import { describe, expect, it } from "vitest";
import { projectRetentionRecall } from "../lib/ortho-retention-recall";
import { classifyFollowups, type FollowupCase } from "../lib/ortho-followup";
import { row } from "./fixtures/ortho-retention-ui";
import type { RetentionEvent } from "../lib/ortho-retention-events";
const recall = (dueOn: string | null): RetentionEvent => ({ kind: "followup_intent", device: null, dueOn, intervalDays: dueOn ? null : 90,
  occurrence: { occurredOn: null, dateProvenance: "unknown", sourceNote: "Synthetic unknown date" }, scope: "upper arch", note: "", documentIds: [] });
describe("documented retention recall", () => {
  it("uses the latest instruction per arch and the earliest due arch", () => {
    const events = [row(10, 1, recall("2026-11-10")), row(20, 2, recall("2026-12-10")), row(30, 3, recall("2026-11-20"), { arch: "lower" })];
    expect(projectRetentionRecall(events)).toEqual({ state: "recorded", dueDate: "2026-11-20" });
  });
  it("does not anchor an interval to an unknown event date or an old adjustment", () => {
    expect(projectRetentionRecall([row(10, 1, recall(null))])).toEqual({ state: "recorded", dueDate: null });
    expect(projectRetentionRecall([])).toEqual({ state: "not_recorded", dueDate: null });
    const value: FollowupCase = { caseId: 1, patientId: 1, patientName: "Synthetic", patientPhone: null, status: "retention", phase: "retention", startDate: "2020-01-01", lastAdjustmentDate: "2020-06-01", nextWeeks: 4, upperWire: null, lowerWire: null, nextAppointment: null, lastWasNoShow: false };
    expect(classifyFollowups({ cases: [value], today: "2026-11-03" })[0]).toMatchObject({ dueDate: null, buckets: ["no_appointment", "retention"] });
  });
  it("preserves a distinction between an empty and an invalid history", () => {
    expect(projectRetentionRecall([{ wrong: true }])).toEqual({ state: "invalid", dueDate: null });
  });
});
