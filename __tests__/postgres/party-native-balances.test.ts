import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createHash } from "node:crypto";
import { assertRealPostgresUrl } from "./_setup";
import { assertLocalExpenseComparisonUrl } from "./_expense-comparison-fixture-url";
import { loadPartyDueByCurrency, loadPartyNativeBalanceSnapshot, type DbPool } from "../../lib/db";

// Execute only the real read projection against synthetic session-local tables.
// No application pool, initializer, migrations, public writes or Railway target.
const connectionString = assertLocalExpenseComparisonUrl(assertRealPostgresUrl());
if (process.env.RAILWAY_PROJECT_ID) throw new Error("Party balance fixtures require a local PostgreSQL test target outside Railway.");
const client = new Client({ connectionString, ssl: false });
let queries = 0;
const runner: Pick<DbPool, "query"> = {
  query: async <T>(sql: string, values?: unknown[]) => {
    queries += 1;
    return { rows: (await client.query(sql, values)).rows as T[] };
  },
};
const fixtureTables = ["parties", "payables", "payable_adjustments", "party_opening_advances", "expenses", "expense_payable_allocations"] as const;

beforeAll(async () => {
  await client.connect();
  await client.query("SET search_path TO pg_temp");
  await client.query(`
    CREATE TEMP TABLE parties (id integer PRIMARY KEY, name text, kind text, is_active boolean);
    CREATE TEMP TABLE payables (id integer PRIMARY KEY, party_id integer, currency text, amount_minor bigint, exchange_rate numeric);
    CREATE TEMP TABLE payable_adjustments (id integer PRIMARY KEY, payable_id integer, delta_minor bigint);
    CREATE TEMP TABLE party_opening_advances (id integer PRIMARY KEY, party_id integer, currency text, amount_minor bigint, voided_at timestamptz);
    CREATE TEMP TABLE expenses (id integer PRIMARY KEY, party_id integer, payable_id integer, currency text,
      amount_minor bigint, base_amount_minor bigint, base_currency text, payable_settled_minor bigint);
    CREATE TEMP TABLE expense_payable_allocations (id integer PRIMARY KEY, expense_id integer, payable_id integer,
      paid_minor bigint, payable_currency text, settled_minor bigint);
  `);
});
beforeEach(async () => {
  await client.query(`TRUNCATE pg_temp.parties, pg_temp.payables, pg_temp.payable_adjustments,
    pg_temp.party_opening_advances, pg_temp.expenses, pg_temp.expense_payable_allocations`);
});
afterAll(async () => { await client.end(); });

async function fingerprints() {
  const result: Record<string, { count: number; sha256: string }> = {};
  for (const table of fixtureTables) {
    // Fixed local allowlist; READ ONLY alone still allows writes to TEMP tables.
    const { rows: [row] } = await client.query<{ count: string; contents: string }>(`
      SELECT COUNT(*)::text AS count,
        COALESCE(jsonb_agg(to_jsonb(f) ORDER BY to_jsonb(f)::text COLLATE "C"), '[]'::jsonb)::text AS contents
      FROM pg_temp.${table} f`);
    result[table] = { count: Number(row.count), sha256: createHash("sha256").update(row.contents).digest("hex") };
  }
  return result;
}
async function protectedRead<T>(operation: () => Promise<T>) {
  queries = 0;
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    const before = await fingerprints();
    try { return await operation(); }
    finally {
      expect(queries).toBe(1);
      // Compare every fixture, including allocation children, before rollback.
      expect(await fingerprints()).toEqual(before);
    }
  } finally { await client.query("ROLLBACK"); }
}
const read = () => protectedRead(() => loadPartyDueByCurrency(runner));
const readSnapshot = () => protectedRead(() => loadPartyNativeBalanceSnapshot(runner));

describe("canonical native party balances in one PostgreSQL read", () => {
  it("fully paid USD remains zero despite different recorded base equivalents; partial SAR remains SAR", async () => {
    await client.query(`INSERT INTO pg_temp.parties VALUES (1,'Inactive USD lab','lab',false),(2,'SAR supplier','supplier',true);
      INSERT INTO pg_temp.payables VALUES (11,1,'USD',10000,500),(21,2,'SAR',20000,140);
      INSERT INTO pg_temp.expenses VALUES
        (1,1,11,'USD',10000,60000,'YER',10000),
        (2,2,21,'SAR',5000,9000,'YER',5000)`);
    expect(await read()).toEqual([{ partyId: 2, name: "SAR supplier", kind: "supplier", currency: "SAR", dueMinor: 15000 }]);
    // Base values are deliberately inconsistent across dates; the query must not use them for modern snapshots.
    await client.query("UPDATE pg_temp.expenses SET base_amount_minor = 999999999");
    expect(await read()).toEqual([{ partyId: 2, name: "SAR supplier", kind: "supplier", currency: "SAR", dueMinor: 15000 }]);
  });

  it("keeps all currency signs, inactive parties and identities separate without cross-currency or cross-party offset", async () => {
    await client.query(`INSERT INTO pg_temp.parties VALUES
      (1,'Same name','lab',false),(2,'Same name','supplier',true),(3,'Excluded doctor','doctor',true);
      INSERT INTO pg_temp.payables VALUES (11,1,'YER',900,1),(12,1,'SAR',1200,140),(13,2,'SAR',300,140),(14,3,'USD',99900,500);
      INSERT INTO pg_temp.party_opening_advances VALUES (1,1,'USD',500,NULL),(2,2,'SAR',800,NULL)`);
    expect(await read()).toEqual([
      { partyId: 1, name: "Same name", kind: "lab", currency: "YER", dueMinor: 900 },
      { partyId: 1, name: "Same name", kind: "lab", currency: "SAR", dueMinor: 1200 },
      { partyId: 1, name: "Same name", kind: "lab", currency: "USD", dueMinor: -500 },
      { partyId: 2, name: "Same name", kind: "supplier", currency: "SAR", dueMinor: -500 },
    ]);
  });

  it("includes opening corrections, active advances and signed direct reversals exactly once", async () => {
    await client.query(`INSERT INTO pg_temp.parties VALUES (1,'Opening supplier','supplier',true);
      INSERT INTO pg_temp.payables VALUES (11,1,'USD',10000,500);
      INSERT INTO pg_temp.payable_adjustments VALUES (1,11,3000),(2,11,-1000);
      INSERT INTO pg_temp.party_opening_advances VALUES (1,1,'USD',500,NULL),(2,1,'USD',800,now());
      INSERT INTO pg_temp.expenses VALUES (1,1,11,'YER',10000,10000,'YER',2000),(2,1,11,'YER',-2500,-2500,'YER',-500)`);
    expect(await read()).toEqual([{ partyId: 1, name: "Opening supplier", kind: "supplier", currency: "USD", dueMinor: 10000 }]);
  });

  it("deducts only the residual of a partly allocated on-account voucher, without pretending every bill was settled", async () => {
    await client.query(`INSERT INTO pg_temp.parties VALUES (1,'Partial allocation','supplier',true),(2,'Unlinked payment','lab',true);
      INSERT INTO pg_temp.payables VALUES (11,1,'USD',10000,500),(21,2,'USD',10000,500);
      INSERT INTO pg_temp.expenses VALUES (1,1,NULL,'USD',5000,30000,'YER',NULL),(2,2,NULL,'USD',2000,12000,'YER',NULL);
      INSERT INTO pg_temp.expense_payable_allocations VALUES (1,1,11,3000,'USD',3000)`);
    expect(await read()).toEqual([
      { partyId: 2, name: "Unlinked payment", kind: "lab", currency: "USD", dueMinor: 8000 },
      { partyId: 1, name: "Partial allocation", kind: "supplier", currency: "USD", dueMinor: 5000 },
    ]);
    // The projection is read-only and does not allocate the remaining on-account cash to an invoice.
    expect((await client.query("SELECT payable_settled_minor FROM pg_temp.expenses WHERE id=2")).rows[0].payable_settled_minor).toBeNull();
  });

  it("does not double-deduct a fully allocated batch, and restores its obligations after signed reversal", async () => {
    await client.query(`INSERT INTO pg_temp.parties VALUES (1,'Batch laboratory','lab',true);
      INSERT INTO pg_temp.payables VALUES (11,1,'USD',2000,500),(12,1,'USD',3000,500);
      INSERT INTO pg_temp.expenses VALUES (1,1,NULL,'USD',5000,30000,'YER',NULL);
      INSERT INTO pg_temp.expense_payable_allocations VALUES (1,1,11,2000,'USD',2000),(2,1,12,3000,'USD',3000)`);
    expect(await read()).toEqual([]);
    await client.query(`INSERT INTO pg_temp.expenses VALUES (2,1,NULL,'USD',-5000,-30000,'YER',NULL);
      INSERT INTO pg_temp.expense_payable_allocations VALUES (3,2,11,-2000,'USD',-2000),(4,2,12,-3000,'USD',-3000)`);
    expect(await read()).toEqual([{ partyId: 1, name: "Batch laboratory", kind: "lab", currency: "USD", dueMinor: 5000 }]);
  });

  it("keeps unallocated foreign tender separate from another currency's invoice debt", async () => {
    await client.query(`INSERT INTO pg_temp.parties VALUES (1,'Unallocated foreign tender','supplier',true);
      INSERT INTO pg_temp.payables VALUES (11,1,'USD',10000,500);
      INSERT INTO pg_temp.expenses VALUES (1,1,NULL,'SAR',37500,52500,'YER',NULL)`);
    expect(await read()).toEqual([
      { partyId: 1, name: "Unallocated foreign tender", kind: "supplier", currency: "SAR", dueMinor: -37500 },
      { partyId: 1, name: "Unallocated foreign tender", kind: "supplier", currency: "USD", dueMinor: 10000 },
    ]);
  });

  it("retains legacy settlement fallback and missing-payable residual handling", async () => {
    await client.query(`INSERT INTO pg_temp.parties VALUES (1,'Legacy supplier','supplier',true);
      INSERT INTO pg_temp.payables VALUES (11,1,'USD',10000,500),(12,1,'SAR',5000,140),(13,1,'YER',1000,1);
      INSERT INTO pg_temp.expenses VALUES
        (1,1,11,'YER',25000,25000,'YER',NULL),
        (2,1,12,'SAR',2000,3000,'YER',NULL),
        (3,1,13,'USD',100,500,'YER',NULL),
        (4,1,999,'USD',500,3000,'YER',NULL)`);
    expect(await read()).toEqual([
      { partyId: 1, name: "Legacy supplier", kind: "supplier", currency: "YER", dueMinor: 500 },
      { partyId: 1, name: "Legacy supplier", kind: "supplier", currency: "SAR", dueMinor: 3000 },
      { partyId: 1, name: "Legacy supplier", kind: "supplier", currency: "USD", dueMinor: 4500 },
    ]);
  });

  it("keeps modern cross-currency settled snapshots instead of recomputing them from base or current rates", async () => {
    await client.query(`INSERT INTO pg_temp.parties VALUES (1,'Cross-currency lab','lab',true);
      INSERT INTO pg_temp.payables VALUES (11,1,'USD',10000,500);
      INSERT INTO pg_temp.expenses VALUES (1,1,11,'SAR',37500,52500,'YER',9813)`);
    expect(await read()).toEqual([{ partyId: 1, name: "Cross-currency lab", kind: "lab", currency: "USD", dueMinor: 187 }]);
  });

  it("rejects an unknown currency even when its bucket nets to zero", async () => {
    await client.query(`INSERT INTO pg_temp.parties VALUES (1,'Invalid currency','supplier',true);
      INSERT INTO pg_temp.payables VALUES (11,1,'EUR',10000,500);
      INSERT INTO pg_temp.expenses VALUES (1,1,11,'EUR',10000,50000,'YER',10000)`);
    await expect(read()).rejects.toThrow(/عملة/);
  });

  it("rejects a total outside safe minor units", async () => {
    await client.query(`INSERT INTO pg_temp.parties VALUES (1,'Unsafe aggregate','supplier',true);
      INSERT INTO pg_temp.payables VALUES (11,1,'USD',9007199254740991,500),(12,1,'USD',1,500)`);
    await expect(read()).rejects.toThrow(/الآمنة/);
  });

  it("loads an untruncated multi-party list in exactly one query rather than one query per party", async () => {
    await client.query(`INSERT INTO pg_temp.parties SELECT id,'Synthetic ' || id,'supplier',true FROM generate_series(1,250) id;
      INSERT INTO pg_temp.payables SELECT id,id,'USD',id,500 FROM generate_series(1,250) id`);
    const rows = await read();
    expect(rows).toHaveLength(250);
    expect(new Set(rows.map((row) => row.partyId)).size).toBe(250);
    expect(rows.reduce((sum, row) => sum + row.dueMinor, 0)).toBe(31375);
  });

  it("returns empty only for a successful no-balance read", async () => {
    await client.query("INSERT INTO pg_temp.parties VALUES (1,'No activity','supplier',true)");
    expect(await read()).toEqual([]);
  });

  it("carries complete atomic identity coverage for no-activity, settled and nonzero parties", async () => {
    await client.query(`INSERT INTO pg_temp.parties VALUES
      (1,'No activity','supplier',false),(2,'Settled lab','lab',true),(3,'Partial supplier','supplier',true),(4,'Doctor excluded','doctor',true);
      INSERT INTO pg_temp.payables VALUES (21,2,'USD',10000,500),(31,3,'SAR',9000,140),(41,4,'USD',5000,500);
      INSERT INTO pg_temp.expenses VALUES (1,2,21,'USD',10000,60000,'YER',10000),(2,3,31,'SAR',2000,9999,'YER',2000)`);
    expect(await readSnapshot()).toEqual({
      partyIdentities: [
        { id: 2, name: "Settled lab", kind: "lab" },
        { id: 1, name: "No activity", kind: "supplier" },
        { id: 3, name: "Partial supplier", kind: "supplier" },
      ],
      balancesByCurrency: [{ partyId: 3, name: "Partial supplier", kind: "supplier", currency: "SAR", dueMinor: 7000 }],
    });
  });

  it("distinguishes an empty source catalogue from covered identities whose net balances are zero", async () => {
    expect(await readSnapshot()).toEqual({ partyIdentities: [], balancesByCurrency: [] });
    await client.query("INSERT INTO pg_temp.parties VALUES (1,'Covered zero','lab',true)");
    expect(await readSnapshot()).toEqual({ partyIdentities: [{ id: 1, name: "Covered zero", kind: "lab" }], balancesByCurrency: [] });
  });

  it("rejects an actual NULL currency bucket instead of confusing it with a no-activity left join", async () => {
    await client.query(`INSERT INTO pg_temp.parties VALUES (1,'Invalid null currency','supplier',true);
      INSERT INTO pg_temp.payables VALUES (11,1,NULL,10000,500)`);
    await expect(readSnapshot()).rejects.toThrow(/عملة/);
  });
});
