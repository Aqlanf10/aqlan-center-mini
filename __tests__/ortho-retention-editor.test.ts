import { describe, expect, it } from "vitest";
import { chooseRetentionDevice, chooseRetentionKind, correctRetentionEvent, initialRetentionEditor, retentionDraftTargetIsCurrent, retentionEditorCommand, retentionIntervalDays } from "../lib/ortho-retention-editor";
import { delivery, occurrence, readFixture, row } from "./fixtures/ortho-retention-ui";
const requestId = "synthetic_retention_001";
function draft() { return { ...initialRetentionEditor(readFixture()), reason: "Synthetic documentary event" }; }
describe("explicit retention event drafting", () => {
  it("starts without inferred kind, arch, clinical date, device or wearing status", () => {
    const value = draft(); expect(value.kind).toBe(""); expect(value.arch).toBe(""); expect(value.device).toBeNull(); expect(value.status).toBe("");
    expect(value.occurrence).toEqual(occurrence); expect(Object.values(value.findings).every(v => v.state === "not_assessed")).toBe(true);
    expect(retentionEditorCommand(value, requestId)).toEqual({ ok: false, code: "retention_event_kind_required" });
  });
  it("creates a new delivery with no fabricated device ID, date or lab link", () => {
    const value = { ...chooseRetentionKind(draft(), "device_delivery"), arch: "upper" as const, deviceType: "fixed" as const, description: "fixed", extent: "13–23" };
    const checked = retentionEditorCommand(value, requestId); expect(checked.ok).toBe(true);
    if (!checked.ok) return; expect(checked.value.content).toEqual(delivery("fixed")); expect("deviceId" in checked.value.content).toBe(false);
    expect(checked.value.expectedHeadId).toBeNull(); expect(checked.value.content.occurrence.occurredOn).toBeNull();
  });
  it("freezes exact selected physical root and device head, not just arch", () => {
    const read = readFixture([row(101, 1, delivery("fixed")), row(102, 2, delivery("removable"))]);
    const value = chooseRetentionDevice(chooseRetentionKind({ ...initialRetentionEditor(read), reason: "review" }, "device_review"), read.devices[1]);
    expect(value.device).toEqual({ deviceId: 102, expectedDeviceRevisionId: 102 }); expect(value.arch).toBe("upper");
    expect(retentionEditorCommand(value, requestId).ok).toBe(true); expect(retentionDraftTargetIsCurrent(value, read)).toBe(true);
    const refreshed = structuredClone(read); refreshed.devices[1].lastEventId = 200;
    expect(retentionDraftTargetIsCurrent(value, refreshed)).toBe(false); expect(value.device?.expectedDeviceRevisionId).toBe(102);
  });
  it("requires recorded review findings to contain a description while preserving unknown/not-assessed", () => {
    const read = readFixture([row(101, 1, delivery())]);
    const value = chooseRetentionDevice(chooseRetentionKind({ ...initialRetentionEditor(read), reason: "review" }, "device_review"), read.devices[0]);
    value.findings.fit = { state: "recorded", note: "" }; expect(retentionEditorCommand(value, requestId).ok).toBe(false);
    value.findings.fit.note = "Clinician recorded fit"; value.findings.loss = { state: "unknown", note: "No reliable history" };
    const parsed = retentionEditorCommand(value, requestId); expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.content.kind === "device_review") expect(parsed.value.content.observations.adherence.state).toBe("not_assessed");
  });
  it("copies a correction's explicit facts and keeps its event kind and physical target", () => {
    const base = row(101, 1, delivery());
    const repair = row(102, 2, { kind: "device_repair", occurrence: { ...occurrence }, note: "old note", documentIds: [601], description: "repair", device: { deviceId: 101, expectedDeviceRevisionId: 101 } });
    const read = readFixture([base, repair]), value = correctRetentionEvent(read, 102);
    expect(value.supersedesEntryId).toBe(102); expect(value.documentIds).toEqual([601]); expect(value.device).toEqual({ deviceId: 101, expectedDeviceRevisionId: 102 });
    expect(chooseRetentionKind(value, "device_delivery")).toBe(value);
    expect(() => chooseRetentionDevice(value, { ...read.devices[0], deviceId: 999 })).toThrow("correction_retargets_device");
    expect(retentionEditorCommand({ ...value, reason: "correct repair", description: "corrected" }, requestId).ok).toBe(true);
    value.documentIds.push(602); expect(read.currentEvents[1].content.documentIds).toEqual([601]);
  });
  it("requires a specific arch correction reason and retains the original physical root", () => {
    const read = readFixture([row(101, 1, delivery())]), value = correctRetentionEvent(read, 101);
    value.reason = "correct source arch"; value.arch = "lower";
    expect(retentionEditorCommand(value, requestId).ok).toBe(false); value.archCorrectionReason = "Verified original record";
    const parsed = retentionEditorCommand(value, requestId); expect(parsed.ok).toBe(true);
    if (parsed.ok) { expect(parsed.value.supersedesEntryId).toBe(101); expect(parsed.value.arch).toBe("lower"); }
  });
  it("parses explicit Arabic/English day digits without guessing separators or creating a date", () => {
    for (const value of ["30", "٣٠", "۳۰"]) expect(retentionIntervalDays(value)).toBe(30);
    for (const value of ["0", "٠", " 30", "30 ", "3.0", "3٫0", "1e2", "3,000", "3651"]) expect(() => retentionIntervalDays(value)).toThrow("invalid_retention_interval");
    const value = { ...chooseRetentionKind(draft(), "followup_intent"), arch: "legacy_unknown" as const, intervalDays: "٣٠", followupScope: "review after return" };
    const parsed = retentionEditorCommand(value, requestId); expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.content.kind === "followup_intent") { expect(parsed.value.content.dueOn).toBeNull(); expect(parsed.value.content.intervalDays).toBe(30); expect(parsed.value.content.device).toBeNull(); }
  });
  it("requires a reason and exact head/version coherence and does not copy prior-kind fields", () => {
    const first = { ...draft(), kind: "device_delivery" as const, description: "old", deviceType: "fixed" as const, status: "lost" as const };
    const second = chooseRetentionKind(first, "device_review"); expect(second.description).toBe(""); expect(second.deviceType).toBe(""); expect(second.status).toBe("");
    const value = { ...draft(), kind: "debond" as const, arch: "upper" as const, extent: "upper", previousVersion: 1 };
    expect(retentionEditorCommand(value, requestId)).toEqual({ ok: false, code: "invalid_retention_draft_head" });
  });
});
