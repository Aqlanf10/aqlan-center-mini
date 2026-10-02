import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Client } from "pg";
import type { DbClient, QueryResult } from "../../lib/db";
import { validatePostgresTestTarget } from "./_safe-target";
import { stubPostgresEnv } from "./_setup";
import { prepareExpenseCategoryHistoryFixture } from "./_expense-category-fixture";

// Real PostgreSQL desired invariants. The standalone proof refuses a nonempty
// schema; aggregate CI uses the standard fixture only after the canonical target
// guard. Never repair/backfill financial documents to make these tests pass.
const originalEnvironment = { ...process.env };
const target = validatePostgresTestTarget(originalEnvironment);
stubPostgresEnv();
vi.mock("@/lib/session", () => ({
  requireSession: async () => ({ username: "category-history-test", role: "admin" }),
}));
const db = await import("../../lib/db");
const route = await import("../../app/api/finance/expense-categories/route");
const { isBalanced } = await import("../../lib/accounting");
const ACTOR = "category-history-test";
const FROM = "0001-01-01";
const TO = "2099-12-31";
let sequence = 0;
const unique = () => `history_${++sequence}`;

beforeAll(async () => {
  await prepareExpenseCategoryHistoryFixture(originalEnvironment);
  await db.ensureSchema();
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

type Category = Awaited<ReturnType<typeof db.createExpenseCategory>>;
async function category(overrides: Partial<Parameters<typeof db.createExpenseCategory>[0]> = {}): Promise<Category> {
  const key = unique();
  return db.createExpenseCategory({ key, name: `Synthetic ${key}`, accountCode: "5502", autoPostJournal: true, ...overrides });
}
async function categoryRow(id: number) {
  return (await db.getPool().query("SELECT * FROM expense_categories WHERE id = $1", [id])).rows[0] ?? null;
}
async function allCategoryRows() {
  return (await db.getPool().query("SELECT * FROM expense_categories ORDER BY id")).rows;
}
const input = (alias: string) => ({
  category: alias, partyId: null, payeeText: "Synthetic utility", amountMinor: 2_000,
  currency: "YER" as const, baseCurrency: "YER" as const, exchangeRate: 1,
  payableId: null, note: "Synthetic history containment", createdBy: ACTOR, rates: { YER: 1 },
});
async function closedVoucher(alias: string) {
  const shift = await db.openShift({ openedBy: ACTOR, opening: { YER: 10_000, SAR: 0, USD: 0 } });
  expect(shift).not.toBeNull();
  const written = await db.recordExpense(input(alias));
  expect(written.reason).toBeNull();
  expect(written.expense).not.toBeNull();
  const closed = await db.closeShift({ id: shift!.id, closedBy: ACTOR, counted: { YER: 8_000, SAR: 0, USD: 0 }, note: null });
  expect(closed.reason).toBeNull();
  expect(closed.difference).toEqual({ YER: 0, SAR: 0, USD: 0 });
  return { shiftId: shift!.id, expenseId: written.expense!.id, voucherNumber: written.expense!.voucherNumber };
}
type Fixture = Awaited<ReturnType<typeof closedVoucher>>;
async function history(fixture: Fixture) {
  const journal = await db.journalEntries(FROM, TO);
  expect(journal.every(isBalanced)).toBe(true);
  return { journal, expense: await db.getExpense(fixture.expenseId), shift: await db.getShift(fixture.shiftId) };
}
async function refusesWithoutHistoryChange(fixture: Fixture, action: () => Promise<unknown>) {
  const before = await history(fixture);
  const rows = await allCategoryRows();
  let error: unknown;
  try { await action(); } catch (caught) { error = caught; }
  // Soft checks show both the missing refusal and its financial consequence.
  expect.soft(error, "material category edit must be refused, not silently accepted").toBeInstanceOf(Error);
  expect.soft(await allCategoryRows(), "a refused operation must leave ALL categories unchanged").toEqual(rows);
  expect.soft(await history(fixture), "closed drawer, immutable voucher, and derived GL must retain history").toEqual(before);
}
const request = (method: "POST" | "PATCH", body: unknown) => new NextRequest("http://localhost/api/finance/expense-categories", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

it("fresh bootstrap seeds current facility/marketing accounts and enabled posting", async () => {
  const { rows } = await db.getPool().query(
    `SELECT key, account_code, auto_post_journal FROM expense_categories
      WHERE key IN ('facility_maintenance', 'marketing') ORDER BY key`,
  );
  expect(rows).toEqual([
    { key: "facility_maintenance", account_code: "5504", auto_post_journal: true },
    { key: "marketing", account_code: "5902", auto_post_journal: true },
  ]);
});

// Key and legacy display-name references are equally material because the GL
// resolves ec.key = e.category OR ec.name = e.category.
describe("referenced expense categories preserve posting history", () => {
  it("allows sync of unused configuration and subsequent no-op sync of referenced configuration", async () => {
    const unused = await category({ autoPostJournal: false });
    const synced = await db.syncExpenseCategoriesAccountingMapping();
    expect(synced.fixedCount).toBeGreaterThanOrEqual(1);
    expect(await categoryRow(unused.id)).toMatchObject({ account_code: "5502", auto_post_journal: true });
    const fixture = await closedVoucher(unused.key);
    const before = await history(fixture);
    expect((await db.syncExpenseCategoriesAccountingMapping()).fixedCount).toBe(0);
    expect(await history(fixture)).toEqual(before);
  });

  for (const reference of ["key", "name"] as const) {
    it.each([
      ["disable posting", { autoPostJournal: false }],
      ["change account", { accountCode: "5503" }],
      ["rename", { name: "Renamed historical category" }],
    ] as const)(`refuses %s when a closed voucher references the ${reference}`, async (_label, change) => {
      const used = await category();
      const fixture = await closedVoucher(used[reference]);
      await refusesWithoutHistoryChange(fixture, () => db.updateExpenseCategory(used.id, change));
    });

    it(`refuses re-enabling an excluded historical ${reference} voucher`, async () => {
      const used = await category({ autoPostJournal: false });
      const fixture = await closedVoucher(used[reference]);
      expect((await history(fixture)).journal.filter((entry) => entry.reference === fixture.voucherNumber)).toHaveLength(0);
      await refusesWithoutHistoryChange(fixture, () => db.updateExpenseCategory(used.id, { autoPostJournal: true }));
    });

    it(`deactivates instead of deleting a ${reference}-referenced category`, async () => {
      const used = await category();
      const fixture = await closedVoucher(used[reference]);
      const before = await history(fixture);
      const outcome = await db.deleteExpenseCategory(used.id);
      expect.soft(outcome).toEqual({ success: true, deactivated: true });
      expect.soft(await categoryRow(used.id)).toMatchObject({ key: used.key, name: used.name, account_code: "5502", auto_post_journal: true, is_active: false });
      expect.soft(await history(fixture)).toEqual(before);
    });
  }

  it("accepts normalized material no-ops on a referenced category", async () => {
    const used = await category();
    const fixture = await closedVoucher(used.key);
    const before = await history(fixture);
    expect(await db.updateExpenseCategory(used.id, { name: ` ${used.name} `, accountCode: " 5502 ", autoPostJournal: true })).toBe(true);
    expect(await history(fixture)).toEqual(before);
  });

  it("accepts unrelated budget, display, description and activation edits", async () => {
    const used = await category();
    const fixture = await closedVoucher(used.name);
    const before = await history(fixture);
    expect(await db.updateExpenseCategory(used.id, { categoryGroup: "Synthetic metadata", monthlyBudgetMinor: 500,
      annualBudgetMinor: 6000, budgetCurrency: "SAR", description: "Budget only", displayOrder: 7, isActive: false })).toBe(true);
    expect(await categoryRow(used.id)).toMatchObject({ category_group: "Synthetic metadata", monthly_budget_minor: "500",
      annual_budget_minor: "6000", budget_currency: "SAR", description: "Budget only", display_order: 7, is_active: false });
    expect(await history(fixture)).toEqual(before);
  });

  it("allows material configuration for a genuinely unused, non-colliding category", async () => {
    const unused = await category();
    const renamed = `Unused ${unique()}`;
    expect(await db.updateExpenseCategory(unused.id, { name: renamed, accountCode: "5503", autoPostJournal: false })).toBe(true);
    expect(await categoryRow(unused.id)).toMatchObject({ name: renamed, account_code: "5503", auto_post_journal: false });
  });

  it("rolls back an earlier valid batch update when a later referenced change refuses", async () => {
    const unused = await category();
    const used = await category();
    const fixture = await closedVoucher(used.name);
    await refusesWithoutHistoryChange(fixture, () => db.batchUpdateExpenseCategories([
      { id: unused.id, accountCode: "5503", autoPostJournal: false },
      { id: used.id, accountCode: "5503" },
    ]));
  });

  it("allows a batch of used-category no-ops/metadata and unused material edits", async () => {
    const unused = await category();
    const used = await category();
    const fixture = await closedVoucher(used.key);
    const before = await history(fixture);
    expect(await db.batchUpdateExpenseCategories([
      { id: used.id, accountCode: used.accountCode, autoPostJournal: used.autoPostJournal, monthlyBudgetMinor: 321 },
      { id: unused.id, accountCode: "5503", autoPostJournal: false },
    ])).toEqual({ updatedCount: 2 });
    expect(await history(fixture)).toEqual(before);
  });

  it("sync refuses historic exclusion changes and rolls back all its earlier candidates", async () => {
    await category({ autoPostJournal: false }); // earlier unused candidate must not partially apply
    const used = await category({ autoPostJournal: false });
    const fixture = await closedVoucher(used.name);
    await refusesWithoutHistoryChange(fixture, () => db.syncExpenseCategoriesAccountingMapping());
  });

  it("sync cannot replace the nonstandard account used by a closed standard-category voucher", async () => {
    const { categories } = await db.listExpenseCategories({ includeInactive: true });
    const electricity = categories.find((row) => row.key === "electricity")!;
    expect(electricity).toBeDefined();
    expect(await db.updateExpenseCategory(electricity.id, { accountCode: "5901" })).toBe(true);
    const fixture = await closedVoucher(electricity.key);
    await refusesWithoutHistoryChange(fixture, () => db.syncExpenseCategoriesAccountingMapping());
  });
});

describe("category aliases cannot capture or multiply historical expense joins", () => {
  it.each(["name-to-name", "new-key-to-old-name", "new-name-to-old-key"] as const)("refuses creation collision: %s", async (kind) => {
    const alias = unique();
    const used = await category({ name: alias });
    const fixture = await closedVoucher(kind === "new-name-to-old-key" ? used.key : used.name);
    const values = kind === "name-to-name" ? { name: used.name }
      : kind === "new-key-to-old-name" ? { key: used.name } : { name: used.key };
    await refusesWithoutHistoryChange(fixture, () => category(values));
  });

  it("refuses renaming an unused category onto an existing category alias", async () => {
    const used = await category();
    const fixture = await closedVoucher(used.key);
    const unused = await category();
    await refusesWithoutHistoryChange(fixture, () => db.updateExpenseCategory(unused.id, { name: used.key }));
  });

  it.each(["key", "name"] as const)("refuses creation whose %s would capture an old unmatched expense", async (field) => {
    const orphan = unique();
    const fixture = await closedVoucher(orphan);
    const before = await history(fixture);
    expect(before.journal.filter((entry) => entry.reference === fixture.voucherNumber)).toHaveLength(1);
    await refusesWithoutHistoryChange(fixture, () => category({ [field]: orphan, accountCode: "5503", autoPostJournal: false }));
  });

  it("checks the normalized creation key before capturing an old unmatched expense", async () => {
    const orphan = unique();
    const fixture = await closedVoucher(orphan);
    await refusesWithoutHistoryChange(fixture, () => category({ key: ` ${orphan.toUpperCase()} `, accountCode: "5503" }));
  });

  it("refuses renaming a genuinely unused category onto an old unmatched expense", async () => {
    const fixture = await closedVoucher(unique());
    const usedAlias = (await db.getExpense(fixture.expenseId))!.category;
    const unused = await category();
    await refusesWithoutHistoryChange(fixture, () => db.updateExpenseCategory(unused.id, { name: usedAlias }));
  });
});

describe("real expense-category API entry points preserve the same history", () => {
  it.each(["single", "batch", "sync_accounting", "ensure_all_linked", "create-alias"] as const)("returns a conflict without successful audit/write through %s", async (door) => {
    const isSync = door === "sync_accounting" || door === "ensure_all_linked";
    const used = await category({ autoPostJournal: !isSync });
    const fixture = await closedVoucher(used.name);
    const before = await history(fixture);
    const rows = await allCategoryRows();
    const auditCount = async () => (await db.getPool().query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE actor = $1", [ACTOR])).rows[0].n;
    const auditBefore = await auditCount();
    const response = door === "single" ? await route.PATCH(request("PATCH", { id: used.id, autoPostJournal: false }))
      : door === "batch" ? await route.PATCH(request("PATCH", { updates: [{ id: used.id, accountCode: "5503" }] }))
      : door === "create-alias" ? await route.POST(request("POST", { key: unique(), name: used.name, accountCode: "5503" }))
      : await route.POST(request("POST", { action: door }));
    expect.soft(response.status).toBe(409);
    expect.soft((await response.json()).ok).not.toBe(true);
    expect.soft(await allCategoryRows()).toEqual(rows);
    expect.soft(await auditCount(), "refused changes must not produce success settings.update audits").toBe(auditBefore);
    expect.soft(await history(fixture)).toEqual(before);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("category history reference checks are safe against an uncommitted first voucher", () => {
  it.each(["edit-policy", "create-orphan-alias"] as const)("serializes %s behind the writer and refuses after the first voucher commits", async (mutation) => {
    const unused = await category();
    const alias = mutation === "edit-policy" ? unused.key : unique();
    const categoriesBefore = await allCategoryRows();
    const shift = (await db.openShift({ openedBy: ACTOR, opening: { YER: 10_000, SAR: 0, USD: 0 } }))!;
    const inserted = deferred();
    const releaseWriter = deferred();
    const pool = db.getPool();
    const originalConnect = pool.connect.bind(pool);
    let writerPid = 0;
    // Test-only scheduling seam: pause a REAL transaction after successful INSERT
    // and before COMMIT. No runtime query, category resolution, or refusal mocked.
    const connectSpy = vi.spyOn(pool, "connect").mockImplementationOnce(async () => {
      const client = await originalConnect();
      writerPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const originalQuery = client.query.bind(client);
      const wrapper: DbClient = {
        async query<T>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
          const result = await originalQuery<T>(sql, values);
          if (/INSERT\s+INTO\s+expenses\s*\(/i.test(sql)) {
            inserted.resolve();
            await releaseWriter.promise;
          }
          return result;
        },
        release: () => client.release(),
      };
      return wrapper;
    });
    const writer = db.recordExpense(input(alias));
    let edit: Promise<{ accepted: boolean; error?: unknown }> | undefined;
    const inspector = new Client({ connectionString: target.testUrl.toString(), ssl: false });
    try {
      await Promise.race([inserted.promise, writer.then(() => { throw new Error("Writer ended before the insertion barrier"); })]);
      connectSpy.mockRestore();
      // The new reference exists only inside the paused writer transaction.
      await inspector.connect();
      expect((await inspector.query<{ n: number }>("SELECT count(*)::int AS n FROM expenses WHERE category = $1", [alias])).rows[0].n).toBe(0);
      let settled = false;
      const change = mutation === "edit-policy"
        ? db.updateExpenseCategory(unused.id, { autoPostJournal: false })
        : category({ name: alias, autoPostJournal: false });
      edit = change.then(
        () => ({ accepted: true }), (error: unknown) => ({ accepted: false, error }),
      ).finally(() => { settled = true; });
      let genuinelyBlocked = false;
      const deadline = Date.now() + 10_000;
      // Observe an actual lock waiter, never infer a lock from an arbitrary sleep.
      while (!settled && !genuinelyBlocked && Date.now() < deadline) {
        const result = await inspector.query<{ blocked: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked", [writerPid],
        );
        genuinelyBlocked = result.rows[0].blocked;
        if (!genuinelyBlocked && !settled) await new Promise<void>((done) => setImmediate(done));
      }
      expect.soft(genuinelyBlocked, "configuration must wait on the first voucher, not inspect an empty reference set and commit").toBe(true);
      releaseWriter.resolve();
      const written = await writer;
      expect(written.reason).toBeNull();
      expect(written.expense).not.toBeNull();
      const outcome = await edit;
      expect.soft(outcome.accepted).toBe(false);
      expect.soft(outcome.error).toBeInstanceOf(Error);
      expect.soft(await allCategoryRows()).toEqual(categoriesBefore);
      expect.soft(await categoryRow(unused.id)).toMatchObject({ auto_post_journal: true, account_code: "5502" });
      const journal = await db.journalEntries(FROM, TO);
      expect.soft(journal.filter((entry) => entry.reference === written.expense!.voucherNumber)).toHaveLength(1);
      expect.soft((await db.getShift(shift.id))?.expected.YER).toBe(8_000);
    } finally {
      releaseWriter.resolve();
      connectSpy.mockRestore();
      await writer.catch(() => {});
      await edit?.catch(() => {});
      await inspector.end().catch(() => {});
      const current = await db.getShift(shift.id);
      if (current?.status === "open") await db.closeShift({ id: shift.id, closedBy: ACTOR, counted: current.expected, note: null });
    }
  });
});


// Scheduling hooks pause actual database statements, never replace the SQL
// business behavior. Each wait assertion observes pg_blocking_pids, not sleep.
function pauseNextTransaction(afterSql: RegExp) {
  const paused = deferred();
  const release = deferred();
  let pid = 0;
  let stopped = false;
  const pool = db.getPool();
  const originalConnect = pool.connect.bind(pool);
  const spy = vi.spyOn(pool, "connect").mockImplementationOnce(async () => {
    const client = await originalConnect();
    pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const query = client.query.bind(client);
    return {
      async query<T>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
        const result = await query<T>(sql, values);
        if (!stopped && afterSql.test(sql)) { stopped = true; paused.resolve(); await release.promise; }
        return result;
      },
      release: () => client.release(),
    };
  });
  return { paused, release, spy, pid: () => pid };
}
async function waitForBlocked(inspector: Client, blockingPid: number, isSettled: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!isSettled() && Date.now() < deadline) {
    const { rows } = await inspector.query<{ blocked: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked", [blockingPid],
    );
    if (rows[0].blocked) return true;
    await new Promise<void>((done) => setImmediate(done));
  }
  return false;
}
async function finishShift(shiftId: number) {
  const shift = await db.getShift(shiftId);
  if (shift?.status === "open") await db.closeShift({ id: shiftId, closedBy: ACTOR, counted: shift.expected, note: null });
}

// Minimal synthetic source rows for the two real category FKs. These are fixture
// constructors, not new runtime writers or changes to lab accounting behavior.
async function fkFixture(kind: "lab_orders" | "payables") {
  if (kind === "lab_orders") {
    const { rows } = await db.getPool().query<{ id: number }>(
      `INSERT INTO patients(patient_number, full_name) VALUES ($1, 'Synthetic FK patient') RETURNING id`, [unique()],
    );
    return { sql: `INSERT INTO lab_orders(patient_id, lab_name, work_type, due_date, expense_category_id)
      VALUES ($1, 'Synthetic lab', 'Synthetic work', CURRENT_DATE, $2) RETURNING id`, parentId: rows[0].id };
  }
  const { rows } = await db.getPool().query<{ id: number }>(
    `INSERT INTO parties(name, kind) VALUES ('Synthetic category supplier', 'supplier') RETURNING id`,
  );
  return { sql: `INSERT INTO payables(party_id, description, amount_minor, currency, base_amount_minor, expense_category_id)
    VALUES ($1, 'Synthetic payable', 1000, 'YER', 1000, $2) RETURNING id`, parentId: rows[0].id };
}

describe("configuration-first and namespace serialization", () => {
  it("records the first voucher only after the preceding configuration commits", async () => {
    const unused = await category();
    const shift = (await db.openShift({ openedBy: ACTOR, opening: { YER: 10_000, SAR: 0, USD: 0 } }))!;
    const gate = pauseNextTransaction(/UPDATE expense_categories SET/);
    const edit = db.updateExpenseCategory(unused.id, { accountCode: "5503" });
    const inspector = new Client({ connectionString: target.testUrl.toString(), ssl: false });
    let writer: ReturnType<typeof db.recordExpense> | undefined;
    try {
      await Promise.race([gate.paused.promise, edit.then(() => { throw new Error("Configuration ended before barrier"); })]);
      gate.spy.mockRestore();
      await inspector.connect();
      let settled = false;
      writer = db.recordExpense(input(unused.key)).finally(() => { settled = true; });
      expect(await waitForBlocked(inspector, gate.pid(), () => settled)).toBe(true);
      expect((await inspector.query("SELECT count(*)::int AS n FROM expenses WHERE category=$1", [unused.key])).rows[0].n).toBe(0);
      gate.release.resolve();
      expect(await edit).toBe(true);
      const result = await writer;
      expect(result.reason).toBeNull();
      expect(await categoryRow(unused.id)).toMatchObject({ account_code: "5503" });
      const entries = (await db.journalEntries(FROM, TO)).filter((entry) => entry.reference === result.expense!.voucherNumber);
      expect(entries).toHaveLength(1);
      expect(entries[0].lines.some((line) => line.accountCode === "5503")).toBe(true);
      await expect(db.updateExpenseCategory(unused.id, { accountCode: "5502" })).rejects.toBeInstanceOf(db.ExpenseCategoryConflictError);
    } finally {
      gate.release.resolve(); gate.spy.mockRestore();
      await edit.catch(() => {}); await writer?.catch(() => {}); await inspector.end().catch(() => {});
      await finishShift(shift.id);
    }
  });

  it("serializes concurrent cross-key/name creation and refuses the second alias", async () => {
    const alias = unique();
    const gate = pauseNextTransaction(/INSERT INTO expense_categories/);
    const first = category({ name: alias });
    const inspector = new Client({ connectionString: target.testUrl.toString(), ssl: false });
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([gate.paused.promise, first.then(() => { throw new Error("Creation ended before barrier"); })]);
      gate.spy.mockRestore(); await inspector.connect();
      let settled = false;
      second = category({ key: alias }).then(() => ({ accepted: true }), (error: unknown) => ({ accepted: false, error }))
        .finally(() => { settled = true; });
      expect(await waitForBlocked(inspector, gate.pid(), () => settled)).toBe(true);
      gate.release.resolve();
      const created = await first;
      expect(await second).toMatchObject({ accepted: false, error: expect.any(db.ExpenseCategoryConflictError) });
      const matches = await inspector.query("SELECT id FROM expense_categories WHERE key=$1 OR name=$1", [alias]);
      expect(matches.rows).toEqual([{ id: created.id }]);
    } finally {
      gate.release.resolve(); gate.spy.mockRestore();
      await first.catch(() => {}); await second?.catch(() => {}); await inspector.end().catch(() => {});
    }
  });

  it("rolls back a bounded lock timeout and returns 409 without success audit", async () => {
    const unused = await category();
    const rows = await allCategoryRows();
    const blocker = new Client({ connectionString: target.testUrl.toString(), ssl: false });
    await blocker.connect();
    const originalConnect = db.getPool().connect.bind(db.getPool());
    const auditBefore = (await db.getPool().query("SELECT count(*)::int AS n FROM audit_log WHERE actor=$1", [ACTOR])).rows[0].n;
    const spy = vi.spyOn(db.getPool(), "connect").mockImplementationOnce(async () => {
      const client = await originalConnect();
      const query = client.query.bind(client);
      return { query: <T>(sql: string, values?: unknown[]) => query<T>(sql === "SET LOCAL lock_timeout = '10s'" ? "SET LOCAL lock_timeout = '50ms'" : sql, values), release: () => client.release() };
    });
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE expenses IN ROW EXCLUSIVE MODE");
      const response = await route.PATCH(request("PATCH", { id: unused.id, accountCode: "5503" }));
      expect(response.status).toBe(409);
      expect(await allCategoryRows()).toEqual(rows);
      expect((await db.getPool().query("SELECT count(*)::int AS n FROM audit_log WHERE actor=$1", [ACTOR])).rows[0].n).toBe(auditBefore);
      await blocker.query("COMMIT");
      expect(await db.updateExpenseCategory(unused.id, { accountCode: "5503" })).toBe(true);
    } finally { spy.mockRestore(); await blocker.query("ROLLBACK").catch(() => {}); await blocker.end(); }
  });
});

describe("category deletion preserves document foreign keys without lock inversion", () => {
  it("physically deletes only a genuinely unused nonsystem category", async () => {
    const unused = await category();
    expect(await db.deleteExpenseCategory(unused.id)).toEqual({ success: true, deactivated: false });
    expect(await categoryRow(unused.id)).toBeNull();
    expect(await db.deleteExpenseCategory(unused.id)).toEqual({ success: false });
  });

  for (const kind of ["lab_orders", "payables"] as const) {
    it(`deactivates an existing ${kind} reference without clearing it`, async () => {
      const used = await category();
      const fixture = await fkFixture(kind);
      const { rows: [source] } = await db.getPool().query(fixture.sql, [fixture.parentId, used.id]);
      const before = (await db.getPool().query(`SELECT * FROM ${kind} WHERE id=$1`, [source.id])).rows[0];
      expect(await db.deleteExpenseCategory(used.id)).toEqual({ success: true, deactivated: true });
      expect((await db.getPool().query(`SELECT * FROM ${kind} WHERE id=$1`, [source.id])).rows[0]).toEqual(before);
      expect(await categoryRow(used.id)).toMatchObject({ is_active: false });
    });

    it(`refuses promptly behind an uncommitted ${kind} FK writer, allowing its later expense write`, async () => {
      const used = await category();
      const fixture = await fkFixture(kind);
      const writer = new Client({ connectionString: target.testUrl.toString(), ssl: false });
      await writer.connect();
      try {
        await writer.query("BEGIN"); await writer.query("SET LOCAL statement_timeout='3s'");
        const { rows: [source] } = await writer.query(fixture.sql, [fixture.parentId, used.id]);
        const response = await route.DELETE(new NextRequest(`http://localhost/api/finance/expense-categories?id=${used.id}`, { method: "DELETE" }));
        expect(response.status).toBe(409);
        expect(await categoryRow(used.id)).toMatchObject({ is_active: true });
        // Models the real lab-deletion/source-write order, proving the refused
        // configuration released its expenses fence instead of deadlocking.
        await writer.query("UPDATE expenses SET note=note WHERE id=-1");
        await writer.query("COMMIT");
        expect(await db.deleteExpenseCategory(used.id)).toEqual({ success: true, deactivated: true });
        expect((await db.getPool().query(`SELECT expense_category_id FROM ${kind} WHERE id=$1`, [source.id])).rows[0]).toEqual({ expense_category_id: used.id });
      } finally { await writer.query("ROLLBACK").catch(() => {}); await writer.end(); }
    });

    it(`deletion-first blocks a new ${kind} FK and never silently writes NULL`, async () => {
      const unused = await category();
      const fixture = await fkFixture(kind);
      const gate = pauseNextTransaction(/FROM expense_categories WHERE id = \$1 FOR UPDATE NOWAIT/);
      const deletion = db.deleteExpenseCategory(unused.id);
      const writer = new Client({ connectionString: target.testUrl.toString(), ssl: false });
      const inspector = new Client({ connectionString: target.testUrl.toString(), ssl: false });
      let insertion: Promise<unknown> | undefined;
      try {
        await Promise.race([gate.paused.promise, deletion.then(() => { throw new Error("Deletion ended before barrier"); })]);
        gate.spy.mockRestore(); await writer.connect(); await inspector.connect();
        await writer.query("BEGIN");
        let settled = false;
        insertion = writer.query(fixture.sql, [fixture.parentId, unused.id]).then(() => ({ accepted: true }), (error: { code: string }) => ({ accepted: false, code: error.code }))
          .finally(() => { settled = true; });
        expect(await waitForBlocked(inspector, gate.pid(), () => settled)).toBe(true);
        gate.release.resolve();
        expect(await deletion).toEqual({ success: true, deactivated: false });
        expect(await insertion).toEqual({ accepted: false, code: "23503" });
        await writer.query("ROLLBACK");
        expect((await inspector.query(`SELECT count(*)::int AS n FROM ${kind} WHERE expense_category_id=$1`, [unused.id])).rows[0].n).toBe(0);
      } finally {
        gate.release.resolve(); gate.spy.mockRestore();
        await deletion.catch(() => {}); await insertion?.catch(() => {});
        await writer.query("ROLLBACK").catch(() => {}); await writer.end().catch(() => {}); await inspector.end().catch(() => {});
      }
    });
  }
});

describe("legacy compatibility without retrospective cleanup", () => {
  it("allows metadata and exact no-ops for an already ambiguous legacy category", async () => {
    const used = await category();
    const other = await category();
    // Deliberately reproduce old ambiguous data through the synthetic fixture.
    await db.getPool().query("UPDATE expense_categories SET name=$1 WHERE id=$2", [used.name, other.id]);
    const fixture = await closedVoucher(used.name);
    const before = await history(fixture);
    expect(await db.updateExpenseCategory(used.id, { name: used.name, accountCode: "5502", autoPostJournal: true, monthlyBudgetMinor: 17 })).toBe(true);
    expect(await history(fixture)).toEqual(before);
  });

  it("treats a legacy NULL posting flag as enabled without silently disabling history", async () => {
    const used = await category();
    const pool = db.getPool();
    // Only this synthetic schema is relaxed; runtime bootstrap is intentionally
    // unchanged. Restore the fresh schema contract in finally.
    await pool.query("ALTER TABLE expense_categories ALTER COLUMN auto_post_journal DROP NOT NULL");
    try {
      await pool.query("UPDATE expense_categories SET auto_post_journal=NULL WHERE id=$1", [used.id]);
      const fixture = await closedVoucher(used.key);
      const before = await history(fixture);
      expect(await db.updateExpenseCategory(used.id, { description: "NULL remains enabled" })).toBe(true);
      expect((await categoryRow(used.id)).auto_post_journal).toBeNull();
      await refusesWithoutHistoryChange(fixture, () => db.updateExpenseCategory(used.id, { autoPostJournal: false }));
      expect(await db.updateExpenseCategory(used.id, { autoPostJournal: true })).toBe(true);
      expect(await history(fixture)).toEqual(before);
    } finally {
      await pool.query("UPDATE expense_categories SET auto_post_journal=TRUE WHERE id=$1 AND auto_post_journal IS NULL", [used.id]);
      await pool.query("ALTER TABLE expense_categories ALTER COLUMN auto_post_journal SET NOT NULL");
    }
  });
});


describe("cold bootstrap preserves existing category account decisions", () => {
  it.each([
    ["facility_maintenance", "5601", "key"],
    ["marketing", "5901", "name"],
  ] as const)("does not remap used %s account %s on restart", async (key, legacyAccount, reference) => {
    const { categories } = await db.listExpenseCategories({ includeInactive: true });
    const existing = categories.find((row) => row.key === key)!;
    expect(existing).toBeDefined();
    // Author the unused setting, then record immutable history through the real
    // expense writer. Bootstrap is not allowed to supersede that decision.
    expect(await db.updateExpenseCategory(existing.id, { accountCode: legacyAccount })).toBe(true);
    const fixture = await closedVoucher(existing[reference]);
    const categoriesBefore = await allCategoryRows();
    const historyBefore = await history(fixture);
    for (let restart = 0; restart < 2; restart++) {
      db.schemaReadyReset();
      await db.ensureSchema();
      expect.soft(await allCategoryRows(), "bootstrap must not change existing account/posting/category decisions").toEqual(categoriesBefore);
      expect.soft(await history(fixture), "restart must retain the exact journal, voucher, and closed-shift history").toEqual(historyBefore);
      expect.soft(await categoryRow(existing.id)).toMatchObject({ account_code: legacyAccount, auto_post_journal: true });
    }
  });
});
