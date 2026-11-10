import { describe, expect, it } from "vitest";
import { parseCephCorrectionOrigin, parseCephCorrectionSourceToken, parseCephCorrectionCommand, sameCephCorrectionSource } from "../lib/ceph-correction-origin";
const token = { schemaVersion: 1, analysisId: 11, patientId: 2, orthoCaseId: 3, documentId: 4, sourceSha256: "a".repeat(64) };
const origin = { schemaVersion: 1, parentAnalysisId: 11, recordedPatientId: 2, orthoCaseId: 3, documentId: 4,
  parentCompletion: { state: "versioned", witnessVersion: 2, witnessSha256: "b".repeat(64) }, sourceSnapshotSha256: "c".repeat(64) };
describe("strict correction source identity", () => {
  it("keeps old/no-origin distinct from an explicitly unversioned parent", () => {
    expect(parseCephCorrectionOrigin(null)).toBeNull();
    expect(parseCephCorrectionOrigin({ ...origin, parentCompletion: { state: "unversioned", reason: "historical_completion_without_witness" } })).toMatchObject({ parentCompletion: { state: "unversioned" } });
    expect(parseCephCorrectionOrigin(origin)).toEqual(origin);
  });
  it.each([0, -1, 1.5, "11", Number.MAX_SAFE_INTEGER + 1])("refuses invalid parent identifier %s", parentAnalysisId => {
    expect(parseCephCorrectionOrigin({ ...origin, parentAnalysisId })).toBeNull();
  });
  it("rejects added fields, missing proof and unsupported witness versions without inferring old note links", () => {
    for (const invalid of [{ ...origin, note: "copy from11" }, { ...origin, parentCompletion: { state: "versioned", witnessVersion: 3, witnessSha256: "b".repeat(64) } }, { ...origin, sourceSnapshotSha256: null }]) expect(parseCephCorrectionOrigin(invalid)).toBeNull();
  });
  it("requires a complete explicit command and exact current source token", () => {
    expect(parseCephCorrectionCommand({ schemaVersion: 1, expectedCorrectionSource: token })).toEqual({ schemaVersion: 1, expectedCorrectionSource: token });
    expect(parseCephCorrectionCommand({})).toBeNull(); expect(parseCephCorrectionCommand({ schemaVersion: 1, expectedCorrectionSource: token, patientId: 2 })).toBeNull();
    expect(sameCephCorrectionSource(token, token)).toBe(true);
    for (const change of [{ analysisId: 12 }, { patientId: 5 }, { orthoCaseId: null }, { documentId: 6 }, { sourceSha256: "d".repeat(64) }]) expect(sameCephCorrectionSource(token, { ...token, ...change })).toBe(false);
    expect(parseCephCorrectionSourceToken({ ...token, sourceSha256: "A".repeat(64) })).toBeNull();
  });
  it("returns detached primitive identities, preserving nullable standalone case scope", () => {
    const raw = { ...origin, orthoCaseId: null, parentCompletion: { ...origin.parentCompletion } };
    const parsed = parseCephCorrectionOrigin(raw)!; raw.parentCompletion.witnessSha256 = "d".repeat(64);
    expect(parsed.parentCompletion).toEqual(origin.parentCompletion); expect(parsed.orthoCaseId).toBeNull();
  });
});
