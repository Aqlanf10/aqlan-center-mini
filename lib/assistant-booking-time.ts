// Booking is operational: do not apply the generic parser's guessed p.m. default.
export function parseExplicitBookingTime(text: string): string | null {
  const normalized = text
    .replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) % 16))
    .replace(/[\u064B-\u065F\u0670]/gu, "")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, " ");
  const candidates = [...normalized.matchAll(
    /(?:الساعة[\s:]+(\d{1,2})(?::(\d{2}))?(?![\d:])|(?<![\d:])(\d{1,2}):(\d{2})(?![\d:]))(?:\s*(صباحا?|فجرا?|عصرا?|مساء|ليلا?|ظهرا?|منتصف الليل|[مص])(?=\s|[.،؟!؛]|$))?/gu,
  )];
  if (candidates.length !== 1) return null;
  const [, hourNamed, minuteNamed, hourClock, minuteClock, period] = candidates[0];
  const clockMinutes = minuteNamed ?? minuteClock;
  let hour = Number(hourNamed ?? hourClock);
  const minute = Number(clockMinutes ?? 0);
  if (hour > 23 || minute > 59) return null;
  if (period) {
    if (hour < 1 || hour > 12) return null;
    if (/^(?:ليل|ليلا|منتصف الليل)$/u.test(period)) {
      // Only 12 at night is unambiguous; other nighttime hours need a 24-hour clock.
      if (hour !== 12) return null;
      hour = 0;
    } else if (/^(?:عصرا?|مساء|ظهرا?|م)$/u.test(period)) {
      hour = (hour % 12) + 12;
    } else {
      hour %= 12;
    }
  } else if (!clockMinutes && hour >= 1 && hour <= 12) {
    return null;
  }
  return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
}
