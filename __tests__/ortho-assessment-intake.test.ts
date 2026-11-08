import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readOpenAssessmentCommand, readStartTreatmentCommand, verifyIntakeReceipt } from "../lib/ortho-assessment-intake";
import { canonicalJourneyJSON } from "../lib/ortho-case-journey-json";

const opened = { schemaVersion: 1 as const, clientRequestId: "synthetic_intake_command_01", reason: "Synthetic assessment" };
const started = { ...opened, confirmed: true, appliance: "fixed_metal", arches: "both", slot: "022", startDate: "2026-10-01", plannedMonths: 18, bracketSystem: "" };
describe("explicit assessment and treatment commands", () => {
  it("opens only a diagnostic identity without accepting implied treatment facts", () => {
    expect(readOpenAssessmentCommand(opened)).toEqual(opened);
    expect(() => readOpenAssessmentCommand({ ...opened, startDate: "2026-10-01" })).toThrow();
    expect(() => readOpenAssessmentCommand({ ...opened, reason: " " })).toThrow();
  });
  it.each([
    { confirmed: false }, { appliance: "" }, { arches: "" }, { slot: null },
    { startDate: "2026-02-30" }, { startDate: "" }, { plannedMonths: 0 },
    { plannedMonths: 1.5 }, { plannedMonths: "18" }, { unwanted: true },
    { appliance: "aligners", slot: "022" }, { appliance: "aligners", slot: null, bracketSystem: "MBT" },
  ])("refuses unknown or inconsistent treatment facts: %j", delta => {
    expect(() => readStartTreatmentCommand({ ...started, ...delta })).toThrow();
  });
  it("permits explicit fixed appliances and non-wire appliances without an invented slot", () => {
    expect(readStartTreatmentCommand(started)).toEqual(started);
    const aligners = { ...started, appliance: "aligners", slot: null };
    expect(readStartTreatmentCommand(aligners)).toEqual(aligners);
  });
  it("binds acknowledgment to patient, actor, exact command, operation and HTTP status", async () => {
    const receipt = { ok: true, patientId: 2, orthoCaseId: 3, clinicalCaseId: 4, actorId: 5,
      commandId: opened.clientRequestId, requestFingerprint: createHash("sha256").update(canonicalJourneyJSON(opened)).digest("hex"), mode: "created" };
    const expected = { patientId: 2, actorId: 5, command: opened };
    await expect(verifyIntakeReceipt(receipt, expected, 201)).resolves.toEqual(receipt);
    for (const delta of [{ patientId: 7 }, { actorId: 8 }, { mode: "started" }, { requestFingerprint: "0".repeat(64) }, { orthoCaseId: null }]) {
      await expect(verifyIntakeReceipt({ ...receipt, ...delta }, expected, 201)).rejects.toThrow();
    }
    await expect(verifyIntakeReceipt(receipt, expected, 200)).rejects.toThrow();
    await expect(verifyIntakeReceipt(receipt, { ...expected, command: { ...opened, reason: "Changed" } }, 201)).rejects.toThrow();
  });
});
