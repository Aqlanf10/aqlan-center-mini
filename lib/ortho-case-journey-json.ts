/** Browser-safe exact canonical JSON. Arrays retain their authored order. */
function canonical(value: unknown, depth: number): unknown {
  if (depth > 64) throw new Error("json_depth_limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  // JSON has no distinct negative-zero representation; normalize only that value.
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return Array.from(value, item => canonical(item, depth + 1));
  if (typeof value === "object" && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonical((value as Record<string, unknown>)[key], depth + 1);
    return result;
  }
  throw new Error("invalid_json_value");
}
export function canonicalJourneyJSON(value: unknown): string { return JSON.stringify(canonical(value, 0)); }
