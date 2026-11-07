import { describe, expect, it } from "vitest";
import { classifyFollowups, groupByBucket, type FollowupCase } from "../lib/ortho-followup";
import { projectFollowupBookings, type ProjectedFollowupBooking } from "../lib/ortho-followup-board";

const TODAY = "2026-10-06";
const row = (changes: Partial<FollowupCase> = {}): FollowupCase => ({
  caseId: 41, patientId: 10, patientName: "Synthetic retention", patientPhone: null,
  status: "retention", phase: "retention", startDate: "2025-01-01",
  lastAdjustmentDate: "2025-02-01", nextWeeks: 4, upperWire: null, lowerWire: null,
  nextAppointment: null, lastWasNoShow: false,
  bookingContext: { verified: true, pastUnresolvedAppointment: null, reviewAppointments: [], otherAppointments: [] },
  ...changes,
});
const classify = (cases: FollowupCase[]) => classifyFollowups({ cases, today: TODAY });
const appointment = (changes: Partial<ProjectedFollowupBooking> = {}): ProjectedFollowupBooking => ({
  id: 71, patientId: 10, scheduledDate: "2026-10-10", scheduledTime: "10:30", status: "booked",
  appointmentType: "follow_up", serviceId: null, service: null, referralId: null, referral: null,
  plannedVisitId: null, plannedVisit: null, serviceName: null, doctorName: null, ...changes,
});
const project = (bookings: ProjectedFollowupBooking[]) => projectFollowupBookings({
  target: { patientId: 10, orthoCaseId: 41, clinicalCaseId: 51, startDate: "2025-01-01" },
  today: TODAY, appointments: bookings,
});

// V2R297 / O20: unknown clinician-set retention recall is not an adjustment interval.
// Saved-study retention events are documentary evidence, not an operational schedule.
describe("retention recall truth in the read-only follow-up projection", () => {
  it.each([
    ["retention", "retention"], ["retention", "finishing"], ["active", "retention"],
  ] as const)("uses explicit retention status or phase without rewriting %s / %s", (status, phase) => {
    const input = row({ status, phase });
    const before = structuredClone(input);
    const [result] = classify([input]);
    expect(result).toMatchObject({ status, phase, dueDate: null, daysSinceLast: null, dueBasis: "retention_schedule_unavailable" });
    expect(result.buckets).toEqual(["no_appointment", "retention"]);
    expect(input).toEqual(before);
    expect(result.lastAdjustmentDate).toBe(input.lastAdjustmentDate);
    expect(result.bookingContext).toBe(input.bookingContext);
  });

  it.each(["2025-02-01", "2026-10-06", null])("does not infer recall or lapse from adjustment %s or the treatment start", (lastAdjustmentDate) => {
    for (const nextWeeks of [1, 4, 52]) {
      const [result] = classify([row({ lastAdjustmentDate, nextWeeks })]);
      expect(result).toMatchObject({ dueDate: null, daysSinceLast: null, dueBasis: "retention_schedule_unavailable" });
      expect(result.buckets).toEqual(["no_appointment", "retention"]);
    }
  });

  it.each([
    ["2026-10-06", "booked", "today"], ["2026-10-06", "arrived", "today"],
    ["2026-10-07", "booked", "tomorrow"], ["2026-10-10", "arrived", "this_week"],
    ["2026-10-20", "booked", "upcoming"], ["2026-10-01", "booked", "overdue"],
    ["2026-10-01", "arrived", "overdue"],
  ])("keeps actual %s %s booking evidence in %s without making it recall or completed care", (scheduledDate, status, bucket) => {
    const projected = project([appointment({ scheduledDate, status })]);
    const input = row({ ...projected, lastWasNoShow: true });
    const before = structuredClone(input);
    const [result] = classify([input]);
    expect(result).toMatchObject({ dueDate: null, daysSinceLast: null, dueBasis: "retention_schedule_unavailable", status: "retention" });
    expect(result.buckets).toEqual([bucket, "no_show", "retention"]);
    expect(result.nextAppointment).toEqual(projected.nextAppointment);
    expect(result.bookingContext).toEqual(projected.bookingContext);
    expect(input).toEqual(before);
  });

  it("keeps other and uncertain bookings visible without promoting either into retention recall", () => {
    const projected = project([
      appointment({ id: 72, appointmentType: "cleaning" }),
      appointment({ id: 73, appointmentType: null }),
      appointment({ id: 74, patientId: 20 }),
    ]);
    const [result] = classify([row(projected)]);
    expect(result.buckets).toEqual(["no_appointment", "retention"]);
    expect(result.dueDate).toBeNull();
    expect(result.nextAppointment).toBeNull();
    expect(result.bookingContext?.otherAppointments.map(a => a.id)).toEqual([72]);
    expect(result.bookingContext?.reviewAppointments.map(a => a.id)).toEqual([73]);
    expect(JSON.stringify(result)).not.toContain('"id":74');
  });

  it("uses a real future booking over an unresolved past booking but preserves both without inferring recall", () => {
    const projected = project([appointment({ id: 75, scheduledDate: "2026-10-01" }), appointment()]);
    const [result] = classify([row(projected)]);
    expect(result.buckets).toEqual(["this_week", "retention"]);
    expect(result.nextAppointment?.id).toBe(71);
    expect(result.bookingContext?.pastUnresolvedAppointment?.id).toBe(75);
    expect(result.dueDate).toBeNull();
    expect(result.daysSinceLast).toBeNull();
  });

  it.each([
    [27, null], [28, "lapsed_4"], [29, "lapsed_4"], [41, "lapsed_4"],
    [42, "lapsed_6"], [43, "lapsed_6"], [55, "lapsed_6"], [56, "lapsed_8"], [57, "lapsed_8"],
  ] as const)("preserves active-treatment exact %s-day adjustment boundaries", (days, bucket) => {
    const lastAdjustmentDate = new Date(Date.parse(`${TODAY}T12:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
    const dueDate = new Date(Date.parse(`${lastAdjustmentDate}T12:00:00Z`) + 28 * 86400000).toISOString().slice(0, 10);
    const input = row({ status: "active", phase: "finishing", lastAdjustmentDate });
    const [result] = classify([input]);
    expect(result).toMatchObject({ dueDate, daysSinceLast: days });
    expect(result.buckets).toEqual(bucket ? ["no_appointment", bucket] : ["no_appointment"]);
  });

  it("preserves active-treatment start fallback, nextWeeks and booking/no-show classifications", () => {
    const [result] = classify([row({ status: "active", phase: "working", lastAdjustmentDate: null,
      startDate: "2026-09-01", nextWeeks: 6, lastWasNoShow: true,
      nextAppointment: { id: 77, date: TODAY, time: "09:00", status: "arrived" },
    })]);
    expect(result).toMatchObject({ dueDate: "2026-10-13", daysSinceLast: 35 });
    expect(result.buckets).toEqual(["today", "no_show", "lapsed_4"]);
  });

  it("keeps retention ordering neutral to adjustment age and uses deterministic cohorts while preserving active age order", () => {
    const input = [
      row({ caseId: 44, lastAdjustmentDate: "2024-01-01" }),
      row({ caseId: 12, status: "active", phase: "working", lastAdjustmentDate: "2026-09-01" }),
      row({ caseId: 42, lastAdjustmentDate: "2026-10-01" }),
      row({ caseId: 11, status: "active", phase: "working", lastAdjustmentDate: "2026-08-01" }),
    ];
    const original = structuredClone(input);
    const classified = classify(input);
    const classifiedBefore = structuredClone(classified);
    const groups = groupByBucket(classified);
    expect(groups.get("retention")?.map(r => r.caseId)).toEqual([42, 44]);
    expect(groups.get("no_appointment")?.map(r => r.caseId)).toEqual([11, 12, 42, 44]);
    expect(input).toEqual(original);
    expect(classified).toEqual(classifiedBefore);
    // Reversing/rotating unordered DB input must not change the display order.
    for (const variant of [input.slice().reverse(), [...input.slice(1), input[0]], [input[2], input[0], input[3], input[1]]]) {
      expect(groupByBucket(classify(variant)).get("no_appointment")?.map(r => r.caseId)).toEqual([11, 12, 42, 44]);
    }
  });

  it.each(["this_week", "overdue"] as const)("orders retention %s by actual booking date/time instead of old adjustment", (bucket) => {
    const dates = bucket === "this_week" ? ["2026-10-10", "2026-10-08"] : ["2026-10-03", "2026-10-01"];
    const rows = [
      row({ caseId: 41, lastAdjustmentDate: "2020-01-01", ...project([appointment({ scheduledDate: dates[0], scheduledTime: "09:00" })]) }),
      row({ caseId: 43, lastAdjustmentDate: "2026-09-01", ...project([appointment({ scheduledDate: dates[1], scheduledTime: "11:00" })]) }),
      row({ caseId: 42, lastAdjustmentDate: null, ...project([appointment({ scheduledDate: dates[1], scheduledTime: "10:00" })]) }),
    ];
    expect(groupByBucket(classify(rows)).get(bucket)?.map(r => r.caseId)).toEqual([42, 43, 41]);
  });
});
