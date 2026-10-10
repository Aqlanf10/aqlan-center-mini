/** Explicit visit selection is never silently replaced by workflow.lastVisit. */
export type CheckoutVisitRequest = number | "invalid" | null;

export function readCheckoutVisitRequest(value: unknown): CheckoutVisitRequest {
  if (value === undefined) return null;
  // A duplicate query arrives as an array from Next's page searchParams.
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return "invalid";
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : "invalid";
}
