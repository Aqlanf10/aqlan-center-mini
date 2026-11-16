import "server-only";
import { getPool } from "./db";
import { patientResponsibilityOn, ResponsibilityError, validateResponsibilityInput, type ResponsibilityCommand, type ResponsibilityTarget } from "./patient-responsibility-settings";
import { staffOperationIdentity, staffOperationOwnerOperations, withStaffOperation } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * The case's responsible doctor on the canonical runtime (M2 slice 88b; owner decision
 * G4-7, 6648682456): `GET/PATCH /api/patients/[id]/responsibility`.
 *
 * The protected owner alone, for now: the owner-only operation
 * `clinical.case-responsibility.change` (never an editable grant; no finance grant or
 * general administrative label reaches it). Proved wherever the legacy writer revalidated
 * its admin session: before the read, after the writes and before the commit. The legacy
 * body (`patientResponsibilityOn`) is unchanged: the fingerprint guard, the doctor held
 * FOR SHARE NOWAIT, a written reason, and the `case.responsibility_change` audit with the
 * actor, the previous and the new doctor in the same transaction. Admission rides on
 * `patients.edit` (an action the owner always holds); without the owner operation the
 * request is refused even with that grant. Any later delegation needs its own decision.
 */
const ACTION = "patients.edit" as const;
const OPERATION = "clinical.case-responsibility.change" as const;

export async function commandCanonicalCaseResponsibility(session: VerifiedDurableSession, target: ResponsibilityTarget,
  command: ResponsibilityCommand | undefined, pool = getPool()) {
  validateResponsibilityInput(target, command);
  try {
    return await withStaffOperation(pool, session, ACTION, async (client, handle) => patientResponsibilityOn(client, target, command, async () => {
      if (!(await staffOperationOwnerOperations(client, handle, ACTION, [OPERATION] as const)).has(OPERATION)) {
        throw new ResponsibilityError(403, "تغيير الطبيب المسؤول عن الحالة للمالك وحده.");
      }
      const identity = await staffOperationIdentity(client, handle, ACTION);
      return { userId: identity.userId, username: identity.username, role: identity.role };
    }));
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") throw new ResponsibilityError(409, "يجري تحديث الحالة. أعد المحاولة بعد لحظة.");
    throw error;
  }
}
