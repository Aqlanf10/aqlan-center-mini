import { describe, expect, it } from "vitest";
import {
  classifyFollowupBooking, selectFollowupBookings,
  type FollowupBookingFacts, type FollowupTarget,
} from "../lib/ortho-followup-booking-context";

const target: FollowupTarget = { patientId: 10, orthoCaseId: 41, clinicalCaseId: 51, startDate: "2026-01-01" };
const service = { id: 7, code: "ORTHO_FOLLOW_UP", specialty: "orthodontics", legacyType: "follow_up" };
const booking = (change: Partial<FollowupBookingFacts> = {}): FollowupBookingFacts => ({
  id: 101, patientId: 10, scheduledDate: "2026-10-08", scheduledTime: "10:30", status: "booked",
  appointmentType: "follow_up", serviceId: 7, service: { ...service }, referralId: null, referral: null,
  plannedVisitId: null, ...change,
});
const referral = { id: 61, patientId: 10, toSpecialty: "other", caseId: 51, casePatientId: 10, orthoCaseId: 41 };
const classify = (change: Partial<FollowupBookingFacts> = {}) => classifyFollowupBooking(target, booking(change));
const select = (appointments: readonly FollowupBookingFacts[], selected = target) =>
  selectFollowupBookings({ target: selected, today: "2026-10-05", appointments });

describe("periodic follow-up evidence", () => {
  it("accepts the designated service without claiming exact case or completed care", () => {
    expect(classify()).toEqual({ classification: "identified_followup", reason: "designated_periodic_service", basis: "designated_service" });
  });
  it("supports a custom Ortho service explicitly mapped to the legacy periodic type", () => {
    expect(classify({ service: { ...service, code: "CUSTOM_PERIODIC_REVIEW" } }).classification).toBe("identified_followup");
  });
  it("does not erase existing bookings for an inactive service", () => {
    const inactive = { ...service, isActive: false };
    expect(classify({ service: inactive }).classification).toBe("identified_followup");
  });
  it.each(["ORTHO_START", "ORTHO_DEBOND", "BRACKET_REBOND", "BRACKET_BONDING", "ORTHO_WIRE_CHANGE"])("reviews %s even when legacy follow_up misleadingly remains", (code) => {
    expect(classify({ service: { ...service, code } })).toMatchObject({ classification: "needs_review", reason: "other_ortho_service" });
  });
  it("does not use Ortho specialty alone for an unknown service purpose", () => {
    expect(classify({ service: { ...service, code: "CUSTOM_ORTHO", legacyType: null } }).classification).toBe("needs_review");
  });
  it("does not classify radiology Ortho records as a periodic follow-up", () => {
    expect(classify({ service: { ...service, code: "ORTHO_RECORDS", specialty: "radiology", legacyType: null }, appointmentType: null }).classification).toBe("other");
  });
  it.each(["endodontics", "consultation", "radiology", "other"])("does not let legacy follow_up override explicit %s service evidence", (specialty) => {
    expect(classify({ service: { ...service, specialty } })).toMatchObject({ classification: "needs_review", reason: "contrary_service_specialty" });
  });
  it("classifies an unambiguous unrelated service as other", () => {
    expect(classify({ appointmentType: "endo", service: { ...service, code: "ROOT_CANAL", specialty: "endodontics", legacyType: "endo" } }).classification).toBe("other");
  });
  it.each(["consultation", "other"])("reviews a periodic service with contradictory stored type %s", (appointmentType) => {
    expect(classify({ appointmentType }).classification).toBe("needs_review");
  });
  it("reviews contradictory legacy mapping on the designated service", () => {
    expect(classify({ service: { ...service, legacyType: "endo" } }).reason).toBe("conflicting_periodic_type");
  });
  it("supports genuinely service-less legacy follow_up", () => {
    expect(classify({ serviceId: null, service: null })).toEqual({ classification: "identified_followup", reason: "service_less_legacy", basis: "legacy_type" });
  });
  it.each([null, undefined, "other"])("keeps untyped legacy %s visible for review", (appointmentType) => {
    expect(classify({ serviceId: null, service: null, appointmentType }).classification).toBe("needs_review");
  });
  it("does not pretend an unresolved service FK is service-less", () => {
    expect(classify({ service: null }).reason).toBe("unresolved_service");
  });
  it("reviews missing relationship projections", () => {
    const row = booking(); delete (row as Partial<FollowupBookingFacts>).referralId;
    expect(classifyFollowupBooking(target, row).reason).toBe("missing_or_invalid_context");
  });
  it("ignores patient/doctor/master-plan resemblance as positive evidence", () => {
    const row = { ...booking({ serviceId: null, service: null, appointmentType: null }), doctorId: 8, planId: 9, note: "Ortho follow up" };
    expect(classifyFollowupBooking(target, row).classification).toBe("needs_review");
  });
  it("does not infer a planned visit's case from its plan", () => {
    expect(classify({ plannedVisitId: 99 }).reason).toBe("planned_visit_requires_review");
  });
});

describe("referral and patient boundaries", () => {
  it("preserves a designated appointment with consistent current-case linkage", () => {
    expect(classify({ referralId: 61, referral }).classification).toBe("identified_followup");
  });
  it("supports an explicit Ortho bridge when the target lacks a clinical bridge ID", () => {
    expect(classifyFollowupBooking({ ...target, clinicalCaseId: null }, booking({ referralId: 61, referral })).classification).toBe("identified_followup");
  });
  it.each([
    { ...referral, caseId: 52, orthoCaseId: 42 },
    { ...referral, caseId: 52 },
    { ...referral, orthoCaseId: 42 },
    { ...referral, patientId: 11 },
    { ...referral, casePatientId: 11 },
    { ...referral, toSpecialty: "endodontics" },
    { ...referral, caseId: null, casePatientId: null, orthoCaseId: null },
  ])("rejects explicit contrary or incomplete referral context %#", (facts) => {
    expect(classify({ referralId: 61, referral: facts }).classification).toBe("needs_review");
  });
  it("does not use a service-less legacy type to bypass contrary case evidence", () => {
    expect(classify({ serviceId: null, service: null, referralId: 61, referral: { ...referral, orthoCaseId: 42 } }).classification).toBe("needs_review");
  });
  it("reviews broken or inconsistent referral links", () => {
    expect(classify({ referralId: 61 }).reason).toBe("unresolved_referral");
    expect(classify({ referral }).reason).toBe("inconsistent_referral");
  });
  it("never selects another Ortho patient's booking", () => {
    const second = { patientId: 11, orthoCaseId: 42, clinicalCaseId: 52, startDate: "2026-01-01" };
    const rows = [booking({ id: 101 }), booking({ id: 102, patientId: 11, scheduledDate: "2026-10-06" })];
    expect(select(rows).nextAppointment?.appointment.id).toBe(101);
    expect(select(rows, second).nextAppointment?.appointment.id).toBe(102);
    expect(select(rows).reviewAppointments).toEqual([]);
  });
  it("reviews an old appointment preceding the current case", () => {
    expect(classify({ scheduledDate: "2025-12-31" }).reason).toBe("before_case_start");
  });
});

describe("malformed and inherited identifiers", () => {
  it.each(["constructor", "__proto__", "toString", "ORTHODONTICS", "unknown"])("does not admit unrecognized identifiers %s", (identifier) => {
    expect(classify({ appointmentType: identifier }).classification).toBe("needs_review");
    expect(classify({ service: { ...service, specialty: identifier } }).classification).toBe("needs_review");
    expect(classify({ service: { ...service, legacyType: identifier } }).classification).toBe("needs_review");
    expect(classify({ referralId: 61, referral: { ...referral, toSpecialty: identifier } }).classification).toBe("needs_review");
  });
  it("does not use inherited service classification or inherited booking IDs", () => {
    expect(classify({ service: Object.assign(Object.create(service), { id: 7 }) }).classification).toBe("needs_review");
    const row = Object.assign(Object.create({ id: 101 }), booking()); delete row.id;
    expect(classifyFollowupBooking(target, row).reason).toBe("invalid_identity");
  });
  it("rejects inherited referral case proof and target identity", () => {
    expect(classify({ referralId: 61, referral: Object.assign(Object.create(referral), { id: 61, patientId: 10 }) }).classification).toBe("needs_review");
    const inheritedTarget = Object.assign(Object.create(target), { patientId: 10 });
    expect(classifyFollowupBooking(inheritedTarget, booking()).reason).toBe("invalid_target");
    expect(() => select([], inheritedTarget)).toThrow(RangeError);
  });
  it("does not echo inherited status", () => {
    const row = Object.assign(Object.create({ status: "arrived" }), booking()); delete row.status;
    const result = select([row]);
    expect(result.nextAppointment).toBeNull();
    expect(result.reviewAppointments[0].appointment.status).toBe("unknown");
  });
  it("does not accept an inherited legacy type", () => {
    const row = Object.assign(Object.create({ appointmentType: "follow_up" }), booking({ serviceId: null, service: null }));
    delete row.appointmentType;
    expect(classifyFollowupBooking(target, row).reason).toBe("untyped_legacy");
  });
  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "7"])("reviews invalid service identifier %s", (value) => {
    expect(classify({ serviceId: value as number }).classification).toBe("needs_review");
  });
  it.each(["2026-02-30", "2026-13-01", "constructor"])("rejects invalid appointment dates %s", (scheduledDate) => {
    expect(classify({ scheduledDate }).classification).toBe("excluded");
  });
  it.each(["24:00", "9:30", "10:61", "__proto__"])("rejects invalid appointment times %s", (scheduledTime) => {
    expect(classify({ scheduledTime }).classification).toBe("excluded");
  });
});

describe("deterministic read selection", () => {
  it("selects later relevant booking instead of earlier unrelated booking", () => {
    const unrelated = booking({ id: 102, scheduledDate: "2026-10-06", appointmentType: "consultation", service: { ...service, code: "CONSULTATION", specialty: "consultation", legacyType: "consultation" } });
    const result = select([unrelated, booking()]);
    expect(result.nextAppointment?.appointment.id).toBe(101);
    expect(result.otherAppointments.map((r) => r.appointment.id)).toEqual([102]);
  });
  it("does not lose existing appointments when no follow-up is identified", () => {
    const result = select([booking({ serviceId: null, service: null, appointmentType: null })]);
    expect(result.nextAppointment).toBeNull();
    expect(result.reviewAppointments[0].appointment).toEqual({ id: 101, patientId: 10, scheduledDate: "2026-10-08", scheduledTime: "10:30", status: "booked" });
  });
  it("orders by date, time and ID regardless of input order", () => {
    const rows = [booking({ id: 9, scheduledTime: "11:00" }), booking({ id: 8 }), booking({ id: 7 }), booking({ id: 6, scheduledDate: "2026-10-09" })];
    expect(select(rows).nextAppointment?.appointment.id).toBe(7);
    expect(select([...rows].reverse()).nextAppointment?.appointment.id).toBe(7);
  });
  it("keeps nearest future and latest past unresolved appointments separate", () => {
    const result = select([booking({ id: 1, scheduledDate: "2026-10-02" }), booking({ id: 2, scheduledDate: "2026-10-04" }), booking()]);
    expect(result.nextAppointment?.appointment.id).toBe(101);
    expect(result.pastUnresolvedAppointment?.appointment.id).toBe(2);
    expect(select([booking({ scheduledDate: "2026-10-04" })]).nextAppointment).toBeNull();
  });
  it("breaks past appointment ties by time then ID", () => {
    const result = select([booking({ id: 1, scheduledDate: "2026-10-04", scheduledTime: "10:00" }),
      booking({ id: 2, scheduledDate: "2026-10-04" }), booking({ id: 3, scheduledDate: "2026-10-04" })]);
    expect(result.pastUnresolvedAppointment?.appointment.id).toBe(3);
  });
  it.each(["done", "cancelled", "no_show"])("does not use %s as a future booking", (status) => {
    expect(select([booking({ status })])).toEqual({ nextAppointment: null, pastUnresolvedAppointment: null, reviewAppointments: [], otherAppointments: [] });
  });
  it("preserves arrived status instead of manufacturing booked or an arrival", () => {
    const result = select([booking({ scheduledDate: "2026-10-05", status: "arrived" })]);
    expect(result.nextAppointment?.appointment.status).toBe("arrived");
    expect(classify({ status: "waiting" }).classification).toBe("needs_review");
  });
  it("does not use or echo calculated due dates and does not mutate its inputs", () => {
    const row = Object.freeze({ ...booking(), dueDate: "2027-01-01", doctorId: 8, planId: 9 });
    Object.freeze(row.service);
    const rows = Object.freeze([row]);
    const before = JSON.stringify(rows);
    const result = select(rows);
    expect(result.nextAppointment?.appointment.scheduledDate).toBe("2026-10-08");
    expect(result.nextAppointment?.appointment).not.toHaveProperty("dueDate");
    expect(JSON.stringify(rows)).toBe(before);
  });
  it("requires a real clinic-date boundary", () => {
    expect(() => selectFollowupBookings({ target, today: "2026-02-30", appointments: [] })).toThrow(RangeError);
  });
});
