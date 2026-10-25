import type { Currency } from "./money";

export type AgreementAmendmentPreview = {
  planId: number; patientId: number; currency: Currency; itemId: number; caseId: number | null; quantity: number;
  oldServiceId: number; oldUnitMinor: number; previousAgreementMinor: number;
  recordedPaymentsMinor: number; recordedRefundsMinor: number; sourceHash: string;
  services: { id: number; name: string; category: string | null }[];
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number => amount(value) && value > 0;

// Validate every field consumed by the preview renderer/quote before keeping it
// in client state. A successful HTTP status is not evidence of a usable preview.
export function isAgreementAmendmentPreview(value: unknown, planId: number): value is AgreementAmendmentPreview {
  return record(value) && positive(value.planId) && value.planId === planId
    && positive(value.patientId) && positive(value.itemId) && positive(value.oldServiceId)
    && (value.caseId === null || positive(value.caseId)) && positive(value.quantity)
    && (value.currency === "YER" || value.currency === "SAR" || value.currency === "USD")
    && amount(value.oldUnitMinor) && amount(value.previousAgreementMinor)
    && amount(value.recordedPaymentsMinor) && amount(value.recordedRefundsMinor)
    && value.recordedRefundsMinor <= value.recordedPaymentsMinor
    && typeof value.sourceHash === "string" && value.sourceHash.trim().length > 0
    && Array.isArray(value.services) && value.services.every((service: unknown) =>
      record(service) && positive(service.id) && typeof service.name === "string"
      && (service.category === null || typeof service.category === "string"));
}
