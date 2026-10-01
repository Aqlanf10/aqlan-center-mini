import { daysBetween } from "./ortho";

/**
 * (P1-E) مسار استشارة المريض الجديد — متابعة عروض العلاج.
 *
 * المريض الجديد يأتي للكشف، فيُعدّ له الطبيب خطة (عرض علاج) بأسعارها، ثم يقول «أفكّر وأردّ».
 * بلا قائمةٍ تذكّر به يضيع العرض: لا موافقة ولا رفض ولا اتصال. هنا تصنيفٌ خالص لكل عرضٍ
 * لم يوافَق عليه بعد: جديد، أو حان الاتصال، أو تواصلنا مؤخرًا، أو قديم — بمدّةٍ من الإعدادات.
 * لا يغيّر خطةً ولا مبلغًا: الموافقة والإلغاء بمسارَيهما القائمين في ملف المريض.
 */
export type ProposalStage = "due" | "stale" | "contacted" | "fresh";

export const PROPOSAL_STAGE_LABEL: Record<ProposalStage, string> = {
  due: "حان الاتصال",
  stale: "عرضٌ قديم",
  contacted: "تواصلنا مؤخرًا",
  fresh: "جديد",
};

export interface ProposalTiming {
  stage: ProposalStage;
  ageDays: number;
  daysSinceContact: number | null;
}

export function proposalTiming(input: {
  createdOn: string;
  lastContactOn: string | null;
  today: string;
  followUpDays: number;
}): ProposalTiming {
  const every = Math.max(1, Math.round(input.followUpDays));
  const ageDays = Math.max(0, daysBetween(input.createdOn, input.today));
  const daysSinceContact = input.lastContactOn ? Math.max(0, daysBetween(input.lastContactOn, input.today)) : null;
  let stage: ProposalStage;
  if (daysSinceContact !== null && daysSinceContact < every) stage = "contacted";
  else if (ageDays >= every * 4) stage = "stale";
  else if (ageDays >= every) stage = "due";
  else stage = "fresh";
  return { stage, ageDays, daysSinceContact };
}

const STAGE_ORDER: Record<ProposalStage, number> = { due: 0, stale: 1, contacted: 2, fresh: 3 };

/** الأَولى بالاتصال أولًا: حان الاتصال، ثم القديم، ثم من تواصلنا معه، ثم الجديد — والأقدم داخل كلٍّ أولًا. */
export function sortProposals<T extends { timing: ProposalTiming }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    STAGE_ORDER[a.timing.stage] - STAGE_ORDER[b.timing.stage] || b.timing.ageDays - a.timing.ageDays);
}

export function followUpDaysFrom(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 90 ? value : 7;
}
