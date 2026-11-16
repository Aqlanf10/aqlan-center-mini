import "server-only";
import { getPool, insertAuditRow, listBookingRequestsWith, rejectBookingRequestWith, type AuditInput, type DbClient } from "./db";
import type { BookingActor } from "./book-appointment";
import type { BookingRequest, BookingRequestStatus } from "./booking";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationAppointmentScope, staffOperationCapabilities, staffOperationIdentity, withStaffOperation } from "./staff-operation-runtime";

/**
 * Canonical online booking requests (M2 slice 21): GET /api/booking-requests and
 * PATCH /api/booking-requests/[id] (confirm, reject).
 *
 * The queue holds people who are not patients yet (name and phone), so it opens only to
 * `appointments.create` with the WHOLE appointment scope: an `own`-scope clinician
 * neither reads nor handles it (the confirmed appointment would land outside its scope).
 * - Read: the record read `read:booking-requests`, one owning snapshot.
 * - Reject: one admitted `appointments.cancel` transaction; the request row is updated
 *   only while new; a `booking_request.reject` audit row commits with it. Rejecting
 *   never needs, and never grants, booking.
 * - Confirm: one admitted `appointments.create` transaction running the route's own
 *   capacity-engine door on the admitted client (day locks, then the request row,
 *   judgement, confirmation), with the capacity override only for
 *   `appointments.override-capacity`; a request whose phone matches no patient also needs
 *   `patients.create` (it creates the patient file). The appointment.create,
 *   booking_request.confirm and any override rows are atomic; any refusal rolls back.
 */
export class CanonicalBookingRequestRefusal extends Error {
  constructor(readonly code: "invalid_booking_request" | "booking_request_handled", readonly status: 400 | 409, message: string) {
    super(message);
    this.name = "CanonicalBookingRequestRefusal";
  }
}

const STATUSES: readonly BookingRequestStatus[] = ["new", "confirmed", "rejected"];

export function parseBookingRequestStatus(value: string | null): BookingRequestStatus {
  const status = value ?? "new";
  if (!(STATUSES as readonly string[]).includes(status)) throw new CanonicalBookingRequestRefusal("invalid_booking_request", 400, "حالة غير معروفة.");
  return status as BookingRequestStatus;
}

export async function readCanonicalBookingRequests(session: VerifiedDurableSession, status: BookingRequestStatus): Promise<BookingRequest[]> {
  return runCanonicalReadSnapshot(session, "read:booking-requests", async (query, scope) => {
    if (scope.appointmentScope.kind !== "all") throw new Error("STAFF_READ_RECORD_SCOPE_DENIED");
    return listBookingRequestsWith(query, status);
  }, { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 });
}

function validId(id: number): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new CanonicalBookingRequestRefusal("invalid_booking_request", 400, "رقم الطلب غير صالح.");
  return id;
}

export async function commandCanonicalBookingRequestReject(session: VerifiedDurableSession, rawId: number, pool = getPool()): Promise<BookingRequest> {
  const id = validId(rawId);
  return withStaffOperation(pool, session, "appointments.cancel", async (client, handle) => {
    if ((await staffOperationAppointmentScope(client, handle, "appointments.cancel")).kind !== "all") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const rejected = await rejectBookingRequestWith(client, id);
    if (!rejected) throw new CanonicalBookingRequestRefusal("booking_request_handled", 409, "الطلب عولج سلفًا.");
    const identity = await staffOperationIdentity(client, handle, "appointments.cancel");
    await insertAuditRow(client, {
      action: "booking_request.reject", entity: "booking_request", entityId: id, entityLabel: rejected.fullName,
      details: { الطلب: id }, actor: identity.username, actorRole: identity.role,
    });
    return rejected;
  });
}

/** What the route's confirmation door needs on the canonical path. */
export interface CanonicalConfirmContext {
  readonly client: DbClient;
  readonly actor: BookingActor & { userId: number };
  readonly audit: (row: AuditInput) => Promise<void>;
  readonly allowNewPatient: boolean;
}
type ConfirmOutcome = { ok: true; confirmed: { appointmentId: number; patientId: number } } | { ok: false };

class ConfirmNotDone<R> extends Error {
  constructor(readonly result: R) { super("booking request not confirmed"); }
}

/**
 * Admits `appointments.create` and runs the route's confirmation door on the admitted
 * transaction. A result that is not ok rolls the transaction back and is returned as is,
 * so the route answers with its legacy shapes.
 */
export async function commandCanonicalBookingRequestConfirm<R extends ConfirmOutcome>(
  session: VerifiedDurableSession, rawId: number,
  confirm: (context: CanonicalConfirmContext) => Promise<R>, pool = getPool(),
): Promise<R> {
  const id = validId(rawId);
  try {
    return await withStaffOperation(pool, session, "appointments.create", async (client, handle) => {
      if ((await staffOperationAppointmentScope(client, handle, "appointments.create")).kind !== "all") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const held = await staffOperationCapabilities(client, handle, "appointments.create", ["appointments.override-capacity", "patients.create"]);
      const identity = await staffOperationIdentity(client, handle, "appointments.create");
      const audit = (row: AuditInput) => insertAuditRow(client, row);
      // Role "canonical" is a display label the engine never matches: grants decide.
      const result = await confirm({
        client, audit, allowNewPatient: held.has("patients.create"),
        actor: { username: identity.username, userId: identity.userId, role: "canonical", channel: "ui", canOverrideCapacity: held.has("appointments.override-capacity") },
      });
      if (!result.ok) throw new ConfirmNotDone(result);
      await audit({
        action: "appointment.create", entity: "appointment", entityId: result.confirmed.appointmentId,
        details: { "طلب الحجز": id, المريض: result.confirmed.patientId }, actor: identity.username, actorRole: identity.role,
      });
      await audit({
        action: "booking_request.confirm", entity: "booking_request", entityId: id,
        details: { الموعد: result.confirmed.appointmentId, المريض: result.confirmed.patientId }, actor: identity.username, actorRole: identity.role,
      });
      return result;
    });
  } catch (error) {
    if (error instanceof ConfirmNotDone) return error.result as R;
    throw error;
  }
}
