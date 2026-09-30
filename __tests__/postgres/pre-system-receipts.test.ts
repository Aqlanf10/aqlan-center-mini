import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (LEGACY-AUDIT) كشف «سندات ما قبل النظام في الورديات» — للقراءة فقط، على PostgreSQL 18.
 *
 * نمط نقل الملفات: رصيدٌ افتتاحي بكامل قيمة العلاج، ثم سند قبض بما دُفع قبل النظام داخل وردية مفتوحة.
 * الكشف يعلّم هذه السندات (بالملاحظة، أو برصيدٍ افتتاحي في اليوم نفسه) ويعرض أثرها على كل وردية،
 * ولا يعلّم التحصيل الحقيقي، ولا يغيّر شيئًا.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, recordPayment, setPatientOpeningBalance, openShift, CLINIC_TIME_ZONE } =
  await import("../../lib/db");
const { buildReport, parseFilters } = await import("../../lib/reports");
const { clinicDateString } = await import("../../lib/schedule");
const { canAccessUnifiedReport } = await import("../../lib/report-access");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);

async function patient(name: string): Promise<number> {
  return (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`P-${name}`, name]))[0].id;
}
async function pay(patientId: number, amountMinor: number, note: string | null, openingCurrency: "YER" | null = null) {
  const result = await recordPayment({
    patientId, invoiceId: null, openingCurrency, kind: "payment", amountMinor, currency: "YER", baseCurrency: "YER",
    exchangeRate: 1, method: "cash", note, createdBy: "reception",
  });
  if (!result.payment) throw new Error(String(result.reason));
  return result.payment;
}

let shiftId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const shift = await openShift({ openedBy: "reception", opening: { YER: 0, SAR: 0, USD: 0 } });
  if (!shift) throw new Error("no shift");
  shiftId = shift.id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(LEGACY-AUDIT) pre-system receipts inside cashier shifts", () => {
  it("flags onboarding receipts, keeps real collections out, and shows each shift's real cash", async () => {
    // مريض نُقل ملفه اليوم: رصيدٌ افتتاحي بالكامل + سند بما دفعه قبل النظام (بلا ملاحظة).
    const moved = await patient("منقول");
    await setPatientOpeningBalance({ patientId: moved, amountMinor: 600_000, asOfDate: today, note: "علاج تقويم كامل", createdBy: "reception" });
    const onboarding = await pay(moved, 250_000, null, "YER");
    // سندٌ ملاحظته تقول «تسوية قبل النظام» — بلا رصيدٍ افتتاحي اليوم.
    const noted = await patient("ملاحظة");
    const byNote = await pay(noted, 40_000, "تسوية مدفوعات قبل النظام");
    // تحصيلٌ حقيقي اليوم لمريضٍ بلا رصيدٍ افتتاحي ولا ملاحظة: لا يُعلَّم.
    const regular = await patient("عادي");
    await pay(regular, 15_000, "حشوة");

    const invoicesBefore = await q(`SELECT COUNT(*)::int AS n FROM invoices`);
    const paymentsBefore = await q(`SELECT id, amount_minor, shift_id, note FROM payments ORDER BY id`);

    const report = await buildReport("pre-system-receipts", parseFilters(new URLSearchParams({ preset: "today" }), today));
    expect(report.periodLabel).toBe("كل الفترات");
    expect((report.rows ?? []).map((row) => [row.receiptNumber, row.amountMinor, row.reason])).toEqual([
      [onboarding.receiptNumber, 250_000, "رصيد افتتاحي في اليوم نفسه"],
      [byNote.receiptNumber, 40_000, "الملاحظة"],
    ]);
    expect(report.kpis.find((kpi) => kpi.key === "receipts")?.count).toBe(2);
    expect(report.kpis.find((kpi) => kpi.key === "shifts")?.count).toBe(1);
    expect(report.sections?.[0].rows).toEqual([expect.objectContaining({
      shiftId: `#${shiftId}`, currency: "YER", count: 2,
      flaggedMinor: 290_000, shiftTotalMinor: 305_000, realMinor: 15_000,
    })]);

    // للقراءة فقط.
    expect(await q(`SELECT COUNT(*)::int AS n FROM invoices`)).toEqual(invoicesBefore);
    expect(await q(`SELECT id, amount_minor, shift_id, note FROM payments ORDER BY id`)).toEqual(paymentsBefore);
  });

  it("the patient filter narrows rows and the patients KPI", async () => {
    const [moved] = await q<{ id: number }>(`SELECT id FROM patients WHERE full_name = 'منقول'`);
    const only = await buildReport("pre-system-receipts",
      parseFilters(new URLSearchParams({ preset: "today", patientId: String(moved.id) }), today));
    expect(only.rows).toHaveLength(1);
    expect(only.kpis.find((kpi) => kpi.key === "patients")?.count).toBe(1);
  });

  it("is for the manager and the accountant only", () => {
    expect(canAccessUnifiedReport("admin", "pre-system-receipts")).toBe(true);
    expect(canAccessUnifiedReport("accountant", "pre-system-receipts")).toBe(true);
    expect(canAccessUnifiedReport("reception", "pre-system-receipts")).toBe(false);
    expect(canAccessUnifiedReport("doctor", "pre-system-receipts")).toBe(false);
    expect(canAccessUnifiedReport("cashier", "pre-system-receipts")).toBe(false);
  });
});
