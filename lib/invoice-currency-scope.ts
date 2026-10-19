/** Admin correction diagnostics only: no patient data or eligibility overrides. */
export const INVOICE_CURRENCY_SCOPE_MESSAGES = {
  PLAN_LINKED_LINEAGE: "الفاتورة أو إحدى نسخها مرتبطة بخطة على مستوى الفاتورة؛ تصحيح عملة هذا الارتباط غير مدعوم حاليًا.",
  INDEPENDENT_ITEM_SOURCE: "لبند في الفاتورة مصدر مستقل غير بند خطة؛ تصحيح عملة هذا المصدر غير مدعوم حاليًا.",
  ALREADY_RECLASSIFIED: "سبق تسجيل إعادة تصنيف لتسوية هذه الفاتورة أو إحدى نسخها؛ لا يدعم هذا المسار إعادة تصنيف أخرى.",
} as const;
export type InvoiceCurrencyScopeReason = keyof typeof INVOICE_CURRENCY_SCOPE_MESSAGES;
export interface InvoiceCurrencyScopeFacts {
  plan_linked_lineage: boolean;
  independent_item_source: boolean;
  already_reclassified: boolean;
}
export function invoiceCurrencyScopeReasons(facts: InvoiceCurrencyScopeFacts): InvoiceCurrencyScopeReason[] {
  const reasons: InvoiceCurrencyScopeReason[] = [];
  if (facts.plan_linked_lineage) reasons.push("PLAN_LINKED_LINEAGE");
  if (facts.independent_item_source) reasons.push("INDEPENDENT_ITEM_SOURCE");
  if (facts.already_reclassified) reasons.push("ALREADY_RECLASSIFIED");
  return reasons;
}
export function isInvoiceCurrencyScopeReason(value: unknown): value is InvoiceCurrencyScopeReason {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(INVOICE_CURRENCY_SCOPE_MESSAGES, value);
}
export function invoiceCurrencyScopeMessage(reasons: readonly InvoiceCurrencyScopeReason[]): string {
  return reasons.map(reason => INVOICE_CURRENCY_SCOPE_MESSAGES[reason]).join(" ");
}
