import { describe, expect, it } from "vitest";
import { syntheticFace } from "./fixtures/ortho-facial-analysis";
import type { FacialCommand } from "../lib/ortho-facial-analysis";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import {
  facialSubmissionHash,
  parseFacialSubmissionBody,
  readFacialSubmissionIdentity,
  verifyFacialSubmissionAcknowledgment,
  verifyFacialSubmissionRecovery,
  type FacialSubmissionExpectation,
  type FacialSubmissionIdentity,
} from "../lib/ortho-facial-submission-contract";
// Independently authored test roles; not identifiers, dates or notes from a patient record.
const SYN = {
  patient: 21001, orthoCase: 22001, clinicalCase: 23001, actor: 24001,
  document: 25001, revisionBase: 26000, submission: 27001,
  timestamp: '2001-02-03T04:05:06.000Z',
};


const scope = { patientId: SYN.patient, orthoCaseId: SYN.orthoCase, clinicalCaseId: SYN.clinicalCase };
const actorId = SYN.actor;
const command = (): FacialCommand => ({
  schemaVersion: 1,
  clientRequestId: 'synthetic_facial_submission_contract_001',
  documentId: SYN.document,
  expectedHeadId: null,
  reason: 'SYNTHETIC SUBMISSION-CONTRACT REASON 1',
  content: syntheticFace(),
});

function fixtures() {
  const c = command();
  const identity: FacialSubmissionIdentity = {
    id: SYN.submission,
    commandId: c.clientRequestId,
    requestFingerprint: journeyContentHash(c),
  };
  const expected: FacialSubmissionExpectation = { scope: { ...scope }, actorId, previousVersion: 0, command: c };
  return {
    identity,
    expected,
    recovery: { ok: true, scope: { ...scope }, actorId, recovery: { state: "pending", identity, expected } },
    acknowledgment: { ok: true, scope: { ...scope }, actorId, identity, state: "committed", acknowledged: true },
  };
}

describe("inactive facial submission envelope parser", () => {
  it("retains the exact command without claiming command validation or authority", () => {
    const c = command();
    const body = { patientId: scope.patientId, clinicalCaseId: scope.clinicalCaseId, actorId, command: c };
    expect(parseFacialSubmissionBody(body)).toEqual(body);
    expect(parseFacialSubmissionBody(body)?.command).toBe(c);
    expect(parseFacialSubmissionBody({ ...body, command: null })?.command).toBeNull();
  });

  it.each([null, undefined, [], true, "body", 1])("rejects a non-record envelope %s", raw => {
    expect(parseFacialSubmissionBody(raw)).toBeNull();
  });

  it.each(["patientId", "clinicalCaseId", "actorId", "command"] as const)("rejects missing %s", field => {
    const body: Record<string, unknown> = { patientId: SYN.patient, clinicalCaseId: SYN.clinicalCase, actorId, command: command() };
    delete body[field];
    expect(parseFacialSubmissionBody(body)).toBeNull();
  });

  it.each(["patientId", "clinicalCaseId", "actorId"] as const)("requires a positive safe integer for %s", field => {
    for (const value of [0, -1, 1.5, NaN, Infinity, "1", Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(parseFacialSubmissionBody({ patientId: SYN.patient, clinicalCaseId: SYN.clinicalCase, actorId, command: command(), [field]: value })).toBeNull();
    }
  });

  it("rejects additional fields instead of trusting an external authority claim", () => {
    expect(parseFacialSubmissionBody({ patientId: SYN.patient, clinicalCaseId: SYN.clinicalCase, actorId, command: command(), authorized: true })).toBeNull();
  });
});

describe("pure facial submission identity and fingerprints", () => {
  it("matches the existing SHA-256 canonical JSON helper without reordering arrays", async () => {
    const c = command();
    await expect(facialSubmissionHash(c)).resolves.toBe(journeyContentHash(c));
    await expect(facialSubmissionHash({ b: 2, a: 1 })).resolves.toBe(journeyContentHash({ a: 1, b: 2 }));
    expect(await facialSubmissionHash([1, 2])).not.toBe(await facialSubmissionHash([2, 1]));
    expect(await facialSubmissionHash({ ...c, reason: 'SYNTHETIC SUBMISSION-CONTRACT REASON 2' })).not.toBe(journeyContentHash(c));
    await expect(facialSubmissionHash({ coordinate: NaN })).rejects.toThrow();
  });

  it("accepts an exact identity and rejects malformed or additional fields", () => {
    const { identity } = fixtures();
    expect(readFacialSubmissionIdentity(identity)).toEqual(identity);
    for (const raw of [
      null, [], { ...identity, id: 0 }, { ...identity, id: "8" },
      { ...identity, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...identity, commandId: "short" }, { ...identity, commandId: " ".repeat(16) },
      { ...identity, requestFingerprint: "A".repeat(64) },
      { ...identity, requestFingerprint: "a".repeat(63) }, { ...identity, extra: true },
      { id: identity.id, commandId: identity.commandId },
    ]) expect(() => readFacialSubmissionIdentity(raw)).toThrow();
  });
});

describe("pure facial recovery receipts", () => {
  it("verifies exact pending and committed bytes without modifying the input", async () => {
    const f = fixtures();
    for (const state of ["pending", "committed"] as const) {
      const raw = { ...f.recovery, recovery: { ...f.recovery.recovery, state } };
      const before = structuredClone(raw);
      await expect(verifyFacialSubmissionRecovery(raw, scope, actorId)).resolves.toEqual(before);
      expect(raw).toEqual(before);
    }
  });

  it("accepts a later version only with a prior head and matching fingerprint", async () => {
    const f = fixtures();
    f.expected.previousVersion = 3;
    f.expected.command.expectedHeadId = SYN.revisionBase + 1;
    f.identity.requestFingerprint = journeyContentHash(f.expected.command);
    await expect(verifyFacialSubmissionRecovery(f.recovery, scope, actorId)).resolves.toEqual(f.recovery);
  });

  it("retains metadata-only absent, blocked and cancelled states", async () => {
    const f = fixtures();
    const states = [
      null,
      { state: "blocked", identity: null, canCancel: false },
      { state: "blocked", identity: f.identity, canCancel: true },
      { state: "cancelled", identity: f.identity },
    ];
    for (const recovery of states) {
      const raw = { ok: true, scope, actorId, recovery };
      await expect(verifyFacialSubmissionRecovery(raw, scope, actorId)).resolves.toEqual(raw);
    }
  });

  it.each([
    "actor", "patient", "ortho_case", "clinical_case", "expected_actor", "expected_scope",
    "hash", "command_id", "command", "version", "negative_version", "fractional_version",
    "unsafe_version", "document", "protocol", "coordinate", "occurrence",
    "extra_root", "extra_scope", "extra_recovery", "extra_expected", "extra_identity", "extra_command",
  ] as const)("rejects changed %s instead of restoring an unverified command", async kind => {
    const raw = structuredClone(fixtures().recovery);
    const recovery = raw.recovery;
    if (kind === "actor") raw.actorId++;
    if (kind === "patient") raw.scope.patientId++;
    if (kind === "ortho_case") raw.scope.orthoCaseId++;
    if (kind === "clinical_case") raw.scope.clinicalCaseId++;
    if (kind === "expected_actor") recovery.expected.actorId++;
    if (kind === "expected_scope") recovery.expected.scope.patientId++;
    if (kind === "hash") recovery.identity.requestFingerprint = "b".repeat(64);
    if (kind === "command_id") recovery.identity.commandId = 'synthetic_unmatched_command_001';
    if (kind === "command") recovery.expected.command.reason = 'SYNTHETIC SUBMISSION-CONTRACT REASON 3';
    if (kind === "version") recovery.expected.previousVersion = 1;
    if (kind === "negative_version") recovery.expected.previousVersion = -1;
    if (kind === "fractional_version") recovery.expected.previousVersion = 0.5;
    if (kind === "unsafe_version") recovery.expected.previousVersion = Number.MAX_SAFE_INTEGER + 1;
    if (kind === "document") recovery.expected.command.documentId = SYN.document + 101;
    if (kind === "protocol") Object.assign(recovery.expected.command.content, { protocol: "unversioned" });
    if (kind === "coordinate") recovery.expected.command.content.landmarks.tr = { state: "located", x: Infinity, y: 0.5 };
    if (kind === "occurrence") recovery.expected.command.content.occurrence.occurredOn = '2001-02-29';
    if (kind === "extra_root") Object.assign(raw, { extra: true });
    if (kind === "extra_scope") Object.assign(raw.scope, { extra: true });
    if (kind === "extra_recovery") Object.assign(recovery, { extra: true });
    if (kind === "extra_expected") Object.assign(recovery.expected, { extra: true });
    if (kind === "extra_identity") Object.assign(recovery.identity, { extra: true });
    if (kind === "extra_command") Object.assign(recovery.expected.command, { extra: true });
    await expect(verifyFacialSubmissionRecovery(raw, scope, actorId)).rejects.toThrow();
  });

  it("rejects clinical payloads and contradictory cancellation flags in metadata-only states", async () => {
    const f = fixtures();
    for (const recovery of [
      { state: "blocked", identity: null, canCancel: false, expected: f.expected },
      { state: "blocked", identity: null, canCancel: true },
      { state: "blocked", identity: f.identity, canCancel: false },
      { state: "cancelled", identity: f.identity, expected: f.expected },
      { state: "unknown", identity: f.identity },
    ]) await expect(verifyFacialSubmissionRecovery({ ok: true, scope, actorId, recovery }, scope, actorId)).rejects.toThrow();
  });

  it("rejects invalid expected actor and scope even for absent recovery", async () => {
    await expect(verifyFacialSubmissionRecovery({ ok: true, scope, actorId: 0, recovery: null }, scope, 0)).rejects.toThrow();
    const invalidScope = { ...scope, patientId: 0 };
    await expect(verifyFacialSubmissionRecovery({ ok: true, scope: invalidScope, actorId, recovery: null }, invalidScope, actorId)).rejects.toThrow();
  });
});

describe("pure facial command acknowledgment receipt", () => {
  it("checks committed state, actor, scope and exact command fingerprint", async () => {
    const f = fixtures();
    await expect(verifyFacialSubmissionAcknowledgment(f.acknowledgment, scope, actorId, f.expected.command)).resolves.toBe(true);
    for (const raw of [
      { ...f.acknowledgment, actorId: SYN.actor + 101 },
      { ...f.acknowledgment, scope: { ...scope, clinicalCaseId: SYN.clinicalCase + 101 } },
      { ...f.acknowledgment, scope: { ...scope, extra: true } },
      { ...f.acknowledgment, state: "cancelled" },
      { ...f.acknowledgment, acknowledged: false },
      { ...f.acknowledgment, extra: true },
      { ...f.acknowledgment, identity: { ...f.identity, commandId: 'synthetic_unmatched_command_001' } },
      { ...f.acknowledgment, identity: { ...f.identity, requestFingerprint: "b".repeat(64) } },
    ]) await expect(verifyFacialSubmissionAcknowledgment(raw, scope, actorId, f.expected.command)).resolves.toBe(false);
    await expect(verifyFacialSubmissionAcknowledgment(f.acknowledgment, scope, actorId, { ...f.expected.command, reason: 'SYNTHETIC SUBMISSION-CONTRACT REASON 4' })).resolves.toBe(false);
  });

  it("refuses malformed identity rather than silently completing acknowledgment", async () => {
    const f = fixtures();
    await expect(verifyFacialSubmissionAcknowledgment({ ...f.acknowledgment, identity: { ...f.identity, extra: true } }, scope, actorId, f.expected.command)).rejects.toThrow();
  });
});
