import { describe, expect, it } from "vitest";
import type { AppointmentReadScope } from "../lib/appointment-read-scope";
import {
  isConfirmedUnscheduled, projectWorkflowPlannedAppointment, workflowAppointmentEmptyText, workflowCalendar,
} from "../lib/patient-workflow-calendar";

const scoped: AppointmentReadScope = { kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set() };
const clinical = { id: 21, planId: 31, planTitle: "Clinical plan", title: "Clinical visit", sequence: 2,
  doctorId: 7, doctorName: "Assigned clinician", durationMinutes: 45, status: "scheduled",
  visitId: 41, note: "Clinical note", createdAt: "2026-10-03T08:00:00Z" };
const planned = { ...clinical, appointmentId: 991, appointmentDate: "2026-11-12", appointmentTime: "15:47" };
const reference = { id: 991, patientId: 91, doctorId: 8 };
const nextAppointment = { id: 992, date: "2026-11-13", time: "16:48", note: "CALENDAR_ONLY" };

describe("workflow planned calendar projection", () => {
  it("uses the appointment's actual provider rather than the clinical assignment", () => {
    const result = projectWorkflowPlannedAppointment(planned, 91, scoped, reference);
    expect(result).toEqual({ ...clinical, appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "scoped" });
    expect(JSON.stringify(result)).not.toMatch(/991|2026-11-12|15:47/);
    expect(planned.appointmentId).toBe(991);
  });
  it.each([null, 0, 7])("retains a readable actual provider %s", (doctorId) => {
    expect(projectWorkflowPlannedAppointment(planned, 91, scoped, { ...reference, doctorId }))
      .toEqual({ ...planned, appointmentVisibility: "scoped" });
  });
  it.each([
    { kind: "all" }, { kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set([91]) },
  ] as AppointmentReadScope[])("retains the existing full patient-calendar scope %o", (scope) => {
    expect(projectWorkflowPlannedAppointment(planned, 91, scope, reference)).toEqual({ ...planned, appointmentVisibility: "all" });
  });
  it.each([null, { ...reference, id: 993 }, { ...reference, patientId: 92 }])("fails closed on inconsistent joined identity %o even for all readers", (joined) => {
    const result = projectWorkflowPlannedAppointment(planned, 91, { kind: "all" }, joined);
    expect(result).toEqual({ ...clinical, appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "unknown" });
    expect(isConfirmedUnscheduled({ ...result, status: "planned" })).toBe(false);
  });
  it("does not disclose unassigned appointment metadata to a no-calendar reader", () => {
    expect(projectWorkflowPlannedAppointment(planned, 91, { kind: "none" }, { ...reference, doctorId: null }))
      .toEqual({ ...clinical, appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "hidden" });
  });
  it.each(["planned", "scheduled", "in_progress"])("preserves clinical status %s and all plan/visit identities when withholding", (status) => {
    expect(projectWorkflowPlannedAppointment({ ...planned, status }, 91, scoped, reference))
      .toMatchObject({ ...clinical, status, appointmentId: null });
  });
});

describe("workflow calendar client authority", () => {
  it.each([undefined, null, false, "invalid", "hidden"])("withholds stale values under %s top-level state", (appointmentVisibility) => {
    const result = workflowCalendar({ appointmentVisibility, nextAppointment,
      plannedVisits: [{ ...planned, appointmentVisibility: "all" as const }] });
    expect(result.nextAppointment).toBeNull();
    expect(result.plannedVisits[0]).toMatchObject({ ...clinical, appointmentId: null, appointmentDate: null, appointmentTime: null });
    expect(JSON.stringify(result)).not.toMatch(/991|992|2026-11|15:47|16:48|CALENDAR_ONLY/);
  });
  it.each([undefined, "hidden", "unknown"] as const)("does not restore nested stale values from %s row metadata under all reads", (appointmentVisibility) => {
    const row = workflowCalendar({ appointmentVisibility: "all", nextAppointment: null,
      plannedVisits: [{ ...planned, appointmentVisibility }] }).plannedVisits[0];
    expect(row.appointmentDate).toBeNull(); expect(row.appointmentId).toBeNull();
    expect(isConfirmedUnscheduled({ ...row, status: "planned" })).toBe(false);
  });
  it("never classifies a scoped null reference as unbooked or offers scheduling", () => {
    const absent = { ...clinical, status: "planned", appointmentId: null, appointmentDate: null, appointmentTime: null };
    const full = projectWorkflowPlannedAppointment(absent, 91, { kind: "all" }, null);
    const subset = projectWorkflowPlannedAppointment(absent, 91, scoped, null);
    expect(isConfirmedUnscheduled(full)).toBe(true); expect(isConfirmedUnscheduled(subset)).toBe(false);
    expect(isConfirmedUnscheduled({ ...full, status: "scheduled" })).toBe(false);
    expect(isConfirmedUnscheduled({ ...full, appointmentId: undefined })).toBe(false);
  });
  it("does not promote a nested all flag above the parent scoped projection", () => {
    const result = workflowCalendar({ appointmentVisibility: "scoped", nextAppointment,
      plannedVisits: [{ ...planned, appointmentVisibility: "all" as const }] });
    expect(result.nextAppointment).toEqual(nextAppointment);
    expect(result.plannedVisits[0]).toEqual({ ...planned, appointmentVisibility: "scoped" });
  });
  it.each(["scoped", "hidden", "unknown"] as const)("uses qualified empty copy for %s", (state) => {
    expect(workflowAppointmentEmptyText(state)).not.toContain("لا يوجد موعد");
  });
});


describe("malformed calendar shape", () => {
  it.each([undefined, {}, { id: 991, date: "2026-11-12" }, { id: 991, date: null, time: "15:47" }])("does not invent an absent next appointment from %o", (nextAppointment) => {
    const result = workflowCalendar({ appointmentVisibility: "all", nextAppointment, plannedVisits: [] });
    expect(result.appointmentVisibility).toBe("unknown"); expect(result.nextAppointment).toBeNull();
    expect(workflowAppointmentEmptyText(result.appointmentVisibility)).not.toContain("لا يوجد موعد");
  });
  it.each([{ appointmentId: undefined }, { appointmentDate: null }, { appointmentTime: null }])("clears the entire nested reference when one linked field is malformed: %o", (change) => {
    const result = workflowCalendar({ appointmentVisibility: "all", nextAppointment: null,
      plannedVisits: [{ ...planned, ...change, appointmentVisibility: "all" as const }] }).plannedVisits[0];
    expect(result).toMatchObject({ appointmentVisibility: "unknown", appointmentId: null, appointmentDate: null, appointmentTime: null });
    expect(isConfirmedUnscheduled({ ...result, status: "planned" })).toBe(false);
  });
});
