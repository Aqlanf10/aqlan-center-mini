import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (DN-1) الترقيم بعد ٩٩٬٩٩٩ — على PostgreSQL 18.
 *
 * كان الرقم يُصاغ بـ LPAD(n, 5): وهي في PostgreSQL **تقصّ** ما زاد على خمس خانات. فالسند ١٠٠٬٠٠٠
 * يخرج «R-10000» (رقم سندٍ قديم) والتالي «R-10000» أيضًا — تكرارٌ يُسقط القبض برسالة خطأ، أو
 * رقمٌ مطبوع يطابق سندًا آخر. والمطلوب: خمس خانات كحدٍّ أدنى لا أقصى — «R-00042» كما كان،
 * و«R-100000» و«R-100001» بعده بلا قصٍّ ولا تكرار. وكذلك الفواتير وسندات الصرف وملفات المرضى.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { ensureSchema, getPool, resetPoolForTesting, openShift, createInvoice, recordPayment, recordExpense, createPatient } = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let patientId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  const patient = await createPatient({
    fullName: "مريض الترقيم", phone: null, altPhone: null, gender: "male", birthYear: 1990,
    address: null, medicalAlert: null, note: null,
  });
  patientId = patient.id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function invoice(): Promise<string> {
  const created = await createInvoice({
    patientId, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "doctor",
    items: [{ serviceId: null, doctorId: null, description: "خدمة", quantity: 1, unitPriceMinor: 1_000 }],
  });
  if (!created) throw new Error("invoice not created");
  return created.invoiceNumber;
}

async function receipt(): Promise<string> {
  const paid = await recordPayment({
    patientId, invoiceId: null, kind: "payment", amountMinor: 100, currency: "YER", baseCurrency: "YER",
    exchangeRate: 1, method: "cash", note: null, createdBy: "cashier", reversalOfId: null, openingCurrency: null,
  });
  if (paid.reason !== null || !paid.payment) throw new Error(`payment refused: ${paid.reason}`);
  return paid.payment.receiptNumber;
}

async function voucher(): Promise<string> {
  const paid = await recordExpense({
    category: "electricity", partyId: null, payeeText: "الكهرباء", amountMinor: 100, currency: "YER",
    baseCurrency: "YER", exchangeRate: 1, payableId: null, note: null, createdBy: "cashier", rates: { YER: 1, SAR: 140, USD: 530 },
  });
  if (paid.reason !== null || !paid.expense) throw new Error(`voucher refused: ${paid.reason}`);
  return paid.expense.voucherNumber;
}

async function patientNumber(): Promise<string> {
  const created = await createPatient({
    fullName: `مريض ${Math.random()}`, phone: null, altPhone: null, gender: "female", birthYear: 1995,
    address: null, medicalAlert: null, note: null,
  });
  return created.patientNumber;
}

describe("(DN-1) numbering past 99,999", () => {
  it("small numbers keep their five-digit form", async () => {
    await q(`SELECT setval('receipt_number_seq', 41, true)`);
    expect(await receipt()).toBe("R-00042");
  });

  for (const [label, seq, make, prefix] of [
    ["receipts", "receipt_number_seq", receipt, "R"],
    ["invoices", "invoice_number_seq", invoice, "INV"],
    ["vouchers", "voucher_number_seq", voucher, "V"],
    ["patient files", "patient_number_seq", patientNumber, "P"],
  ] as const) {
    it(`${label}: 99,999 → 100,000 → 100,001 — full width, no truncation, no duplicate`, async () => {
      await q(`SELECT setval('${seq}', 99998, true)`);
      const numbers = [await make(), await make(), await make()];
      expect(numbers).toEqual([`${prefix}-99999`, `${prefix}-100000`, `${prefix}-100001`]);
    });
  }

  it("the counter sync at startup reads six-digit numbers back correctly", async () => {
    // بعد إعادة الإقلاع: المزامنة تقرأ أكبر رقمٍ قائم (١٠٠٬٠٠١) — فلا يعود العدّاد إلى الخلف.
    await q(`SELECT setval('receipt_number_seq', 5, true)`);
    await q(`SELECT setval('receipt_number_seq', GREATEST(
               (SELECT last_value FROM receipt_number_seq),
               (SELECT COALESCE(MAX(NULLIF(regexp_replace(receipt_number, '\\D', '', 'g'), '')::bigint), 0) FROM payments)
             ), true)`);
    expect(await receipt()).toBe("R-100002");
  });
});
