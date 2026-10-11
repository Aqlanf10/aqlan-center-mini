/** Safety metadata for the existing suggestion path, not a clinical growth model. */
export const CEPH_SUGGESTION_ENGINE_VERSION = "ceph-draft-safety-v1" as const;

/** Only acquisition-date context is eligible. Birth-year-only ages are approximate.
 * A missing/invalid date is unknown, never today's age; no growth inference follows.
 */
export function cephAcquisitionAge(birthYear: number | null | undefined, acquiredOn: string | null | undefined): number | undefined {
  if (!Number.isInteger(birthYear) || birthYear == null || birthYear < 1
    || typeof acquiredOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(acquiredOn)) return undefined;
  const date = new Date(`${acquiredOn}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== acquiredOn) return undefined;
  const years = date.getUTCFullYear() - birthYear;
  return Number.isInteger(years) && years >= 0 && years <= 130 ? years : undefined;
}

export function finiteCephValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface CephSuggestionIdentity { analysisId: number; patientId: number; documentId: number }
export interface CephSuggestionProvenance extends CephSuggestionIdentity {
  state: "draft";
  source: "geometric-placement" | "local-measurement-summary" | "external-text-assistance";
  engineVersion: string;
  acquisitionAgeYears: number | null;
  agePrecision: "birth-year-approximate" | "unknown";
  growthAssessment: "not-assessed";
}

export function matchesCephSuggestionIdentity(raw: unknown, expected: CephSuggestionIdentity): raw is CephSuggestionProvenance {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  return value.state === "draft" && value.analysisId === expected.analysisId
    && value.patientId === expected.patientId && value.documentId === expected.documentId
    && ["geometric-placement", "local-measurement-summary", "external-text-assistance"].includes(String(value.source))
    && typeof value.engineVersion === "string" && value.engineVersion.length > 0 && value.engineVersion.length <= 100
    && value.growthAssessment === "not-assessed"
    && (value.acquisitionAgeYears === null ? value.agePrecision === "unknown"
      : typeof value.acquisitionAgeYears === "number" && Number.isInteger(value.acquisitionAgeYears)
        && value.acquisitionAgeYears >= 0 && value.acquisitionAgeYears <= 130 && value.agePrecision === "birth-year-approximate");
}

/** A request can update only the still-current mounted study generation. */
export function createCephSuggestionLifetime() {
  let generation = 0;
  let ownerKey: string | null = null;
  let mounted = true;
  let pending = false;
  return {
    setOwner(key: string) { if (key !== ownerKey) { ownerKey = key; generation++; pending = false; } },
    mount() { mounted = true; },
    unmount() { mounted = false; generation++; pending = false; },
    begin() {
      if (!mounted || pending) return null;
      pending = true;
      const claimed = generation;
      return {
        current: () => mounted && claimed === generation,
        finish() { if (mounted && claimed === generation) pending = false; },
      };
    },
    busy: () => pending,
    active: () => mounted,
  };
}
