import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, grantReceptionCollection, harness } from "./_server";

/**
 * تسجيل الدَّين السابق يتبع إعداد الرصيد الافتتاحي. التحصيل وقراءة الكشف يتطلبان تخويل المريض.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let priorOpeningSetting: string | null = null;
const openingSetting = "finance.reception_adds_opening_balance";
const arabic = /[؀-ۿ]/;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const setting = await db.query<{ value: string }>("SELECT value FROM settings WHERE key=$1", [openingSetting]);
  priorOpeningSetting = setting.rows[0]?.value ?? null;
  await db.query("INSERT INTO settings(key,value) VALUES ($1,'true') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [openingSetting]);
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض قديم عليه مبلغ') RETURNING id`, [`D1H-${Date.now()}`]));
}, 120_000);
afterAll(async () => {
  if (!db) return;
  if (priorOpeningSetting === null) await db.query("DELETE FROM settings WHERE key=$1", [openingSetting]);
  else await db.query("UPDATE settings SET value=$2 WHERE key=$1", [openingSetting, priorOpeningSetting]);
  await db.end();
});

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

    expect((await authedGet(`/api/patients/${patientId}/ledger`, h.sessions.reception)).status).toBe(403);
    await grantReceptionCollection(h, patientId);
    const ledger = await (await authedGet(`/api/patients/${patientId}/ledger`, h.sessions.reception)).json() as {
      openings: { currency: string; dueMinor: number }[];
    };
    expect(ledger).not.toHaveProperty("openingAccess");
    expect(Object.fromEntries(ledger.openings.map((row) => [row.currency, row.dueMinor]))).toEqual({ YER: 100000, SAR: 20000 });
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

  it("admin registers a returning patient and the previous balance in one step", async () => {
    const name = `مريض سابق ${Date.now()}`;
    const created = await authedMutation("/api/patients", h.sessions.admin, "POST",
      JSON.stringify({ fullName: name, gender: "male", confirmDuplicate: true,
        openingBalance: { amount: "75000", currency: "YER", note: "تقويم 2024" } }));
    expect(created.status).toBe(201);
    const patient = await created.json() as { id: number; warning?: string };
    expect(patient.warning).toBeUndefined();
    const { rows } = await db.query<{ amount_minor: string; currency: string; created_by: string }>(
      `SELECT amount_minor::text, currency, created_by FROM patient_opening_balances WHERE patient_id = $1`, [patient.id]);
    expect(rows).toEqual([{ amount_minor: "75000", currency: "YER", created_by: "secadmin" }]);
  });

  it("records previous debt during unassigned registration while denying collection", async () => {
    const fullName = `مريض جديد بلا تفويض ${Date.now()}`;
    const opening = { amount: "75000", currency: "YER", note: "رصيد سابق اصطناعي" };
    const registration = await authedMutation("/api/patients", h.sessions.reception, "POST", JSON.stringify({
      fullName, gender: "male", confirmDuplicate: true, openingBalance: opening,
    }));
    expect(registration.status).toBe(201);
    const patient = await registration.json() as { id: number; warning?: string };
    expect(patient.warning).toBeUndefined();
    expect((await db.query("SELECT id FROM patients WHERE full_name=$1", [fullName])).rows).toEqual([{ id: patient.id }]);
    expect((await authedGet(`/api/patients/${patient.id}/ledger`, h.sessions.reception)).status).toBe(403);
    const balances = () => db.query("SELECT amount_minor::text, currency, created_by FROM patient_opening_balances WHERE patient_id=$1", [patient.id]);
    expect((await db.query("SELECT action FROM patient_opening_balance_history WHERE patient_id=$1", [patient.id])).rows)
      .toEqual([{ action: "set" }]);
    const audit = () => db.query("SELECT action FROM audit_log WHERE entity='patient' AND entity_id=$1 AND action IN ('patient.create','opening_balance.set') ORDER BY id", [String(patient.id)]);
    const collect = await authedMutation("/api/payments", h.sessions.reception, "POST", JSON.stringify({
      patientId: patient.id, currency: "YER", amount: "100", openingCurrency: "YER", method: "cash",
    }), { "Idempotency-Key": `fixture-opening-unassigned-${patient.id}` });
    expect(collect.status).toBe(403);
    expect((await db.query("SELECT id FROM payments WHERE patient_id=$1", [patient.id])).rows).toEqual([]);
    expect((await balances()).rows).toEqual([{ amount_minor: "75000", currency: "YER", created_by: "secreception" }]);
    expect((await audit()).rows).toEqual([{ action: "patient.create" }, { action: "opening_balance.set" }]);
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
