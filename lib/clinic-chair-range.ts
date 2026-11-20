/** Hard physical bound already enforced by clinic.chairs settings and the TV.
 * The caller uses the current configured count for actual movements and cards. */
export const MAX_CLINIC_CHAIRS = 20;
export function isClinicChairNumber(value: unknown, configuredCount = MAX_CLINIC_CHAIRS): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    && value <= MAX_CLINIC_CHAIRS && value <= configuredCount;
}
