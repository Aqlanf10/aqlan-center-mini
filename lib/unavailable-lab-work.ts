/** Compatibility barrier for writers without the persisted lab work graph. */
function hasWork(rows: unknown): boolean {
  return Array.isArray(rows) && rows.some(row => row && typeof row === "object" && row.labWork != null);
}

export function requestsInvoiceLabWork(source: Record<string, unknown>): boolean {
  const selection = source.templateSelection;
  return source.labIntent != null || source.labRetirements != null || hasWork(source.items)
    || (selection != null && typeof selection === "object" && "sites" in selection && hasWork(selection.sites));
}

export function requestsVisitLabWork(source: Record<string, unknown>): boolean {
  return source.action === "prepare_lab_dispatch" || source.labRequestKey != null || source.labRetirements != null
    || source.labReviewVersion != null || source.labSignVersion != null || hasWork(source.procedures);
}

export const unavailableLabWork = {
  code: "lab_work_unavailable",
  message: "تعذّر حفظ عمل المختبر المرتبط في هذه النسخة. تحقّق من إيصال أي محاولة سابقة قبل المتابعة.",
};
