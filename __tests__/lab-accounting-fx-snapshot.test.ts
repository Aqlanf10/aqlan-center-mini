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
  base_amount_minor: "13278", exchange_rate: "531.125000", payable_id: 23, is_posted: true,
});
let order: ReturnType<typeof originalOrder> | null;
let failure: RegExp | null;
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
  boundary.connect.mockResolvedValue({ query: boundary.query, release: boundary.release });
  await ensureSchema();
  boundary.poolQuery.mockClear();
  order = originalOrder(); failure = null;
  boundary.query.mockImplementation(async (sql: string) => {
    if (failure?.test(sql)) throw fault;
    if (/FROM lab_orders WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: order ? [order] : [] };
    if (/INSERT INTO payables/.test(sql)) return { rows: [{ id: 29 }] };
    return { rows: [] };
  });
});
afterEach(async () => { await resetPoolForTesting(); vi.unstubAllEnvs(); });

function statement(pattern: RegExp) {
  const calls = boundary.query.mock.calls.filter(([sql]) => pattern.test(sql));
  expect(calls).toHaveLength(1);
  return { sql: calls[0][0] as string, values: calls[0][1] as unknown[] };
}
function assertPair(cost: number, currency: string, rate: number, base: number) {
  const o = statement(/UPDATE lab_orders\s+SET expense_category_id/);
  const p = statement(/UPDATE payables\s+SET expense_category_id/);
  expect(o.values).toEqual([null, "5101", "2101", true, cost, currency, 11, true, base, rate]);
  expect(p.values).toEqual([null, "5101", "2101", true, cost, currency, base, 23, true, rate]);
  // Check the actual SQL binds the converted base and rate, not the source
  // amount. Real SQL persistence and numeric storage are covered in PG CI.
  expect(o.sql).toMatch(/base_amount_minor = CASE WHEN \$8::boolean AND \$5::bigint > 0 THEN \$9::bigint ELSE base_amount_minor END/);
  expect(o.sql).toMatch(/exchange_rate = CASE WHEN \$8::boolean AND \$5::bigint > 0 THEN \$10::numeric ELSE exchange_rate END/);
  expect(p.sql).toMatch(/base_amount_minor = CASE WHEN \$9::boolean AND \$5::bigint > 0 THEN \$7::bigint ELSE base_amount_minor END/);
  expect(p.sql).toMatch(/exchange_rate = CASE WHEN \$9::boolean AND \$5::bigint > 0 THEN \$10::numeric ELSE exchange_rate END/);
}

describe("actual lab accounting writer money snapshot bindings", () => {
  it.each([
    ["USD", 7500, 531.125, 39834], ["SAR", 7500, 141.25, 10594],
    ["YER", 7500, 1, 7500], ["USD", 1, 531.123456, 5],
  ] as const)("keeps %s minor units, conversion and rate together", async (currency, cost, rate, base) => {
    await updateLabOrderAccounting(11, { costMinor: cost, costCurrency: currency, exchangeRate: rate });
    assertPair(cost, currency, rate, base);
    expect(boundary.query.mock.calls.at(-1)).toEqual(["COMMIT"]);
    expect(boundary.release).toHaveBeenCalledTimes(1);
  });
  it("uses the saved FX rate for a cost-only edit", async () => {
    await updateLabOrderAccounting(11, { costMinor: 7500 });
    assertPair(7500, "USD", 531.125, 39834);
  });
  it("revalues using an explicit new rate without changing source minor units", async () => {
    await updateLabOrderAccounting(11, { exchangeRate: 540.123456 });
    assertPair(2500, "USD", 540.123456, 13503);
  });
  it.each([true, false])("preserves each saved money snapshot for metadata-only isPosted=%s", async isPosted => {
    order!.base_amount_minor = "13001"; // Deliberate legacy value: no implicit repair.
    await updateLabOrderAccounting(11, { isPosted, expenseAccountCode: "5102" });
    const o = statement(/UPDATE lab_orders\s+SET expense_category_id/);
    const p = statement(/UPDATE payables\s+SET expense_category_id/);
    expect(o.values[7]).toBe(false); expect(o.values[8]).toBe(13001);
    expect(p.values[8]).toBe(false);
    for (const column of ["cost_minor", "cost_currency", "base_amount_minor", "exchange_rate"]) {
      expect(o.sql).toMatch(new RegExp(`${column} = CASE WHEN \\$8::boolean[\\s\\S]*?ELSE ${column} END`));
    }
    for (const column of ["amount_minor", "currency", "base_amount_minor", "exchange_rate"]) {
      expect(p.sql).toMatch(new RegExp(`${column} = CASE WHEN \\$9::boolean[\\s\\S]*?ELSE ${column} END`));
    }
  });
  it("carries the same snapshot through missing-payable insertion and conflict update", async () => {
    order!.payable_id = null as unknown as number;
    await updateLabOrderAccounting(11, { costMinor: 7500, costCurrency: "SAR", exchangeRate: 141.25 });
    const insert = statement(/INSERT INTO payables/);
    expect(insert.values.slice(2, 6)).toEqual([7500, "SAR", 141.25, 10594]);
    expect(insert.sql).toContain("exchange_rate = CASE WHEN $14::boolean THEN EXCLUDED.exchange_rate ELSE payables.exchange_rate END");
    expect(insert.values[13]).toBe(true);
    const o = statement(/UPDATE lab_orders\s+SET expense_category_id/);
    expect(o.values.slice(7)).toEqual([true, 10594, 141.25]);
  });
  it("preserves a conflicting payable snapshot when only relinking accounting metadata", async () => {
    order!.payable_id = null as unknown as number;
    await updateLabOrderAccounting(11, { isPosted: false });
    const insert = statement(/INSERT INTO payables/);
    expect(insert.values[13]).toBe(false);
    for (const column of ["amount_minor", "currency", "exchange_rate", "base_amount_minor"]) {
      expect(insert.sql).toContain(`${column} = CASE WHEN $14::boolean THEN EXCLUDED.${column} ELSE payables.${column} END`);
    }
  });
  it.each([
    { costMinor: 100, exchangeRate: 0.49999999, error: "lab_order_exchange_rate_invalid" },
    { costMinor: 100, exchangeRate: 1.0000004, error: "lab_order_exchange_rate_invalid" },
    { costMinor: 100, exchangeRate: Infinity, error: "lab_order_exchange_rate_invalid" },
    { costMinor: 100, exchangeRate: 1_000_001, error: "lab_order_exchange_rate_invalid" },
    { costMinor: Number.MAX_SAFE_INTEGER + 1, exchangeRate: 1, error: "lab_order_accounting_price_invalid" },
    { costMinor: Number.MAX_SAFE_INTEGER, exchangeRate: 1_000_000, error: "lab_order_accounting_price_invalid" },
    { costMinor: 0.5, exchangeRate: 1, error: "lab_order_accounting_price_invalid" },
  ])("rejects unsafe positive monetary input before either write: $costMinor at $exchangeRate", async ({ error, ...input }) => {
    await expect(updateLabOrderAccounting(11, input)).rejects.toThrow(error);
    expect(boundary.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN", expect.stringContaining("FROM lab_orders WHERE id = $1 FOR UPDATE"), "ROLLBACK",
    ]);
    expect(boundary.release).toHaveBeenCalledTimes(1);
  });
  it.each([/UPDATE payables\s+SET expense_category_id/, /INSERT INTO lab_order_tracking/])(
    "rolls back and releases on a late failure at %s", async failAt => {
      failure = failAt;
      await expect(updateLabOrderAccounting(11, { costMinor: 7500, exchangeRate: 540 })).rejects.toBe(fault);
      expect(boundary.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
      expect(boundary.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
      expect(boundary.release).toHaveBeenCalledTimes(1);
    });
  it("rolls back a missing order without attempting writes", async () => {
    order = null;
    expect(await updateLabOrderAccounting(11, { costMinor: 7500 })).toBeNull();
    expect(boundary.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN", expect.stringContaining("FROM lab_orders WHERE id = $1 FOR UPDATE"), "ROLLBACK",
    ]);
    expect(boundary.release).toHaveBeenCalledTimes(1);
  });
});
