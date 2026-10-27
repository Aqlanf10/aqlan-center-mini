/** No commission or payroll amount may assume a cost split across active invoices. */
export const COMMISSION_LAB_LINEAGE_REVIEW = {
  code: "commission_lab_lineage_review",
  message: "تعذّر احتساب العمولة: عمل مختبر واحد مرتبط بأكثر من فاتورة فعالة. راجع ربط العمل وتصحيح الفواتير قبل احتساب المستحقات أو اعتماد المسير؛ لم تُوزّع التكلفة تلقائيًا.",
} as const;

export class CommissionLabLineageError extends Error {
  readonly code = COMMISSION_LAB_LINEAGE_REVIEW.code;
  readonly status = 409;
  constructor(readonly labOrderId: number) {
    super(COMMISSION_LAB_LINEAGE_REVIEW.message);
    this.name = "CommissionLabLineageError";
  }
}
