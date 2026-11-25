export const ORTHO_RETURN_REVIEW_MESSAGE = "تعذّر تأكيد الطبيب المسؤول الحالي. راجع الاقتراح أو إعدادات الحالة قبل الحجز.";
export const ORTHO_RETURN_REVIEW_CODE = "ortho_return_review_required";

export type OrthoReturnBooking = { caseId: number; adjustmentId: number; fingerprint: string };
export function readOrthoReturnBooking(value: unknown): OrthoReturnBooking | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { caseId, adjustmentId, fingerprint } = value as Record<string, unknown>;
  if (typeof caseId !== "number" || !Number.isSafeInteger(caseId) || caseId <= 0
    || typeof adjustmentId !== "number" || !Number.isSafeInteger(adjustmentId) || adjustmentId <= 0
    || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) return null;
  return { caseId, adjustmentId, fingerprint };
}
