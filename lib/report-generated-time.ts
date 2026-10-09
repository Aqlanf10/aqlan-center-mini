import { formatClinicTimestamp } from "./clinic-clock";
import { isKnownZone } from "./clinicZone";

/** Display only: never rewrite the report's raw generation instant or dates.
 * Old responses may lack a zone. Label UTC explicitly rather than guessing the
 * clinic/browser zone or discarding otherwise valid financial report data.
 */
export function formatReportGeneratedAt(iso: string, clinicTimeZone?: unknown): string {
  // A timezone-less timestamp is not an absolute instant and would use the host.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(iso)) return "—";
  // Date can silently turn February 30 into March. Validate the written calendar
  // date independently of its offset before formatting the original instant.
  const calendarDate = /^((?:\d{4}|[+-]\d{6})-\d{2}-\d{2})T/i.exec(iso)?.[1];
  if (!calendarDate) return "—";
  const midnight = new Date(`${calendarDate}T00:00:00Z`);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().split("T")[0] !== calendarDate) return "—";
  const zone = typeof clinicTimeZone === "string" ? clinicTimeZone.trim() : "";
  const knownZone = zone !== "" && isKnownZone(zone);
  const text = formatClinicTimestamp(iso, knownZone ? zone : "UTC");
  return text === "—" || knownZone ? text : `${text} (UTC)`;
}
