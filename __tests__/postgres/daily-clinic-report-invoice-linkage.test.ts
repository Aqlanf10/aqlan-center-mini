import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";

if (!process.env.TEST_DATABASE_URL?.trim()) throw new Error("Explicit TEST_DATABASE_URL is required; ambient DATABASE_URL is never a test target.");
if (process.env.DATABASE_ENVIRONMENT === "production" || process.env.RAILWAY_PROJECT_ID) throw new Error("Production markers are forbidden for this fixture.");
const testUrl = assertRealPostgresUrl();
const baseTarget = new URL(testUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(baseTarget.hostname)
  || !/^\/aqlan_(?:p1_test|test|ci)(?:_[a-z0-9]+)*$/i.test(baseTarget.pathname)) {
  throw new Error("Daily-clinic migrated-schema writer fixtures require local isolated PostgreSQL.");
}
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousTestDatabaseUrl = process.env.TEST_DATABASE_URL;
stubPostgresEnv();
const isolatedName = `aqlan_daily_invoice_test_${randomUUID().replaceAll("-", "")}`;
const isolatedTarget = new URL(testUrl);
isolatedTarget.pathname = `/${isolatedName}`;
let createdDatabase = false;
let db: typeof import("../../lib/db");
let getDailyClinicReportToday: typeof import("../../lib/daily-clinic-report")["getDailyClinicReportToday"];
let loadDailyClinicReport: typeof import("../../lib/daily-clinic-report")["loadDailyClinicReport"];
const query = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query(sql, values)).rows as T[];

beforeAll(async () => {
  const admin = new Client({ connectionString: testUrl, ssl: false });
  await admin.connect();
  try {
    // CREATE only: an unexpected existing name fails rather than being dropped.
    await admin.query(`CREATE DATABASE "${isolatedName}"`);
    createdDatabase = true;
  } finally { await admin.end(); }
  process.env.DATABASE_URL = isolatedTarget.toString();
  process.env.TEST_DATABASE_URL = isolatedTarget.toString();
  db = await import("../../lib/db");
  ({ getDailyClinicReportToday, loadDailyClinicReport } = await import("../../lib/daily-clinic-report"));
  const { migrate } = await import("../../lib/migrations");
  expect((await query<{ database: string }>("SELECT current_database() AS database"))[0].database).toBe(isolatedName);
  const migration = await migrate(db.getPool(), { apply: true });
  expect(migration.adoptedBaseline).toBe(false);
  expect(migration.appliedVersions).toContain("0001");
  // Crucially run every report SELECT against numbered migrations BEFORE ensureSchema
  // or a domain writer can fill a missing runtime column/table and hide schema drift.
  const empty = await loadDailyClinicReport("1900-01-01");
  expect(empty.attendees).toEqual([]);
  expect(empty.expenses.movements).toEqual([]);
  await db.ensureSchema();
  await db.openShift({ openedBy: "synthetic-report-cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await db.resetPoolForTesting();
    if (createdDatabase) {
      if (!/^aqlan_daily_invoice_test_[a-f0-9]{32}$/.test(isolatedName)
        || isolatedTarget.pathname !== `/${isolatedName}` || isolatedTarget.pathname === baseTarget.pathname) {
        throw new Error("Refusing cleanup of an unowned database");
      }
      const admin = new Client({ connectionString: testUrl, ssl: false });
      await admin.connect();
      try { await admin.query(`DROP DATABASE "${isolatedName}" WITH (FORCE)`); }
      finally { await admin.end(); }
    }
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL; else process.env.TEST_DATABASE_URL = previousTestDatabaseUrl;
  }
});

async function fingerprint() {
  const tables = ["invoices", "invoice_items", "payments", "plan_items", "treatment_plans", "legacy_treatment_agreements",
    "patient_opening_balances", "audit_log"];
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    const order = table === "patient_opening_balances" ? "t.patient_id, t.currency" : "t.id";
    result[table] = (await query(`SELECT COUNT(*)::int AS count,
      md5(COALESCE(string_agg(row_to_json(t)::text, '|' ORDER BY ${order}), '')) AS fingerprint FROM ${table} t`))[0];
  }
  return result;
}

describe("(INV-LINK REPORT) daily clinic report over real invoice-first, correction and legacy writers", () => {
  it("shows each invoice once with its line links, explicit receipts and stored correction; legacy facts never become today's money", async () => {
    const { DEFAULT_SPECIALTY_TEMPLATES } = await import("../../lib/specialty-templates");
    const { createLinkedInvoice } = await import("../../lib/invoice-linkage-db");
    const { parseLegacyTreatmentRequest } = await import("../../lib/legacy-treatment");
    const { createLegacyTreatment } = await import("../../lib/legacy-treatment-db");
    const date = getDailyClinicReportToday();
    const doctor = await db.createParty({ name: "Synthetic linkage doctor", kind: "doctor", phone: null, commissionPercent: 0, note: null });
    const service = async (name: string, category: string | null) => (await query<{ id: number }>(`INSERT INTO services
      (name,category,price_minor,is_active,price_configured) VALUES ($1,$2,150000,TRUE,TRUE) RETURNING id`, [name, category]))[0].id;
    const rct = await service("Synthetic root canal", "rct");
    const consult = await service("Synthetic consultation", null);
    const [{ id: patientId }] = await query<{ id: number }>(
      "INSERT INTO patients (patient_number,full_name) VALUES ('RPT-LINK-1','Synthetic linkage patient') RETURNING id");
    await db.addVisit({ patientName: "Synthetic linkage patient", patientPhone: null, note: null, patientId, doctorId: doctor.id });

    const create = (items: Record<string, unknown>[]) => createLinkedInvoice({ patientId, baseCurrency: "YER", discountMinor: 0, note: null,
      createdBy: "synthetic-reception", actorRole: "reception", items: items as never, templates: DEFAULT_SPECIALTY_TEMPLATES,
      idempotencyKey: null, requestHash: null, auditDetails: {} });
    const clinical = await create([{ serviceId: rct, category: "rct", doctorId: doctor.id, description: "Synthetic RCT 36",
      quantity: 1, unitPriceMinor: 150000, toothCode: 36, caseId: null, scope: null, sessions: null }]);
    if (!clinical.ok) throw new Error(clinical.reason);
    const paid = await db.recordPayment({ patientId, invoiceId: clinical.invoice.id, kind: "payment", amountMinor: 50000, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "synthetic-report-cashier" });
    expect(paid.reason).toBeNull();
    const financial = await create([{ serviceId: consult, category: null, doctorId: doctor.id, description: "Synthetic consultation",
      quantity: 1, unitPriceMinor: 20000, toothCode: null, caseId: null, scope: null, sessions: null }]);
    if (!financial.ok) throw new Error(financial.reason);
    const [financialItem] = await query<{ id: number }>("SELECT id FROM invoice_items WHERE invoice_id=$1", [financial.invoice.id]);
    const corrected = await db.correctInvoice({ invoiceId: financial.invoice.id, lines: [{ itemId: financialItem.id, quantity: 1, unitPriceMinor: 15000 }],
      reason: "Synthetic price correction", actor: "synthetic-admin", actorRole: "admin" });
    if (!corrected.ok) throw new Error("correction refused");

    const parsed = parseLegacyTreatmentRequest({ serviceId: rct, toothCode: 46, sessions: 2, currency: "YER",
      agreedAmount: "300000", previouslyPaidAmount: "120000", historicalAsOf: "2026-01-15" }, date);
    if (!parsed.ok) throw new Error(parsed.message);
    const legacy = await createLegacyTreatment({ patientId, request: parsed.value, actor: "synthetic-admin", actorRole: "admin",
      canEditOpening: true, templates: DEFAULT_SPECIALTY_TEMPLATES });
    if (!legacy.ok) throw new Error(legacy.reason);

    const [{ plan_id: invoicePlanId }] = await query<{ plan_id: number | null }>("SELECT plan_id FROM invoices WHERE id=$1", [clinical.invoice.id]);
    expect(invoicePlanId).toBeNull(); // the link lives on invoice_items.plan_item_id only

    const before = await fingerprint();
    const report = await loadDailyClinicReport(date);
    expect(await fingerprint()).toEqual(before);

    const byId = new Map(report.invoices.map((row) => [row.id, row]));
    expect(report.invoices.filter((row) => row.id === clinical.invoice.id)).toHaveLength(1);
    expect(byId.get(clinical.invoice.id)).toMatchObject({ status: "open", linkage: "single_plan_item", explicitPaymentIds: [paid.payment!.id],
      explicitlySettledMinor: 50000, remainingMinor: 100000, issuedOnReportDay: true });
    expect(byId.get(clinical.invoice.id)!.lines[0]).toMatchObject({ planItemId: clinical.links[0].planItemId, toothCode: 36 });
    expect(byId.get(clinical.invoice.id)!.lines[0].planId).toBe(clinical.planId);
    expect(byId.get(financial.invoice.id)).toMatchObject({ status: "cancelled", netMinor: 0, linkage: "financial_only" });
    expect(byId.get(financial.invoice.id)!.corrections).toEqual([expect.objectContaining({
      correctedInvoiceNumber: corrected.corrected.invoiceNumber, reason: "Synthetic price correction", actor: "synthetic-admin" })]);
    expect(byId.get(corrected.corrected.id)!.correctsInvoiceNumbers).toEqual([financial.invoice.invoiceNumber]);

    expect(report.legacyAgreements).toEqual([expect.objectContaining({ id: legacy.agreement.id, agreedMinor: 300000,
      previouslyPaidMinor: 120000, remainingAtStartMinor: 180000, historicalAsOf: "2026-01-15", status: "live", currency: "YER" })]);
    expect(report.totals.nativeReceipts.YER).toBe(50000); // the 120000 paid before the system is not today's collection
    const account = report.currentAccounts.find((row) => row.patientId === patientId)!;
    expect(account.byCurrency.YER).toMatchObject({ openingMinor: 180000, billedMinor: 150000 + 15000, collectedMinor: 50000 });
    expect(account.byCurrency.YER.receivableMinor).toBe(180000 + 150000 + 15000 - 50000); // the historical remainder counted once
    expect(report.totals.invoicesIssuedNet.YER).toBe(150000 + 15000);
    expect(report.totals.cancelledInvoicesCount).toBe(1);
  });
});
