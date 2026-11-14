import type { SessionPayload } from "./auth";
import type { DbClient } from "./db";
import { canWriteCephClinical } from "./ceph-access";
import { currentClinicalActor, ClinicalMutationAuthorityError } from "./clinical-mutation-authority";
import { canAccessPatient } from "./patient-access";

/**
 * Canonical (staff-cutover) admission: called inside the writer's transaction right after the
 * patient row lock, in place of the legacy session re-proof. It proves the operation's capability,
 * current patient scope and identity, and returns the actor whose expiry the writer re-checks.
 * It never widens access: a refusal throws ClinicalMutationAuthorityError.
 */
export type CephCanonicalAdmit = (client: DbClient, patientId: number) => Promise<SessionPayload>;
export type CephDraftWriteRequest = {
  patientId: number;
  documentId: number;
} & ({ session: SessionPayload; admit?: undefined } | { admit: CephCanonicalAdmit; session?: undefined });
export function assertCephDraftRequest(request: CephDraftWriteRequest): void {
  if (!request || (!request.session && typeof request.admit !== "function") || (request.session && request.admit)
    || !Number.isSafeInteger(request.patientId) || request.patientId <= 0
    || !Number.isSafeInteger(request.documentId) || request.documentId <= 0) {
    throw new ClinicalMutationAuthorityError(401, "هوية طلب تعديل الدراسة غير صالحة.");
  }
}
/** Match completion's patient → account/access → analysis → image lock order. */
export async function authorizeCephDraft(client: DbClient, request: CephDraftWriteRequest): Promise<SessionPayload> {
  assertCephDraftRequest(request);
  const { rows } = await client.query("SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE", [request.patientId]);
  if (request.admit) {
    if (!rows.length) throw new ClinicalMutationAuthorityError(403, "غير مصرّح لك بتعديل دراسة هذا المريض.");
    return request.admit(client, request.patientId);
  }
  const current = await currentClinicalActor(request.session!, client);
  if (!rows.length || !canWriteCephClinical(current.role)
    || !await canAccessPatient(current, request.patientId, "canUploadXrays", client, "nowait")) {
    throw new ClinicalMutationAuthorityError(403, "غير مصرّح لك بتعديل دراسة هذا المريض.");
  }
  return current;
}
/** Called only after the analysis row lock; never substitute another image. */
export async function assertCephDraftScope(client: DbClient, request: CephDraftWriteRequest,
  analysis: { patient_id: number; document_id: number }): Promise<void> {
  if (analysis.patient_id !== request.patientId || analysis.document_id !== request.documentId) {
    throw new ClinicalMutationAuthorityError(409, "تغيّر صاحب الدراسة أو صورتها؛ أعد فتح الدراسة للمراجعة.");
  }
  const { rows: [image] } = await client.query<{ patient_id: number }>(
    "SELECT patient_id FROM patient_documents WHERE id = $1 FOR SHARE NOWAIT", [request.documentId]);
  if (!image || image.patient_id !== request.patientId) {
    throw new ClinicalMutationAuthorityError(409, "الصورة المرتبطة لا تخص مريض الدراسة؛ راجع رابطها.");
  }
}
