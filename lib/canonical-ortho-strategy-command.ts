import "server-only";
import { doctorOwnsPatient, getPool, patientInDoctorScopeWith, type DbClient } from "./db";
import { checkStrategyCommand, type StrategyCommand, type StrategyRevision, type StrategyScope, type StrategyCanonicalContext } from "./ortho-treatment-strategy";
import { appendOrthoTreatmentStrategyWith, assertOrthoStrategyHistoryBudgetWith, assertStrategyPlanLinksAuthority, OrthoStrategyStoreFault, readOrthoStrategyHistoryWith } from "./ortho-treatment-strategy-store";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

function fail(status: number, code: string, message: string): never { throw new OrthoStrategyStoreFault(status, code, message); }
const missing = () => fail(404, "ortho_case_not_found", "حالة التقويم غير متاحة ضمن مرضاك.");
const sorted = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
export function parseCanonicalOrthoStrategyCommand(rawId: string, body: unknown) {
  const id = Number(rawId), checked = checkStrategyCommand(body);
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || id > 2147483647) fail(400, "invalid_scope", "معرّف حالة التقويم غير صالح.");
  if (!checked.ok) fail(400, checked.code, checked.message);
  return { id, command: checked.value };
}
function references(revisions: StrategyRevision[], command?: StrategyCommand) {
  const problems = sorted([...revisions.flatMap(r => r.rows.map(row => row.problem.id)), ...(command?.rows.map(row => row.problemId) ?? [])]);
  const items = sorted([...revisions.flatMap(r => r.rows.flatMap(row => row.planItems.map(item => item.id))), ...(command?.rows.flatMap(row => row.planItemIds) ?? [])]);
  if (problems.length + items.length > 128) fail(409, "strategy_reference_limit", "مراجع السجل تتجاوز حد القراءة الآمنة؛ لم يُختصر السجل.");
  return { problems, items };
}

/** Only requested or historical references; never the legacy unbounded picker.
 * Foreign live references contribute identity/unavailable state without content. */
async function contextWith(q: DbClient, scope: StrategyScope, revisions: StrategyRevision[], command: StrategyCommand | undefined,
  planVisible: boolean, planLinksWritable: boolean): Promise<StrategyCanonicalContext> {
  const ids = references(revisions, command);
  const problems = ids.problems.length ? (await q.query<{
    id: number; patient_id: number; case_id: number | null; label: string; site: string | null; status: string | null;
  }>(`SELECT id,patient_id,CASE WHEN patient_id=$2 THEN case_id END case_id,
      CASE WHEN patient_id=$2 THEN label ELSE '' END label,CASE WHEN patient_id=$2 THEN site END site,
      CASE WHEN patient_id=$2 THEN status END status FROM patient_problems WHERE id=ANY($1::int[])`, [ids.problems, scope.patientId])).rows : [];
  const items = planVisible && ids.items.length ? (await q.query<{
    id: number; patient_id: number; case_id: number | null; service_name: string; tooth_code: number | null; case_site: string | null; status: string | null;
  }>(`SELECT i.id,t.patient_id,CASE WHEN t.patient_id=$2 THEN i.case_id END case_id,
      CASE WHEN t.patient_id=$2 THEN i.service_name ELSE '' END service_name,
      CASE WHEN t.patient_id=$2 THEN i.tooth_code END tooth_code,
      CASE WHEN t.patient_id=$2 AND c.patient_id=$2 THEN c.site END case_site,
      CASE WHEN t.patient_id=$2 THEN i.status END status
      FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id LEFT JOIN clinical_cases c ON c.id=i.case_id
      WHERE i.id=ANY($1::int[])`, [ids.items, scope.patientId])).rows : [];
  return {
    patientId: scope.patientId, orthoCase: { id: scope.orthoCaseId, patientId: scope.patientId },
    clinicalCase: { id: scope.clinicalCaseId, patientId: scope.patientId, orthoCaseId: scope.orthoCaseId },
    problems: problems.map(row => ({ id: row.id, patientId: row.patient_id, caseId: row.case_id, label: row.label, site: row.site, status: row.status })),
    planItems: items.map(row => ({ id: row.id, patientId: row.patient_id, caseId: row.case_id, serviceName: row.service_name, toothCode: row.tooth_code, caseSite: row.case_site, status: row.status })),
    problemLookupState: "ready", planVisibility: planVisible ? "allowed" : "restricted", clinicalWriteAllowed: true, planLinksWritable,
  };
}

export async function commandCanonicalOrthoStrategy(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalOrthoStrategyCommand(rawId, body), action = "clinical.ortho.edit" as const;
  try {
    return await withStaffOperation(pool, session, action, async (client, handle) => {
      let access = await staffOperationPatientScope(client, handle, action);
      if (access.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const found = (await client.query<{ patient_id: number }>("SELECT patient_id FROM ortho_cases WHERE id=$1", [input.id])).rows[0];
      if (!found || access.kind === "own" && !await patientInDoctorScopeWith(client, access.clinicianPartyId, found.patient_id)) missing();
      const patient = await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [found.patient_id]);
      access = await staffOperationPatientScope(client, handle, action);
      if (access.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      if (!patient.rows.length || access.kind === "own" && !await patientInDoctorScopeWith(client, access.clinicianPartyId, found.patient_id)) missing();
      const bridges = (await client.query<{ id: number; patient_id: number; specialty: string }>("SELECT id,patient_id,specialty FROM clinical_cases WHERE ortho_case_id=$1", [input.id])).rows;
      if (bridges.length > 1 || bridges.some(row => row.patient_id !== found.patient_id || row.specialty !== "orthodontics")) fail(409, "scope_mismatch", "الرابط السريري لا يطابق الحالة المحددة.");
      if (!bridges.length) {
        if ((await client.query("SELECT id FROM ortho_strategy_revisions WHERE ortho_case_id=$1 LIMIT 1", [input.id])).rows.length) {
          fail(409, "revision_scope_mismatch", "سجل موجود فقد رابطه السريري؛ لم يُعتبر فارغًا.");
        }
        fail(409, "bridge_missing", "اربط الحالة سريريًا بالإجراء الصريح أولًا.");
      }
      const scope = { patientId: found.patient_id, orthoCaseId: input.id, clinicalCaseId: bridges[0].id };
      const actor = await staffOperationIdentity(client, handle, action);
      const grants = await staffOperationCapabilities(client, handle, action, ["clinical.plans.view", "clinical.plans.edit"]);
      const planVisible = grants.has("clinical.plans.view"), planLinksWritable = planVisible && grants.has("clinical.plans.edit");
      const saved = await readOrthoStrategyHistoryWith(client, scope);
      const replay = saved.stored.findIndex(row => row.actor_user_id === actor.userId && row.command_id === input.command.commandId);
      assertStrategyPlanLinksAuthority({ planVisible, planLinksWritable }, replay < 0 ? [saved.revisions[0] ?? null] : [saved.revisions[replay], saved.revisions[replay + 1] ?? null], input.command);
      const ids = references(saved.revisions, input.command);
      // Secondary locks are NOWAIT: legacy inverse order cannot become a wait
      // while this command holds the patient. Plan parents precede their items.
      if (planVisible && ids.items.length) {
        await client.query(`SELECT t.id FROM treatment_plans t WHERE t.patient_id=$1 AND t.id IN
          (SELECT plan_id FROM plan_items WHERE id=ANY($2::int[])) ORDER BY t.id FOR SHARE OF t NOWAIT`, [scope.patientId, ids.items]);
        await client.query(`SELECT i.id FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id
          WHERE t.patient_id=$1 AND i.id=ANY($2::int[]) ORDER BY i.id FOR UPDATE OF i NOWAIT`, [scope.patientId, ids.items]);
      }
      if (ids.problems.length) await client.query("SELECT id FROM patient_problems WHERE patient_id=$1 AND id=ANY($2::int[]) ORDER BY id FOR UPDATE NOWAIT", [scope.patientId, ids.problems]);
      const assertCurrent = async () => {
        await assertStaffOperation(client, handle, action);
        const fresh = await staffOperationPatientScope(client, handle, action);
        if (fresh.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
        if (fresh.kind === "own" && !await doctorOwnsPatient(fresh.clinicianPartyId, scope.patientId, client, "nowait")) missing();
      };
      await assertCurrent();
      return appendOrthoTreatmentStrategyWith(client, scope, input.command, {
        actor: { id: actor.userId, name: actor.username, role: actor.role }, clinicalWritable: true, planVisible, planLinksWritable,
        nowait: true, assertCurrent, history: readOrthoStrategyHistoryWith,
        context: async (q, current, revisions, command) => {
          if (current.clinicalCaseId !== scope.clinicalCaseId) fail(409, "case_changed", "تغير الرابط السريري؛ أعد قراءة الحالة.");
          return contextWith(q, current, revisions, command, planVisible, planLinksWritable);
        },
        afterInsert: (q, current) => assertOrthoStrategyHistoryBudgetWith(q, current.orthoCaseId),
      });
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["55P03", "40P01", "40001"].includes(String(error.code))) {
      fail(409, "strategy_conflict", "تغيرت الحالة أو تعذّر تثبيت مراجعها. أعد القراءة قبل طلب جديد.");
    }
    throw error;
  }
}
