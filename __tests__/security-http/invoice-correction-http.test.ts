import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/** (FIN-2) تصحيح الفاتورة عبر المسار الحقيقي: للمدير وحده، بسببٍ مكتوب، ورسائل عربية. */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'تصحيح عبر HTTP') RETURNING id`, [`FIN2H-${Date.now()}`]));
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("POST /api/invoices/[id]/correct", () => {
  it("reception is refused; the admin needs a reason; a valid correction reissues the invoice", async () => {
    const { rows: [invoice] } = await db.query<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
       VALUES ($1, $2, 50000, 0, 'YER', 't') RETURNING id`, [`FIN2H-INV-${Date.now()}`, patientId]);
    const { rows: [item] } = await db.query<{ id: number }>(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
       VALUES ($1, 'حشوة', 1, 50000, 50000) RETURNING id`, [invoice.id]);
    const body = (reason: string, price: string) => JSON.stringify({ reason, lines: [{ itemId: item.id, quantity: 1, unitPrice: price }] });
    const path = `/api/invoices/${invoice.id}/correct`;

    const reception = await authedMutation(path, h.sessions.reception, "POST", body("سعر خاطئ", "30000"));
    expect(reception.status).toBe(403);
    expect((await reception.json() as { message: string }).message).toBe("تصحيح الفاتورة للمدير وحده.");

    const noReason = await authedMutation(path, h.sessions.admin, "POST", body("", "30000"));
    expect(noReason.status).toBe(400);
    expect((await noReason.json() as { message: string }).message).toBe("اكتب سبب التصحيح.");

    const increase = await authedMutation(path, h.sessions.admin, "POST", body("سعر خاطئ", "60000"));
    expect(increase.status).toBe(400);
    expect((await increase.json() as { message: string }).message).toContain("تخفيضٌ فقط");

    const ok = await authedMutation(path, h.sessions.admin, "POST", body("سعر خاطئ", "30000"));
    expect(ok.status).toBe(201);
    const payload = await ok.json() as { original: { status: string }; corrected: { totalMinor: number; invoiceNumber: string } };
    expect(payload.original.status).toBe("cancelled");
    expect(payload.corrected.totalMinor).toBe(30000);

    const again = await authedMutation(path, h.sessions.admin, "POST", body("سعر خاطئ", "20000"));
    expect(again.status).toBe(409);
    expect((await again.json() as { message: string }).message).toBe("الفاتورة ملغاة — لا تُصحَّح.");
  });
});
