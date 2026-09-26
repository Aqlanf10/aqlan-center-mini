import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (PAT-1) البحث عن المريض على PostgreSQL 18 كما تكتبه موظفة الاستقبال فعلًا:
 * بلا همزة، بالهاء بدل التاء المربوطة، بالكلمات بأي ترتيب، وبرقم الجوال بأي صيغة، وبرقم
 * الهوية وجوال وليّ الأمر. كان «احمد» لا يجد «أحمد» — فيُنشأ ملفٌ مكرر.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { getPool, resetPoolForTesting, ensureSchema, searchPatients } = await import("../../lib/db");
const { normalizeSearchText, normalizedSql } = await import("../../lib/patient-search");

const ids: Record<string, number> = {};

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  const add = async (key: string, sql: string, params: unknown[]) => {
    ids[key] = (await pool.query<{ id: number }>(sql, params)).rows[0].id;
  };
  await add("ahmad", `INSERT INTO patients (patient_number, full_name, phone) VALUES ('PS-1', 'أحمد عبدالله الشرعبي', '967770111222') RETURNING id`, []);
  await add("fatima", `INSERT INTO patients (patient_number, full_name, phone) VALUES ('PS-2', 'فاطمة مصطفى', '0733444555') RETURNING id`, []);
  await add("child", `INSERT INTO patients (patient_number, full_name, guardian_name, guardian_phone, national_id)
    VALUES ('PS-3', 'مُحَمَّد علي', 'علي سعيد', '771999888', '01010123456') RETURNING id`, []);
}, 120_000);
afterAll(async () => { await resetPoolForTesting(); });

const found = async (term: string) => (await searchPatients(term, 20)).map((row) => row.id);

describe("(PAT-1) smart patient search", () => {
  it("finds names regardless of hamza, taa marbuta, alef maqsura and diacritics", async () => {
    expect(await found("احمد")).toContain(ids.ahmad);
    expect(await found("فاطمه")).toContain(ids.fatima);
    expect(await found("مصطفي")).toContain(ids.fatima);
    expect(await found("محمد")).toContain(ids.child);
  });

  it("matches words in any order", async () => {
    expect(await found("الشرعبي احمد")).toEqual([ids.ahmad]);
    expect(await found("علي محمد")).toContain(ids.child);
  });

  it("finds phones in any form, the national id, and the guardian's phone and name", async () => {
    expect(await found("0770111222")).toEqual([ids.ahmad]);
    expect(await found("+967 733 444 555")).toEqual([ids.fatima]);
    expect(await found("٧٧١٩٩٩٨٨٨")).toEqual([ids.child]);
    expect(await found("01010123456")).toEqual([ids.child]);
    expect(await found("سعيد")).toEqual([ids.child]);
  });

  it("normalizes the database side exactly like the typed side", async () => {
    const samples = ["أحمد", "إبراهيم آمنة", "مُحَمَّد", "مصطفى", "لؤي", "٧٧٠", "Ahmad"];
    for (const sample of samples) {
      const { rows } = await getPool().query<{ value: string }>(`SELECT ${normalizedSql("$1::text")} AS value`, [sample]);
      expect(rows[0].value).toBe(normalizeSearchText(sample));
    }
  });
});
