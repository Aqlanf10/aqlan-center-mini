import "server-only";
import type { SessionPayload } from "./auth";
import type { CephCanonicalAdmit } from "./ceph-draft-authority";
import { ClinicalMutationAuthorityError } from "./clinical-mutation-authority";
import { doctorOwnsPatient, type DbClient } from "./db";
import { revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationIdentity, staffOperationPatientScope, type StaffOperationHandle, type StaffRuntimeAction } from "./staff-operation-runtime";

/**
 * Canonical admission for staging's ceph writers (runCephWritersInTransaction). Called by the
 * writer right after it locks the patient row: proves the operation's current patient scope on
 * that locked patient and returns the actor the writer records and re-checks for expiry.
 * The capability itself was proved when the staff operation was opened for `action`, and the
 * operation re-asserts it before commit. Out of scope is refused as 404-like "not available",
 * never as a different patient's data.
 */
export function canonicalCephAdmission(session: VerifiedDurableSession, handle: StaffOperationHandle, action: StaffRuntimeAction): CephCanonicalAdmit {
  return async (client: DbClient, patientId: number): Promise<SessionPayload> => {
    const scope = await staffOperationPatientScope(client, handle, action);
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.kind === "own" && !await doctorOwnsPatient(scope.clinicianPartyId, patientId, client, "nowait")) {
      throw new ClinicalMutationAuthorityError(403, "الدراسة غير متاحة ضمن مرضاك.");
    }
    const identity = await staffOperationIdentity(client, handle, action);
    const claims = revalidateVerifiedDurableSession(session);
    if (!claims || claims.userId !== identity.userId || claims.username !== identity.username) {
      throw new ClinicalMutationAuthorityError(401, "انتهت الجلسة أو تغيّرت صلاحياتها.");
    }
    return { userId: identity.userId, username: identity.username, role: identity.role, expiresAt: claims.expiresAt };
  };
}
