import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/**
 * (P2-4 + P2-5) إلغاء الفاتورة وتعديل الرصيد الافتتاحي قراران مسبَّبان — عبر المسارات الحقيقية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'ضوابط المال') RETURNING id`, [`FC-${Date.now()}`]));
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("P2-4 — cancelling an invoice needs a reason and tells where the paid money went", () => {
  it("refuses without a reason, then cancels and reports the paid amount as patient credit", async () => {
    const { rows: [invoice] } = await db.query<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
       VALUES ($1, $2, 20000, 0, 'YER', 't') RETURNING id`, [`FC-INV-${Date.now()}`, patientId]);
    const { rows: [shift] } = await db.query<{ id: number }>(
      `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd, status) VALUES ('fc', 0, 0, 0, 'closed') RETURNING id`);
    await db.query(
      `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate,
                             base_amount_minor, base_currency, method, created_by)
       VALUES ($1, $2, $3, $4, 'payment', 5000, 'YER', 1, 5000, 'YER', 'cash', 't')`,
      [`FC-R-${Date.now()}`, patientId, invoice.id, shift.id]);

    const noReason = await authedMutation(`/api/invoices/${invoice.id}`, h.sessions.admin, "PATCH", JSON.stringify({ status: "cancelled" }));
    expect(noReason.status).toBe(400);
    expect((await noReason.json() as { message: string }).message).toBe("اكتب سبب إلغاء الفاتورة.");

    const cancelled = await authedMutation(`/api/invoices/${invoice.id}`, h.sessions.admin, "PATCH",
      JSON.stringify({ status: "cancelled", reason: "فاتورة مكررة" }));
    expect(cancelled.status).toBe(200);
    const body = await cancelled.json() as { cancellation: { reason: string; paidOnInvoice: { currency: string; netMinor: number }[]; guidance: string } };
    expect(body.cancellation.reason).toBe("فاتورة مكررة");
    expect(body.cancellation.paidOnInvoice).toEqual([{ currency: "YER", netMinor: 5000 }]);
    expect(body.cancellation.guidance).toContain("رصيدًا دائنًا للمريض");

    const { rows: [audit] } = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'invoice.cancel' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [String(invoice.id)]);
    expect(audit.details).toMatchObject({ السبب: "فاتورة مكررة" });
  });
});

describe("P2-5 — an existing opening balance is changed or cleared only with a reason", () => {
  it("first set needs no reason; overwrite and clear do; history keeps every value", async () => {
    const set = (body: Record<string, unknown>) => authedMutation("/api/opening-balances", h.sessions.admin, "POST",
      JSON.stringify({ patientId, asOfDate: "2025-01-01", ...body }));
    expect((await set({ amount: "50000" })).status).toBe(201);
    const overwrite = await set({ amount: "40000" });
    expect(overwrite.status).toBe(400);
    expect((await set({ amount: "40000", reason: "تصحيح" })).status).toBe(201);

    expect((await authedMutation(`/api/opening-balances?patientId=${patientId}`, h.sessions.admin, "DELETE")).status).toBe(400);
    expect((await authedMutation(`/api/opening-balances?patientId=${patientId}&reason=${encodeURIComponent("سُدّد")}`, h.sessions.admin, "DELETE")).status).toBe(200);

    const { rows } = await db.query<{ action: string; before_amount_minor: string | null; after_amount_minor: string | null }>(
      `SELECT action, before_amount_minor::text, after_amount_minor::text FROM patient_opening_balance_history
        WHERE patient_id = $1 ORDER BY id`, [patientId]);
    expect(rows.map((row) => [row.action, row.before_amount_minor, row.after_amount_minor])).toEqual([
      ["set", null, "50000"], ["set", "50000", "40000"], ["clear", "40000", null],
    ]);
  });
});
