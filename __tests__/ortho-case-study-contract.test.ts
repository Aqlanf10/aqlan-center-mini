import { describe, expect, it } from "vitest";
import { CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
import { checkStudySaveCommand, type StudySaveCommand } from "../lib/ortho-case-study";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { checkRetentionEventCommand } from "../lib/ortho-retention-events";
import { studyPgPositiveInteger } from "../lib/ortho-case-study-pg-values";
const command = (): StudySaveCommand => ({ schemaVersion: 1, clientRequestId: "synthetic_study_0001", expectedHead: null,
  baseDocumentedRevision: null, kind: "draft", documentedFrom: null, reason: "Explicit draft",
  content: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: "a".repeat(64) },
    identityDisclosure: "case_only", sources: [], groups: [], mediaUses: [], comment: "",
    panels: [{ instanceId: "interview1", layoutKey: "interview", included: true, state: "not_recorded", sourceKeys: [], images: [], comment: "" }] } });
describe("new persisted study source contracts", () => {
  it("accepts exact safe PostgreSQL int8 text without numeric coercion", () => {
    expect(studyPgPositiveInteger("1048576")).toBe(1048576);
    expect(studyPgPositiveInteger(12)).toBe(12);
    expect(studyPgPositiveInteger("2147483648")).toBe(2147483648);
    expect(studyPgPositiveInteger("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    for (const bad of [[12], "01", "1.0", "1e3", "9007199254740992", 0, null]) expect(() => studyPgPositiveInteger(bad)).toThrow();
  });
  it("admits an explicit empty draft without an export capability or invented findings", () => {
    const value = command(); expect(checkStudySaveCommand(value)).toEqual({ ok: true, value });
    expect(value.content.sources).toEqual([]);
  });
  it("requires an exact draft head for documentary copy", () => {
    const value = command(); value.kind = "documented";
    expect(checkStudySaveCommand(value).ok).toBe(false);
    value.expectedHead = { id: 2, contentHash: "b".repeat(64) }; value.documentedFrom = { ...value.expectedHead };
    expect(checkStudySaveCommand(value).ok).toBe(true);
    value.documentedFrom.id = 3; expect(checkStudySaveCommand(value).ok).toBe(false);
  });
  it("rejects coerced modes and unknown authority fields", () => {
    expect(checkStudySaveCommand({ ...command(), kind: ["draft"] }).ok).toBe(false);
    expect(checkStudySaveCommand({ ...command(), actorId: 1 }).ok).toBe(false);
  });
  it("canonicalizes object keys while preserving authored array order", () => {
    expect(journeyContentHash({ b: 2, a: 1 })).toBe(journeyContentHash({ a: 1, b: 2 }));
    expect(journeyContentHash([1, 2])).not.toBe(journeyContentHash([2, 1]));
    expect(journeyContentHash(-0)).toBe(journeyContentHash(0));
    expect(() => journeyContentHash({ x: undefined })).toThrow();
  });
  it("records unknown retention dates and refuses fabricated lab association", () => {
    const value = { schemaVersion: 1, clientRequestId: "synthetic_device_0001", expectedHeadId: null, reason: "Historical documentation",
      arch: "upper", supersedesEntryId: null, archCorrectionReason: null,
      content: { kind: "device_delivery", occurrence: { occurredOn: null, dateProvenance: "unknown", sourceNote: "Date not available" },
        note: "", documentIds: [], deviceType: "removable", description: "Recorded device", extent: "upper arch", labOrderId: null } };
    expect(checkRetentionEventCommand(value).ok).toBe(true);
    expect(checkRetentionEventCommand({ ...value, content: { ...value.content, labOrderId: 4 } }).ok).toBe(false);
    expect(checkRetentionEventCommand({ ...value, content: { ...value.content, occurrence: { ...value.content.occurrence, occurredOn: "2026-10-11" } } }).ok).toBe(false);
  });
});
