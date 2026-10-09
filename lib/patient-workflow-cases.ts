/** Display-only workflow projections. Keep this module independent of the database. */
export interface AssessmentCase {
  id: number;
  patientId: number;
  kind: "specialty";
  orthoCaseId: null;
  specialty: string;
  title: string;
  needsAssessment: true;
}

interface LegacyCaseFields {
  patientId: number;
  specialty: string;
  title: string;
  site: string | null;
  status: "active" | "waiting";
  legacy: true;
}

export type LegacyCase = LegacyCaseFields & (
  | { kind: "specialty"; id: number; orthoCaseId: number | null }
  | { kind: "ortho"; id: null; orthoCaseId: number; specialty: "orthodontics" }
);

export interface WorkflowCases {
  assessmentCases: AssessmentCase[];
  legacyCases: LegacyCase[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nonblankText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Specialty IDs and unbridged orthodontic IDs occupy separate identity namespaces. */
export function legacyCaseKey(row: LegacyCase): string {
  return row.kind === "specialty" ? `case-${row.id}` : `ortho-${row.orthoCaseId}`;
}

function readAssessmentCases(rows: unknown[], patientId: number): AssessmentCase[] | null {
  const result: AssessmentCase[] = [];
  const ids = new Set<number>();
  for (const row of rows) {
    if (!record(row) || !positiveId(row.id) || ids.has(row.id)
      || row.patientId !== patientId || row.kind !== "specialty" || row.orthoCaseId !== null
      || !nonblankText(row.specialty) || !nonblankText(row.title) || row.needsAssessment !== true
      || (row.legacy !== undefined && row.legacy !== false)) return null;
    ids.add(row.id);
    result.push({
      id: row.id, patientId, kind: "specialty", orthoCaseId: null,
      specialty: row.specialty, title: row.title, needsAssessment: true,
    });
  }
  return result;
}

function readLegacyCases(rows: unknown[], patientId: number): LegacyCase[] | null {
  const result: LegacyCase[] = [];
  const keys = new Set<string>();
  for (const row of rows) {
    if (!record(row) || row.patientId !== patientId || !nonblankText(row.specialty)
      || !nonblankText(row.title) || (row.site !== null && typeof row.site !== "string")
      || (row.status !== "active" && row.status !== "waiting") || row.legacy !== true) return null;

    const fields: LegacyCaseFields = {
      patientId, specialty: row.specialty, title: row.title, site: row.site,
      status: row.status, legacy: true,
    };
    let parsed: LegacyCase;
    if (row.kind === "specialty" && positiveId(row.id)
      && (row.orthoCaseId === null || positiveId(row.orthoCaseId))) {
      parsed = { ...fields, kind: "specialty", id: row.id, orthoCaseId: row.orthoCaseId };
    } else if (row.kind === "ortho" && row.id === null && positiveId(row.orthoCaseId)
      && row.specialty === "orthodontics") {
      parsed = { ...fields, kind: "ortho", id: null, orthoCaseId: row.orthoCaseId, specialty: "orthodontics" };
    } else {
      return null;
    }

    const key = legacyCaseKey(parsed);
    if (keys.has(key)) return null;
    keys.add(key);
    result.push(parsed);
  }
  return result;
}

/**
 * Validate the owning workflow response before exposing any banner projection.
 * Missing arrays are invalid, not an empty success. The legacy release explicitly
 * opts in so the assessment-only release does not depend on a future wire field.
 */
export function readWorkflowCases(value: unknown, patientId: number, includeLegacy = false): WorkflowCases | null {
  if (!positiveId(patientId) || !record(value) || !record(value.patient)
    || !positiveId(value.patient.id) || value.patient.id !== patientId
    || !Array.isArray(value.assessmentCases)) return null;
  if (includeLegacy && !Array.isArray(value.legacyCases)) return null;

  const assessmentCases = readAssessmentCases(value.assessmentCases, patientId);
  if (assessmentCases === null) return null;
  const legacyCases = includeLegacy ? readLegacyCases(value.legacyCases as unknown[], patientId) : [];
  if (legacyCases === null) return null;
  return { assessmentCases, legacyCases };
}
