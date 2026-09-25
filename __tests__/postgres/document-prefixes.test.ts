import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P3-1) بادئات المستندات المالية من الإعدادات — على PostgreSQL 18 الحقيقي.
 *
 * العيب (تدقيق الجاهزية): «INV-» و«R-» و«V-» و«X-» مكتوبةٌ في الكود — العيادة
 * لا تستطيع أن تجعل فاتورتها «FAC-» دون نشرةٍ برمجية.
 *
 * البادئة تُقرأ داخل معاملة الإدراج نفسها من جدول الإعدادات، فلا خبيئة تؤخّرها
 * ولا سباق بين تغييرها وترقيم مستند. والعدّاد واحد لا يتغيّر: الأرقام تتابع ولا
 * تتكرّر مهما تغيّرت البادئة.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  ensureSchema, schemaReadyReset, getPool, resetPoolForTesting, createInvoice, saveSettingsAudited, recordPayment, recordExpense, voidExpense, openShift,
} = await import("../../lib/db");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

async function setPrefix(key: string, value: string) {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

let patientId = 0;

async function invoice() {
  const created = await createInvoice({
    patientId, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "p31",
    items: [{ serviceId: null, doctorId: null, description: "كشف", quantity: 1, unitPriceMinor: 5000 }],
  });
  return created!;
}

async function receipt(invoiceId: number) {
  const result = await recordPayment({
    patientId, invoiceId, kind: "payment", amountMinor: 1000, currency: "YER", baseCurrency: "YER",
    exchangeRate: 1, method: "cash", note: null, createdBy: "p31",
  });
  return result.payment!;
}

async function voucher() {
  const result = await recordExpense({
    category: "other", partyId: null, payeeText: "نثريات", amountMinor: 700, currency: "YER", baseCurrency: "YER",
    exchangeRate: 1, payableId: null, note: null, createdBy: "p31", rates: { YER: 1, SAR: 140, USD: 535 },
    payableExchangeRate: null, rateOverrideReason: null, prepaymentReason: null, expectedQuote: null,
  });
  return result.expense!;
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "p31", opening: { YER: 0, SAR: 0, USD: 0 } });
  const [row] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ('P31-1', 'مريض البادئات') RETURNING id`,
  );
  patientId = row.id;
}, 180_000);

beforeEach(async () => {
  await q(`DELETE FROM settings WHERE key LIKE 'documents.%_prefix'`);
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("P3-1 — بادئات المستندات المالية", () => {
  it("بلا إعداد: البادئات التاريخية نفسها (لا يتغيّر شيء يوم النشر)", async () => {
    const inv = await invoice();
    expect(inv.invoiceNumber).toMatch(/^INV-\d{5}$/);
    expect((await receipt(inv.id)).receiptNumber).toMatch(/^R-\d{5}$/);
    const expense = await voucher();
    expect(expense.voucherNumber).toMatch(/^V-\d{5}$/);
    const voided = await voidExpense(expense.id, { actor: "admin", actorRole: "admin", reason: "خطأ" });
    expect(voided.voidedVoucherNumber).toMatch(/^X-\d{5}$/);
  });

  it("البادئات المضبوطة تُطبَّق على الفاتورة والسند وسند الصرف وسند الإبطال", async () => {
    await setPrefix("documents.invoice_prefix", "FAC");
    await setPrefix("documents.receipt_prefix", "QBD");
    await setPrefix("documents.voucher_prefix", "SRF");
    await setPrefix("documents.reversal_prefix", "IBT");
    const inv = await invoice();
    expect(inv.invoiceNumber).toMatch(/^FAC-\d{5}$/);
    expect((await receipt(inv.id)).receiptNumber).toMatch(/^QBD-\d{5}$/);
    const expense = await voucher();
    expect(expense.voucherNumber).toMatch(/^SRF-\d{5}$/);
    const voided = await voidExpense(expense.id, { actor: "admin", actorRole: "admin", reason: "خطأ" });
    expect(voided.voidedVoucherNumber).toMatch(/^IBT-\d{5}$/);
  });

  it("تغيير البادئة لا يعيد العدّاد: الرقم يتابع بلا تكرار", async () => {
    const before = await invoice();
    await setPrefix("documents.invoice_prefix", "FAC");
    const after = await invoice();
    const digits = (value: string) => Number(value.replace(/\D/g, ""));
    expect(digits(after.invoiceNumber)).toBe(digits(before.invoiceNumber) + 1);
  });

  it("قيمة فاسدة مخزّنة مباشرةً في الجدول لا تدخل رقم المستند — تعود للافتراضي", async () => {
    // الشاشة والخادم يرفضانها؛ هذا دفاعٌ لمن كتب في القاعدة مباشرة. الرقم داخل
    // البادئة يُفسد مزامنة العدّاد عند الإقلاع (تُنزع غير الأرقام وتُقرأ الباقية).
    await setPrefix("documents.invoice_prefix", "IN2026");
    expect((await invoice()).invoiceNumber).toMatch(/^INV-\d{5}$/);
    await setPrefix("documents.invoice_prefix", "fac' --");
    expect((await invoice()).invoiceNumber).toMatch(/^INV-\d{5}$/);
  });

  it("مزامنة العدّادات عند الإقلاع لا تقفز بسبب البادئة الجديدة", async () => {
    await setPrefix("documents.invoice_prefix", "FAC");
    const last = await invoice();
    schemaReadyReset();
    await ensureSchema();
    const next = await invoice();
    const digits = (value: string) => Number(value.replace(/\D/g, ""));
    expect(digits(next.invoiceNumber)).toBe(digits(last.invoiceNumber) + 1);
  });

  it("مراجعة: بادئةٌ استعملها نوعٌ في مستنداتٍ سابقة لا تُعطى لنوعٍ آخر", async () => {
    await invoice(); // INV-000NN موجودة في الدفاتر
    const moved = await saveSettingsAudited({ values: { "documents.invoice_prefix": "FAC" }, actor: "admin", reason: "ت" });
    expect(moved.ok).toBe(true);
    const reused = await saveSettingsAudited({ values: { "documents.receipt_prefix": "INV" }, actor: "admin", reason: "ت" });
    expect(reused.ok).toBe(false);
    expect(!reused.ok && "problem" in reused ? reused.problem : "").toContain("مستخدمة سابقًا");
    // والعودة إلى البادئة القديمة للنوع نفسه مسموحة: العدّاد يتابع فلا تكرار.
    expect((await saveSettingsAudited({ values: { "documents.invoice_prefix": "INV" }, actor: "admin", reason: "ت" })).ok).toBe(true);
  });

  it("مراجعة: حفظان متزامنان يعطيان بادئةً واحدة لنوعين — ينجح واحدٌ فقط", async () => {
    const results = await Promise.all([
      saveSettingsAudited({ values: { "documents.invoice_prefix": "DUP" }, actor: "a1", reason: "ت" }),
      saveSettingsAudited({ values: { "documents.receipt_prefix": "DUP" }, actor: "a2", reason: "ت" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const rows = await q<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM settings WHERE key LIKE 'documents.%_prefix' AND value = 'DUP'`,
    );
    expect(rows[0]?.n).toBe(1);
  });
});

