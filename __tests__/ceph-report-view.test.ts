import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { buildCephReportTracing, cephAgeAtAcquisition, cephReportAgeLabel,
  cephReportCalibration, sameCephReportSource, type CephReportGeometryInput } from "../lib/ceph-report-view";

const landmarks = () => [
  { code: "S", x: 10, y: 20 }, { code: "N", x: 50, y: 15 },
  { code: "A", x: 55, y: 60 }, { code: "Me", x: 45, y: 95 },
];
const input = (): CephReportGeometryInput => ({ analysisId: 401, patientId: 402, documentId: 403,
  status: "draft", draftLandmarks: landmarks(), saved: { analysisId: 401, recordedPatientId: 402,
    image: { documentId: 403 }, snapshot: { patientId: 402, documentId: 403,
      mmPerPixel: 0.05, landmarks: landmarks().map(point => ({ ...point, x: point.x + 100 })) } } });

describe("cephalometric acquisition age never uses the print clock", () => {
  for (const date of [null, undefined, "", "2026", "2026-2-03", "2026-02-30", "2025-02-29", "1900-02-29",
    "2026-00-02", "2026-13-01", "2026-01-00", "2026-01-32", "2026-01-01T12:00:00Z", "2026-04-31"]) {
    it(`withholds age for invalid acquisition date ${String(date)}`, () => {
      assert.equal(cephAgeAtAcquisition(1900, date), null);
    });
  }
  for (const year of [null, undefined, NaN, Infinity, 0, -5, 2000.5, 10000, 2027]) {
    it(`withholds age for invalid/future birth year ${String(year)}`, () => {
      assert.equal(cephAgeAtAcquisition(year, "2026-01-01"), null);
    });
  }
  it("expresses birth-year uncertainty rather than inventing a birthday", () => {
    assert.deepEqual(cephAgeAtAcquisition(2010, "2026-01-01"),
      { minimumYears: 15, maximumYears: 16, precision: "birth_year_only" });
    assert.equal(cephReportAgeLabel(cephAgeAtAcquisition(2010, "2026-01-01")), "15–16 سنة تقريبًا (سنة الميلاد فقط)");
  });
  it("accepts a valid leap day", () => assert.equal(cephAgeAtAcquisition(1990, "2000-02-29")?.maximumYears, 10));
  it("accepts Gregorian year 0001 without Date's year-1900 coercion", () => assert.equal(cephAgeAtAcquisition(1, "0001-01-01")?.maximumYears, 0));
  it("does not generate a negative lower age bound", () => assert.equal(cephAgeAtAcquisition(2026, "2026-04-10")?.minimumYears, 0));
  it("explains missing age", () => assert.match(cephReportAgeLabel(null), /غير متاح/));
});

describe("report image calibration is not paper scale", () => {
  it("uses saved calibration exclusively for completed studies", () => assert.equal(cephReportCalibration("completed", 9, input().saved), "0.05 mm/px"));
  it("uses the draft calibration only for drafts", () => assert.equal(cephReportCalibration("draft", 0.2, input().saved), "0.2 mm/px"));
  it("does not borrow draft calibration for unversioned history", () => assert.equal(cephReportCalibration("completed", 0.2, null), "المعايرة التاريخية غير موثّقة"));
  for (const scale of [null, 0, -1, NaN, Infinity, -Infinity]) {
    it(`withholds invalid draft calibration ${String(scale)}`, () => assert.equal(cephReportCalibration("draft", scale, null), "غير معايَر"));
    it(`does not replace invalid saved calibration ${String(scale)}`, () => {
      const saved = input().saved!; saved.snapshot.mmPerPixel = scale;
      assert.equal(cephReportCalibration("completed", 0.1, saved), "المعايرة التاريخية غير صالحة");
    });
  }
  it("keeps very small positive scales without reciprocal overflow", () => {
    const label = cephReportCalibration("draft", Number.MIN_VALUE, null);
    assert.equal(label, "5e-324 mm/px"); assert.doesNotMatch(label, /Infinity|1:100|px\/mm/);
  });
  it("withholds calibration for discarded studies", () => assert.equal(cephReportCalibration("discarded", 0.1, input().saved), "غير متاح"));
});

describe("report tracing comes only from the selected source", () => {
  it("uses draft geometry only in a draft", () => {
    const result = buildCephReportTracing(input());
    assert.equal(result.available, true);
    if (result.available) { assert.equal(result.source, "draft"); assert.equal(result.points[0].x, 10); }
  });
  it("uses sealed coordinates despite divergent current landmarks", () => {
    const data = input(); data.status = "completed";
    const result = buildCephReportTracing(data);
    assert.equal(result.available, true);
    if (result.available) { assert.equal(result.source, "sealed"); assert.equal(result.points[0].x, 110); }
  });
  it("does not mutate or retain aliases to caller coordinates", () => {
    const data = input(), before = JSON.stringify(data), result = buildCephReportTracing(data);
    assert.equal(JSON.stringify(data), before);
    data.draftLandmarks[0].x = 900;
    if (!result.available) throw new Error("missing tracing");
    assert.equal(result.points[0].x, 10);
  });
  it("keeps an empty sealed set empty instead of borrowing draft landmarks", () => {
    const data = input(); data.status = "completed"; data.saved!.snapshot.landmarks = [];
    assert.deepEqual(buildCephReportTracing(data), { available: false, reason: "insufficient_landmarks" });
  });
  it("withholds unversioned completed geometry", () => {
    const data = input(); data.status = "completed"; data.saved = null;
    assert.deepEqual(buildCephReportTracing(data), { available: false, reason: "unversioned_history" });
  });
  for (const part of ["analysis", "recorded-patient", "snapshot-patient", "snapshot-document", "image-document"]) {
    it(`rejects a ${part} source mismatch`, () => {
      const data = input(); data.status = "completed";
      if (part === "analysis") data.saved!.analysisId++;
      if (part === "recorded-patient") data.saved!.recordedPatientId++;
      if (part === "snapshot-patient") data.saved!.snapshot.patientId++;
      if (part === "snapshot-document") data.saved!.snapshot.documentId++;
      if (part === "image-document") data.saved!.image.documentId++;
      assert.equal(sameCephReportSource(data), false);
      assert.deepEqual(buildCephReportTracing(data), { available: false, reason: "source_mismatch" });
    });
  }
  for (const status of ["discarded", "unknown", ""]) {
    it(`rejects status ${status}`, () => assert.deepEqual(buildCephReportTracing({ ...input(), status }), { available: false, reason: "unsupported_status" }));
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    it(`rejects nonfinite coordinates ${String(value)}`, () => {
      const data = input(); data.draftLandmarks[0].y = value;
      assert.deepEqual(buildCephReportTracing(data), { available: false, reason: "invalid_landmarks" });
    });
  }
  it("rejects duplicate codes rather than choosing one silently", () => {
    const data = input(); data.draftLandmarks[1].code = "S";
    assert.deepEqual(buildCephReportTracing(data), { available: false, reason: "invalid_landmarks" });
  });
  it("rejects invalid code markup", () => {
    const data = input(); data.draftLandmarks[1].code = '<script>';
    assert.deepEqual(buildCephReportTracing(data), { available: false, reason: "invalid_landmarks" });
  });
  it("withholds a collapsed extent", () => assert.deepEqual(buildCephReportTracing({ ...input(),
    draftLandmarks: landmarks().map(point => ({ ...point, x: 1, y: 1 })) }), { available: false, reason: "invalid_extent" }));
  it("withholds an overflowing extent", () => {
    const data = input(); data.draftLandmarks[0].x = -Number.MAX_VALUE; data.draftLandmarks[1].x = Number.MAX_VALUE;
    assert.deepEqual(buildCephReportTracing(data), { available: false, reason: "invalid_extent" });
  });
  it("allows finite collinear diagrams without manufacturing an angle", () => {
    const data = input(); data.draftLandmarks = landmarks().map(point => ({ ...point, x: 0 }));
    const result = buildCephReportTracing(data); assert.equal(result.available, true);
    if (result.available) assert.ok(result.viewBox.split(" ").map(Number).every(Number.isFinite));
  });
  it("does not correct reversed landmark names or alter measurement inputs", () => {
    const data = input(); data.draftLandmarks = [
      { code: "U1A", x: 1, y: 9 }, { code: "U1", x: 1, y: 2 },
      { code: "L1A", x: 2, y: 1 }, { code: "L1", x: 2, y: 8 },
    ];
    const result = buildCephReportTracing(data); assert.equal(result.available, true);
    if (result.available) assert.deepEqual(result.points, data.draftLandmarks);
  });
});
