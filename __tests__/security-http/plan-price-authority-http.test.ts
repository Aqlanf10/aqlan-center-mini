import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (FIN-5) سلطة السعر على **بنود الخطة اليدوية** — القاعدة نفسها التي تحكم الزيارة والفاتورة.
 *
 * العيب (تدقيق المالية): الخطة اليدوية (V2) كانت تأخذ سعر البند من الطلب كما هو. والجلسة
 * المرتبطة ببند خطة تُفوتَر بسعر الخطة لا بسعر الدليل — فتاجٌ سعره في الدليل ١٥٬٠٠٠ يُكتب
 * في الخطة بريال فتصدر فاتورته بريال، متجاوزًا حدّ الخصم (`billing.max_discount_percent`)
 * الذي يُفرض على الزيارة والفاتورة اليدوية. وكذلك إضافة بندٍ لخطةٍ بعملة اتفاق (سعرها يُكتب).
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let crownId = 0;
let unpricedId = 0;
let unpricedInUsd = 0;
const stamp = Date.now();

async function setMaxDiscount(value: string) {
  const current = await (await authedGet("/api/settings", h.sessions.admin)).json() as { __versions?: Record<string, unknown> };
  const response = await authedMutation("/api/settings", h.sessions.admin, "PATCH", JSON.stringify({
    "billing.max_discount_percent": value,
    __versions: { "billing.max_discount_percent": current.__versions?.["billing.max_discount_percent"] ?? null },
    __reason: "اختبار سلطة سعر الخطة",
  }));
  expect(response.status).toBe(200);
}

const createPlan = (session: "admin" | "reception", items: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  authedMutation("/api/plans", h.sessions[session], "POST", JSON.stringify({
    mode: "v2", patientId: h.seeded.patientAId, title: `خطة سعر ${stamp}`, billingMode: "per_procedure", items, ...extra,
  }));

const crown = (unitPriceMinor: number, more: Record<string, unknown> = {}) => ({
  serviceId: crownId, serviceName: "تاج", quantity: 1, unitPriceMinor, billingRule: "on_start", sessionCount: 2, ...more,
});

async function storedItems(planId: number) {
  const { rows } = await db.query<{ service_name: string; unit_price_minor: string }>(
    `SELECT service_name, unit_price_minor::text FROM plan_items WHERE plan_id = $1 ORDER BY id`, [planId]);
  return rows.map((row) => ({ name: row.service_name, price: Number(row.unit_price_minor) }));
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  await setMaxDiscount("10");
  ({ rows: [{ id: crownId }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, price_configured, is_active)
     VALUES ($1, 'crown', 15000, TRUE, TRUE) RETURNING id`, [`تاج سلطة الخطة ${stamp}`]));
  ({ rows: [{ id: unpricedInUsd }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, price_configured, is_active)
     VALUES ($1, 'filling', 20000, TRUE, TRUE) RETURNING id`, [`حشوة بلا سعر دولاري ${stamp}`]));
  ({ rows: [{ id: unpricedId }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, price_configured, is_active)
     VALUES ($1, 'other', 0, FALSE, TRUE) RETURNING id`, [`خدمة بلا سعر للخطة ${stamp}`]));
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("(FIN-5) manual plan item prices follow the catalog and the discount limit", () => {
  it("reception cannot price a 15,000 crown at 1 in a plan — nothing is created", async () => {
    const before = await db.query(`SELECT COUNT(*)::int AS n FROM treatment_plans`);
    const response = await createPlan("reception", [crown(1, { priceReason: "مريض قديم" })]);
    expect(response.status).toBe(400);
    expect((await response.json() as { message: string }).message)
      .toContain("يتجاوز الحد المسموح (10٪) — يحتاج موافقة المدير");
    const after = await db.query(`SELECT COUNT(*)::int AS n FROM treatment_plans`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("a discount within the limit needs a written reason, then passes and is audited", async () => {
    const noReason = await createPlan("reception", [crown(13500)]);
    expect(noReason.status).toBe(400);
    expect((await noReason.json() as { message: string }).message).toContain("اكتب سبب الخصم");

    const response = await createPlan("reception", [crown(13500, { priceReason: "خصم عائلة" })]);
    expect(response.status).toBe(201);
    const { id: planId } = await response.json() as { id: number };
    expect(await storedItems(planId)).toEqual([{ name: `تاج سلطة الخطة ${stamp}`, price: 13500 }]);
    const { rows: [audit] } = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'plan.create_v2' AND entity_id = $1`, [String(planId)]);
    expect(String(audit.details["أسعار_معدلة"])).toContain("15000 ← 13500 (خصم عائلة)");
  });

  it("raising above the catalog is for the admin only, with a reason", async () => {
    const reception = await createPlan("reception", [crown(20000, { priceReason: "حالة معقدة" })]);
    expect(reception.status).toBe(400);
    expect((await reception.json() as { message: string }).message).toContain("رفع السعر للمدير وحده");
    const admin = await createPlan("admin", [crown(20000, { priceReason: "حالة معقدة" })]);
    expect(admin.status).toBe(201);
  });

  it("the catalog price itself passes silently; the service name comes from the catalog, not the request", async () => {
    const response = await createPlan("reception", [crown(15000, { serviceName: "اسم مزيف" })]);
    expect(response.status).toBe(201);
    const { id: planId } = await response.json() as { id: number };
    expect(await storedItems(planId)).toEqual([{ name: `تاج سلطة الخطة ${stamp}`, price: 15000 }]);
  });

  it("an item must be a catalog service; an unpriced service keeps its typed price", async () => {
    const unknown = await createPlan("reception", [{ serviceId: 99999999, serviceName: "وهمي", quantity: 1, unitPriceMinor: 1 }]);
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as { message: string }).message).toBe("اختر خدمة كل بند من الدليل.");
    const free = await createPlan("reception", [{ serviceName: "بند حر", quantity: 1, unitPriceMinor: 1 }]);
    expect(free.status).toBe(400);

    const unpriced = await createPlan("reception", [{ serviceId: unpricedId, serviceName: "x", quantity: 1, unitPriceMinor: 7000 }]);
    expect(unpriced.status).toBe(201);
  });

  it("adding an item to a foreign-currency plan follows the same rule on its typed price", async () => {
    const created = await authedMutation("/api/plans", h.sessions.admin, "POST", JSON.stringify({
      mode: "v2", patientId: h.seeded.patientAId, title: `خطة دولار ${stamp}`, billingMode: "installments", currency: "USD",
      installments: [{ dueDate: "2026-12-01", amountMinor: 10000 }],
    }));
    expect(created.status).toBe(201);
    const { id: planId } = await created.json() as { id: number };
    await db.query(`UPDATE services SET price_usd_minor = 10000 WHERE id = $1`, [crownId]);

    const noReason = await authedMutation(`/api/plans/${planId}/items`, h.sessions.reception, "POST",
      JSON.stringify({ serviceId: crownId, quantity: 1, price: "1" }));
    expect(noReason.status).toBe(400);
    expect((await noReason.json() as { message: string }).message).toContain("اكتب سبب الخصم");
    const tooLow = await authedMutation(`/api/plans/${planId}/items`, h.sessions.reception, "POST",
      JSON.stringify({ serviceId: crownId, quantity: 1, price: "1", priceReason: "مريض قديم" }));
    expect(tooLow.status).toBe(400);
    expect((await tooLow.json() as { message: string }).message).toContain("يحتاج موافقة المدير");

    /* قرار المالك (TD-05): خدمةٌ بلا سعرٍ مقرَّر بالدولار — سعر الاتفاق يُكتب ولا يُقاس
       على سعرٍ محوَّل من اليمني؛ يُقبل ويُعلَّم في التدقيق. */
    const agreed = await authedMutation(`/api/plans/${planId}/items`, h.sessions.reception, "POST",
      JSON.stringify({ serviceId: unpricedInUsd, quantity: 1, price: "1" }));
    expect(agreed.status).toBe(201);

    const ok = await authedMutation(`/api/plans/${planId}/items`, h.sessions.reception, "POST",
      JSON.stringify({ serviceId: crownId, quantity: 1, price: "95", priceReason: "خصم متفق" }));
    expect(ok.status).toBe(201);
    const { rows: [audit] } = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'plan.price_override' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [String(planId)]);
    expect(String(audit.details["أسعار_معدلة"])).toContain("10000 ← 9500 (خصم متفق)");
  });
});
