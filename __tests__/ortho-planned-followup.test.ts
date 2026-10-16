import { describe, expect, it } from "vitest";
import { classifyFollowupBooking, type FollowupBookingFacts, type FollowupTarget } from "../lib/ortho-followup-booking-context";
import { projectFollowupBookings } from "../lib/ortho-followup-board";
import type { PlannedFollowupFacts, PlannedFollowupSessionFacts } from "../lib/ortho-planned-followup";

const target: FollowupTarget = { patientId: 10, orthoCaseId: 41, clinicalCaseId: 51, startDate: "2026-01-01" };
const session = (change: Partial<PlannedFollowupSessionFacts> = {}): PlannedFollowupSessionFacts => ({
  id: 81, plannedVisitId: 61, status: "planned", visitId: null,
  itemId: 71, itemPlanId: 31, itemStatus: "in_progress", itemCategory: "ortho",
  clinicalCaseId: 51, casePatientId: 10, caseSpecialty: "orthodontics", caseStatus: "active",
  orthoCaseId: 41, orthoPatientId: 10, ...change,
});
const planned = (change: Partial<PlannedFollowupFacts> = {}): PlannedFollowupFacts => ({
  id: 61, patientId: 10, planId: 31, planPatientId: 10, planStatus: "active",
  status: "scheduled", appointmentId: 101, visitId: null, visitPatientId: null,
  visitPlannedVisitId: null, visitSigned: null, sessions: [session()], ...change,
});
const booking = (change: Partial<FollowupBookingFacts> = {}): FollowupBookingFacts => ({
  id: 101, patientId: 10, scheduledDate: "2026-10-20", scheduledTime: "10:30", status: "booked",
  serviceId: 7, service: { id: 7, code: "ORTHO_FOLLOW_UP", specialty: "orthodontics", legacyType: "follow_up" },
  appointmentType: "follow_up", referralId: null, referral: null,
  plannedVisitId: 61, plannedVisit: planned(), ...change,
});
const classify = (change: Partial<FollowupBookingFacts> = {}) => classifyFollowupBooking(target, booking(change));

describe("exact existing planned case sessions", () => {
  it("accepts periodic purpose plus an exact pending session/item/case chain with distinct identifiers", () => {
    expect(classify()).toEqual({ classification: "identified_followup", reason: "planned_periodic_case_sessions", basis: "planned_case_sessions" });
    expect(classify({ plannedVisit: planned({ sessions: [session(), session({ id: 82, itemId: 72 })] }) }).classification).toBe("identified_followup");
  });
  it("accepts an already arrived open planned visit, without claiming any work is complete", () => {
    expect(classify({ status: "arrived", plannedVisit: planned({ status: "in_progress", visitId: 91,
      visitPatientId: 10, visitPlannedVisitId: 61, visitSigned: false,
      sessions: [session({ status: "in_progress", visitId: 91 })] }) }).basis).toBe("planned_case_sessions");
  });
  it("keeps service-less legacy periodic purpose, but never invents it from the plan or title", () => {
    expect(classify({ serviceId: null, service: null }).basis).toBe("planned_case_sessions");
    expect(classify({ serviceId: null, service: null, appointmentType: null }).reason).toBe("untyped_legacy");
    expect(classify({ serviceId: null, service: null, appointmentType: "consultation" }).classification).toBe("other");
  });
  it("does not let exact links override another explicit appointment service", () => {
    expect(classify({ service: { id: 7, code: "ORTHO_START", specialty: "orthodontics", legacyType: null } }).classification).toBe("needs_review");
    expect(classify({ service: { id: 7, code: "ROOT_CANAL", specialty: "endodontics", legacyType: "endo" } }).classification).toBe("needs_review");
  });
  it("projects only the classification, never raw plan/case/session records or amounts", () => {
    const raw = { ...booking(), serviceName: "Synthetic periodic booking", doctorName: "Synthetic doctor",
      secretPlanAmount: 123456, foreignPatientName: "never echo" };
    const result = projectFollowupBookings({ target, today: "2026-10-16", appointments: [raw] });
    expect(result.nextAppointment).toMatchObject({ id: 101, matchBasis: "planned_case_sessions" });
    const json = JSON.stringify(result);
    for (const field of ["plannedVisit", "planId", "itemId", "clinicalCaseId", "secretPlanAmount", "foreignPatientName"]) expect(json).not.toContain(field);
  });
});

describe("unresolved or contradictory planned records stay visible for review", () => {
  it.each([
    { id: 62 }, { patientId: 11 }, { appointmentId: 102 }, { appointmentId: null },
    { planId: null }, { planId: 32 }, { planPatientId: 11 }, { planPatientId: null },
    { planStatus: "cancelled" }, { planStatus: "completed" }, { status: "planned" },
    { status: "completed" }, { status: "cancelled" }, { sessions: [] },
    { sessions: [session(), session()] }, { sessions: [session(), session({ id: 82, clinicalCaseId: 52, orthoCaseId: 42 })] },
    { status: "in_progress", visitId: 91, visitPatientId: 11, visitPlannedVisitId: 61, visitSigned: false },
    { status: "in_progress", visitId: 91, visitPatientId: 10, visitPlannedVisitId: 62, visitSigned: false },
    { status: "in_progress", visitId: 91, visitPatientId: 10, visitPlannedVisitId: 61, visitSigned: true },
  ] satisfies Partial<PlannedFollowupFacts>[])("reviews inconsistent planned record %#", change => {
    expect(classify({ plannedVisit: planned(change) }).classification).toBe("needs_review");
  });
  it.each([
    { id: 0 }, { plannedVisitId: 62 }, { itemId: null }, { itemPlanId: 32 }, { itemStatus: "cancelled" },
    { itemStatus: "done" }, { status: "done" }, { status: "skipped" }, { itemCategory: "endo" },
    { clinicalCaseId: 52 }, { clinicalCaseId: null }, { casePatientId: 11 }, { caseSpecialty: "endodontics" },
    { caseStatus: "completed" }, { orthoCaseId: 42 }, { orthoPatientId: 11 }, { visitId: 91 },
  ] satisfies Partial<PlannedFollowupSessionFacts>[])("reviews inconsistent session/item/case %#", change => {
    expect(classify({ plannedVisit: planned({ sessions: [session(change)] }) }).classification).toBe("needs_review");
  });
  it("does not substitute an Ortho ID for a clinical ID or infer a missing clinical bridge", () => {
    expect(classify({ plannedVisit: planned({ sessions: [session({ clinicalCaseId: 41 })] }) }).classification).toBe("needs_review");
    expect(classifyFollowupBooking({ ...target, clinicalCaseId: null }, booking()).classification).toBe("needs_review");
  });
  it("preserves uncertainty from an older or contradictory projection", () => {
    expect(classify({ plannedVisit: undefined }).reason).toBe("planned_visit_requires_review");
    expect(classify({ plannedVisit: null }).reason).toBe("planned_visit_requires_review");
    expect(classify({ plannedVisitId: null }).reason).toBe("inconsistent_planned_visit");
  });
  it("never admits inherited or malformed facts or coerces an arbitrary status object", () => {
    const hostile = { toString() { throw Error("Must not coerce status"); } };
    for (const facts of [Object.create(planned()), [], { ...planned(), sessions: [null] },
      { ...planned(), sessions: [Object.create(session())] }, { ...planned(), status: hostile },
      { ...planned(), sessions: [{ ...session(), status: hostile }] }]) {
      expect(classify({ plannedVisit: facts as PlannedFollowupFacts }).classification).toBe("needs_review");
    }
  });
});
