import { createHash } from "node:crypto";
import type { CephAnalysisForCompare } from "./db";

type Projection = Omit<CephAnalysisForCompare, "projectionSha256">;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const finiteOrNull = (value: unknown) => value === null || finite(value);
const textOrNull = (value: unknown) => value === null || typeof value === "string";

/**
 * Equality of the clinical projection used by the table and overlay, not a
 * persisted revision, approval, authorization credential or freshness claim.
 * Explicit tuples exclude notes, actors, private storage paths and unrelated
 * mutable metadata. Means remain in the legacy projection shape but current
 * readers emit null. Catalog-only changes do not affect descriptive raw output;
 * this hash does not claim reference consistency or clinical applicability.
 */
export function cephComparisonProjectionSha256(source: Projection): string {
  // JSON would otherwise silently collapse undefined/nonfinite values to null.
  // Duplicate result codes are also rejected: comparison's Map is last-wins,
  // so sorting duplicate inputs could conceal a change in the selected value.
  const codes = new Set<string>();
  if (!source || ![source.id, source.patientId, source.documentId].every(id => Number.isSafeInteger(id) && id > 0)
    || ![source.documentWidth, source.documentHeight, source.mmPerPixel].every(finiteOrNull)
    || !textOrNull(source.xrayDate) || typeof source.createdAt !== "string" || typeof source.phase !== "string"
    || !["draft", "completed", "discarded"].includes(source.status)
    || !["not_completed", "versioned", "unversioned", "integrity_unavailable"].includes(source.provenanceState)
    || !(source.imageSha256 === null || typeof source.imageSha256 === "string" && /^[a-f0-9]{64}$/.test(source.imageSha256))
    || !source.points || typeof source.points !== "object" || Array.isArray(source.points)
    || Object.values(source.points).some(point => !point || !finite(point.x) || !finite(point.y))
    || !Array.isArray(source.measurements) || source.measurements.some(m => {
      if (!m || typeof m.code !== "string" || !m.code || codes.has(m.code) || typeof m.name !== "string" || typeof m.unit !== "string"
        || !finite(m.value) || !finiteOrNull(m.mean) || !(m.provenanceKey === undefined || typeof m.provenanceKey === "string")) return true;
      codes.add(m.code); return false;
    })) throw new Error("Invalid cephalometric comparison projection");
  const points = Object.entries(source.points).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([code, point]) => [code, point!.x, point!.y]);
  const measurements = source.measurements.map(m =>
    [m.code, m.name, m.unit, m.value, m.mean, m.provenanceKey ?? null])
    .sort((a, b) => { const left = JSON.stringify(a), right = JSON.stringify(b); return left < right ? -1 : left > right ? 1 : 0; });
  return createHash("sha256").update(JSON.stringify([
    "ceph-comparison-projection-v1",
    source.id, source.patientId, source.documentId, source.imageSha256,
    source.phase, source.xrayDate, source.createdAt, source.status, source.provenanceState,
    source.documentWidth, source.documentHeight, source.mmPerPixel, points, measurements,
  ])).digest("hex");
}
