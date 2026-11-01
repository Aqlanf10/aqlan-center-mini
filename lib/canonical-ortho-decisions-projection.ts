export interface CanonicalOrthoPendingDecision { adjustmentId: number; patientId: number; patientName: string; doneOn: string; doctorName: string | null; legacy: boolean; decisionContext: { expectedVersion: string; choices: ("billed" | "no_charge")[] } | null }
export interface CanonicalOrthoDecisions { projection: "ortho-pending-decisions"; pending: CanonicalOrthoPendingDecision[]; hasMore: boolean; limit: 300 }
export function isCanonicalOrthoDecisions(value: unknown): value is CanonicalOrthoDecisions {
  if (!value || typeof value !== "object") return false;
  const v = value as CanonicalOrthoDecisions;
  return v.projection === "ortho-pending-decisions" && v.limit === 300 && typeof v.hasMore === "boolean" && Array.isArray(v.pending) && v.pending.length <= 300
    && v.pending.every(row => !!row && Number.isSafeInteger(row.adjustmentId) && row.adjustmentId > 0 && Number.isSafeInteger(row.patientId) && row.patientId > 0
      && typeof row.patientName === "string" && typeof row.doneOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.doneOn)
      && (row.doctorName === null || typeof row.doctorName === "string") && typeof row.legacy === "boolean"
      && (row.decisionContext === null || !!row.decisionContext && typeof row.decisionContext.expectedVersion === "string" && /^[a-f0-9]{64}$/.test(row.decisionContext.expectedVersion)
        && Array.isArray(row.decisionContext.choices) && row.decisionContext.choices.length >= 1 && row.decisionContext.choices.length <= 2
        && new Set(row.decisionContext.choices).size === row.decisionContext.choices.length && row.decisionContext.choices.every(choice => choice === "billed" || choice === "no_charge")));
}
