import { describe, expect, it } from "vitest";
import { parseFollowupCommand, followupFingerprintInput } from "../lib/appointment-followup-contract";

const input = { appointmentId: 1, expectedPatientId: 7, sourceCreatedAt: "1700000000.123456", generation: "a".repeat(32),
  requestId: "synthetic-followup-request", expectedRevision: 0, assigneeUserId: 2,
  dueAt: "2030-01-01T00:00:00.000Z", status: "open", outcome: "pending", nextStep: "call" };
describe("bounded patient-free followup contract", () => {
  it("retains full source precision and stable canonical fingerprint order", () => {
    const command = parseFollowupCommand(input)!;
    expect(command.sourceCreatedAt).toBe("1700000000.123456");
    expect(followupFingerprintInput(parseFollowupCommand(Object.fromEntries(Object.entries(input).reverse()))!))
      .toBe(followupFingerprintInput(command));
    expect(followupFingerprintInput(parseFollowupCommand({ ...input, requestId: input.requestId + "-retry" })!))
      .toBe(followupFingerprintInput(command));
  });
  it.each([
    { patientName: "Synthetic only" }, { phone: "synthetic" }, { note: "synthetic" }, { appointmentId: "1" },
    { expectedPatientId: undefined }, { expectedPatientId: "7" }, { expectedPatientId: 0 },
    { sourceCreatedAt: "1700000000.123" }, { generation: "" }, { expectedRevision: -1 }, { expectedRevision: 2147483647 },
    { assigneeUserId: 0 }, { dueAt: "2030-02-30T00:00:00.000Z" }, { dueAt: "2030-01-01T00:00:00" },
    { outcome: "whatsapp_sent" }, { outcome: "rebooked" }, { status: "closed", outcome: "pending", nextStep: "none" },
    { status: "open", outcome: "resolved" }, { status: "open", nextStep: "none" }, { outcome: "no_answer" },
  ])("rejects invalid creation %j", edit => expect(parseFollowupCommand({ ...input, ...edit })).toBeNull());
  it.each(["no_answer", "awaiting_reply"])("%s remains open with a next step", outcome => {
    const value = { ...input, expectedRevision: 1, outcome };
    expect(parseFollowupCommand(value)).not.toBeNull();
    expect(parseFollowupCommand({ ...value, status: "closed", nextStep: "none" })).toBeNull();
  });
  it("binds the displayed patient witness into the request fingerprint", () => {
    expect(followupFingerprintInput(parseFollowupCommand({ ...input, expectedPatientId: 8 })!))
      .not.toBe(followupFingerprintInput(parseFollowupCommand(input)!));
  });
  it("keeps rebooking pending review; never accepts an arbitrary replacement ID", () => {
    const value = { ...input, expectedRevision: 1, outcome: "rebooking_review", nextStep: "review" };
    expect(parseFollowupCommand(value)).not.toBeNull();
    expect(parseFollowupCommand({ ...value, replacementAppointmentId: 9 })).toBeNull();
    expect(parseFollowupCommand({ ...value, status: "closed", nextStep: "none" })).toBeNull();
  });
  it.each(["resolved", "declined"])("requires explicit %s for closure", outcome => {
    expect(parseFollowupCommand({ ...input, expectedRevision: 1, outcome, status: "closed", nextStep: "none" })).not.toBeNull();
  });
});
