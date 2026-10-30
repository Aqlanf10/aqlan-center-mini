import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  query: vi.fn(), poolQuery: vi.fn(), connect: vi.fn(), release: vi.fn(), end: vi.fn(),
}));
// The actual accounting writer runs; every SQL boundary is synthetic. Neither
// pg nor PGlite can open a connection, including during ensureSchema.
vi.mock("pg", () => ({ Pool: class {
  query = boundary.poolQuery;
  connect = boundary.connect;
  end = boundary.end;
} }));
vi.mock("@electric-sql/pglite", () => ({ PGlite: class {
  constructor() { throw new Error("Local database is forbidden in this unit suite"); }
} }));
import { ensureSchema, resetPoolForTesting, updateLabOrderAccounting } from "../lib/db";

const originalOrder = () => ({
  id: 11, party_id: 7, lab_name: "Synthetic lab", work_type: "Synthetic crown",
  details: null, tooth_numbers: "16", due_date: new Date("2026-10-12T00:00:00Z"),
  sent_date: new Date("2026-10-05T00:00:00Z"), cost_minor: "2500", cost_currency: "USD",
  base_amount_minor: "13278", exchange_rate: "531.125000", payable_id: 23, is_posted: true, financial_status: "payable_created",
  expense_category_id: null as number | null, expense_account_code: "5101", payable_account_code: "2101",
});
let order: ReturnType<typeof originalOrder> | null;
let failure: RegExp | null;
let invoiceDate: string | null = null;
let trackingHistory = false;
let paid = false; let cutoff = ""; let busy = false;
const fault = new Error("Synthetic accounting write failure");

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic@127.0.0.1:54329/aqlan_p1_test?sslmode=disable");
  vi.stubEnv("USE_LOCAL_DB", undefined);
  vi.stubEnv("RAILWAY_PROJECT_ID", undefined);
  vi.stubEnv("SKIP_SEED", "true");
  boundary.end.mockResolvedValue(undefined);
  await resetPoolForTesting();
  boundary.poolQuery.mockResolvedValue({ rows: [] });
  boundary.query.mockImplementation(async(sql:string)=>({rows:sql.includes("AS present")?[{present:false}]:[]}));
  boundary.connect.mockResolvedValue({ query: boundary.query, release: boundary.release });
  await ensureSchema();
  // The real additive bootstrap now reserves a migration connection. Start
  // accounting assertions after that synthetic bootstrap, with the same bounds.
  boundary.poolQuery.mockClear();
  boundary.query.mockClear(); boundary.connect.mockClear(); boundary.release.mockClear();
  order = originalOrder(); failure = null; paid = false; cutoff = ""; busy = false; invoiceDate = null; trackingHistory = false;
  boundary.query.mockImplementation(async (sql: string) => {
    if (failure?.test(sql)) throw fault;
    if (/FROM lab_orders WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: order ? [order] : [] };
    if (/FROM payables.*FOR UPDATE NOWAIT/s.test(sql)) {
      if (busy) throw Object.assign(new Error("busy"), { code: "55P03" });
      return { rows: [{ id: 23, party_id: 7, lab_order_id: 11, source_type: "operational", created_date: "2026-10-05" }] };
    }
    if (/AS has_settlement/.test(sql)) return { rows: [{ has_settlement: paid || (trackingHistory && sql.includes("financial_settlement_reversed")) }] };
    if (/AS invoice_date/.test(sql)) return { rows: invoiceDate ? [{ invoice_date: invoiceDate }] : [] };
    if (/SELECT value FROM settings/.test(sql)) return { rows: [{ value: cutoff }] };
    if (/INSERT INTO payables/.test(sql)) return { rows: [{ id: 29 }] };
    return { rows: [] };
  });
});
afterEach(async () => { await resetPoolForTesting(); vi.unstubAllEnvs(); });


describe("lab accounting financial safety", () => {
  it("blocks legacy batch history after reversal reset the paid marker", async () => {
    trackingHistory = true;
    await expect(updateLabOrderAccounting(11, { costMinor: 3000 })).rejects.toThrow("lab_order_accounting_settled");
    const history = boundary.query.mock.calls.find(([sql]) => /AS has_settlement/.test(sql));
    expect(history?.[0]).toContain("lab_order_id = $2");
    expect(history?.[1]).toEqual([[23], 11]);
  });
  it("writes detailed financial evidence only to protected audit, not clinical tracking", async () => {
    await updateLabOrderAccounting(11, { costMinor: 3000 });
    const tracking = boundary.query.mock.calls.find(([sql]) => /INSERT INTO lab_order_tracking/.test(sql));
    expect(tracking?.[1]?.[4]).not.toContain("3000");
    expect(boundary.query.mock.calls.some(([sql]) => /INSERT INTO audit_log/.test(sql))).toBe(true);
  });
  it("blocks revaluation of a closed earlier linked patient invoice", async () => {
    cutoff = "2026-10-01"; invoiceDate = "2026-09-20";
    await expect(updateLabOrderAccounting(11, { costMinor: 3000 })).rejects.toThrow("lab_order_accounting_period_locked");
  });
  it.each([null, 0, -1])("rejects clearing/invalid debt amount %s rather than corrupting paired snapshots", async costMinor => {
    await expect(updateLabOrderAccounting(11, { costMinor })).rejects.toThrow("lab_order_accounting_price_invalid");
  });
  it.each([
    { costMinor: 3000 }, { costCurrency: "SAR" as const }, { exchangeRate: 540 },
    { isPosted: false }, { expenseAccountCode: "5102" }, { expenseCategoryId: 5 },
    { payableAccountCode: "2102" },
  ])("rejects every financially material change after settlement: %j", async input => {
    paid = true;
    await expect(updateLabOrderAccounting(11, input)).rejects.toThrow("lab_order_accounting_settled");
    expect(boundary.query.mock.calls.some(([sql]) => /UPDATE lab_orders|UPDATE payables|INSERT INTO lab_order_tracking|INSERT INTO audit_log/.test(sql))).toBe(false);
    expect(boundary.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
  });
  it("blocks closed-period changes under a settings fence", async () => {
    cutoff = "2026-10-06";
    await expect(updateLabOrderAccounting(11, { costMinor: 3000 })).rejects.toThrow("lab_order_accounting_period_locked");
    expect(boundary.query.mock.calls.some(([sql]) => sql === "LOCK TABLE settings IN SHARE MODE NOWAIT")).toBe(true);
    expect(boundary.query.mock.calls.some(([sql]) => /UPDATE lab_orders/.test(sql))).toBe(false);
  });
  it("rejects a concurrent payment lock without waiting or writing", async () => {
    busy = true;
    await expect(updateLabOrderAccounting(11, { costMinor: 3000 })).rejects.toThrow("lab_order_accounting_busy");
    expect(boundary.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
  });
  it("reads settlement history in a fresh statement after the payable lock", async () => {
    await updateLabOrderAccounting(11, { costMinor: 3000 });
    const sql = boundary.query.mock.calls.map(([query]) => query as string);
    const lock = sql.findIndex(query => /FROM payables.*FOR UPDATE NOWAIT/s.test(query));
    const history = sql.findIndex(query => /AS has_settlement/.test(query));
    expect(lock).toBeGreaterThan(0); expect(history).toBeGreaterThan(lock);
    expect(sql[history]).toContain("expense_payable_allocations");
    expect(sql[history]).toContain("expenses");
  });
  it("preserves an explicitly overridden saved account when category is omitted", async () => {
    order!.expense_category_id = 5; order!.expense_account_code = "5102";
    await updateLabOrderAccounting(11, {});
    expect(boundary.query.mock.calls.some(([sql]) => /FROM expense_categories|UPDATE lab_orders|UPDATE payables/.test(sql))).toBe(false);
  });
  it("accepts an exact no-op for a paid closed-period order without changing state or audit", async () => {
    paid = true; order!.financial_status = "paid"; cutoff = "2026-10-06";
    await updateLabOrderAccounting(11, {});
    expect(boundary.query.mock.calls.some(([sql]) => /UPDATE lab_orders|UPDATE payables|INSERT INTO lab_order_tracking|INSERT INTO audit_log/.test(sql))).toBe(false);
    expect(boundary.query.mock.calls.at(-1)).toEqual(["COMMIT"]);
  });
});
