import { resolveClinicZone } from "./clinicZone";

const savedInstantKinds = new Set(["visit", "plan", "invoice", "payment", "lab", "document", "diagnosis", "referral"]);

/** Render saved instants in the clinic zone, without moving a scheduled civil date or changing the ortho display. */
export function patientTimelineDateTimeParts({ kind, at }: { kind: string; at: string }, clinicZone?: string) {
  const original = { date: at.slice(0, 10), time: at.slice(11, 16) };
  if (!savedInstantKinds.has(kind)) return original;
  // A wall-clock string has no defined source offset. Never parse it in the browser zone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(at)) return original;
  const instant = new Date(at);
  if (!Number.isFinite(instant.getTime())) return original;
  const fields = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveClinicZone(clinicZone), year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant).map(({ type, value }) => [type, value]));
  return { date: `${fields.year}-${fields.month}-${fields.day}`, time: `${fields.hour}:${fields.minute}` };
}
