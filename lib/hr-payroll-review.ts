import { PAY_BLOCKER_LABEL, type PayBlocker } from "./hr-pay-terms";

/** Preserve API codes for support; never render unknown implementation text. */
export function payrollBlockerLabel(code: string): string {
  return Object.hasOwn(PAY_BLOCKER_LABEL, code)
    ? PAY_BLOCKER_LABEL[code as PayBlocker]
    : "تعذّر إثبات شروط الاستحقاق؛ يلزم مراجعة السجل والقرار المعتمد قبل إعادة الاحتساب";
}

export function payrollReviewContractIds(snapshot: Record<string, unknown>): number[] {
  const values = Array.isArray(snapshot.reviewContractIds) ? snapshot.reviewContractIds : [snapshot.contractId];
  return [...new Set(values.filter((value): value is number => Number.isSafeInteger(value) && Number(value) > 0))];
}
