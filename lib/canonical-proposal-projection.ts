import type { ProposalTiming } from "./consultation-followup";
import type { Currency } from "./money";
import { isCurrency } from "./money";
export interface CanonicalProposal {
  planId: number; patientId: number; patientName: string; patientPhone: string | null; title: string; doctorName: string | null;
  createdOn: string; lastContactOn: string | null; items: number; timing: ProposalTiming; contactVersion: string;
  money?: { totalMinor: number; currency: Currency };
}
export interface CanonicalProposalFeed {
  projection: "pending-plan-proposals"; proposals: CanonicalProposal[]; followUpDays: number; today: string; hasMore: boolean; limit: 300; canSeeMoney: boolean;
}
export function isCanonicalProposalFeed(value: unknown): value is CanonicalProposalFeed {
  if (!value || typeof value !== "object") return false;
  const v = value as CanonicalProposalFeed, day = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (v.projection !== "pending-plan-proposals" || !Array.isArray(v.proposals) || v.proposals.length > 300 || v.limit !== 300
    || typeof v.hasMore !== "boolean" || typeof v.canSeeMoney !== "boolean" || !day(v.today)
    || !Number.isInteger(v.followUpDays) || v.followUpDays < 1 || v.followUpDays > 90) return false;
  return v.proposals.every(r => Number.isSafeInteger(r.planId) && r.planId > 0 && Number.isSafeInteger(r.patientId) && r.patientId > 0
    && typeof r.patientName === "string" && typeof r.title === "string" && (r.patientPhone === null || typeof r.patientPhone === "string")
    && (r.doctorName === null || typeof r.doctorName === "string") && day(r.createdOn) && (r.lastContactOn === null || day(r.lastContactOn))
    && Number.isSafeInteger(r.items) && r.items >= 0 && typeof r.contactVersion === "string" && /^[a-f0-9]{64}$/.test(r.contactVersion)
    && !!r.timing && ["due", "stale", "contacted", "fresh"].includes(r.timing.stage) && Number.isSafeInteger(r.timing.ageDays) && r.timing.ageDays >= 0
    && (r.timing.daysSinceContact === null || Number.isSafeInteger(r.timing.daysSinceContact) && r.timing.daysSinceContact >= 0)
    && (v.canSeeMoney ? !!r.money && Number.isSafeInteger(r.money.totalMinor) && isCurrency(r.money.currency) : !("money" in r)));
}
