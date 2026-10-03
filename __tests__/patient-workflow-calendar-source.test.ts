import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source-only contracts: do not import db.ts or execute SQL/application startup.
const db = readFileSync("lib/db.ts", "utf8");
const workflow = db.slice(db.indexOf("export async function patientWorkflow("), db.indexOf("// ─── الخط الزمني"));
const route = readFileSync("app/api/patients/[id]/workflow/route.ts", "utf8");

describe("workflow calendar source boundary", () => {
  it("applies the canonical same-patient SQL scope before the next-row LIMIT", () => {
    const start = workflow.indexOf("`SELECT a.id, a.scheduled_date::text");
    const end = workflow.indexOf("return rows[0]", start);
    const query = workflow.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(query).toContain("FROM appointments a");
    expect(query).toContain("WHERE a.patient_id = $1 AND ${PATIENT_APPOINTMENT_READ_SQL}");
    expect(query).toContain("a.scheduled_date >= $4::date");
    expect(query).toContain("[patientId, ...patientAppointmentReadParameters(appointmentScope, patientId), today]");
    expect(query.indexOf("PATIENT_APPOINTMENT_READ_SQL")).toBeLessThan(query.indexOf("LIMIT 1"));
    expect(query).not.toContain("scheduled_date >= $2");
  });
  it("uses actual joined appointment identity and preserves the independent raw source for alerts", () => {
    const select = db.slice(db.indexOf("const PLANNED_VISIT_SELECT"), db.indexOf("/**\n * لوحة اليوم"));
    expect(select).toContain("a.id AS calendar_id, a.patient_id AS calendar_patient_id, a.doctor_id AS calendar_doctor_id");
    expect(select).toContain("id: row.calendar_id, patientId: row.calendar_patient_id, doctorId: row.calendar_doctor_id");
    expect(select).toContain("const source = toPlannedVisit(row)");
    expect(workflow).toContain("const plannedVisits = plannedVisitReads.map((row) => row.source)");
    expect(workflow).toContain('visit.status === "planned" && !visit.appointmentId');
    expect(workflow).toContain("plannedVisits: plannedVisitReads.map((row) => row.read)");
  });
  it("resolves calendar scope after patient admission and serializes an explicit response", () => {
    expect(route.indexOf("canAccessPatient(session, patientId)")).toBeLessThan(route.indexOf("resolveAppointmentReadScope(session, [patientId])"));
    expect(route).toContain("patientWorkflow(patientId, today, appointmentScope)");
    const returns = route.slice(route.indexOf('if (session.role === "assistant")'));
    expect(returns).not.toContain("...summary");
    expect(returns).toContain('appointmentVisibility: "hidden"');
    expect(returns).toContain("nextAppointment: calendar.nextAppointment");
    expect(route).toContain("workflowCalendarAlertVisible(alert.kind, calendar.appointmentVisibility)");
  });
  it("does not derive UI scheduling from missing dates", () => {
    const summary = readFileSync("components/patient/SummaryTab.tsx", "utf8");
    expect(summary).not.toContain("!visit.appointmentDate");
    expect(summary).toContain("isConfirmedUnscheduled(visit) && scheduleFor !== visit.id");
    expect(summary).toContain("isConfirmedUnscheduled(visit) && scheduleFor === visit.id");
    expect(summary).toContain("const nextPlanned = plannedVisits[0] ?? null");
    expect(summary).not.toContain("— جدولها من هنا");
  });
});
