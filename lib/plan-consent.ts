/** Optional schedule intent, validated before a consent command can write. */
export interface PlanConsentSchedule {
  count: number;
  everyDays: number;
  firstDueDate: string;
}

type ScheduleResult =
  | { ok: true; schedule: PlanConsentSchedule | null }
  | { ok: false; message: string };

function numericInput(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return NaN;
  return Number(value);
}

function realCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  // addDays uses Date.UTC; years below 100 have different constructor semantics.
  if (year < 100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function parseConsentSchedule(source: Record<string, unknown>, today: string): ScheduleResult {
  const rawCount = source.count === undefined ? 0 : numericInput(source.count);
  const count = Math.round(rawCount);
  if (!Number.isFinite(rawCount) || rawCount < 0 || count > 60 || (rawCount > 0 && count < 1)) {
    return { ok: false, message: "عدد الأقساط بين 1 و60، أو صفر للموافقة دون تقسيط." };
  }
  const rawEveryDays = source.everyDays === undefined ? 30 : numericInput(source.everyDays);
  const everyDays = Math.round(rawEveryDays);
  if (!Number.isFinite(rawEveryDays) || rawEveryDays <= 0 || everyDays < 1 || everyDays > 365) {
    return { ok: false, message: "المدة بين الأقساط بين 1 و365 يومًا." };
  }
  const firstDueDate = source.firstDueDate === undefined ? today : source.firstDueDate;
  if (!realCalendarDate(firstDueDate)) {
    return { ok: false, message: "تاريخ أول قسط غير صالح." };
  }
  return { ok: true, schedule: count === 0 ? null : { count, everyDays, firstDueDate } };
}
