import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات سجل نسب المواد الفعّال (P1.10).
 *
 * النموذج: material_rates = الحالية، material_rate_history = append-only بسريان
 * effective_from. التقارير تحلّ النسبة كما كانت سارية (materialRatesMapAsOf)
 * لا كما هي الآن — فتعديل اليوم لا يعيد كتابة تقرير الأمس.
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

beforeAll(async () => {
  await ensureSchema();
  // إفراغ الجدولين لعزل الاختبار
  await getPool().query("DELETE FROM material_rate_history");
  await getPool().query("DELETE FROM material_rates");
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("سجل نسب المواد الفعّال", () => {
  it("كتابة نسبة تسجل الحالية + سطر تاريخ بسريان اليوم", async () => {
    const result = await setMaterialRate({ category: "تقويم", rateBp: 3500, actor: "test" });
    expect(result.ok).toBe(true);

    const current = await materialRatesMap();
    expect(current.get("تقويم")).toBe(3500);

    const asOfToday = await materialRatesMapAsOf(isoDaysAgo(0));
    expect(asOfToday.get("تقويم")).toBe(3500);
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
       VALUES ('زراعة', 2000, $1::date, 'seed')
       ON CONFLICT (category, effective_from) DO NOTHING`,
      [isoDaysAgo(10)],
    );
    await setMaterialRate({ category: "زراعة", rateBp: 3000, actor: "test" });

    // حلّ الأمس: النسبة السارية يومها = 2000 (سطر الأمس)، لا 3000 اليوم
    const yesterday = await materialRatesMapAsOf(isoDaysAgo(1));
    expect(yesterday.get("زراعة")).toBe(2000);
    // حلّ اليوم: 3000
    const today = await materialRatesMapAsOf(isoDaysAgo(0));
    expect(today.get("زراعة")).toBe(3000);
    // والحالية الحيّة: 3000
    const live = await materialRatesMap();
    expect(live.get("زراعة")).toBe(3000);
  });

  it("تعديل النسبة مرتين في اليوم نفسه يحدّث سطر اليوم (سطر واحد لكل تاريخ)", async () => {
    await setMaterialRate({ category: "تقويم", rateBp: 1000, actor: "test" });
    await setMaterialRate({ category: "تقويم", rateBp: 4000, actor: "test" });
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM material_rate_history WHERE category = 'تقويم' AND effective_from = CURRENT_DATE`,
    );
    expect(rows[0].n).toBe(1);
    expect((await materialRatesMapAsOf(isoDaysAgo(0))).get("تقويم")).toBe(4000);
  });

  it("حذف النسبة يسجّل صفرًا ساريًا من اليوم — لا يمحو الماضي", async () => {
    await setMaterialRate({ category: "زراعة", rateBp: null, actor: "test" });
    const today = await materialRatesMapAsOf(isoDaysAgo(0));
    expect(today.get("زراعة")).toBe(0); // «لا خصم من اليوم»
    // وما زال حلّ الأمس يرى نسبة الأمس
    const yesterday = await materialRatesMapAsOf(isoDaysAgo(1));
    expect(yesterday.get("زراعة")).toBe(2000);
    // والحالية الحية محذوفة
    expect((await listMaterialRates()).find((rate) => rate.category === "زراعة")).toBeUndefined();
  });

  it("قيد النطاق على rate_bp محفوظ في جدول التاريخ أيضًا", async () => {
    const pool = getPool();
    await expect(pool.query(
      `INSERT INTO material_rate_history (category, rate_bp, effective_from)
       VALUES ('x', 20000, CURRENT_DATE)`,
    )).rejects.toThrow();
  });
});
