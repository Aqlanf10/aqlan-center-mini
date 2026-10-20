/** Read-side integrity refusal. Never repair, omit or guess historical source facts. */
export type JournalReadIntegrityReason = "ambiguous_expense_category" | "unbalanced_journal";
export class JournalReadIntegrityError extends Error {
  readonly source: string;
  readonly reference: string;
  constructor(readonly reason: JournalReadIntegrityReason, source: string, reference: string) {
    super("Journal source requires review");
    this.name = "JournalReadIntegrityError";
    this.source = source.replace(/[^a-z_]/g, "").slice(0, 32);
    this.reference = reference.replace(/[^A-Za-z0-9._:#-]/g, "").slice(0, 80);
  }
}
/** Shared public refusal: no source identities, amounts, free text or internal diagnostics. */
export const JOURNAL_REVIEW_RESPONSE = Object.freeze({
  code: "journal_review_required",
  message: "تحتاج بعض مصادر الدفاتر إلى مراجعة محاسبية قبل عرض الأرصدة أو تصديرها. راجع الإدارة؛ لم تُعرض نتائج جزئية.",
});
