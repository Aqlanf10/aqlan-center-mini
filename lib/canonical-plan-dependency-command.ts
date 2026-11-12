import "server-only";
import { addPlanItemDependencyInTransaction, doctorOwnsPatient, getPool, patientInDoctorScopeWith, removePlanItemDependencyInTransaction } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";
import { CASE_READ_LIMITS } from "./canonical-case-projection";
import { planDependencyVersion } from "./canonical-plan-dependency-version";

export class CanonicalPlanDependencyRefusal extends Error {
  constructor(readonly code: "invalid_plan_dependency" | "plan_dependency_not_found" | "plan_dependency_conflict" | "plan_dependency_cycle" | "plan_dependency_limit", readonly status: 400 | 404 | 409, message: string) { super(message); this.name = "CanonicalPlanDependencyRefusal"; }
}
const missing = () => new CanonicalPlanDependencyRefusal("plan_dependency_not_found", 404, "البند أو الاعتماد غير متاح ضمن مرضاك.");
const conflict = () => new CanonicalPlanDependencyRefusal("plan_dependency_conflict", 409, "تغيّر الاعتماد أو تعذّر تثبيت سياقه. حدّث السجل وراجع الحالة قبل طلب جديد.");
const invalid = () => new CanonicalPlanDependencyRefusal("invalid_plan_dependency", 400, "راجع البند المطلوب ونوع الاعتماد والملاحظة.");
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
type Draft = { itemId: number; requiresItemId: number } & ({ kind: "add"; requirement: "completed" | "clearance"; note: string | null } | { kind: "remove"; expectedVersion: string });
export function parseCanonicalPlanDependency(kind: "add" | "remove", rawId: string, body: unknown): Draft {
  if (!/^[1-9]\d*$/.test(rawId) || !id(Number(rawId)) || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const row = body as Record<string, unknown>, itemId = Number(rawId);
  if (!id(row.requiresItemId) || row.requiresItemId === itemId) throw invalid();
  if (kind === "remove") {
    if (Object.keys(row).sort().join(",") !== "expectedVersion,requiresItemId" || typeof row.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(row.expectedVersion)) throw invalid();
    return { kind, itemId, requiresItemId: row.requiresItemId, expectedVersion: row.expectedVersion };
  }
  if (Object.keys(row).sort().join(",") !== "note,requirement,requiresItemId" || typeof row.requirement !== "string" || !["completed", "clearance"].includes(row.requirement)
    || row.note !== null && (typeof row.note !== "string" || row.note.length > 500)) throw invalid();
  return { kind, itemId, requiresItemId: row.requiresItemId, requirement: row.requirement as "completed" | "clearance", note: typeof row.note === "string" ? row.note.trim() || null : null };
}

/** Graph changes share the legacy patient lock and writer. There is no durable
 * request receipt: callers must verify an uncertain result before a new intent. */
export async function commandCanonicalPlanDependency(session: VerifiedDurableSession, kind: "add" | "remove", rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalPlanDependency(kind, rawId, body), action = "clinical.plans.edit" as const;
  try {
    return await withStaffOperation(pool, session, action, async (client, handle) => {
      let scope = await staffOperationPatientScope(client, handle, action);
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const { rows: [initial] } = await client.query<{ patient_id: number }>("SELECT t.patient_id FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id WHERE i.id=$1", [input.itemId]);
      if (!initial || scope.kind === "own" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, initial.patient_id)) throw missing();
      // All legacy graph additions take this same patient UPDATE lock before the
      // graph read. Child/plan locks are NOWAIT so an inverse writer cannot deadlock.
      const patient = await client.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [initial.patient_id]);
      scope = await staffOperationPatientScope(client, handle, action);
      if (!patient.rows.length) throw missing();
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const { rows: pair } = await client.query<{ id: number; plan_id: number }>("SELECT id,plan_id FROM plan_items WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE NOWAIT", [[input.itemId, input.requiresItemId]]);
      if (pair.length !== 2) throw missing();
      const { rows: plans } = await client.query<{ id: number; patient_id: number }>("SELECT id,patient_id FROM treatment_plans WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE NOWAIT", [[...new Set(pair.map(i => i.plan_id))]]);
      if (pair.some(i => !plans.some(p => p.id === i.plan_id && p.patient_id === initial.patient_id))) throw missing();
      if (scope.kind === "own" && !await doctorOwnsPatient(scope.clinicianPartyId, initial.patient_id, client, "nowait")) throw missing();
      const actor = await staffOperationIdentity(client, handle, action);
      if (input.kind === "add") {
        const { rows: [size] } = await client.query<{ items: number; edges: number; foreign_edge: boolean }>(`SELECT
          (SELECT count(*)::int FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id WHERE t.patient_id=$1) items,
          (SELECT count(*)::int FROM plan_item_dependencies d JOIN plan_items i ON i.id=d.item_id JOIN treatment_plans t ON t.id=i.plan_id WHERE t.patient_id=$1) edges,
          EXISTS(SELECT 1 FROM plan_item_dependencies d JOIN plan_items i ON i.id=d.item_id JOIN treatment_plans t ON t.id=i.plan_id
            LEFT JOIN plan_items r ON r.id=d.requires_item_id LEFT JOIN treatment_plans rt ON rt.id=r.plan_id
            WHERE t.patient_id=$1 AND rt.patient_id IS DISTINCT FROM $1) foreign_edge`, [initial.patient_id]);
        if (!size || size.foreign_edge) throw missing();
        if (size.items > CASE_READ_LIMITS.items || size.edges >= CASE_READ_LIMITS.dependencies) throw new CanonicalPlanDependencyRefusal("plan_dependency_limit", 409, "بلغت شبكة الخطة حد المعالجة الآمنة؛ لم يُضف اعتماد أو تُختصر الشبكة.");
        const result = await addPlanItemDependencyInTransaction(client, { ...input, actor: actor.username, actorRole: actor.role });
        if (!result.ok) {
          if (result.reason === "cycle") throw new CanonicalPlanDependencyRefusal("plan_dependency_cycle", 409, "هذا الاعتماد يصنع دورة — كلٌّ من البندين سينتظر الآخر.");
          if (result.reason === "exists") throw conflict();
          throw missing();
        }
      } else {
        const { rows: [edge] } = await client.query<{ itemId: number; requiresItemId: number; requirement: string; note: string | null; createdBy: string; createdAt: string; rowXmin: string; rowTid: string }>(`SELECT
          item_id AS "itemId",requires_item_id AS "requiresItemId",requirement,note,created_by AS "createdBy",created_at::text AS "createdAt",xmin::text AS "rowXmin",ctid::text AS "rowTid"
          FROM plan_item_dependencies WHERE item_id=$1 AND requires_item_id=$2 FOR UPDATE NOWAIT`, [input.itemId, input.requiresItemId]);
        if (!edge) throw missing();
        if (planDependencyVersion(edge) !== input.expectedVersion) throw conflict();
        const result = await removePlanItemDependencyInTransaction(client, { ...input, actor: actor.username, actorRole: actor.role });
        if (!result.ok) throw missing();
      }
      await assertStaffOperation(client, handle, action);
      return { ok: true as const, itemId: input.itemId, requiresItemId: input.requiresItemId };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["55P03", "40P01", "40001", "23505"].includes(String(error.code))) throw conflict();
    throw error;
  }
}
