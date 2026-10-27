import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Client, type Pool } from "pg";
import { randomUUID } from "node:crypto";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { migrate } from "../../lib/migrations";
import { readFirstUseReadinessInTransaction } from "../../lib/inventory-domain/first-use-readiness";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_CUSTODY_SQL } from "../../lib/inventory-domain/custody-schema-proposal";
import { INVENTORY_SUPPLIER_FINANCE_SQL } from "../../lib/inventory-domain/supplier-finance-schema-proposal";
import { INVENTORY_SUPPLIER_NUMBER_SQL } from "../../lib/inventory-domain/supplier-number-schema-proposal";
import { INVENTORY_COMMAND_LIFECYCLE_SQL } from "../../lib/inventory-domain/command-lifecycle-schema-proposal";
vi.mock("server-only", () => ({}));
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
async function read(pool: Pool) {
  const c = await pool.connect();
  try { await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); return await readFirstUseReadinessInTransaction(c); }
  finally { await c.query("ROLLBACK"); c.release(); }
}
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  await migrate(fixture.source, { apply: true });
  await migrate(fixture.archiveTarget, { apply: true });
  for (const sql of [INVENTORY_PROCUREMENT_SQL, INVENTORY_CUSTODY_SQL, INVENTORY_SUPPLIER_FINANCE_SQL,
    INVENTORY_SUPPLIER_NUMBER_SQL, INVENTORY_COMMAND_LIFECYCLE_SQL]) await fixture.source.query(sql);
});
afterAll(async () => { await fixture?.close(); });

it("missing schema is unknown, never reported as empty and never provisioned by inspection", async () => {
  const empty = await read(fixture.sqlTarget);
  expect(empty.state).toBe("schema_incomplete");
  expect(empty.inventoryHistory.every(row => row.count === null)).toBe(true);
  expect(empty.protectedSupplierFinance).toEqual({ liabilities: null, payments: null, allocations: null });
  expect((await fixture.sqlTarget.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0].n).toBe(0);
  const baseline = await read(fixture.archiveTarget);
  expect(baseline.inventoryHistory.find(row => row.table === "inventory_movements")?.count).toBe("0");
  expect(baseline.inventoryHistory.find(row => row.table === "purchase_requests")?.count).toBeNull();
  expect(baseline.missingTables).toContain("purchase_requests");
});

it("complete empty inventory is only a first-use candidate, with no activation authority inferred", async () => {
  const result = await read(fixture.source);
  expect(result).toMatchObject({ state: "first_use_candidate", schemaCoverage: "complete", snapshotOnly: true, missingTables: [] });
  expect(result.inventoryHistory.find(row => row.table === "inventory_supplier_intents")?.count).toBeNull();
  expect(result.protectedSupplierFinance).toEqual({ liabilities: "0", payments: "0", allocations: "0" });
  expect(result).not.toHaveProperty("canActivate");
  expect(result.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

it("requires an explicit repeatable transaction and permits central authority row locks", async () => {
  const c = await fixture.source.connect();
  try {
    await expect(readFirstUseReadinessInTransaction(c)).rejects.toMatchObject({ code: "transaction_required" });
    await c.query("BEGIN READ ONLY");
    await expect(readFirstUseReadinessInTransaction(c)).rejects.toMatchObject({ code: "readiness_snapshot_required" });
    await c.query("ROLLBACK"); await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await c.query("SELECT id FROM users FOR SHARE");
    expect((await readFirstUseReadinessInTransaction(c)).snapshotOnly).toBe(true);
  } finally { await c.query("ROLLBACK"); c.release(); }
});

it("preserves shared supplier debts and counts each payment once despite multiple allocations or reversals", async () => {
  const p = fixture.source;
  const supplier = (await p.query("INSERT INTO parties(kind,name) VALUES('supplier','SYN-READINESS-SUPPLIER') RETURNING id")).rows[0].id;
  const shift = (await p.query("INSERT INTO cashier_shifts(opened_by) VALUES('SYN-READINESS') RETURNING id")).rows[0].id;
  const payableIds: number[] = [];
  for (const amount of [100, 100, -50]) payableIds.push((await p.query("INSERT INTO payables(party_id,description,amount_minor,currency,base_amount_minor) VALUES($1,'SYN-READINESS-DEBT',$2,'YER',$2) RETURNING id", [supplier, amount])).rows[0].id);
  const expenseIds: number[] = [];
  for (const amount of [30, -10]) expenseIds.push((await p.query("INSERT INTO expenses(voucher_number,category,party_id,shift_id,amount_minor,currency,base_amount_minor) VALUES($1,'supplier',$2,$3,$4,'YER',$4) RETURNING id", [randomUUID(), supplier, shift, amount])).rows[0].id);
  for (const payable of payableIds.slice(0, 2)) await p.query("INSERT INTO expense_payable_allocations(expense_id,payable_id,paid_minor,payable_currency,payable_exchange_rate,settled_minor) VALUES($1,$2,10,'YER',1,10)", [expenseIds[0], payable]);
  await p.query("INSERT INTO expenses(voucher_number,category,shift_id,amount_minor,currency,base_amount_minor) VALUES($1,'supplier',$2,20,'YER',20)", [randomUUID(), shift]);
  const before = (await p.query("SELECT (SELECT count(*) FROM payables)::text AS liabilities,(SELECT count(*) FROM expenses)::text AS payments,(SELECT count(*) FROM expense_payable_allocations)::text AS allocations")).rows[0];
  const result = await read(p);
  expect(result.state).toBe("first_use_candidate");
  expect(result.protectedSupplierFinance).toEqual({ liabilities: "3", payments: "3", allocations: "2" });
  expect(result.protectedSupplierFinance).toEqual(before);
  expect(JSON.stringify(result)).not.toMatch(/SYN-READINESS|amount_minor|description|party_id/);
  expect((await p.query("SELECT (SELECT count(*) FROM payables)::text AS liabilities,(SELECT count(*) FROM expenses)::text AS payments,(SELECT count(*) FROM expense_payable_allocations)::text AS allocations")).rows[0]).toEqual(before);
});

it("rejected0065 command evidence requires review even with no stock, and a snapshot stays stable across a concurrent commit", async () => {
  const c = await fixture.source.connect();
  const concurrent = new Client({ connectionString: fixture.source.options.connectionString, ssl: false });
  try {
    await concurrent.connect();
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const before = await readFirstUseReadinessInTransaction(c);
    const userId = (await concurrent.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('SYN-READINESS-USER','Synthetic readiness user','synthetic-hash','admin') RETURNING id")).rows[0].id;
    await concurrent.query("INSERT INTO inventory_purchase_receipts(request_key,actor_user_id,fingerprint_version,request_digest,outcome,result_version,result_snapshot) VALUES($1,$2,1,$3,'rejected',1,$4::jsonb)", [randomUUID(), userId, "a".repeat(64), JSON.stringify({ message: "Synthetic rejected request", httpStatus: 409 })]);
    expect(await readFirstUseReadinessInTransaction(c)).toEqual(before);
    await c.query("ROLLBACK");
  } finally { await c.query("ROLLBACK"); c.release(); await concurrent.end(); }
  const after = await read(fixture.source);
  expect(after.state).toBe("history_review_required");
  expect(after.inventoryHistory.find(row => row.table === "inventory_purchase_receipts")?.count).toBe("1");
  expect(after.inventoryHistory.find(row => row.table === "inventory_movements")?.count).toBe("0");
});


it("counts stock evidence without netting offsetting movements or revealing patient/visit content", async () => {
  const item = (await fixture.source.query("INSERT INTO inventory_items(name,unit,created_by) VALUES('SYN-READINESS-ITEM','unit','SYN-READINESS') RETURNING id")).rows[0].id;
  await fixture.source.query("INSERT INTO inventory_movements(item_id,kind,qty,created_by) VALUES($1,'in',1,'SYN-READINESS'),($1,'out',1,'SYN-READINESS')", [item]);
  const result = await read(fixture.source);
  expect(result.state).toBe("history_review_required");
  expect(result.inventoryHistory.find(row => row.table === "inventory_movements")?.count).toBe("2");
  expect(result.references.find(row => row.table === "inventory_items")?.count).toBe("1");
  expect(JSON.stringify(result)).not.toMatch(/SYN-READINESS|patient_id|visit_id|qty/);
});
