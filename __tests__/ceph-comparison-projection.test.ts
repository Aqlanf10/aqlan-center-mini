import { describe, expect, it } from "vitest";
import { cephComparisonProjectionSha256 } from "../lib/ceph-comparison-projection";
import type { CephAnalysisForCompare } from "../lib/db";

type Projection = Omit<CephAnalysisForCompare, "projectionSha256">;
const source = (): Projection => ({ id: 1, patientId: 11, documentId: 51, imageSha256: null,
  status: "draft", provenanceState: "not_completed", phase: "pretreatment", xrayDate: "2020-01-01", createdAt: "2026-01-01",
  documentWidth: 800, documentHeight: 600, mmPerPixel: .1,
  points: { S: { x: 20, y: 20 }, N: { x: 80, y: 20 }, Me: { x: 60, y: 100 } },
  measurements: [{ code: "SNA", name: "SNA", value: 82, mean: 82, unit: "°" }, { code: "SN", name: "SN", value: 6, mean: null, unit: "mm" }],
  comparisonUnavailableReason: null, provenanceNotice: "Draft preview" });

describe("server comparison projection identity", () => {
  it("is opaque and stable without mutating its source or depending on object/landmark/result order", () => {
    const original = source(), saved = structuredClone(original), hash = cephComparisonProjectionSha256(original);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const reordered = Object.fromEntries(Object.entries(original).reverse()) as Projection;
    reordered.points = Object.fromEntries(Object.entries(original.points).reverse().map(([code, point]) => [code, { y: point!.y, x: point!.x }]));
    reordered.measurements = [...original.measurements].reverse();
    expect(cephComparisonProjectionSha256(reordered)).toBe(hash); expect(original).toEqual(saved);
  });
  it.each([
    ["landmark", (p: Projection) => { p.points.N!.x += .01; }],
    ["scale", (p: Projection) => { p.mmPerPixel = .2; }],
    ["numeric result", (p: Projection) => { p.measurements[0].value = 85; }],
    ["projected reference mean", (p: Projection) => { p.measurements[0].mean = 90; }],
    ["unit", (p: Projection) => { p.measurements[0].unit = "mm"; }],
    ["calculation provenance", (p: Projection) => { p.measurements[0].provenanceKey = "sealed-engine"; }],
    ["image dimensions", (p: Projection) => { p.documentWidth = 1000; }],
    ["image identity", (p: Projection) => { p.imageSha256 = "a".repeat(64); }],
    ["document", (p: Projection) => { p.documentId = 52; }],
    ["patient", (p: Projection) => { p.patientId = 12; }],
    ["analysis", (p: Projection) => { p.id = 2; }],
    ["status", (p: Projection) => { p.status = "completed"; }],
    ["provenance", (p: Projection) => { p.provenanceState = "integrity_unavailable"; }],
    ["acquisition date", (p: Projection) => { p.xrayDate = "2021-01-01"; }],
    ["creation date", (p: Projection) => { p.createdAt = "2022-01-01"; }],
    ["phase", (p: Projection) => { p.phase = "posttreatment"; }],
  ] as const)("binds %s without treating unchanged IDs as source equality", (_, change) => {
    const before = source(), after = source(); change(after);
    expect(cephComparisonProjectionSha256(after)).not.toBe(cephComparisonProjectionSha256(before));
  });
  it.each([
    ["NaN coordinate", (p: Projection) => { p.points.N!.x = NaN; }],
    ["infinite coordinate", (p: Projection) => { p.points.N!.y = Infinity; }],
    ["missing coordinate", (p: Projection) => { Reflect.deleteProperty(p.points.N!, "x"); }],
    ["undefined point", (p: Projection) => { p.points.N = undefined; }],
    ["infinite scale", (p: Projection) => { p.mmPerPixel = Infinity; }],
    ["missing scale", (p: Projection) => { Reflect.deleteProperty(p, "mmPerPixel"); }],
    ["nonfinite dimension", (p: Projection) => { p.documentWidth = NaN; }],
    ["missing measurements", (p: Projection) => { Reflect.deleteProperty(p, "measurements"); }],
    ["nonfinite measurement", (p: Projection) => { p.measurements[0].value = Infinity; }],
    ["nonfinite mean", (p: Projection) => { p.measurements[0].mean = NaN; }],
    ["missing mean", (p: Projection) => { Reflect.deleteProperty(p.measurements[0], "mean"); }],
    ["duplicate code", (p: Projection) => { p.measurements.push({ ...p.measurements[0], value: 90 }); }],
    ["malformed image hash", (p: Projection) => { p.imageSha256 = "private/path"; }],
  ] as const)("fails closed rather than hashing a collapsed %s", (_, change) => {
    const invalid = source(); change(invalid);
    expect(() => cephComparisonProjectionSha256(invalid)).toThrow("Invalid cephalometric comparison projection");
  });
  it("excludes private/unrelated data and intentionally treats same-state ABA as equal", () => {
    const before = source(), after = { ...source(), note: "private", storageKey: "private/path", actor: "private" };
    after.points.N!.x = 180; after.points.N!.x = 80;
    expect(cephComparisonProjectionSha256(after)).toBe(cephComparisonProjectionSha256(before));
  });
});
