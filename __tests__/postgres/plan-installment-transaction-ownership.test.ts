import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import { FinancialCurrencyIntegrityError } from "../../lib/money";
import type { DbClient } from "../../lib/db";

// Inspect the ORIGINAL environment before stubPostgresEnv removes Railway markers.
// The canonical PostgreSQL global setup also checks this target and PG major 18.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
type Input = Parameters<typeof db.recordPlanInstallment>[0];
type QueryPort = Pick<DbClient, "query">;
const oldPoolMax = process.env.DB_POOL_MAX;
let witness: Client | undefined;
let serial = 0;

beforeAll(async () => {
  process.env.DB_POOL_MAX = "1";
  await db.resetPoolForTesting(); // No borrowed lease exists yet.
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
  expect((db.getPool() as unknown as { options: { max: number } }).options.max).toBe(1);
  await db.openShift({ openedBy: "installment-owner-test", opening: { YER: 0, SAR: 0, USD: 0 } });
  witness = new Client({ connectionString: target.testUrl.toString(), ssl: false });
  await witness.connect();
}, 180_000);

afterAll(async () => {
  try {
    await witness?.end();
  } finally {
    await db.resetPoolForTesting();
    if (oldPoolMax === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = oldPoolMax;
  }
});

function observer(): QueryPort {
  if (!witness) throw new Error("independent witness is not connected");
  return witness as unknown as QueryPort;
}

async function fixture(): Promise<Input> {
  serial += 1;
  const pool = db.getPool();
  const { rows: [patient] } = await pool.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic installment owner') RETURNING id`,
    [`INSTALLMENT-OWNER-${serial}`],
  );
  const { rows: [plan] } = await pool.query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, billing_mode, note)
     VALUES ($1, 'Synthetic owner agreement', 300000, 'YER', 'active', 'installments', 'baseline') RETURNING id`,
    [patient.id],
  );
  await pool.query(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
    VALUES ($1, 1, '2026-01-01', 300000)`, [plan.id]);
  return { patientId: patient.id, planId: plan.id, installmentNumber: 1, planTitle: "Synthetic owner agreement",
    amountMinor: 150000, currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null,
    createdBy: "installment-owner-test", actorRole: "reception", idempotencyKey: `owner:installment-${serial}` };
}

async function graph(port: QueryPort, input: Input) {
  const shifts = await port.query(`SELECT * FROM cashier_shifts ORDER BY id`);
  const plan = await port.query(`SELECT * FROM treatment_plans WHERE id = $1`, [input.planId]);
  const installments = await port.query(`SELECT * FROM plan_installments WHERE plan_id = $1 ORDER BY id`, [input.planId]);
  const invoices = await port.query(`SELECT * FROM invoices WHERE plan_id = $1 ORDER BY id`, [input.planId]);
  const items = await port.query(`SELECT x.* FROM invoice_items x JOIN invoices i ON i.id = x.invoice_id
    WHERE i.plan_id = $1 ORDER BY x.id`, [input.planId]);
  const payments = await port.query(`SELECT * FROM payments WHERE plan_id = $1 ORDER BY id`, [input.planId]);
  // Scope by immutable audit detail rather than a join that could hide an orphan.
  const audits = await port.query(`SELECT * FROM audit_log WHERE action = 'payment.create'
    AND details ->> 'الخطة' = $1 ORDER BY id`, [String(input.planId)]);
  return { shifts: shifts.rows, plan: plan.rows, installments: installments.rows, invoices: invoices.rows,
    items: items.rows, payments: payments.rows, audits: audits.rows };
}

async function identity(port: QueryPort) {
  const { rows: [row] } = await port.query<{ pid: number; xid: string }>(
    `SELECT pg_backend_pid() AS pid, txid_current()::text AS xid`,
  );
  return row;
}

async function mark(client: DbClient, input: Input, note: string) {
  await client.query(`UPDATE treatment_plans SET note = $2 WHERE id = $1`, [input.planId, note]);
}

/** Fail immediately on a second application connection; never use pool timeout as proof. */
function ownershipGuard(client: DbClient, afterAuditError?: Error) {
  const pool = db.getPool();
  const realQuery = client.query.bind(client);
  const sqlSeen: string[] = [];
  let injected = false;
  const querySpy = vi.spyOn(client, "query").mockImplementation(async (sql, values) => {
    sqlSeen.push(sql);
    const result = await realQuery(sql, values);
    if (afterAuditError && !injected && /INSERT\s+INTO\s+audit_log\b/i.test(sql)) {
      injected = true;
      // Real audit INSERT succeeded: a careless catch could now publish a partial attempt.
      throw afterAuditError;
    }
    return result;
  });
  const connectSpy = vi.spyOn(pool, "connect").mockImplementation(async () => {
    throw new Error("borrowed kernel attempted another application checkout");
  });
  const poolQuerySpy = vi.spyOn(pool, "query").mockImplementation(async () => {
    throw new Error("borrowed kernel attempted a global pool query");
  });
  const releaseSpy = vi.spyOn(client, "release").mockImplementation(() => {
    throw new Error("borrowed kernel released its owner's client");
  });
  return {
    assertClean() {
      expect(connectSpy).not.toHaveBeenCalled();
      expect(poolQuerySpy).not.toHaveBeenCalled();
      expect(releaseSpy).not.toHaveBeenCalled();
      expect(sqlSeen.filter((sql) => /^\s*(?:BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|END\b|ROLLBACK\b|ABORT\b|SAVEPOINT\b|RELEASE\s+SAVEPOINT\b|PREPARE\s+TRANSACTION\b)/i.test(sql)))
        .toEqual([]);
      if (afterAuditError) expect(injected).toBe(true);
    },
    restore() {
      querySpy.mockRestore(); releaseSpy.mockRestore(); poolQuerySpy.mockRestore(); connectSpy.mockRestore();
    },
  };
}

function expectCompleteGraph(value: Awaited<ReturnType<typeof graph>>, input: Input, invoiceId: number, paymentId: number) {
  expect(value.invoices).toHaveLength(1); expect(value.items).toHaveLength(1);
  expect(value.payments).toHaveLength(1); expect(value.audits).toHaveLength(1);
  expect(value.invoices[0]).toMatchObject({ id: invoiceId, plan_id: input.planId, status: "paid", base_currency: "YER" });
  expect(Number(value.invoices[0].total_minor)).toBe(input.amountMinor);
  expect(value.items[0].invoice_id).toBe(invoiceId);
  expect(Number(value.items[0].total_minor)).toBe(input.amountMinor);
  expect(value.payments[0]).toMatchObject({ id: paymentId, patient_id: input.patientId, invoice_id: invoiceId,
    plan_id: input.planId, kind: "payment", currency: "YER", idempotency_key: input.idempotencyKey });
  expect(value.payments[0].shift_id).not.toBeNull();
  expect(Number(value.payments[0].amount_minor)).toBe(input.amountMinor);
  expect(Number(value.payments[0].base_amount_minor)).toBe(input.amountMinor);
  expect(value.audits[0]).toMatchObject({ entity: "payment", entity_id: String(paymentId),
    actor: input.createdBy, actor_role: "reception" });
  expect(value.audits[0].details).toMatchObject({ الخطة: input.planId, قسط: 1, فاتورة_القسط: invoiceId,
    المريض: input.patientId, المبلغ: input.amountMinor, العملة: "YER" });
}

async function assertFreshLease() {
  const fresh = await db.getPool().connect();
  try { expect((await fresh.query(`SELECT 1 AS ok`)).rows[0].ok).toBe(1); }
  finally { fresh.release(); }
}

describe("borrowed installment transaction ownership on PostgreSQL with DB_POOL_MAX=1", () => {
  it("keeps schema initialization, pool access and ownership out of the borrowed source call chain", () => {
    const source = readFileSync(resolve(process.cwd(), "lib/db.ts"), "utf8");
    const start = source.indexOf("function preparePlanInstallment(");
    const end = source.indexOf("// ─── رحلة المريض V2", start);
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
    const chain = source.slice(start, end);
    expect(chain).toContain("export async function recordPlanInstallmentInTransaction(");
    expect(chain).toContain("async function runPlanInstallmentTransaction(");
    // A cached ensureSchema() can be invisible to runtime pool spies, hence this source guard.
    expect(chain).not.toMatch(/\b(?:ensureSchema|getPool)\s*\(/);
    expect(chain).not.toMatch(/\.\s*(?:release|connect)\s*\(/);
    expect(chain).not.toMatch(/\.query\s*\(\s*["'`](?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i);
  });

  it("a borrowed installment stays invisible and disappears with its owner's rollback", async () => {
    const input = await fixture(); const before = await graph(observer(), input);
    const client = await db.getPool().connect();
    let guard: ReturnType<typeof ownershipGuard> | undefined;
    try {
      await client.query("BEGIN"); const beforeId = await identity(client);
      expect(beforeId.pid).not.toBe((await identity(observer())).pid);
      await mark(client, input, "owner-before"); guard = ownershipGuard(client);
      const result = await db.recordPlanInstallmentInTransaction(client, input);
      if ("reason" in result) throw new Error(result.reason);
      expect(Object.keys(result).sort()).toEqual(["invoiceId", "paymentId"]);
      expectCompleteGraph(await graph(client, input), input, result.invoiceId, result.paymentId);
      await mark(client, input, "owner-after"); expect(await identity(client)).toEqual(beforeId);
      expect(await graph(observer(), input)).toEqual(before);
      guard.assertClean(); guard.restore(); guard = undefined;
      await client.query("ROLLBACK");
      expect(await graph(observer(), input)).toEqual(before);
    } finally { guard?.restore(); await client.query("ROLLBACK").catch(() => {}); client.release(); }
    await assertFreshLease();
  });

  it("only the outer commit publishes the installment and both surrounding writes", async () => {
    const input = await fixture(); const before = await graph(observer(), input);
    const client = await db.getPool().connect();
    let guard: ReturnType<typeof ownershipGuard> | undefined;
    let created: { invoiceId: number; paymentId: number } | undefined;
    try {
      await client.query("BEGIN"); const beforeId = await identity(client);
      await mark(client, input, "owner-before"); guard = ownershipGuard(client);
      const result = await db.recordPlanInstallmentInTransaction(client, input);
      if ("reason" in result) throw new Error(result.reason); created = result;
      expect((await graph(client, input)).plan[0].note).toBe("owner-before");
      await mark(client, input, "owner-after"); expect(await identity(client)).toEqual(beforeId);
      expect(await graph(observer(), input)).toEqual(before);
      guard.assertClean(); guard.restore(); guard = undefined;
      await client.query("COMMIT");
      const committed = await graph(observer(), input);
      expectCompleteGraph(committed, input, result.invoiceId, result.paymentId);
      expect(committed.plan[0].note).toBe("owner-after");
    } finally { guard?.restore(); await client.query("ROLLBACK").catch(() => {}); client.release(); }
    if (!created) throw new Error("missing successful collection");
    const committed = await graph(observer(), input);
    expect(await db.recordPlanInstallment(input)).toEqual({ ...created, replayed: true });
    expect(await graph(observer(), input)).toEqual(committed); await assertFreshLease();
  });

  it("borrowed replay returns stored IDs without committing the surrounding transaction", async () => {
    const input = await fixture(); const original = await db.recordPlanInstallment(input);
    if ("reason" in original) throw new Error(original.reason);
    const before = await graph(observer(), input); const client = await db.getPool().connect();
    let guard: ReturnType<typeof ownershipGuard> | undefined;
    try {
      await client.query("BEGIN"); await mark(client, input, "owner-before"); guard = ownershipGuard(client);
      expect(await db.recordPlanInstallmentInTransaction(client, input)).toEqual({ ...original, replayed: true });
      expect((await graph(client, input)).plan[0].note).toBe("owner-before");
      expect(await graph(observer(), input)).toEqual(before);
      guard.assertClean(); guard.restore(); guard = undefined; await client.query("ROLLBACK");
      expect(await graph(observer(), input)).toEqual(before);
    } finally { guard?.restore(); await client.query("ROLLBACK").catch(() => {}); client.release(); }
    await assertFreshLease();
  });

  it("borrowed no_shift refusal leaves the outer owner in control", async () => {
    const input = await fixture(); const before = await graph(observer(), input);
    const client = await db.getPool().connect(); let guard: ReturnType<typeof ownershipGuard> | undefined;
    try {
      await client.query("BEGIN"); const beforeId = await identity(client);
      // Synthetic transaction-local closure; rollback restores the fixture's open shift.
      await client.query(`UPDATE cashier_shifts SET status = 'closed' WHERE status = 'open'`);
      await mark(client, input, "owner-before"); guard = ownershipGuard(client);
      expect(await db.recordPlanInstallmentInTransaction(client, input)).toEqual({ reason: "no_shift" });
      const pending = await graph(client, input);
      expect(pending.plan[0].note).toBe("owner-before");
      expect(pending.invoices).toEqual([]); expect(pending.items).toEqual([]);
      expect(pending.payments).toEqual([]); expect(pending.audits).toEqual([]);
      await mark(client, input, "owner-after"); expect(await identity(client)).toEqual(beforeId);
      expect(await graph(observer(), input)).toEqual(before);
      guard.assertClean(); guard.restore(); guard = undefined; await client.query("ROLLBACK");
      expect(await graph(observer(), input)).toEqual(before);
    } finally { guard?.restore(); await client.query("ROLLBACK").catch(() => {}); client.release(); }
    await assertFreshLease();
  });

  it.each(["missing", "wrong-patient"] as const)(
    "the public wrapper preserves its %s plan error when cleanup rollback reports a failure", async (mode) => {
      const input = await fixture();
      const other = await fixture();
      const before = await graph(observer(), input); const otherBefore = await graph(observer(), other);
      const rejectedInput = mode === "missing" ? { ...input, planId: -1 }
        : { ...input, patientId: other.patientId };
      const pool = db.getPool(); const client = await pool.connect();
      const realQuery = client.query.bind(client); const realRelease = client.release.bind(client);
      const rollbackFailure = new Error("synthetic rollback acknowledgement failure");
      let rollbackObserved = false;
      const querySpy = vi.spyOn(client, "query").mockImplementation(async (sql, values) => {
        const result = await realQuery(sql, values);
        if (/^\s*ROLLBACK\b/i.test(sql)) {
          rollbackObserved = true;
          // The database really rolled back; only its acknowledgement is reported as failing.
          throw rollbackFailure;
        }
        return result;
      });
      const releaseSpy = vi.spyOn(client, "release");
      const connectSpy = vi.spyOn(pool, "connect").mockResolvedValueOnce(client);
      try {
        await expect(db.recordPlanInstallment(rejectedInput)).rejects.toThrow("الخطة غير موجودة أو لا تخص المريض.");
        expect(rollbackObserved).toBe(true);
        expect(releaseSpy).toHaveBeenCalledTimes(1);
        expect(connectSpy).toHaveBeenCalledTimes(1);
        expect(await graph(observer(), input)).toEqual(before);
        expect(await graph(observer(), other)).toEqual(otherBefore);
      } finally {
        const released = releaseSpy.mock.calls.length > 0;
        querySpy.mockRestore(); releaseSpy.mockRestore(); connectSpy.mockRestore();
        if (!released) { await realQuery("ROLLBACK").catch(() => {}); realRelease(); }
      }
      await assertFreshLease();
    },
  );

  it.each(["unexpected", "financial-integrity"] as const)(
    "a %s exception after the real audit INSERT escapes and all partial writes roll back", async (kind) => {
      const input = await fixture(); const before = await graph(observer(), input);
      const error = kind === "unexpected" ? new Error("synthetic after-audit failure")
        : new FinancialCurrencyIntegrityError("synthetic owner test", String(input.planId), "INVALID");
      const client = await db.getPool().connect(); let guard: ReturnType<typeof ownershipGuard> | undefined;
      try {
        await client.query("BEGIN"); await mark(client, input, "owner-before"); guard = ownershipGuard(client, error);
        await expect(db.recordPlanInstallmentInTransaction(client, input)).rejects.toBe(error);
        // All SQL genuinely succeeded before the injected JS error. Only the owner can undo it.
        const pending = await graph(client, input);
        expect(pending.invoices).toHaveLength(1); expect(pending.items).toHaveLength(1);
        expect(pending.payments).toHaveLength(1); expect(pending.audits).toHaveLength(1);
        expect(pending.invoices[0].status).toBe("paid");
        expect(pending.plan[0].note).toBe("owner-before");
        expect(await graph(observer(), input)).toEqual(before);
        guard.assertClean(); guard.restore(); guard = undefined; await client.query("ROLLBACK");
        expect(await graph(observer(), input)).toEqual(before);
      } finally { guard?.restore(); await client.query("ROLLBACK").catch(() => {}); client.release(); }
      await assertFreshLease();
    },
  );
});
