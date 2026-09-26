import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (DAY1 — قرار المالك) الرصيد السابق للمرضى القدامى عبر المسارات الحقيقية: الاستقبال يضيف
 * (من الملف أو عند التسجيل) ولا يعدّل، والمدير يعدّل، والطبيب لا يسجّل رصيدًا ولا يولد ملفٌ
 * ناقص حين يُرفض رصيده.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
const arabic = /[؀-ۿ]/;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض قديم عليه مبلغ') RETURNING id`, [`D1H-${Date.now()}`]));
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("(DAY1) previous balance — reception adds, admin edits", () => {
  it("reception adds a balance, cannot replace it, and the admin can", async () => {
    const added = await authedMutation("/api/opening-balances", h.sessions.reception, "POST",
      JSON.stringify({ patientId, amount: "120000", note: "من قبل النظام" }));
    expect(added.status).toBe(201);
    const again = await authedMutation("/api/opening-balances", h.sessions.reception, "POST",
      JSON.stringify({ patientId, amount: "1", reason: "محاولة" }));
    expect(again.status).toBe(403);
    expect((await again.json() as { message: string }).message).toMatch(arabic);
    expect((await authedMutation("/api/opening-balances", h.sessions.reception, "POST",
      JSON.stringify({ patientId, amount: "200", currency: "SAR" }))).status).toBe(201);
    expect((await authedMutation("/api/opening-balances", h.sessions.admin, "POST",
      JSON.stringify({ patientId, amount: "100000", reason: "تصحيح بعد مراجعة الدفتر" }))).status).toBe(201);

    const ledger = await (await authedGet(`/api/patients/${patientId}/ledger`, h.sessions.reception)).json() as {
      openings: { currency: string; amountMinor: number }[]; openingAccess: { add: boolean; edit: boolean };
    };
    expect(ledger.openingAccess).toEqual({ add: true, edit: false });
    expect(Object.fromEntries(ledger.openings.map((row) => [row.currency, row.amountMinor]))).toEqual({ YER: 100000, SAR: 20000 });
    const { rows } = await db.query<{ actor: string }>(
      `SELECT actor FROM patient_opening_balance_history WHERE patient_id = $1 ORDER BY id`, [patientId]);
    expect(rows.map((row) => row.actor)).toEqual(["secreception", "secreception", "secadmin"]);
  });

  it("doctors and the cashier cannot record a previous balance", async () => {
    for (const session of [h.sessions.doctorA, h.sessions.cashier]) {
      const denied = await authedMutation("/api/opening-balances", session, "POST",
        JSON.stringify({ patientId, amount: "5", currency: "USD" }));
      expect(denied.status).toBe(403);
    }
  });

  it("reception registers a returning patient with the old amount in one step", async () => {
    const name = `مريض سابق ${Date.now()}`;
    const created = await authedMutation("/api/patients", h.sessions.reception, "POST",
      JSON.stringify({ fullName: name, gender: "male", confirmDuplicate: true,
        openingBalance: { amount: "75000", currency: "YER", note: "تقويم 2024" } }));
    expect(created.status).toBe(201);
    const patient = await created.json() as { id: number; warning?: string };
    expect(patient.warning).toBeUndefined();
    const { rows } = await db.query<{ amount_minor: string; currency: string; created_by: string }>(
      `SELECT amount_minor::text, currency, created_by FROM patient_opening_balances WHERE patient_id = $1`, [patient.id]);
    expect(rows).toEqual([{ amount_minor: "75000", currency: "YER", created_by: "secreception" }]);
  });

  it("a refused previous balance creates no half patient", async () => {
    const name = `بلا صلاحية ${Date.now()}`;
    const bad = await authedMutation("/api/patients", h.sessions.reception, "POST",
      JSON.stringify({ fullName: name, gender: "male", confirmDuplicate: true, openingBalance: { amount: "-5" } }));
    expect(bad.status).toBe(400);
    const { rows } = await db.query(`SELECT 1 FROM patients WHERE full_name = $1`, [name]);
    expect(rows).toHaveLength(0);
  });
});

describe("(DAY1 review) the registration form follows the reception setting", () => {
  it("tells each user whether they may add or edit a previous balance (the form hides it otherwise)", async () => {
    const access = async (session: typeof h.sessions.admin) =>
      (await (await authedGet("/api/opening-balances/access", session)).json()) as { add: boolean; edit: boolean };
    expect(await access(h.sessions.reception)).toEqual({ add: true, edit: false });
    expect(await access(h.sessions.admin)).toEqual({ add: true, edit: true });
    expect(await access(h.sessions.doctorA)).toEqual({ add: false, edit: false });
  });
});
