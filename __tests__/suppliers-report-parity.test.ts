import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const postgresUrl = process.env.TEST_SUPPLIERS_REPORT_DATABASE_URL;
if (postgresUrl) {
  const { validatePostgresTestTarget } = await import("./postgres/_safe-target");
  validatePostgresTestTarget({ ...process.env, TEST_DATABASE_URL: postgresUrl });
}
vi.stubEnv("USE_LOCAL_DB", postgresUrl ? "false" : "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
vi.stubEnv("DATABASE_URL", postgresUrl ?? "");
vi.stubEnv("CLINIC_TIME_ZONE", "Asia/Aden");
const { ensureSchema, getPool, resetPoolForTesting, partyStatement, payableAmountSql, payableSettledTotalSql } = await import("../lib/db");
const { buildReport, parseFilters } = await import("../lib/reports");
const q = (sql: string, params: unknown[] = []) => getPool().query(sql, params);
let serial = 0;
let shift: number;
async function bill(currency: string, kind = "supplier") {
  const name = `Synthetic supplier report ${++serial}`;
  const pid = (await q("INSERT INTO parties (name, kind) VALUES ($1,$2) RETURNING id", [name, kind])).rows[0].id;
  const id = (await q(`INSERT INTO payables (party_id, description, amount_minor, currency, exchange_rate, base_amount_minor,
    source_type, as_of_date, opening_reason, created_at) VALUES ($1,$2,10000,$3,500,50000,'opening','2026-10-01','synthetic opening','2026-10-10T12:00:00+03:00') RETURNING id`, [pid, name, currency])).rows[0].id;
  return { id, pid, name };
}
async function expense(b: Awaited<ReturnType<typeof bill>>, currency: string, amount: number, settled: number | null, at = "2026-10-15T12:00:00+03:00", base = amount) {
  return (await q(`INSERT INTO expenses (voucher_number,category,party_id,shift_id,amount_minor,currency,base_amount_minor,payable_id,payable_settled_minor,created_at)
    VALUES ($1,'supplier',$2,$3,$4,$5,$6,$7,$8,$9::timestamptz) RETURNING id`, [`SPR-${++serial}`, b.pid, shift, amount, currency, base, b.id, settled, at])).rows[0].id;
}
async function report(name: string, to = "2026-10-31", currency = "all") {
  const result = await buildReport("suppliers", parseFilters(new URLSearchParams({ preset: "custom", from: "2026-10-20", to, currency })));
  return { result, row: result.rows?.find(row => row.partyName === name) };
}
beforeAll(async () => {
  await ensureSchema();
  await q(postgresUrl ? "SET TIME ZONE 'UTC'" : "SET TIME ZONE 'Asia/Aden'");
  shift = (await q("INSERT INTO cashier_shifts (opened_by) VALUES ('synthetic supplier report') RETURNING id")).rows[0].id;
}, 120000);
afterAll(async () => { await resetPoolForTesting(); vi.unstubAllEnvs(); });

describe("canonical payable SQL compatibility", () => {
  it("keeps live readers unbounded unless a cutoff is explicitly supplied", () => {
    expect(payableAmountSql("b")).toBe("(b.amount_minor + COALESCE((SELECT SUM(pa.delta_minor) FROM payable_adjustments pa WHERE pa.payable_id = b.id), 0))");
    expect(payableSettledTotalSql("b")).not.toContain("AT TIME ZONE");
    expect(payableSettledTotalSql("b")).toContain("COALESCE(se.payable_settled_minor, CASE");
    expect(payableSettledTotalSql("b")).toContain("WHERE sa.payable_id = b.id), 0)");
  });
});

describe("supplier report reconciles native payable authority at clinic cutoff", () => {
  it.each(["YER", "SAR", "USD"])("includes signed opening corrections in %s and excludes future corrections", async currency => {
    const b = await bill(currency);
    await q(`INSERT INTO payable_adjustments (payable_id,delta_minor,reason,created_by,created_at) VALUES
      ($1,-2000,'synthetic correction','test','2026-10-31T20:59:59.999Z'),
      ($1,3000,'future correction','test','2026-10-31T21:00:00Z')`, [b.id]);
    expect((await report(b.name)).row).toMatchObject({ currency, amountMinor: 8000, remainingMinor: 8000 });
    expect((await report(b.name, "2026-11-01")).row).toMatchObject({ amountMinor: 11000, remainingMinor: 11000 });
  });
  it.each(["YER", "SAR", "USD"])("uses recorded settlements and excludes future reversal in %s", async currency => {
    const b = await bill(currency, "lab");
    await expense(b, "YER", 25000, 4000, "2026-10-31T20:59:59.999Z");
    await expense(b, "YER", -25000, -4000, "2026-10-31T21:00:00Z");
    expect((await report(b.name)).row).toMatchObject({ settledMinor: 4000, remainingMinor: 6000 });
    expect((await report(b.name, "2026-11-01")).row).toMatchObject({ settledMinor: 0, remainingMinor: 10000 });
  });
  it.each(["YER", "SAR", "USD"])("matches the statement for historical same-currency null snapshots in %s", async currency => {
    const b = await bill(currency);
    await expense(b, currency, 3000, null);
    const row = (await report(b.name)).row;
    expect(row).toMatchObject({ currency, settledMinor: 3000, remainingMinor: 7000 });
    const statement = await partyStatement(b.pid);
    expect(statement?.payables.find(p => p.id === b.id)).toMatchObject({ settledMinor: row?.settledMinor, remainingMinor: row?.remainingMinor });
  });
  it("uses historical cross-currency fallback without current FX or receipt rewriting", async () => {
    const b = await bill("USD", "lab");
    const eid = await expense(b, "SAR", 2000, null, undefined, 15000);
    expect((await report(b.name)).row).toMatchObject({ currency: "USD", settledMinor: 3000, remainingMinor: 7000 });
    expect((await q("SELECT payable_settled_minor FROM expenses WHERE id=$1", [eid])).rows[0].payable_settled_minor).toBeNull();
  });
  it("retains signed batch allocations by their own clinic cutoff and source currency", async () => {
    const b = await bill("SAR", "lab");
    // A batch voucher is unlinked; its allocation is the sole settlement authority.
    const eid = (await q(`INSERT INTO expenses (voucher_number,category,party_id,shift_id,amount_minor,currency,base_amount_minor,created_at)
      VALUES ($1,'lab',$2,$3,9000,'YER',9000,'2026-10-15T12:00:00+03:00') RETURNING id`, [`SPR-${++serial}`, b.pid, shift])).rows[0].id;
    await q(`INSERT INTO expense_payable_allocations (expense_id,payable_id,paid_minor,payable_currency,payable_exchange_rate,settled_minor,created_at) VALUES
      ($1,$2,9000,'SAR',500,2000,'2026-10-31T20:59:59.999Z'),
      ($1,$2,-9000,'SAR',500,-2000,'2026-10-31T21:00:00Z')`, [eid,b.id]);
    expect((await report(b.name)).row).toMatchObject({ currency: "SAR", settledMinor: 2000, remainingMinor: 8000 });
    expect((await report(b.name, "2026-11-01")).row).toMatchObject({ settledMinor: 0, remainingMinor: 10000 });
    expect((await report(b.name, "2026-10-31", "USD")).row).toBeUndefined();
  });
  it("uses the saved base amount for a legacy payment against a base-currency payable", async () => {
    const b = await bill("YER");
    await expense(b, "SAR", 100, null, undefined, 5000);
    expect((await report(b.name)).row).toMatchObject({ settledMinor: 5000, remainingMinor: 5000 });
  });

});
