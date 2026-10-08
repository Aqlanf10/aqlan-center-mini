import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { assertLocalExpenseComparisonUrl } from "./_expense-comparison-fixture-url";
import type { ReportResult } from "../../lib/reports-types";
import type { Currency } from "../../lib/money";
import { applyReportView, moneyTotalsByCurrency } from "../../lib/report-view";

/**
 * RPT-PERIOD-BOUNDARIES: annual month rows use the real loader and projection.
 * Reuses the PR297 expense-comparison local-only, session-TEMP harness and guard.
 * No migrations, public-schema reset, real writers, or production records.
 * SOURCE ONLY: this file is authored for a later authorized isolated run.
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
      if (!harness.client) throw new Error("Annual report fixture is not connected.");
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

async function read(params: Record<string, string>) {
  const filters = parseFilters(new URLSearchParams(params), "2026-10-08");
  // Application execution is read-only, and TEMP contents are fingerprinted too.
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    const before = await fingerprint();
    const result = await buildReport("annual", filters);
    expect(await fingerprint()).toEqual(before);
    return result;
  } finally {
    await client.query("ROLLBACK");
  }
}

const annual = (from: string, to: string) => read({ preset: "custom", from, to });
const at = (date: string) => `${date}T12:00:00+03:00`;
const minor = (result: ReportResult, key: string) => result.kpis.find((item) => item.key === key)?.minor;
const count = (result: ReportResult, key: string) => result.kpis.find((item) => item.key === key)?.count;
const text = (result: ReportResult, key: string) => result.kpis.find((item) => item.key === key)?.text;
const rows = (result: ReportResult) => result.monthly?.rows ?? [];

async function patient(id: number, createdAt: string) {
  await client.query(
    "INSERT INTO pg_temp.patients (id, patient_number, full_name, created_at) VALUES ($1, $2, $3, $4::timestamptz)",
    [id, `ANNUAL-${id}`, `Synthetic annual patient ${id}`, createdAt],
  );
}

async function invoice(id: number, patientId: number, createdAt: string, value: number, currency: Currency = "YER") {
  await client.query(
    "INSERT INTO pg_temp.invoices (id, patient_id, created_at, total_minor, discount_minor, base_currency, status) VALUES ($1, $2, $3::timestamptz, $4, 0, $5, 'issued')",
    [id, patientId, createdAt, value, currency],
  );
  await client.query(
    "INSERT INTO pg_temp.invoice_items (id, invoice_id, description, quantity, total_minor) VALUES ($1, $1, 'Synthetic service', 1, $2)",
    [id, value],
  );
}

async function payment(id: number, patientId: number, invoiceId: number, createdAt: string, value: number, currency: Currency = "YER") {
  await client.query(
    "INSERT INTO pg_temp.payments (id, patient_id, invoice_id, created_at, kind, amount_minor, currency, base_amount_minor, method) VALUES ($1, $2, $3, $4::timestamptz, 'payment', $5, $6, $7, 'cash')",
    // Foreign payments settle their same-currency invoices by native amount.
    // The deliberately different stored base equivalent must not become a new FX policy.
    [id, patientId, invoiceId, createdAt, value, currency, currency === "YER" ? value : 987_654],
  );
}

async function expense(id: number, createdAt: string, value: number, reversalOf: number | null = null) {
  await client.query(
    "INSERT INTO pg_temp.expenses (id, created_at, base_amount_minor, reversal_of_id) VALUES ($1, $2::timestamptz, $3, $4)",
    [id, createdAt, value, reversalOf],
  );
}

async function visit(id: number, patientId: number, arrivedAt: string) {
  await client.query(
    "INSERT INTO pg_temp.visits (id, patient_id, arrived_at, status) VALUES ($1, $2, $3::timestamptz, 'finished')",
    [id, patientId, arrivedAt],
  );
}

describe("RPT-PERIOD-BOUNDARIES annual month rows", () => {
  it("clips both partial-month endpoints for movements, counts and closing balance in clinic time", async () => {
    expect(CLINIC_TIME_ZONE).toBe("Asia/Aden");
    const before = "2026-04-09T20:59:59.999Z";
    const first = "2026-04-09T21:00:00Z";
    const last = "2026-04-20T20:59:59.999Z";
    const after = "2026-04-20T21:00:00Z";
    await patient(1, first);
    await patient(2, before);
    await patient(3, after);
    await invoice(1, 1, first, 1_000);
    await invoice(2, 1, last, 2_000);
    await invoice(3, 2, before, 90_000);
    await invoice(4, 3, after, 80_000);
    await payment(1, 1, 1, first, 400);
    await payment(2, 1, 2, last, 600);
    await payment(3, 2, 3, before, 90_000);
    await visit(1, 1, first);
    await visit(2, 1, last);
    await visit(3, 2, before);
    await visit(4, 3, after);
    await expense(1, before, 90_000);
    await expense(2, first, 30);
    await expense(3, last, 40);
    await expense(4, after, 80_000);

    const result = await annual("2026-04-10", "2026-04-20");
    expect(result).toMatchObject({
      from: "2026-04-10", to: "2026-04-20", subtitle: "سنة 2026",
      periodLabel: "10/04/2026 → 20/04/2026",
    });
    expect(rows(result)).toEqual([{
      monthLabel: "أبريل", currency: "YER", patients: 1, visits: 2, services: 2,
      servicesMinor: 3_000, collectedMinor: 1_000, debtMinor: 2_000,
      expensesMinor: 70, outstandingMinor: 2_000,
    }]);
    expect(result.bars).toEqual([{ label: "أبريل", minor: 1_000 }]);
    expect(minor(result, "revenue")).toBe(3_000);
    expect(minor(result, "collected")).toBe(1_000);
    expect(minor(result, "expenses")).toBe(70);
    expect(minor(result, "debt")).toBe(2_000);
    expect(count(result, "patients")).toBe(1);
    expect(count(result, "new")).toBe(1);
    // The shared parser remains the authority for reversed custom bounds.
    const reversed = await annual("2026-04-20", "2026-04-10");
    expect(reversed).toEqual(result);
  });

  it("includes clipped December and January without mixing native currencies or base expenses", async () => {
    const cases = [
      { id: 1, currency: "YER" as const, dec: 1_000, decPaid: 400, jan: 2_000, janPaid: 800, end: 1_800 },
      { id: 2, currency: "SAR" as const, dec: 300, decPaid: 100, jan: 500, janPaid: 150, end: 550 },
      { id: 3, currency: "USD" as const, dec: 400, decPaid: 200, jan: 600, janPaid: 250, end: 550 },
    ];
    for (const entry of cases) {
      await patient(entry.id, at("2026-12-20"));
      await invoice(entry.id, entry.id, at("2026-12-20"), entry.dec, entry.currency);
      await payment(entry.id, entry.id, entry.id, at("2026-12-20"), entry.decPaid, entry.currency);
      await invoice(entry.id + 10, entry.id, at("2027-01-10"), entry.jan, entry.currency);
      await payment(entry.id + 10, entry.id, entry.id + 10, at("2027-01-10"), entry.janPaid, entry.currency);
    }
    await invoice(90, 1, at("2027-01-11"), 90_000);
    await expense(1, at("2026-12-19"), 90_000);
    await expense(2, at("2026-12-20"), 71);
    await expense(3, at("2027-01-10"), 83);
    await expense(4, at("2027-01-11"), 80_000);

    const result = await annual("2026-12-20", "2027-01-10");
    expect(result.subtitle).toBe("السنوات 2026 → 2027");
    expect(result.periodLabel).toBe("20/12/2026 → 10/01/2027");
    expect(rows(result)).toHaveLength(6);
    expect(rows(result).map((row) => [row.monthLabel, row.currency])).toEqual([
      ["ديسمبر 2026", "YER"], ["ديسمبر 2026", "SAR"], ["ديسمبر 2026", "USD"],
      ["يناير 2027", "YER"], ["يناير 2027", "SAR"], ["يناير 2027", "USD"],
    ]);
    for (const entry of cases) {
      const currencyRows = rows(result).filter((row) => row.currency === entry.currency);
      expect(currencyRows.map((row) => row.servicesMinor)).toEqual([entry.dec, entry.jan]);
      expect(currencyRows.map((row) => row.collectedMinor)).toEqual([entry.decPaid, entry.janPaid]);
      expect(currencyRows.map((row) => row.expensesMinor)).toEqual(entry.currency === "YER" ? [71, 83] : [0, 0]);
      expect(currencyRows[1].outstandingMinor).toBe(entry.end);
      const suffix = entry.currency === "YER" ? "" : `-${entry.currency}`;
      expect(minor(result, `revenue${suffix}`)).toBe(entry.dec + entry.jan);
      expect(minor(result, `collected${suffix}`)).toBe(entry.decPaid + entry.janPaid);
      expect(minor(result, `debt${suffix}`)).toBe(entry.end);
    }
    expect(minor(result, "expenses")).toBe(154);
    expect(text(result, "best")).toBe("يناير 2027");
    expect(result.bars).toEqual([{ label: "ديسمبر 2026", minor: 400 }, { label: "يناير 2027", minor: 800 }]);
  });

  it("retains a leap day and stops on the requested day of the next month", async () => {
    await patient(1, at("2024-02-29"));
    await invoice(1, 1, "2024-02-28T21:00:00Z", 100);
    await payment(1, 1, 1, "2024-02-28T21:00:00Z", 40);
    await invoice(2, 1, "2024-03-01T20:59:59.999Z", 200);
    await payment(2, 1, 2, "2024-03-01T20:59:59.999Z", 80);
    await invoice(3, 1, "2024-03-01T21:00:00Z", 90_000);
    await expense(1, "2024-02-28T20:59:59.999Z", 90_000);
    await expense(2, "2024-02-28T21:00:00Z", 29);
    await expense(3, "2024-03-01T20:59:59.999Z", 31);
    await expense(4, "2024-03-01T21:00:00Z", 80_000);

    const result = await annual("2024-02-29", "2024-03-01");
    expect(rows(result).map((row) => [row.monthLabel, row.servicesMinor, row.collectedMinor, row.expensesMinor, row.outstandingMinor]))
      .toEqual([["فبراير", 100, 40, 29, 60], ["مارس", 200, 80, 31, 180]]);
    expect(result.bars).toEqual([{ label: "فبراير", minor: 40 }, { label: "مارس", minor: 80 }]);
    expect(minor(result, "revenue")).toBe(300);
    expect(minor(result, "expenses")).toBe(60);
    expect(minor(result, "debt")).toBe(180);
  });

  it("keeps zero-income expense months, negative adjustments and net-zero reversals as base rows", async () => {
    await expense(1, at("2026-02-01"), 500);
    await expense(2, at("2026-03-01"), -200);
    await expense(3, at("2026-04-01"), 700);
    await expense(4, at("2026-04-01"), -700, 3);
    await expense(5, at("2026-05-01"), 0);
    const result = await annual("2026-01-01", "2026-05-31");
    expect(rows(result).map((row) => [row.monthLabel, row.currency, row.expensesMinor]))
      .toEqual([["فبراير", "YER", 500], ["مارس", "YER", -200], ["أبريل", "YER", 0], ["مايو", "YER", 0]]);
    for (const row of rows(result)) {
      expect(row).toMatchObject({ servicesMinor: 0, collectedMinor: 0, outstandingMinor: 0, patients: 0, visits: 0 });
    }
    expect(result.bars).toHaveLength(5);
    expect(result.bars?.every((bar) => bar.minor === 0)).toBe(true);
    expect(minor(result, "expenses")).toBe(300);
    expect(minor(result, "revenue")).toBe(0);
    expect(minor(result, "collected")).toBe(0);
  });

  it("adds a base expense row when the month's only financial activity uses a foreign currency", async () => {
    await patient(1, at("2026-06-05"));
    await invoice(1, 1, at("2026-06-05"), 100, "SAR");
    await payment(1, 1, 1, at("2026-06-05"), 100, "SAR");
    await expense(1, at("2026-06-05"), 27);
    const result = await annual("2026-06-01", "2026-06-30");
    expect(rows(result).map((row) => [row.currency, row.servicesMinor, row.collectedMinor, row.expensesMinor]))
      .toEqual([["YER", 0, 0, 27], ["SAR", 100, 100, 0]]);
    expect(minor(result, "expenses")).toBe(27);
    expect(minor(result, "revenue")).toBe(0);
    expect(minor(result, "revenue-SAR")).toBe(100);
  });

  it("distinguishes the same month in different years in rows, grouping, bars and period labels", async () => {
    await expense(1, at("2026-01-15"), 10);
    await expense(2, at("2027-01-15"), 20);
    const result = await annual("2026-01-15", "2027-01-15");
    expect(result.subtitle).toBe("السنوات 2026 → 2027");
    expect(result.periodLabel).toBe("15/01/2026 → 15/01/2027");
    expect(rows(result).map((row) => row.monthLabel)).toEqual(["يناير 2026", "يناير 2027"]);
    expect(new Set(rows(result).map((row) => `${row.monthLabel}:${row.currency}`)).size).toBe(2);
    expect(result.bars).toHaveLength(13);
    expect(new Set(result.bars?.map((bar) => bar.label)).size).toBe(13);
    expect(result.bars?.[0].label).toBe("يناير 2026");
    expect(result.bars?.[12].label).toBe("يناير 2027");
    const grouped = applyReportView(result.monthly!.columns, rows(result), { columns: null, sort: null, group: "monthLabel" }, "YER");
    expect(grouped.groups).toHaveLength(2);
    expect(minor(result, "expenses")).toBe(30);
  });

  it("preserves closing snapshots without adding balances across months or grouped totals", async () => {
    await patient(1, at("2025-12-01"));
    await client.query(
      "INSERT INTO pg_temp.patient_opening_balances (patient_id, currency, as_of_date, amount_minor) VALUES (1, 'YER', '2025-12-01', 500)",
    );
    const result = await annual("2026-01-10", "2026-03-05");
    expect(rows(result).map((row) => row.outstandingMinor)).toEqual([500, 500, 500]);
    expect(minor(result, "debt")).toBe(500);
    const columns = result.monthly!.columns;
    const closing = columns.find((column) => column.key === "outstandingMinor")!;
    expect(closing.aggregate).toBe("none");
    expect(moneyTotalsByCurrency(rows(result), closing, "YER")).toEqual({});
    expect(columns.some((column) => column.key === "openingMinor")).toBe(false);
    const grouped = applyReportView(columns, rows(result), { columns: null, sort: null, group: "currency" }, "YER");
    expect(grouped.groups?.[0].totals).not.toHaveProperty("outstandingMinor");
    expect(grouped.groups?.[0].totals.servicesMinor).toEqual({ YER: 0 });
  });

  it("keeps recorded activity at both ends of the full 120-month request budget", async () => {
    await patient(1, at("2017-01-31"));
    await invoice(1, 1, at("2017-01-31"), 100);
    await payment(1, 1, 1, at("2017-01-31"), 100);
    await invoice(2, 1, at("2026-12-01"), 200);
    await payment(2, 1, 2, at("2026-12-01"), 200);
    await expense(1, at("2017-01-31"), 5);
    await expense(2, at("2026-12-01"), 7);
    const result = await annual("2017-01-31", "2026-12-01");
    expect(result.bars).toHaveLength(120);
    expect(rows(result).map((row) => [row.monthLabel, row.servicesMinor, row.collectedMinor, row.expensesMinor]))
      .toEqual([["يناير 2017", 100, 100, 5], ["ديسمبر 2026", 200, 200, 7]]);
    expect(minor(result, "revenue")).toBe(300);
    expect(minor(result, "collected")).toBe(300);
    expect(minor(result, "expenses")).toBe(12);
    expect(result.periodLabel).toBe("31/01/2017 → 01/12/2026");
  });

  it("keeps the default this-year range, twelve month labels, values and bars unchanged", async () => {
    const labels = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
    await patient(1, at("2026-01-01"));
    for (let month = 1; month <= 12; month++) {
      const date = `2026-${String(month).padStart(2, "0")}-15`;
      await invoice(month, 1, at(date), month * 100);
      await payment(month, 1, month, at(date), month * 100);
      await expense(month, at(date), month * 3);
    }
    const result = await read({ preset: "this_year" });
    expect(result).toMatchObject({ from: "2026-01-01", to: "2026-12-31", subtitle: "سنة 2026", periodLabel: "01/01/2026 → 31/12/2026" });
    expect(rows(result)).toEqual(labels.map((monthLabel, index) => ({
      monthLabel, currency: "YER", patients: 1, visits: 0, services: 1,
      servicesMinor: (index + 1) * 100, collectedMinor: (index + 1) * 100, debtMinor: 0,
      expensesMinor: (index + 1) * 3, outstandingMinor: 0,
    })));
    expect(result.bars).toEqual(labels.map((label, index) => ({ label, minor: (index + 1) * 100 })));
    expect(minor(result, "revenue")).toBe(7_800);
    expect(minor(result, "collected")).toBe(7_800);
    expect(minor(result, "expenses")).toBe(234);
    expect(minor(result, "debt")).toBe(0);
    expect(minor(result, "avgMonthly")).toBe(650);
    expect(count(result, "patients")).toBe(1);
    expect(count(result, "new")).toBe(1);
    expect(text(result, "best")).toBe("ديسمبر");
    const custom = await annual("2026-01-01", "2026-12-31");
    expect(custom.kpis).toEqual(result.kpis);
    expect(custom.monthly).toEqual(result.monthly);
    expect(custom.bars).toEqual(result.bars);
  });
});
