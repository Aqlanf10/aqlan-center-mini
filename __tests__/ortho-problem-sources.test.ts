import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readProblemSourceCommand, problemSourceIdentity, type ProblemSourceCommand } from "../lib/ortho-problem-sources";
import { ORTHO_PROBLEM_SOURCES_SQL } from "../lib/ortho-problem-sources-schema";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { verifyProblemSourceReceipt, readProblemSourceRead } from "../lib/ortho-problem-source-client";
const command: ProblemSourceCommand = { schemaVersion: 1, commandId: "synthetic_problem_source_1", source: { kind: "assessment_observation", id: 2, member: "clinical_toothFindings", version: `sha256:${"a".repeat(64)}` },
  expectedReviewId: null, action: "create", problemId: null, label: "Synthetic clinician-reviewed finding", reason: "Synthetic review", clinicianReviewed: true };
describe("explicit source-to-problem review contract", () => {
  it("keeps clinical review mandatory and separates existing links from new labels", () => {
    expect(readProblemSourceCommand(command)).toEqual(command);
    for (const value of [{ ...command, clinicianReviewed: false }, { ...command, label: " " }, { ...command, patientId: 2 },
      { ...command, action: "link", problemId: 3 }, { ...command, source: { ...command.source, version: "latest" } }, { ...command, expectedReviewId: 0 }]) expect(readProblemSourceCommand(value)).toBeNull();
    expect(readProblemSourceCommand({ ...command, action: "link", problemId: 3, label: null })).not.toBeNull();
    expect(problemSourceIdentity(command.source)).toBe(problemSourceIdentity({ ...command.source, id: 9, version: `sha256:${"b".repeat(64)}` }));
    expect(problemSourceIdentity({ kind: "ceph_diagnosis", id: 3, member: "final_dx", version: command.source.version })).not.toBe(problemSourceIdentity({ kind: "ceph_diagnosis", id: 4, member: "final_dx", version: command.source.version }));
  });
  it("verifies the exact command receipt and refuses foreign or malformed readbacks", async () => {
    const scope = { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3, actorId: 4 };
    const receipt = { ...scope, ok: true, commandId: command.commandId, requestFingerprint: journeyContentHash(command), reviewId: 5, problemId: 6,
      sourceIdentity: problemSourceIdentity(command.source), sourceVersion: command.source.version, replayed: false };
    expect(await verifyProblemSourceReceipt(receipt, scope, command, 201)).toEqual(receipt);
    for (const bad of [{ ...receipt, actorId: 8 }, { ...receipt, sourceVersion: `sha256:${"b".repeat(64)}` }, { ...receipt, requestFingerprint: "a".repeat(64) }, { ...receipt, replayed: true }])
      await expect(verifyProblemSourceReceipt(bad, scope, command, 201)).rejects.toThrow();
    expect(() => readProblemSourceRead({ ok: true, ...scope, candidates: [], reviews: [], problems: null, writable: true }, scope)).toThrow();
  });
  it("pins the additive migration to the runtime mirror without a historical backfill", () => {
    expect(readFileSync("migrations/0117_ortho_problem_sources.sql", "utf8")).toBe(ORTHO_PROBLEM_SOURCES_SQL);
    expect(ORTHO_PROBLEM_SOURCES_SQL).not.toMatch(/INSERT INTO patient_problems|UPDATE patient_problems|DELETE FROM/i);
  });
});
