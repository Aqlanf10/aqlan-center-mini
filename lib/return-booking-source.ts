export const RETURN_BOOKING_SOURCE_KINDS = ["clinical_case", "ortho_case", "ortho_adjustment", "visit", "planned_visit", "plan_item", "lab_work"] as const;
export interface ReturnBookingSource { kind: typeof RETURN_BOOKING_SOURCE_KINDS[number]; id: number }
export function parseReturnBookingSource(value: unknown): ReturnBookingSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => key !== "kind" && key !== "id")
    || !RETURN_BOOKING_SOURCE_KINDS.includes(source.kind as ReturnBookingSource["kind"])
    || typeof source.id !== "number" || !Number.isSafeInteger(source.id) || source.id <= 0 || source.id > 2147483647) return null;
  return { kind: source.kind as ReturnBookingSource["kind"], id: source.id };
}
