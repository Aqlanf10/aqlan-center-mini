import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (PAT-1) البحث عن المريض على PostgreSQL 18 كما تكتبه موظفة الاستقبال فعلًا:
 * بلا همزة، بالهاء بدل التاء المربوطة، بالكلمات بأي ترتيب، وبرقم الجوال بأي صيغة، وبرقم
 * الهوية وجوال وليّ الأمر. كان «احمد» لا يجد «أحمد» — فيُنشأ ملفٌ مكرر.
 */

// Exercise the real ordinary GET route and PostgreSQL query with an already
// signed-in, fictional reception identity; no live authentication or traffic.
vi.mock("@/lib/session", () => ({
  requireSession: async () => ({ userId: 1, role: "reception", username: "synthetic-desk" }),
}));

assertRealPostgresUrl();
stubPostgresEnv();

const { getPool, resetPoolForTesting, ensureSchema, searchPatients, duplicateCandidates } = await import("../../lib/db");
const { normalizeSearchText, normalizedSql } = await import("../../lib/patient-search");
const { GET: receptionistSearch } = await import("../../app/api/patients/route");

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
  // Stage allocates P- with five digits minimum, not maximum. Match both a
  // supported five-digit ID and a supported six-digit partial result.
  await add("rankExact", "INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id",
    ["P-12345", "SYNTHETIC FRONT DESK ZULU"]);
  await add("rankLonger", "INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id",
    ["P-123456", "SYNTHETIC FRONT DESK ALPHA"]);
  await add("rankPadded", "INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id",
    ["P-07000", "SYNTHETIC FRONT DESK PADDED"]);
}, 120_000);
afterAll(async () => { await resetPoolForTesting(); });

const found = async (term: string) => (await searchPatients(term, 20)).map((row) => row.id);

const receptionFound = async (term: string) => {
  const url = new URL("http://127.0.0.1/api/patients");
  url.searchParams.set("q", term);
  const response = await receptionistSearch(new Request(url));
  expect(response.status).toBe(200);
  const rows = await response.json() as { id: number; patientNumber: string }[];
  return rows.map(({ id, patientNumber }) => ({ id, patientNumber }));
};

describe("(PAT-1) smart patient search", () => {
  it.each(["P-12345", "p-١٢٣٤٥", "P-۱۲۳۴۵"])("ranks the exact file first for ordinary reception search %s", async term => {
    expect(await receptionFound(term)).toEqual([
      { id: ids.rankExact, patientNumber: "P-12345" }, { id: ids.rankLonger, patientNumber: "P-123456" },
    ]);
  });

  it("preserves zero padding and keeps partial terms ambiguous", async () => {
    for (const term of ["P-07000", "p-٠٧٠٠٠", "P-۰۷۰۰۰"]) {
      expect(await receptionFound(term)).toEqual([{ id: ids.rankPadded, patientNumber: "P-07000" }]);
    }
    for (const term of ["P-1234", "۱۲۳۴۵"]) {
      expect(await receptionFound(term)).toEqual([
        { id: ids.rankLonger, patientNumber: "P-123456" }, { id: ids.rankExact, patientNumber: "P-12345" },
      ]);
    }
  });

  it("leaves unopted internal lookups in their existing order", async () => {
    expect(await found("p-١٢٣٤٥")).toEqual([ids.rankLonger, ids.rankExact]);
  });

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

  it("warns about a duplicate typed without hamza or with ه for ة (candidates are fetched normalized)", async () => {
    const candidates = await duplicateCandidates({ fullName: "احمد عبدالله الشرعبي", phone: null, altPhone: null });
    expect(candidates.map((row) => row.id)).toContain(ids.ahmad);
    const fatima = await duplicateCandidates({ fullName: "فاطمه مصطفي", phone: null, altPhone: null });
    expect(fatima.map((row) => row.id)).toContain(ids.fatima);
  });
});
