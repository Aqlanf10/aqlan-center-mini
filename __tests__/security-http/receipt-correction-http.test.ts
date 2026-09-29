import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/** (RC-1) تصحيح سند القبض عبر المسار الحقيقي: للمدير وحده، بسببٍ مكتوب، ورسائل عربية، وتدقيق. */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let invoiceId = 0;
let shiftId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'تصحيح سند عبر HTTP') RETURNING id`, [`RCH-${Date.now()}`]));
  ({ rows: [{ id: invoiceId }] } = await db.query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
     VALUES ($1, $2, 100000, 0, 'YER', 't') RETURNING id`, [`RCH-INV-${Date.now()}`, patientId]));
  await db.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'rc-http', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
  ({ rows: [{ id: shiftId }] } = await db.query<{ id: number }>(
    `SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1`));
}, 120_000);
afterAll(async () => { await db?.end(); });

async function receipt(amountMinor: number): Promise<number> {
  const { rows: [row] } = await db.query<{ id: number }>(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate,
                           base_amount_minor, base_currency, method, created_by)
     VALUES ($1, $2, $3, $4, 'payment', $5, 'YER', 1, $5, 'YER', 'cash', 'reception1') RETURNING id`,
    [`RCH-R-${Date.now()}-${amountMinor}`, patientId, invoiceId, shiftId, amountMinor]);
  return row.id;
}

const message = async (response: Response) => (await response.json() as { message: string }).message;

describe("POST /api/payments/[id]/correct", () => {
  it("only the admin corrects; a reason is required; the correction reverses and reissues, is audited, and cannot run twice", async () => {
    const paymentId = await receipt(50_000);
    const path = `/api/payments/${paymentId}/correct`;
    const body = (reason: string, amount = "5000") => JSON.stringify({ mode: "correct", reason, amount, currency: "YER", method: "cash", invoiceId });

    for (const role of ["reception", "cashier", "accountant", "doctorA"] as const) {
      const refused = await authedMutation(path, h.sessions[role], "POST", body("مبلغ خطأ"));
      expect(refused.status).toBe(403);
      expect(await message(refused)).toBe("تصحيح سند القبض أو ردّه يتطلب صلاحية المدير.");
    }

    const noReason = await authedMutation(path, h.sessions.admin, "POST", body(" "));
    expect(noReason.status).toBe(400);
    expect(await message(noReason)).toBe("اكتب سبب التصحيح (٣ أحرف على الأقل).");

    const zero = await authedMutation(path, h.sessions.admin, "POST", body("مبلغ خطأ", "0"));
    expect(zero.status).toBe(400);
    expect(await message(zero)).toBe("اكتب مبلغ السند الصحيح أكبر من صفر.");

    const ok = await authedMutation(path, h.sessions.admin, "POST", body("كُتب 50,000 والمقبوض 5,000"),
      { "Idempotency-Key": `rc-http-${Date.now()}` });
    expect(ok.status).toBe(201);
    const payload = await ok.json() as {
      reversal: { kind: string; amountMinor: number }; replacement: { kind: string; amountMinor: number; invoiceId: number };
    };
    expect(payload.reversal).toMatchObject({ kind: "refund", amountMinor: 50_000 });
    expect(payload.replacement).toMatchObject({ kind: "payment", amountMinor: 5_000, invoiceId });

    const { rows: audit } = await db.query<{ actor: string; details: Record<string, unknown> }>(
      `SELECT actor, details FROM audit_log WHERE action = 'payment.correct' AND entity_id = $1`, [paymentId]);
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ السبب: "كُتب 50,000 والمقبوض 5,000", المبلغ_المعكوس: 50_000, المبلغ_الصحيح: 5_000 });

    const again = await authedMutation(path, h.sessions.admin, "POST", body("مرة ثانية"));
    expect(again.status).toBe(409);
    expect(await message(again)).toBe("هذا السند معكوسٌ بالكامل سلفًا — لا شيء يُصحَّح فيه.");
  });

  it("void mode reverses alone; a refund row and an unknown receipt are refused in Arabic", async () => {
    const paymentId = await receipt(7_000);
    const voided = await authedMutation(`/api/payments/${paymentId}/correct`, h.sessions.admin, "POST",
      JSON.stringify({ mode: "void", reason: "لم يُقبض شيء" }));
    expect(voided.status).toBe(201);
    const payload = await voided.json() as { reversal: { id: number; amountMinor: number }; replacement: unknown };
    expect(payload.reversal.amountMinor).toBe(7_000);
    expect(payload.replacement).toBeNull();

    const refundRow = await authedMutation(`/api/payments/${payload.reversal.id}/correct`, h.sessions.admin, "POST",
      JSON.stringify({ mode: "void", reason: "سبب" }));
    expect(refundRow.status).toBe(409);
    expect(await message(refundRow)).toBe("هذا سند ردّ — يُصحَّح سند القبض الأصلي لا ردُّه.");

    const missing = await authedMutation(`/api/payments/99999999/correct`, h.sessions.admin, "POST",
      JSON.stringify({ mode: "void", reason: "سبب" }));
    expect(missing.status).toBe(404);
    expect(await message(missing)).toBe("السند غير موجود.");
  });

  it("the ledger tells the admin what is left to correct on each receipt — and tells nobody else", async () => {
    const paymentId = await receipt(3_000);
    const admin = await authedGet(`/api/patients/${patientId}/ledger`, h.sessions.admin);
    expect(admin.status).toBe(200);
    const adminLedger = await admin.json() as { receiptRemaining?: Record<string, number> };
    expect(adminLedger.receiptRemaining?.[paymentId]).toBe(3_000);

    const reception = await authedGet(`/api/patients/${patientId}/ledger`, h.sessions.reception);
    expect(reception.status).toBe(200);
    expect((await reception.json() as { receiptRemaining?: unknown }).receiptRemaining).toBeUndefined();
  });
});
