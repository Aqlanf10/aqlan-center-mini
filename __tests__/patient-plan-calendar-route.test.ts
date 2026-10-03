import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import type { TreatmentPlan } from "../lib/db";
import type { AppointmentReadScope } from "../lib/appointment-read-scope";
import { projectWorkflowPlannedAppointment } from "../lib/patient-workflow-calendar";
import { NO_PATIENT_PLAN_CAPABILITIES } from "../lib/patient-plan-projection";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), owns: vi.fn(), owned: vi.fn(), plans: vi.fn(), reads: vi.fn(), raw: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: mocks.user, doctorOwnsPatient: mocks.owns,
  doctorOwnedPatientIds: mocks.owned, listPatientPlans: mocks.plans,
  listPatientPlannedVisitReads: mocks.reads, listPatientPlannedVisits: mocks.raw,
  getSettings: async () => ({ "workflow.doctor_financial_view": "false" }),
}));
import { GET } from "../app/api/patients/[id]/plans/route";

const session: SessionPayload = { userId: 10, username: "synthetic-plan-reader", role: "doctor", partyId: 7, expiresAt: 0 };
const user = { isActive: true, partyId: 7 as number | null,
  permissions: { canViewAllPatients: true, canViewPlans: true, canEditPlans: true } };
const clinical = { id: 21, planId: 41, planTitle: "Clinical plan", title: "Clinical planned visit", sequence: 1,
  doctorId: 7, doctorName: "Clinical assignment", durationMinutes: 45, status: "planned", visitId: 51,
  note: "Clinical note", createdAt: "2026-10-03T08:00:00Z" };
const appointment = { id: 991, patientId: 91, doctorId: 8 as number | null };
const planned = { ...clinical, appointmentId: 991, appointmentDate: "2026-11-12", appointmentTime: "15:47" };
const plan: TreatmentPlan = {
  id: 41, patientId: 91, patientName: "Synthetic patient", patientPhone: null,
  title: "خطة سريرية", totalMinor: 78000, baseCurrency: "USD", status: "active",
  startDate: "2026-01-01", note: "clinical note", createdAt: "2026-01-01T00:00:00Z",
  lastReminderAt: "2026-02-12T10:15:00Z", installments: [{ id: 52, number: 1, dueDate: "2026-11-23", amountMinor: 39000 }],
  paidMinor: 12000, progress: { totalMinor: 78000, dueToDateMinor: 39000, paidMinor: 12000,
    remainingMinor: 66000, overdueMinor: 27000, nextDueDate: "2026-11-23", nextDueAmountMinor: 39000, paidCount: 0, count: 2 },
  totalFromItems: true, consentAt: null, consentBy: null, consentNote: "agreement-specific note",
  items: [{ id: 73, serviceId: 8, serviceName: "خدمة سريرية", category: "rct", toothCode: 16, surfaces: "MO",
    quantity: 1, unitPriceMinor: 78000, totalMinor: 78000, status: "planned", visitId: null, doneAt: null, note: null,
    plannedVisitNumber: 2, billingRule: "on_completion", billingStatus: "unbilled", sessionCount: 3,
    sessionsCompleted: 1, doctorId: 7, doctorName: "Synthetic doctor" }],
  itemsProgress: { count: 1, doneCount: 0, totalMinor: 78000, doneMinor: 0, remainingMinor: 78000 },
};
const request = (id = "91") => GET(new Request(`http://test.invalid/api/patients/${id}/plans`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks(); mocks.session.mockResolvedValue(session); mocks.user.mockResolvedValue(user);
  mocks.owns.mockResolvedValue(false); mocks.owned.mockResolvedValue(new Set()); mocks.plans.mockResolvedValue([plan]);
  // Synthetic collaborator only. The shared SQL reader is covered separately by
  // source contracts and the existing guarded, linked PostgreSQL regression.
  mocks.reads.mockImplementation(async (patientId: number, scope: AppointmentReadScope) =>
    [projectWorkflowPlannedAppointment(planned, patientId, scope, appointment)]);
  mocks.raw.mockImplementation(() => { throw new Error("Raw internal reader must not reach plans GET"); });
});

describe("patient plans GET calendar scope", () => {
  it("does not turn all-patient clinical admission into all-appointment reading or plan writers", async () => {
    const response = await request(); expect(response.status).toBe(200);
    const payload = await response.json();
    expect(mocks.reads).toHaveBeenCalledWith(91, { kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set() });
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ appointmentVisibility: "scoped", canSeeFinancial: false,
      capabilities: NO_PATIENT_PLAN_CAPABILITIES,
      plannedVisits: [{ ...clinical, appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "scoped" }] });
    expect(payload.plans[0]).toMatchObject({ id: 41, patientId: 91, financialVisible: false, totalMinor: null });
    expect(JSON.stringify(payload)).not.toMatch(/991|2026-11-12|15:47|calendar_doctor_id|"source"/);
  });

  it.each(["own-provider", "unassigned"])("keeps the canonical %s appointment even when the planned provider differs", async (kind) => {
    mocks.reads.mockImplementation(async (patientId: number, scope: AppointmentReadScope) =>
      [projectWorkflowPlannedAppointment({ ...planned, doctorId: 8 }, patientId, scope,
        { ...appointment, doctorId: kind === "own-provider" ? 7 : null })]);
    const payload = await (await request()).json();
    expect(payload).toMatchObject({ appointmentVisibility: "scoped", canSeeFinancial: false,
      plannedVisits: [{ doctorId: 8, appointmentId: 991, appointmentDate: "2026-11-12", appointmentTime: "15:47", appointmentVisibility: "scoped" }] });
  });

  it.each(["owned-patient", "all-appointments"])("keeps the existing %s calendar grant", async (kind) => {
    if (kind === "owned-patient") mocks.owned.mockResolvedValue(new Set([91]));
    else mocks.user.mockResolvedValue({ ...user, permissions: { ...user.permissions, canViewAllAppointments: true } });
    const payload = await (await request()).json();
    expect(payload).toMatchObject({ appointmentVisibility: "all", canSeeFinancial: false,
      plannedVisits: [{ appointmentId: 991, appointmentVisibility: "all" }] });
    expect(payload.capabilities).toEqual(NO_PATIENT_PLAN_CAPABILITIES);
  });

  it.each(["admin", "reception"])("retains %s calendar reads", async (role) => {
    mocks.session.mockResolvedValue({ ...session, role });
    const payload = await (await request()).json();
    expect(mocks.reads).toHaveBeenCalledWith(91, { kind: "all" });
    expect(payload).toMatchObject({ appointmentVisibility: "all", plannedVisits: [{ appointmentId: 991, appointmentVisibility: "all" }] });
  });

  it("reports hidden for a clinically admitted reader with no calendar identity", async () => {
    mocks.session.mockResolvedValue({ ...session, partyId: undefined }); mocks.user.mockResolvedValue({ ...user, partyId: null });
    const payload = await (await request()).json();
    expect(mocks.reads).toHaveBeenCalledWith(91, { kind: "none" });
    expect(payload).toMatchObject({ appointmentVisibility: "hidden", plannedVisits: [{ ...clinical,
      appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "hidden" }] });
  });

  it("does not call an incomplete joined calendar reference absent", async () => {
    mocks.session.mockResolvedValue({ ...session, role: "admin" });
    mocks.reads.mockImplementation(async (patientId: number, scope: AppointmentReadScope) =>
      [projectWorkflowPlannedAppointment(planned, patientId, scope, { ...appointment, patientId: 92 })]);
    const payload = await (await request()).json();
    expect(payload).toMatchObject({ appointmentVisibility: "all", plannedVisits: [{ ...clinical,
      appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "unknown" }] });
  });

  it("declares scoped coverage even when no planned rows are returned", async () => {
    mocks.reads.mockResolvedValue([]);
    expect(await (await request()).json()).toMatchObject({ appointmentVisibility: "scoped", plannedVisits: [] });
  });

  it("fails closed when owned-patient lookup fails without borrowing the planned doctor's assignment", async () => {
    mocks.owned.mockRejectedValue(new Error("synthetic ownership failure"));
    const payload = await (await request()).json();
    expect(payload).toMatchObject({ appointmentVisibility: "scoped", plannedVisits: [{ appointmentId: null, appointmentVisibility: "scoped" }] });
  });

  it.each(["assistant", "accountant", "cashier"])("keeps the %s plan-admission ceiling", async (role) => {
    mocks.session.mockResolvedValue({ ...session, role });
    expect((await request()).status).toBe(403); expect(mocks.reads).not.toHaveBeenCalled(); expect(mocks.owned).not.toHaveBeenCalled();
  });

  it.each(["session", "patient", "permission", "invalid-id"])("rejects %s before reading calendar rows", async (kind) => {
    if (kind === "session") mocks.session.mockResolvedValue(null);
    if (kind === "patient") mocks.user.mockResolvedValue({ ...user, permissions: { ...user.permissions, canViewAllPatients: false } });
    if (kind === "permission") mocks.user.mockResolvedValue({ ...user, permissions: { ...user.permissions, canViewPlans: false, canViewAllAppointments: true } });
    expect((await request(kind === "invalid-id" ? "invalid" : "91")).status)
      .toBe(kind === "session" ? 401 : kind === "invalid-id" ? 400 : 403);
    expect(mocks.reads).not.toHaveBeenCalled(); expect(mocks.owned).not.toHaveBeenCalled();
  });

  it("does not fall back to raw rows on a projected read failure", async () => {
    mocks.reads.mockRejectedValue(new Error("synthetic projection failure"));
    expect((await request()).status).toBe(500); expect(mocks.raw).not.toHaveBeenCalled();
  });
});
