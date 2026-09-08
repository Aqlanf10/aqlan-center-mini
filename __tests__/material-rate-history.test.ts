import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات سجل نسب المواد الفعّال (P1.10 + P1-FIX-6).
 *
 * النموذج: material_rates = الحالية، material_rate_history = append-only بسريان
 * effective_from TIMESTAMPTZ لكل تغيير (لا UNIQUE يومي ولا ON CONFLICT DO
 * UPDATE — تغييران في اليوم نفسه صفّان). التقارير تحلّ النسبة كما كانت سارية
 * وقت الحدث (لا نهاية مدى التقرير) — فتعديل النسبة لا يعيد كتابة تقرير الأمس.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const {
  getPool, resetPoolForTesting, ensureSchema, setMaterialRate,
  materialRatesMap, materialRatesMapAsOf, listMaterialRates,
} = await import("../lib/db");

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

/** «الآن» بطابع كامل — سريان TIMESTAMPTZ بدقة اللحظة لا اليوم. */
function isoNow(): string {
  return new Date().toISOString();
}

beforeAll(async () => {
  await ensureSchema();
  // إفراغ الجدولين لعزل الاختبار
  await getPool().query("DELETE FROM material_rate_history");
  await getPool().query("DELETE FROM material_rates");
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("سجل نسب المواد الفعّال (append-only بالسريان الزمني)", () => {
  it("كتابة نسبة تسجل الحالية + سطر تاريخ بسريان اللحظة — بذرة معاملة واحدة", async () => {
    const result = await setMaterialRate({ category: "تقويم", rateBp: 3500, actor: "test" });
    expect(result.ok).toBe(true);

    const current = await materialRatesMap();
    expect(current.get("تقويم")).toBe(3500);

    const asOfNow = await materialRatesMapAsOf(isoNow());
    expect(asOfNow.get("تقويم")).toBe(3500);

    // الكتابة ذرّية: الجدولان معًا — لا حالة «الحالية تغيّرت والتاريخ لا»
    const pool = getPool();
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM material_rate_history WHERE category = 'تقويم'`,
    );
    expect(row.n).toBe(1);
  });

  it("قبل تاريخ أول سجل ⇒ غير مقيَّمة (لا نختلق نسبًا رجعيّة)", async () => {
    const before = await materialRatesMapAsOf(isoDaysAgo(30));
    expect(before.get("تقويم")).toBeUndefined();
  });

  it("تعديل النسبة اليوم لا يغيّر حلّ الأمس — التقرير التاريخي محمي", async () => {
    // نسجّل سطر تاريخ بسريان الأمس يدويًّا (محاكاة تاريخ قائم من P1)
    const pool = getPool();
    await pool.query(
      `INSERT INTO material_rate_history (category, rate_bp, effective_from, recorded_by)
       VALUES ('زراعة', 2000, $1::timestamptz, 'seed')`,
      [`${isoDaysAgo(10)}T00:00:00Z`],
    );
    await setMaterialRate({ category: "زراعة", rateBp: 3000, actor: "test" });

    // حلّ الأمس: النسبة السارية يومها = 2000 (سطر الأمس)، لا 3000 اليوم
    const yesterday = await materialRatesMapAsOf(`${isoDaysAgo(1)}T12:00:00Z`);
    expect(yesterday.get("زراعة")).toBe(2000);
    // حلّ الآن: 3000
    const today = await materialRatesMapAsOf(isoNow());
    expect(today.get("زراعة")).toBe(3000);
    // والحالية الحيّة: 3000
    const live = await materialRatesMap();
    expect(live.get("زراعة")).toBe(3000);
  });

  it("تغييران في اليوم نفسه ⇒ صفّان append-only والأحدث هو الساري (P1-FIX-6)", async () => {
    await setMaterialRate({ category: "تقويم", rateBp: 1000, actor: "test" });
    await setMaterialRate({ category: "تقويم", rateBp: 4000, actor: "test" });
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n, MAX(rate_bp)::int AS latest
         FROM material_rate_history WHERE category = 'تقويم'`,
    );
    // 3500 (الأول) + 1000 + 4000: ثلاثة صفوف — كل تغيير صف، لا UPDATE لسطر اليوم
    expect(rows[0].n).toBe(3);
    expect(rows[0].latest).toBe(4000);
    expect((await materialRatesMapAsOf(isoNow())).get("تقويم")).toBe(4000);
  });

  it("حذف النسبة يسجّل صفرًا ساريًا من اللحظة — لا يمحو الماضي", async () => {
    await setMaterialRate({ category: "زراعة", rateBp: null, actor: "test" });
    const today = await materialRatesMapAsOf(isoNow());
    expect(today.get("زراعة")).toBe(0); // «لا خصم من الآن»
    // وما زال حلّ الأمس يرى نسبة الأمس
    const yesterday = await materialRatesMapAsOf(`${isoDaysAgo(1)}T12:00:00Z`);
    expect(yesterday.get("زراعة")).toBe(2000);
    // والحالية الحية محذوفة
    expect((await listMaterialRates()).find((rate) => rate.category === "زراعة")).toBeUndefined();
  });

  it("قيد النطاق على rate_bp محفوظ في جدول التاريخ أيضًا", async () => {
    const pool = getPool();
    await expect(pool.query(
      `INSERT INTO material_rate_history (category, rate_bp, effective_from)
       VALUES ('x', 20000, NOW())`,
    )).rejects.toThrow();
  });

  it("التسجيل مستقل عن الترتيب داخل اليوم: حلّ لحظةٍ بين تغييرين يرى الأول لا الأحدث", async () => {
    const pool = getPool();
    await pool.query("DELETE FROM material_rate_history WHERE category = 'ترميم'");
    const first = await setMaterialRate({ category: "ترميم", rateBp: 1500, actor: "test" });
    expect(first.ok).toBe(true);
    const firstAt = await pool.query<{ effective_from: Date }>(
      `SELECT effective_from FROM material_rate_history WHERE category = 'ترميم' ORDER BY effective_from LIMIT 1`,
    );
    const midTimestamp = new Date(firstAt.rows[0].effective_from).toISOString();
    await setMaterialRate({ category: "ترميم", rateBp: 2500, actor: "test" });
    // حلّ اللحظة بعد التغيير الأول وقبل الثاني مباشرة: 1500 لا 2500
    const atMid = await materialRatesMapAsOf(midTimestamp);
    expect(atMid.get("ترميم")).toBe(1500);
    // وبعد الثاني: 2500
    const atEnd = await materialRatesMapAsOf(isoNow());
    expect(atEnd.get("ترميم")).toBe(2500);
  });
});
