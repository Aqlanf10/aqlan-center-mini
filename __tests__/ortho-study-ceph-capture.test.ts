import { describe, expect, it } from "vitest";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { decodeStudySavedContent } from "../lib/ortho-case-study-capture";
import { decodeWitnessedStudyCephCapture, decodeWitnessedStudyCephCaptureV2, decodeWitnessedStudyCephCaptureV3, isWitnessedStudyCephCapture } from "../lib/ortho-study-ceph-capture";
import { syntheticStudyCommand } from "./fixtures/ortho-case-study";
import { syntheticWitnessedStudyCephCapture, syntheticSourceBoundStudyCephCapture } from "./fixtures/ortho-study-ceph-witness";
const selection = (payload: unknown) => ({ key: "ceph", kind: "ceph_study" as const, id: 7, version: null, contentHash: journeyContentHash(payload) });
describe("saved schema1 with a nested witnessed ceph capture", () => {
  it("accepts only pinned schema1 witness evidence without consulting current engine or reference definitions", () => {
    const capture = syntheticWitnessedStudyCephCapture();
    expect(decodeWitnessedStudyCephCapture(capture, selection(capture))).toEqual({ ok: true, value: capture });
    expect(isWitnessedStudyCephCapture(capture)).toBe(true);
    expect(isWitnessedStudyCephCapture({ id: 7 })).toBe(false);
    expect(isWitnessedStudyCephCapture(null)).toBe(false);
  });
  it("keeps outer saved schema1 and permits historical witness identity before a patient merge", () => {
    const payload = syntheticWitnessedStudyCephCapture(), s = selection(payload), authored = syntheticStudyCommand().content;
    authored.sources = [s];
    const saved = { schemaVersion: 1, capturedAt: "2026-11-05T12:10:00.000Z", recordedPatientId: 99,
      orthoCaseId: 31, clinicalCaseId: 41, caseStatusAtCapture: "completed", authored,
      sources: [{ selection: s, state: "available", unavailableReason: null, access: { images: true, plans: false }, payload }] };
    expect(decodeStudySavedContent(saved, { patientId: 101, orthoCaseId: 31, clinicalCaseId: 41 })).toEqual({ ok: true, value: saved });
  });
  it.each([
    (c: ReturnType<typeof syntheticWitnessedStudyCephCapture>) => ({ ...c, measurements: [] }),
    (c: ReturnType<typeof syntheticWitnessedStudyCephCapture>) => ({ ...c, image: c.completion.witness.image }),
    (c: ReturnType<typeof syntheticWitnessedStudyCephCapture>) => ({ ...c, diagnosis: c.completion.witness.snapshot.diagnosis }),
    (c: ReturnType<typeof syntheticWitnessedStudyCephCapture>) => ({ ...c, captureVersion: 3 }),
    (c: ReturnType<typeof syntheticWitnessedStudyCephCapture>) => ({ ...c, status: "draft" }),
    (c: ReturnType<typeof syntheticWitnessedStudyCephCapture>) => ({ ...c, id: 8 }),
    (c: ReturnType<typeof syntheticWitnessedStudyCephCapture>) => ({ ...c, createdAt: "bad" }),
    (c: ReturnType<typeof syntheticWitnessedStudyCephCapture>) => ({ ...c, completion: { ...c.completion, witnessSha256: "0".repeat(64) } }),
  ])("rejects malformed or contradictory captures even after rehashing %i", mutate => {
    const raw = mutate(syntheticWitnessedStudyCephCapture());
    expect(decodeWitnessedStudyCephCapture(raw, selection(raw)).ok).toBe(false);
  });
  it.each(["schemaVersion", "sourceIdentityMeaning"])("rejects unsupported/overstated frozen witness %s even after all hashes are rewritten", key => {
    const raw = syntheticWitnessedStudyCephCapture();
    Object.assign(raw.completion.witness, { [key]: key === "schemaVersion" ? 2 : "confirmed_as_viewed" });
    raw.completion.witnessSha256 = journeyContentHash(raw.completion.witness);
    expect(decodeWitnessedStudyCephCapture(raw, selection(raw)).ok).toBe(false);
  });
  it("binds kind, version, id, and source hash", () => {
    const raw = syntheticWitnessedStudyCephCapture(), s = selection(raw);
    for (const bad of [{ ...s, kind: "document" as const }, { ...s, version: 2 }, { ...s, id: 8 }, { ...s, contentHash: "0".repeat(64) }])
      expect(decodeWitnessedStudyCephCapture(raw, bad).ok).toBe(false);
  });
});

describe("explicit source-bound nested ceph capture v3", () => {
  it("accepts schema2 source identity only in capture3 while preserving outer schema1", () => {
    const payload = syntheticSourceBoundStudyCephCapture(), s = selection(payload), authored = syntheticStudyCommand().content;
    authored.sources = [s];
    expect(isWitnessedStudyCephCapture(payload)).toBe(true);
    expect(decodeWitnessedStudyCephCapture(payload, s)).toEqual({ ok: true, value: payload });
    const saved = { schemaVersion: 1, capturedAt: "2026-11-05T12:10:00.000Z", recordedPatientId: 99,
      orthoCaseId: 31, clinicalCaseId: 41, caseStatusAtCapture: "completed", authored,
      sources: [{ selection: s, state: "available", unavailableReason: null, access: { images: true, plans: false }, payload }] };
    expect(decodeStudySavedContent(saved, { patientId: 101, orthoCaseId: 31, clinicalCaseId: 41 })).toEqual({ ok: true, value: saved });
  });
  it("keeps each exported branch decoder strict", () => {
    const v2 = syntheticWitnessedStudyCephCapture(), v3 = syntheticSourceBoundStudyCephCapture();
    expect(decodeWitnessedStudyCephCaptureV2(v2, selection(v2))).toEqual({ ok: true, value: v2 });
    expect(decodeWitnessedStudyCephCaptureV3(v3, selection(v3))).toEqual({ ok: true, value: v3 });
    expect(decodeWitnessedStudyCephCaptureV2(v3, selection(v3)).ok).toBe(false);
    expect(decodeWitnessedStudyCephCaptureV3(v2, selection(v2)).ok).toBe(false);
  });
  it("keeps the original capture2 payload/hash immutable and forbids implicit assurance upgrades", () => {
    const old = syntheticWitnessedStudyCephCapture();
    expect(journeyContentHash(old)).toBe("9de3bf7fe78e791fea86fcfba23cd096f8d7c7915e2e62b9787d597dcf48b545");
    const upgraded = { ...old, captureVersion: 3 };
    const downgraded = { ...syntheticSourceBoundStudyCephCapture(), captureVersion: 2 };
    for (const raw of [upgraded, downgraded]) expect(decodeWitnessedStudyCephCapture(raw, selection(raw)).ok).toBe(false);
    expect(decodeWitnessedStudyCephCapture(old, selection(old))).toEqual({ ok: true, value: old });
  });
  it.each([0, 1, 4, 99, "3", null])("fails closed for unknown capture version %s even after rehashing", captureVersion => {
    const raw = { ...syntheticSourceBoundStudyCephCapture(), captureVersion };
    expect(isWitnessedStudyCephCapture(raw)).toBe(false);
    expect(decodeWitnessedStudyCephCapture(raw, selection(raw)).ok).toBe(false);
    const s = selection(raw), authored = syntheticStudyCommand().content;
    authored.sources = [s];
    const saved = { schemaVersion: 1, capturedAt: "2026-11-05T12:10:00.000Z", recordedPatientId: 11,
      orthoCaseId: 31, clinicalCaseId: 41, caseStatusAtCapture: "completed", authored,
      sources: [{ selection: s, state: "available", unavailableReason: null, access: { images: true, plans: false }, payload: raw }] };
    expect(decodeStudySavedContent(saved, { patientId: 11, orthoCaseId: 31, clinicalCaseId: 41 }).ok).toBe(false);
  });
  it.each([
    (c: ReturnType<typeof syntheticSourceBoundStudyCephCapture>) => { Object.assign(c, { measurements: [] }); },
    (c: ReturnType<typeof syntheticSourceBoundStudyCephCapture>) => { Object.assign(c.completion, { verified: true }); },
    (c: ReturnType<typeof syntheticSourceBoundStudyCephCapture>) => { delete (c.completion.witness as Partial<typeof c.completion.witness>).sourceReview; },
    (c: ReturnType<typeof syntheticSourceBoundStudyCephCapture>) => { Object.assign(c.completion.witness, { schemaVersion: 3 }); },
    (c: ReturnType<typeof syntheticSourceBoundStudyCephCapture>) => { Object.assign(c.completion.witness, { sourceIdentityMeaning: "server_captured_at_completion_not_confirmed_as_viewed" }); },
    (c: ReturnType<typeof syntheticSourceBoundStudyCephCapture>) => { c.completion.witness.sourceReview.identity.imageSha256 = "0".repeat(64); },
    (c: ReturnType<typeof syntheticSourceBoundStudyCephCapture>) => { c.completion.witness.sourceReview.identity.referenceSetSha256 = "0".repeat(64); },
    (c: ReturnType<typeof syntheticSourceBoundStudyCephCapture>) => { c.completion.witness.sourceReview.identity.engineSourceSha256 = "0".repeat(64); },
    (c: ReturnType<typeof syntheticSourceBoundStudyCephCapture>) => { c.completion.witness.sourceReview.identity.documentId++; },
    (c: ReturnType<typeof syntheticSourceBoundStudyCephCapture>) => { Object.assign(c.completion.witness, { clinicalMeaning: "clinically_validated" }); },
  ])("rejects corrupt source binding or overstatement after rehashing %#", mutate => {
    const raw = syntheticSourceBoundStudyCephCapture(); mutate(raw);
    raw.completion.witnessSha256 = journeyContentHash(raw.completion.witness);
    expect(decodeWitnessedStudyCephCapture(raw, selection(raw)).ok).toBe(false);
  });
});
