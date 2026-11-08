import { describe, expect, it } from "vitest";
import { normalizeCephDiagnosis, parseCephCompletionDiagnosis, parseCephCompletionSnapshot, sameCephCompletionSnapshot,
  type CephCompletionSnapshot } from "../lib/ceph-completion-snapshot";
const snapshot = (): CephCompletionSnapshot => ({ patientId: 11, documentId: 22, refSet: "builtin_default",
  calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, mmPerPixel: 0.1,
  landmarks: [{ code: "S", x: 10, y: 20, source: "manual" }, { code: "N", x: 20, y: 30, source: "suggested" }],
  diagnosis: { skeletal: null, dental: "Reviewed", softTissue: null, note: null, finalDx: "Explicit text" } });
describe("explicit reviewed completion snapshots", () => {
  it("accepts a truthful unready draft without treating it as completion-ready", () => {
    expect(parseCephCompletionSnapshot({ ...snapshot(), calibration: null, mmPerPixel: null, landmarks: [], diagnosis: null })).not.toBeNull();
  });
  it("compares full point sets independent of order, without mutating callers", () => {
    const a = snapshot(), b = snapshot(); b.landmarks.reverse();
    expect(sameCephCompletionSnapshot(a, b)).toBe(true); expect(a.landmarks[0].code).toBe("S");
  });
  it.each(["patientId", "documentId", "refSet", "calibration", "mmPerPixel", "landmarks", "diagnosis"])("requires explicit %s", key => {
    const value = { ...snapshot() } as Record<string, unknown>; delete value[key]; expect(parseCephCompletionSnapshot(value)).toBeNull();
  });
  it.each([NaN, Infinity, "0.1"])("rejects nonfinite/non-number scale %s", mmPerPixel => {
    expect(parseCephCompletionSnapshot({ ...snapshot(), mmPerPixel })).toBeNull();
  });
  it("rejects unknown, duplicate, unbounded or invalid point records", () => {
    const p = snapshot().landmarks[0];
    for (const landmarks of [[{ ...p, code: "UNKNOWN" }], [p, p], [{ ...p, source: undefined }],
      [{ ...p, x: NaN }], Array.from({ length: 28 }, () => p)]) {
      expect(parseCephCompletionSnapshot({ ...snapshot(), landmarks })).toBeNull();
    }
  });
  it("rejects unbounded references and diagnosis fields", () => {
    expect(parseCephCompletionSnapshot({ ...snapshot(), refSet: "x".repeat(201) })).toBeNull();
    expect(parseCephCompletionDiagnosis({ ...snapshot().diagnosis, note: "x".repeat(2001) })).toBeNull();
    expect(parseCephCompletionDiagnosis({ finalDx: "x" })).toBeNull();
  });
  it("detects changed sources, optional point sets and displayed diagnosis whitespace", () => {
    const a = snapshot();
    expect(sameCephCompletionSnapshot(a, { ...a, landmarks: a.landmarks.map(p => ({ ...p, source: "manual" })) })).toBe(false);
    expect(sameCephCompletionSnapshot(a, { ...a, landmarks: [...a.landmarks, { code: "D", x: 30, y: 40, source: "manual" }] })).toBe(false);
    expect(sameCephCompletionSnapshot(a, { ...a, diagnosis: { ...a.diagnosis, finalDx: "Explicit text " } })).toBe(false);
  });
  it("normalizes only a save acknowledgment, with the existing trim/cap/null rules", () => {
    expect(normalizeCephDiagnosis({ skeletal: "  a  ", dental: "   ", softTissue: null,
      note: "z".repeat(2001), finalDx: "  text  " })).toEqual({ skeletal: "a", dental: null, softTissue: null, note: "z".repeat(2000), finalDx: "text" });
  });
});
