import { expect, it } from "vitest";
import { isCanonicalOrthoFollowups, type CanonicalOrthoFollowups } from "../lib/canonical-ortho-followup-projection";
const valid = (): CanonicalOrthoFollowups => ({ projection: "ortho-followups", appointmentCoverage: "none", today: "2026-11-01", hasMore: false,
  rows: [{ caseId: 1, patientId: 2, patientName: "مريض اصطناعي", status: "active", phase: "aligning", startDate: "2026-01-01", lastAdjustmentDate: null,
    nextWeeks: 4, dueDate: "2026-01-29", daysSinceLast: 304, buckets: ["lapsed_8"], schedule: null }] });
it("accepts a bounded clinical-only projection without asserting absent bookings", () => expect(isCanonicalOrthoFollowups(valid())).toBe(true));
it.each(["no_appointment", "today", "no_show"] as const)("rejects %s under no appointment authority", bucket => {
  const body = valid(); body.rows[0].buckets.push(bucket); expect(isCanonicalOrthoFollowups(body)).toBe(false);
});
it("own coverage cannot imply whole-patient absence", () => {
  const body = valid(); body.appointmentCoverage = "own"; body.rows[0].buckets.push("no_appointment");
  body.rows[0].schedule = { nextAppointment: null, pastUnresolvedAppointment: null, reviewAppointments: [], otherAppointments: [], hasRecordedNoShow: false };
  expect(isCanonicalOrthoFollowups(body)).toBe(false); body.rows[0].buckets = []; expect(isCanonicalOrthoFollowups(body)).toBe(true);
});
it("rejects rich legacy board or a wrong projection", () => {
  expect(isCanonicalOrthoFollowups({ today: "2026-11-01", buckets: [] })).toBe(false);
  expect(isCanonicalOrthoFollowups({ ...valid(), projection: "case-summary" })).toBe(false);
});
it.each([0, -1, NaN, 1.5])("rejects unsafe case identity %s", id => { const body = valid(); body.rows[0].caseId = id; expect(isCanonicalOrthoFollowups(body)).toBe(false); });
it("rejects duplicate cases and invalid calendar dates", () => {
  const body = valid(); body.rows.push({ ...body.rows[0] }); expect(isCanonicalOrthoFollowups(body)).toBe(false);
  const badDate = valid(); badDate.rows[0].startDate = "2026-02-30"; expect(isCanonicalOrthoFollowups(badDate)).toBe(false);
});
it("rejects malformed schedule details instead of rendering partial data", () => {
  const body = valid(); body.appointmentCoverage = "all";
  body.rows[0].schedule = { nextAppointment: { id: 3, date: "2026-11-01", time: "10:00", status: "booked", serviceName: "متابعة", doctorName: null, appointmentType: "follow_up", matchBasis: "legacy_type", reason: "service_less_legacy" }, pastUnresolvedAppointment: null, otherAppointments: [], reviewAppointments: [], hasRecordedNoShow: false };
  expect(isCanonicalOrthoFollowups(body)).toBe(true); body.rows[0].schedule.nextAppointment!.date = "invalid"; expect(isCanonicalOrthoFollowups(body)).toBe(false);
});
