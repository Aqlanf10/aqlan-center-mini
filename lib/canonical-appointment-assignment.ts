import "server-only";
import { patientInDoctorScopeWith, type DbClient } from "./db";
import { staffOperationPatientScope, type StaffOperationHandle, type StaffRuntimeAction } from "./staff-operation-runtime";

/** Appointment-wide scheduling authority is not authority to grant oneself a
 * new patient relationship. Run on the admitted client AFTER the day/doctor locks
 * and BEFORE the insert can make its own scope check true.
 * Other-doctor/unassigned bookings, the whole patient scope and the legacy engine
 * retain their rules. No new clinical assignment policy or capability is created. */
export function canonicalAppointmentAssignmentGuard(client: DbClient, handle: StaffOperationHandle, action: StaffRuntimeAction) {
  return async (patientId: number, doctorId: number | null): Promise<void> => {
    const scope = await staffOperationPatientScope(client, handle, action);
    if (scope.kind === "own" && doctorId === scope.clinicianPartyId
      && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId)) {
      throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    }
  };
}
