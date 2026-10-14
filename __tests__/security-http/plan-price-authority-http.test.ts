import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (FIN-5) سلطة السعر على بنود الخطة المنشأة من الفاتورة، وعلى تعديل الخطط القائمة.
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
let sequence = 0;

async function setMaxDiscount(value: string) {
  const current = await (await authedGet("/api/settings", h.sessions.admin)).json() as { __versions?: Record<string, unknown> };
  const response = await authedMutation("/api/settings", h.sessions.admin, "PATCH", JSON.stringify({
    "billing.max_discount_percent": value,
    __versions: { "billing.max_discount_percent": current.__versions?.["billing.max_discount_percent"] ?? null },
    __reason: "اختبار سلطة سعر الخطة",
  }));
  expect(response.status).toBe(200);
}

async function createTreatment(session: "admin" | "reception", items: Record<string, unknown>[]) {
  // Independent patients keep price-authority failures distinct from duplicate-work refusals.
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض سلطة السعر الاصطناعي') RETURNING id`,
    [`FIN5-${stamp}-${++sequence}`]);
  return authedMutation("/api/invoices", h.sessions[session], "POST", JSON.stringify({
    patientId: patient.id, currency: "YER", items: items.map((item) => ({
      serviceId: item.serviceId, description: item.serviceName, quantity: item.quantity,
      price: String(item.unitPriceMinor), priceReason: item.priceReason, toothCode: 36, sessions: 2,
    })),
  }));
}

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
     VALUES ($1, 'filling', 0, FALSE, TRUE) RETURNING id`, [`خدمة بلا سعر للخطة ${stamp}`]));
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("(FIN-5) invoice-created plan item prices follow the catalog and the discount limit", () => {
  it("reception cannot price a 15,000 crown at 1 in a plan — nothing is created", async () => {
    const before = await db.query(`SELECT COUNT(*)::int AS n FROM treatment_plans`);
    const beforeInvoices = await db.query(`SELECT COUNT(*)::int AS n FROM invoices`);
    const response = await createTreatment("reception", [crown(1, { priceReason: "مريض قديم" })]);
    expect(response.status).toBe(400);
    expect((await response.json() as { message: string }).message)
      .toContain("يتجاوز الحد المسموح (10٪) — يحتاج موافقة المدير");
    const after = await db.query(`SELECT COUNT(*)::int AS n FROM treatment_plans`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM invoices`)).rows[0].n).toBe(beforeInvoices.rows[0].n);
  });

  it("a discount within the limit needs a written reason, then passes and is audited", async () => {
    const noReason = await createTreatment("reception", [crown(13500)]);
    expect(noReason.status).toBe(400);
    expect((await noReason.json() as { message: string }).message).toContain("اكتب سبب الخصم");

    const response = await createTreatment("reception", [crown(13500, { priceReason: "خصم عائلة" })]);
    expect(response.status).toBe(201);
    const { id: invoiceId, clinical: { planId } } = await response.json() as { id: number; clinical: { planId: number } };
    expect(planId).toBeGreaterThan(0);
    expect(await storedItems(planId)).toEqual([{ name: `تاج سلطة الخطة ${stamp}`, price: 13500 }]);
    const { rows: [audit] } = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'invoice.create' AND entity_id = $1`, [String(invoiceId)]);
    expect(String(audit.details["أسعار_معدلة"])).toContain("15000 ← 13500 (خصم عائلة)");
  });

  it("raising above the catalog is for the admin only, with a reason", async () => {
    const reception = await createTreatment("reception", [crown(20000, { priceReason: "حالة معقدة" })]);
    expect(reception.status).toBe(400);
    expect((await reception.json() as { message: string }).message).toContain("رفع السعر للمدير وحده");
    const admin = await createTreatment("admin", [crown(20000, { priceReason: "حالة معقدة" })]);
    expect(admin.status).toBe(201);
    const { clinical: { planId } } = await admin.json() as { clinical: { planId: number } };
    expect(await storedItems(planId)).toEqual([{ name: `تاج سلطة الخطة ${stamp}`, price: 20000 }]);
  });

  it("the catalog price itself passes silently; the service name comes from the catalog, not the request", async () => {
    const response = await createTreatment("reception", [crown(15000, { serviceName: "اسم مزيف" })]);
    expect(response.status).toBe(201);
    const { clinical: { planId } } = await response.json() as { clinical: { planId: number } };
    expect(await storedItems(planId)).toEqual([{ name: `تاج سلطة الخطة ${stamp}`, price: 15000 }]);
  });

  it("rejects an unknown catalogue reference without silently creating a financial fallback", async () => {
    const response = await createTreatment("reception", [{ serviceId: 99999999, serviceName: "بند مالي يدوي", quantity: 1, unitPriceMinor: 1 }]);
    expect(response.status).toBe(400);
    const { rows: [patient] } = await db.query<{ id: number }>("SELECT id FROM patients WHERE patient_number=$1", [`FIN5-${stamp}-${sequence}`]);
    for (const table of ["invoices", "treatment_plans", "clinical_cases", "payments"]) {
      expect((await db.query(`SELECT id FROM ${table} WHERE patient_id=$1`, [patient.id])).rows).toEqual([]);
    }
  });

  it("manual descriptions remain financial-only and cannot invent clinical catalog work", async () => {
    for (const serviceId of [undefined]) {
      const response = await createTreatment("reception", [{ serviceId, serviceName: "بند مالي يدوي", quantity: 1, unitPriceMinor: 1 }]);
      expect(response.status).toBe(201);
      const invoice = await response.json() as { id: number; patientId: number; clinical: { planId: null; links: unknown[] } };
      expect(invoice.clinical).toMatchObject({ planId: null, links: [expect.objectContaining({ kind: "financial", planItemId: null, caseId: null })] });
      const { rows: [row] } = await db.query<{ patient_id: number }>(`SELECT patient_id FROM invoices WHERE id = $1`, [invoice.id]);
      expect((await db.query(`SELECT service_id, description, unit_price_minor::text, plan_item_id
        FROM invoice_items WHERE invoice_id = $1`, [invoice.id])).rows)
        .toEqual([{ service_id: null, description: "بند مالي يدوي", unit_price_minor: "1", plan_item_id: null }]);
      for (const table of ["treatment_plans", "clinical_cases", "payments"]) {
        expect((await db.query(`SELECT id FROM ${table} WHERE patient_id = $1`, [row.patient_id])).rows).toEqual([]);
      }
    }
  });

  it("an unpriced catalog service keeps its typed price on the linked clinical item", async () => {
    const unpriced = await createTreatment("reception", [{ serviceId: unpricedId, serviceName: "x", quantity: 1, unitPriceMinor: 7000 }]);
    expect(unpriced.status).toBe(201);
    const { clinical: { planId } } = await unpriced.json() as { clinical: { planId: number } };
    expect(await storedItems(planId)).toEqual([{ name: `خدمة بلا سعر للخطة ${stamp}`, price: 7000 }]);
  });

  it("adding an item to a foreign-currency plan follows the same rule on its typed price", async () => {
    // Preserve an existing USD installment agreement. This tests its supported edit
    // route, not new-plan creation and not a fabricated invoice for historical data.
    const { rows: [{ id: planId }] } = await db.query<{ id: number }>(
      `INSERT INTO treatment_plans
       (patient_id, title, total_minor, base_currency, billing_mode, total_from_items, start_date, created_by)
       VALUES ($1, $2, 10000, 'USD', 'installments', FALSE, CURRENT_DATE, 'price-existing-fixture') RETURNING id`,
      [h.seeded.patientAId, `خطة دولار ${stamp}`]);
    await db.query(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
      VALUES ($1, 1, '2026-12-01', 10000)`, [planId]);
    await db.query(`UPDATE services SET price_usd_minor = 10000 WHERE id = $1`, [crownId]);

    // The surviving clinical edit route still requires actual catalog identity,
    // even though ordinary descriptive invoice lines legitimately remain financial-only.
    const beforeGuard = (await db.query(`SELECT
      (SELECT COUNT(*)::int FROM plan_items) AS items,
      (SELECT COUNT(*)::int FROM invoices) AS invoices,
      (SELECT COUNT(*)::int FROM payments) AS payments,
      (SELECT COUNT(*)::int FROM clinical_cases) AS cases`)).rows;
    for (const [serviceId, status, message] of [
      [99999999, 404, "الخدمة غير موجودة في الدليل."],
      [undefined, 400, "اختر الخدمة من الدليل."],
    ] as const) {
      const rejected = await authedMutation(`/api/plans/${planId}/items`, h.sessions.reception, "POST",
        JSON.stringify({ serviceId, description: "بند علاجي مصطنع", quantity: 1, toothCode: 36, price: "1" }));
      expect(rejected.status).toBe(status);
      expect(await rejected.json()).toMatchObject({ message });
    }
    expect((await db.query(`SELECT
      (SELECT COUNT(*)::int FROM plan_items) AS items,
      (SELECT COUNT(*)::int FROM invoices) AS invoices,
      (SELECT COUNT(*)::int FROM payments) AS payments,
      (SELECT COUNT(*)::int FROM clinical_cases) AS cases`)).rows).toEqual(beforeGuard);

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
