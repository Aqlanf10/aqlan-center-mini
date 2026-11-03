import { describe, expect, it } from "vitest";
import { readRetentionTransitionCommand, readRetentionTransitionRead, type RetentionTransitionCommand } from "../lib/ortho-retention-transition";
import { verifyRetentionTransitionSaved } from "../lib/ortho-retention-transition-client";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
const command: RetentionTransitionCommand = { schemaVersion: 1, clientRequestId: "synthetic-transition-1", expectedPhase: "finishing", confirmed: true,
  reason: "Synthetic decision", retentionPlan: "Review plan entered by clinician", occurrence: { occurredOn: null, dateProvenance: "unknown", sourceNote: "Original date unavailable" } };
const record = { id: 1, patientId: 2, orthoCaseId: 3, clinicalCaseId: 4, recordedPatientId: 2, actorId: 5, createdBy: "Synthetic clinician", createdAt: "2026-11-03T00:00:00.000Z", command, requestFingerprint: journeyContentHash(command) };
describe("explicit retention decision contract", () => {
  it("keeps a missing historic date explicit and rejects ambiguous commands", () => {
    expect(readRetentionTransitionCommand(command)).toEqual(command);
    for (const invalid of [{ ...command, confirmed: false }, { ...command, ignored: true }, { ...command, retentionPlan: " " },
      { ...command, occurrence: { ...command.occurrence, sourceNote: " " } }, { ...command, occurrence: { ...command.occurrence, occurredOn: "2026-11-03" } },
      { ...command, occurrence: { ...command.occurrence, dateProvenance: "retrospective_record", occurredOn: "2026-02-30" } }]) expect(() => readRetentionTransitionCommand(invalid)).toThrow();
  });
  it("projects only the public scope and rejects inconsistent state", () => {
    const read = { ok: true, patientId: 2, orthoCaseId: 3, clinicalCaseId: 4, status: "retention", phase: "retention", canTransition: false, transition: record };
    expect(readRetentionTransitionRead(read, { ...record })).toEqual(read);
    expect(() => readRetentionTransitionRead({ ...read, canTransition: true }, record)).toThrow();
    expect(() => readRetentionTransitionRead({ ...read, patientId: 99 }, record)).toThrow();
  });
  it("checks actor, scope, exact command and fingerprint before accepting a receipt", async () => {
    const expected = { patientId: 2, orthoCaseId: 3, clinicalCaseId: 4, actorId: 5, command };
    await expect(verifyRetentionTransitionSaved({ ok: true, replayed: false, transition: record }, expected, 201)).resolves.toEqual(record);
    await expect(verifyRetentionTransitionSaved({ ok: true, replayed: true, transition: record }, expected, 200)).resolves.toEqual(record);
    for (const bad of [{ ...record, clinicalCaseId: 6 }, { ...record, actorId: 6 }, { ...record, patientId: 6 }, { ...record, requestFingerprint: "a".repeat(64) }, { ...record, command: { ...command, reason: "Other" } }])
      await expect(verifyRetentionTransitionSaved({ ok: true, replayed: false, transition: bad }, expected, 201)).rejects.toThrow();
    await expect(verifyRetentionTransitionSaved({ ok: true, replayed: false, transition: record }, expected, 200)).rejects.toThrow();
  });
});
