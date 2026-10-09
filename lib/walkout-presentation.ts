import type { VisitWalkout, WalkoutLine } from "./db";
import type { BillingClassification } from "./billing-classification";

/** Presentation only: all clinical work and coverage come from visitWalkout. */
export const WALKOUT_CLASS_LABEL: Record<BillingClassification, { text: string; tone: string }> = {
  NEW_BILLABLE: { text: "مستحق جديد", tone: "bg-amber-100 text-amber-900" },
  INCLUDED: { text: "مشمول بالاتفاق", tone: "bg-sky-100 text-sky-900" },
  LEGACY_INCLUDED: { text: "مشمول بالعلاج السابق", tone: "bg-violet-100 text-violet-900" },
  OUTSIDE_CONTRACT: { text: "خارج العقد — قرار فوترة", tone: "bg-rose-100 text-rose-900" },
  NO_CHARGE: { text: "بلا رسوم", tone: "bg-slate-100 text-slate-700" },
};
export const PREVIOUS_BALANCE_LABEL = "الرصيد السابق (باستثناء فاتورة الزيارة ودفعات يومها)";
export const PREVIOUS_BALANCE_NOTE = "رصيد مرجعي من الدفتر باستثناء فاتورة هذه الزيارة وجميع دفعات يوم وصولها؛ ليس لقطة لحظة التوقيع. الرصيد الحالي هو دين الحساب القائم، ومتـبقي الاتفاق مستقل عنه.";
export function walkoutNeedsReview(value: Pick<VisitWalkout, "lines" | "orthoAdjustment">): boolean {
  return value.lines.some((line) => line.financialReviewRequired || line.billingClass === "OUTSIDE_CONTRACT")
    || value.orthoAdjustment?.pendingDecision === true
    || value.orthoAdjustment?.billingClass === "OUTSIDE_CONTRACT";
}
export function adjustmentLabel(value: NonNullable<VisitWalkout["orthoAdjustment"]>): string {
  if (value.pendingDecision || value.billingClass === "OUTSIDE_CONTRACT") return "خارج العقد — قرار فوترة معلّق";
  if (value.billingClass === "NEW_BILLABLE") return "فوتِرت بسطر «شدّة تقويم»";
  return `${WALKOUT_CLASS_LABEL[value.billingClass].text} · بلا رسوم جديدة`;
}
export function lineNeedsReview(line: WalkoutLine): boolean {
  return line.financialReviewRequired === true || line.billingClass === "OUTSIDE_CONTRACT";
}
