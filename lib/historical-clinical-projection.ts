import { planItemsProgress, type PlanItemLike } from "./plans";

/** Display-only facts. Historical money never establishes completed or remaining clinical work. */
export interface ClinicalProgressView {
  historicalItems: number;
  knownItems: number;
  knownDoneItems: number;
  knownDoneMinor: number;
  knownRemainingMinor: number;
}

export function historicalClinicalProgress(items: readonly (PlanItemLike & { legacyAgreementId?: number })[]): ClinicalProgressView {
  const historical = (item: { legacyAgreementId?: number }) => Number.isSafeInteger(item.legacyAgreementId) && (item.legacyAgreementId ?? 0) > 0;
  const known = planItemsProgress(items.filter((item) => !historical(item)));
  return {
    historicalItems: items.filter(historical).length,
    knownItems: known.count,
    knownDoneItems: known.doneCount,
    knownDoneMinor: known.doneMinor,
    knownRemainingMinor: known.remainingMinor,
  };
}

/** Call only within one currency bucket; no conversions and no debt arithmetic. */
export function combineClinicalProgress(views: readonly ClinicalProgressView[]): ClinicalProgressView {
  return views.reduce((sum, view) => ({
    historicalItems: sum.historicalItems + view.historicalItems,
    knownItems: sum.knownItems + view.knownItems,
    knownDoneItems: sum.knownDoneItems + view.knownDoneItems,
    knownDoneMinor: sum.knownDoneMinor + view.knownDoneMinor,
    knownRemainingMinor: sum.knownRemainingMinor + view.knownRemainingMinor,
  }), { historicalItems: 0, knownItems: 0, knownDoneItems: 0, knownDoneMinor: 0, knownRemainingMinor: 0 });
}
