import "server-only";
import { doctorOwnsPatient, getPool, patientInDoctorScopeWith, setPlanItemCaseInTransaction } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalPlanCaseRefusal extends Error {
  constructor(readonly code: "invalid_plan_case" | "plan_item_not_found" | "plan_case_not_available" | "plan_case_conflict" | "plan_case_capability_denied" | "plan_case_billed_lock", readonly status: 400 | 403 | 404 | 409, message: string) { super(message); this.name = "CanonicalPlanCaseRefusal"; }
}
const missing = () => new CanonicalPlanCaseRefusal("plan_item_not_found", 404, "البند غير موجود ضمن مرضاك.");
const invalid = () => new CanonicalPlanCaseRefusal("invalid_plan_case", 400, "راجع الحالة والأولوية والقيم السابقة قبل حفظ الربط.");
const conflict = () => new CanonicalPlanCaseRefusal("plan_case_conflict", 409, "تغيّر البند أو تعذّر تثبيت سياقه. حدّث الحالات وراجع الربط قبل محاولة جديدة.");
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
const priority = (v: unknown) => v === null || id(v) && v <= 999;
const nullableId = (v: unknown) => v === null || id(v);
export function parseCanonicalPlanCaseInput(rawId: string, body: unknown) {
  if (!/^[1-9]\d*$/.test(rawId) || !id(Number(rawId)) || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const data = body as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== "caseId,expectedCaseId,expectedPriority,priority"
    || !nullableId(data.caseId) || !nullableId(data.expectedCaseId) || !priority(data.priority) || !priority(data.expectedPriority)) throw invalid();
  return { itemId: Number(rawId), caseId: data.caseId as number | null, priority: data.priority as number | null,
    expectedCaseId: data.expectedCaseId as number | null, expectedPriority: data.expectedPriority as number | null };
}

/** A state comparison prevents lost edits; it is not a durable request receipt.
 * No caller-selected actor, no automatic retry and no financial reassignment. */
export async function commandCanonicalPlanItemCase(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalPlanCaseInput(rawId, body), action = "clinical.plans.edit" as const;
  try {
    return await withStaffOperation(pool, session, action, async (client, handle) => {
      let scope = await staffOperationPatientScope(client, handle, action);
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const { rows: [initial] } = await client.query<{ patient_id: number }>("SELECT t.patient_id FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id WHERE i.id=$1", [input.itemId]);
      if (!initial || scope.kind === "own" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, initial.patient_id)) throw missing();
      // Match the existing patient→item lock order. Parent plan/case witness locks use
      // NOWAIT to fail closed on inverse clinical/financial ordering, not deadlock.
      // Do not upgrade to UPDATE: retained invoice inserts need the compatible
      // patient FK KEY SHARE lock while their item lock makes us wait.
      const patient = await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [initial.patient_id]);
      const { rows: [item] } = await client.query<{ plan_id: number; case_id: number | null; priority: number | null }>("SELECT plan_id,case_id,priority FROM plan_items WHERE id=$1 FOR UPDATE", [input.itemId]);
      scope = await staffOperationPatientScope(client, handle, action); // Expiry and authority after both waits.
      if (!patient.rows.length || !item) throw missing();
      const { rows: [plan] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM treatment_plans WHERE id=$1 FOR SHARE NOWAIT", [item.plan_id]);
      if (!plan || plan.patient_id !== initial.patient_id) throw conflict();
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      if (scope.kind === "own" && !await doctorOwnsPatient(scope.clinicianPartyId, plan.patient_id, client, "nowait")) throw missing();
      const capabilities = await staffOperationCapabilities(client, handle, action, ["clinical.plans.view", "clinical.ortho.view"]);
      if (!capabilities.has("clinical.plans.view")) throw new CanonicalPlanCaseRefusal("plan_case_capability_denied", 403, "عرض بنود الخطط مطلوب قبل تغيير روابطها.");
      // Read/write visibility is symmetric: no blind unlinking of a hidden ortho case.
      const cases = [...new Set([item.case_id, input.caseId].filter((n): n is number => n !== null))].sort((a, b) => a - b);
      for (const caseId of cases) {
        const { rows: [row] } = await client.query<{ patient_id: number; specialty: string; ortho_case_id: number | null }>("SELECT patient_id,specialty,ortho_case_id FROM clinical_cases WHERE id=$1 FOR SHARE NOWAIT", [caseId]);
        if (!row || row.patient_id !== plan.patient_id) throw new CanonicalPlanCaseRefusal("plan_case_not_available", 404, "الحالة غير متاحة لهذا البند.");
        if ((row.specialty === "orthodontics" || row.ortho_case_id !== null) && !capabilities.has("clinical.ortho.view")) throw new CanonicalPlanCaseRefusal("plan_case_capability_denied", 403, "رابط حالة التقويم يحتاج صلاحية عرض التقويم المستقلة.");
        if (row.ortho_case_id !== null) {
          const ortho = await client.query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT", [row.ortho_case_id, plan.patient_id]);
          if (!ortho.rows.length || row.specialty !== "orthodontics") throw new CanonicalPlanCaseRefusal("plan_case_not_available", 404, "الحالة غير متاحة لهذا البند.");
        }
      }
      if (item.case_id !== input.expectedCaseId || item.priority !== input.expectedPriority) throw conflict();
      const actor = await staffOperationIdentity(client, handle, action);
      const changed = item.case_id !== input.caseId || item.priority !== input.priority;
      if (changed) {
        const result = await setPlanItemCaseInTransaction(client, { itemId: input.itemId, caseId: input.caseId, priority: input.priority, actor: actor.username, actorRole: actor.role });
        if (!result.ok) {
          if (result.reason === "billed_case_lock") throw new CanonicalPlanCaseRefusal("plan_case_billed_lock", 409, "لا يمكن تغيير الحالة المرتبطة ببند صدرت له فاتورة حفاظًا على السجل المالي والعمولات. يمكنك تعديل الأولوية فقط.");
          if (result.reason === "not_found") throw missing();
          throw new CanonicalPlanCaseRefusal("plan_case_not_available", 404, "الحالة غير متاحة لهذا البند.");
        }
      }
      await assertStaffOperation(client, handle, action);
      return { ok: true as const, changed, itemId: input.itemId, caseId: input.caseId, priority: input.priority };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["55P03", "40P01", "40001"].includes(String(error.code))) throw conflict();
    throw error;
  }
}
