import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CURRENCY_READ_TEMP_SCHEMA } from "./postgres/_currency-read-temp-schema";
import { ReportView } from "../components/reports/ReportView";
import { PrintableReportDocument } from "../components/reports/PrintableReportDocument";
import { EMPTY_REPORT_VIEW } from "../lib/report-view";
import { formatMoney } from "../lib/money";
import { SETTING_DEFAULTS } from "../lib/settings";
import type { ReportResult } from "../lib/reports-types";

// Private in-memory SQL engine; no application adapter, migrations, network,
// production env, or writers. SQL AT TIME ZONE runs unchanged (host is UTC).
const harness = vi.hoisted(() => ({ db: null as PGlite | null }));
vi.mock("../lib/db", async (original) => ({
  ...await original<typeof import("../lib/db")>(),
  ensureSchema: async () => {}, listParties: async () => [],
  getPool: () => { if (!harness.db) throw new Error("Fixture not ready"); return harness.db; },
}));
vi.mock("../lib/financial-read-snapshot", () => ({ withFinancialReadSnapshot:
  async (pool: unknown, read: (runner: unknown) => Promise<unknown>) => read(pool) }));
vi.mock("../lib/session", () => ({ requireSession: async () => ({ role: "admin", username: "synthetic" }) }));
vi.mock("../components/Icon", () => ({ Icon: () => null, Logo: () => null }));
vi.mock("../components/SettingsProvider", () => ({ useSetting: () => "" }));
vi.mock("../components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));
const { buildReport, parseFilters } = await import("../lib/reports");
const { GET } = await import("../app/api/reports/route");
const db = new PGlite();
beforeAll(async () => {
  await db.exec("SET search_path TO pg_temp; SET TIME ZONE 'UTC';");
  harness.db = db;
  await db.exec(`
    CREATE TEMP TABLE approved_agreement_principals (
      plan_id integer, patient_id integer, invoice_id integer, opening_currency text,
      historical_paid_minor bigint, currency text
    );
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
  await db.exec(CURRENCY_READ_TEMP_SCHEMA);
  await db.exec(`CREATE TEMP TABLE payables (id integer, created_at timestamptz, due_date date, amount_minor bigint, currency text);
    ALTER TABLE expenses ADD COLUMN payable_id integer;
    ALTER TABLE expenses ADD COLUMN amount_minor bigint;
    ALTER TABLE expenses ADD COLUMN currency text;`);
}, 30000);
afterAll(async () => { harness.db = null; await db.close(); });
beforeEach(async () => {
  await db.exec(`TRUNCATE patients, invoices, invoice_items, payments, expenses, payables;
    INSERT INTO patients (id, patient_number, full_name, created_at) VALUES (1, 'SYN-1', 'Synthetic', '2026-01-01Z');
    INSERT INTO invoices (id, patient_id, created_at, total_minor, discount_minor, base_currency, status)
      VALUES (1, 1, '2026-09-30T20:59:59Z', 10000, 1000, 'YER', 'issued'),
             (2, 1, '2026-09-30T20:59:59Z', 5000, 500, 'SAR', 'issued');
    INSERT INTO invoice_items (id, invoice_id, description, quantity, total_minor)
      VALUES (1, 1, 'Synthetic service', 1, 10000), (2, 2, 'Synthetic service', 1, 5000);
    INSERT INTO payables VALUES (1, '2026-09-30T20:59:59Z', '2026-10-15', 6000, 'YER');`);
});
const read = (from: string, to: string) => buildReport("monthly", parseFilters(new URLSearchParams({ preset: "custom", from, to, compare: "none" }), "2026-10-31"));
const minor = (result: ReportResult, key: string) => result.kpis.find(k => k.key === key)?.minor;
async function partialPayment() {
  await db.exec(`INSERT INTO payments (id, patient_id, created_at, kind, amount_minor, currency, base_amount_minor, base_currency, exchange_rate, method, invoice_id)
    VALUES (1, 1, '2026-09-30T21:00:00Z', 'payment', 4000, 'YER', 4000, 'YER', 1, 'cash', 1);
    INSERT INTO expenses (id, created_at, base_amount_minor, payable_id, amount_minor, currency)
    VALUES (1, '2026-09-30T21:00:00Z', 2000, 1, 20, 'SAR');`);
}
it("distinguishes discounted document, unpaid payable, later partial payments and refund at clinic midnight", async () => {
  const september = await read("2026-09-01", "2026-09-30");
  expect(minor(september, "invoiced")).toBe(9000);
  expect(minor(september, "invoiced-SAR")).toBe(4500);
  expect(minor(september, "expenses")).toBe(0);
  expect(minor(september, "net")).toBe(9000); // Not 3000 (invoice minus unpaid payable).
  expect(minor(september, "collected")).toBe(0);
  await partialPayment();
  const october = await read("2026-10-01", "2026-10-31");
  expect(minor(october, "invoiced")).toBe(0);
  expect(minor(october, "collected")).toBe(4000);
  expect(minor(october, "expenses")).toBe(2000); // Stored base evidence, not native SAR 20.
  expect(minor(october, "net")).toBe(-2000); // Not cash surplus 2000.
  await db.exec(`INSERT INTO payments (id, patient_id, created_at, kind, amount_minor, currency, base_amount_minor, base_currency, exchange_rate, method, invoice_id)
    VALUES (2, 1, '2026-10-31T20:59:59Z', 'refund', 500, 'YER', 500, 'YER', 1, 'cash', 1),
           (3, 1, '2026-10-31T21:00:00Z', 'refund', 100, 'YER', 100, 'YER', 1, 'cash', 1);`);
  const refunded = await read("2026-10-01", "2026-10-31");
  expect(minor(refunded, "collected")).toBe(3500);
  expect(minor(refunded, "net")).toBe(-2000);
  expect(minor(await read("2026-11-01", "2026-11-30"), "collected")).toBe(-100);
  expect(await read("2026-09-01", "2026-09-30")).toEqual(september);
});
it("delivers identical measurement disclosures and amounts through API, screen and print without writes", async () => {
  await partialPayment();
  const snapshot = () => db.query("SELECT (SELECT jsonb_agg(t) FROM invoices t) invoices, (SELECT jsonb_agg(t) FROM payables t) payables, (SELECT jsonb_agg(t) FROM expenses t) expenses, (SELECT jsonb_agg(t) FROM payments t) payments");
  const before = await snapshot();
  const expected = await read("2026-09-01", "2026-10-31");
  const response = await GET(new Request("https://synthetic.invalid/api/reports?report=monthly&preset=custom&from=2026-09-01&to=2026-10-31&compare=none"));
  expect(response.status).toBe(200);
  const { result, clinicTimeZone } = await response.json();
  expect(result).toEqual(expected);
  expect(clinicTimeZone).toBe("Asia/Aden");
  expect(minor(result, "net")).toBe(7000);
  expect(result.kpis.find((k: {key: string}) => k.key === "net").label).toBe("فرق الفواتير وسندات الصرف (الأساس)");
  expect(result.notes.join(" ")).toContain("مستحقات الموردين غير المدفوعة لا تدخل فيه");
  const screen = renderToStaticMarkup(createElement(ReportView, { result, clinicName: "Synthetic", generated: { at: "2026-11-01T00:00:00Z", by: "synthetic", clinicTimeZone }, printHref: "/synthetic", view: EMPTY_REPORT_VIEW, onViewChange: () => {}, onPatientClick: () => {} }));
  const print = renderToStaticMarkup(createElement(PrintableReportDocument, { result, settings: SETTING_DEFAULTS, generatedAt: "synthetic", generatedBy: "synthetic" }));
  for (const html of [screen, print]) {
    for (const kpi of expected.kpis) {
      expect(html).toContain(kpi.label);
      if (kpi.hint) expect(html).toContain(kpi.hint);
      if (kpi.minor !== undefined) expect(html).toContain(formatMoney(kpi.minor, kpi.currency ?? "YER"));
    }
    for (const note of expected.notes ?? []) expect(html).toContain(note);
    expect(html).not.toContain("أساس الاستحقاق لا الصندوق");
  }
  expect(await snapshot()).toEqual(before);
});

it("keeps comparison labels aligned and expense reversals on their recording date", async () => {
  await partialPayment();
  await db.exec(`INSERT INTO expenses (id, created_at, base_amount_minor, reversal_of_id, payable_id)
    VALUES (2, '2026-10-01T21:00:00Z', -2000, 1, 1);`);
  const result = await buildReport("monthly", parseFilters(new URLSearchParams({
    preset: "custom", from: "2026-10-02", to: "2026-10-02", compare: "prev_period",
  }), "2026-10-31"));
  expect(minor(result, "expenses")).toBe(-2000);
  expect(minor(result, "net")).toBe(2000);
  expect(result.comparison?.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ label: "سندات الصرف (المكافئ الأساسي)", currentMinor: -2000, previousMinor: 2000, currency: "YER" }),
    expect.objectContaining({ label: "التحصيل بعملة التسوية", currentMinor: 0, previousMinor: 4000, currency: "YER" }),
    expect.objectContaining({ label: "صافي الفواتير بعد الخصم", currentMinor: 0, previousMinor: 0, currency: "YER" }),
  ]));
});
