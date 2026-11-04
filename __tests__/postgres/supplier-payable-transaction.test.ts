vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import type { CreatePayableInput, DbClient } from "../../lib/db";
import { withTransaction } from "../../lib/transactions";

assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
let partyId: number;

beforeAll(async () => {
  await db.ensureSchema();
  partyId = (await db.getPool().query<{ id: number }>(
    "INSERT INTO parties(name,kind) VALUES($1,'supplier') RETURNING id", [`SYN-PAYABLE-${randomUUID()}`],
  )).rows[0].id;
  await db.getPool().query("CREATE TABLE IF NOT EXISTS synthetic_payable_transaction_sentinels(id UUID PRIMARY KEY)");
});
afterAll(async () => { await db.resetPoolForTesting(); });

function input(overrides: Partial<CreatePayableInput> = {}): CreatePayableInput {
  return {
    partyId, category: "supplier", description: `SYN-PAYABLE-${randomUUID()}`, amountMinor: 12345,
    currency: "SAR", baseCurrency: "YER", exchangeRate: 140.125, labOrderId: null,
    dueDate: "2030-01-15", createdBy: "synthetic-payable-admin", ...overrides,
  };
}
async function effects() {
  return (await db.getPool().query(`SELECT
    (SELECT COUNT(*) FROM payables)::int AS payables,
    (SELECT COUNT(*) FROM expenses)::int AS expenses,
    (SELECT COUNT(*) FROM inventory_movements)::int AS movements,
    (SELECT COUNT(*) FROM audit_log)::int AS audits,
    (SELECT COUNT(*) FROM synthetic_payable_transaction_sentinels)::int AS sentinels`)).rows[0];
}
function observedClient(client: DbClient, statements: string[], after?: (sql: string) => void): DbClient {
  return {
    async query<T>(sql: string, values?: Parameters<DbClient["query"]>[1]) {
      statements.push(sql);
      const result = await client.query<T>(sql, values);
      after?.(sql);
      return result;
    },
    release() { throw new Error("Core must not release the caller connection"); },
  };
}
async function insertAudit(client: DbClient, id: number) {
  await db.insertAuditRow(client, { action: "payable.create", entity: "payable", entityId: id,
    actor: "synthetic-payable-admin", actorRole: "admin", details: { source: "synthetic test only" } });
}

describe("caller-owned native payable writer", () => {
  it("refuses autocommit before creating debt", async () => {
    const before = await effects();
    const client = await db.getPool().connect();
    try {
      await expect(db.createPayableInTransaction(client, input())).rejects.toMatchObject({ code: "transaction_required" });
    } finally { client.release(); }
    expect(await effects()).toEqual(before);
  });

  it("preserves a same-name caller savepoint and rollback ownership", async () => {
    const before = await effects();
    const statements: string[] = [];
    const pool = db.getPool();
    const connect = vi.spyOn(pool, "connect");
    try {
      await withTransaction(pool, async client => {
        await client.query("SAVEPOINT payable_writer_transaction_check");
        await client.query("INSERT INTO synthetic_payable_transaction_sentinels(id) VALUES($1)", [randomUUID()]);
        const payable = await db.createPayableInTransaction(observedClient(client, statements), input());
        expect(payable).toMatchObject({ currency: "SAR", amountMinor: 12345, settledMinor: 0, remainingMinor: 12345 });
        await insertAudit(client, payable!.id);
        await client.query("ROLLBACK TO SAVEPOINT payable_writer_transaction_check");
      });
      expect(connect).toHaveBeenCalledTimes(1);
    } finally { connect.mockRestore(); }
    expect(statements.filter(sql => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql))).toEqual([]);
    expect(await effects()).toEqual(before);
  });

  it.each([
    { currency: "YER" as const, exchangeRate: 1, expectedBase: 12345 },
    { currency: "SAR" as const, exchangeRate: 140.125, expectedBase: 17298 },
    { currency: "USD" as const, exchangeRate: 535.25, expectedBase: 66077 },
  ])("retains the original $currency amount/rate and no stock or cash effects", async row => {
    const before = await effects();
    const source = input({ currency: row.currency, exchangeRate: row.exchangeRate });
    const payable = await withTransaction(db.getPool(), async client => {
      const created = await db.createPayableInTransaction(client, source);
      await insertAudit(client, created!.id);
      return created!;
    });
    expect(payable).toMatchObject({ partyId, description: source.description, amountMinor: 12345,
      originalAmountMinor: 12345, currency: row.currency, exchangeRate: row.exchangeRate,
      baseAmountMinor: row.expectedBase, settledMinor: 0, remainingMinor: 12345,
      sourceType: "operational", dueDate: "2030-01-15" });
    // A caller changing its later quote does not mutate the persisted snapshot.
    source.exchangeRate = 999;
    const saved = (await db.getPool().query<{ amount_minor: string; currency: string; exchange_rate: string; base_amount_minor: string }>(
      "SELECT amount_minor::text,currency,exchange_rate::text,base_amount_minor::text FROM payables WHERE id=$1", [payable.id],
    )).rows[0];
    expect(saved.amount_minor).toBe("12345");
    expect(saved.currency).toBe(row.currency);
    expect(Number(saved.exchange_rate)).toBe(row.exchangeRate);
    expect(Number(saved.base_amount_minor)).toBe(row.expectedBase);
    expect(await effects()).toEqual({ ...before, payables: before.payables + 1, audits: before.audits + 1 });
  });

  it.each(["payable insert", "payable read", "audit insert"])("rolls back the debt and caller sentinel after %s failure", async stage => {
    const before = await effects();
    let injected = false;
    await expect(withTransaction(db.getPool(), async client => {
      await client.query("INSERT INTO synthetic_payable_transaction_sentinels(id) VALUES($1)", [randomUUID()]);
      const checked = observedClient(client, [], sql => {
        const isStage = stage === "payable insert" ? /^INSERT INTO payables\b/i.test(sql.trim())
          : stage === "audit insert" ? /^INSERT INTO audit_log\b/i.test(sql.trim())
            : /^SELECT b\.id,/i.test(sql.trim());
        if (isStage) { injected = true; throw new Error(`synthetic ${stage} failure`); }
      });
      const payable = await db.createPayableInTransaction(checked, input());
      await insertAudit(checked, payable!.id);
    })).rejects.toThrow(`synthetic ${stage} failure`);
    expect(injected).toBe(true);
    expect(await effects()).toEqual(before);
  });

  it("rolls back on a real mandatory audit database failure", async () => {
    const before = await effects();
    const failure = `synthetic_audit_failure_${randomUUID().replaceAll("-", "")}`;
    await db.getPool().query(`CREATE FUNCTION ${failure}() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.actor='synthetic-payable-admin' THEN RAISE EXCEPTION 'synthetic mandatory payable audit failure'; END IF;
      RETURN NEW; END; $$`);
    await db.getPool().query(`CREATE TRIGGER ${failure} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${failure}()`);
    try {
      await expect(withTransaction(db.getPool(), async client => {
        await client.query("INSERT INTO synthetic_payable_transaction_sentinels(id) VALUES($1)", [randomUUID()]);
        const payable = await db.createPayableInTransaction(client, input());
        await insertAudit(client, payable!.id);
      })).rejects.toThrow("synthetic mandatory payable audit failure");
      expect(await effects()).toEqual(before);
    } finally {
      await db.getPool().query(`DROP TRIGGER ${failure} ON audit_log`);
      await db.getPool().query(`DROP FUNCTION ${failure}()`);
    }
  });

  it("the compatibility wrapper also rolls back if its final read fails", async () => {
    const before = await effects();
    const pool = db.getPool();
    const originalConnect = pool.connect.bind(pool);
    let injected = false;
    const connect = vi.spyOn(pool, "connect").mockImplementation(async () => {
      const client = await originalConnect();
      const checked = observedClient(client, [], sql => {
        if (/^SELECT b\.id,/i.test(sql.trim())) { injected = true; throw new Error("synthetic wrapper read failure"); }
      });
      return { ...checked, release: destroy => client.release(destroy) };
    });
    try { await expect(db.createPayable(input())).rejects.toThrow("synthetic wrapper read failure"); }
    finally { connect.mockRestore(); }
    expect(injected).toBe(true);
    expect(await effects()).toEqual(before);
  });

  it("retains lab-order conflict semantics across wrapper and core concurrency", async () => {
    const patient = (await db.getPool().query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic payable test') RETURNING id", [`SYN-${randomUUID()}`],
    )).rows[0].id;
    const order = (await db.getPool().query<{ id: number }>(
      "INSERT INTO lab_orders(patient_id,lab_name,work_type,due_date,status,party_id,cost_minor,cost_currency) VALUES($1,'Synthetic lab','test',CURRENT_DATE,'delivered',$2,100,'YER') RETURNING id", [patient, partyId],
    )).rows[0].id;
    const source = input({ labOrderId: order, category: "lab", currency: "YER", exchangeRate: 1, amountMinor: 100 });
    const before = await effects();
    const results = await Promise.all([
      db.createPayable(source),
      withTransaction(db.getPool(), client => db.createPayableInTransaction(client, source)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter(result => result === null)).toHaveLength(1);
    expect(await effects()).toEqual({ ...before, payables: before.payables + 1 });
    expect(await db.createPayable(source)).toBeNull();
    expect(await effects()).toEqual({ ...before, payables: before.payables + 1 });
  });

  it("does not fabricate idempotency for equal independent supplier invoices", async () => {
    const source = input();
    const before = await effects();
    const [first, second] = await Promise.all([
      withTransaction(db.getPool(), client => db.createPayableInTransaction(client, source)),
      withTransaction(db.getPool(), client => db.createPayableInTransaction(client, source)),
    ]);
    expect(first!.id).not.toBe(second!.id);
    expect(await effects()).toEqual({ ...before, payables: before.payables + 2 });
  });
});
