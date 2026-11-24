import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (FIN-4) الفاتورة اليدوية تحت حدّ الخصم نفسه الذي يحكم الزيارة.
 *
 * كان الاستقبال يصدر من «فاتورة جديدة» خصمًا بأي قدر — حتى ١٠٠٪ — بلا سبب، ويكتب سعر خدمة
 * الدليل أقل بلا سبب ولا حد، متجاوزًا `billing.max_discount_percent` (الافتراضي ٠٪).
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let serviceId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'حد الخصم') RETURNING id`, [`FIN4-${Date.now()}`]));
  ({ rows: [{ id: serviceId }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured) VALUES ($1, 20000, TRUE, TRUE) RETURNING id`,
    [`تبييض FIN4 ${Date.now()}`]));
  await setMaxDiscount("10");
}, 120_000);
afterAll(async () => {
  await setMaxDiscount("0");
  await db?.end();
});

/* عبر مسار الإعدادات نفسه (كاختبار سلطة السعر) — فيُفرَّغ مخزن الإعدادات في الخادم. */
async function setMaxDiscount(value: string) {
  const current = await (await authedGet("/api/settings", h.sessions.admin)).json() as { __versions?: Record<string, unknown> };
  const response = await authedMutation("/api/settings", h.sessions.admin, "PATCH", JSON.stringify({
    "billing.max_discount_percent": value,
    __versions: { "billing.max_discount_percent": current.__versions?.["billing.max_discount_percent"] ?? null },
    __reason: "اختبار حد خصم الفاتورة اليدوية",
  }));
  expect(response.status).toBe(200);
}

const create = (session: typeof h.sessions.admin, body: Record<string, unknown>) =>
  authedMutation("/api/invoices", session, "POST", JSON.stringify({ patientId, currency: "YER", ...body }));
const message = async (response: Response) => ((await response.json()) as { message: string }).message;

describe("(FIN-4) manual invoice discounts follow billing.max_discount_percent", () => {
  it("refuses a reception invoice at the original price and at either discount level", async () => {
    const before = (await db.query("SELECT count(*) AS n FROM invoices WHERE patient_id=$1", [patientId])).rows;
    for (const discount of ["0", "2000", "5000"]) {
      const response = await create(h.sessions.reception, { items: [{ serviceId }], discount, discountReason: "اختبار صلاحية" });
      expect(response.status).toBe(403);
    }
    expect((await db.query("SELECT count(*) AS n FROM invoices WHERE patient_id=$1", [patientId])).rows).toEqual(before);
  });

  it("an administrator must explain a lower catalogue price and can save a documented discount", async () => {
    const lower = (priceReason?: string) => create(h.sessions.admin, { items: [{ serviceId, price: "18000", priceReason }] });
    const denied = await lower();
    expect(denied.status).toBe(400);
    expect(await message(denied)).toContain("سبب");
    expect((await lower("خصم عائلة")).status).toBe(201);
  });

  it("the admin may exceed the limit, with a reason — recorded in the invoice audit", async () => {
    const noReason = await create(h.sessions.admin, { items: [{ serviceId }], discount: "20000" });
    expect(noReason.status).toBe(400);
    const ok = await create(h.sessions.admin, { items: [{ serviceId }], discount: "20000", discountReason: "حالة إنسانية" });
    expect(ok.status).toBe(201);
    const invoice = await ok.json() as { id: number; discountMinor: number };
    expect(invoice.discountMinor).toBe(20000);
    const { rows: [audit] } = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'invoice.create' AND entity_id = $1`, [String(invoice.id)]);
    expect(audit.details).toMatchObject({ سبب_الخصم: "حالة إنسانية", نسبة_الخصم: 100 });
  });

  it("catalog price with no discount, and a free-text line at any price", async () => {
    expect((await create(h.sessions.admin, { items: [{ serviceId }] })).status).toBe(201);
    expect((await create(h.sessions.admin, { items: [{ description: "بند يدوي", price: "3500" }] })).status).toBe(201);
  });
});
