import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (SPEC-T1) «خطة من قالب التخصص» عبر المسار الحقيقي: الخادم يبني البنود من القالب ويسعّرها من
 * الدليل (لا من الطلب)، ويُنشئ الجلسات بعناوين القالب ومدده، ويجمع الجلسة نفسها لعدة أسنان في
 * زيارةٍ مخطَّطة واحدة.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let rctId = 0;
let crownId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const stamp = Date.now();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض القالب') RETURNING id`, [`T1-${stamp}`]));
  ({ rows: [{ id: rctId }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, is_active, price_configured) VALUES ($1, 'rct', 44000, TRUE, TRUE) RETURNING id`,
    [`عصب اختبار ${stamp}`]));
  ({ rows: [{ id: crownId }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, is_active, price_configured) VALUES ($1, 'crown', 77000, TRUE, TRUE) RETURNING id`,
    [`تاج اختبار ${stamp}`]));
}, 120_000);
afterAll(async () => { await db?.end(); });

const create = (body: Record<string, unknown>) =>
  authedMutation("/api/plans", h.sessions.admin, "POST", JSON.stringify({ mode: "template", patientId, ...body }));

describe("(SPEC-T1) plan from a specialty template", () => {
  it("a doctor without the price list still gets the services to choose from — names only, no prices (review)", async () => {
    const response = await authedGet("/api/plan-templates", h.sessions.doctorA);
    expect(response.status).toBe(200);
    const payload = await response.json() as { showPrices: boolean; services: { id: number; category: string | null; priceMinor: number | null }[] };
    expect(payload.showPrices).toBe(false);
    const rct = payload.services.find((service) => service.id === rctId);
    expect(rct).toMatchObject({ category: "rct", priceMinor: null });
    expect(payload.services.every((service) => service.priceMinor === null)).toBe(true);
    const admin = await (await authedGet("/api/plan-templates", h.sessions.admin)).json() as { showPrices: boolean; services: { id: number; priceMinor: number | null }[] };
    expect(admin.showPrices).toBe(true);
    expect(admin.services.find((service) => service.id === rctId)?.priceMinor).toBe(44000);
  });

  it("lists the ready-made templates", async () => {
    const response = await authedGet("/api/plan-templates", h.sessions.reception);
    expect(response.status).toBe(200);
    const { templates } = await response.json() as { templates: { id: string; name: string }[] };
    expect(templates.map((template) => template.id)).toEqual(expect.arrayContaining(["endo", "ortho", "crowns"]));
  });

  it("endo + crown on 36 and 46: catalog prices, template sessions, one planned visit per step session", async () => {
    const response = await create({
      templateId: "endo", title: "علاج عصب — 36 و46", teeth: [36, 46],
      steps: [
        { key: "rct", include: true, serviceId: rctId },
        { key: "post", include: false },
        { key: "crown", include: true, serviceId: crownId },
      ],
      // يُتجاهل: السعر من الدليل على الخادم.
      items: [{ serviceId: rctId, unitPriceMinor: 1 }], unitPriceMinor: 1,
    });
    expect(response.status).toBe(201);
    const { id: planId } = await response.json() as { id: number };

    const { rows: [plan] } = await db.query<{ specialty: string; total_minor: string }>(
      `SELECT specialty, total_minor::text FROM treatment_plans WHERE id = $1`, [planId]);
    expect(plan).toEqual({ specialty: "علاج عصب", total_minor: String(2 * 44000 + 2 * 77000) });

    const { rows: items } = await db.query<{ service_id: number; tooth_code: number; unit_price_minor: string; session_count: number; billing_rule: string }>(
      `SELECT service_id, tooth_code, unit_price_minor::text, session_count, billing_rule FROM plan_items WHERE plan_id = $1 ORDER BY id`, [planId]);
    expect(items).toEqual([
      { service_id: rctId, tooth_code: 36, unit_price_minor: "44000", session_count: 3, billing_rule: "per_session" },
      { service_id: rctId, tooth_code: 46, unit_price_minor: "44000", session_count: 3, billing_rule: "per_session" },
      { service_id: crownId, tooth_code: 36, unit_price_minor: "77000", session_count: 2, billing_rule: "on_start" },
      { service_id: crownId, tooth_code: 46, unit_price_minor: "77000", session_count: 2, billing_rule: "on_start" },
    ]);

    const { rows: visits } = await db.query<{ sequence: number; title: string; duration_minutes: number; sessions: number }>(
      `SELECT v.sequence, v.title, v.duration_minutes,
              (SELECT COUNT(*)::int FROM treatment_sessions s WHERE s.planned_visit_id = v.id) AS sessions
         FROM planned_visits v WHERE v.plan_id = $1 ORDER BY v.sequence`, [planId]);
    expect(visits).toEqual([
      { sequence: 1, title: "فتح السن وتنظيف القنوات — سن 36، 46", duration_minutes: 90, sessions: 2 },
      { sequence: 2, title: "تشكيل وتعقيم القنوات — سن 36، 46", duration_minutes: 90, sessions: 2 },
      { sequence: 3, title: "حشو القنوات النهائي — سن 36، 46", duration_minutes: 90, sessions: 2 },
      { sequence: 4, title: "تحضير السن وأخذ الطبعة — سن 36، 46", duration_minutes: 90, sessions: 2 },
      { sequence: 5, title: "تركيب التاج — سن 36، 46", duration_minutes: 60, sessions: 2 },
    ]);

    const { rows: [audit] } = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'plan.create_v2' AND entity_id = $1`, [String(planId)]);
    expect(audit.details).toMatchObject({ القالب: "علاج عصب + تاج", الأسنان: "36، 46", البنود: 4, الجلسات: 10 });
  });

  it("refuses with an Arabic message: no teeth, unknown template", async () => {
    const noTeeth = await create({ templateId: "endo", title: "عصب", teeth: [], steps: [{ key: "rct", include: true, serviceId: rctId }] });
    expect(noTeeth.status).toBe(400);
    expect((await noTeeth.json() as { message: string }).message).toBe("اختر السن أو الأسنان لخطوة «علاج الجذور».");
    const unknown = await create({ templateId: "nope", title: "x", teeth: [11] });
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as { message: string }).message).toBe("قالب التخصص غير موجود.");
  });
});
