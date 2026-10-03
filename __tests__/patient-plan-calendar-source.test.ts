import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source contract only: no db.ts import, server startup, or query execution.
const db = readFileSync("lib/db.ts", "utf8");
const planned = db.slice(db.indexOf("async function readPatientPlannedVisitRows("), db.indexOf("/**\n * لوحة اليوم"));
const route = readFileSync("app/api/patients/[id]/plans/route.ts", "utf8");

describe("patient plans shared calendar-read boundary", () => {
  it("shares one ordered patient-local SQL reader with the unchanged raw internal path", () => {
    expect(planned.match(/getPool\(\)\.query<PlannedVisitRow>/g)).toHaveLength(1);
    expect(planned).toContain("WHERE v.patient_id = $1 AND v.status NOT IN ('completed', 'cancelled')");
    expect(planned).toContain("ORDER BY v.status = 'in_progress' DESC, v.sequence, v.id");
    expect(planned).toContain("return (await readPatientPlannedVisitRows(patientId)).map(toPlannedVisit)");
    expect(planned).toContain("const rows = await readPatientPlannedVisitRows(patientId)");
    expect(planned).toContain("const source = toPlannedVisit(row)");
    expect(planned).toContain("projectWorkflowPlannedAppointment(source, patientId, scope");
    expect(planned).toContain("id: row.calendar_id, patientId: row.calendar_patient_id, doctorId: row.calendar_doctor_id");
  });
  it("exports only projected rows from the read-only wrapper and defaults to no calendar scope", () => {
    const wrapper = planned.slice(planned.indexOf("export async function listPatientPlannedVisitReads("));
    expect(wrapper).toContain('scope: AppointmentReadScope = { kind: "none" }');
    expect(wrapper).toContain("return (await patientWorkflowPlannedVisits(patientId, scope)).map((row) => row.read)");
    expect(wrapper).not.toContain("row.source");
    expect(db).not.toContain("export async function patientWorkflowPlannedVisits");
    expect(db).not.toContain("export async function readPatientPlannedVisitRows");
  });
  it("admits the clinical plan read before resolving calendar scope and never serializes the raw reader", () => {
    expect(route.indexOf('canAccessPatient(session, patientId, "canViewPlans")')).toBeLessThan(route.indexOf("resolveAppointmentReadScope(session, [patientId])"));
    expect(route).toContain("listPatientPlannedVisitReads(patientId, appointmentScope)");
    expect(route).toContain("appointmentVisibility: patientAppointmentVisibility(appointmentScope, patientId)");
    expect(route).not.toContain("listPatientPlannedVisits");
  });
  it("qualifies calendar absence without adding scheduling controls or replacing mutation owners", () => {
    const component = readFileSync("components/PatientPlans.tsx", "utf8");
    expect(component).toContain("patientPlanCalendar({");
    expect(component).toContain('sameContext && !loading && !readError ? cachedAppointmentVisibility : "unknown"');
    expect(component).toContain("patientPlanAppointmentEmptyText(visit)");
    expect(component).toContain("data-appointment-visibility={visit.appointmentVisibility}");
    expect(component).not.toContain("تُجدوَل بتاريخٍ ووقت فقط من تبويب الملخص");
    expect(component).not.toContain("/api/planned-visits/");
    expect(component).toContain("uncertainAttempts.current.set");
    expect(component).toContain("creationWrites.current.size > 0 || itemWrites.current.size > 0");
  });
});
