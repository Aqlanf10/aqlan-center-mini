import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import { canReadAppointment, patientAppointmentVisibility, type AppointmentReadScope } from "../lib/appointment-read-scope";
import { projectWorkflowPlannedAppointment } from "../lib/patient-workflow-calendar";

const mocks = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), owned: vi.fn(), owns: vi.fn(), todayVisit: vi.fn(), workflow: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", getSettings: async () => ({ "workflow.doctor_financial_view": "false" }),
  findUserByUsername: mocks.user, doctorOwnedPatientIds: mocks.owned, doctorOwnsPatient: mocks.owns,
  patientHasVisitToday: mocks.todayVisit, patientWorkflow: mocks.workflow,
}));
import { GET } from "../app/api/patients/[id]/workflow/route";

const session: SessionPayload = { userId: 10, username: "synthetic-doctor", role: "doctor", partyId: 7, expiresAt: 0 };
const clinical = { id: 21, planId: 31, planTitle: "Clinical plan", sequence: 1, title: "Clinical planned row",
  doctorId: 7, doctorName: "Clinical assignment", durationMinutes: 30, status: "planned", visitId: 41, note: "Clinical note", createdAt: "2026-10-03T08:00:00Z" };
const appointment = { id: 991, patientId: 91, doctorId: 8, date: "2026-11-12", time: "15:47", durationMinutes: 30,
  appointmentType: "CALENDAR_TYPE", note: "CALENDAR_NOTE", status: "booked" };
const context = { params: Promise.resolve({ id: "91" }) };
const request = () => GET(new Request("http://test.invalid/api/patients/91/workflow"), context);

beforeEach(() => {
  vi.clearAllMocks(); mocks.session.mockResolvedValue(session);
  mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: { canViewAllPatients: true, canViewPlans: true } });
  mocks.owned.mockResolvedValue(new Set()); mocks.owns.mockResolvedValue(false); mocks.todayVisit.mockResolvedValue(true);
  // Synthetic route collaborator only. SQL selection is asserted separately by
  // the source contract; this mock is not evidence of database execution.
  mocks.workflow.mockImplementation(async (_patientId: number, _today: string, scope: AppointmentReadScope) => ({
    patient: { id: 91 }, openVisit: { id: 51, status: "in_chair", plannedTitle: "Clinical planned row" }, lastVisit: { id: 61 },
    nextAppointment: canReadAppointment(scope, appointment) ? appointment : null,
    appointmentVisibility: patientAppointmentVisibility(scope, 91),
    plannedVisits: [projectWorkflowPlannedAppointment({ ...clinical, appointmentId: 991, appointmentDate: appointment.date,
      appointmentTime: appointment.time }, 91, scope, appointment)],
    activePlans: [], financial: { balanceMinor: 500, invoicedMinor: 500, paidMinor: 0, openingMinor: 0 },
    counts: { visits: 1, openLabOrders: 2, documents: 3, orthoCase: true },
    alerts: [{ kind: "unscheduled_visit", severity: "warning", text: "BOOKING_ABSENCE" },
      { kind: "plan_ready", severity: "info", text: "CLINICAL_READY" }],
    futureUnreviewedField: "DO_NOT_SERIALIZE",
  }));
});

describe("workflow GET canonical calendar projection", () => {
  it("does not let canViewAllPatients grant another provider's appointment", async () => {
    const response = await request(); expect(response.status).toBe(200);
    const payload = await response.json();
    expect(mocks.workflow).toHaveBeenCalledWith(91, expect.any(String), { kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set() });
    expect(payload).toMatchObject({ appointmentVisibility: "scoped", nextAppointment: null, financial: null,
      plannedVisits: [{ ...clinical, appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "scoped" }] });
    expect(JSON.stringify(payload)).not.toMatch(/991|2026-11-12|15:47|CALENDAR_|BOOKING_ABSENCE|DO_NOT_SERIALIZE/);
    expect(payload.alerts).toEqual([{ kind: "plan_ready", severity: "info", text: "CLINICAL_READY" }]);
  });
  it.each(["own-provider", "unassigned", "owned-patient", "all-appointments"])("preserves the canonical %s read", async (kind) => {
    if (kind === "owned-patient") mocks.owned.mockResolvedValue(new Set([91]));
    if (kind === "all-appointments") mocks.user.mockResolvedValue({ isActive: true, partyId: 7,
      permissions: { canViewAllPatients: true, canViewPlans: true, canViewAllAppointments: true } });
    if (kind === "own-provider" || kind === "unassigned") {
      const implementation = mocks.workflow.getMockImplementation()!;
      mocks.workflow.mockImplementation(async (id, today, scope) => {
        const data = await implementation(id, today, scope);
        const readable = { ...appointment, doctorId: kind === "own-provider" ? 7 : null };
        return { ...data, nextAppointment: canReadAppointment(scope, readable) ? readable : null,
          plannedVisits: [projectWorkflowPlannedAppointment({ ...clinical, appointmentId: 991,
            appointmentDate: appointment.date, appointmentTime: appointment.time }, 91, scope, readable)] };
      });
    }
    const payload = await (await request()).json();
    expect(payload.nextAppointment?.id).toBe(991); expect(payload.plannedVisits[0].appointmentId).toBe(991);
    expect(payload.canSeeFinancial).toBe(false);
  });
  it.each(["admin", "reception"])("retains %s all-calendar reads", async (role) => {
    mocks.session.mockResolvedValue({ ...session, role });
    const payload = await (await request()).json();
    expect(payload.appointmentVisibility).toBe("all"); expect(payload.nextAppointment.id).toBe(991);
    expect(payload.alerts.some((alert: { kind: string }) => alert.kind === "unscheduled_visit")).toBe(true);
  });
  it("preserves the assistant ceiling without granting clinical plans or calendar", async () => {
    mocks.session.mockResolvedValue({ ...session, role: "assistant" });
    const payload = await (await request()).json();
    expect(payload).toMatchObject({ appointmentVisibility: "hidden", nextAppointment: null, plannedVisits: [], activePlans: [],
      planVisible: false, canSeeFinancial: false, financial: null, openVisit: { id: 51, plannedTitle: null } });
    expect(mocks.workflow).toHaveBeenCalledWith(91, expect.any(String), { kind: "none" });
  });
  it.each([null, "foreign"])("denies %s session/patient before reading workflow", async (kind) => {
    if (kind === null) mocks.session.mockResolvedValue(null);
    else mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: {} });
    expect((await request()).status).toBe(kind === null ? 401 : 403); expect(mocks.workflow).not.toHaveBeenCalled();
  });
});
