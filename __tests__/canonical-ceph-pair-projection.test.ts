import { expect, it } from "vitest";
import { isCanonicalCephComparison as compare, isCanonicalCephSuperimposition as geometry, type CanonicalCephComparison, type CanonicalCephSuperimposition } from "../lib/canonical-ceph-pair-projection";

const study = { id: 1, status: "completed" as const, phase: "pretreatment" as const, xrayDate: "2024-01-01", createdAt: "2024-01-02T12:00:00Z", measurementsState: "saved-approved" as const };
const line = { from: { x: 0, y: 0 }, to: { x: 10, y: 5 }, label: "SN" };
const comparison = (): CanonicalCephComparison => ({ projection: "ceph-saved-comparison", patientId: 7, before: { ...study }, after: { ...study, id: 2 }, normSource: "historical-norm-not-stored", rows: [{ code: "SYN_OLD", before: 4.125, after: 2.25, delta: -1.875 }], onlyBefore: ["ONLY_B"], onlyAfter: ["ONLY_A"] });
const placed = (): CanonicalCephSuperimposition => ({ projection: "ceph-saved-superimposition", patientId: 7, before: { ...study, lines: [structuredClone(line)] }, after: { ...study, id: 2, lines: [structuredClone(line)] }, geometrySource: "derived-from-saved-landmarks", rotationDegrees: 0, cranialBaseBefore: 10, cranialBaseAfter: 11, viewBox: { x: -1, y: -1, width: 12, height: 7 } });
it("accepts saved-value and derived-geometry projections without requiring invented historical norms", () => {
  expect(compare(comparison(), 7, 1, 2)).toBe(true); expect(compare(comparison(), 7, 2, 1)).toBe(true); expect(geometry(placed(), 7, 1, 2)).toBe(true);
});
it("binds both projections to the exact patient and both selected studies", () => {
  for (const [p, a, b] of [[8, 1, 2], [7, 1, 3], [7, 2, 2], [0, 1, 2], [7, NaN, 2]]) {
    expect(compare(comparison(), p, a, b)).toBe(false); expect(geometry(placed(), p, a, b)).toBe(false);
  }
});
it.each(["duplicate", "invented-delta", "nonfinite", "wrong-type", "too-many", "missing-only", "overlap"])("refuses misleading comparison rows: %s", kind => {
  const v = comparison();
  if (kind === "duplicate") v.rows.push({ ...v.rows[0] });
  if (kind === "invented-delta") v.rows[0].delta = 1;
  if (kind === "nonfinite") v.rows[0].before = Infinity;
  if (kind === "wrong-type") (v.rows[0] as unknown as { before: string }).before = "4.125";
  if (kind === "too-many") v.onlyBefore = Array.from({ length: 256 }, (_, i) => `old-${i}`);
  if (kind === "missing-only") (v as unknown as { onlyBefore: null }).onlyBefore = null;
  if (kind === "overlap") v.onlyBefore.push(v.rows[0].code);
  expect(compare(v, 7, 1, 2)).toBe(false);
});
it.each(["bad-line", "nonfinite", "zero-span", "zero-box", "over-count", "wrong-source"])("refuses misleading or unrenderable geometry: %s", kind => {
  const v = placed();
  if (kind === "bad-line") v.before.lines[0].from.x = NaN;
  if (kind === "nonfinite") v.rotationDegrees = Infinity;
  if (kind === "zero-span") v.cranialBaseBefore = 0;
  if (kind === "zero-box") v.viewBox.width = 0;
  if (kind === "over-count") v.before.lines = Array.from({ length: 9 }, () => structuredClone(line));
  if (kind === "wrong-source") (v as unknown as { geometrySource: string }).geometrySource = "current-live-tracing";
  expect(geometry(v, 7, 1, 2)).toBe(false);
});
it("rejects mismatched draft approval labels and unsupported phase metadata", () => {
  const a = comparison(); a.before.status = "draft"; expect(compare(a, 7, 1, 2)).toBe(false);
  a.before.measurementsState = "saved-unapproved"; expect(compare(a, 7, 1, 2)).toBe(true);
  const b = placed(); (b.after as unknown as { phase: string }).phase = "unknown"; expect(geometry(b, 7, 1, 2)).toBe(false);
});
