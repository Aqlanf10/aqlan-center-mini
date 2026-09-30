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
    expect(report.sections?.[1].rows).toEqual([expect.objectContaining({
      patientId: moved, currency: "YER", openingMinor: 600_000, currentDueMinor: 350_000,
    })]);
    expect(report.sections?.[4].rows).toContainEqual(expect.objectContaining({
      patientId: moved, currency: "YER", openingMinor: 600_000,
      historicalMinor: 250_000, currentDueMinor: 350_000,
    }));
    expect(report.sections?.[5].rows).toContainEqual(expect.objectContaining({
      patientId: moved, currency: "YER", action: "تعيين / تعديل", afterMinor: 600_000,
    }));

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
    expect(only.sections?.[0].rows).toEqual([expect.objectContaining({
      shiftId: `#${shiftId}`, flaggedMinor: 290_000, shiftTotalMinor: 305_000, realMinor: 15_000,
    })]);
  });

  it("attributes a later refund to its own shift while keeping the original shift estimate intact", async () => {
    const [moved] = await q<{ id: number }>(`SELECT id FROM patients WHERE full_name = 'منقول'`);
    const [original] = await q<{ id: number }>(
      `SELECT id FROM payments WHERE patient_id = $1 AND kind = 'payment' ORDER BY id LIMIT 1`, [moved.id]);
    await q(`UPDATE cashier_shifts SET status = 'closed', closed_at = NOW(), closed_by = 'test' WHERE id = $1`, [shiftId]);
    const later = await openShift({ openedBy: "reception", opening: { YER: 0, SAR: 0, USD: 0 } });
    if (!later) throw new Error("no later shift");
    const refund = await recordPayment({
      patientId: moved.id, invoiceId: null, kind: "refund", amountMinor: 20_000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: "رد جزئي", createdBy: "reception", reversalOfId: original.id,
    });
    expect(refund.payment).not.toBeNull();
    const regular = await patient("دفعة جديدة");
    await pay(regular, 5_000, "تحصيل حقيقي");

    const report = await buildReport("pre-system-receipts", parseFilters(new URLSearchParams({
      preset: "today", patientId: String(moved.id),
    }), today));
    expect(report.rows).toEqual([expect.objectContaining({ amountMinor: 230_000 })]);
    expect(report.sections?.[0].rows).toEqual([
      expect.objectContaining({ shiftId: `#${shiftId}`, flaggedMinor: 290_000, shiftTotalMinor: 305_000, realMinor: 15_000 }),
      expect.objectContaining({ shiftId: `#${later.id}`, flaggedMinor: -20_000, shiftTotalMinor: -15_000, realMinor: 5_000 }),
    ]);
  });

  it("flags ambiguous legacy ortho and possible duplicate billing as review candidates only", async () => {
    const [moved] = await q<{ id: number }>(`SELECT id FROM patients WHERE full_name = 'منقول'`);
    await q(
      `INSERT INTO ortho_cases (patient_id, created_by, start_date, note)
       VALUES ($1, 'dr', CURRENT_DATE - 90, 'علاج بدأ قبل إدخال الحالة')`, [moved.id]);
    const [service] = await q<{ id: number }>(
      `INSERT INTO services (name, price_minor, category, price_configured)
       VALUES ('شدّة للمراجعة', 10_000, 'ortho', TRUE) RETURNING id`);
    const [invoice] = await q<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, base_currency, created_by)
       VALUES ('LEGACY-REVIEW-1', $1, 10_000, 'YER', 'test') RETURNING id`, [moved.id]);
    await q(
      `INSERT INTO invoice_items (invoice_id, service_id, description, unit_price_minor, total_minor)
       VALUES ($1, $2, 'شدّة للمراجعة', 10_000, 10_000)`, [invoice.id, service.id]);

    const report = await buildReport("pre-system-receipts", parseFilters(new URLSearchParams({
      preset: "today", patientId: String(moved.id),
    }), today));
    expect(report.sections?.[2].rows).toEqual([expect.objectContaining({
      patientId: moved.id, reviewState: expect.stringContaining("مراجعة بشرية"),
    })]);
    expect(report.sections?.[3].rows).toEqual([expect.objectContaining({
      patientId: moved.id, invoiceNumber: "LEGACY-REVIEW-1",
      reviewState: expect.stringContaining("مرشح للمراجعة"),
    })]);
    expect(report.sections?.[4].rows).toContainEqual(expect.objectContaining({
      patientId: moved, currency: "YER", invoicedMinor: 10_000, currentDueMinor: 380_000,
    }));
  });

  it("keeps SAR opening and receipts separate from the YER ledger", async () => {
    const [moved] = await q<{ id: number }>(`SELECT id FROM patients WHERE full_name = 'منقول'`);
    await setPatientOpeningBalance({ patientId: moved.id, currency: "SAR", amountMinor: 50_000,
      asOfDate: today, note: "رصيد ريال", createdBy: "reception" });
    const payment = await recordPayment({ patientId: moved.id, invoiceId: null, openingCurrency: "SAR",
      kind: "payment", amountMinor: 10_000, currency: "SAR", baseCurrency: "YER", exchangeRate: 1,
      method: "cash", note: "دفعة بعد النظام", createdBy: "reception" });
    expect(payment.payment).not.toBeNull();

    const report = await buildReport("pre-system-receipts", parseFilters(new URLSearchParams({
      preset: "today", patientId: String(moved.id),
    }), today));
    expect(report.sections?.[1].rows).toContainEqual(expect.objectContaining({
      patientId: moved.id, currency: "SAR", openingMinor: 50_000, currentDueMinor: 40_000,
    }));
    expect(report.sections?.[4].rows).toContainEqual(expect.objectContaining({
      patientId: moved.id, currency: "SAR", openingMinor: 50_000,
      historicalMinor: 10_000, laterOtherMinor: 0, currentDueMinor: 40_000,
    }));
    expect(report.sections?.[4].rows).toContainEqual(expect.objectContaining({
      patientId: moved.id, currency: "YER", openingMinor: 600_000,
    }));

    const sarOnly = await buildReport("pre-system-receipts", parseFilters(new URLSearchParams({
      preset: "today", patientId: String(moved.id), currency: "SAR",
    }), today));
    // A receipt entered on the same clinic day as the opening balance is deliberately
    // flagged for human review; the audit must keep it in the SAR bucket, never YER.
    expect(sarOnly.rows).toEqual([expect.objectContaining({
      patientId: moved.id, currency: "SAR", amountMinor: 10_000,
    })]);
    expect(sarOnly.sections?.[0].rows).toEqual([expect.objectContaining({
      currency: "SAR", flaggedMinor: 10_000,
    })]);
    expect(sarOnly.sections?.[1].rows).toEqual([expect.objectContaining({
      patientId: moved.id, currency: "SAR", currentDueMinor: 40_000,
    })]);
    expect(sarOnly.sections?.[4].rows).toEqual([expect.objectContaining({
      patientId: moved.id, currency: "SAR", currentDueMinor: 40_000,
    })]);
  });

  it("is for the manager and the accountant only", () => {
    expect(canAccessUnifiedReport("admin", "pre-system-receipts")).toBe(true);
    expect(canAccessUnifiedReport("accountant", "pre-system-receipts")).toBe(true);
    expect(canAccessUnifiedReport("reception", "pre-system-receipts")).toBe(false);
    expect(canAccessUnifiedReport("doctor", "pre-system-receipts")).toBe(false);
    expect(canAccessUnifiedReport("cashier", "pre-system-receipts")).toBe(false);
  });
});
