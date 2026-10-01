import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P0-D) لوحة الوصول على PostgreSQL 18 — رحلة مريض التقويم السابق للنظام كما وصفها المالك:
 * رصيدٌ قديم ٣٥٠ ألفًا وترتيب ٣٠ ألفًا مع كل زيارة ⇒ يُحصَّل ٣٠ ألفًا على opening_currency فيصير ٣٢٠ ألفًا
 * بلا فاتورة ⇒ حشوة جديدة ١٥ ألفًا ⇒ المستحق ٣٣٥ ألفًا، والترتيب يبقى على القديم وحده.
 * واللوحة قراءةٌ فقط: لا تكتب شيئًا.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { ensureSchema, getPool, resetPoolForTesting, openShift, recordPayment, setPatientOpeningBalance, arriveAppointment } = db;
const { createLegacyBalanceArrangement } = await import("../../lib/legacy-balance-arrangements-db");
const { arrivalPanel } = await import("../../lib/arrival-panel-db");
const { clinicDateString } = await import("../../lib/schedule");
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let doctorId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  doctorId = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. عقلان') RETURNING id`))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(P0-D) the returning legacy orthodontic patient at reception", () => {
  it("shows the old balance, the suggested installment, today's appointment and the ortho phase — per currency", async () => {
    const patientId = (await q<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('ARR-1', 'مريض تقويم سابق') RETURNING id`))[0].id;
    await q(`INSERT INTO ortho_cases (patient_id, created_by, baseline_kind, baseline_recorded_at, legacy_financial_mode,
                                      responsible_doctor_id, upper_wire, lower_wire)
             VALUES ($1, 'migration', 'legacy', NOW(), 'opening_balance', $2, '019×025 SS', '017×025 NiTi')`, [patientId, doctorId]);
    await setPatientOpeningBalance({
      patientId, currency: "YER", amountMinor: 350_000, asOfDate: today, note: null, createdBy: "migration", reason: null,
    });
    const arrangement = await createLegacyBalanceArrangement({
      patientId, currency: "YER", cadence: "per_visit", installmentMinor: 30_000, firstDueDate: null,
      note: null, createdBy: "reception", today,
    });
    expect(arrangement.ok).toBe(true);
    const appointmentId = (await q<{ id: number }>(
      `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, appointment_type, doctor_id)
       VALUES ($1, $2::date, '10:00', 'شدّة تقويم', $3) RETURNING id`, [patientId, today, doctorId]))[0].id;
    expect(await arriveAppointment(appointmentId, { actor: "reception" })).toBe(true);

    const before = await q(`SELECT (SELECT count(*) FROM invoices)::int AS invoices, (SELECT count(*) FROM payments)::int AS payments`);
    const panel = await arrivalPanel(patientId, { includeMoney: true });
    expect(await q(`SELECT (SELECT count(*) FROM invoices)::int AS invoices, (SELECT count(*) FROM payments)::int AS payments`)).toEqual(before);

    expect(panel?.appointments).toEqual([expect.objectContaining({ time: "10:00", type: "شدّة تقويم", status: "arrived" })]);
    expect(panel?.activeVisit).not.toBeNull();
    expect(panel?.ortho).toMatchObject({ legacy: true, upperWire: "019×025 SS", lowerWire: "017×025 NiTi" });
    expect(panel?.money?.lines).toEqual([expect.objectContaining({
      currency: "YER", balanceMinor: 350_000, openingRemainingMinor: 350_000, sources: ["opening"],
      legacy: expect.objectContaining({ suggestedMinor: 30_000, overdueMinor: 0 }),
    })]);
    expect(panel?.money?.suggestions).toEqual([expect.objectContaining({ kind: "legacy", currency: "YER", amountMinor: 30_000 })]);

    /* القسط المقترح يُدفع على opening_currency عبر محرك الدفع القائم ⇒ الرصيد القديم ٣٢٠ ألفًا، بلا فاتورة. */
    const paid = await recordPayment({
      patientId, invoiceId: null, openingCurrency: "YER", kind: "payment", amountMinor: 30_000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "cashier",
    });
    expect(paid.reason).toBeNull();
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toEqual([]);

    /* حشوة جديدة ١٥ ألفًا ⇒ المستحق ٣٣٥ ألفًا، والقديم ٣٢٠ ألفًا، والاقتراح يبقى قسط القديم. */
    await q(`INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
             VALUES ('INV-ARR-1', $1, 15000, 0, 'YER', 'doctor')`, [patientId]);
    const after = await arrivalPanel(patientId, { includeMoney: true });
    expect(after?.money?.lines[0]).toMatchObject({
      balanceMinor: 335_000, openingRemainingMinor: 320_000, openInvoices: 1, sources: ["opening", "invoice"],
    });
    expect(after?.money?.suggestions).toEqual([expect.objectContaining({ kind: "legacy", amountMinor: 30_000 })]);
  });

  it("hides money when not allowed, and keeps currencies apart", async () => {
    const patientId = (await q<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('ARR-2', 'مريض بعملتين') RETURNING id`))[0].id;
    await setPatientOpeningBalance({ patientId, currency: "YER", amountMinor: 50_000, asOfDate: today, note: null, createdBy: "m", reason: null });
    await setPatientOpeningBalance({ patientId, currency: "SAR", amountMinor: 20_000, asOfDate: today, note: null, createdBy: "m", reason: null });
    expect((await arrivalPanel(patientId, { includeMoney: false }))?.money).toBeNull();
    const panel = await arrivalPanel(patientId, { includeMoney: true });
    expect(panel?.money?.lines.map((line) => [line.currency, line.balanceMinor])).toEqual([["YER", 50_000], ["SAR", 20_000]]);
  });
});
