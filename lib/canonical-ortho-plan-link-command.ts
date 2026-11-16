import "server-only";
import { doctorOwnsPatient, getPool, linkOrthoCasePlanWith, patientInDoctorScopeWith } from "./db";
import { orthoLifecycleVersionWith } from "./canonical-ortho-lifecycle-version";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalOrthoPlanLinkRefusal extends Error {
  constructor(readonly code: "invalid_ortho_plan_link" | "ortho_plan_link_not_found" | "ortho_plan_link_conflict" | "ortho_plan_link_unavailable", readonly status: 400 | 404 | 409, message: string) { super(message); this.name = "CanonicalOrthoPlanLinkRefusal"; }
}
const invalid = () => new CanonicalOrthoPlanLinkRefusal("invalid_ortho_plan_link", 400, "اختر خطة واحدة أو فك الارتباط، مع نسخة الحالة الحالية.");
const missing = () => new CanonicalOrthoPlanLinkRefusal("ortho_plan_link_not_found", 404, "الحالة غير متاحة ضمن مرضاك.");
const conflict = () => new CanonicalOrthoPlanLinkRefusal("ortho_plan_link_conflict", 409, "تغيّرت الحالة أو تعذّر تثبيت ارتباطها. راجع السجل قبل طلب جديد.");
const unavailable = () => new CanonicalOrthoPlanLinkRefusal("ortho_plan_link_unavailable", 409, "الخطة غير متاحة لهذه الحالة؛ لم يُغيّر الارتباط.");

export function parseCanonicalOrthoPlanLink(rawId: string, body: unknown) {
  const id = Number(rawId);
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || id > 2147483647 || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const value = body as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "expectedVersion,planId" || typeof value.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedVersion)
    || value.planId !== null && (typeof value.planId !== "number" || !Number.isSafeInteger(value.planId) || value.planId <= 0 || value.planId > 2147483647)) throw invalid();
  return { id, expectedVersion: value.expectedVersion, planId: value.planId as number | null };
}

/** Observed native case version prevents a delayed stale change; this is not a
 * durable command receipt. Unknown outcomes require reading before a new intent. */
export async function commandCanonicalOrthoPlanLink(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalOrthoPlanLink(rawId, body), action = "clinical.ortho.edit" as const;
  try {
    return await withStaffOperation(pool, session, action, async (client, handle) => {
      const assertPlanAuthority = async () => {
        const grants = await staffOperationCapabilities(client, handle, action, ["clinical.plans.view", "clinical.plans.edit"]);
        if (!grants.has("clinical.plans.view") || !grants.has("clinical.plans.edit")) throw new Error("STAFF_OPERATION_CAPABILITY_DENIED");
      };
      await assertPlanAuthority();
      let scope = await staffOperationPatientScope(client, handle, action);
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const initial = (await client.query<{ patient_id: number }>("SELECT patient_id FROM ortho_cases WHERE id=$1", [input.id])).rows[0];
      if (!initial || scope.kind === "own" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, initial.patient_id)) throw missing();
      const patient = await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [initial.patient_id]);
      const assertCurrent = async () => {
        await assertStaffOperation(client, handle, action);
        await assertPlanAuthority();
        scope = await staffOperationPatientScope(client, handle, action);
        if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
        if (!patient.rows.length || scope.kind === "own" && !await doctorOwnsPatient(scope.clinicianPartyId, initial.patient_id, client, "nowait")) throw missing();
      };
      await assertCurrent();
      const before = (await client.query<{ patient_id: number; status: string; plan_id: number | null }>("SELECT patient_id,status,plan_id FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR UPDATE NOWAIT", [input.id, initial.patient_id])).rows[0];
      if (!before) throw missing();
      if (!["active", "retention"].includes(before.status) || await orthoLifecycleVersionWith(client, input.id) !== input.expectedVersion) throw conflict();
      const plans = [...new Set([before.plan_id, input.planId].filter((id): id is number => id !== null))].sort((a, b) => a - b);
      // Prove parents belong to this patient before touching any plan lock. Repeat
      // under the lock: a writer that bypassed the patient lock must still fail safe.
      if (plans.length) {
        const owned = await client.query("SELECT id FROM treatment_plans WHERE id=ANY($1::int[]) AND patient_id=$2", [plans, initial.patient_id]);
        if (owned.rows.length !== plans.length) throw unavailable();
        const locked = await client.query<{ id: number; status: string }>("SELECT id,status FROM treatment_plans WHERE id=ANY($1::int[]) AND patient_id=$2 ORDER BY id FOR SHARE NOWAIT", [plans, initial.patient_id]);
        if (locked.rows.length !== plans.length || locked.rows.some(row => row.id === input.planId && row.status === "cancelled")) throw unavailable();
      }
      await assertCurrent();
      const actor = await staffOperationIdentity(client, handle, action);
      const result = await linkOrthoCasePlanWith(client, { caseId: input.id, planId: input.planId, actor: actor.username, actorRole: actor.role });
      if (!result.ok) throw unavailable();
      await assertCurrent();
      // Funding is an independent projection; the native result is not serialized.
      return { ok: true as const, caseId: input.id, changed: result.changed };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["55P03", "40P01", "40001"].includes(String(error.code))) throw conflict();
    throw error;
  }
}
