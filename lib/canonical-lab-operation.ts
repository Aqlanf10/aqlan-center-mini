import "server-only";
import { doctorOwnsPatient, type DbClient } from "./db";
import { CANONICAL_LAB_OPERATION_BRAND, type CanonicalLabOperation } from "./lab-work-intent-db";
import {
  staffOperationCapabilities,
  staffOperationIdentity,
  staffOperationPatientScope,
  type StaffOperationHandle,
  type StaffRuntimeAction,
} from "./staff-operation-runtime";

/**
 * Transaction-bound canonical lab-work authorization handle.
 * Kept in a `server-only` module outside `lib/db.ts`'s import graph so plain-Node
 * child scripts (`tsx`) never resolve Next's `server-only` marker.
 */
export function canonicalLabOperation(
  handle: StaffOperationHandle,
  action: StaffRuntimeAction,
): CanonicalLabOperation {
  return Object.freeze({
    async [CANONICAL_LAB_OPERATION_BRAND](client: DbClient, patientId: number) {
      const identity = await staffOperationIdentity(client, handle, action);
      const capabilities = await staffOperationCapabilities(client, handle, action, ["clinical.lab.order"] as const);
      if (!Number.isSafeInteger(identity.userId) || identity.userId <= 0 || !capabilities.has("clinical.lab.order")) {
        return null;
      }
      const scope = await staffOperationPatientScope(client, handle, action);
      if (scope.kind === "none") return null;
      if (scope.kind === "own" && !(await doctorOwnsPatient(scope.clinicianPartyId, patientId, client, "nowait"))) {
        return null;
      }
      return { userId: identity.userId, username: identity.username, role: identity.role };
    },
  });
}
