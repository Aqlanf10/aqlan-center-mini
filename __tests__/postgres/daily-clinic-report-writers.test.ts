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
const isolatedName = `aqlan_daily_report_test_${randomUUID().replaceAll("-", "")}`;
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
      if (!/^aqlan_daily_report_test_[a-f0-9]{32}$/.test(isolatedName)
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
  const tables = ["visits", "visit_procedures", "treatment_plans", "plan_items", "treatment_sessions", "invoices", "payments", "expenses", "audit_log"];
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    result[table] = (await query(`SELECT COUNT(*)::int AS count,
      md5(COALESCE(string_agg(row_to_json(t)::text, '|' ORDER BY t.id), '')) AS fingerprint FROM ${table} t`))[0];
  }
  return result;
}

describe("daily-clinic actual migrated schema and domain writers", () => {
  it("preserves clinical, installment, receipt/refund and voucher writers while reporting their evidence", async () => {
    const date = getDailyClinicReportToday();
    const doctor = await db.createParty({ name: "Synthetic report doctor", kind: "doctor", phone: null, commissionPercent: 0, note: null });
    const [service] = await query<{ id: number }>(`INSERT INTO services
      (name,category,price_minor,is_active,price_configured) VALUES ('Synthetic report service','filling',1000,TRUE,TRUE) RETURNING id`);
    const patient = async (number: string) => (await query<{ id: number }>(
      `INSERT INTO patients (patient_number,full_name) VALUES ($1,$1) RETURNING id`, [number]))[0].id;
    const attendeeId = await patient("RPT-WRITER-ATTENDEE");
    const paymentOnlyId = await patient("RPT-WRITER-NO-ATTENDANCE");
    const zeroMoneyId = await patient("RPT-WRITER-ZERO-MONEY");

    const plan = await db.createPlanV2({ patientId: attendeeId, title: "Synthetic funded agreement", specialty: "filling",
      primaryDoctorId: doctor.id, billingMode: "installments", baseCurrency: "SAR", startDate: date, note: null, createdBy: "synthetic-admin",
      items: [{ serviceId: service.id, serviceName: "Synthetic report service", category: "filling", toothCode: 16,
        surfaces: null, quantity: 1, unitPriceMinor: 5000, billingRule: "per_session", sessionCount: 3, note: null }],
      installments: [{ dueDate: date, amountMinor: 5000 }] });
    if (!plan.ok) throw new Error(plan.message);
    await query("UPDATE plan_items SET doctor_id=$2 WHERE plan_id=$1", [plan.planId, doctor.id]);
    expect((await db.recordPlanConsent({ planId: plan.planId, actor: "synthetic-admin", note: null })).ok).toBe(true);
    const installment = await db.recordPlanInstallment({ planId: plan.planId, patientId: attendeeId, installmentNumber: 1,
      planTitle: "Synthetic funded agreement", amountMinor: 1000, currency: "SAR", baseCurrency: "YER", exchangeRate: 140,
      method: "cash", note: "Synthetic report fixture", createdBy: "synthetic-report-cashier" });
    if (!("paymentId" in installment)) throw new Error(installment.reason);
    const [item] = await query<{ id: number }>("SELECT id FROM plan_items WHERE plan_id=$1", [plan.planId]);
    const visit = await db.addVisit({ patientName: "Synthetic attendee", patientPhone: null, note: null, patientId: attendeeId, doctorId: doctor.id });
    expect(await db.setVisitProcedures({ visitId: visit.id, procedures: [{ serviceId: service.id, toothCode: 16,
      surfaces: null, quantity: 1, unitPriceMinor: 0, priceReason: null, doctorId: doctor.id, note: null, planItemId: item.id }] })).toBe(true);
    const signed = await db.signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "synthetic-admin", signerRole: "admin", signerDoctorPartyId: doctor.id });
    expect(signed.reason).toBeNull();
    expect(signed.invoiceId).toBeNull();
    const pending = await db.addVisit({ patientName: "Synthetic zero-money", patientPhone: null, note: null, patientId: zeroMoneyId });

    const refund = await db.recordPayment({ patientId: attendeeId, invoiceId: installment.invoiceId, planId: plan.planId,
      kind: "refund", reversalOfId: installment.paymentId, amountMinor: 200, currency: "SAR", baseCurrency: "YER", exchangeRate: 140,
      method: "cash", note: "Synthetic partial reversal", createdBy: "synthetic-report-cashier" });
    expect(refund.reason).toBeNull();
    const remoteReceipt = await db.recordPayment({ patientId: paymentOnlyId, invoiceId: null, kind: "payment",
      amountMinor: 300, currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "transfer", note: null, createdBy: "synthetic-report-cashier" });
    expect(remoteReceipt.reason).toBeNull();

    const expenses = [];
    for (const [currency, amountMinor, exchangeRate] of [["YER", 500, 1], ["SAR", 250, 140], ["USD", 100, 530]] as const) {
      const result = await db.recordExpense({ category: "other", partyId: null, payeeText: `Synthetic ${currency} recipient`,
        amountMinor, currency, baseCurrency: "YER", exchangeRate, payableId: null, note: "Synthetic report fixture",
        createdBy: "synthetic-report-cashier", rates: { YER: 1, SAR: 140, USD: 530 } });
      expect(result.reason).toBeNull();
      if (!result.expense) throw new Error("Missing synthetic voucher");
      expenses.push(result.expense);
    }
    expect((await db.voidExpense(expenses[0].id, { actor: "synthetic-admin", actorRole: "admin", reason: "Synthetic correction" })).ok).toBe(true);
    const before = await fingerprint();
    const report = await loadDailyClinicReport(date);
    const after = await fingerprint();
    expect(after).toEqual(before);
    expect(report.attendees.find((row) => row.patientId === zeroMoneyId)?.visitIds).toContain(pending.id);
    expect(report.attendees.some((row) => row.patientId === paymentOnlyId)).toBe(false);
    const attendee = report.attendees.find((row) => row.patientId === attendeeId)!;
    expect(attendee.agreement).toEqual({ YER: 0, SAR: 5000, USD: 0 });
    expect(attendee.explicitlySettled.SAR).toBe(800);
    expect(attendee.agreementRemaining.SAR).toBe(4200);
    expect(report.work.find((row) => row.visitId === visit.id)).toMatchObject({ classification: "included", valueMinor: null });
    expect(report.receipts.find((row) => row.id === remoteReceipt.payment!.id)).toMatchObject({ attendee: false, method: "transfer", tenderCurrency: "YER" });
    expect(report.receipts.find((row) => row.id === refund.payment!.id)).toMatchObject({ kind: "refund", signedSettlementMinor: -200 });
    expect(report.expenses.totals.netOutflowMinor).toEqual({ YER: 0, SAR: 250, USD: 100 });
    expect(report.expenses.movements).toHaveLength(4);
    expect(report.expenses.recipientTotals).toHaveLength(3);
    expect(report.basis.account).toBe("current_at_generation");
  });
});
