import { describe, expect, it } from "vitest";
import { projectRetentionEventHistory, type RetentionEventRecord } from "../lib/ortho-retention-event-history";
import { projectRetentionRecall } from "../lib/ortho-retention-recall";
import { checkRetentionEventCommand, readRetentionEvent } from "../lib/ortho-retention-events";
const occurrence = (date: string | null) => ({ occurredOn: date, dateProvenance: date === null ? "unknown" as const : "historical_source" as const, sourceNote: "" });
const row = (id = 1, version = id): RetentionEventRecord => ({ id, version, arch: "upper", supersedesEntryId: null, archCorrectionReason: null,
  content: { kind: "followup_intent", occurrence: occurrence("2026-01-01"), note: "", documentIds: [], device: null, scope: "Retention review", dueOn: "2026-02-01", intervalDays: null } });
function intent(overrides: object = {}, id = 1): RetentionEventRecord {
  const value = row(id); return { ...value, content: { ...value.content, ...overrides } as typeof value.content };
}
const delivery = (): RetentionEventRecord => ({ ...row(), content: { kind: "device_delivery", occurrence: occurrence("2026-01-01"), note: "", documentIds: [], deviceType: "fixed", description: "Fixture", extent: "upper", labOrderId: null } });
describe("strict retention reconstruction boundary", () => {
  it.each([null, {}, [null], [undefined], new Array(1), [row(), row()], [row(1, 2)], [row(1, 1), row(2, 3)], Array(5001).fill(row())])("rejects malformed or non-contiguous history %#", raw => {
    expect(projectRetentionEventHistory(raw).ok).toBe(false);
    expect(projectRetentionRecall(raw).state).toBe("invalid");
  });
  it("rejects malicious prototypes, symbols, accessors, extra keys and sparse document arrays", () => {
    const getter = row(); let called = false;
    Object.defineProperty(getter, "content", { enumerable: true, get() { called = true; return row().content; } });
    const malicious = [getter, Object.assign(Object.create({ x: 1 }), row()), { ...row(), extra: true },
      { ...row(), [Symbol("hidden")]: true }, { ...row(), content: { ...row().content, documentIds: new Array(1) } },
      JSON.parse(JSON.stringify(row()).replace('"note":""', '"note":"","__proto__":{}'))];
    for (const raw of malicious) expect(projectRetentionEventHistory([raw]).ok).toBe(false);
    expect(called).toBe(false);
    const sparse = new Array(1); Array.prototype[0] = row();
    try { expect(projectRetentionEventHistory(sparse).ok).toBe(false); } finally { delete Array.prototype[0]; }
  });
  it("hardens direct event and command boundaries too", () => {
    expect(() => readRetentionEvent({ ...row().content, documentIds: new Array(1) })).toThrow();
    const raw = { schemaVersion: 1, clientRequestId: "fixture_command1", expectedHeadId: null, reason: "fixture", arch: "upper", supersedesEntryId: null, archCorrectionReason: null, content: row().content };
    expect(checkRetentionEventCommand(raw).ok).toBe(true);
    expect(checkRetentionEventCommand(Object.assign(Object.create({}), raw)).ok).toBe(false);
  });
  it("clones all accepted content and handles documentary ordering independently of IDs", () => {
    const source = delivery(); source.id = 20;
    const next = intent({ device: { deviceId: 20, expectedDeviceRevisionId: 20 }, documentIds: [7] }, 2);
    const result = projectRetentionEventHistory([next, source]); expect(result.ok).toBe(true); if (!result.ok) return;
    source.content.note = "mutated"; next.content.documentIds.push(9);
    expect(result.value.devices[0].delivery.note).toBe("");
    expect(result.value.currentEvents[1].content.documentIds).toEqual([7]);
  });
  it("rejects correction forks, future references, type changes, retargeting and stale witnesses", () => {
    const corrected = { ...row(2), supersedesEntryId: 1 };
    expect(projectRetentionEventHistory([row(), corrected, { ...row(3), supersedesEntryId: 1 }]).ok).toBe(false);
    expect(projectRetentionEventHistory([{ ...row(), supersedesEntryId: 2 }, row(2)]).ok).toBe(false);
    expect(projectRetentionEventHistory([delivery(), { ...row(2), supersedesEntryId: 1 }]).ok).toBe(false);
    const first = intent({ device: { deviceId: 1, expectedDeviceRevisionId: 1 } }, 2);
    expect(projectRetentionEventHistory([delivery(), first, { ...row(3), supersedesEntryId: 2 }]).ok).toBe(false);
    expect(projectRetentionEventHistory([delivery(), first, intent({ device: { deviceId: 1, expectedDeviceRevisionId: 1 } }, 3)]).ok).toBe(false);
  });
  it("requires an exact arch correction reason and flags retained dependent arch facts", () => {
    const first = intent({ device: { deviceId: 1, expectedDeviceRevisionId: 1 } }, 2);
    const corrected = { ...delivery(), id: 3, version: 3, supersedesEntryId: 1, arch: "lower" as const };
    expect(projectRetentionEventHistory([delivery(), first, corrected]).ok).toBe(false);
    const history = [delivery(), first, { ...corrected, archCorrectionReason: "Documentary correction" }];
    const result = projectRetentionEventHistory(history); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.devices[0].ambiguityReasons).toContain("dependent_event_arch_mismatch");
    const recall = projectRetentionRecall(history);
    expect(recall.state).toBe("ambiguous");
    expect(recall.intents[0]).toMatchObject({ dueOn: "2026-02-01", dueDate: null });
    expect(recall.intents[0].ambiguityReasons).toContain("device_arch_changed");
  });
});
describe("documentary recall, never automatic scheduling", () => {
  it("does not derive recall from delivery", () => { expect(projectRetentionRecall([delivery()])).toEqual({ state: "not_recorded", dueDate: null, intents: [] }); });
  it("resolves explicit dates and anchored intervals including leap years", () => {
    expect(projectRetentionRecall([row()]).dueDate).toBe("2026-02-01");
    expect(projectRetentionRecall([intent({ dueOn: null, intervalDays: 1, occurrence: occurrence("2024-02-28") })]).dueDate).toBe("2024-02-29");
    expect(projectRetentionRecall([intent({ intervalDays: 31 })]).state).toBe("recorded");
  });
  it.each([
    { dueOn: null, intervalDays: 1, occurrence: occurrence(null) },
    { dueOn: "2026-02-01", intervalDays: 1, occurrence: occurrence(null) },
    { intervalDays: 2 },
    { dueOn: "2025-12-31" },
    { dueOn: null, intervalDays: 1, occurrence: occurrence("9999-12-31") },
  ])("preserves unresolved/conflicting timing %#", patch => {
    const result = projectRetentionRecall([intent(patch)]); expect(result.state).toBe("ambiguous"); expect(result.dueDate).toBeNull(); expect(result.intents[0].ambiguityReasons.length).toBeGreaterThan(0);
  });
  it("retains explicit and derived timing evidence even when contradictory", () => {
    const result = projectRetentionRecall([intent({ intervalDays: 2 })]);
    expect(result.intents[0]).toMatchObject({ dueOn: "2026-02-01", intervalDays: 2, intervalDueDate: "2026-01-03", occurrence: occurrence("2026-01-01"), dueDate: null });
    const missing = projectRetentionRecall([intent({ intervalDays: 2, occurrence: occurrence(null) })]);
    expect(missing.intents[0]).toMatchObject({ dueOn: "2026-02-01", intervalDays: 2, intervalDueDate: null, occurrence: occurrence(null), dueDate: null });
  });
  it.each(["removed", "lost", "not_in_use"] as const)("retains recall after %s without declaring it actionable", status => {
    const first = intent({ device: { deviceId: 1, expectedDeviceRevisionId: 1 } }, 2);
    const change = { ...row(3), content: { kind: "device_status_change", occurrence: occurrence("2026-01-02"), note: "", documentIds: [], device: { deviceId: 1, expectedDeviceRevisionId: 2 }, status } };
    const result = projectRetentionRecall([delivery(), first, change]);
    expect(result.state).toBe("ambiguous"); expect(result.intents[0]).toMatchObject({ dueOn: "2026-02-01", dueDate: null });
    expect(result.intents[0].ambiguityReasons).toContain("device_state_requires_reconciliation");
  });
  it("withholds an ambiguous device date but preserves independent intent and timing evidence", () => {
    const first = intent({ device: { deviceId: 1, expectedDeviceRevisionId: 1 }, intervalDays: 31 }, 2);
    const change: RetentionEventRecord = { ...row(3), content: { kind: "device_status_change", occurrence: occurrence(null), note: "", documentIds: [], device: { deviceId: 1, expectedDeviceRevisionId: 2 }, status: "in_use" } };
    const independent = { ...row(4), arch: "lower" as const };
    const result = projectRetentionRecall([delivery(), first, change, independent]);
    expect(result.state).toBe("ambiguous"); expect(result.dueDate).toBeNull();
    expect(result.intents[0]).toMatchObject({ eventId: 2, dueOn: "2026-02-01", intervalDays: 31, intervalDueDate: "2026-02-01", dueDate: null, occurrence: occurrence("2026-01-01") });
    expect(result.intents[0].ambiguityReasons).toContain("device_state_requires_reconciliation");
    expect(result.intents[1]).toMatchObject({ eventId: 4, dueOn: "2026-02-01", dueDate: "2026-02-01", ambiguityReasons: [] });
  });
  it("never hides an unknown intent behind another resolved arch", () => {
    const unknown = { ...intent({ dueOn: null, intervalDays: 30, occurrence: occurrence(null) }, 2), arch: "lower" as const };
    const result = projectRetentionRecall([row(), unknown]); expect(result.state).toBe("ambiguous"); expect(result.dueDate).toBeNull(); expect(result.intents).toHaveLength(2);
  });
  it.each(["2025-12-01", "2026-01-01", "2026-03-01", null])("does not treat authored/clinical recency as cancellation (%s)", date => {
    const later = intent({ occurrence: occurrence(date), dueOn: "2026-04-01", scope: "Different free-text scope" }, 2);
    const result = projectRetentionRecall([row(), later]); expect(result.state).toBe("ambiguous"); expect(result.intents).toHaveLength(2);
    expect(result.intents.every(i => i.dueDate === null)).toBe(true);
    expect(result.intents.map(i => i.dueOn)).toEqual(["2026-02-01", "2026-04-01"]);
  });
  it("uses explicit correction, preserving clinical corrected date rather than write time", () => {
    const correction = { ...intent({ dueOn: "2026-01-15", occurrence: occurrence("2025-12-01") }, 2), supersedesEntryId: 1 };
    const result = projectRetentionRecall([row(), correction]); expect(result.state).toBe("recorded"); expect(result.dueDate).toBe("2026-01-15"); expect(result.intents.map(i => i.eventId)).toEqual([2]);
  });
  it("returns earliest date only for fully resolved independent arches/devices", () => {
    const lower = { ...intent({ dueOn: "2026-01-15" }, 2), arch: "lower" as const };
    expect(projectRetentionRecall([row(), lower]).dueDate).toBe("2026-01-15");
    const second = { ...delivery(), id: 2, version: 2 };
    const intents = [intent({ device: { deviceId: 1, expectedDeviceRevisionId: 1 } }, 3), intent({ device: { deviceId: 2, expectedDeviceRevisionId: 2 }, dueOn: "2026-03-01" }, 4)];
    expect(projectRetentionRecall([delivery(), second, ...intents]).state).toBe("recorded");
    expect(projectRetentionRecall([delivery(), second, ...intents, row(5)]).state).toBe("ambiguous");
  });
  it("keeps earlier device recall after replacement without declaring discharge", () => {
    const first = intent({ device: { deviceId: 1, expectedDeviceRevisionId: 1 } }, 2);
    const replacement = { ...delivery(), id: 3, version: 3, content: { ...delivery().content, kind: "device_replacement", replaces: { deviceId: 1, expectedDeviceRevisionId: 2 } } };
    const result = projectRetentionRecall([delivery(), first, replacement]); expect(result.state).toBe("ambiguous"); expect(result.intents[0].eventId).toBe(2);
    expect(result.intents[0]).toMatchObject({ dueOn: "2026-02-01", dueDate: null });
    expect(result.intents[0].ambiguityReasons).toContain("device_replaced_requires_reconciliation");
  });
});
