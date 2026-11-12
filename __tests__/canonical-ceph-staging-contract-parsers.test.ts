import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { CanonicalCephEditRefusal, parseCanonicalCephEdit } from "../lib/canonical-ceph-edit-command";
import { CanonicalCephCompleteRefusal, parseCanonicalCephComplete } from "../lib/canonical-ceph-complete-command";
import { CanonicalCephCopyRefusal, parseCanonicalCephCopy } from "../lib/canonical-ceph-copy-command";
import { parseCanonicalCephDiscard } from "../lib/canonical-ceph-discard-command";
import { parseCephDraftEdit } from "../lib/ceph-draft-edit";

/** The canonical commands admit exactly the bodies the legacy routes admit (staging contract). */
const calibration = { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, expectedCalibration = { calibration: null, mmPerPixel: null };
const diagnosis = { skeletal: null, dental: null, softTissue: null, note: null, finalDx: "SYN draft" };
it.each(["0", "01", "-1", "1.2", "1e2", " 1", "2147483648"])("rejects invalid identity %s before any database access", id => {
  expect(() => parseCanonicalCephEdit(id, { diagnosis, expectedDiagnosis: null })).toThrow(CanonicalCephEditRefusal);
  expect(() => parseCanonicalCephComplete(id, {})).toThrow(CanonicalCephCompleteRefusal);
  expect(() => parseCanonicalCephCopy(id, {})).toThrow(CanonicalCephCopyRefusal);
});
it("requires the observed prior state of every edit category, one category per request", () => {
  expect(parseCanonicalCephEdit("7", { calibration, expectedCalibration }).edit.kind).toBe("calibration");
  expect(parseCanonicalCephEdit("7", { diagnosis, expectedDiagnosis: null }).edit.kind).toBe("diagnosis");
  expect(parseCanonicalCephEdit("7", { landmarks: [{ code: "S", x: 1, y: 2 }], expectedLandmarks: [] }).edit.kind).toBe("landmarks");
  expect(() => parseCanonicalCephEdit("7", { calibration })).toThrow(/نسخة المعايرة السابقة/);
  expect(() => parseCanonicalCephEdit("7", { landmarks: [] })).toThrow(/مواضعها السابقة/);
  expect(() => parseCanonicalCephEdit("7", { diagnosis })).toThrow(/نسخته السابقة/);
  expect(() => parseCanonicalCephEdit("7", { calibration, expectedCalibration, diagnosis, expectedDiagnosis: null })).toThrow(/طلب مستقل/);
  expect(() => parseCanonicalCephEdit("7", { removeLandmarks: ["S"], expectedLandmarks: [] })).toThrow(/موضعه المحفوظ/);
});
it("is the same parser the legacy route uses (no second admission rule)", () => {
  for (const body of [{ calibration, expectedCalibration }, { diagnosis, expectedDiagnosis: null }, { calibration: { ...calibration, x2: 0 }, expectedCalibration }])
    expect(parseCephDraftEdit(body)).toEqual((() => { try { return { ok: true, edit: parseCanonicalCephEdit("7", body).edit }; } catch (error) { return { ok: false, message: (error as Error).message }; } })());
});
it("completion needs a valid reviewed snapshot; a present but malformed source identity is refused", () => {
  expect(() => parseCanonicalCephComplete("7", { expectedVersion: "a".repeat(64) })).toThrow(/نسخة صالحة/);
  expect(() => parseCanonicalCephComplete("7", { expectedSnapshot: {}, expectedSources: null })).toThrow(CanonicalCephCompleteRefusal);
});
it("a correction copy needs this study's own correction token", () => {
  expect(() => parseCanonicalCephCopy("7", {})).toThrow(/أصل التصحيح/);
  expect(() => parseCanonicalCephCopy("7", { schemaVersion: 1, expectedCorrectionSource: { analysisId: 8 } })).toThrow(CanonicalCephCopyRefusal);
});
it("discard keeps the legacy body: an optional textual note only", () => {
  expect(parseCanonicalCephDiscard("7", { note: "SYN wrong image" })).toEqual({ id: 7, note: "SYN wrong image" });
  expect(parseCanonicalCephDiscard("7", { note: 5, actor: "owner" })).toEqual({ id: 7, note: null });
  expect(parseCanonicalCephDiscard("7", null)).toEqual({ id: 7, note: null });
});
