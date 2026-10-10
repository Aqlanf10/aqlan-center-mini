/** Explicit form snapshot: service-only and billing-rule-only edits are real drafts. */
export interface PlanItemDraftSnapshot {
  serviceId: number | null;
  tooth: string; surfaces: string; targetVisitNumber: string; sessionCount: string;
  billingRule: string; doctorId: string; itemPrice: string; itemPriceReason: string;
}
export const INITIAL_PLAN_ITEM_DRAFT: PlanItemDraftSnapshot = {
  serviceId: null, tooth: "", surfaces: "", targetVisitNumber: "1", sessionCount: "1",
  billingRule: "on_completion", doctorId: "", itemPrice: "", itemPriceReason: "",
};
export function planItemDraftChanged(current: PlanItemDraftSnapshot, baseline: PlanItemDraftSnapshot): boolean {
  return (Object.keys(INITIAL_PLAN_ITEM_DRAFT) as (keyof PlanItemDraftSnapshot)[]).some((key) => current[key] !== baseline[key]);
}
