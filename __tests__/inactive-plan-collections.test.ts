import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PlanStatus } from "../lib/plans";

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
vi.mock("@/lib/session", () => ({
  requireSession: async () => ({ username: "inactive-plan-test", role: "admin" }),
}));
const db = await import("../lib/db");
const general = await import("../app/api/payments/route");
const dedicated = await import("../app/api/plans/[id]/route");

beforeAll(async () => {
  await db.ensureSchema();
  await db.openShift({ openedBy: "inactive-plan-test", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 60_000);
afterAll(async () => { await db.resetPoolForTesting(); });

type Target = { patientId: number; planId: number };
async function seed(status: PlanStatus = "active", installments = true): Promise<Target> {
  const { rows: [patient] } = await db.getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic collection test') RETURNING id`,
    [`PLAN-COLLECT-${crypto.randomUUID()}`],
  );
  const { rows: [plan] } = await db.getPool().query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, billing_mode)
     VALUES ($1, 'Synthetic agreement', 300000, 'YER', $2, $3) RETURNING id`,
    [patient.id, status, installments ? "installments" : "per_procedure"],
  );
  if (installments) await db.getPool().query(
    `INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
     VALUES ($1, 1, '2026-10-01', 150000), ($1, 2, '2026-11-01', 150000)`, [plan.id],
  );
  return { patientId: patient.id, planId: plan.id };
}
const body = (target: Target, amount = "150000") => ({ ...target, amount, currency: "YER", method: "cash" });
const request = (value: unknown, key: string) => new Request("http://localhost/api/payments", {
  method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(value),
});
const post = (door: "general" | "dedicated", target: Target, key: string, amount = "150000") => door === "general"
  ? general.POST(request(body(target, amount), key))
  : dedicated.POST(request(body(target, amount), key), { params: Promise.resolve({ id: String(target.planId) }) });
const ordinary = (target: Target) => ({
  ...target, invoiceId: null, kind: "payment" as const, amountMinor: 150000,
  currency: "YER" as const, baseCurrency: "YER" as const, exchangeRate: 1,
  method: "cash", note: null, createdBy: "inactive-plan-test",
});
const close = (target: Target, status: "completed" | "cancelled") => db.setPlanStatus(target.planId, status, {
  actor: "inactive-plan-test", actorRole: "admin", reason: "Synthetic plan closure",
});
async function assertNoFinancialWrites(target: Target) {
  const ledger = await db.patientLedger(target.patientId);
  expect(ledger.invoices).toHaveLength(0);
  expect(ledger.payments).toHaveLength(0);
  expect(db.ledgerBalancesByCurrency(target.patientId, ledger, await db.patientPlanCurrencies(target.patientId)).YER.dueMinor).toBe(0);
  expect((await db.getPool().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'payment.create' AND details ->> 'المريض' = $1`,
    [String(target.patientId)],
  )).rows[0].n).toBe(0);
}

describe("inactive plan collection eligibility", () => {
  it("an active installment collection still produces a paid invoice without artificial credit", async () => {
    const target = await seed();
    expect(await db.isPlanFundedByAgreement(target.planId, target.patientId)).toBe(true);
    const response = await post("general", target, "active-installment-test");
    expect(response.status).toBe(201);
    const payment = await response.json();
    expect(payment.invoiceId).not.toBeNull();
    const ledger = await db.patientLedger(target.patientId);
    expect(ledger.invoices).toHaveLength(1);
    expect(ledger.payments).toHaveLength(1);
    expect(db.ledgerBalancesByCurrency(target.patientId, ledger, await db.patientPlanCurrencies(target.patientId)).YER.dueMinor).toBe(0);
  });

  it.each(["completed", "cancelled"] as const)("both endpoints refuse new collection on a %s agreement", async (status) => {
    const target = await seed(status);
    // Funding type never depends on lifecycle state.
    expect(await db.isPlanFundedByAgreement(target.planId, target.patientId)).toBe(true);
    for (const door of ["general", "dedicated"] as const) {
      const response = await post(door, target, `${door}-${status}-new`);
      expect(response.status).toBe(409);
      expect((await response.json()).message).toContain("الخطة غير جارية");
    }
    await assertNoFinancialWrites(target);
  });

  it.each(["completed", "cancelled"] as const)("canonical writers also refuse %s plans", async (status) => {
    const target = await seed(status);
    expect(await db.recordPlanInstallment({
      ...ordinary(target), installmentNumber: 1, planTitle: "Synthetic agreement", idempotencyKey: `service-${status}-new`,
    })).toEqual({ reason: "inactive_plan" });
    expect(await db.recordPayment({ ...ordinary(target), idempotencyKey: `ordinary-${status}-new` }))
      .toMatchObject({ reason: "inactive_plan", payment: null });
    await assertNoFinancialWrites(target);
  });

  it("a plain plan keeps its funding classification but cannot take new on-account receipts after closure", async () => {
    const target = await seed("active", false);
    expect(await db.isPlanFundedByAgreement(target.planId, target.patientId)).toBe(false);
    expect((await post("general", target, "plain-plan-first")).status).toBe(201);
    await close(target, "cancelled");
    expect(await db.isPlanFundedByAgreement(target.planId, target.patientId)).toBe(false);
    expect((await post("general", target, "plain-plan-new")).status).toBe(409);
    const replay = await post("general", target, "plain-plan-first");
    expect(replay.status).toBe(200);
    expect((await db.patientLedger(target.patientId)).payments).toHaveLength(1);
  });

  it.each(["completed", "cancelled"] as const)("both collection doors replay a prior receipt after %s without another write", async (status) => {
    for (const door of ["general", "dedicated"] as const) {
      const target = await seed();
      const key = `replay-${door}-${status}`;
      const first = await post(door, target, key);
      expect(first.status).toBe(201);
      const issued = await first.json();
      await close(target, status);
      const again = await post(door, target, key);
      expect(again.status).toBe(200);
      const replay = await again.json();
      expect(door === "general" ? replay.id : replay.paymentId).toBe(door === "general" ? issued.id : issued.paymentId);
      const changed = await post(door, target, key, "140000");
      expect(changed.status).toBe(409);
      expect((await changed.json()).message).toContain("مفتاح الإعادة");
      const ledger = await db.patientLedger(target.patientId);
      expect(ledger.invoices).toHaveLength(1);
      expect(ledger.payments).toHaveLength(1);
    }
  });

  it("historical refunds and original-target corrections remain valid; reversed installments require explicit recovery", async () => {
    const target = await seed();
    const first = await post("general", target, "historical-origin-test");
    expect(first.status).toBe(201);
    const receipt = await first.json();
    await close(target, "cancelled");
    const refund = await db.recordPayment({
      ...ordinary(target), planId: null, kind: "refund", amountMinor: 10000,
      reversalOfId: receipt.id, idempotencyKey: "historical-refund-test",
    });
    expect(refund.reason).toBeNull();
    expect(refund.payment).toMatchObject({ invoiceId: receipt.invoiceId, planId: target.planId, kind: "refund" });
    const correction = await db.correctPayment({
      paymentId: receipt.id, reason: "Synthetic correction", actor: "inactive-plan-test", actorRole: "admin",
      idempotencyKey: "historical-correction-test", replacement: {
        amountMinor: 140000, currency: "YER", exchangeRate: 1, method: "transfer", target: { kind: "original" },
      },
    });
    expect(correction.reason).toBeNull();
    if (correction.reason === null) expect(correction.replacement).toMatchObject({ invoiceId: receipt.invoiceId, planId: target.planId });
    const before = await db.patientLedger(target.patientId);
    const legacySettlement = await db.recordPayment({
      ...ordinary(target), planId: null, invoiceId: receipt.invoiceId, amountMinor: 10000, idempotencyKey: "historical-settlement-test",
    });
    expect(legacySettlement).toMatchObject({ reason: "issued_installment_recovery_required", payment: null });
    expect(await db.patientLedger(target.patientId)).toEqual(before);
    const settlement = await db.recordReversedInstallmentRecovery({
      purpose: "reversed-installment-recovery", patientId: target.patientId, invoiceId: receipt.invoiceId,
      amountMinor: 10000, currency: "YER", method: "cash", note: null,
      createdBy: "inactive-plan-test", actorRole: "admin", idempotencyKey: "historical-explicit-recovery-test",
    });
    expect(settlement.reason).toBeNull();
    expect(settlement.payment).toMatchObject({ invoiceId: receipt.invoiceId, planId: target.planId });
    const after = await db.patientLedger(target.patientId);
    expect(after.invoices).toHaveLength(1);
    expect(db.ledgerBalancesByCurrency(target.patientId, after, await db.patientPlanCurrencies(target.patientId)).YER.dueMinor).toBe(0);
  });

  it("an ordinary issued invoice on a closed plan remains collectible without a reversal recovery purpose", async () => {
    const target = await seed("active", false);
    const invoice = await db.createInvoice({ patientId: target.patientId, baseCurrency: "YER", discountMinor: 0,
      note: null, createdBy: "inactive-plan-test",
      items: [{ serviceId: null, doctorId: null, description: "Synthetic ordinary issued invoice", quantity: 1, unitPriceMinor: 10000 }] });
    if (!invoice) throw new Error("ordinary invoice missing");
    await db.getPool().query(`UPDATE invoices SET plan_id = $2 WHERE id = $1`, [invoice.id, target.planId]);
    await close(target, "cancelled");
    const settlement = await db.recordPayment({ ...ordinary(target), planId: null, invoiceId: invoice.id,
      amountMinor: 10000, idempotencyKey: "ordinary-inactive-issued-invoice" });
    expect(settlement.reason).toBeNull();
    expect(settlement.payment).toMatchObject({ invoiceId: invoice.id, planId: null });
    const ledger = await db.patientLedger(target.patientId);
    expect(ledger.invoices).toHaveLength(1); expect(ledger.payments).toHaveLength(1);
    expect(db.ledgerBalancesByCurrency(target.patientId, ledger, await db.patientPlanCurrencies(target.patientId)).YER.dueMinor).toBe(0);
  });

  it("an original-target correction of a historical plan-only receipt stays possible", async () => {
    const target = await seed("active", false);
    const first = await db.recordPayment({ ...ordinary(target), idempotencyKey: "plan-only-origin-test" });
    expect(first.payment).not.toBeNull();
    await close(target, "completed");
    const correction = await db.correctPayment({
      paymentId: first.payment!.id, reason: "Synthetic correction", actor: "inactive-plan-test", actorRole: "admin",
      idempotencyKey: "plan-only-correction-test", replacement: {
        amountMinor: 140000, currency: "YER", exchangeRate: 1, method: "cash", target: { kind: "original" },
      },
    });
    expect(correction.reason).toBeNull();
    if (correction.reason === null) expect(correction.replacement).toMatchObject({ invoiceId: null, planId: target.planId });
  });

  it("refuses a new explicit inactive-plan correction target atomically", async () => {
    const target = await seed("active", false);
    const first = await db.recordPayment({ ...ordinary(target), planId: null, idempotencyKey: "explicit-target-origin" });
    expect(first.payment).not.toBeNull();
    await close(target, "cancelled");
    const correction = await db.correctPayment({
      paymentId: first.payment!.id, reason: "Synthetic target correction", actor: "inactive-plan-test", actorRole: "admin",
      idempotencyKey: "explicit-inactive-target", replacement: {
        amountMinor: 140000, currency: "YER", exchangeRate: 1, method: "cash",
        target: { kind: "explicit", invoiceId: null, planId: target.planId, openingCurrency: null },
      },
    });
    expect(correction).toEqual({ reason: "inactive_plan" });
    const ledger = await db.patientLedger(target.patientId);
    expect(ledger.payments).toHaveLength(1);
    expect(ledger.payments[0]).toMatchObject({ id: first.payment!.id, kind: "payment", amountMinor: 150000, planId: null });
  });

  it("rechecks cancellation after the dedicated route's earlier active-plan snapshot", async () => {
    const target = await seed();
    const realGetPlan = db.getPlan;
    const read = vi.spyOn(db, "getPlan").mockImplementationOnce(async (...args) => {
      const snapshot = await realGetPlan(...args);
      await close(target, "cancelled");
      return snapshot;
    });
    try {
      expect((await post("dedicated", target, "interleaved-cancellation-test")).status).toBe(409);
      await assertNoFinancialWrites(target);
    } finally { read.mockRestore(); }
  });
});
