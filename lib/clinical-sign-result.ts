import { isCurrency } from "./money";

/** Validate the sign endpoint's checkout DTO before publishing a success receipt.
 * The request already owns visitId; any echoed identity must agree with it.
 */
export function isClinicalSignResult(value: unknown, visitId: number, patientId?: number | null): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const id = (one: unknown) => Number.isSafeInteger(one) && Number(one) > 0;
  const count = (one: unknown) => Number.isSafeInteger(one) && Number(one) >= 0;
  if ((row.id !== undefined && row.id !== visitId)
    || (row.status !== undefined && row.status !== "signed")
    || !(row.patientId === null || id(row.patientId))
    || (patientId != null && row.patientId !== patientId)
    || !(row.invoiceId === null || id(row.invoiceId))
    || !(row.invoiceCurrency === null || isCurrency(row.invoiceCurrency))
    || (row.invoiceId !== null && row.invoiceCurrency === null)
    || !count(row.duesMinor) || !count(row.sessionsCompleted)
    || (row.labOrdersCreated !== undefined && !count(row.labOrdersCreated))
    || (row.materialsDeducted !== undefined && !count(row.materialsDeducted))) return false;
  if (row.nextPlannedVisit === null) return true;
  if (!row.nextPlannedVisit || typeof row.nextPlannedVisit !== "object" || Array.isArray(row.nextPlannedVisit)) return false;
  const next = row.nextPlannedVisit as Record<string, unknown>;
  return id(next.id) && typeof next.title === "string" && count(next.sequence)
    && count(next.durationMinutes)
    && (next.suggestedDate === undefined || next.suggestedDate === null || typeof next.suggestedDate === "string")
    && (next.afterDays === undefined || next.afterDays === null || count(next.afterDays));
}
