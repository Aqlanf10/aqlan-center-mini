import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (P1-5b) Opening balances in their own currency, through the real routes: the admin
 * records a SAR opening, the ledger shows it in the SAR bucket, and reception collects
 * it in SAR against the opening — the YER bucket is never touched.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  await db.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'ob-http', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('finance.rate.USD', '530'), ('finance.rate.SAR', '140')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'رصيد سعودي قديم') RETURNING id`, [`OBH-${Date.now()}`]));
}, 120_000);
afterAll(async () => { await db?.end(); });

type Ledger = { openings: { currency: string; amountMinor: number }[]; balances: Record<string, { dueMinor: number; openingMinor: number }> };
const ledger = async () => (await (await authedGet(`/api/patients/${patientId}/ledger`, h.sessions.admin)).json()) as Ledger;

describe("P1-5b — an old balance stays in its currency", () => {
  it("records a SAR opening next to a YER one; the ledger keeps them in separate buckets", async () => {
    const sar = await authedMutation("/api/opening-balances", h.sessions.admin, "POST",
      JSON.stringify({ patientId, currency: "SAR", amount: "793", asOfDate: "2026-09-01", note: "تقويم — النظام القديم" }));
    expect(sar.status).toBe(201);
    expect((await sar.json() as { currency: string; amountMinor: number })).toMatchObject({ currency: "SAR", amountMinor: 79300 });
    expect((await authedMutation("/api/opening-balances", h.sessions.admin, "POST",
      JSON.stringify({ patientId, amount: "50000", asOfDate: "2026-09-01" }))).status).toBe(201);
    expect((await authedMutation("/api/opening-balances", h.sessions.admin, "POST",
      JSON.stringify({ patientId, currency: "EUR", amount: "5" }))).status).toBe(400);

    const book = await ledger();
    expect(book.openings.map((row) => row.currency)).toEqual(["SAR", "YER"]);
    expect(book.balances.SAR).toMatchObject({ openingMinor: 79300, dueMinor: 79300 });
    expect(book.balances.YER).toMatchObject({ openingMinor: 50000, dueMinor: 50000 });
  });

  it("reception collects the SAR opening in SAR; a USD payment against it is refused in Arabic", async () => {
    const paid = await authedMutation("/api/payments", h.sessions.reception, "POST",
      JSON.stringify({ patientId, amount: "300", currency: "SAR", openingCurrency: "SAR", method: "cash" }));
    expect(paid.status).toBe(201);
    const book = await ledger();
    expect(book.balances.SAR.dueMinor).toBe(49300);
    expect(book.balances.YER.dueMinor).toBe(50000);

    const wrong = await authedMutation("/api/payments", h.sessions.reception, "POST",
      JSON.stringify({ patientId, amount: "10", currency: "USD", openingCurrency: "SAR", method: "cash" }));
    expect(wrong.status).toBe(409);
    expect((await wrong.json() as { message: string }).message).toMatch(/[؀-ۿ]/);

    const none = await authedMutation("/api/payments", h.sessions.reception, "POST",
      JSON.stringify({ patientId, amount: "10", currency: "USD", openingCurrency: "USD", method: "cash" }));
    expect(none.status).toBe(409);
    expect((await none.json() as { message: string }).message).toBe("لا يوجد على المريض رصيد سابق بهذه العملة.");
  });

  it("clears one currency by name and keeps the other", async () => {
    const cleared = await authedMutation(`/api/opening-balances?patientId=${patientId}&currency=YER&reason=${encodeURIComponent("تصحيح")}`,
      h.sessions.admin, "DELETE");
    expect(cleared.status).toBe(200);
    expect((await ledger()).openings.map((row) => row.currency)).toEqual(["SAR"]);
  });
});
