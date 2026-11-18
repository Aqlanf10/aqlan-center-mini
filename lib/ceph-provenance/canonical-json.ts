/**
 * Exact canonical JSON and its SHA-256 for cephalometric completion evidence. Object keys are sorted, array order
 * is kept as authored, -0 becomes 0, and anything that is not plain JSON is refused (no silent coercion).
 * Ported from #530 (ortho-case-journey-json) without the orthodontic journey dependency.
 * A hash detects corruption or drift; it is not a digital signature and not clinical validation.
 */
import { createHash } from "node:crypto";

function canonical(value: unknown, depth: number): unknown {
  if (depth > 64) throw new Error("json_depth_limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return Array.from(value, (item) => canonical(item, depth + 1));
  if (typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonical((value as Record<string, unknown>)[key], depth + 1);
    return result;
  }
  throw new Error("invalid_json_value");
}

export function canonicalCephJson(value: unknown): string {
  return JSON.stringify(canonical(value, 0));
}

export function cephContentHash(value: unknown): string {
  return createHash("sha256").update(canonicalCephJson(value)).digest("hex");
}
