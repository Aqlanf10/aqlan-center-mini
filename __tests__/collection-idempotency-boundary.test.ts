import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  session: vi.fn(), settings: vi.fn(), plan: vi.fn(), payment: vi.fn(),
  ordinary: vi.fn(), installment: vi.fn(), recovery: vi.fn(), audit: vi.fn(), approved: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: calls.session }));
vi.mock("@/lib/approved-agreements", () => ({ collectApprovedAgreement: calls.approved }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", getSettings: calls.settings, getPlan: calls.plan,
  recordPayment: calls.payment, recordSettingsOwnedPayment: calls.ordinary,
  recordPlanInstallment: calls.installment, recordReversedInstallmentRecovery: calls.recovery,
  recordAudit: calls.audit, getPayment: vi.fn(), getPaymentByIdempotencyKey: vi.fn(),
  isPlanFundedByAgreement: vi.fn(), listPaymentsByDate: vi.fn(), setPlanStatus: vi.fn(),
}));
import { POST as payment } from "../app/api/payments/route";
import { POST as installment } from "../app/api/plans/[id]/route";

beforeEach(() => {
  vi.clearAllMocks();
  calls.session.mockResolvedValue({ username: "synthetic-collector", role: "reception", userId: 1 });
});

it.each([null, "", "   ", "short", "invalid key", "x".repeat(129)])("rejects key %j before financial reads or writes on both collection doors", async (key) => {
  for (const door of ["payment", "installment"]) {
    const request = new Request("https://synthetic.invalid/api/payments", {
      method: "POST", headers: { "Content-Type": "application/json", ...(key === null ? {} : { "Idempotency-Key": key }) },
      body: JSON.stringify({ patientId: 1, planId: 1, amount: "205000", currency: "YER", kind: "payment" }),
    });
    const response = door === "payment" ? await payment(request) : await installment(request, { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(400);
    for (const [name, spy] of Object.entries(calls)) if (name !== "session") expect(spy, name).not.toHaveBeenCalled();
  }
});
