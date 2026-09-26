import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (PAT-1) قائمة المرضى كما في الأنظمة الرائدة، على PostgreSQL 18: المرشّحات على **كل** المرضى
 * لا على الصفحة المحمّلة (كان «تنبيه طبي» يرشّح الـ٢٥ المعروضين فقط)، والأعمدة التي يُسأل
 * عنها: آخر زيارة، الموعد القادم، الرصيد بكل عملة، التقويم النشط، العمر — والترتيب.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { getPool, resetPoolForTesting, ensureSchema, browsePatients, setPatientOpeningBalance } = await import("../../lib/db");

const ids: Record<string, number> = {};
const TODAY = "2026-09-26";

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  const add = async (key: string, name: string, extra: Record<string, unknown> = {}) => {
    const columns = ["patient_number", "full_name", ...Object.keys(extra)];
    const values = [`PB-${key}`, name, ...Object.values(extra)];
    ids[key] = (await pool.query<{ id: number }>(
      `INSERT INTO patients (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, values)).rows[0].id;
  };
  // ٣٠ مريضًا عاديًّا يملؤون الصفحة الأولى — والمميَّزون بعدهم في الترتيب الافتراضي.
  for (let i = 0; i < 30; i += 1) await add(`n${i}`, `مريض عادي ${i}`, { phone: `96777000${String(i).padStart(4, "0")}`, created_at: "2026-09-20" });
  await add("alert", "صاحب تنبيه", { phone: "967771111111", medical_alert: "حساسية بنسلين", created_at: "2025-01-01", birth_year: 1990 });
  await add("nophone", "بلا جوال", { created_at: "2025-01-02" });
  await add("debtor", "مدين قديم", { phone: "967772222222", created_at: "2025-01-03" });
  await add("booked", "له موعد", { phone: "967773333333", created_at: "2025-01-04" });
  await setPatientOpeningBalance({ patientId: ids.debtor, currency: "SAR", amountMinor: 30000, asOfDate: "2026-01-01", note: null, createdBy: "t" });
  await pool.query(`INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, status) VALUES ($1, '2026-10-02', '10:30', 'booked')`, [ids.booked]);
  await pool.query(`INSERT INTO visits (patient_name, patient_id, status, arrived_at) VALUES ('له موعد', $1, 'done', '2026-09-01 09:00+03')`, [ids.booked]);
}, 120_000);
afterAll(async () => { await resetPoolForTesting(); });

const browse = (filter: string, sort = "recent", offset = 0) =>
  browsePatients({ offset, limit: 25, filter: filter as never, sort: sort as never, doctorPartyId: null, today: TODAY });

describe("(PAT-1) patient list filters over all patients", () => {
  it("medical-alert and no-phone filters reach patients beyond the first page", async () => {
    const alert = await browse("alert");
    expect(alert.total).toBe(1);
    expect(alert.rows.map((row) => row.id)).toEqual([ids.alert]);
    expect(alert.rows[0]).toMatchObject({ age: 36, medicalAlert: "حساسية بنسلين" });
    expect((await browse("no_phone")).rows.map((row) => row.id)).toEqual([ids.nophone]);
  });

  it("debt filter uses the canonical per-currency balance", async () => {
    const debt = await browse("debt");
    expect(debt.rows.map((row) => row.id)).toEqual([ids.debtor]);
    expect(debt.rows[0].balances).toEqual([{ currency: "SAR", dueMinor: 30000 }]);
  });

  it("shows last visit and the next booked appointment; no-next excludes the booked patient", async () => {
    const all = await browse("all", "name", 0);
    expect(all.total).toBe(34);
    const booked = (await browse("all", "last_visit")).rows[0];
    expect(booked.id).toBe(ids.booked);
    expect(booked.nextAppointment).toEqual({ date: "2026-10-02", time: "10:30" });
    expect(booked.lastVisitAt).not.toBeNull();
    const noNext = await browse("no_next");
    expect(noNext.total).toBe(33);
    expect(noNext.rows.some((row) => row.id === ids.booked)).toBe(false);
  });

  it("new this month counts patients registered since the first of the month", async () => {
    expect((await browse("new_month")).total).toBe(30);
  });
});
