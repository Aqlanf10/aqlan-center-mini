import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreatmentPlan } from "../lib/db";
import { canReadPatientPlanFinance, groupProjectedPlanItems, patientPlanCapabilities, projectPatientPlan, projectPatientPlanTotal } from "../lib/patient-plan-projection";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), owns: vi.fn(), settings: vi.fn(), plans: vi.fn(), activePlans: vi.fn(),
  add: vi.fn(), getPlanPatientId: vi.fn(), getCurrency: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: mocks.user, doctorOwnsPatient: mocks.owns,
  doctorOwnedPatientIds: vi.fn(async () => new Set<number>([19])),
  getSettings: mocks.settings, listPatientPlans: mocks.plans, listActivePlans: mocks.activePlans,
  listPatientPlannedVisitReads: vi.fn(async () => [{ id: 65, title: "جلسة سريرية", sequence: 2 }]),
  addPlanItem: mocks.add, getPlanPatientId: mocks.getPlanPatientId, getPlanCurrency: mocks.getCurrency,
  getService: vi.fn(async () => ({ id: 8, name: "خدمة سريرية", category: "rct", priceMinor: 78000 })),
  recordAudit: mocks.audit,
}));
import { GET as patientGet } from "../app/api/patients/[id]/plans/route";
import { GET as legacyGet } from "../app/api/plans/route";
import { POST as itemPost } from "../app/api/plans/[id]/items/route";

const plan: TreatmentPlan = {
  id: 41, patientId: 19, patientName: "Synthetic patient", patientPhone: null,
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
const context = { params: Promise.resolve({ id: "19" }) };
const permissions = (payment = false, catalog = false, edit = true) => ({
  canViewPlans: true, canEditPlans: edit, canViewPatientPayments: payment, canViewServicePrices: catalog, canViewAllPatients: false,
});
function doctor(payment = false, catalog = false, edit = true) {
  mocks.session.mockResolvedValue({ username: "synthetic-doctor", role: "doctor", partyId: 7 });
  mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: permissions(payment, catalog, edit) });
}
function expectNoMoney(value: unknown) {
  if (Array.isArray(value)) { value.forEach(expectNoMoney); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/Minor$|dueDate|nextDueDate|paidCount|lastReminderAt|secretFinancial|discount|exchangeRate/i.test(key)) expect(child).toBeNull();
    expectNoMoney(child);
  }
}
beforeEach(() => {
  vi.clearAllMocks(); doctor();
  mocks.owns.mockResolvedValue(true); mocks.settings.mockResolvedValue({ "workflow.doctor_financial_view": "false" });
  mocks.plans.mockResolvedValue([plan]); mocks.activePlans.mockResolvedValue([plan]);
  mocks.add.mockResolvedValue({ ok: true, totalMinor: 156000 });
  mocks.getPlanPatientId.mockResolvedValue(19); mocks.getCurrency.mockResolvedValue("YER");
});

describe("explicit saved-agreement projection", () => {
  it("removes all money and due details recursively, including unrecognized future fields", () => {
    const injected = { ...plan, secretFinancial: 123, items: [{ ...plan.items[0], discountMinor: 555 }],
      progress: { ...plan.progress, exchangeRate: 125 } };
    const hidden = projectPatientPlan(injected, false);
    expectNoMoney(hidden);
    expect(hidden).not.toHaveProperty("secretFinancial");
    expect(hidden.items[0]).not.toHaveProperty("discountMinor");
    expect(hidden).toMatchObject({ financialVisible: false, hasInstallments: true, installments: null, progress: null,
      items: [{ id: 73, toothCode: 16, surfaces: "MO", plannedVisitNumber: 2, sessionCount: 3, sessionsCompleted: 1 }] });
    expect(groupProjectedPlanItems(hidden.items)[0]).toMatchObject({ totalMinor: null, visitNumber: 2, doneCount: 0 });
  });
  it("preserves genuine zero and the complete authorized numeric payload", () => {
    const zero = { ...plan, totalMinor: 0, paidMinor: 0 };
    expect(projectPatientPlan(zero, true)).toEqual({ ...zero, financialVisible: true, hasInstallments: true });
    expect(projectPatientPlan(zero, false).totalMinor).toBeNull();
    expect(projectPatientPlanTotal(0, true)).toEqual({ financialVisible: true, totalMinor: 0 });
    expect(projectPatientPlanTotal(0, false)).toEqual({ financialVisible: false, totalMinor: null });
  });
  it.each([false, true])("keeps an absent aggregate explicitly unknown with financial visibility=%s", (financialVisible) => {
    expect(projectPatientPlanTotal(undefined, financialVisible)).toEqual({ financialVisible, totalMinor: null });
  });
  it("distinguishes a hidden schedule from no agreement without due or payment details", () => {
    expect(projectPatientPlan(plan, false).hasInstallments).toBe(true);
    expect(projectPatientPlan({ ...plan, installments: [] }, false)).toMatchObject({ installments: null, hasInstallments: false });
  });
});

for (const global of [false, true]) for (const payment of [false, true]) for (const catalog of [false, true]) for (const edit of [false, true]) {
  it(`both GETs: global=${global}, payments=${payment}, catalogue=${catalog}, edit=${edit}`, async () => {
    doctor(payment, catalog, edit);
    mocks.settings.mockResolvedValue({ "workflow.doctor_financial_view": String(global) });
    for (const response of [await patientGet(new Request("http://test/api/patients/19/plans"), context),
      await legacyGet(new Request("http://test/api/plans?patientId=19"))]) {
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.plans[0].financialVisible).toBe(global && payment);
      expect(body.plans[0].baseCurrency).toBe("USD");
      if (!(global && payment)) expectNoMoney(body.plans[0]);
      else expect(body.plans[0].totalMinor).toBe(78000);
      if (body.capabilities) {
        expect(body.capabilities).toMatchObject({ canEditPlans: edit, canViewCatalogPrices: catalog,
          canCollectPayments: false, canCompletePlan: false, canRecordConsent: false, canPrintContract: false });
      }
    }
  });
}

it.each(["admin", "reception"])("retains full %s reads and distinct writer capabilities", async (role) => {
  mocks.session.mockResolvedValue({ role, username: `synthetic-${role}` });
  const body = await (await patientGet(new Request("http://test"), context)).json();
  expect(body.plans[0]).toEqual({ ...plan, financialVisible: true, hasInstallments: true });
  expect(Object.values(body.capabilities).every(Boolean)).toBe(true);
  const legacy = await (await legacyGet(new Request("http://test/api/plans?patientId=19"))).json();
  expect(legacy.plans[0].items[0].unitPriceMinor).toBe(78000);
});
it.each(["cashier", "accountant"])("retains %s legacy finance-only response", async (role) => {
  mocks.session.mockResolvedValue({ role, username: `synthetic-${role}` });
  const body = await (await legacyGet(new Request("http://test/api/plans"))).json();
  expect(body.plans[0]).toMatchObject({ title: "خطة مالية #41", totalMinor: 78000, progress: plan.progress });
  expect(body.plans[0]).not.toHaveProperty("items");
  expect(body.plans[0]).not.toHaveProperty("consentNote");
  expect((await patientGet(new Request("http://test"), context)).status).toBe(403);
});
it("enforces canViewPlans on both GETs and fails closed for a revoked user", async () => {
  for (const user of [{ isActive: true, partyId: 7, permissions: { ...permissions(true), canViewPlans: false } },
    { isActive: false, partyId: 7, permissions: permissions(true) }, null]) {
    mocks.user.mockResolvedValue(user);
    expect((await patientGet(new Request("http://test"), context)).status).toBe(403);
    expect((await legacyGet(new Request("http://test/api/plans?patientId=19"))).status).toBe(403);
  }
  expect(mocks.plans).not.toHaveBeenCalled();
});
it("does not widen legacy ownership or mutation capability with canViewAllPatients", async () => {
  mocks.owns.mockResolvedValue(false);
  mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: { ...permissions(), canViewAllPatients: true } });
  const body = await (await patientGet(new Request("http://test"), context)).json();
  expect(body.capabilities.canEditPlans).toBe(false);
  expect((await legacyGet(new Request("http://test/api/plans?patientId=19"))).status).toBe(403);
  expect((await legacyGet(new Request("http://test/api/plans"))).status).toBe(403);
});
it("separates catalogue and agreement grants without creating money writers", () => {
  expect(canReadPatientPlanFinance("doctor", true, false)).toBe(false);
  expect(canReadPatientPlanFinance("doctor", false, true)).toBe(false);
  expect(patientPlanCapabilities("doctor", permissions(true, true), true)).toMatchObject({ canEditPlans: true,
    canCollectPayments: false, canRecordConsent: false, canCompletePlan: false, canPrintContract: false });
  expect(patientPlanCapabilities("doctor", permissions(false, false), true).canEditPlans).toBe(true);
});
it.each([[false, false], [true, false], [false, true], [true, true]])("item response respects global=%s payment=%s", async (global, payment) => {
  doctor(payment); mocks.settings.mockResolvedValue({ "workflow.doctor_financial_view": String(global) });
  const response = await itemPost(new Request("http://test/api/plans/41/items", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ serviceId: 8, quantity: 1, toothCode: 16 }) }),
  { params: Promise.resolve({ id: "41" }) });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ totalMinor: global && payment ? 156000 : null, financialVisible: global && payment });
  expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ unitPriceMinor: 78000, quantity: 1 }));
});
it.each([
  { financialVisible: false, totalMinor: undefined, expectedTotalMinor: null },
  { financialVisible: true, totalMinor: undefined, expectedTotalMinor: null },
  { financialVisible: false, totalMinor: 0, expectedTotalMinor: null },
  { financialVisible: true, totalMinor: 0, expectedTotalMinor: 0 },
])("item response preserves unknown/zero: visibility=$financialVisible total=$totalMinor", async ({ financialVisible, totalMinor, expectedTotalMinor }) => {
  doctor(true);
  mocks.settings.mockResolvedValue({ "workflow.doctor_financial_view": String(financialVisible) });
  mocks.add.mockResolvedValue(totalMinor === undefined ? { ok: true } : { ok: true, totalMinor });
  const response = await itemPost(new Request("http://test/api/plans/41/items", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ serviceId: 8, quantity: 1 }) }),
  { params: Promise.resolve({ id: "41" }) });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ totalMinor: expectedTotalMinor, financialVisible });
});
it.each(["admin", "reception"])("item response retains %s numeric aggregate", async (role) => {
  mocks.session.mockResolvedValue({ role, username: `synthetic-${role}` });
  const response = await itemPost(new Request("http://test/api/plans/41/items", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ serviceId: 8, quantity: 1 }) }),
  { params: Promise.resolve({ id: "41" }) });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ totalMinor: 156000, financialVisible: true });
});
it("item response does not disclose totals when clinical plan reading is revoked", async () => {
  doctor(true); mocks.settings.mockResolvedValue({ "workflow.doctor_financial_view": "true" });
  mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: { ...permissions(true), canViewPlans: false } });
  const response = await itemPost(new Request("http://test/api/plans/41/items", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ serviceId: 8, quantity: 1 }) }),
  { params: Promise.resolve({ id: "41" }) });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ totalMinor: null, financialVisible: false });
});
