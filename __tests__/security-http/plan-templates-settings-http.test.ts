import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (SPEC-T2) المالك يعدّل قوالب التخصص من الإعدادات — عبر مسار الإعدادات المدقَّق نفسه. القيمة
 * تُفحص على الخادم، والطبيب يبني خطته من القالب المعدَّل، و«استعادة الجاهزة» تعيدها.
 */

const KEY = "plans.specialty_templates";
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
}, 120_000);
afterAll(async () => {
  await save("", "تنظيف اختبار القوالب").catch(() => {});
  await db?.end();
});

async function save(value: string, reason: string) {
  const current = await (await authedGet("/api/settings", h.sessions.admin)).json() as { __versions?: Record<string, string | null> };
  return authedMutation("/api/settings", h.sessions.admin, "PATCH", JSON.stringify({
    [KEY]: value, __versions: { [KEY]: current.__versions?.[KEY] ?? null }, __reason: reason,
  }));
}

describe("(SPEC-T2) editing specialty templates", () => {
  it("rejects a broken template with an Arabic message, saves a valid one, and plans use it", async () => {
    const templates = await (await authedGet("/api/plan-templates", h.sessions.admin)).json() as { templates: Record<string, unknown>[]; customized: boolean; canEdit: boolean };
    expect(templates.customized).toBe(false);
    expect(templates.canEdit).toBe(true);

    const broken = await save(JSON.stringify([{ id: "x", name: "قالب", specialty: "س", steps: [] }]), "اختبار");
    expect(broken.status).toBe(400);
    expect((await broken.json() as { message: string }).message).toContain("قوالب الخطط حسب التخصص:");

    const cleaning = templates.templates.find((template) => template.id === "cleaning")!;
    const custom = [{ ...cleaning, name: "تنظيف المركز", steps: (cleaning.steps as Record<string, unknown>[]).map((step) => ({
      ...step, sessions: [{ title: "تنظيف عميق", minutes: 60, afterDays: 0 }],
    })) }];
    const saved = await save(JSON.stringify(custom), "قالب تنظيف المركز");
    expect(saved.status).toBe(200);

    const after = await (await authedGet("/api/plan-templates", h.sessions.reception)).json() as { templates: { id: string; name: string }[]; customized: boolean; canEdit: boolean };
    expect(after.customized).toBe(true);
    expect(after.canEdit).toBe(false);
    expect(after.templates.map((template) => template.name)).toEqual(["تنظيف المركز"]);

    const { rows: [service] } = await db.query<{ id: number }>(
      `INSERT INTO services (name, category, price_minor, is_active, price_configured) VALUES ($1, 'cleaning', 12000, TRUE, TRUE) RETURNING id`,
      [`تنظيف اختبار ${Date.now()}`]);
    const body = {
      patientId: h.seeded.patientBId, currency: "YER", items: [],
      idempotencyKey: `template-settings-adapter:${randomUUID()}`,
      templateSelection: {
        templateId: "cleaning", teeth: [], doctorId: null,
        steps: [{ key: (cleaning.steps as { key: string }[])[0].key, include: true, serviceId: service.id }],
        sites: [{ stepKey: (cleaning.steps as { key: string }[])[0].key, toothCode: null, scope: "full_mouth" }],
      },
    };
    const preview = await authedMutation("/api/invoices/clinical-preview", h.sessions.admin, "POST", JSON.stringify(body));
    expect(preview.status).toBe(200);
    const reviewed = await preview.json() as { template: { version: string } | null };
    expect(reviewed.template?.version).toEqual(expect.any(String));
    const plan = await authedMutation("/api/invoices", h.sessions.admin, "POST", JSON.stringify({
      ...body, templateSelection: { ...body.templateSelection, version: reviewed.template!.version },
    }));
    expect(plan.status).toBe(201);
    const { clinical: { planId: id } } = await plan.json() as { clinical: { planId: number } };
    const { rows: [visit] } = await db.query<{ title: string; duration_minutes: number }>(
      `SELECT title, duration_minutes FROM planned_visits WHERE plan_id = $1`, [id]);
    expect(visit).toEqual({ title: "تنظيف عميق", duration_minutes: 60 });

    // الإيقاف: قالبٌ حُذف من القائمة لا يُبنى منه.
    const gone = await authedMutation("/api/invoices/clinical-preview", h.sessions.admin, "POST", JSON.stringify({
      patientId: h.seeded.patientBId, currency: "YER", items: [],
      templateSelection: { templateId: "endo", teeth: [11], doctorId: null,
        steps: [{ key: "rct", include: true, serviceId: service.id }] },
    }));
    expect(gone.status).toBe(400);
    expect(await gone.json()).toMatchObject({ code: "INVOICE_TEMPLATE_INVALID", message: "قالب العلاج غير موجود؛ أعد اختيار القالب الحالي." });

    expect((await save("", "استعادة الجاهزة")).status).toBe(200);
    const restored = await (await authedGet("/api/plan-templates", h.sessions.admin)).json() as { customized: boolean; templates: unknown[] };
    expect(restored.customized).toBe(false);
    expect(restored.templates.length).toBeGreaterThan(1);
  });

  it("reception cannot change templates", async () => {
    const current = await (await authedGet("/api/settings", h.sessions.admin)).json() as { __versions?: Record<string, string | null> };
    const response = await authedMutation("/api/settings", h.sessions.reception, "PATCH", JSON.stringify({
      [KEY]: "[]", __versions: { [KEY]: current.__versions?.[KEY] ?? null }, __reason: "x",
    }));
    expect(response.status).toBe(403);
  });
});
