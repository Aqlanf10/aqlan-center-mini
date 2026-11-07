import { describe, expect, it } from "vitest";
import { projectRetentionEventHistory, type RetentionEventRecord } from "../lib/ortho-retention-event-history";
import type { RetentionEvent } from "../lib/ortho-retention-events";
const base = { occurrence: { occurredOn: null, dateProvenance: "unknown" as const, sourceNote: "Historical date unavailable" }, note: "", documentIds: [] };
function delivery(id: number, version: number, deviceType: "fixed" | "removable" = "fixed"): RetentionEventRecord {
  return { id, version, arch: "upper", supersedesEntryId: null, archCorrectionReason: null,
    content: { ...base, kind: "device_delivery", deviceType, description: "Explicit device", extent: "Upper arch", labOrderId: null } };
}
function replace(id: number, version: number, deviceId: number, expectedDeviceRevisionId: number): RetentionEventRecord {
  return { ...delivery(id, version, "removable"), content: { ...base, kind: "device_replacement", deviceType: "removable",
    description: "Explicit replacement", extent: "Upper arch", labOrderId: null, replaces: { deviceId, expectedDeviceRevisionId } } };
}
describe("documentary physical-device identity", () => {
  it("keeps concurrent fixed and removable devices on the same arch", () => {
    const result = projectRetentionEventHistory([delivery(1, 1), delivery(2, 2, "removable")]);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.devices.map(d => [d.deviceId, d.delivery.deviceType])).toEqual([[1, "fixed"], [2, "removable"]]);
    expect(result.value.devices.every(d => d.currentState === "ambiguous" && d.intervalStart === null)).toBe(true);
  });
  it("rejects competing physical replacements even when the latest documentary witness is known", () => {
    expect(projectRetentionEventHistory([delivery(1, 1), replace(2, 2, 1, 1), replace(3, 3, 1, 2)]))
      .toEqual({ ok: false, code: "device_already_replaced" });
  });
  it("permits replacing the newly delivered physical replacement", () => {
    const result = projectRetentionEventHistory([delivery(1, 1), replace(2, 2, 1, 1), replace(3, 3, 2, 2)]);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.devices.map(d => [d.deviceId, d.replacedDeviceId])).toEqual([[1, null], [2, 1], [3, 2]]);
  });
  it("corrects replacement facts without inventing a second device root", () => {
    const corrected = replace(3, 3, 1, 2); corrected.supersedesEntryId = 2; corrected.content.note = "Corrected documentary detail";
    const result = projectRetentionEventHistory([delivery(1, 1), replace(2, 2, 1, 1), corrected]);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.devices.map(d => d.deviceId)).toEqual([1, 2]);
    expect(result.value.devices.find(d => d.deviceId === 2)?.deliveryRevisionId).toBe(3);
  });
  it("refuses a stale device witness and a cross-arch replacement", () => {
    const stale = replace(3, 3, 2, 1);
    expect(projectRetentionEventHistory([delivery(1, 1), delivery(2, 2), stale])).toEqual({ ok: false, code: "device_reference_changed" });
    const otherArch = replace(2, 2, 1, 1); otherArch.arch = "lower";
    expect(projectRetentionEventHistory([delivery(1, 1), otherArch])).toEqual({ ok: false, code: "device_reference_changed" });
  });
  it("does not infer wearing, adherence or delivery date from a recorded delivery", () => {
    const dated = delivery(1, 1); dated.content.occurrence = { occurredOn: "2026-01-01", dateProvenance: "historical_source", sourceNote: "Explicit dated source" };
    const result = projectRetentionEventHistory([dated]); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.devices[0].currentState).toBe("unknown"); expect(result.value.devices[0].stateEventId).toBeNull();
  });
  it("marks same-day competing status timing ambiguous instead of sorting clinical events by row ID", () => {
    const dated = delivery(1, 1); dated.content.occurrence = { occurredOn: "2026-01-01", dateProvenance: "historical_source", sourceNote: "Explicit date" };
    const status = (id: number, expected: number, value: "in_use" | "removed"): RetentionEventRecord => ({ id, version: id, arch: "upper", supersedesEntryId: null, archCorrectionReason: null,
      content: { ...base, kind: "device_status_change", device: { deviceId: 1, expectedDeviceRevisionId: expected }, status: value,
        occurrence: { occurredOn: "2026-02-01", dateProvenance: "contemporaneous_record", sourceNote: "Explicit same date" } } satisfies RetentionEvent });
    const result = projectRetentionEventHistory([dated, status(2, 1, "in_use"), status(3, 2, "removed")]);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.devices[0].currentState).toBe("ambiguous"); expect(result.value.devices[0].ambiguityReasons).toContain("same_day_order_unknown");
  });
});
