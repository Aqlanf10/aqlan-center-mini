import { MIN_DURATION, MAX_DURATION, type AppointmentService } from "./appointment-services";

/** The board can propose only this active, unambiguous scheduling identity. */
export function isPeriodicFollowupService(service: AppointmentService | null | undefined): service is AppointmentService {
  return !!service && service.code === "ORTHO_FOLLOW_UP"
    && service.isActive === true && service.specialty === "orthodontics"
    && (service.legacyType === "follow_up" || service.legacyType === null)
    && Number.isInteger(service.id) && service.id > 0
    && Number.isInteger(service.defaultDurationMinutes)
    && service.defaultDurationMinutes >= MIN_DURATION && service.defaultDurationMinutes <= MAX_DURATION;
}

export const FOLLOWUP_SERVICE_REVIEW_MESSAGE = "تعذّر تأكيد خدمة متابعة التقويم. أعد تحميل الخدمات أو اختر نوع الموعد والخدمة بعد المراجعة.";
