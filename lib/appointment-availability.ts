import { effectiveWindow, windowsOverlap, type AppointmentService } from "./appointment-services";
import { judgeFullCapacity, usableShifts, type ProviderBlockWindow } from "./capacity";
import { FALLBACK_SERVICE, type CapacityContext } from "./capacity-context";
import { occupiesChair, toMinutes, toTime, type Appointment } from "./schedule";

export type DoctorSlotStatus = "available" | "booked" | "blocked" | "unavailable";
export interface DoctorSlot {
  time: string;
  status: DoctorSlotStatus;
  label: string;
}

type AvailabilityService = Pick<AppointmentService,
  "nameAr" | "isActive" | "requiresProvider" | "requiresChair" | "allowsConcurrentProviderWork"
  | "consumesEmergencyReserve" | "bufferBeforeMinutes" | "bufferAfterMinutes">;

/** أوقات الطبيب في ورديات المركز، وفق حجب الطبيب والحجوزات وسعة الخدمة المختارة. */
export function doctorAvailabilitySlots(input: {
  date: string;
  doctorId: number;
  durationMinutes: number;
  service: AvailabilityService | null;
  context: CapacityContext;
  appointments: Appointment[];
  blocks: ProviderBlockWindow[];
  chairNo?: number | null;
  isNewPatient?: boolean;
  today: string;
  nowMinutes: number;
}): DoctorSlot[] {
  const { date, doctorId, durationMinutes, service, context, appointments, blocks, today, nowMinutes } = input;
  const selectedService = service ?? FALLBACK_SERVICE;
  const before = service?.bufferBeforeMinutes ?? 0;
  const after = service?.bufferAfterMinutes ?? 0;
  const starts = new Set<number>();
  for (const shift of usableShifts(context.shifts)) {
    for (let minute = Math.ceil(shift.start / 15) * 15; minute + durationMinutes <= shift.end; minute += 15) {
      starts.add(minute);
    }
  }

  return [...starts].sort((a, b) => a - b).map((minute): DoctorSlot => {
    const time = toTime(minute);
    const proposed = effectiveWindow({ startMinutes: minute, durationMinutes, bufferBeforeMinutes: before, bufferAfterMinutes: after });
    if (date < today || (date === today && minute <= nowMinutes)) {
      return { time, status: "unavailable", label: "وقت مضى" };
    }
    if (selectedService.requiresProvider && blocks.some((block) => windowsOverlap(proposed, { start: block.startMinutes, end: block.endMinutes }))) {
      return { time, status: "blocked", label: "الطبيب غير متاح" };
    }
    if (selectedService.requiresProvider && !selectedService.allowsConcurrentProviderWork && appointments.some((appointment) => {
      if (appointment.doctorId !== doctorId || !occupiesChair(appointment.status)) return false;
      const start = toMinutes(appointment.scheduledTime);
      if (start === null) return false;
      const occupied = effectiveWindow({
        startMinutes: start, durationMinutes: appointment.durationMinutes,
        bufferBeforeMinutes: appointment.bufferBeforeMinutes ?? 0,
        bufferAfterMinutes: appointment.bufferAfterMinutes ?? 0,
      });
      return windowsOverlap(proposed, occupied);
    })) {
      return { time, status: "booked", label: "محجوز" };
    }
    const verdict = judgeFullCapacity({
      appointments, date, time, durationMinutes,
      bufferBeforeMinutes: before, bufferAfterMinutes: after,
      chairs: context.chairs, shifts: context.shifts,
      nearCapacityPercent: context.nearCapacityPercent,
      service: selectedService, providerId: doctorId, providerBlocks: blocks,
      emergencyReserveMinutesPerShift: context.emergencyReserveMinutes,
      chairNo: input.chairNo ?? null,
      isNewPatient: input.isNewPatient ?? false,
      newPatientDailyLimit: context.newPatientDailyLimit,
      newPatientsBookedToday: appointments.filter((appointment) => appointment.isNewPatient === true).length,
    });
    return verdict.state === "OVER_CAPACITY" || verdict.outsideHours
      ? { time, status: "unavailable", label: "غير متاح" }
      : { time, status: "available", label: "متاح" };
  });
}
