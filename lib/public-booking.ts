import { CLINIC_TIME_ZONE, ensureSchema, getPool, getSettingsInTransaction, listAppointmentServices, listAppointmentsByDate, listParties } from "./db";
import { loadCapacityContext, loadProviderBlockWindows } from "./capacity-context";
import { readDoctorAvailabilityAdvisory } from "./doctor-availability-advisory";
import { doctorAvailabilitySuggestions } from "./appointment-availability-advisory";
import { addDays, clinicDateString, toMinutes } from "./schedule";
import type { BookingRequestInput } from "./booking";

async function liveSettings() {
  await ensureSchema();
  const client = await getPool().connect();
  try { return await getSettingsInTransaction(client); } finally { client.release(); }
}

/** Public allowlist only. No patient rows, HR identities, block reasons or internal settings. */
export async function publicBookingCatalog() {
  const [settings, services, doctors] = await Promise.all([liveSettings(), listAppointmentServices(), listParties("doctor")]);
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const horizon = Math.min(366, Math.max(1, Number(settings["scheduling.max_days_ahead"]) || 60));
  const workingDays = (settings["clinic.working_days"] ?? "0,1,2,3,4,5,6").split(",").filter(Boolean).map(Number);
  return { today, timeZone: CLINIC_TIME_ZONE,
    days: Array.from({ length: horizon + 1 }, (_, index) => addDays(today, index))
      .filter(date => workingDays.includes(new Date(`${date}T12:00:00Z`).getUTCDay())),
    services: services.map(service => ({ id: service.id, name: service.nameAr, durationMinutes: service.defaultDurationMinutes, followUp: service.legacyType === "follow_up" })),
    doctors: doctors.filter(doctor => doctor.isActive).map(doctor => ({ id: doctor.id, name: doctor.name })),
  };
}

export async function publicBookingTimes(date: string, serviceId: number, doctorId: number) {
  const catalog = await publicBookingCatalog();
  if (!catalog.days.includes(date) || !catalog.services.some(service => service.id === serviceId)
    || !catalog.doctors.some(doctor => doctor.id === doctorId)) throw new Error("BOOKING_SELECTION_INVALID");
  const [services, context, appointments, blocks, roster] = await Promise.all([
    listAppointmentServices(), liveSettings().then(loadCapacityContext), listAppointmentsByDate(date),
    loadProviderBlockWindows(doctorId, date), readDoctorAvailabilityAdvisory(doctorId, date, CLINIC_TIME_ZONE),
  ]);
  const service = services.find(row => row.id === serviceId);
  if (!service) throw new Error("BOOKING_SELECTION_INVALID");
  const now = new Date();
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: CLINIC_TIME_ZONE,
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const suggestions = doctorAvailabilitySuggestions({ date, doctorId, durationMinutes: service.defaultDurationMinutes,
    // A named doctor cannot be double-booked from the public portal, including services
    // whose internal workflow permits concurrent provider work.
    service: { ...service, requiresProvider: true, allowsConcurrentProviderWork: false }, context,
    appointments, blocks, roster, timeZone: CLINIC_TIME_ZONE,
    today: clinicDateString(now, CLINIC_TIME_ZONE), nowMinutes: toMinutes(clock) ?? 0 });
  return { date, serviceId, doctorId, durationMinutes: service.defaultDurationMinutes, timeZone: CLINIC_TIME_ZONE,
    times: suggestions.slots.filter(slot => slot.status === "available").map(slot => slot.time),
    bookingGuaranteed: false as const };
}

export async function validatePublicBookingSelection(input: BookingRequestInput) {
  const preferences = input.preferences ?? {};
  if (preferences.serviceId || preferences.doctorId || preferences.time) {
    if (!input.preferredDate || !preferences.serviceId || !preferences.doctorId || !preferences.time) throw new Error("BOOKING_SELECTION_INVALID");
    const available = await publicBookingTimes(input.preferredDate, preferences.serviceId, preferences.doctorId);
    if (!available.times.includes(preferences.time)) throw new Error("BOOKING_SLOT_UNAVAILABLE");
  } else if (input.preferredDate) {
    if (!(await publicBookingCatalog()).days.includes(input.preferredDate)) throw new Error("BOOKING_SELECTION_INVALID");
  }
}
