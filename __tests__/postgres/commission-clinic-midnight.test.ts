import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();

const { CLINIC_TIME_ZONE, commissionReport, ensureSchema, getPool, resetPoolForTesting } =
  await import("../../lib/db");

const FIRST_DAY = "2024-01-15";
const SECOND_DAY = "2024-01-16";
let doctorId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();

  const { rows: [server] } = await pool.query<{ zone: string }>(
    `SELECT current_setting('TimeZone') AS zone`,
  );
  // UTC makes a raw TIMESTAMPTZ::date differ from the clinic date at 00:01.
  expect(["UTC", "Etc/UTC"]).toContain(server.zone);

  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('finance.commission_material_rate', 'on')
     ON CONFLICT (key) DO UPDATE SET value = 'on'`,
  );
  await pool.query(
    `INSERT INTO material_rate_history (category, rate_bp, effective_from, recorded_by)
     VALUES ('overpay-midnight-pg', 2000, TIMESTAMPTZ '2024-01-14 00:00:00+00', 'test')`,
  );
  const { rows: [shift] } = await pool.query<{ id: number }>(
    `INSERT INTO cashier_shifts (opened_by) VALUES ('commission-midnight-pg') RETURNING id`,
  );
  const { rows: [doctor] } = await pool.query<{ id: number }>(
    `INSERT INTO parties (name, kind, commission_percent)
     VALUES ('د. منتصف الليل', 'doctor', 100) RETURNING id`,
  );
  doctorId = doctor.id;
  const { rows: [service] } = await pool.query<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, is_active)
     VALUES ('خدمة منتصف الليل', 'overpay-midnight-pg', 100000, TRUE) RETURNING id`,
  );
  const { rows: [patient] } = await pool.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name)
     VALUES ('COMM-MIDNIGHT-PG', 'مريض منتصف الليل') RETURNING id`,
  );
  const { rows: [invoice] } = await pool.query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ('COMM-MIDNIGHT-INV', $1, 100000, 0, 'YER', 'test',
             ($2::date + TIME '23:59') AT TIME ZONE $3) RETURNING id`,
    [patient.id, FIRST_DAY, CLINIC_TIME_ZONE],
  );
  await pool.query(
    `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id)
     VALUES ($1, $2, 'بند عمولة', 1, 100000, 100000, $3)`,
    [invoice.id, service.id, doctorId],
  );
  await pool.query(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor,
       currency, exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
     VALUES ('COMM-MIDNIGHT-PAY', $1, $2, $3, 'payment', 100000,
             'YER', 1, 100000, 'YER', 'cash', 'test',
             ($4::date + TIME '23:59') AT TIME ZONE $5)`,
    [patient.id, invoice.id, shift.id, FIRST_DAY, CLINIC_TIME_ZONE],
  );
  await pool.query(
    `INSERT INTO expenses (voucher_number, category, party_id, shift_id, amount_minor,
       currency, exchange_rate, base_amount_minor, base_currency, created_at)
     VALUES ('COMM-MIDNIGHT-EXP', 'commission', $1, $2, 90000,
             'YER', 1, 90000, 'YER',
             ($3::date + TIME '00:01') AT TIME ZONE $4)`,
    [doctorId, shift.id, SECOND_DAY, CLINIC_TIME_ZONE],
  );
}, 180_000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("commission report at clinic midnight on PostgreSQL", () => {
  it("assigns 23:59 earnings and 00:01 payout to separate clinic dates", async () => {
    const { rows: [payoutDate] } = await getPool().query<{
      utc_day: string; clinic_day: string;
    }>(
      `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS utc_day,
              (created_at AT TIME ZONE $1)::date::text AS clinic_day
         FROM expenses WHERE voucher_number = 'COMM-MIDNIGHT-EXP'`,
      [CLINIC_TIME_ZONE],
    );
    expect(payoutDate).toEqual({ utc_day: FIRST_DAY, clinic_day: SECOND_DAY });

    const first = (await commissionReport(FIRST_DAY, FIRST_DAY))
      .find((row) => row.doctorId === doctorId && row.currency === "YER");
    expect(first).toMatchObject({
      earnedMinor: 100000,
      materialRateCostMinor: 20000,
      netEarnedMinor: 80000,
      paidMinor: 0,
      dueMinor: 80000,
    });

    const second = (await commissionReport(SECOND_DAY, SECOND_DAY))
      .find((row) => row.doctorId === doctorId && row.currency === "YER");
    expect(second).toMatchObject({ earnedMinor: 0, paidMinor: 90000, dueMinor: -90000 });

    const combined = (await commissionReport(FIRST_DAY, SECOND_DAY))
      .find((row) => row.doctorId === doctorId && row.currency === "YER");
    expect(combined).toMatchObject({
      earnedMinor: 100000,
      materialRateCostMinor: 20000,
      netEarnedMinor: 80000,
      paidMinor: 90000,
      dueMinor: -10000,
    });
  });
});
