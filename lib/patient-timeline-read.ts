import {
  patientAppointmentVisibility,
  type AppointmentReadScope,
  type PatientAppointmentVisibility,
} from "./appointment-read-scope";
import { TIMELINE_KIND_LABEL, type TimelineEvent, type TimelineGroup, type TimelineKind } from "./workflow";

/** Read inputs only, resolved by existing domain guards after patient admission. */
export interface PatientTimelineReadScope {
  plans: boolean;
  documents: boolean;
  financial: boolean;
  appointments: AppointmentReadScope;
}

/** No hidden counts or inference about whether inaccessible records exist. */
export interface PatientTimelineSources {
  plans: boolean;
  documents: boolean;
  financial: boolean;
  appointments: PatientAppointmentVisibility;
}
export interface PatientTimelinePayload {
  patientId: number;
  events: TimelineEvent[];
  sources: PatientTimelineSources;
  /** Existing wire flag retained; it is never a doctor-finance grant. */
  canSeeFinancial: boolean;
}

export function patientTimelineSources(scope: PatientTimelineReadScope, patientId: number): PatientTimelineSources {
  return { plans: scope.plans, documents: scope.documents, financial: scope.financial,
    appointments: patientAppointmentVisibility(scope.appointments, patientId) };
}

export function timelineKindReadable(kind: TimelineKind, sources: PatientTimelineSources): boolean {
  switch (kind) {
    case "plan": return sources.plans;
    case "document": return sources.documents;
    case "invoice": case "payment": return sources.financial;
    case "appointment": return sources.appointments === "all" || sources.appointments === "scoped";
    // Referral progression is clinical. A "scheduled" audit event does not
    // contain an actual appointment identity or scheduled slot.
    case "visit": case "ortho": case "diagnosis": case "referral": case "lab": return true;
  }
}

export function timelineGroups(sources: PatientTimelineSources): TimelineGroup[] {
  return ["all", "clinical", ...(sources.financial ? ["financial" as const] : []), "lab",
    ...(sources.documents ? ["files" as const] : [])];
}

/** Only exact current-patient/source destinations are links; never trust arbitrary payload URLs. */
export function timelineSourceHref(event: TimelineEvent, patientId: number, sources: PatientTimelineSources): string | null {
  if (!timelineKindReadable(event.kind, sources) || !event.href) return null;
  const patient = `/patients/${patientId}`;
  const id = event.key.split(":")[1];
  const expected = event.kind === "visit" ? `/visits/${id}/clinical`
    : event.kind === "invoice" || event.kind === "payment" ? `${patient}?tab=account`
    : event.kind === "document" ? `${patient}?tab=files`
    : event.kind === "appointment" ? `${patient}?tab=summary`
    : event.kind === "lab" ? "/lab" : `${patient}?tab=treatment`;
  // Legacy clinical events link to the treatment overview (chart); this view is
  // clinical, not the separately gated plans subtab. Preserve that destination.
  return event.href === expected ? expected : null;
}

/** Defense in depth; DB source selection already occurs before every relevant cap. */
export function projectPatientTimeline(events: TimelineEvent[], patientId: number, sources: PatientTimelineSources): TimelineEvent[] {
  return events.filter((event) => timelineKindReadable(event.kind, sources))
    .map((event) => ({ ...event, href: timelineSourceHref(event, patientId, sources) }));
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nullableText = (value: unknown) => value === null || typeof value === "string";

/** Missing/legacy or malformed source assertions are unavailable, never a complete empty history. */
export function readPatientTimeline(value: unknown, patientId: number): PatientTimelinePayload | null {
  if (!record(value) || value.patientId !== patientId || !record(value.sources) || !Array.isArray(value.events)) return null;
  const source = value.sources;
  if (typeof source.plans !== "boolean" || typeof source.documents !== "boolean" || typeof source.financial !== "boolean"
    || (source.appointments !== "all" && source.appointments !== "scoped" && source.appointments !== "hidden")
    || value.canSeeFinancial !== source.financial || value.events.length > 200) return null;
  const sources: PatientTimelineSources = { plans: source.plans, documents: source.documents, financial: source.financial,
    appointments: source.appointments as PatientAppointmentVisibility };
  const events: TimelineEvent[] = [];
  const keys = new Set<string>();
  for (const row of value.events) {
    if (!record(row) || typeof row.kind !== "string" || !Object.hasOwn(TIMELINE_KIND_LABEL, row.kind)) return null;
    const kind = row.kind as TimelineKind;
    if (typeof row.key !== "string" || !new RegExp(`^${kind}:[1-9][0-9]*$`).test(row.key) || keys.has(row.key)
      || typeof row.at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(row.at) || !Number.isFinite(Date.parse(row.at))
      || typeof row.title !== "string" || !nullableText(row.detail) || !nullableText(row.href)
      || (row.amountMinor !== null && (typeof row.amountMinor !== "number" || !Number.isFinite(row.amountMinor)))
      || (row.doctorName !== undefined && !nullableText(row.doctorName))
      || (row.caseTitle !== undefined && !nullableText(row.caseTitle))
      || (row.specialties !== undefined && (!Array.isArray(row.specialties) || !row.specialties.every((one) => typeof one === "string")))) return null;
    // Contradictory source data invalidates the entire read; silently dropping it
    // could turn a malformed, capped response into an authoritative empty list.
    if (!timelineKindReadable(kind, sources)) return null;
    if (kind !== "invoice" && kind !== "payment" && row.amountMinor !== null) return null;
    keys.add(row.key);
    const event: TimelineEvent = {
      key: row.key, kind, at: row.at, title: row.title, detail: row.detail as string | null,
      amountMinor: row.amountMinor as number | null,
      // Preserve the saved/unknown currency behavior: malformed units never fall
      // back to the clinic base or silently change the monetary amount.
      currency: typeof row.currency === "string" ? row.currency : null,
      href: row.href as string | null,
      ...(row.doctorName !== undefined ? { doctorName: row.doctorName as string | null } : {}),
      ...(row.caseTitle !== undefined ? { caseTitle: row.caseTitle as string | null } : {}),
      ...(row.specialties !== undefined ? { specialties: row.specialties as string[] } : {}),
    };
    events.push({ ...event, href: timelineSourceHref(event, patientId, sources) });
  }
  return { patientId, sources, events, canSeeFinancial: sources.financial };
}
