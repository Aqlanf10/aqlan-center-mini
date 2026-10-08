import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { assertLocalExpenseComparisonUrl } from "./_expense-comparison-fixture-url";
import type { CompareMode, ReportResult } from "../../lib/reports-types";

/**
 * RPT-EXPENSE-COMPARISON: run the real loadContext/buildReport SQL and projections.
 * Reuses daily-clinic-expense-report.test.ts's local-only, session-TEMP pattern.
 * No migrations, public-schema reset, real writers, or production records.
 */
const harness = vi.hoisted(() => ({ client: null as Client | null }));
vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    // Schema bootstrapping must never escape the temporary fixture connection.
    ensureSchema: vi.fn(async () => {}),
    listParties: vi.fn(async () => []),
    getPool: () => {
      if (!harness.client) throw new Error("Expense comparison fixture is not connected.");
      return harness.client;
    },
  };
});

const connectionString = assertLocalExpenseComparisonUrl(assertRealPostgresUrl());
stubPostgresEnv();
const { buildReport, parseFilters } = await import("../../lib/reports");
const { CLINIC_TIME_ZONE } = await import("../../lib/db");
const client = new Client({ connectionString, ssl: false });
const fixtureTables = [
  "expenses", "payments", "patient_opening_balances", "invoice_items", "invoices",
  "visits", "plan_items", "treatment_plans", "services", "patients",
] as const;

beforeAll(async () => {
  await client.connect();
  harness.client = client;
  // An omitted fixture table must fail, never fall through to a public table.
  await client.query("SET search_path TO pg_temp");
  await client.query(`
    CREATE TEMP TABLE expenses (
      id integer PRIMARY KEY, created_at timestamptz, base_amount_minor bigint,
      category text DEFAULT 'synthetic', payee_text text DEFAULT 'synthetic recipient',
      reversal_of_id integer
    );
    CREATE TEMP TABLE patients (
      id integer PRIMARY KEY, patient_number text, full_name text, phone text,
      created_at timestamptz, referral_source text, referred_by text
    );
    CREATE TEMP TABLE visits (
      id integer PRIMARY KEY, patient_id integer, patient_name text, patient_phone text,
      arrived_at timestamptz, called_at timestamptz, seated_at timestamptz, finished_at timestamptz,
      status text, doctor_id integer, invoice_id integer, appointment_id integer, chair integer
    );
    CREATE TEMP TABLE treatment_plans (
      id integer PRIMARY KEY, patient_id integer, title text, total_minor bigint,
      base_currency text, status text, start_date date
    );
    CREATE TEMP TABLE plan_items (
      id integer PRIMARY KEY, plan_id integer, category text, quantity numeric,
      unit_price_minor bigint, status text
    );
    CREATE TEMP TABLE invoices (
      id integer PRIMARY KEY, patient_id integer, created_at timestamptz,
      total_minor bigint, discount_minor bigint, base_currency text, plan_id integer, status text
    );
    CREATE TEMP TABLE invoice_items (
      id integer PRIMARY KEY, invoice_id integer, service_id integer, description text,
      quantity numeric, total_minor bigint, doctor_id integer
    );
    CREATE TEMP TABLE services (id integer PRIMARY KEY, category text);
    CREATE TEMP TABLE payments (
      id integer PRIMARY KEY, patient_id integer, created_at timestamptz, kind text,
      amount_minor bigint, currency text, base_amount_minor bigint, method text,
      invoice_id integer, plan_id integer, opening_currency text, created_by text, note text
    );
    CREATE TEMP TABLE patient_opening_balances (
      patient_id integer, currency text, as_of_date date, amount_minor bigint
    );
  `);
});

beforeEach(async () => {
  await client.query(`TRUNCATE ${fixtureTables.map((table) => `pg_temp.${table}`).join(", ")}`);
});

afterAll(async () => {
  harness.client = null;
  await client.end();
});

async function fingerprint() {
  const snapshots = [];
  for (const table of fixtureTables) {
    const { rows } = await client.query(`
      SELECT to_jsonb(t) AS row FROM pg_temp.${table} t ORDER BY to_jsonb(t)::text
    `);
    snapshots.push({ table, rows });
  }
  return snapshots;
}

async function read(
  from: string, to: string, compare: CompareMode = "prev_period", report = "monthly",
  beforeReportWitness?: () => Promise<void>,
) {
  const filters = parseFilters(new URLSearchParams({ preset: "custom", from, to, compare }), "2026-10-08");
  // This helper owns BEGIN/ROLLBACK. Application code never owns this connection.
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    const before = await fingerprint();
    await beforeReportWitness?.();
    const result = await buildReport(report, filters);
    // PostgreSQL permits TEMP writes even in READ ONLY: verify before rolling back.
    expect(await fingerprint()).toEqual(before);
    return result;
  } finally {
    await client.query("ROLLBACK");
  }
}

type ExpenseFixture = { id: number; at: string; minor: number; reversalOf?: number };
async function expenses(rows: ExpenseFixture[]) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO pg_temp.expenses (id, created_at, base_amount_minor, reversal_of_id)
      VALUES ($1, $2::timestamptz, $3, $4)
    `, [row.id, row.at, row.minor, row.reversalOf ?? null]);
  }
}

function expenseComparison(result: ReportResult) {
  return result.comparison?.entries.find((entry) => entry.label === "المصروفات");
}
function minor(result: ReportResult, key: string) {
  return result.kpis.find((item) => item.key === key)?.minor;
}
const at = (date: string) => `${date}T12:00:00+03:00`;

describe("RPT-EXPENSE-COMPARISON", () => {
  it("reads both complete periods without contaminating current KPIs or rows", async () => {
    await expenses([
      { id: 1, at: at("2026-09-27"), minor: 90_000 },
      { id: 2, at: at("2026-09-28"), minor: 1_000 },
      { id: 3, at: at("2026-09-30"), minor: -200 }, // Recorded legacy negative adjustment.
      { id: 4, at: at("2026-10-01"), minor: 400 },
      { id: 5, at: at("2026-10-03"), minor: -100 },
      { id: 6, at: at("2026-10-04"), minor: 80_000 },
    ]);
    const result = await read("2026-10-01", "2026-10-03", "prev_period", "monthly", async () => {
      // Original-loader SQL counterfactual only, pinned to reports.ts blob
      // 7b9ce549610876127991b8f99630a7ba4f861ab1 (da35 / 30e6 main).
      // This does not execute the original application or claim old-app CI.
      const original = await client.query<{ date: string; base: string; category: string; payee: string | null }>(
        `SELECT (created_at AT TIME ZONE $1)::date::text AS date,
            base_amount_minor::text AS base, category, payee_text AS payee
       FROM expenses
      WHERE (created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`,
        [CLINIC_TIME_ZONE, "2026-10-01", "2026-10-03"],
      );
      expect(original.rows.map(({ date, base }) => ({ date, base })).sort((a, b) => a.date.localeCompare(b.date)))
        .toEqual([{ date: "2026-10-01", base: "400" }, { date: "2026-10-03", base: "-100" }]);
      expect(original.rows.filter((row) => row.date >= "2026-09-28" && row.date <= "2026-09-30"))
        .toEqual([]);
    });
    expect(expenseComparison(result)).toMatchObject({
      currency: "YER", currentMinor: 300, previousMinor: 800, changePercent: -62.5,
    });
    const currentOnly = await read("2026-10-01", "2026-10-03", "none");
    expect(currentOnly.comparison).toBeUndefined();
    expect(result.kpis).toEqual(currentOnly.kpis);
    expect(result.rows).toEqual(currentOnly.rows);
    expect(minor(result, "expenses")).toBe(300);
    expect(minor(result, "net")).toBe(-300);
  });

  it("uses clinic-local inclusive endpoints for the current and prior-year ranges", async () => {
    expect(CLINIC_TIME_ZONE).toBe("Asia/Aden");
    await expenses([
      { id: 1, at: "2025-01-09T20:59:59.999Z", minor: 90_000 },
      { id: 2, at: "2025-01-09T21:00:00Z", minor: 100 },
      { id: 3, at: "2025-01-12T20:59:59.999Z", minor: 200 },
      { id: 4, at: "2025-01-12T21:00:00Z", minor: 90_000 },
      { id: 5, at: at("2025-07-01"), minor: 90_000 },
      { id: 6, at: "2026-01-09T20:59:59.999Z", minor: 90_000 },
      { id: 7, at: "2026-01-09T21:00:00Z", minor: 400 },
      { id: 8, at: "2026-01-12T20:59:59.999Z", minor: 200 },
      { id: 9, at: "2026-01-12T21:00:00Z", minor: 90_000 },
    ]);
    expect(expenseComparison(await read("2026-01-10", "2026-01-12", "prev_year")))
      .toMatchObject({ currentMinor: 600, previousMinor: 300, changePercent: 100 });
  });

  it("normalizes reversed custom bounds and uses an equal-length inclusive previous period", async () => {
    await expenses([
      { id: 1, at: at("2026-10-06"), minor: 90_000 },
      { id: 2, at: at("2026-10-07"), minor: 1 },
      { id: 3, at: at("2026-10-08"), minor: 2 },
      { id: 4, at: at("2026-10-09"), minor: 3 },
      { id: 5, at: at("2026-10-10"), minor: 10 },
      { id: 6, at: at("2026-10-11"), minor: 20 },
      { id: 7, at: at("2026-10-12"), minor: 30 },
      { id: 8, at: at("2026-10-13"), minor: 90_000 },
    ]);
    const result = await read("2026-10-12", "2026-10-10");
    expect(result).toMatchObject({ from: "2026-10-10", to: "2026-10-12" });
    expect(expenseComparison(result)).toMatchObject({ currentMinor: 60, previousMinor: 6, changePercent: 900 });
    expect(result.comparison?.title).toContain("2026-10-07");
    expect(result.comparison?.title).toContain("2026-10-09");
  });

  it("keeps a later-period reversal on its actual date instead of moving it to the original", async () => {
    await expenses([
      { id: 1, at: at("2026-10-06"), minor: 1_000 },
      { id: 2, at: at("2026-10-07"), minor: -1_000, reversalOf: 1 },
    ]);
    const result = await read("2026-10-07", "2026-10-07");
    expect(expenseComparison(result)).toMatchObject({ currentMinor: -1_000, previousMinor: 1_000, changePercent: -200 });
    expect(minor(result, "expenses")).toBe(-1_000);
    expect(minor(result, "net")).toBe(1_000);
  });

  it("retains a reversal-only prior period even when its original is outside both ranges", async () => {
    await expenses([
      { id: 1, at: at("2026-09-01"), minor: 250 },
      { id: 2, at: at("2026-10-06"), minor: -250, reversalOf: 1 },
    ]);
    expect(expenseComparison(await read("2026-10-07", "2026-10-07")))
      .toMatchObject({ currentMinor: 0, previousMinor: -250 });
  });

  it("keeps same-period original/reversal net zero and does not invent a prior value", async () => {
    await expenses([
      { id: 1, at: at("2026-10-07"), minor: 700 },
      { id: 2, at: at("2026-10-07"), minor: -700, reversalOf: 1 },
    ]);
    expect(expenseComparison(await read("2026-10-07", "2026-10-07")))
      .toMatchObject({ currentMinor: 0, previousMinor: 0, changePercent: null });
  });

  it("does not duplicate a source row when a long custom prior-year period overlaps the current one", async () => {
    await expenses([
      { id: 1, at: at("2024-08-01"), minor: 50 },
      { id: 2, at: at("2025-06-15"), minor: 100 },
      { id: 3, at: at("2026-01-01"), minor: 200 },
    ]);
    expect(expenseComparison(await read("2025-06-01", "2026-06-30", "prev_year")))
      .toMatchObject({ currentMinor: 300, previousMinor: 150, changePercent: 100 });
  });

  it("keeps the existing leap-day prior-year clamping", async () => {
    await expenses([
      { id: 1, at: at("2023-02-28"), minor: 100 },
      { id: 2, at: at("2023-03-01"), minor: 90_000 },
      { id: 3, at: at("2024-02-28"), minor: 90_000 },
      { id: 4, at: at("2024-02-29"), minor: 200 },
    ]);
    expect(expenseComparison(await read("2024-02-29", "2024-02-29", "prev_year")))
      .toMatchObject({ currentMinor: 200, previousMinor: 100, changePercent: 100 });
  });

  it.each(["daily", "annual"])("does not widen expenses for %s even when compare is supplied", async (report) => {
    await expenses([
      { id: 1, at: at("2026-09-28"), minor: 8_000 },
      { id: 2, at: at("2026-10-01"), minor: 400 },
      { id: 3, at: at("2026-10-03"), minor: -100 },
      { id: 4, at: at("2026-10-04"), minor: 90_000 },
    ]);
    const result = await read("2026-10-01", "2026-10-03", "prev_period", report);
    const currentOnly = await read("2026-10-01", "2026-10-03", "none", report);
    expect(result.kpis).toEqual(currentOnly.kpis);
    expect(result.monthly).toEqual(currentOnly.monthly);
    expect(minor(result, "expenses")).toBe(300);
  });

  it("preserves patient refunds in collection comparisons without treating them as expenses", async () => {
    await client.query(`
      INSERT INTO pg_temp.patients (id, patient_number, full_name, created_at)
        VALUES (1, 'SYN-EXP-1', 'Synthetic expense comparison patient', '2026-01-01 12:00+03');
      INSERT INTO pg_temp.patient_opening_balances VALUES (1, 'YER', '2026-01-01', 10000);
      INSERT INTO pg_temp.payments (id, patient_id, created_at, kind, amount_minor, currency, base_amount_minor, method)
        VALUES (1, 1, '2026-09-30 12:00+03', 'payment', 2000, 'YER', 2000, 'cash'),
               (2, 1, '2026-09-30 13:00+03', 'refund', 500, 'YER', 500, 'cash'),
               (3, 1, '2026-10-01 12:00+03', 'payment', 3000, 'YER', 3000, 'cash'),
               (4, 1, '2026-10-01 13:00+03', 'refund', 700, 'YER', 700, 'cash');
    `);
    await expenses([
      { id: 1, at: at("2026-09-30"), minor: 200 },
      { id: 2, at: at("2026-10-01"), minor: 350 },
    ]);
    const result = await read("2026-10-01", "2026-10-01");
    expect(result.comparison?.entries.find((entry) => entry.label === "التحصيل"))
      .toMatchObject({ currentMinor: 2_300, previousMinor: 1_500 });
    expect(expenseComparison(result)).toMatchObject({ currentMinor: 350, previousMinor: 200 });
    expect(minor(result, "collected")).toBe(2_300);
    expect(minor(result, "expenses")).toBe(350);
    expect(result.kpis).toEqual((await read("2026-10-01", "2026-10-01", "none")).kpis);
  });
});
