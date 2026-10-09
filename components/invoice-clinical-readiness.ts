/** Clinical read evidence only: these checks block signing, never saving a factual draft. */
export interface PlannedClinicalEvidence {
  planItemId: number; origin?: string; billingStatus?: string;
  financialReviewRequired?: boolean; clinicalConsentRecorded?: boolean;
  prebilled?: boolean; includedByAgreement?: boolean;
}
export interface SignatureEvidence {
  procedures: { id?: number; planItemId: number | null }[];
  outstanding: PlannedClinicalEvidence[];
  sessionPricing: { procedureId?: number; planItemId?: number; financialReviewRequired?: boolean; clinicalConsentRecorded?: boolean }[];
}

/** Warnings constrain signature/financial activation, never truthful draft documentation. */
export function plannedItemBlock(item: PlannedClinicalEvidence): string | null {
  if (item.financialReviewRequired || item.billingStatus === "needs_financial_review") {
    return "يمكن توثيق العمل كمسودة؛ يحتاج مراجعة مالية قبل التوقيع، ولا تُنشأ فاتورة ثانية لهذا البند.";
  }
  if (item.origin === "invoice" && typeof item.financialReviewRequired !== "boolean") {
    return "يمكن حفظ المسودة؛ تعذّر التحقق من حالة البند المالية. أعد تحميل الزيارة قبل التوقيع.";
  }
  if (item.origin === "invoice" && item.clinicalConsentRecorded !== true) {
    return "يمكن توثيق العمل كمسودة؛ يلزم توثيق الموافقة السريرية قبل التوقيع. الفاتورة ليست موافقة علاجية.";
  }
  return null;
}
export function visitSignatureBlock(visit: SignatureEvidence | null): string | null {
  if (!visit) return null;
  for (const procedure of visit.procedures.filter((line) => line.planItemId !== null)) {
    const matches = visit.sessionPricing.filter((line) => line.procedureId === procedure.id && line.planItemId === procedure.planItemId);
    const line = matches[0];
    if (!Number.isSafeInteger(procedure.id) || matches.length !== 1
      || typeof line.financialReviewRequired !== "boolean" || typeof line.clinicalConsentRecorded !== "boolean") {
      return "يمكن حفظ التوثيق كمسودة؛ بيانات التحقق من بنود الخطة غير مكتملة. أعد تحميل الزيارة قبل التوقيع.";
    }
    if (line.financialReviewRequired) return "يمكن حفظ التوثيق كمسودة؛ نسبة العمل أو تغطيته المالية تحتاج مراجعة قبل التوقيع.";
    if (!line.clinicalConsentRecorded) return "يمكن حفظ التوثيق كمسودة؛ يلزم توثيق الموافقة السريرية لبنود الخطة قبل التوقيع.";
  }
  const linked = new Set(visit.procedures.map((line) => line.planItemId));
  for (const item of visit.outstanding) {
    if (linked.has(item.planItemId)) {
      const reason = plannedItemBlock(item);
      if (reason) return reason;
    }
  }
  return null;
}


export function hasUnresolvedClinicalFinance(item: PlannedClinicalEvidence): boolean {
  return item.financialReviewRequired === true || item.billingStatus === "needs_financial_review"
    || (item.origin === "invoice" && typeof item.financialReviewRequired !== "boolean");
}
export function hasVerifiedClinicalCoverage(item: PlannedClinicalEvidence): boolean {
  return !hasUnresolvedClinicalFinance(item) && (item.prebilled === true || item.includedByAgreement === true);
}
