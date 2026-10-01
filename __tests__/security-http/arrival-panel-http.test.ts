import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, harness } from "./_server";

/**
 * (P0-D) لوحة الوصول على التطبيق المبني: الاستقبال والكاشير يرون المال بكل عملة، والطبيب على مرضاه
 * فقط وبلا مال دون صلاحية «مدفوعات مرضاي»، والمحاسب خارجها — وكل رفضٍ بالعربية. قراءةٌ فقط.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let ownedId = 0;
let otherId = 0;
const stamp = Date.now();

type Who = "admin" | "reception" | "doctorA" | "doctorB" | "cashier" | "accountant";
const get = (who: Who, id: number) => authedGet(`/api/patients/${id}/arrival-panel`, h.sessions[who]);

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  const insert = async (suffix: string, primary: number | null) => (await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`ARRH-${suffix}-${stamp}`, `وصول ${suffix}`, primary])).rows[0].id;
  ownedId = await insert("A", doctor.party_id);
  otherId = await insert("B", null);
  await db.query(`INSERT INTO patient_opening_balances (patient_id, currency, amount_minor, as_of_date, created_by)
                  VALUES ($1, 'YER', 90000, CURRENT_DATE, 'm'), ($1, 'SAR', 3000, CURRENT_DATE, 'm')`, [ownedId]);
}, 120_000);

afterAll(async () => { await db?.end(); });

describe("(P0-D) arrival panel access", () => {
  it("reception and cashier see the money per currency", async () => {
    for (const who of ["reception", "cashier", "admin"] as const) {
      const response = await get(who, ownedId);
      expect(response.status).toBe(200);
      const body = await response.json() as { money: { lines: { currency: string; openingRemainingMinor: number }[] } | null };
      expect(body.money?.lines.map((line) => [line.currency, line.openingRemainingMinor])).toEqual([["YER", 90000], ["SAR", 3000]]);
    }
  });

  it("a doctor sees only own patients, and no money without the payments permission", async () => {
    const own = await get("doctorA", ownedId);
    expect(own.status).toBe(200);
    expect((await own.json() as { money: unknown }).money).toBeNull();
    const other = await get("doctorA", otherId);
    expect(other.status).toBe(403);
    expect(((await other.json()) as { message: string }).message).toMatch(/[؀-ۿ]/);
  });

  it("the accountant does not reach the arrival panel; bad ids are refused in Arabic", async () => {
    expect([401, 403]).toContain((await get("accountant", ownedId)).status);
    const bad = await authedGet(`/api/patients/abc/arrival-panel`, h.sessions.reception);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toMatch(/[؀-ۿ]/);
  });
});
