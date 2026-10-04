import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { REVERSED_INSTALLMENT_RECOVERY_PURPOSE as PURPOSE } from "../../lib/reversed-installment-recovery";
import { isBalanced, trialBalance } from "../../lib/accounting";
import type { Currency } from "../../lib/money";

assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
let sequence = 0;
let gate: Client;
let witness: Client;
async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await db.getPool().query(sql, values)).rows as T[];
}
async function rate(currency: "SAR" | "USD", value: string) {
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [`finance.rate.${currency}`, value]);
  db.invalidateSettingsCache();
}
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  await rate("SAR", "140"); await rate("USD", "530");
  await db.openShift({ openedBy: "recovery-test", opening: { YER: 0, SAR: 0, USD: 0 } });
  gate = new Client({ connectionString: process.env.DATABASE_URL!, ssl: false });
  witness = new Client({ connectionString: process.env.DATABASE_URL!, ssl: false });
  await gate.connect(); await witness.connect();
}, 180_000);
afterAll(async () => {
  await gate?.query("ROLLBACK").catch(() => {}); await gate?.end().catch(() => {});
  await witness?.end().catch(() => {}); await db.resetPoolForTesting();
});

async function issued(currency: Currency = "SAR", amountMinor = 7_000) {
  sequence += 1;
  const [{ id: patientId }] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic recovery patient') RETURNING id`, [`RECOVERY-${sequence}`]);
  const doctor = await db.createParty({ name: `Synthetic recovery doctor ${sequence}`, kind: "doctor", phone: null, commissionPercent: 30, note: null });
  const [{ id: planId }] = await q<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, billing_mode, start_date, primary_doctor_id)
     VALUES ($1, 'Synthetic orthodontic agreement', $2, $3, 'active', 'installments', '2026-01-01', $4) RETURNING id`,
    [patientId, amountMinor * 2, currency, doctor.id]);
  await q(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
    VALUES ($1, 1, '2026-01-01', $2), ($1, 2, '2026-02-01', $2)`, [planId, amountMinor]);
  const request = {
    patientId, planId, installmentNumber: 1, planTitle: "Synthetic orthodontic agreement", amountMinor,
    currency, baseCurrency: "YER" as const, exchangeRate: currency === "SAR" ? 140 : currency === "USD" ? 530 : 1,
    method: "cash", note: null, createdBy: "recovery-test", actorRole: "reception", idempotencyKey: `recovery-origin-${sequence}`,
  };
  const made = await db.recordPlanInstallment(request);
  if (!("paymentId" in made)) throw new Error(`installment refused: ${made.reason}`);
  return { patientId, planId, doctorId: doctor.id, currency, amountMinor, request, ...made };
}
type Issued = Awaited<ReturnType<typeof issued>>;
async function refund(target: Issued, amountMinor = target.amountMinor, originId = target.paymentId) {
  const result = await db.recordPayment({ patientId: target.patientId, invoiceId: null, kind: "refund", amountMinor,
    currency: target.currency, baseCurrency: "YER", exchangeRate: 999, method: "cash", note: "Synthetic reversal",
    createdBy: "recovery-admin", reversalOfId: originId });
  if (result.reason !== null || !result.payment) throw new Error(`refund refused: ${result.reason}`);
  return result.payment;
}
function recovery(target: Issued, key: string, amountMinor = target.amountMinor) {
  return { purpose: PURPOSE, patientId: target.patientId, invoiceId: target.invoiceId, amountMinor,
    currency: target.currency, method: "cash" as const, note: null, createdBy: "recovery-test", actorRole: "reception", idempotencyKey: key };
}
async function due(target: Issued) {
  const ledger = await db.patientLedger(target.patientId);
  return db.ledgerBalancesByCurrency(target.patientId, ledger, await db.patientPlanCurrencies(target.patientId))[target.currency].dueMinor;
}
async function drawer() {
  const open = await db.getOpenShift(); if (!open) throw new Error("missing open shift"); return open.expected;
}
async function commission(doctorId: number, currency: Currency) {
  return (await db.commissionReport("2000-01-01", "2099-12-31"))
    .filter((row) => row.doctorId === doctorId && row.currency === currency).reduce((total, row) => total + row.earnedMinor, 0);
}
async function audits(paymentId: number) {
  return q<{ details: Record<string, unknown> }>(`SELECT details FROM audit_log WHERE action = 'payment.recover_installment' AND entity_id = $1`, [String(paymentId)]);
}
async function invoiceSource(target: Issued) {
  return { invoice: await q(`SELECT * FROM invoices WHERE id = $1`, [target.invoiceId]),
    items: await q(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [target.invoiceId]) };
}
/** Independent autocommit witness, matching the repository's TD05 lock-order pattern. */
async function waiting(pattern: string, minimum = 1) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { rows: [row] } = await witness.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()
       AND wait_event_type = 'Lock' AND query LIKE $1`, [pattern]);
    if (row.count >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No deterministic lock witness for ${pattern}`);
}

describe("explicit issued-installment recovery on canonical PostgreSQL", () => {
  it("reverses and recollects once: original provider/invoice, plan, SAR drawer and commission remain coherent under concurrent duplicate attempts", async () => {
    const beforeDrawer = await drawer();
    const target = await issued();
    expect(await commission(target.doctorId, "SAR")).toBe(2_100);
    const source = await invoiceSource(target);
    const reversed = await refund(target);
    const [creation] = await q<{ id: string }>(`SELECT id FROM audit_log WHERE action = 'payment.create' AND entity_id = $1`, [String(target.paymentId)]);
    expect(typeof creation.id).toBe("string"); // canonical PG BIGSERIAL wire shape, not the pure fixture's number
    expect((await db.patientReversedInstallmentRecoveries(target.patientId)).recoveries[0])
      .toMatchObject({ creationAuditId: Number(creation.id), invoiceId: target.invoiceId, planId: target.planId });
    expect(await due(target)).toBe(7_000);
    expect(await commission(target.doctorId, "SAR")).toBe(0);
    const oldRows = await q(`SELECT * FROM payments WHERE id = ANY($1::int[]) ORDER BY id`, [[target.paymentId, reversed.id]]);
    const other = await db.createParty({ name: "Synthetic later plan doctor", kind: "doctor", phone: null, commissionPercent: 50, note: null });
    await q(`UPDATE treatment_plans SET primary_doctor_id = $2 WHERE id = $1`, [target.planId, other.id]);
    const request = recovery(target, "recovery-five-identical");
    const results = await Promise.all(Array.from({ length: 5 }, () => db.recordReversedInstallmentRecovery(request)));
    expect(results.every((result) => result.reason === null)).toBe(true);
    const ids = new Set(results.map((result) => result.payment?.id)); expect(ids.size).toBe(1);
    const payment = results[0].payment!;
    expect(payment).toMatchObject({ invoiceId: target.invoiceId, planId: target.planId, amountMinor: 7_000, currency: "SAR" });
    expect(results.filter((result) => result.replayed)).toHaveLength(4);
    expect(await audits(payment.id)).toHaveLength(1);
    expect((await db.recordReversedInstallmentRecovery(request)).payment?.id).toBe(payment.id);
    expect(await audits(payment.id)).toHaveLength(1);
    expect(await due(target)).toBe(0);
    expect((await db.getPlan(target.planId, "2026-03-01"))?.paidMinor).toBe(7_000);
    expect((await db.patientLedger(target.patientId)).invoices).toHaveLength(1);
    expect(await invoiceSource(target)).toEqual(source);
    expect(await q(`SELECT * FROM payments WHERE id = ANY($1::int[]) ORDER BY id`, [[target.paymentId, reversed.id]])).toEqual(oldRows);
    expect(await commission(target.doctorId, "SAR")).toBe(2_100); // One final collection, never doubled.
    expect(await commission(other.id, "SAR")).toBe(0); // Current plan doctor cannot take the original provider's receipt.
    const afterDrawer = await drawer();
    expect(afterDrawer.SAR - beforeDrawer.SAR).toBe(7_000);
    expect(afterDrawer.YER).toBe(beforeDrawer.YER); expect(afterDrawer.USD).toBe(beforeDrawer.USD);
    const entries = await db.journalEntries("2000-01-01", "2099-12-31");
    expect(entries.every(isBalanced)).toBe(true);
    const trial = trialBalance(entries);
    for (const currency of ["YER", "SAR", "USD"] as const) {
      const bucket = trial.filter((row) => row.currency === currency);
      expect(bucket.reduce((sum, row) => sum + row.debitMinor, 0)).toBe(bucket.reduce((sum, row) => sum + row.creditMinor, 0));
    }
  });

  it("recovers only the partial reversed remainder and preserves both IDs when that recovery is refunded", async () => {
    const target = await issued(); await refund(target, 2_000);
    const read = await db.patientReversedInstallmentRecoveries(target.patientId);
    expect(read.recoveries[0]).toMatchObject({ invoiceId: target.invoiceId, remainingMinor: 2_000, suggestedCashMinor: 2_000 });
    expect((await db.recordReversedInstallmentRecovery(recovery(target, "recovery-too-large", 2_001))).reason).toBe("recovery_exceeds_remaining");
    const first = await db.recordReversedInstallmentRecovery(recovery(target, "recovery-partial-a", 1_000));
    expect(first.reason).toBeNull(); expect(await due(target)).toBe(1_000);
    const reversed = await refund(target, 500, first.payment!.id);
    expect(reversed).toMatchObject({ invoiceId: target.invoiceId, planId: target.planId, exchangeRate: 140 });
    expect(await due(target)).toBe(1_500);
    expect((await db.patientReversedInstallmentRecoveries(target.patientId)).recoveries[0].remainingMinor).toBe(1_500);
  });

  it("refuses another installment invoice for the proven debt; old installment success remains replayable", async () => {
    const target = await issued(); await refund(target);
    const before = await db.patientLedger(target.patientId); const cash = await drawer();
    expect(await db.recordPlanInstallment({ ...target.request, idempotencyKey: "recovery-do-not-reinvoice" }))
      .toEqual({ reason: "issued_installment_recovery_required", recoveryInvoiceIds: [target.invoiceId] });
    expect(await db.patientLedger(target.patientId)).toEqual(before); expect(await drawer()).toEqual(cash);
    expect(await db.recordPlanInstallment(target.request)).toMatchObject({ invoiceId: target.invoiceId, paymentId: target.paymentId, replayed: true });
  });

  it("rolls back receipt, plan, drawer and projection if the atomic recovery audit fails", async () => {
    const target = await issued(); await refund(target);
    const before = await db.patientLedger(target.patientId); const cash = await drawer();
    await q(`ALTER TABLE audit_log ADD CONSTRAINT recovery_test_block CHECK (action <> 'payment.recover_installment') NOT VALID`);
    try { await expect(db.recordReversedInstallmentRecovery(recovery(target, "recovery-audit-failure"))).rejects.toThrow(); }
    finally { await q(`ALTER TABLE audit_log DROP CONSTRAINT recovery_test_block`); }
    expect(await db.patientLedger(target.patientId)).toEqual(before); expect(await drawer()).toEqual(cash);
    expect((await db.getPlan(target.planId, "2026-03-01"))?.paidMinor).toBe(0);
    expect((await db.patientReversedInstallmentRecoveries(target.patientId)).recoveries[0].remainingMinor).toBe(7_000);
  });

  it.each(["completed", "cancelled"] as const)("settles its already issued invoice after plan %s", async (status) => {
    const target = await issued(); await refund(target);
    await db.setPlanStatus(target.planId, status, { actor: "recovery-admin", actorRole: "admin", reason: "Synthetic closure" });
    const result = await db.recordReversedInstallmentRecovery(recovery(target, `recovery-inactive-${status}`));
    expect(result.reason).toBeNull(); expect(result.payment).toMatchObject({ invoiceId: target.invoiceId, planId: target.planId });
  });

  it("replays stored FX after settings, invoice and plan changes and a closed shift", async () => {
    const target = await issued(); await refund(target);
    const request = recovery(target, "recovery-stored-context");
    const first = await db.recordReversedInstallmentRecovery(request); expect(first.reason).toBeNull();
    const shift = await db.getOpenShift(); if (!shift) throw new Error("no shift");
    await rate("SAR", "0");
    await db.setPlanStatus(target.planId, "completed", { actor: "recovery-admin", actorRole: "admin" });
    await db.setInvoiceStatus(target.invoiceId, "cancelled", { actor: "recovery-admin", actorRole: "admin" });
    expect((await db.closeShift({ id: shift.id, closedBy: "recovery-test", counted: shift.expected, note: "Synthetic closure" })).reason).toBeNull();
    try {
      const replay = await db.recordReversedInstallmentRecovery(request);
      expect(replay).toMatchObject({ reason: null, replayed: true });
      expect(replay.payment).toEqual(first.payment);
      expect(await audits(first.payment!.id)).toHaveLength(1);
    } finally {
      await rate("SAR", "140");
      await db.openShift({ openedBy: "recovery-test", opening: { YER: 0, SAR: 0, USD: 0 } });
    }
  });

  it("a lookup miss followed by the competing commit still replays before a settled-state refusal", async () => {
    const target = await issued(); await refund(target);
    const request = recovery(target, "recovery-lookup-miss-commit");
    const pool = db.getPool();
    const pausedClient = await pool.connect();
    const originalQuery = pausedClient.query.bind(pausedClient);
    let releaseLookup!: () => void;
    const holdLookup = new Promise<void>((resolve) => { releaseLookup = resolve; });
    let signalMiss!: () => void;
    let signalFailure!: (error: unknown) => void;
    const sawMiss = new Promise<void>((resolve, reject) => { signalMiss = resolve; signalFailure = reject; });
    let intercepted = false;
    const querySpy = vi.spyOn(pausedClient, "query").mockImplementation(async (sql, values) => {
      const result = await originalQuery(sql, values);
      if (!intercepted && sql.includes("FROM payments WHERE idempotency_key = $1") && values?.[0] === request.idempotencyKey) {
        intercepted = true; expect(result.rows).toHaveLength(0); signalMiss(); await holdLookup;
      }
      return result;
    });
    // Only this service acquisition is redirected; later pool/query acquisitions use the original implementation.
    const connectSpy = vi.spyOn(pool, "connect").mockResolvedValueOnce(pausedClient);
    const retry = db.recordReversedInstallmentRecovery(request); void retry.catch(signalFailure);
    try {
      await sawMiss;
      // The captured invocation is still awaiting holdLookup. Restore both spies
      // now, before either writer can release a client that Pool.query may reuse
      // through its callback overload during postcommit hydration.
      querySpy.mockRestore(); connectSpy.mockRestore();
      const winner = await db.recordReversedInstallmentRecovery(request); expect(winner.reason).toBeNull();
      releaseLookup();
      const replay = await retry;
      expect(replay).toMatchObject({ reason: null, replayed: true });
      expect(replay.payment?.id).toBe(winner.payment?.id); expect(await audits(winner.payment!.id)).toHaveLength(1);
    } finally { releaseLookup(); await retry.catch(() => {}); querySpy.mockRestore(); connectSpy.mockRestore(); }
  });

  it("five exact recovery attempts replay after an invoice snapshot misses a concurrently committed unrelated receipt", async () => {
    const target = await issued(); await refund(target);
    const request = recovery(target, "recovery-invoice-snapshot-commit");
    const pool = db.getPool(); const paused = await pool.connect(); const realQuery = paused.query.bind(paused);
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    let observed!: () => void; let failed!: (error: unknown) => void;
    const sawSnapshot = new Promise<void>((resolve, reject) => { observed = resolve; failed = reject; });
    let intercepted = false;
    const querySpy = vi.spyOn(paused, "query").mockImplementation(async (sql, values) => {
      const result = await realQuery(sql, values);
      if (!intercepted && sql.includes("total_minor::text, discount_minor::text, base_currency")
        && sql.includes("FROM invoices WHERE patient_id = $1 ORDER BY id") && values?.[0] === target.patientId) {
        intercepted = true; observed(); await held;
      }
      return result;
    });
    const connectSpy = vi.spyOn(pool, "connect").mockResolvedValueOnce(paused);
    const retry = db.recordReversedInstallmentRecovery(request); void retry.catch(failed);
    try {
      await sawSnapshot; querySpy.mockRestore(); connectSpy.mockRestore();
      const winner = await db.recordReversedInstallmentRecovery(request);
      expect(winner.reason).toBeNull();
      // Recovery creates no invoice. A separate canonical invoice+receipt (net0)
      // creates the actual mixed-snapshot error without changing original lineage.
      const spectatorInvoiceId = await unrelatedPaidInvoice(target);
      const others = await Promise.all(Array.from({ length: 3 }, () => db.recordReversedInstallmentRecovery(request)));
      release(); const results = [winner, ...others, await retry];
      const [counts] = await q<{ payments: number; invoices: number }>(`SELECT
        (SELECT COUNT(*)::int FROM payments WHERE idempotency_key = $1) AS payments,
        (SELECT COUNT(*)::int FROM invoices WHERE plan_id = $2) AS invoices`, [request.idempotencyKey, target.planId]);
      const auditCount = winner.payment ? (await audits(winner.payment.id)).length : 0;
      const observations = results.map((result) => ({ reason: result.reason, paymentId: result.payment?.id ?? null,
        invoiceId: result.payment?.invoiceId ?? null, planId: result.payment?.planId ?? null, replayed: result.replayed ?? false }));
      console.info("REPLAY_SNAPSHOT_WITNESS", JSON.stringify({ operation: "recovery", results: observations, counts, auditCount, spectatorInvoiceId }));
      expect(new Set(observations.map((result) => result.paymentId)).size, JSON.stringify(observations)).toBe(1);
      expect(observations.every((result) => result.reason === null && result.paymentId !== null && result.invoiceId === target.invoiceId && result.planId === target.planId)).toBe(true);
      expect(observations.filter((result) => result.replayed)).toHaveLength(4);
      expect(counts).toEqual({ payments: 1, invoices: 1 }); expect(auditCount).toBe(1); expect(await due(target)).toBe(0);
      expect((await db.patientLedger(target.patientId)).invoices.map((invoice) => invoice.id).sort((a, b) => a - b))
        .toEqual([target.invoiceId, spectatorInvoiceId].sort((a, b) => a - b));
    } finally { release(); await retry.catch(() => {}); querySpy.mockRestore(); connectSpy.mockRestore(); }
  });

  it("refuses a new FX snapshot rounded to zero without leaving a receipt or audit", async () => {
    const target = await issued(); await refund(target);
    const before = await db.patientLedger(target.patientId); const cash = await drawer();
    await rate("SAR", "0.0000001");
    try {
      expect((await db.recordReversedInstallmentRecovery(recovery(target, "recovery-tiny-fx-refusal"))).reason).toBe("exchange_rate_required");
      expect(await db.patientLedger(target.patientId)).toEqual(before); expect(await drawer()).toEqual(cash);
    } finally { await rate("SAR", "140"); }
  });


  it("preserves successful old invoice-only replay while refusing new unsafe recollection", async () => {
    const target = await issued();
    const ordinary = { patientId: target.patientId, invoiceId: target.invoiceId, kind: "payment" as const, amountMinor: 1_000,
      currency: "SAR" as const, baseCurrency: "YER" as const, exchangeRate: 140, method: "cash", note: null,
      createdBy: "recovery-test", idempotencyKey: "ordinary-before-recovery" };
    const original = await db.recordPayment(ordinary); expect(original.payment?.planId).toBeNull();
    await refund(target);
    expect((await db.recordPayment(ordinary)).replayed).toBe(true);
    expect((await db.recordPayment({ ...ordinary, idempotencyKey: "ordinary-new-unsafe-recollection" })).reason)
      .toBe("installment_recovery_review_required");
    expect((await db.recordReversedInstallmentRecovery(recovery(target, ordinary.idempotencyKey, 1_000))).reason).toBe("idempotency_conflict");
    expect((await db.recordReversedInstallmentRecovery(recovery(target, target.request.idempotencyKey))).reason).toBe("idempotency_conflict");
    expect((await db.recordReversedInstallmentRecovery(recovery(target, "review-lost-historical-plan"))).reason).toBe("recovery_review_required");
  });


  it("legacy invoice-only, plan-only and ambiguous YER account collections refuse a reversed installment without posting", async () => {
    const target = await issued("YER"); await refund(target);
    const before = await db.patientLedger(target.patientId); const cash = await drawer();
    for (const [label, invoiceId, planId] of [["invoice", target.invoiceId, null], ["plan", null, target.planId], ["account", null, null]] as const) {
      const result = await db.recordPayment({ patientId: target.patientId, invoiceId, planId, kind: "payment", amountMinor: 7_000,
        currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "recovery-test",
        idempotencyKey: `legacy-no-purpose-${label}` });
      expect(result).toEqual({ payment: null, reason: "issued_installment_recovery_required" });
    }
    expect(await db.patientLedger(target.patientId)).toEqual(before); expect(await drawer()).toEqual(cash);
    expect((await db.recordReversedInstallmentRecovery(recovery(target, "explicit-after-containment"))).reason).toBeNull();
  });

  it("ordinary unaffected invoice and on-account payments remain accepted", async () => {
    const target = await issued("YER"); // No reversal: the new containment does not reinterpret paid status.
    const base = { patientId: target.patientId, kind: "payment" as const, amountMinor: 100, currency: "YER" as const,
      baseCurrency: "YER" as const, exchangeRate: 1, method: "cash", note: null, createdBy: "recovery-test" };
    expect((await db.recordPayment({ ...base, invoiceId: target.invoiceId, idempotencyKey: "ordinary-unaffected-invoice" })).reason).toBeNull();
    expect((await db.recordPayment({ ...base, invoiceId: null, idempotencyKey: "ordinary-unaffected-account" })).reason).toBeNull();
  });

  it("an outstanding SAR recovery does not capture unrelated explicit targets or the YER account bucket", async () => {
    const target = await issued(); await refund(target);
    const invoice = await db.createInvoice({ patientId: target.patientId, baseCurrency: "SAR", discountMinor: 0, note: null, createdBy: "recovery-test",
      items: [{ serviceId: null, doctorId: null, description: "Synthetic unrelated target", quantity: 1, unitPriceMinor: 1_000 }] });
    if (!invoice) throw new Error("missing unrelated invoice");
    const base = { patientId: target.patientId, kind: "payment" as const, amountMinor: 1_000, currency: "SAR" as const,
      baseCurrency: "YER" as const, exchangeRate: 140, method: "cash", note: null, createdBy: "recovery-test" };
    expect((await db.recordPayment({ ...base, invoiceId: invoice.id, idempotencyKey: "unrelated-explicit-invoice" })).reason).toBeNull();
    const [{ id: otherPlan }] = await q<{ id: number }>(`INSERT INTO treatment_plans
      (patient_id, title, total_minor, base_currency, status, billing_mode, start_date)
      VALUES ($1, 'Synthetic unrelated per-procedure plan', 1000, 'SAR', 'active', 'per_procedure', '2026-01-01') RETURNING id`, [target.patientId]);
    expect((await db.recordPayment({ ...base, invoiceId: null, planId: otherPlan, idempotencyKey: "unrelated-explicit-plan" })).reason).toBeNull();
    await db.setPatientOpeningBalance({ patientId: target.patientId, currency: "SAR", amountMinor: 1_000,
      asOfDate: "2026-01-01", note: "Synthetic explicit opening", createdBy: "recovery-admin" });
    expect((await db.recordPayment({ ...base, invoiceId: null, openingCurrency: "SAR", idempotencyKey: "unrelated-explicit-opening" })).reason).toBeNull();
    expect((await db.recordPayment({ ...base, invoiceId: null, amountMinor: 100, currency: "YER", exchangeRate: 1,
      idempotencyKey: "unrelated-yer-bucket" })).reason).toBeNull();
    const ledger = await db.patientLedger(target.patientId);
    const balances = db.ledgerBalancesByCurrency(target.patientId, ledger, await db.patientPlanCurrencies(target.patientId));
    expect(balances.YER.dueMinor).toBe(-100); expect(balances.SAR.dueMinor).toBe(6_000);
    expect((await db.patientReversedInstallmentRecoveries(target.patientId)).recoveries[0]).toMatchObject({ invoiceId: target.invoiceId, remainingMinor: 7_000 });
  });

  it("conflicts for changed intent/actor and refuses fabricated dual targets", async () => {
    const target = await issued(); await refund(target);
    const request = recovery(target, "recovery-intent-binding", 1_000);
    expect((await db.recordReversedInstallmentRecovery(request)).reason).toBeNull();
    for (const change of [{ amountMinor: 999 }, { invoiceId: target.invoiceId + 999 }, { currency: "USD" as const },
      { createdBy: "another-actor" }, { method: "transfer" as const }, { note: "Changed intent" }]) {
      expect((await db.recordReversedInstallmentRecovery({ ...request, ...change })).reason).toBe("idempotency_conflict");
    }
    const fabricated = { ...request, idempotencyKey: "recovery-fabricated-plan", planId: target.planId };
    expect((await db.recordReversedInstallmentRecovery(fabricated)).reason).toBe("invalid_recovery_request");
  });

  it("cannot disguise a recovery key as legacy correction replay, but can correct the recovery with its own new key", async () => {
    const target = await issued(); const origin = await db.getPayment(target.paymentId); if (!origin) throw new Error("missing original receipt");
    const why = "Synthetic exact-note collision";
    expect((await db.correctPayment({ paymentId: target.paymentId, reason: why, actor: "recovery-test", actorRole: "admin", replacement: null })).reason).toBeNull();
    const request = { ...recovery(target, "recovery-purpose-note-collision"), note: `بدل السند ${origin.receiptNumber}`, actorRole: "admin" };
    const recovered = await db.recordReversedInstallmentRecovery(request); expect(recovered.reason).toBeNull();
    expect((await db.correctPayment({ paymentId: target.paymentId, reason: why, actor: "recovery-test", actorRole: "admin",
      idempotencyKey: request.idempotencyKey, replacement: { amountMinor: 7_000, currency: "SAR", exchangeRate: 140,
        method: "cash", target: { kind: "original" } } })).reason).toBe("idempotency_conflict");
    const correction = { paymentId: recovered.payment!.id, reason: "Synthetic later correction", actor: "recovery-test", actorRole: "admin",
      idempotencyKey: "correct-recovery-own-new-key", replacement: { amountMinor: 6_000, currency: "SAR" as const, exchangeRate: 140,
        method: "cash", target: { kind: "original" as const } } };
    const first = await db.correctPayment(correction); const replay = await db.correctPayment(correction);
    expect(first.reason).toBeNull(); expect(replay.reason).toBeNull();
    if (first.reason !== null || replay.reason !== null) throw new Error("correction refused");
    expect(replay.replayed).toBe(true); expect(replay.replacement?.id).toBe(first.replacement?.id);
    expect(first.replacement).toMatchObject({ invoiceId: target.invoiceId, planId: target.planId });
    expect(await due(target)).toBe(1_000);
  });

  it("an explicit invoice-only correction cannot discard installment attribution; original-target paired correction remains atomic", async () => {
    const target = await issued(); const before = await db.patientLedger(target.patientId); const cash = await drawer();
    const request = { paymentId: target.paymentId, reason: "Synthetic correction association", actor: "recovery-test", actorRole: "admin",
      idempotencyKey: "correction-keep-installment-source", replacement: { amountMinor: 6_000, currency: "SAR" as const,
        exchangeRate: 140, method: "cash", target: { kind: "explicit" as const, invoiceId: target.invoiceId, planId: null, openingCurrency: null } } };
    expect((await db.correctPayment(request)).reason).toBe("issued_installment_recovery_required");
    expect(await db.patientLedger(target.patientId)).toEqual(before); expect(await drawer()).toEqual(cash);
    const corrected = await db.correctPayment({ ...request, replacement: { ...request.replacement, target: { kind: "original" } } });
    expect(corrected.reason).toBeNull();
    if (corrected.reason !== null) throw new Error(corrected.reason);
    expect(corrected.replacement).toMatchObject({ invoiceId: target.invoiceId, planId: target.planId, amountMinor: 6_000 });
    expect(await due(target)).toBe(1_000);
  });

  it("an original-target correction cannot append another unattributed receipt to historical installment ambiguity", async () => {
    const target = await issued();
    const prior = await db.recordPayment({ patientId: target.patientId, invoiceId: target.invoiceId, kind: "payment", amountMinor: 1_000,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 140, method: "cash", note: null, createdBy: "recovery-test" });
    if (!prior.payment) throw new Error("historical invoice-only receipt missing");
    expect(prior.payment.planId).toBeNull(); await refund(target);
    expect((await db.patientReversedInstallmentRecoveries(target.patientId)).reviews).toHaveLength(1);
    const before = await db.patientLedger(target.patientId); const cash = await drawer();
    const auditBefore = await q(`SELECT id FROM audit_log ORDER BY id`);
    const result = await db.correctPayment({ paymentId: prior.payment.id, reason: "Synthetic historical ambiguity correction",
      actor: "recovery-test", actorRole: "admin", idempotencyKey: "correction-original-missing-plan",
      replacement: { amountMinor: 500, currency: "SAR", exchangeRate: 140, method: "cash", target: { kind: "original" } } });
    expect(result.reason).toBe("installment_recovery_review_required");
    expect(await db.patientLedger(target.patientId)).toEqual(before); expect(await drawer()).toEqual(cash);
    expect(await q(`SELECT id FROM audit_log ORDER BY id`)).toEqual(auditBefore);
  });

  it("uses recorded foreign settlement for an original YER invoice and rejects unsupported foreign-to-foreign recollection", async () => {
    const target = await issued("YER", 9_800);
    await refund(target);
    const request = { ...recovery(target, "recovery-yer-via-sar", 7_000), currency: "SAR" as const };
    const result = await db.recordReversedInstallmentRecovery(request);
    expect(result.reason).toBeNull(); expect(result.payment).toMatchObject({ amountMinor: 7_000, baseAmountMinor: 9_800, planId: target.planId });
    expect(await due(target)).toBe(0);
    const sar = await issued(); await refund(sar);
    expect((await db.recordReversedInstallmentRecovery({ ...recovery(sar, "recovery-no-sar-usd"), currency: "USD" })).reason).toBe("cross_currency_not_supported");
  });

  it("recovers USD in its own currency without altering the YER/SAR drawers", async () => {
    const before = await drawer(); const target = await issued("USD"); await refund(target);
    const result = await db.recordReversedInstallmentRecovery(recovery(target, "recovery-usd-original"));
    expect(result.reason).toBeNull(); expect(result.payment).toMatchObject({ currency: "USD", amountMinor: 7_000, planId: target.planId });
    const after = await drawer(); expect(after.USD - before.USD).toBe(7_000);
    expect(after.YER).toBe(before.YER); expect(after.SAR).toBe(before.SAR); expect(await due(target)).toBe(0);
  });

  it.each([7_000, 5_000])("the real adapter includes a paired correction replacement of %i before computing remaining", async (amountMinor) => {
    const target = await issued();
    const corrected = await db.correctPayment({ paymentId: target.paymentId, reason: "Synthetic paired correction", actor: "recovery-admin",
      replacement: { amountMinor, currency: "SAR", exchangeRate: 140, method: "cash", target: { kind: "original" } } });
    expect(corrected.reason).toBeNull();
    const read = await db.patientReversedInstallmentRecoveries(target.patientId);
    if (amountMinor === 7_000) expect(read.recoveries).toHaveLength(0);
    else expect(read.recoveries[0]).toMatchObject({ invoiceId: target.invoiceId, remainingMinor: 2_000 });
  });

  it.each(["manual", "replacement"] as const)("does not globally block new installments for unrelated %s invoice-only refund history", async (mode) => {
    const target = await issued();
    let invoiceId: number;
    if (mode === "manual") {
      const manual = await db.createInvoice({ patientId: target.patientId, baseCurrency: "SAR", discountMinor: 0, note: null, createdBy: "recovery-admin",
        items: [{ serviceId: null, doctorId: target.doctorId, description: "Synthetic unrelated document", quantity: 1, unitPriceMinor: 1_000 }] });
      if (!manual) throw new Error("manual invoice missing"); invoiceId = manual.id;
      await q(`UPDATE invoices SET plan_id = $2 WHERE id = $1`, [invoiceId, target.planId]);
      await db.setInvoiceStatus(invoiceId, "paid", { actor: "recovery-admin", actorRole: "admin" });
    } else {
      const source = await db.getInvoice(target.invoiceId); if (!source) throw new Error("source invoice missing");
      const replacement = await db.correctInvoice({ invoiceId: target.invoiceId, reason: "Synthetic replacement document", actor: "recovery-admin", actorRole: "admin",
        lines: [{ itemId: source.items[0].id, quantity: 1, unitPriceMinor: 5_000 }] });
      if (!replacement.ok) throw new Error(replacement.message); invoiceId = replacement.corrected.id;
    }
    const paid = await db.recordPayment({ patientId: target.patientId, invoiceId, kind: "payment", amountMinor: 1_000,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 140, method: "cash", note: null, createdBy: "recovery-test" });
    if (!paid.payment) throw new Error("ordinary receipt missing");
    expect(paid.payment.planId).toBeNull();
    expect((await db.recordPayment({ patientId: target.patientId, invoiceId: null, kind: "refund", amountMinor: 1_000,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 999, method: "cash", note: null, createdBy: "recovery-admin", reversalOfId: paid.payment.id })).reason).toBeNull();
    const read = await db.patientReversedInstallmentRecoveries(target.patientId);
    expect(read.recoveries).toHaveLength(0); expect(read.reviews).toHaveLength(0);
    const statusBefore = (await db.getInvoice(invoiceId))?.status;
    const ordinary = await db.recordPayment({ patientId: target.patientId, invoiceId, kind: "payment", amountMinor: 500,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 140, method: "cash", note: null, createdBy: "recovery-test",
      idempotencyKey: `ordinary-after-its-refund-${mode}` });
    expect(ordinary.reason).toBeNull(); if (!ordinary.payment) throw new Error("ordinary replacement missing");
    const corrected = await db.correctPayment({ paymentId: ordinary.payment.id, reason: "Synthetic ordinary original-target correction",
      actor: "recovery-test", actorRole: "admin", idempotencyKey: `ordinary-inherited-correction-${mode}`,
      replacement: { amountMinor: 400, currency: "SAR", exchangeRate: 140, method: "cash", target: { kind: "original" } } });
    expect(corrected.reason).toBeNull();
    if (corrected.reason !== null) throw new Error(corrected.reason);
    expect(corrected.replacement).toMatchObject({ invoiceId, planId: null, amountMinor: 400 });
    const fresh = await db.recordPlanInstallment({ ...target.request, amountMinor: 500, idempotencyKey: `recovery-unrelated-${mode}` });
    expect("paymentId" in fresh).toBe(true);
    expect((await db.getInvoice(invoiceId))?.status).toBe(statusBefore);
  });

  it("distinct-key full recoveries serialize: one receipt, one explicit remaining-state refusal, no duplicate principal", async () => {
    const target = await issued(); await refund(target);
    let first: ReturnType<typeof db.recordReversedInstallmentRecovery> | undefined;
    let second: ReturnType<typeof db.recordReversedInstallmentRecovery> | undefined;
    await gate.query("BEGIN"); await gate.query(`SELECT id FROM cashier_shifts WHERE status = 'open' FOR UPDATE`);
    try {
      first = db.recordReversedInstallmentRecovery(recovery(target, "recovery-race-one")); void first.catch(() => {});
      await waiting("%FROM cashier_shifts%FOR UPDATE%");
      second = db.recordReversedInstallmentRecovery(recovery(target, "recovery-race-two")); void second.catch(() => {});
      await waiting("%FROM payments WHERE id =%FOR UPDATE%");
      await gate.query("COMMIT");
      const results = await Promise.all([first, second]);
      expect(results.filter((result) => result.reason === null)).toHaveLength(1);
      expect(results.filter((result) => result.reason === "recovery_not_available")).toHaveLength(1);
      expect((await db.patientLedger(target.patientId)).payments).toHaveLength(3);
      expect((await db.patientLedger(target.patientId)).invoices).toHaveLength(1); expect(await due(target)).toBe(0);
    } finally { await gate.query("ROLLBACK").catch(() => {}); await Promise.allSettled([first, second].filter((p) => p !== undefined)); }
  });

  it("two partial recoveries may both commit within the one locked remainder", async () => {
    const target = await issued(); await refund(target);
    const results = await Promise.all([db.recordReversedInstallmentRecovery(recovery(target, "recovery-parts-one", 3_000)),
      db.recordReversedInstallmentRecovery(recovery(target, "recovery-parts-two", 4_000))]);
    expect(results.every((result) => result.reason === null)).toBe(true);
    expect(await due(target)).toBe(0); expect((await db.patientLedger(target.patientId)).invoices).toHaveLength(1);
  });

  it("a refund and recovery of the same original serialize without losing sums or reversing lock order", async () => {
    const target = await issued(); await refund(target, 2_000);
    let reversing: ReturnType<typeof refund> | undefined;
    let recovering: ReturnType<typeof db.recordReversedInstallmentRecovery> | undefined;
    await gate.query("BEGIN"); await gate.query(`SELECT id FROM payments WHERE id = $1 FOR UPDATE`, [target.paymentId]);
    try {
      reversing = refund(target, 5_000); void reversing.catch(() => {});
      await waiting("%FROM payments WHERE id =%FOR UPDATE%");
      recovering = db.recordReversedInstallmentRecovery(recovery(target, "recovery-refund-race", 2_000)); void recovering.catch(() => {});
      await waiting("%FROM payments WHERE id =%FOR UPDATE%", 2);
      await gate.query("COMMIT");
      await reversing;
      const result = await recovering; expect(result.reason).toBeNull();
      expect(await due(target)).toBe(5_000);
      expect((await db.getPlan(target.planId, "2026-03-01"))?.paidMinor).toBe(2_000);
      expect(await commission(target.doctorId, "SAR")).toBe(600);
      expect(await audits(result.payment!.id)).toHaveLength(1);
    } finally { await gate.query("ROLLBACK").catch(() => {}); await Promise.allSettled([reversing, recovering].filter((p) => p !== undefined)); }
  });

  it("a shift close queued first prevents a new recovery in the closed drawer", async () => {
    const target = await issued(); await refund(target);
    const shift = await db.getOpenShift(); if (!shift) throw new Error("no shift");
    let closing: ReturnType<typeof db.closeShift> | undefined;
    let recovering: ReturnType<typeof db.recordReversedInstallmentRecovery> | undefined;
    await gate.query("BEGIN"); await gate.query(`SELECT id FROM cashier_shifts WHERE id = $1 FOR UPDATE`, [shift.id]);
    try {
      closing = db.closeShift({ id: shift.id, closedBy: "recovery-test", counted: shift.expected, note: "Synthetic gated close" });
      void closing.catch(() => {});
      // The opening of SHIFT_SELECT is visible even with PostgreSQL's 1KB activity limit.
      await waiting("%SELECT s.*, COALESCE(s.expected_yer%");
      recovering = db.recordReversedInstallmentRecovery(recovery(target, "recovery-shift-close-race")); void recovering.catch(() => {});
      await waiting("%SELECT id FROM cashier_shifts WHERE status = 'open' FOR UPDATE%");
      await gate.query("COMMIT");
      expect((await closing).reason).toBeNull();
      expect((await recovering).reason).toBe("no_shift");
      expect((await db.patientLedger(target.patientId)).payments).toHaveLength(2);
    } finally {
      await gate.query("ROLLBACK").catch(() => {});
      await Promise.allSettled([closing, recovering].filter((p) => p !== undefined));
      if (!(await db.getOpenShift())) await db.openShift({ openedBy: "recovery-test", opening: { YER: 0, SAR: 0, USD: 0 } });
    }
  });

  it("cancellation owning the invoice first refuses recovery without reviving it", async () => {
    const target = await issued(); await refund(target);
    let pending: ReturnType<typeof db.recordReversedInstallmentRecovery> | undefined;
    await gate.query("BEGIN"); await gate.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [target.invoiceId]);
    try {
      pending = db.recordReversedInstallmentRecovery(recovery(target, "recovery-cancel-first")); void pending.catch(() => {});
      await waiting("%FROM invoices WHERE patient_id =%ORDER BY id FOR UPDATE%");
      await gate.query(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [target.invoiceId]); await gate.query("COMMIT");
      expect((await pending).reason).toBe("invalid_invoice");
      expect((await db.patientLedger(target.patientId)).payments).toHaveLength(2);
    } finally { await gate.query("ROLLBACK").catch(() => {}); await pending; }
  });

  it("recovery owning the invoice first commits once before a later cancellation", async () => {
    const target = await issued(); await refund(target);
    let pending: ReturnType<typeof db.recordReversedInstallmentRecovery> | undefined;
    let cancel: ReturnType<typeof db.setInvoiceStatus> | undefined;
    await gate.query("BEGIN"); await gate.query(`SELECT id FROM treatment_plans WHERE id = $1 FOR UPDATE`, [target.planId]);
    try {
      pending = db.recordReversedInstallmentRecovery(recovery(target, "recovery-before-cancel")); void pending.catch(() => {});
      await waiting("%FROM treatment_plans WHERE patient_id =%ORDER BY id FOR SHARE%");
      cancel = db.setInvoiceStatus(target.invoiceId, "cancelled", { actor: "recovery-admin", actorRole: "admin" }); void cancel.catch(() => {});
      await waiting("%FROM invoices WHERE id =%FOR UPDATE%");
      await gate.query("COMMIT");
      const result = await pending; expect(result.reason).toBeNull(); expect((await cancel)?.status).toBe("cancelled");
      expect(await audits(result.payment!.id)).toHaveLength(1); expect(await due(target)).toBe(-7_000);
    } finally { await gate.query("ROLLBACK").catch(() => {}); await Promise.allSettled([pending, cancel].filter((p) => p !== undefined)); }
  });

  async function unrelatedPaidInvoice(target: Issued) {
    const invoice = await db.createInvoice({ patientId: target.patientId, baseCurrency: "SAR", discountMinor: 0, note: null, createdBy: "recovery-test",
      items: [{ serviceId: null, doctorId: null, description: "Synthetic unrelated invoice", quantity: 1, unitPriceMinor: 7_000 }] });
    if (!invoice) throw new Error("missing unrelated invoice");
    const paid = await db.recordPayment({ patientId: target.patientId, invoiceId: invoice.id, kind: "payment", amountMinor: 7_000,
      currency: "SAR", baseCurrency: "YER", exchangeRate: 140, method: "cash", note: null, createdBy: "recovery-test" });
    if (!paid.payment) throw new Error("missing unrelated receipt");
    return invoice.id;
  }

  it("refuses recovery cash above positive actual account due, even when linked invoice remainder is larger", async () => {
    const target = await issued(); await refund(target);
    const otherInvoice = await unrelatedPaidInvoice(target);
    await db.setInvoiceStatus(otherInvoice, "cancelled", { actor: "recovery-admin", actorRole: "admin" });
    const before = await db.patientLedger(target.patientId); const cash = await drawer();
    const projection = await db.patientReversedInstallmentRecoveries(target.patientId);
    expect(projection.recoveries[0]).toMatchObject({ remainingMinor: 7_000, actualAccountDueMinor: 0, suggestedCashMinor: 0, accountCreditReview: true });
    expect((await db.recordReversedInstallmentRecovery(recovery(target, "recovery-credit-capped"))).reason).toBe("recovery_account_credit_review");
    expect(await db.patientLedger(target.patientId)).toEqual(before); expect(await drawer()).toEqual(cash);
  });

  it("rechecks an unrelated invoice cancellation under the account-cap invoice locks", async () => {
    const target = await issued(); await refund(target); const otherInvoice = await unrelatedPaidInvoice(target);
    let pending: ReturnType<typeof db.recordReversedInstallmentRecovery> | undefined;
    await gate.query("BEGIN"); await gate.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [otherInvoice]);
    try {
      pending = db.recordReversedInstallmentRecovery(recovery(target, "recovery-other-invoice-cancel")); void pending.catch(() => {});
      await waiting("%FROM invoices WHERE patient_id =%ORDER BY id FOR UPDATE%");
      await gate.query(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [otherInvoice]); await gate.query("COMMIT");
      expect((await pending).reason).toBe("recovery_account_credit_review"); expect(await due(target)).toBe(0);
    } finally { await gate.query("ROLLBACK").catch(() => {}); await pending; }
  });

  it.each(["opening-first", "recovery-first"] as const)("opening addOnly and recovery obey the patient-before-table fence: %s", async (order) => {
    const target = await issued(); await refund(target);
    const creditedInvoice = await unrelatedPaidInvoice(target);
    await db.setInvoiceStatus(creditedInvoice, "cancelled", { actor: "recovery-admin", actorRole: "admin" });
    expect(await due(target)).toBe(0);
    const openingRequest = { patientId: target.patientId, currency: "SAR" as const, amountMinor: 7_000, asOfDate: "2026-01-01",
      note: "Synthetic opening debt against existing receipt credit", createdBy: "recovery-admin", addOnly: true };
    let opening: ReturnType<typeof db.setPatientOpeningBalance> | undefined;
    let recovering: ReturnType<typeof db.recordReversedInstallmentRecovery> | undefined;
    await gate.query("BEGIN");
    if (order === "opening-first") await gate.query(`SELECT id FROM patients WHERE id = $1 FOR UPDATE`, [target.patientId]);
    else await gate.query(`SELECT id FROM cashier_shifts WHERE status = 'open' FOR UPDATE`);
    try {
      if (order === "opening-first") {
        opening = db.setPatientOpeningBalance(openingRequest); void opening.catch(() => {});
        await waiting("%FROM patients WHERE id =%FOR UPDATE%");
        recovering = db.recordReversedInstallmentRecovery(recovery(target, "recovery-opening-first")); void recovering.catch(() => {});
        await waiting("%FROM patients WHERE id =%FOR KEY SHARE%");
      } else {
        recovering = db.recordReversedInstallmentRecovery(recovery(target, "recovery-before-opening")); void recovering.catch(() => {});
        await waiting("%FROM cashier_shifts%FOR UPDATE%");
        opening = db.setPatientOpeningBalance(openingRequest); void opening.catch(() => {});
        await waiting("%FROM patients WHERE id =%FOR UPDATE%");
      }
      await gate.query("COMMIT"); await opening;
      const result = await recovering;
      expect(result?.reason).toBe(order === "opening-first" ? null : "recovery_account_credit_review");
      expect(await due(target)).toBe(order === "opening-first" ? 0 : 7_000);
    } finally { await gate.query("ROLLBACK").catch(() => {}); await Promise.allSettled([opening, recovering].filter((p) => p !== undefined)); }
  });

  it.each(["set", "clear"] as const)("the account cap waits for an in-flight canonical opening %s and releases its table lock at commit", async (mode) => {
    const target = await issued(); await refund(target);
    const creditedInvoice = await unrelatedPaidInvoice(target);
    await db.setInvoiceStatus(creditedInvoice, "cancelled", { actor: "recovery-admin", actorRole: "admin" });
    const openingRequest = { patientId: target.patientId, currency: "SAR" as const, amountMinor: mode === "set" ? 1_000 : 7_000,
      asOfDate: "2026-01-01", note: "Synthetic strictly positive opening", createdBy: "recovery-admin" };
    await db.setPatientOpeningBalance(openingRequest);
    expect(await due(target)).toBe(mode === "set" ? 1_000 : 7_000);
    let changing: Promise<unknown> | undefined;
    let recovering: ReturnType<typeof db.recordReversedInstallmentRecovery> | undefined;
    await gate.query("BEGIN"); await gate.query(`LOCK TABLE patient_opening_balance_history IN SHARE MODE`);
    try {
      changing = mode === "set" ? db.setPatientOpeningBalance({ ...openingRequest, amountMinor: 7_000 })
        : db.clearPatientOpeningBalance(target.patientId, "recovery-admin", "Synthetic clear", "SAR");
      void changing.catch(() => {});
      await waiting("%INSERT INTO patient_opening_balance_history%");
      recovering = db.recordReversedInstallmentRecovery(recovery(target, `recovery-opening-${mode}`)); void recovering.catch(() => {});
      await waiting("%LOCK TABLE patient_opening_balances IN SHARE MODE%");
      await gate.query("COMMIT"); await changing;
      expect((await recovering).reason).toBe(mode === "set" ? null : "recovery_account_credit_review");
      expect(await due(target)).toBe(0);
      const { rows: [locks] } = await witness.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM pg_locks
        WHERE relation = 'patient_opening_balances'::regclass AND mode = 'ShareLock' AND granted`);
      expect(locks.count).toBe(0);
    } finally { await gate.query("ROLLBACK").catch(() => {}); await Promise.allSettled([changing, recovering].filter((p) => p !== undefined)); }
  });

  it("a plan with multiple reversed origins locks those payments in ascending order before refusing new principal", async () => {
    const target = await issued();
    const second = await db.recordPlanInstallment({ ...target.request, installmentNumber: 2, idempotencyKey: "recovery-second-origin" });
    if (!("paymentId" in second)) throw new Error(second.reason);
    await refund(target); await refund(target, 7_000, second.paymentId);
    let pending: ReturnType<typeof db.recordPlanInstallment> | undefined;
    await gate.query("BEGIN"); await gate.query(`SELECT id FROM payments WHERE id = $1 FOR UPDATE`, [second.paymentId]);
    try {
      pending = db.recordPlanInstallment({ ...target.request, idempotencyKey: "recovery-no-third-invoice" }); void pending.catch(() => {});
      await waiting("%FROM payments WHERE id = ANY%ORDER BY id FOR UPDATE%");
      // The first/lower origin is already locked while the higher origin is gated.
      await witness.query("BEGIN");
      try { await expect(witness.query(`SELECT id FROM payments WHERE id = $1 FOR UPDATE NOWAIT`, [target.paymentId])).rejects.toMatchObject({ code: "55P03" }); }
      finally { await witness.query("ROLLBACK"); }
      await gate.query("COMMIT");
      expect(await pending).toEqual({ reason: "issued_installment_recovery_required", recoveryInvoiceIds: [target.invoiceId, second.invoiceId] });
      expect((await db.patientLedger(target.patientId)).invoices).toHaveLength(2);
      expect((await db.patientLedger(target.patientId)).payments).toHaveLength(4);
    } finally { await gate.query("ROLLBACK").catch(() => {}); await pending; }
  });

  // Deliberately corrupt synthetic rows are last: they must not poison later global commission/book checks.
  it("finds an off-patient directly linked receipt in the real adapter and refuses unsupported history", async () => {
    const target = await issued(); await refund(target);
    const [{ id: otherPatient }] = await q<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('RECOVERY-FOREIGN-OWNER', 'Synthetic inconsistent receipt owner') RETURNING id`);
    const shift = await db.getOpenShift(); if (!shift) throw new Error("no shift");
    await q(`INSERT INTO payments (receipt_number, patient_id, invoice_id, plan_id, shift_id, kind, amount_minor,
      currency, exchange_rate, base_amount_minor, base_currency, method, created_by)
      VALUES ('RECOVERY-FOREIGN-RECEIPT', $1, $2, $3, $4, 'payment', 1000, 'SAR', 140, 1400, 'YER', 'cash', 'synthetic-legacy')`,
      [otherPatient, target.invoiceId, target.planId, shift.id]);
    const before = await q(`SELECT * FROM payments WHERE invoice_id = $1 ORDER BY id`, [target.invoiceId]);
    const projection = await db.patientReversedInstallmentRecoveries(target.patientId);
    expect(projection.recoveries).toHaveLength(0);
    expect(projection.reviews).toEqual([{ invoiceId: target.invoiceId, planId: target.planId, reason: "ownership_mismatch" }]);
    expect((await db.recordReversedInstallmentRecovery(recovery(target, "recovery-off-owner-refused"))).reason).toBe("recovery_review_required");
    expect(await q(`SELECT * FROM payments WHERE invoice_id = $1 ORDER BY id`, [target.invoiceId])).toEqual(before);
  });

  it("maps malformed own-patient foreign invoice linkage to review instead of a generic retry error", async () => {
    const target = await issued(); await refund(target);
    const other = await issued();
    const shift = await db.getOpenShift(); if (!shift) throw new Error("no shift");
    await q(`INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor,
      currency, exchange_rate, base_amount_minor, base_currency, method, created_by)
      VALUES ('RECOVERY-WRONG-TARGET', $1, $2, $3, 'payment', 1000, 'SAR', 140, 1400, 'YER', 'cash', 'synthetic-legacy')`,
      [target.patientId, other.invoiceId, shift.id]);
    const before = await q(`SELECT * FROM payments WHERE patient_id = $1 ORDER BY id`, [target.patientId]);
    expect((await db.recordReversedInstallmentRecovery(recovery(target, "recovery-wrong-target-review"))).reason).toBe("recovery_review_required");
    expect(await db.recordPlanInstallment({ ...target.request, idempotencyKey: "recovery-wrong-target-plan-review" }))
      .toEqual({ reason: "installment_recovery_review_required" });
    expect(await q(`SELECT * FROM payments WHERE patient_id = $1 ORDER BY id`, [target.patientId])).toEqual(before);
  });


  it.each(["null", "other", "wrong-kind"] as const)("the only reversed-origin refund with %s invoice targeting blocks new principal and exposes review", async (mode) => {
    const target = await issued();
    let refundInvoice: number | null = mode === "wrong-kind" ? target.invoiceId : null;
    if (mode === "other") {
      const other = await db.createInvoice({ patientId: target.patientId, baseCurrency: "SAR", discountMinor: 0, note: null, createdBy: "synthetic-legacy",
        items: [{ serviceId: null, doctorId: null, description: "Synthetic divergent target", quantity: 1, unitPriceMinor: 1_000 }] });
      if (!other) throw new Error("missing other invoice"); refundInvoice = other.id;
    }
    const shift = await db.getOpenShift(); if (!shift) throw new Error("no shift");
    await q(`INSERT INTO payments (receipt_number, patient_id, invoice_id, plan_id, shift_id, kind, amount_minor,
      currency, exchange_rate, base_amount_minor, base_currency, method, created_by, reversal_of_id)
      VALUES ($1, $2, $3, $4, $5, $7, 7000, 'SAR', 140, 9800, 'YER', 'cash', 'synthetic-legacy', $6)`,
      [`RECOVERY-DIVERGENT-${mode}`, target.patientId, refundInvoice, target.planId, shift.id, target.paymentId, mode === "wrong-kind" ? "payment" : "refund"]);
    const projection = await db.patientReversedInstallmentRecoveries(target.patientId);
    expect(projection.recoveries).toHaveLength(0);
    expect(projection.reviews).toContainEqual({ invoiceId: target.invoiceId, planId: target.planId,
      reason: mode === "wrong-kind" ? "invalid_payment" : "ownership_mismatch" });
    const before = await db.patientLedger(target.patientId);
    expect(await db.recordPlanInstallment({ ...target.request, idempotencyKey: `recovery-divergent-guard-${mode}` }))
      .toMatchObject({ reason: "installment_recovery_review_required", recoveryInvoiceIds: [target.invoiceId] });
    expect(await db.patientLedger(target.patientId)).toEqual(before);
  });

});
