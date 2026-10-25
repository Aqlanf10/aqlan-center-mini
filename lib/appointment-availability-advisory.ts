import { doctorAvailabilitySlots } from "./appointment-availability";
import { doctorBookingRefusal, type DoctorBookingDay } from "./doctor-booking-window";
import type { DoctorAvailabilityResponse } from "./appointment-availability-contract";

/** Intersects proven duty with the existing capacity suggestions. Read-only, not admission.
 * A selected doctor's duty is relevant to a suggestion even for a non-provider service;
 * this deliberately does not change which services the canonical writer may accept.
 */
export function doctorAvailabilitySuggestions(input: Parameters<typeof doctorAvailabilitySlots>[0] & {
  roster: DoctorBookingDay; timeZone: string;
}): DoctorAvailabilityResponse {
  const response: DoctorAvailabilityResponse = {
    purpose: "advisory_only", bookingGuaranteed: false,
    doctorId: input.doctorId, date: input.date, durationMinutes: input.durationMinutes,
    timeZone: input.timeZone, rosterStatus: input.roster.resolved ? "resolved" : "unknown", slots: [],
  };
  if (!input.roster.resolved || input.roster.windows.length === 0) return response;
  response.slots = doctorAvailabilitySlots(input).map(slot => {
    const refusal = doctorBookingRefusal(input.roster, {
      date: input.date, time: slot.time, durationMinutes: input.durationMinutes,
      before: input.service?.bufferBeforeMinutes ?? 0, after: input.service?.bufferAfterMinutes ?? 0,
      zone: input.timeZone,
    });
    if (refusal) return { time: slot.time, status: "unavailable" as const, label: "خارج جدول الدوام" };
    return slot.status === "available" ? { ...slot, label: "مقترح" } : slot;
  });
  return response;
}
