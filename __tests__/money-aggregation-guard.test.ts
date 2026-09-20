import { describe, expect, it } from "vitest";
import { scanMoneyAggregation } from "../lib/money-aggregation-guard";

/**
 * اختبارات حارس تجميع المال (P-01) — الحارس نفسه يُختبر: عينةٌ غير آمنة تفشل،
 * وعينةٌ آمنة تمر، وكود المنتج الحقيقي نظيف. حارسٌ لا يُختبر حارسٌ لا يحمي.
 */

const FILE = "fixture.ts";

describe("حارس تجميع المال — العينات غير الآمنة تُكتشف", () => {
  it("SUM لفواتير بلا GROUP BY عملة (خطأ P0-1 الأصلي) يُكتشف", () => {
    const source = [
      "const sql = `SELECT COALESCE(SUM(GREATEST(0, total_minor - discount_minor)), 0) AS invoiced,",
      " COUNT(*)::int AS count",
      " FROM invoices WHERE status <> 'cancelled'`;",
    ].join("\n");
    const violations = scanMoneyAggregation(source, FILE);
    expect(violations.length).toBe(1);
    expect(violations[0]?.column).toContain("total_minor");
    expect(violations[0]?.column).toContain("discount_minor");
  });

  it("SUM للدفعات بلا GROUP BY currency يُكتشف", () => {
    const source = [
      "const sql = `SELECT patient_id,",
      " COALESCE(SUM(CASE WHEN kind = 'refund' THEN -base_amount_minor ELSE base_amount_minor END), 0) AS amount,",
      " COALESCE(SUM(amount_minor), 0) AS raw",
      " FROM payments GROUP BY patient_id`;",
    ].join("\n");
    const violations = scanMoneyAggregation(source, FILE);
    // base_amount_minor معفى (مكافئ أساسي مسجَّل)؛ amount_minor بلا بعد عملة يُكتشف.
    expect(violations.length).toBe(1);
    expect(violations[0]?.column).toBe("amount_minor");
  });

  it("GROUP BY patient_id وحده لا يكفي للفواتير — المريض بعملتين", () => {
    const source = [
      "const sql = `SELECT patient_id, SUM(total_minor) AS total",
      " FROM invoices WHERE status <> 'cancelled' GROUP BY patient_id`;",
    ].join("\n");
    const violations = scanMoneyAggregation(source, FILE);
    expect(violations.length).toBe(1);
  });

  it("ORDER BY على مجموع مختلط بلا بعد عملة يُكتشف (ترتيب عبر العملات)", () => {
    const source = [
      "const sql = `SELECT it.description, COUNT(*)::int AS count, COALESCE(SUM(it.total_minor), 0) AS total",
      " FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id",
      " WHERE i.status <> 'cancelled' GROUP BY it.description ORDER BY total DESC LIMIT 10`;",
    ].join("\n");
    const violations = scanMoneyAggregation(source, FILE);
    expect(violations.length).toBe(1);
    expect(violations[0]?.column).toBe("total_minor");
  });

  it("مصاريف بلا بعد عملة تُكتشف — للمصروف عملته كالدفعات", () => {
    const source = [
      "const sql = `SELECT SUM(amount_minor) AS spent FROM expenses WHERE shift_id = $1`;",
    ].join("\n");
    const violations = scanMoneyAggregation(source, FILE);
    expect(violations.length).toBe(1);
  });
});

describe("حارس تجميع المال — العينات الآمنة تمر", () => {
  it("GROUP BY base_currency (استعلام P-01 الجديد) آمن", () => {
    const source = [
      "const sql = `SELECT base_currency,",
      " COALESCE(SUM(GREATEST(0, total_minor - discount_minor)), 0) AS invoiced,",
      " COUNT(*)::int AS count",
      " FROM invoices WHERE status <> 'cancelled' GROUP BY base_currency`;",
    ].join("\n");
    expect(scanMoneyAggregation(source, FILE)).toEqual([]);
  });

  it("GROUP BY currency, kind للدفعات آمن (عقد الدفعات القائم)", () => {
    const source = [
      "const sql = `SELECT currency, kind, COALESCE(SUM(amount_minor), 0) AS amount,",
      " COALESCE(SUM(base_amount_minor), 0) AS base",
      " FROM payments GROUP BY currency, kind`;",
    ].join("\n");
    expect(scanMoneyAggregation(source, FILE)).toEqual([]);
  });

  it("فلتر عملة واحدة حرفي آمن (WHERE currency = 'YER')", () => {
    const source = [
      "const sql = `SELECT COALESCE(SUM(amount_minor), 0) AS total",
      " FROM payments WHERE patient_id = $1 AND currency = 'YER'`;",
    ].join("\n");
    expect(scanMoneyAggregation(source, FILE)).toEqual([]);
  });

  it("تجميع لكل فاتورة بعينها آمن — الفاتورة الواحدة عملة واحدة", () => {
    const source = [
      "const sql = `SELECT i.patient_id, i.id AS invoice_id,",
      " COALESCE(SUM(it.total_minor), 0) AS share_minor",
      " FROM invoices i LEFT JOIN invoice_items it ON it.invoice_id = i.id",
      " GROUP BY i.patient_id, i.id, i.total_minor`;",
    ].join("\n");
    expect(scanMoneyAggregation(source, FILE)).toEqual([]);
  });

  it("GROUP BY invoice_id للبنود آمن", () => {
    const source = [
      "const sql = `SELECT invoice_id, SUM(total_minor) AS items_total",
      " FROM invoice_items GROUP BY invoice_id`;",
    ].join("\n");
    expect(scanMoneyAggregation(source, FILE)).toEqual([]);
  });

  it("base_amount_minor معفى — المكافئ المسجَّل بوحدات الأساس", () => {
    const source = [
      "const sql = `SELECT party_id, COALESCE(SUM(base_amount_minor), 0) AS paid",
      " FROM expenses WHERE category = 'commission' GROUP BY party_id`;",
    ].join("\n");
    expect(scanMoneyAggregation(source, FILE)).toEqual([]);
  });

  it("الرصيد الافتتاحي معفى — أساسيٌّ بنيويًّا بلا عمود عملة", () => {
    const source = [
      "const sql = `SELECT SUM(amount_minor) AS opening_total",
      " FROM patient_opening_balances WHERE patient_id = $1`;",
    ].join("\n");
    expect(scanMoneyAggregation(source, FILE)).toEqual([]);
  });

  it("تجميع JavaScript خارج SQL لا يُحرس هنا (نطاق الحارس SQL)", () => {
    const source = "const total = payments.reduce((sum, p) => sum + p.amountMinor, 0);";
    expect(scanMoneyAggregation(source, FILE)).toEqual([]);
  });

  it("GROUP BY base_currency للخدمات مع الوصف آمن (استعلام P-01 للخدمات)", () => {
    const source = [
      "const sql = `SELECT it.description, i.base_currency, COUNT(*)::int AS count,",
      " COALESCE(SUM(it.total_minor), 0) AS total",
      " FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id",
      " WHERE i.status <> 'cancelled' GROUP BY it.description, i.base_currency`;",
    ].join("\n");
    expect(scanMoneyAggregation(source, FILE)).toEqual([]);
  });
});

describe("حارس تجميع المال — كود المنتج الحقيقي", () => {
  it("lib/db.ts لا يحوي تجميعًا عبر العملات (خارج الاستثناءين الموثَّقين)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "lib/db.ts"), "utf8");
    const violations = scanMoneyAggregation(source, "lib/db.ts");
    // الاستثناءان الموثَّقان في db.ts: سلسلة الاسترداد (عملة الأصل حكامًا)،
    // والاستعلام المرتبط لكل خطة (دلو عملة الخطة حكامًا) — كلاهما TD-05.
    // المطابقة على نص الجملة كاملًا (sqlSegment): استعلام الخطة طويلٌ
    // فيقع موضع الدفعات خارج مقتطف العرض المقتطع.
    expect(violations.length).toBe(2);
    expect(violations[0]?.sqlSegment).toContain("reversal_of_id");
    expect(violations[1]?.sqlSegment).toContain("y.plan_id = t.id");
  });
});
