import { isKnownZone } from "./clinicZone";
import type { DoctorSlot } from "./appointment-availability";

/** Display suggestions only. This contract never grants booking authority. */
export interface DoctorAvailabilityResponse {
  purpose: "advisory_only";
  bookingGuaranteed: false;
  doctorId: number;
  date: string;
  durationMinutes: number;
  timeZone: string;
  rosterStatus: "resolved" | "unknown";
  slots: DoctorSlot[];
}

/** Reject incomplete, mismatched or unqualified successes instead of showing green times. */
export function parseDoctorAvailabilityResponse(value: unknown, expected: {
  doctorId: number; date: string; durationMinutes: number;
}): DoctorAvailabilityResponse | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (body.purpose !== "advisory_only" || body.bookingGuaranteed !== false
    || body.doctorId !== expected.doctorId || body.date !== expected.date
    || body.durationMinutes !== expected.durationMinutes
    || typeof body.timeZone !== "string" || !body.timeZone || !isKnownZone(body.timeZone)
    || (body.rosterStatus !== "resolved" && body.rosterStatus !== "unknown")
    || !Array.isArray(body.slots) || body.slots.length > 96
    || (body.rosterStatus === "unknown" && body.slots.length !== 0)) return null;
  const slots: DoctorSlot[] = [];
  for (const candidate of body.slots) {
    if (!candidate || typeof candidate !== "object") return null;
    const slot = candidate as Record<string, unknown>;
    if (typeof slot.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)
      || (slots.length > 0 && slots.at(-1)!.time >= slot.time)
      || !["available", "booked", "blocked", "unavailable"].includes(String(slot.status))
      || typeof slot.label !== "string" || !slot.label.trim() || slot.label.length > 80) return null;
    slots.push({ time: slot.time, status: slot.status as DoctorSlot["status"], label: slot.label });
  }
  return { purpose: "advisory_only", bookingGuaranteed: false, ...expected,
    timeZone: body.timeZone, rosterStatus: body.rosterStatus, slots };
}
