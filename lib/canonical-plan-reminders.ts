import "server-only";
import { doctorOwnsPatient, getPool, recordPlanInstallmentRemindersOn, type DbClient } from "./db";
import { CanonicalPlanRefusal } from "./canonical-plan-writes";
import { staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * POST /api/plans/reminders on the canonical runtime (M2 slice 94e; owner decision G4-8;
 * contract section 14). `appointments.create`; the legacy writer on the admitted operation's
 * transaction. After the plan row locks, each plan's patient scope is decided: `all` admits
 * every plan; `own` needs a positive ownership witness FOR SHARE NOWAIT (a lock conflict is
 * 409 and nothing is written). A plan outside the scope is skipped and not counted, exactly
 * like a missing one. Role labels decide nothing.
 */
const ACTION = "appointments.create" as const;

function scopedAdmission(client: DbClient, handle: StaffOperationHandle) {
  return async (patientId: number): Promise<boolean> => {
    const scope = await staffOperationPatientScope(client, handle, ACTION);
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.kind === "all") return true;
    try { return await doctorOwnsPatient(scope.clinicianPartyId, patientId, client, "nowait"); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "55P03") {
        throw new CanonicalPlanRefusal("patient_scope_conflict", 409, "تعذّر تثبيت نطاق المريض. حدّث الصفحة وأعد المحاولة.");
      }
      throw error;
    }
  };
}

export async function commandCanonicalPlanReminders(session: VerifiedDurableSession,
  input: { planIds: number[]; installmentNumber?: number; bulk: boolean }, pool = getPool()) {
  return withStaffOperation(pool, session, ACTION, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, ACTION);
    return recordPlanInstallmentRemindersOn(client, { ...input, actor: identity.username, actorRole: identity.role }, scopedAdmission(client, handle));
  });
}
