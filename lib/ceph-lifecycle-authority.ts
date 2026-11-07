import type { DbClient } from "./db";
import type { SessionPayload } from "./auth";
import { assertCephDraftRequest, type CephDraftWriteRequest } from "./ceph-draft-authority";
import { currentClinicalActor, ClinicalMutationAuthorityError } from "./clinical-mutation-authority";
import { canAccessPatient } from "./patient-access";

/** Lifecycle operations preserve the existing CLINIC role contract, separately
 * from clinical calibration/landmark/diagnosis edits. The caller must next lock
 * and verify its exact admitted source rows and recheck expiry before commit. */
export async function authorizeCephLifecycle(client: DbClient, request: CephDraftWriteRequest): Promise<SessionPayload> {
  assertCephDraftRequest(request);
  const { rows } = await client.query("SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE", [request.patientId]);
  const current = await currentClinicalActor(request.session, client);
  if (!rows.length || !["admin", "reception", "doctor"].includes(current.role)
    || !await canAccessPatient(current, request.patientId, "canUploadXrays", client, "nowait")) {
    throw new ClinicalMutationAuthorityError(403, "غير مصرّح لك بإدارة دراسة هذا المريض.");
  }
  return current;
}
