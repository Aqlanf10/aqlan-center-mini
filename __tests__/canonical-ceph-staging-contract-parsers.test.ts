import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { CanonicalCephEditRefusal, parseCanonicalCephEdit } from "../lib/canonical-ceph-edit-command";
import { CanonicalCephCompleteRefusal, parseCanonicalCephComplete } from "../lib/canonical-ceph-complete-command";
import { CanonicalCephCopyRefusal, parseCanonicalCephCopy } from "../lib/canonical-ceph-copy-command";
import { parseCanonicalCephDiscard } from "../lib/canonical-ceph-discard-command";
import { parseCephDraftEdit } from "../lib/ceph-draft-edit";

/** Edit and discard admit exactly the legacy bodies; completion and copy take server-computed fingerprints. */
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
it("completion takes only the reviewed fingerprint; staging's snapshot and identity (internal image ids) are not accepted from the client", () => {
  const fp = "a".repeat(64);
  expect(parseCanonicalCephComplete("7", { expectedFingerprint: fp })).toEqual({ id: 7, fingerprint: fp });
  for (const body of [{}, null, [], { expectedFingerprint: "A".repeat(64) }, { expectedFingerprint: fp.slice(1) }, { expectedFingerprint: fp, expectedSources: null },
    { expectedSnapshot: {}, expectedSources: null }, { expectedFingerprint: fp, actor: "owner" }])
    expect(() => parseCanonicalCephComplete("7", body)).toThrow(/بصمة الدراسة/);
});
it("a correction copy takes only the reviewed correction fingerprint, never a client-built token", () => {
  const fp = "b".repeat(64);
  expect(parseCanonicalCephCopy("7", { schemaVersion: 1, expectedFingerprint: fp })).toEqual({ id: 7, fingerprint: fp });
  for (const body of [{}, { schemaVersion: 2, expectedFingerprint: fp }, { expectedFingerprint: fp }, { schemaVersion: 1, expectedFingerprint: fp, patientId: 2 },
    { schemaVersion: 1, expectedCorrectionSource: { analysisId: 7 } }])
    expect(() => parseCanonicalCephCopy("7", body)).toThrow(/أصل التصحيح/);
});
it("discard keeps the legacy body: an optional textual note only", () => {
  expect(parseCanonicalCephDiscard("7", { note: "SYN wrong image" })).toEqual({ id: 7, note: "SYN wrong image" });
  expect(parseCanonicalCephDiscard("7", { note: 5, actor: "owner" })).toEqual({ id: 7, note: null });
  expect(parseCanonicalCephDiscard("7", null)).toEqual({ id: 7, note: null });
});
