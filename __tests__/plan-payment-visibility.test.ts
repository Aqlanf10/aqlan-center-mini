import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreatmentPlan } from "../lib/db";
import { planProgress } from "../lib/plans";
import { withoutPlanPayments } from "../lib/plan-payment-projection";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), owns: vi.fn(), todayVisit: vi.fn(),
  settings: vi.fn(), plans: vi.fn(), active: vi.fn(), visits: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: mocks.user,
  doctorOwnsPatient: mocks.owns, patientHasVisitToday: mocks.todayVisit,
  getSettings: mocks.settings, listPatientPlans: mocks.plans,
  listActivePlans: mocks.active, listPatientPlannedVisits: mocks.visits,
}));
import { GET as genericGet } from "../app/api/plans/route";
import { GET as patientGet } from "../app/api/patients/[id]/plans/route";

const installments = [
  { id: 401, number: 1, dueDate: "2026-10-04", amountMinor: 15000, lastReminderAt: "2026-10-03T15:00:00.000Z" },
  { id: 402, number: 2, dueDate: "2026-11-04", amountMinor: 15000, lastReminderAt: null },
];
const plan: TreatmentPlan = {
  id: 301, patientId: 201, patientName: "Synthetic plan patient", patientPhone: null,
  title: "Synthetic agreement", totalMinor: 30000, baseCurrency: "SAR", status: "active",
  startDate: "2026-10-04", note: "Clinical note", createdAt: "2026-10-04T00:00:00.000Z",
  lastReminderAt: "2026-10-03T15:00:00.000Z", installments, paidMinor: 16000,
  // Synthetic receipt 18000 less refund 2000 fully covers installment one.
  progress: planProgress({ totalMinor: 30000, status: "active", installments }, 18000 - 2000, "2026-10-04"),
  items: [], itemsProgress: { count: 1, doneCount: 1, totalMinor: 30000, doneMinor: 30000, remainingMinor: 0 },
  totalFromItems: false, consentAt: null, consentBy: null, consentNote: null,
};
const doctor = (permissions: Record<string, boolean> = { canViewPlans: true, canViewPatientPayments: false }) => ({
  id: 7, username: "synthetic_doctor", isActive: true, partyId: 71, permissions,
});
const get = (route: "generic" | "patient", patientId = 201) => route === "generic"
  ? genericGet(new Request(`http://localhost/api/plans?patientId=${patientId}`))
  : patientGet(new Request(`http://localhost/api/patients/${patientId}/plans`), { params: Promise.resolve({ id: String(patientId) }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ userId: 7, username: "synthetic_doctor", role: "doctor", partyId: 71 });
  mocks.user.mockResolvedValue(doctor());
  mocks.owns.mockResolvedValue(true);
  mocks.todayVisit.mockResolvedValue(true);
  mocks.settings.mockResolvedValue({ "workflow.doctor_financial_view": "false" });
  mocks.plans.mockResolvedValue([plan]); mocks.active.mockResolvedValue([plan]);
  mocks.visits.mockResolvedValue([{ id: 501, title: "Synthetic clinical visit" }]);
});

function expectHidden(body: Record<string, unknown>, route: "generic" | "patient") {
  const plans = body.plans as Record<string, unknown>[];
  expect(plans).toHaveLength(1);
  expect(plans[0].paidMinor).toBeNull();
  expect(plans[0].progress).toBeNull();
  expect(body.canSeeFinancial).toBe(false);
  expect(plans[0]).toMatchObject({ paidMinor: null, progress: null, lastReminderAt: null,
    title: plan.title, totalMinor: plan.totalMinor, itemsProgress: plan.itemsProgress, hasInstallments: true });
  expect(plans[0].installments).toEqual(route === "generic" ? [{ id: 401 }, { id: 402 }] : []);
  const raw = JSON.stringify(plans[0]);
  expect(raw).not.toContain("16000");
  expect(raw).not.toMatch(/nextDueDate|nextDueAmountMinor|remainingMinor":14000|paidCount|2026-10-03T15/);
}

for (const route of ["generic", "patient"] as const) {
  describe(`${route} raw plan response`, () => {
    it.each(["false", "true"])("per-doctor deny survives global switch %s", async (global) => {
      mocks.settings.mockResolvedValue({ "workflow.doctor_financial_view": global });
      const response = await get(route);
      expect(response.status).toBe(200);
      expectHidden(await response.json(), route);
    });
    it("missing payment permission is not a grant", async () => {
      mocks.user.mockResolvedValue(doctor({ canViewPlans: true }));
      mocks.settings.mockResolvedValue({ "workflow.doctor_financial_view": "true" });
      expectHidden(await (await get(route)).json(), route);
    });
    it.each(["false", "true"])("explicit permission preserves applicable legacy global deny %s", async (global) => {
      mocks.user.mockResolvedValue(doctor({ canViewPlans: true, canViewPatientPayments: true }));
      mocks.settings.mockResolvedValue({ "workflow.doctor_financial_view": global });
      const response = await get(route);
      expect(response.status).toBe(200);
      const body = await response.json();
      if (route === "patient" && global === "false") expectHidden(body, route);
      else { expect(body.canSeeFinancial).toBe(true); expect(body.plans).toEqual([plan]); }
    });
    it.each(["revoked", "lookup-failed"])("fresh finance authority fails closed when %s after clinical access", async (state) => {
      mocks.settings.mockResolvedValue({ "workflow.doctor_financial_view": "true" });
      mocks.user.mockResolvedValueOnce(doctor({ canViewPlans: true, canViewPatientPayments: true }));
      if (state === "revoked") mocks.user.mockResolvedValue(doctor());
      else mocks.user.mockRejectedValue(new Error("synthetic finance permission read failure"));
      const response = await get(route);
      expect(response.status).toBe(200);
      expectHidden(await response.json(), route);
    });
    it("rejects another provider's patient before loading plans", async () => {
      mocks.owns.mockResolvedValue(false);
      expect((await get(route)).status).toBe(403);
      expect(mocks.plans).not.toHaveBeenCalled();
    });
    it.each(["missing", "inactive", "lookup-failed", "unlinked"])("fails closed for %s persisted doctor", async (state) => {
      if (state === "missing") mocks.user.mockResolvedValue(null);
      if (state === "inactive") mocks.user.mockResolvedValue({ ...doctor(), isActive: false });
      if (state === "lookup-failed") mocks.user.mockRejectedValue(new Error("synthetic read failure"));
      if (state === "unlinked") mocks.user.mockResolvedValue({ ...doctor(), partyId: null });
      expect((await get(route)).status).toBe(403);
      expect(mocks.plans).not.toHaveBeenCalled();
    });
    it("requires a validated session", async () => {
      mocks.session.mockResolvedValue(null);
      expect((await get(route)).status).toBe(401);
      expect(mocks.plans).not.toHaveBeenCalled();
    });
    it.each(["admin", "reception"])("preserves the %s financial and clinical response", async (role) => {
      mocks.session.mockResolvedValue({ role });
      const response = await get(route);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ plans: [plan], canSeeFinancial: true });
    });
  });
}

it("generic plans preserve strict owning-provider scope even with a broad patient grant", async () => {
  mocks.user.mockResolvedValue(doctor({ canViewAllPatients: true, canViewPlans: true, canViewPatientPayments: true }));
  mocks.owns.mockResolvedValue(false);
  expect((await get("generic")).status).toBe(403);
  // The patient-file route retains its existing canonical broader clinical scope.
  expect((await get("patient")).status).toBe(200);
});
it("generic plans still honor clinical plan denial and reject an unscoped doctor list", async () => {
  mocks.user.mockResolvedValue(doctor({ canViewPlans: false, canViewPatientPayments: true }));
  expect((await get("generic")).status).toBe(403);
  mocks.user.mockResolvedValue(doctor());
  expect((await genericGet(new Request("http://localhost/api/plans"))).status).toBe(403);
});
it.each(["cashier", "accountant"])("keeps %s financial-only projection and no patient-file access", async (role) => {
  mocks.session.mockResolvedValue({ role });
  const response = await get("generic");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ canSeeFinancial: true, plans: [{ paidMinor: 16000, progress: plan.progress, installments }] });
  expect(body.plans[0]).not.toHaveProperty("items");
  expect(body.plans[0]).not.toHaveProperty("note");
  expect(body.plans[0]).not.toHaveProperty("consentNote");
  expect((await get("patient")).status).toBe(403);
});
it("assistant receives no new route or payment authority", async () => {
  mocks.session.mockResolvedValue({ role: "assistant" });
  expect((await get("generic")).status).toBe(403);
  // Direct handler remains redacted; proxy still blocks this unlisted assistant route.
  expectHidden(await (await get("patient")).json(), "patient");
});
it("the clinical allowlist excludes future aggregate fields and does not mutate plans", () => {
  const before = structuredClone(plan);
  const projected = withoutPlanPayments({ ...plan, futurePaymentAggregate: 16000 } as TreatmentPlan, true);
  expect(projected).not.toHaveProperty("futurePaymentAggregate");
  expect(plan).toEqual(before);
  expect(plan.progress.nextDueDate).toBe("2026-11-04");
  expect(plan.progress.nextDueAmountMinor).toBe(14000);
});


it.each([false, undefined])("patient-file plans require a current explicit clinical grant, not session claims (%s)", async (permission) => {
  mocks.session.mockResolvedValue({ userId: 7, username: "synthetic_doctor", role: "doctor", partyId: 71,
    permissions: { canViewPlans: true, canViewPatientPayments: true, canViewAllPatients: true } });
  mocks.user.mockResolvedValue(doctor({ canViewPatientPayments: true,
    ...(permission === undefined ? {} : { canViewPlans: permission }) }));
  const response = await get("patient");
  expect(response.status).toBe(403);
  expect(mocks.settings).not.toHaveBeenCalled();
  expect(mocks.plans).not.toHaveBeenCalled();
  expect(mocks.visits).not.toHaveBeenCalled();
});
it("revoking stored plan permission denies the next patient-file read with the same session", async () => {
  expect((await get("patient")).status).toBe(200);
  mocks.user.mockResolvedValue(doctor({ canViewPlans: false, canViewPatientPayments: true, canViewAllPatients: true }));
  mocks.plans.mockClear(); mocks.visits.mockClear(); mocks.settings.mockClear();
  expect((await get("patient")).status).toBe(403);
  expect(mocks.settings).not.toHaveBeenCalled();
  expect(mocks.plans).not.toHaveBeenCalled();
  expect(mocks.visits).not.toHaveBeenCalled();
});

it("masked schedule existence is a real boolean, including a verified empty schedule", () => {
  expect(withoutPlanPayments(plan).hasInstallments).toBe(true);
  expect(withoutPlanPayments({ ...plan, installments: [] }).hasInstallments).toBe(false);
});
