/**
 * Timezone-aware date utilities for the clinic.
 *
 * The clinic operates in `Asia/Aden` (UTC+03:00, no DST). All "today",
 * "overdue" and daily-queue computations must be anchored to the clinic's
 * timezone, never to the server's UTC clock, otherwise "Today" drifts by
 * three hours every day.
 *
 * Strategy:
 *  1. Read zoned calendar parts of any instant via Intl (authoritative).
 *  2. Convert zoned wall-clock parts back to UTC instants with the
 *     standard two-pass offset algorithm (correct for any timezone,
 *     including DST-observing ones).
 *  3. Store every timestamp in the database as `timestamptz` (UTC) and
 *     format for display in the clinic timezone.
 */

export const APP_TIMEZONE =
  process.env.NEXT_PUBLIC_APP_TIMEZONE || "Asia/Aden";

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsFromFormat(
  date: Date,
  timeZone: string
): Record<Intl.DateTimeFormatPartTypes, string> {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const result = {} as Record<Intl.DateTimeFormatPartTypes, string>;
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }
  return result;
}

/** Calendar parts (year/month/day/hour/minute/second) of an instant in a timezone. */
export function getZonedParts(date: Date, timeZone = APP_TIMEZONE): ZonedParts {
  const parts = partsFromFormat(date, timeZone);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset (ms) that must be added to a UTC timestamp to obtain local time. */
function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = partsFromFormat(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

/**
 * Convert a wall-clock time in the clinic timezone to the true UTC instant.
 * Two-pass: guess → measure real offset at guess → correct.
 */
export function zonedTimeToUtc(
  zoned: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone = APP_TIMEZONE
): Date {
  const guess = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour ?? 0,
    zoned.minute ?? 0,
    zoned.second ?? 0
  );
  const offsetAtGuess = getTimeZoneOffsetMs(new Date(guess), timeZone);
  const candidate = new Date(guess - offsetAtGuess);
  // Verify with a second pass to neutralize boundary instants.
  const offsetAtCandidate = getTimeZoneOffsetMs(candidate, timeZone);
  if (offsetAtCandidate === offsetAtGuess) {
    return candidate;
  }
  return new Date(guess - offsetAtCandidate);
}

/** ISO calendar date (YYYY-MM-DD) of "now" in the clinic timezone. */
export function getTodayIsoDate(now: Date = new Date(), timeZone = APP_TIMEZONE): string {
  const { year, month, day } = getZonedParts(now, timeZone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * UTC instants covering "today" in the clinic timezone.
 * Use with `WHERE appointment_date >= start AND appointment_date < end`.
 */
export function getAppDayRangeUtc(
  now: Date = new Date(),
  timeZone = APP_TIMEZONE
): { isoDate: string; startUtc: Date; endUtc: Date } {
  const { year, month, day } = getZonedParts(now, timeZone);
  const startUtc = zonedTimeToUtc({ year, month, day }, timeZone);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { isoDate: getTodayIsoDate(now, timeZone), startUtc, endUtc };
}

/** Add calendar days to an ISO date string (YYYY-MM-DD), timezone-neutral. */
export function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid ISO date: ${isoDate}`);
  }
  const utc = Date.UTC(year, month - 1, day) + days * 24 * 60 * 60 * 1000;
  const next = new Date(utc);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

const intlLocale = (locale: "ar" | "en") =>
  locale === "ar" ? "ar-u-nu-latn" : "en";

/** Format a UTC instant as a date in the clinic timezone. */
export function formatZonedDate(
  date: Date,
  locale: "ar" | "en" = "ar",
  timeZone = APP_TIMEZONE
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

/** Format a UTC instant as a date + time in the clinic timezone. */
export function formatZonedDateTime(
  date: Date,
  locale: "ar" | "en" = "ar",
  timeZone = APP_TIMEZONE
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
