import "server-only";
import { doctorOwnsPatient, getPool, patientInDoctorScopeWith, recordProposalContactInTransaction } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";
import { proposalContactVersion } from "./canonical-proposal-version";

export class CanonicalProposalContactRefusal extends Error {
  constructor(readonly code: "invalid_proposal_contact" | "proposal_contact_not_found" | "proposal_contact_conflict", readonly status: 400 | 404 | 409, message: string) {
    super(message); this.name = "CanonicalProposalContactRefusal";
  }
}
const missing = () => new CanonicalProposalContactRefusal("proposal_contact_not_found", 404, "العرض غير متاح ضمن مرضاك.");
const conflict = () => new CanonicalProposalContactRefusal("proposal_contact_conflict", 409, "تغيّر العرض أو سجل التواصل. تحقّق من الحالة الحالية قبل تسجيل تواصل جديد.");
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
export function parseCanonicalProposalContact(body: unknown) {
  const invalid = () => new CanonicalProposalContactRefusal("invalid_proposal_contact", 400, "راجع العرض والمريض والحالة المرصودة والملاحظة ضمن 300 حرف.");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const row = body as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "expectedVersion,note,patientId,planId" || !validId(row.planId) || !validId(row.patientId)
    || typeof row.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(row.expectedVersion)
    || row.note !== null && (typeof row.note !== "string" || row.note.length > 300)) throw invalid();
  return { planId: row.planId, patientId: row.patientId, expectedVersion: row.expectedVersion, note: typeof row.note === "string" ? row.note.trim() || null : null };
}

/** Manual audit of an already completed contact, never an outbound send. The
 * observed version prevents replay of one observation, not a permanent receipt. */
export async function commandCanonicalProposalContact(session: VerifiedDurableSession, body: unknown, pool = getPool()) {
  const input = parseCanonicalProposalContact(body), action = "clinical.plans.edit" as const;
  try {
    return await withStaffOperation(pool, session, action, async (client, handle) => {
      let scope = await staffOperationPatientScope(client, handle, action);
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const { rows: [initial] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM treatment_plans WHERE id=$1", [input.planId]);
      if (!initial || initial.patient_id !== input.patientId || scope.kind === "own" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, input.patientId)) throw missing();
      // Patient ownership is stable before locking the same plan as the retained
      // legacy writer. NOWAIT on that plan prevents an inverse-order deadlock.
      const patient = await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [input.patientId]);
      scope = await staffOperationPatientScope(client, handle, action); // Recheck session after the actual wait.
      if (!patient.rows.length) throw missing();
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const { rows: [plan] } = await client.query<{ patient_id: number; status: string; consent_at: Date | null; planXmin: string; planTid: string }>(
        'SELECT patient_id,status,consent_at,xmin::text AS "planXmin",ctid::text AS "planTid" FROM treatment_plans WHERE id=$1 FOR UPDATE NOWAIT', [input.planId]);
      if (!plan || plan.patient_id !== input.patientId) throw missing();
      if (scope.kind === "own" && !await doctorOwnsPatient(scope.clinicianPartyId, input.patientId, client, "nowait")) throw missing();
      if (plan.status !== "active" || plan.consent_at !== null) throw conflict();
      const { rows: [contact] } = await client.query<{ contactCount: string; contactId: string | null; contactEpoch: string | null }>(
        `SELECT count(*)::text AS "contactCount",max(id)::text AS "contactId",extract(epoch from max(created_at))::text AS "contactEpoch"
         FROM audit_log WHERE action='plan.proposal_contact' AND entity_id=$1`, [String(input.planId)]);
      if (!contact || proposalContactVersion({ ...plan, ...contact, planId: input.planId }) !== input.expectedVersion) throw conflict();
      const actor = await staffOperationIdentity(client, handle, action);
      const result = await recordProposalContactInTransaction(client, { planId: input.planId, note: input.note, actor: actor.username, actorRole: actor.role });
      if (!result.ok) { if (result.status === 404) throw missing(); throw conflict(); }
      await assertStaffOperation(client, handle, action);
      return { ok: true as const, planId: input.planId, lastContactAt: result.lastContactAt };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["55P03", "40P01", "40001"].includes(String(error.code))) throw conflict();
    throw error;
  }
}
