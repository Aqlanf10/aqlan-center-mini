/** Explicit read-only projection. Never contains the signed commercial source,
 * command receipt, financial totals, care details or an editing permission. */
export interface CanonicalOrthoCoverage {
  projection: "ortho-followup-coverage";
  patientId: number;
  orthoCaseId: number;
  enabled: boolean;
  current: null | { id: string; version: number; decision: "included" | "excluded"; reason: string; createdAt: string; createdBy: string };
  applicable: boolean;
  invoiceSources: { state: "restricted" } | { state: "allowed"; items: { invoiceId: number; invoiceNumber: string; serviceName: string }[] };
}
export function isCanonicalOrthoCoverage(value: unknown, patientId: number, caseId: number): value is CanonicalOrthoCoverage {
  if (!value || typeof value !== "object") return false;
  const v = value as CanonicalOrthoCoverage;
  if (v.projection !== "ortho-followup-coverage" || v.patientId !== patientId || v.orthoCaseId !== caseId
    || typeof v.enabled !== "boolean" || typeof v.applicable !== "boolean" || !v.invoiceSources) return false;
  if (v.current !== null && (!v.current || typeof v.current.id !== "string" || !/^[1-9]\d*$/.test(v.current.id)
    || !Number.isSafeInteger(v.current.version) || v.current.version < 1 || !["included", "excluded"].includes(v.current.decision)
    || typeof v.current.reason !== "string" || v.current.reason.length > 600 || typeof v.current.createdBy !== "string"
    || typeof v.current.createdAt !== "string" || !Number.isFinite(Date.parse(v.current.createdAt)))) return false;
  if ((!v.enabled && (v.current !== null || v.applicable)) || (!v.current && v.applicable)) return false;
  if (v.invoiceSources.state === "restricted") return Object.keys(v.invoiceSources).length === 1;
  return v.invoiceSources.state === "allowed" && Array.isArray(v.invoiceSources.items) && v.invoiceSources.items.length <= 256
    && v.invoiceSources.items.every(i => Number.isSafeInteger(i.invoiceId) && i.invoiceId > 0 && typeof i.invoiceNumber === "string" && typeof i.serviceName === "string");
}
