import { describe, expect, it } from "vitest";
import { patientPlanCalendar, patientPlanAppointmentEmptyText } from "../lib/patient-plan-calendar";
import { isConfirmedUnscheduled, projectWorkflowPlannedAppointment } from "../lib/patient-workflow-calendar";

const clinical = { id: 21, title: "Clinical planned visit", planId: 31, visitId: 41, status: "planned" };
const linked = { ...clinical, appointmentId: 991, appointmentDate: "2026-11-12", appointmentTime: "15:47", appointmentVisibility: "all" as const };
const absent = { ...clinical, appointmentId: null, appointmentDate: null, appointmentTime: null };

describe("patient-plan calendar certainty", () => {
  it.each([undefined, null, false, "bad", "unknown", "hidden"])("withholds stale fields under %s top-level metadata", (appointmentVisibility) => {
    const result = patientPlanCalendar({ appointmentVisibility, plannedVisits: [linked] });
    expect(result.plannedVisits[0]).toMatchObject({ ...clinical, appointmentId: null, appointmentDate: null, appointmentTime: null });
    expect(JSON.stringify(result)).not.toMatch(/991|2026-11-12|15:47/);
    expect(patientPlanAppointmentEmptyText(result.plannedVisits[0])).not.toContain("لم يُحدد موعد");
    expect(linked.appointmentId).toBe(991);
  });
  it.each([undefined, "unknown", "hidden"] as const)("honors %s row metadata under an all-calendar parent", (appointmentVisibility) => {
    const row = patientPlanCalendar({ appointmentVisibility: "all", plannedVisits: [{ ...linked, appointmentVisibility }] }).plannedVisits[0];
    expect(row.appointmentId).toBeNull(); expect(row.appointmentDate).toBeNull(); expect(row.appointmentTime).toBeNull();
    expect(isConfirmedUnscheduled(row)).toBe(false);
  });
  it.each(["all", "scoped"] as const)("retains valid linked fields under %s without adding writer grants", (appointmentVisibility) => {
    const result = patientPlanCalendar({ appointmentVisibility, plannedVisits: [linked] });
    expect(result.plannedVisits[0]).toEqual({ ...linked, appointmentVisibility });
    expect(Object.keys(result).sort()).toEqual(["appointmentVisibility", "plannedVisits"]);
    expect(isConfirmedUnscheduled(result.plannedVisits[0])).toBe(false);
  });
  it.each([{ appointmentId: undefined }, { appointmentDate: null }, { appointmentTime: null }])("withholds all fields for partial linked shape %o", (change) => {
    const row = patientPlanCalendar({ appointmentVisibility: "all", plannedVisits: [{ ...linked, ...change }] }).plannedVisits[0];
    expect(row).toMatchObject({ appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "unknown" });
    expect(patientPlanAppointmentEmptyText(row)).toContain("غير مؤكدة");
  });
  it("does not promote a scoped null to unscheduled or downgrade clinical status", () => {
    for (const status of ["planned", "scheduled", "in_progress"]) {
      const row = patientPlanCalendar({ appointmentVisibility: "scoped", plannedVisits: [{ ...absent, status, appointmentVisibility: "all" as const }] }).plannedVisits[0];
      expect(row.status).toBe(status); expect(row.appointmentVisibility).toBe("scoped");
      expect(isConfirmedUnscheduled(row)).toBe(false); expect(patientPlanAppointmentEmptyText(row)).toContain("قد يوجد حجز غير ظاهر");
    }
  });
  it("asserts unscheduled only for the complete all-visible planned-row absence", () => {
    const row = patientPlanCalendar({ appointmentVisibility: "all", plannedVisits: [{ ...absent, appointmentVisibility: "all" as const }] }).plannedVisits[0];
    expect(patientPlanAppointmentEmptyText(row)).toBe("لم يُحدد موعد لهذه الزيارة");
    expect(patientPlanAppointmentEmptyText({ ...row, status: "scheduled" })).not.toContain("لم يُحدد موعد");
    expect(patientPlanAppointmentEmptyText({ ...row, status: "in_progress" })).not.toContain("لم يُحدد موعد");
  });
  it("keeps an inconsistent joined identity unknown through the plans client projection", () => {
    const row = projectWorkflowPlannedAppointment(linked, 91, { kind: "all" }, { id: 991, patientId: 92, doctorId: 7 });
    const result = patientPlanCalendar({ appointmentVisibility: "all", plannedVisits: [row] }).plannedVisits[0];
    expect(result).toMatchObject({ ...clinical, appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "unknown" });
    expect(patientPlanAppointmentEmptyText(result)).toContain("غير مؤكدة");
  });
});
