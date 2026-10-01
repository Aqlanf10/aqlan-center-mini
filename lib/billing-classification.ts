import type { LegacyFinancialMode } from "./ortho-baseline";

/** The server's billing decision for one clinical work source. */
export type BillingClassification =
  | "INCLUDED"
  | "LEGACY_INCLUDED"
  | "NEW_BILLABLE"
  | "OUTSIDE_CONTRACT"
  | "NO_CHARGE";

/** BILL-1: the agreement invoices installments, so its linked sessions are included. */
export function classifyPlanSession(fundedByAgreement: boolean): BillingClassification {
  return fundedByAgreement ? "INCLUDED" : "NEW_BILLABLE";
}

/**
 * An orthodontic adjustment is a clinical record, not an invoice item. The
 * opening balance must exist in one unambiguous currency before we can say a
 * pre-system adjustment is covered by it. A paid-in-advance legacy case needs
 * no opening receivable. Other modes need an explicit billing decision; this
 * function must never infer a new invoice from the adjustment alone.
 */
export function classifyOrthoAdjustment(input: {
  legacy: boolean;
  financialMode: LegacyFinancialMode | null;
  openingCurrencies: readonly string[];
  fundedPlan: boolean;
}): BillingClassification {
  if (!input.legacy) return "OUTSIDE_CONTRACT";
  if (input.financialMode === "prepaid_included") return "LEGACY_INCLUDED";
  if (input.financialMode === "opening_balance") {
    return input.openingCurrencies.length === 1 ? "LEGACY_INCLUDED" : "OUTSIDE_CONTRACT";
  }
  if (input.financialMode === "installments" && input.fundedPlan) return "INCLUDED";
  return "OUTSIDE_CONTRACT";
}

/**
 * (P6) لماذا لا مستحق اليوم؟ مشتقٌّ من قرارات الفوترة نفسها — لا من زرٍّ يصفّر المبلغ.
 * يُستدعى فقط حين يكون المستحق صفرًا بحسب القواعد.
 */
export function zeroDueReason(
  lines: readonly { classification: BillingClassification; amountMinor: number; planLinked: boolean }[],
  orthoAdjustment: BillingClassification | null,
): string {
  if (lines.length === 0) {
    if (orthoAdjustment === "LEGACY_INCLUDED") return "شدّة تقويم مشمولة بالعلاج السابق";
    if (orthoAdjustment === "INCLUDED") return "شدّة تقويم مشمولة ضمن اتفاق الأقساط";
    return "زيارة توثيق بلا إجراء مفوتر";
  }
  if (lines.every((line) => line.classification === "INCLUDED")) return "مشمولة ضمن اتفاق الأقساط";
  const billable = lines.filter((line) => line.classification === "NEW_BILLABLE");
  if (lines.some((line) => line.classification === "INCLUDED")) {
    return billable.length === 0 ? "مشمولة ضمن اتفاق الأقساط" : "جلساتٌ مشمولة ضمن اتفاق الأقساط، والباقي بلا قيمة مستحقة";
  }
  if (billable.length > 0 && billable.every((line) => line.planLinked)) {
    return "الجلسة الحالية غير مستحقة حسب قاعدة فوترة الخطة";
  }
  return "إجراء بقيمة صفر مقررة من الدليل أو الخطة";
}

/** (P1-C) قرار شدّة التقويم خارج العقد. الفارغ = قرارٌ معلّق. */
export type OutsideContractDecision = "billed" | "no_charge";

export function isOutsideContractDecision(value: unknown): value is OutsideContractDecision {
  return value === "billed" || value === "no_charge";
}

/**
 * (P1-C) التصنيف الفعلي للشدّة بعد القرار: خارج العقد + فوتِرت ⇒ مستحق جديد؛ + بلا رسوم ⇒ بلا رسوم؛
 * وبلا قرار يبقى «خارج العقد» (معلّق). المشمولة لا يغيّرها قرار.
 */
export function effectiveAdjustmentClass(
  snapshot: BillingClassification,
  decision: OutsideContractDecision | null,
): BillingClassification {
  if (snapshot !== "OUTSIDE_CONTRACT" || decision === null) return snapshot;
  return decision === "billed" ? "NEW_BILLABLE" : "NO_CHARGE";
}
