import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  session: vi.fn(), recovery: vi.fn(), ordinary: vi.fn(), installment: vi.fn(),
  settings: vi.fn(), audit: vi.fn(), plan: vi.fn(), funded: vi.fn(), payment: vi.fn(),
  readRecovery: vi.fn(), ledger: vi.fn(), plans: vi.fn(), access: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mock.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", getSettings: mock.settings,
  recordReversedInstallmentRecovery: mock.recovery, recordPayment: mock.ordinary,
  recordPlanInstallment: mock.installment, recordAudit: mock.audit,
  getPlan: mock.plan, isPlanFundedByAgreement: mock.funded, getPayment: mock.payment,
  listPaymentsByDate: vi.fn(), setPlanStatus: vi.fn(),
  patientReversedInstallmentRecoveries: mock.readRecovery, patientLedger: mock.ledger,
  listPatientPlans: mock.plans, patientReceiptRemainders: vi.fn().mockResolvedValue({}),
  openingMinorsOf: () => ({ YER: 0, SAR: 0, USD: 0 }),
}));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mock.access }));
vi.mock("@/lib/legacy-balance-arrangements-db", () => ({
  listLegacyBalanceArrangements: vi.fn().mockResolvedValue([]),
  listLegacyOpeningPositions: vi.fn().mockResolvedValue([]),
}));
import { POST as postPayment } from "../app/api/payments/route";
import { POST as postInstallment } from "../app/api/plans/[id]/route";
import { GET as getLedger } from "../app/api/patients/[id]/ledger/route";

const intent = { purpose: "reversed-installment-recovery", patientId: 7, invoiceId: 17, amount: "20.50", currency: "SAR", method: "cash", note: "existing invoice" };
const request = (body: unknown = intent, key: string | null = "recover-route-001") => new Request("https://synthetic.invalid/api/payments", {
  method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body),
});
const context = { params: Promise.resolve({ id: "7" }) };
beforeEach(() => {
  vi.clearAllMocks();
  mock.session.mockResolvedValue({ username: "cashier-a", role: "reception", userId: 1 });
  mock.recovery.mockResolvedValue({ payment: { id: 50 }, reason: null });
  mock.settings.mockResolvedValue({});
  mock.ordinary.mockResolvedValue({ payment: { id: 51, kind: "payment", receiptNumber: "P51", amountMinor: 20, currency: "YER", exchangeRate: 1, baseAmountMinor: 20, method: "cash" }, reason: null });
  mock.funded.mockResolvedValue(true);
  mock.plan.mockResolvedValue({ id: 7, patientId: 7, title: "plan", baseCurrency: "YER", progress: { paidCount: 1 }, installments: [{}, {}] });
  mock.ledger.mockResolvedValue({ invoices: [], payments: [], openings: [] });
  mock.plans.mockResolvedValue([]);
  mock.readRecovery.mockResolvedValue({ recoveries: [], reviews: [{ invoiceId: 17, planId: 7, reason: "missing_creation_provenance" }] });
  mock.access.mockResolvedValue(false);
});

describe("explicit recovery payment route", () => {
  it.each([null, { username: "doctor", role: "doctor" }, { username: "cashier", role: "cashier", financeAccess: { collectPayments: false } }])("checks session/permission before reading recovery or FX: %j", async (session) => {
    mock.session.mockResolvedValue(session);
    const response = await postPayment(request());
    expect(response.status).toBe(session ? 403 : 401);
    expect(mock.recovery).not.toHaveBeenCalled(); expect(mock.settings).not.toHaveBeenCalled();
  });
  it("normalizes the explicit request and returns the canonical receipt without current FX or a duplicate audit", async () => {
    expect((await postPayment(request())).status).toBe(201);
    expect(mock.recovery).toHaveBeenCalledWith({ purpose: intent.purpose, patientId: 7, invoiceId: 17, amountMinor: 2050, currency: "SAR", method: "cash", note: "existing invoice", createdBy: "cashier-a", actorRole: "reception", idempotencyKey: "recover-route-001" });
    expect(mock.settings).not.toHaveBeenCalled(); expect(mock.ordinary).not.toHaveBeenCalled(); expect(mock.installment).not.toHaveBeenCalled(); expect(mock.audit).not.toHaveBeenCalled();
  });
  it("replays with 200 even when current FX is unavailable, without another audit", async () => {
    mock.settings.mockRejectedValue(new Error("current FX unavailable"));
    mock.recovery.mockResolvedValue({ payment: { id: 50 }, reason: null, replayed: true });
    const response = await postPayment(request());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ id: 50 });
    expect(mock.settings).not.toHaveBeenCalled(); expect(mock.audit).not.toHaveBeenCalled();
  });
  it.each([{ purpose: "unknown" }, { planId: 7 }, { openingCurrency: "SAR" }, { exchangeRate: 140 }, { reversalOfId: 9 }, { amount: "-1" }, { invoiceId: 0 }])("fails closed for explicit invalid fields %j", async (override) => {
    expect((await postPayment(request({ ...intent, ...override }))).status).toBe(400);
    expect(mock.recovery).not.toHaveBeenCalled(); expect(mock.ordinary).not.toHaveBeenCalled(); expect(mock.settings).not.toHaveBeenCalled();
  });
  it("requires an idempotency key for explicit recovery", async () => {
    expect((await postPayment(request(intent, null))).status).toBe(400);
    expect(mock.recovery).not.toHaveBeenCalled();
  });
  it.each(["recovery_review_required", "recovery_not_available", "recovery_exceeds_remaining", "recovery_account_credit_review", "recovery_target_changed", "exchange_rate_required", "idempotency_conflict", "no_shift"])("preserves actionable refusal %s", async (reason) => {
    mock.recovery.mockResolvedValue({ payment: null, reason });
    const response = await postPayment(request());
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ reason, message: expect.any(String) });
    expect(mock.audit).not.toHaveBeenCalled();
  });
  it.each(["issued_installment_recovery_required", "installment_recovery_review_required"])("legacy clients receive explicit %s without a new receipt or fallback", async (reason) => {
    mock.ordinary.mockResolvedValue({ payment: null, reason });
    const response = await postPayment(request({ patientId: 7, invoiceId: 17, amount: "20", currency: "YER" }));
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ reason, message: expect.stringContaining("لم يُسجّل قبض جديد") });
    expect(mock.recovery).not.toHaveBeenCalled(); expect(mock.audit).not.toHaveBeenCalled(); expect(mock.installment).not.toHaveBeenCalled();
  });
  it("retains the ordinary parser/writer path for no purpose", async () => {
    expect((await postPayment(request({ patientId: 7, amount: "20", currency: "YER" }))).status).toBe(201);
    expect(mock.recovery).not.toHaveBeenCalled(); expect(mock.settings).toHaveBeenCalledOnce();
    expect(mock.ordinary).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: null, planId: null, idempotencyKey: "recover-route-001", amountMinor: 20 }));
    expect(mock.audit).toHaveBeenCalledOnce();
  });
});

describe("both installment entrances", () => {
  it.each(["issued_installment_recovery_required", "installment_recovery_review_required"])("explains %s without silently creating or redirecting principal", async (reason) => {
    mock.installment.mockResolvedValue({ reason, recoveryInvoiceIds: [17, 19] });
    const paymentResponse = await postPayment(request({ patientId: 7, planId: 7, amount: "20", currency: "YER" }));
    const planResponse = await postInstallment(request({ amount: "20", currency: "YER" }), context);
    for (const response of [paymentResponse, planResponse]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason, recoveryInvoiceIds: [17, 19], message: expect.stringContaining("قسط") });
    }
    expect(mock.recovery).not.toHaveBeenCalled(); expect(mock.ordinary).not.toHaveBeenCalled();
  });
});

describe("ledger recovery projection boundary", () => {
  it("does not fetch or serialize recovery evidence for a denied doctor", async () => {
    mock.session.mockResolvedValue({ username: "doctor", role: "doctor" });
    expect((await getLedger(new Request("https://synthetic.invalid/api/patients/7/ledger"), context)).status).toBe(403);
    expect(mock.readRecovery).not.toHaveBeenCalled();
  });
  it("returns the dedicated reader projection without inferring from ledger rows", async () => {
    const response = await getLedger(new Request("https://synthetic.invalid/api/patients/7/ledger"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ installmentRecovery: { recoveries: [], reviews: [{ invoiceId: 17, planId: 7, reason: "missing_creation_provenance" }] } });
    expect(mock.readRecovery).toHaveBeenCalledWith(7);
  });
});
