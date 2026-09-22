import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const {
  CLINIC_TIME_ZONE,
  commissionReport,
  ensureSchema,
  getPool,
  openShift,
  recordExpense,
  resetPoolForTesting,
} = await import("../lib/db");

let doctorId = 0;
let invoiceId = 0;
let paymentId = 0;
let expenseId = 0;
const FIXTURE_DAY = "2024-01-15";
const NEXT_DAY = "2024-01-16";

beforeAll(async () => {
  await ensureSchema();
  await openShift({ openedBy: "commission-overpay-test", opening: { YER: 0, SAR: 0, USD: 0 } });

  await getPool().query(
    `INSERT INTO settings (key, value) VALUES ('finance.commission_material_rate', 'on')
     ON CONFLICT (key) DO UPDATE SET value = 'on'`,
  );
  await getPool().query(
    `INSERT INTO material_rate_history (category, rate_bp, effective_from, recorded_by)
     VALUES ('overpay-debt-test', 2000, TIMESTAMPTZ '2024-01-14 00:00:00+00', 'test')`,
  );

  const { rows: [doctor] } = await getPool().query<{ id: number }>(
    `INSERT INTO parties (name, kind, commission_percent, is_active)
     VALUES ('د. اختبار مديونية العمولة', 'doctor', 100, TRUE) RETURNING id`,
  );
  doctorId = doctor.id;

  const { rows: [service] } = await getPool().query<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, is_active)
     VALUES ('خدمة اختبار مديونية العمولة', 'overpay-debt-test', 100000, TRUE) RETURNING id`,
  );
  const { rows: [patient] } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name)
     VALUES ('COMM-OVERPAY-1', 'مريض اختبار مديونية العمولة') RETURNING id`,
  );
  const { rows: [invoice] } = await getPool().query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ('COMM-OVERPAY-INV-1', $1, 100000, 0, 'YER', 'test',
             ($2::date + TIME '12:00') AT TIME ZONE $3) RETURNING id`,
    [patient.id, FIXTURE_DAY, CLINIC_TIME_ZONE],
  );
  invoiceId = invoice.id;
  await getPool().query(
    `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id)
     VALUES ($1, $2, 'بند عمولة', 1, 100000, 100000, $3)`,
    [invoice.id, service.id, doctorId],
  );
  const { rows: [shift] } = await getPool().query<{ id: number }>(
    `SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1`,
  );
  const { rows: [payment] } = await getPool().query<{ id: number }>(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency,
       exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
     VALUES ('COMM-OVERPAY-R-1', $1, $2, $3, 'payment', 100000, 'YER', 1, 100000, 'YER', 'cash', 'test',
             ($4::date + TIME '12:00') AT TIME ZONE $5)
     RETURNING id`,
    [patient.id, invoice.id, shift.id, FIXTURE_DAY, CLINIC_TIME_ZONE],
  );
  paymentId = payment.id;

  const payout = await recordExpense({
    category: "commission",
    partyId: doctorId,
    payeeText: null,
    amountMinor: 90000,
    currency: "YER",
    baseCurrency: "YER",
    exchangeRate: 1,
    payableId: null,
    note: "صرف أعلى من صافي الاستحقاق لاختبار المديونية",
    createdBy: "test",
  });
  expect(payout.expense).not.toBeNull();
  expenseId = payout.expense!.id;
  // recordExpense uses the live clock; pin its row to the same clinic day as
  // the invoice and payment so the fixture is independent of runner midnight.
  await getPool().query(
    `UPDATE expenses SET created_at = ($1::date + TIME '12:00') AT TIME ZONE $2 WHERE id = $3`,
    [FIXTURE_DAY, CLINIC_TIME_ZONE, expenseId],
  );
}, 60_000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("مديونية الطبيب عند صرف عمولة أعلى من صافي الاستحقاق", () => {
  it("لا يصفّر الرصيد السالب عند تفعيل خصم المواد", async () => {
    const rows = await commissionReport(FIXTURE_DAY, FIXTURE_DAY);
    const row = rows.find((item) => item.doctorId === doctorId && item.currency === "YER");
    expect(row).toBeDefined();
    expect(row!.earnedMinor).toBe(100000);
    expect(row!.materialRateCostMinor).toBe(20000);
    expect(row!.netEarnedMinor).toBe(80000);
    expect(row!.paidMinor).toBe(90000);
    // 90,000 مصروف - 80,000 صافي استحقاق = 10,000 مديونية على الطبيب.
    expect(row!.dueMinor).toBe(-10000);
  });

  it("assigns 23:59 and 00:01 events to their respective clinic dates", async () => {
    await getPool().query(
      `UPDATE invoices SET created_at = ($1::date + TIME '23:59') AT TIME ZONE $2 WHERE id = $3`,
      [FIXTURE_DAY, CLINIC_TIME_ZONE, invoiceId],
    );
    await getPool().query(
      `UPDATE payments SET created_at = ($1::date + TIME '23:59') AT TIME ZONE $2 WHERE id = $3`,
      [FIXTURE_DAY, CLINIC_TIME_ZONE, paymentId],
    );
    await getPool().query(
      `UPDATE expenses SET created_at = ($1::date + TIME '00:01') AT TIME ZONE $2 WHERE id = $3`,
      [NEXT_DAY, CLINIC_TIME_ZONE, expenseId],
    );

    const firstDay = (await commissionReport(FIXTURE_DAY, FIXTURE_DAY))
      .find((item) => item.doctorId === doctorId && item.currency === "YER");
    expect(firstDay).toMatchObject({
      earnedMinor: 100000,
      materialRateCostMinor: 20000,
      netEarnedMinor: 80000,
      paidMinor: 0,
      dueMinor: 80000,
    });

    const secondDay = (await commissionReport(NEXT_DAY, NEXT_DAY))
      .find((item) => item.doctorId === doctorId && item.currency === "YER");
    expect(secondDay).toMatchObject({ earnedMinor: 0, paidMinor: 90000, dueMinor: -90000 });

    const bothDays = (await commissionReport(FIXTURE_DAY, NEXT_DAY))
      .find((item) => item.doctorId === doctorId && item.currency === "YER");
    expect(bothDays).toMatchObject({
      earnedMinor: 100000,
      materialRateCostMinor: 20000,
      netEarnedMinor: 80000,
      paidMinor: 90000,
      dueMinor: -10000,
    });
  });
});
