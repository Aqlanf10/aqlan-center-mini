/** Submitted invoice intent is retained independently of changing catalogue evidence. */
export type InvoiceCommandOutcome = "saved" | "refused" | "busy" | "uncertain";
export type InvoiceCommandLease = { owner: object; serialized: string };
export function retainInvoiceCommand(owner: object, body: Record<string, unknown>): InvoiceCommandLease {
  return { owner, serialized: JSON.stringify(body) };
}
export function invoiceCommandForOwner(lease: InvoiceCommandLease, owner: object): Record<string, unknown> | null {
  return lease.owner === owner ? JSON.parse(lease.serialized) as Record<string, unknown> : null;
}
export function invoiceCommandHasTemplate(lease: InvoiceCommandLease): boolean {
  return Object.hasOwn(JSON.parse(lease.serialized) as Record<string, unknown>, "templateSelection");
}
export function invoiceCommandOutcome(status: number, payload: unknown, verifiedReceipt: boolean, redirected = false): InvoiceCommandOutcome {
  if (redirected) return "uncertain";
  if ((status === 200 || status === 201) && verifiedReceipt) return "saved";
  const error = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown> : null;
  const code = error?.code;
  if (status === 409 && code === "INVOICE_TEMPLATE_BUSY") return "busy";
  if (status === 400 && code === "INVOICE_TEMPLATE_INVALID"
    || status === 409 && (code === "INVOICE_TEMPLATE_REVIEW_REQUIRED" || code === "INVOICE_TEMPLATE_STALE")) return "refused";
  // The canonical endpoint returns an ordinary message only after pre-write validation or rollback.
  // Refusal describes this request, not the absence of an earlier same-key commit: retain its lease.
  if ((status === 400 || status === 409) && typeof error?.message === "string"
    && error.message.trim().length > 0 && error.message.length <= 1500) return "refused";
  return "uncertain";
}
