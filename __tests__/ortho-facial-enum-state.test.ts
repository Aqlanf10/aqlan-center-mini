import { describe, expect, it } from "vitest";
import { syntheticFace } from "./fixtures/ortho-facial-analysis";
import { readFacialCommand, type FacialCommand } from "../lib/ortho-facial-analysis";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { verifyFacialSubmissionRecovery } from "../lib/ortho-facial-submission-contract";
// Independently authored test roles; not identifiers, dates or notes from a patient record.
const SYN = {
  patient: 21001, orthoCase: 22001, clinicalCase: 23001, actor: 24001,
  document: 25001, revisionBase: 26000, submission: 27001,
  timestamp: '2001-02-03T04:05:06.000Z',
};


const scope = { patientId: SYN.patient, orthoCaseId: SYN.orthoCase, clinicalCaseId: SYN.clinicalCase };
const actorId = SYN.actor;

function command(): FacialCommand {
  const content = syntheticFace();
  content.quality = { frontalRest: true, headPosition: true, visibleLandmarks: true, perspectiveReviewed: true, note: "" };
  content.review.note = 'SYNTHETIC ENUM-STATE NOTE 1';
  return { schemaVersion: 1, clientRequestId: 'synthetic_facial_enum_state_001', documentId: SYN.document, expectedHeadId: null, reason: 'SYNTHETIC ENUM-STATE REASON 1', content };
}

/** Only ordinary JSON inputs are used, never custom valueOf/toString methods. */
function throughJSON(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("facial review state requires a primitive string", () => {
  it.each(["draft", "reviewed"] as const)("retains accepted primitive %s", state => {
    const c = command();
    c.content.review.state = state;
    expect(readFacialCommand(throughJSON(c))).toEqual(c);
  });

  it.each([
    { label: "draft array", state: ["draft"] },
    { label: "reviewed array", state: ["reviewed"] },
    { label: "nested draft array", state: [["draft"]] },
    { label: "value object", state: { value: "draft" } },
    { label: "empty object", state: {} },
    { label: "empty array", state: [] },
    { label: "null", state: null },
    { label: "boolean", state: true },
    { label: "number", state: 1 },
    { label: "unknown string", state: "completed" },
  ])("refuses $label rather than coercing it to an allowed enum", ({ state }) => {
    const c = command();
    expect(readFacialCommand(throughJSON(c))).toEqual(c);
    const raw = { ...c, content: { ...c.content, review: { ...c.content.review, state } } };
    expect(() => readFacialCommand(throughJSON(raw))).toThrow("invalid_facial_analysis");
  });
});

describe("facial recovered submission state requires a primitive string", () => {
  function recovery(state: unknown) {
    const c = command();
    return {
      ok: true,
      scope,
      actorId,
      recovery: {
        state,
        identity: { id: SYN.submission, commandId: c.clientRequestId, requestFingerprint: journeyContentHash(c) },
        expected: { scope, actorId, previousVersion: 0, command: c },
      },
    };
  }

  it.each(["pending", "committed"] as const)("retains accepted primitive %s", async state => {
    const raw = recovery(state);
    await expect(verifyFacialSubmissionRecovery(throughJSON(raw), scope, actorId)).resolves.toEqual(raw);
  });

  it.each([
    { label: "pending array", state: ["pending"] },
    { label: "committed array", state: ["committed"] },
    { label: "nested pending array", state: [["pending"]] },
    { label: "value object", state: { value: "pending" } },
    { label: "empty object", state: {} },
    { label: "empty array", state: [] },
    { label: "null", state: null },
    { label: "boolean", state: true },
    { label: "number", state: 1 },
    { label: "unknown string", state: "completed" },
  ])("refuses $label rather than restoring a malformed state", async ({ state }) => {
    const valid = recovery("pending");
    await expect(verifyFacialSubmissionRecovery(throughJSON(valid), scope, actorId)).resolves.toEqual(valid);
    await expect(verifyFacialSubmissionRecovery(throughJSON(recovery(state)), scope, actorId)).rejects.toThrow("invalid_facial_submission_recovery");
  });
});
