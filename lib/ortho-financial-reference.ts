/** Money-free clinical projection. A source reference never grants adjustment coverage. */
export interface OrthoFinancialSource {
  kind: "invoice" | "historical_agreement";
  sourceId: number;
  planId: number;
  planItemId: number;
  clinicalCaseId: number;
  current: boolean;
}

export interface OrthoFinancialReference {
  state: "linked" | "review" | "missing" | "restricted";
  clinicalCaseIds: number[];
  sources: OrthoFinancialSource[];
  /** Recorded collection terms only, never principal or clinical eligibility. */
  hasRecordedSchedule: boolean;
}

const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** Allowlist the clinical response, including nested fields; never retain monetary payloads. */
export function readOrthoFinancialReference(raw: unknown): OrthoFinancialReference {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid financial reference");
  const row = raw as Record<string, unknown>;
  if (typeof row.state !== "string" || !["linked", "review", "missing", "restricted"].includes(row.state) || !Array.isArray(row.clinicalCaseIds)
    || row.clinicalCaseIds.some((value) => !id(value)) || new Set(row.clinicalCaseIds).size !== row.clinicalCaseIds.length
    || !Array.isArray(row.sources) || typeof row.hasRecordedSchedule !== "boolean") throw new Error("Invalid financial reference");
  const clinicalCaseIds = row.clinicalCaseIds as number[];
  const keys = new Set<string>();
  const sources = row.sources.map((value): OrthoFinancialSource => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid financial source");
    const source = value as Record<string, unknown>;
    if (source.kind !== "invoice" && source.kind !== "historical_agreement" || !id(source.sourceId)
      || !id(source.planId) || !id(source.planItemId) || !id(source.clinicalCaseId)
      || !clinicalCaseIds.includes(source.clinicalCaseId) || typeof source.current !== "boolean") throw new Error("Invalid financial source");
    const key = `${source.kind}:${source.sourceId}:${source.planItemId}`;
    if (keys.has(key)) throw new Error("Duplicate financial source");
    keys.add(key);
    return { kind: source.kind, sourceId: source.sourceId, planId: source.planId,
      planItemId: source.planItemId, clinicalCaseId: source.clinicalCaseId, current: source.current };
  });
  if (row.state === "linked" && !sources.some((source) => source.current)
    || row.state === "missing" && (sources.length > 0 || row.hasRecordedSchedule)
    || row.state === "restricted" && (sources.length > 0 || clinicalCaseIds.length > 0 || row.hasRecordedSchedule)) throw new Error("Inconsistent financial reference");
  return { state: row.state as OrthoFinancialReference["state"], clinicalCaseIds: [...clinicalCaseIds],
    sources, hasRecordedSchedule: row.hasRecordedSchedule };
}

export const missingOrthoFinancialReference = (): OrthoFinancialReference => ({
  state: "missing", clinicalCaseIds: [], sources: [], hasRecordedSchedule: false,
});
