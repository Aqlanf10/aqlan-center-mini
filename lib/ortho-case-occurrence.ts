/** Explicit clinician documentary timing; never defaults to today or createdAt. */
export interface OccurrenceEvidence {
  occurredOn: string | null;
  dateProvenance: "contemporaneous_record" | "retrospective_record" | "historical_source" | "unknown";
  sourceNote: string;
}
export function readOccurrenceEvidence(raw: unknown): OccurrenceEvidence {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_occurrence");
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== 3 || !Object.hasOwn(r, "occurredOn") || !Object.hasOwn(r, "dateProvenance") || !Object.hasOwn(r, "sourceNote")
    || typeof r.dateProvenance !== "string" || !["contemporaneous_record", "retrospective_record", "historical_source", "unknown"].includes(r.dateProvenance)
    || typeof r.sourceNote !== "string" || r.sourceNote.length > 1000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(r.sourceNote)
    || (r.dateProvenance === "unknown") !== (r.occurredOn === null)) throw new Error("invalid_occurrence");
  if (r.occurredOn !== null) {
    if (typeof r.occurredOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.occurredOn)) throw new Error("invalid_occurrence_date");
    const d = new Date(`${r.occurredOn}T00:00:00.000Z`);
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== r.occurredOn) throw new Error("invalid_occurrence_date");
  }
  return { occurredOn: r.occurredOn as string | null, dateProvenance: r.dateProvenance as OccurrenceEvidence["dateProvenance"], sourceNote: r.sourceNote };
}
