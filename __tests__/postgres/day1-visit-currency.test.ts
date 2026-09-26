import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (DAY1 — ملاحظات المالك من أول يوم تشغيل) على PostgreSQL 18:
 *  * زيارةٌ بالريال السعودي تُسعَّر من سعر الخدمة الخاص بالسعودي، أو المحوَّل بسعر الصرف،
 *    وتُفوتر بالسعودي — لا يمني دائمًا كما كان.
 *  * عملة الزيارة تُحفظ عليها وتبقى بعد حفظٍ لا يذكرها.
 *  * الانحراف عن سعر الدليل بالعملة نفسها يحتاج سببًا كالعادة.
 *  * الرصيد السابق «إضافة فقط» لا يستبدل رصيدًا قائمًا بالعملة نفسها.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  getPool, resetPoolForTesting, ensureSchema, setVisitProcedures, getClinicalVisit, signClinicalVisit,
  setPatientOpeningBalance, getPatientOpeningBalance, ProcedurePriceRejected, OpeningBalanceExists, updateService, getService,
} = db;
const { CLINIC_BASE_CURRENCY } = await import("../../lib/money");

let patientId = 0;
let ownSar = 0;
let converted = 0;

const rates = { SAR: 140, USD: 530 };
const admin = { role: "admin", maxDiscountPercent: 10 };

async function newVisit(): Promise<number> {
  const { rows: [visit] } = await getPool().query<{ id: number }>(
    `INSERT INTO visits (patient_name, status, patient_id, arrived_at) VALUES ('مريض بالسعودي', 'seated', $1, NOW()) RETURNING id`,
    [patientId],
  );
  return visit.id;
}

const line = (serviceId: number, unitPriceMinor: number, priceReason: string | null = null) => ({
  serviceId, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor, priceReason, doctorId: null, note: null, planItemId: null,
});

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  ({ rows: [{ id: patientId }] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('DAY1-1', 'مريض بالسعودي') RETURNING id`));
  ({ rows: [{ id: ownSar }] } = await pool.query(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('تقويم ثابت', 300000, TRUE, TRUE, 'ortho') RETURNING id`));
  ({ rows: [{ id: converted }] } = await pool.query(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('تنظيف', 30000, TRUE, TRUE, 'cleaning') RETURNING id`));
  // سعرٌ خاص بالسعودي يقرّره المالك من الدليل.
  await updateService(ownSar, { priceSarMinor: 150000 });
}, 180_000);

afterAll(async () => { await resetPoolForTesting(); });

describe("(DAY1) visit billing currency", () => {
  it("stores the owner's SAR price on the service and keeps it when other fields change", async () => {
    await updateService(ownSar, { name: "تقويم ثابت — معدني" });
    expect(await getService(ownSar)).toMatchObject({ priceSarMinor: 150000, priceUsdMinor: null, priceMinor: 300000 });
    await updateService(ownSar, { priceUsdMinor: 40000 });
    await updateService(ownSar, { priceUsdMinor: null });
    expect((await getService(ownSar))?.priceUsdMinor).toBeNull();
  });

  it("prices a SAR visit from the own SAR price and the converted one, and signs a SAR invoice", async () => {
    const visitId = await newVisit();
    const saved = await setVisitProcedures({
      visitId, procedures: [line(ownSar, 150000), line(converted, 21400)],
      authority: admin, overrides: [], billingCurrency: "SAR", rates,
    });
    expect(saved).toBe(true);
    const visit = await getClinicalVisit(visitId);
    expect(visit?.billingCurrency).toBe("SAR");
    expect(visit?.totalMinor).toBe(171400);

    const signed = await signClinicalVisit({ visitId, baseCurrency: CLINIC_BASE_CURRENCY, signedBy: "day1" });
    expect(signed.reason).toBeNull();
    expect(signed.invoiceCurrency).toBe("SAR");
    const { rows: [invoice] } = await getPool().query<{ base_currency: string; total_minor: string }>(
      `SELECT base_currency, total_minor::text FROM invoices WHERE id = $1`, [signed.invoiceId]);
    expect(invoice).toEqual({ base_currency: "SAR", total_minor: "171400" });
  });

  it("keeps the chosen currency across a save that does not mention it", async () => {
    const visitId = await newVisit();
    await setVisitProcedures({ visitId, procedures: [line(converted, 5700)], authority: admin, overrides: [], billingCurrency: "USD", rates });
    await setVisitProcedures({ visitId, procedures: [line(converted, 5700)], authority: admin, overrides: [], rates });
    expect((await getClinicalVisit(visitId))?.billingCurrency).toBe("USD");
  });

  it("a doctor deviating from the SAR catalog price needs a reason, like in YER", async () => {
    const visitId = await newVisit();
    await expect(setVisitProcedures({
      visitId, procedures: [line(ownSar, 140000)], authority: { role: "doctor", maxDiscountPercent: 10 },
      overrides: [], billingCurrency: "SAR", rates,
    })).rejects.toBeInstanceOf(ProcedurePriceRejected);
    const overrides: { kind: string; catalogMinor: number }[] = [];
    await setVisitProcedures({
      visitId, procedures: [line(ownSar, 140000, "خصم أسرة")], authority: { role: "doctor", maxDiscountPercent: 10 },
      overrides: overrides as never, billingCurrency: "SAR", rates,
    });
    // (review) الانحراف يُسجَّل بعملته — 140000 تعني 1,400 ريال سعودي لا 140,000 يمني.
    expect(overrides[0]).toMatchObject({ kind: "discount", catalogMinor: 150000, currency: "SAR" });
  });

  it("an unchosen visit still bills in YER from the YER catalog", async () => {
    const visitId = await newVisit();
    await setVisitProcedures({ visitId, procedures: [line(converted, 30000)], authority: admin, overrides: [], rates });
    const signed = await signClinicalVisit({ visitId, baseCurrency: CLINIC_BASE_CURRENCY, signedBy: "day1" });
    expect(signed.invoiceCurrency).toBe("YER");
  });
});

describe("(DAY1) previous balance add-only", () => {
  it("never replaces an existing balance in the same currency; another currency is fine", async () => {
    await setPatientOpeningBalance({ patientId, currency: "YER", amountMinor: 50000, asOfDate: "2026-01-01", note: null, createdBy: "reception", addOnly: true });
    await expect(setPatientOpeningBalance({
      patientId, currency: "YER", amountMinor: 1, asOfDate: "2026-01-01", note: null, createdBy: "reception", addOnly: true,
    })).rejects.toBeInstanceOf(OpeningBalanceExists);
    expect((await getPatientOpeningBalance(patientId, "YER"))?.amountMinor).toBe(50000);
    await setPatientOpeningBalance({ patientId, currency: "SAR", amountMinor: 20000, asOfDate: "2026-01-01", note: null, createdBy: "reception", addOnly: true });
    expect((await getPatientOpeningBalance(patientId, "SAR"))?.amountMinor).toBe(20000);
    // المدير (بلا addOnly) يعدّل كما كان.
    await setPatientOpeningBalance({ patientId, currency: "YER", amountMinor: 45000, asOfDate: "2026-01-01", note: null, createdBy: "admin", reason: "تصحيح" });
    expect((await getPatientOpeningBalance(patientId, "YER"))?.amountMinor).toBe(45000);
  });
});
