import "server-only";
import { decideOrthoAdjustmentBillingInTransaction, doctorOwnsPatient, getPool, patientInDoctorScopeWith } from "./db";
import { orthoDecisionVersion } from "./canonical-ortho-decision-version";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationClinician, staffOperationIdentity, staffOperationIsProtectedOwner, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalOrthoDecisionRefusal extends Error {
  constructor(readonly code: "invalid_ortho_decision" | "ortho_decision_not_found" | "ortho_decision_conflict" | "ortho_decision_responsibility_denied", readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message); this.name = "CanonicalOrthoDecisionRefusal";
  }
}
const missing = () => new CanonicalOrthoDecisionRefusal("ortho_decision_not_found", 404, "الشدّة غير متاحة ضمن مرضاك.");
const conflict = () => new CanonicalOrthoDecisionRefusal("ortho_decision_conflict", 409, "تغيّرت الشدّة أو تعذّر تثبيت مرجعها. راجع الحالة والفاتورة قبل طلب جديد.");
const responsibility = () => new CanonicalOrthoDecisionRefusal("ortho_decision_responsibility_denied", 403, "قرار «بلا رسوم» للطبيب المسؤول عن الحالة أو المالك.");
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
export function parseCanonicalOrthoDecision(rawId: string, body: unknown) {
  const invalid = () => new CanonicalOrthoDecisionRefusal("invalid_ortho_decision", 400, "راجع الشدّة والمريض والحالة المرصودة؛ «بلا رسوم» يحتاج سببًا من 3 إلى 300 حرف، و«فوتِرت» يحتاج رقم فاتورة قائمة.");
  const adjustmentId = Number(rawId);
  if (!/^[1-9]\d*$/.test(rawId) || !validId(adjustmentId) || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const row = body as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "decision,expectedVersion,invoiceNumber,patientId,reason"
    || !validId(row.patientId) || typeof row.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(row.expectedVersion)) throw invalid();
  if (row.decision === "no_charge") {
    if (row.invoiceNumber !== null || typeof row.reason !== "string" || row.reason.trim().length < 3 || row.reason.trim().length > 300) throw invalid();
    return { adjustmentId, patientId: row.patientId, expectedVersion: row.expectedVersion, decision: "no_charge" as const, reason: row.reason.trim(), invoiceNumber: null };
  }
  if (row.decision !== "billed" || row.reason !== null || typeof row.invoiceNumber !== "string" || !row.invoiceNumber.trim()
    || Buffer.byteLength(row.invoiceNumber, "utf8") > JSON_BODY_LIMIT_BYTES) throw invalid();
  return { adjustmentId, patientId: row.patientId, expectedVersion: row.expectedVersion, decision: "billed" as const, reason: null, invoiceNumber: row.invoiceNumber.trim() };
}

/** Existing one-time saved decision only. No invoice creation, coverage calculation,
 * money movement, patient assignment, hidden rich return or automatic replay. */
export async function commandCanonicalOrthoDecision(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalOrthoDecision(rawId, body);
  const action = input.decision === "no_charge" ? "clinical.ortho.edit" as const : "finance.invoices.create" as const;
  try {
    return await withStaffOperation(pool, session, action, async (client, handle) => {
      let scope = await staffOperationPatientScope(client, handle, action);
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const { rows: [initial] } = await client.query<{ patient_id: number }>("SELECT c.patient_id FROM ortho_adjustments a JOIN ortho_cases c ON c.id=a.case_id WHERE a.id=$1", [input.adjustmentId]);
      if (!initial || initial.patient_id !== input.patientId || scope.kind === "own" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, input.patientId)) throw missing();
      const patient = await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [input.patientId]);
      scope = await staffOperationPatientScope(client, handle, action); // Fresh session/grants after the actual wait.
      if (!patient.rows.length) throw missing();
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const { rows: [adjustment] } = await client.query<{ adjustmentId: number; caseId: number; visitId: number | null; billing_class: string | null; billing_decision: string | null; adjustmentXmin: string; adjustmentTid: string }>(
        `SELECT id AS "adjustmentId",case_id AS "caseId",visit_id AS "visitId",billing_class,billing_decision,xmin::text AS "adjustmentXmin",ctid::text AS "adjustmentTid"
         FROM ortho_adjustments WHERE id=$1 FOR UPDATE NOWAIT`, [input.adjustmentId]);
      if (!adjustment) throw missing();
      // NOWAIT on inversely ordered witnesses prevents waiting while holding the
      // patient's lock. Foreign references never expose their fields or labels.
      const { rows: [ortho] } = await client.query<{ patientId: number; responsible_doctor_id: number | null; caseXmin: string; caseTid: string }>(
        `SELECT patient_id AS "patientId",responsible_doctor_id,xmin::text AS "caseXmin",ctid::text AS "caseTid"
         FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT`, [adjustment.caseId, input.patientId]);
      if (!ortho) throw missing();
      if (scope.kind === "own" && !await doctorOwnsPatient(scope.clinicianPartyId, input.patientId, client, "nowait")) throw missing();
      if (input.decision === "no_charge" && !await staffOperationIsProtectedOwner(client, handle, action)
        && (ortho.responsible_doctor_id === null || ortho.responsible_doctor_id !== await staffOperationClinician(client, handle, action))) throw responsibility();
      if (adjustment.visitId !== null) {
        const linked = await client.query("SELECT id FROM visits WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT", [adjustment.visitId, input.patientId]);
        if (linked.rows.length !== 1) throw conflict();
      }
      if (!["OUTSIDE_CONTRACT", "REVIEW_REQUIRED"].includes(adjustment.billing_class ?? "") || adjustment.billing_decision !== null
        || orthoDecisionVersion({ ...adjustment, ...ortho }) !== input.expectedVersion) throw conflict();
      if (input.decision === "billed") {
        const linked = await client.query("SELECT id FROM invoices WHERE invoice_number=$1 AND patient_id=$2 AND status<>'cancelled' FOR SHARE NOWAIT", [input.invoiceNumber, input.patientId]);
        if (linked.rows.length !== 1) throw conflict();
      }
      const actor = await staffOperationIdentity(client, handle, action);
      const result = await decideOrthoAdjustmentBillingInTransaction(client, { ...input, actor: actor.username, actorRole: actor.role });
      if (!result.ok) { if (result.status === 404) throw missing(); throw conflict(); }
      await assertStaffOperation(client, handle, action);
      return { ok: true as const, adjustmentId: input.adjustmentId, decision: input.decision };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["55P03", "40P01", "40001"].includes(String(error.code))) throw conflict();
    throw error;
  }
}
