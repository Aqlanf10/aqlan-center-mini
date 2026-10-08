import { resolveClinicZone } from "./clinicZone";
import { friendlyDateLong, friendlyTime } from "./reminders";
import { clinicDateString } from "./schedule";

/** Render the supplied stored instant in the clinic zone, never the host clock.
 * Uses the existing shift-print date/time format. Callers retain ownership of
 * whether the instant means creation, opening or closing; no current-time fallback.
 */
export function formatClinicTimestamp(iso: string, timeZone: string): string {
  const stamp = new Date(iso);
  if (!Number.isFinite(stamp.getTime())) return "—";
  const zone = resolveClinicZone(timeZone);
  const date = clinicDateString(stamp, zone);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(stamp);
  return `${friendlyDateLong(date)} · ${friendlyTime(time)}`;
}
