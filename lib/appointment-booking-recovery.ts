/** Tab-scoped recovery contains the exact request, never an inferred second booking.
 * Keep it across remount/navigation until success or a definite initial rejection. */
export const PATIENT_CREATE_PENDING_KEY = 'aqlan.appointment.patient-create-pending.v1';
export const APPOINTMENT_RECOVERY_KEY = 'aqlan.appointment.pending.v1';
export interface PendingAppointmentBooking {
  commandId: string;
  body: string;
}
export function parsePendingAppointmentBooking(raw: string | null): PendingAppointmentBooking | null {
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw);
    if (typeof pending.commandId !== 'string' || !/^[0-9a-f-]{36}$/.test(pending.commandId)
      || typeof pending.body !== 'string') return null;
    const body = JSON.parse(pending.body);
    if (!body.expectedActor || !Number.isSafeInteger(body.expectedActor.userId) || body.expectedActor.userId <= 0
      || typeof body.expectedActor.username !== 'string' || !body.expectedActor.username
      || body.commandId !== pending.commandId || !Number.isSafeInteger(body.patientId) || body.patientId <= 0) return null;
    return {commandId:pending.commandId,body:pending.body};
  } catch { return null; }
}
export function isBookingReceipt(value: unknown): value is {id:number;status:string} {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string,unknown>;
  return Number.isSafeInteger(item.id) && Number(item.id)>0
    && ['booked','arrived','done','cancelled','no_show'].includes(String(item.status));
}
