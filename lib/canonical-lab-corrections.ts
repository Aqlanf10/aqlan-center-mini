import "server-only";
import { getPool, patientInDoctorScopeWith, updateLabOrderClinicalOn, updateLabOrderShadesOn, type DbClient, type LabClinicalAuthority } from "./db";
import { labClinicalEditProblem, parseLabClinicalSnapshot } from "./lab-clinical-edit";
import { validateLabPrescription } from "./lab-prescription-input";
import { completeLabPrescriptionOn, LabPrescriptionError } from "./lab-prescription-write";
import { parseLabShadeSpecification } from "./lab-shades";
import { parseLabOrderId } from "./canonical-lab-orders";
import type { StaffRecordConstraint } from "./staff-capabilities";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationClinician, staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle,
} from "./staff-operation-runtime";

/**
 * Canonical lab-order corrections (M2 slice 69): PATCH /api/lab/[id] actions
 * `complete_prescription`, `update_clinical` and `update_shade`.
 *
 * - One admitted `clinical.visits.document` transaction each (the map's branch
 *   requirement; the legacy route allowed admin/doctor for the prescription and
 *   admin/doctor/reception for the corrections). The legacy writers' own bodies run
 *   unchanged through an injectable authority (completeLabPrescriptionOn,
 *   updateLabOrderClinicalOn, updateLabOrderShadesOn).
 * - The order row is locked and the patient scope checked first: outside the scope reads
 *   like a missing order (404). The prescription keeps the legacy lock order (the
 *   lab_orders table lock NOWAIT before row locks).
 * - Unchanged guards: the prescription's observed version and `needed`-only rule, the
 *   source scope, the lab change refused when a cost or payable is attached; the
 *   clinical correction's observed snapshot, the doctor/lab changes refused when money
 *   or an invoice is attached (financial_doctor_locked / financial_lab_locked); the shade
 *   edit's observed specification. Every audit row commits with its write.
 * - A clinician-linked actor may only reassign the treating doctor to itself (the
 *   legacy doctor-role binding).
 */
export class CanonicalLabCorrectionRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "CanonicalLabCorrectionRefusal";
  }
}
const ACTION = "clinical.visits.document" as const;
const invalid = (message: string) => new CanonicalLabCorrectionRefusal("invalid_lab_correction", 400, message);
const notFound = () => new CanonicalLabCorrectionRefusal("lab_order_not_found", 404, "أمر المختبر غير موجود.");

async function inScope(client: DbClient, scope: StaffRecordConstraint, patientId: number): Promise<boolean> {
  if (scope.kind === "all") return true;
  if (scope.kind === "own") return patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId);
  return false;
}

/** Scope, then the order row locked and inside the scope (missing and outside alike). */
async function lockedInScope(client: DbClient, handle: StaffOperationHandle, id: number) {
  const scope = await staffOperationPatientScope(client, handle, ACTION);
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const { rows: [row] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM lab_orders WHERE id = $1 FOR UPDATE", [id]);
  if (!row || !await inScope(client, scope, row.patient_id)) throw notFound();
  const identity = await staffOperationIdentity(client, handle, ACTION);
  const clinician = await staffOperationClinician(client, handle, ACTION);
  const authority: LabClinicalAuthority = {
    actor: { username: identity.username, role: identity.role },
    canAccessPatient: patientId => inScope(client, scope, patientId),
    restrictDoctorTo: clinician ?? "unrestricted",
  };
  return authority;
}

export async function commandCanonicalLabPrescription(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const id = parseLabOrderId(rawId);
  if (typeof body.expected !== "string" || typeof body.dispatch !== "boolean") throw invalid("بيانات مراجعة الطلب غير صالحة.");
  let input;
  try { input = validateLabPrescription(body.prescription, body.dispatch); }
  catch (error) { throw invalid(error instanceof Error ? error.message : "بيانات غير صالحة."); }
  const expected = body.expected, dispatch = body.dispatch;
  try {
    return await withStaffOperation(pool, session, ACTION, async (client, handle) => {
      // The legacy lock order: the table's ordinary DML lock before any row lock.
      await client.query("LOCK TABLE lab_orders IN ROW EXCLUSIVE MODE NOWAIT");
      const authority = await lockedInScope(client, handle, id);
      return completeLabPrescriptionOn(client, id, input, expected, dispatch, authority);
    });
  } catch (error) {
    if (error instanceof LabPrescriptionError) throw new CanonicalLabCorrectionRefusal("lab_prescription_refused", error.status as 400 | 403 | 404 | 409, error.message);
    if ((error as { code?: string }).code === "55P03") throw new CanonicalLabCorrectionRefusal("lab_correction_busy", 409, "يوجد تحديث سريري جارٍ؛ أعد المحاولة بعد تحديث البيانات.");
    throw error;
  }
}

const CLINICAL_RESULTS: Record<string, () => CanonicalLabCorrectionRefusal> = {
  forbidden: () => new CanonicalLabCorrectionRefusal("lab_doctor_forbidden", 403, "غير مصرح لهذا المريض أو الطبيب."),
  not_found: () => notFound(),
  invalid: () => invalid("بيانات الطبيب أو المعمل أو الأسنان غير صالحة؛ أعد مراجعتها."),
  financial_doctor_locked: () => new CanonicalLabCorrectionRefusal("financial_doctor_locked", 409, "تغيير الطبيب قد يعيد توزيع العمولة التاريخية؛ لهذه الإرسالية أثر مالي أو فاتورة مرتبطة ويحتاج تصحيح الطبيب مراجعة مالية مستقلة."),
  financial_lab_locked: () => new CanonicalLabCorrectionRefusal("financial_lab_locked", 409, "للإرسالية تكلفة أو التزام مالي؛ تغيير المعمل يحتاج مراجعة الربط المالي أولًا ولا يُنفّذ من التصحيح السريري."),
  conflict: () => new CanonicalLabCorrectionRefusal("lab_clinical_conflict", 409, "تغيّرت الإرسالية منذ فتحها؛ أغلق النافذة وأعد تحميلها قبل التصحيح."),
};

export async function commandCanonicalLabClinical(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const id = parseLabOrderId(rawId);
  const clinical = parseLabClinicalSnapshot(body.clinical);
  const expectedClinical = parseLabClinicalSnapshot(body.expectedClinical);
  if (!clinical || !expectedClinical) throw invalid("بيانات الإرسالية أو نسختها السابقة غير صالحة.");
  const problem = labClinicalEditProblem(clinical, expectedClinical);
  if (problem) throw invalid(problem);
  const result = await withStaffOperation(pool, session, ACTION, async (client, handle) =>
    updateLabOrderClinicalOn(client, id, { clinical, expectedClinical }, await lockedInScope(client, handle, id)));
  if (result !== "updated") throw CLINICAL_RESULTS[result]();
  return { ok: true as const };
}

const SHADE_RESULTS: Record<string, () => CanonicalLabCorrectionRefusal> = {
  forbidden: () => notFound(),
  not_found: () => notFound(),
  invalid: () => invalid("الألوان تخص أسنانًا غير موجودة في الإرسالية؛ راجع الاختيار."),
  conflict: () => new CanonicalLabCorrectionRefusal("lab_shade_conflict", 409, "تغيّرت الألوان منذ فتح الإرسالية؛ أعد تحميلها قبل التعديل."),
};

export async function commandCanonicalLabShade(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const id = parseLabOrderId(rawId);
  const next = parseLabShadeSpecification(body.shadeSpecification);
  const expected = parseLabShadeSpecification(body.expectedShadeSpecification);
  if (!next.ok || !expected.ok) throw invalid("مواصفات الألوان أو نسختها السابقة غير صالحة.");
  const result = await withStaffOperation(pool, session, ACTION, async (client, handle) =>
    updateLabOrderShadesOn(client, id, { shadeSpecification: next.value, expectedShadeSpecification: expected.value }, await lockedInScope(client, handle, id)));
  if (result !== "updated") throw SHADE_RESULTS[result]();
  return { ok: true as const, shadeSpecification: next.value };
}
