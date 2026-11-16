import "server-only";
import { getPool, insertAuditRow, patientInDoctorScopeWith, type AuditInput, type DbClient } from "./db";
import type { BookingActor } from "./book-appointment";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { readCanonicalPatientRecord } from "./canonical-patient-reads";
import { listReturnBookingContexts, readReturnBookingContext, type ReturnBookingSource } from "./return-booking-context";
import { rebookPlannedVisitWith, type PlannedRebookResult } from "./planned-visit-rebooking";
import type { PlannedRebookIntent } from "./planned-visit-rebooking-contract";
import { staffOperationAppointmentScope, staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

/**
 * Canonical planned-visit scheduling (M2 slice 22): POST /api/planned-visits/[id]/schedule.
 *
 * One admitted `appointments.create` transaction running the route's own
 * capacity-engine door (lib/planned-visit-schedule.ts) on the admitted client:
 *  - the planned visit's patient must be inside the CURRENT patient scope (the map's
 *    scope; `own` = the patient list's condition); a missing visit and one outside the
 *    scope answer identically (404);
 *  - the appointment scope must not be `none`; with `own` the appointment lands on the
 *    case's responsible doctor, which must be the actor's clinician party (403 and roll
 *    back otherwise — the canonical path never books outside its own schedule);
 *  - the engine takes the day locks, then the planned row, as on the legacy path; the
 *    override needs `appointments.override-capacity`; the appointment.create and any
 *    override rows commit with the booking; any refusal rolls back.
 */
export class CanonicalPlannedVisitRefusal extends Error {
  constructor(readonly code: "invalid_planned_visit" | "planned_visit_not_found" | "planned_visit_doctor_not_allowed", readonly status: 400 | 403 | 404, message: string) {
    super(message);
    this.name = "CanonicalPlannedVisitRefusal";
  }
}

export interface CanonicalPlannedScheduleContext {
  readonly client: DbClient;
  readonly patientId: number;
  readonly actor: BookingActor & { userId: number };
  readonly audit: (row: AuditInput) => Promise<void>;
}
type ScheduleOutcome = { ok: true; appointmentId: number; doctorId: number | null } | { ok: false };

class ScheduleNotDone<R> extends Error {
  constructor(readonly result: R) { super("planned visit not scheduled"); }
}

const NOT_FOUND = "لا توجد جلسة مخطَّطة بهذا الرقم ضمن مرضاك.";

export async function commandCanonicalPlannedVisitSchedule<R extends ScheduleOutcome>(
  session: VerifiedDurableSession, plannedVisitId: number,
  schedule: (context: CanonicalPlannedScheduleContext) => Promise<R>, pool = getPool(),
): Promise<R> {
  if (!Number.isSafeInteger(plannedVisitId) || plannedVisitId <= 0) throw new CanonicalPlannedVisitRefusal("invalid_planned_visit", 400, "رقم الزيارة المخطَّطة غير صالح.");
  try {
    return await withStaffOperation(pool, session, "appointments.create", async (client, handle) => {
      const patientScope = await staffOperationPatientScope(client, handle, "appointments.create");
      const appointmentScope = await staffOperationAppointmentScope(client, handle, "appointments.create");
      if (patientScope.kind === "none" || appointmentScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      // No row lock here: the engine takes the day locks, then the planned row (legacy order).
      const { rows: [planned] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM planned_visits WHERE id = $1", [plannedVisitId]);
      const inside = planned && (patientScope.kind === "all" || await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, planned.patient_id));
      if (!inside) throw new CanonicalPlannedVisitRefusal("planned_visit_not_found", 404, NOT_FOUND);
      const held = await staffOperationCapabilities(client, handle, "appointments.create", ["appointments.override-capacity"]);
      const identity = await staffOperationIdentity(client, handle, "appointments.create");
      const audit = (row: AuditInput) => insertAuditRow(client, row);
      // Role "canonical" is a display label the engine never matches: grants decide.
      const result = await schedule({
        client, patientId: planned.patient_id, audit,
        actor: { username: identity.username, userId: identity.userId, role: "canonical", channel: "visit", canOverrideCapacity: held.has("appointments.override-capacity") },
      });
      if (!result.ok) throw new ScheduleNotDone(result);
      if (appointmentScope.kind === "own" && result.doctorId !== appointmentScope.clinicianPartyId) {
        throw new CanonicalPlannedVisitRefusal("planned_visit_doctor_not_allowed", 403, "هذه الجلسة تُحجز على طبيب الحالة المسؤول؛ يحجزها من يملك نطاق المواعيد كاملًا.");
      }
      await audit({
        action: "appointment.create", entity: "appointment", entityId: result.appointmentId,
        details: { "الجلسة المخطَّطة": plannedVisitId, الطبيب: result.doctorId ?? "" }, actor: identity.username, actorRole: identity.role,
      });
      return result;
    });
  } catch (error) {
    if (error instanceof ScheduleNotDone) return error.result as R;
    throw error;
  }
}

/**
 * GET /api/patients/[id]/return-booking-context on the canonical path (M2 slice 22): the
 * case contexts a return booking may follow, or one context with its responsible doctor
 * and fingerprint, read in the patient record snapshot (patient inside the CURRENT
 * patient scope; outside = missing). The same resolver as the legacy route.
 */
export async function readCanonicalReturnBookingContext(session: VerifiedDurableSession, patientId: number, source: ReturnBookingSource | null, origin?: ReturnBookingSource) {
  return readCanonicalPatientRecord(session, "read:patients.record", patientId, async query => {
    const runner = query as unknown as DbClient;
    if (!source) return { status: 200 as const, body: { contexts: await listReturnBookingContexts(runner, patientId) } };
    const result = await readReturnBookingContext(runner, patientId, source, { origin });
    return { status: result.ok ? 200 as const : 409 as const, body: result };
  });
}

/**
 * POST /api/planned-visits/[id]/rebook on the canonical path (M2 slice 23): the same
 * atomic rebooking writer, with the canonical admitted operation as its authority. One
 * admitted `appointments.create` transaction (the writer's whole lock order runs inside
 * it); at the writer's fixed points the identity is the admitted one (its grants are
 * held FOR SHARE for the whole transaction), patient access is the CURRENT patient
 * scope, scheduling a referral appointment needs the whole appointment scope or the
 * receiving clinician, and `own` appointment scope rebooks only on its own party. The
 * receipt (idempotent replay) is keyed by the canonical user id. Any refusal rolls back.
 */
class RebookNotDone extends Error {
  constructor(readonly result: PlannedRebookResult) { super("planned visit not rebooked"); }
}

export async function commandCanonicalPlannedVisitRebook(session: VerifiedDurableSession, intent: PlannedRebookIntent, pool = getPool()): Promise<PlannedRebookResult> {
  try {
    return await withStaffOperation(pool, session, "appointments.create", async (client, handle) => {
      const patientScope = await staffOperationPatientScope(client, handle, "appointments.create");
      const appointmentScope = await staffOperationAppointmentScope(client, handle, "appointments.create");
      if (patientScope.kind === "none" || appointmentScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const identity = await staffOperationIdentity(client, handle, "appointments.create");
      const clinician = appointmentScope.kind === "own" ? appointmentScope.clinicianPartyId : null;
      const actor = { userId: identity.userId, username: identity.username, role: identity.role, partyId: clinician };
      const result = await rebookPlannedVisitWith(intent, {
        client,
        revalidate: async () => actor,
        canAccessPatient: async (_actor, patientId, q) => patientScope.kind === "all" || patientInDoctorScopeWith(q, patientScope.clinicianPartyId, patientId),
        canScheduleReferral: (_actor, referral) => clinician === null || referral.to_party_id === clinician,
        stillValid: () => true,
        admitsDoctor: doctorId => clinician === null || doctorId === clinician,
      });
      if (!result.ok) throw new RebookNotDone(result);
      return result;
    });
  } catch (error) {
    if (error instanceof RebookNotDone) return error.result;
    throw error;
  }
}
