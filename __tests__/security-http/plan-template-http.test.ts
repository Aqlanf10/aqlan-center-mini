import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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

async function create(templateSelection: Record<string, unknown>, selectedPatientId = patientId) {
  const body = {
    patientId: selectedPatientId, currency: "YER", items: [],
    idempotencyKey: `template-adapter:${randomUUID()}`,
    templateSelection: { doctorId: null, ...templateSelection },
  };
  const preview = await authedMutation("/api/invoices/clinical-preview", h.sessions.admin, "POST", JSON.stringify(body));
  if (preview.status !== 200) return preview;
  const reviewed = await preview.json() as { template: { version: string } | null };
  expect(reviewed.template?.version).toEqual(expect.any(String));
  return authedMutation("/api/invoices", h.sessions.admin, "POST", JSON.stringify({
    ...body, templateSelection: { ...body.templateSelection, version: reviewed.template!.version },
  }));
}

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
      templateId: "endo", teeth: [36, 46],
      steps: [
        { key: "rct", include: true, serviceId: rctId },
        { key: "post", include: false, serviceId: null },
        { key: "crown", include: true, serviceId: crownId },
      ],
      sites: [
        { stepKey: "crown", toothCode: 36, episodeTeeth: [36, 46] },
        { stepKey: "crown", toothCode: 46, episodeTeeth: [36, 46] },
      ],
    });
    expect(response.status).toBe(201);
    const { id: invoiceId, clinical: { planId } } = await response.json() as { id: number; clinical: { planId: number } };

    const { rows: [invoice] } = await db.query<{ patient_id: number; currency: string; total_minor: string }>(
      `SELECT patient_id, base_currency AS currency, total_minor::text FROM invoices WHERE id = $1`, [invoiceId]);
    expect(invoice).toEqual({ patient_id: patientId, currency: "YER", total_minor: "242000" });
    expect((await db.query(`SELECT id FROM payments WHERE patient_id = $1`, [patientId])).rows).toEqual([]);
    expect((await db.query(`SELECT consent_at FROM treatment_plans WHERE id = $1`, [planId])).rows).toEqual([{ consent_at: null }]);

    const { rows: [plan] } = await db.query<{ specialty: string | null; total_minor: string }>(
      `SELECT specialty, total_minor::text FROM treatment_plans WHERE id = $1`, [planId]);
    // The canonical master spans endodontics and prosthodontics. It must not
    // mislabel all work as the retired template writer's single specialty.
    expect(plan).toEqual({ specialty: null, total_minor: String(2 * 44000 + 2 * 77000) });
    const { rows: linked } = await db.query<{ service_id: number; tooth_code: number; case_id: number; patient_id: number; specialty: string }>(
      `SELECT i.service_id, i.tooth_code, i.case_id, c.patient_id, c.specialty
       FROM plan_items i JOIN clinical_cases c ON c.id=i.case_id WHERE i.plan_id=$1 ORDER BY i.id`, [planId]);
    expect(linked.map(({ service_id, tooth_code, patient_id, specialty }) => ({ service_id, tooth_code, patient_id, specialty }))).toEqual([
      { service_id: rctId, tooth_code: 36, patient_id: patientId, specialty: "endodontics" },
      { service_id: rctId, tooth_code: 46, patient_id: patientId, specialty: "endodontics" },
      { service_id: crownId, tooth_code: 36, patient_id: patientId, specialty: "prosthodontics" },
      { service_id: crownId, tooth_code: 46, patient_id: patientId, specialty: "prosthodontics" },
    ]);
    expect(new Set(linked.map(row => row.case_id)).size).toBe(3);
    expect(linked[2].case_id).toBe(linked[3].case_id);
    expect((await db.query(`SELECT id FROM treatment_plans WHERE patient_id=$1`, [patientId])).rows).toEqual([{ id: planId }]);

    const { rows: items } = await db.query<{ service_id: number; tooth_code: number; unit_price_minor: string; session_count: number; billing_rule: string }>(
      `SELECT service_id, tooth_code, unit_price_minor::text, session_count, billing_rule FROM plan_items WHERE plan_id = $1 ORDER BY id`, [planId]);
    expect(items).toEqual([
      { service_id: rctId, tooth_code: 36, unit_price_minor: "44000", session_count: 3, billing_rule: "per_session" },
      { service_id: rctId, tooth_code: 46, unit_price_minor: "44000", session_count: 3, billing_rule: "per_session" },
      { service_id: crownId, tooth_code: 36, unit_price_minor: "77000", session_count: 2, billing_rule: "on_start" },
      { service_id: crownId, tooth_code: 46, unit_price_minor: "77000", session_count: 2, billing_rule: "on_start" },
    ]);
    expect((await db.query<{ billed_invoice_id: number }>(
      `SELECT billed_invoice_id FROM plan_items WHERE plan_id = $1 ORDER BY id`, [planId])).rows)
      .toEqual(Array.from({ length: 4 }, () => ({ billed_invoice_id: invoiceId })));

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

    const { rows: [audit] } = await db.query<{ details: Record<string, unknown>; actor: string }>(
      `SELECT details, actor FROM audit_log WHERE action = 'invoice.create' AND entity_id = $1`, [String(invoiceId)]);
    expect(audit.actor).toBe("secadmin");
    expect(audit.details).toMatchObject({ قالب_العلاج: "endo", نسخة_القالب: expect.any(String), عدد_البنود: 4 });
    expect(String(audit.details.نسخة_القالب)).toMatch(/^[a-f0-9]{64}$/);
    const { rows: [planAudit] } = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'plan.create' AND entity = 'patient' AND entity_id = $1`, [String(patientId)]);
    expect(planAudit.details).toMatchObject({ الخطة: planId, البنود: 4 });
    expect((await db.query(`SELECT id FROM treatment_sessions WHERE plan_item_id IN (SELECT id FROM plan_items WHERE plan_id = $1)`, [planId])).rows).toHaveLength(10);
  });

  it("a tooth sent twice becomes one tooth, not two plan items", async () => {
    const { rows: [patient] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض إزالة تكرار السن') RETURNING id`, [`T1-dedup-${Date.now()}`]);
    const response = await create({
      templateId: "endo", teeth: [36, 36],
      steps: [{ key: "rct", include: true, serviceId: rctId }, { key: "post", include: false, serviceId: null }, { key: "crown", include: false, serviceId: null }],
    }, patient.id);
    expect(response.status).toBe(201);
    const { clinical: { planId } } = await response.json() as { clinical: { planId: number } };
    const { rows } = await db.query(`SELECT tooth_code FROM plan_items WHERE plan_id = $1`, [planId]);
    expect(rows).toEqual([{ tooth_code: 36 }]);
  });

  it("refuses caller template prices, billing rules and schedules without creating financial or clinical rows", async () => {
    const { rows: [patient] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض رفض سعر القالب') RETURNING id`, [`T1-tamper-${Date.now()}`]);
    const selection = {
      templateId: "endo", doctorId: null, teeth: [36],
      steps: [{ key: "rct", include: true, serviceId: rctId }],
    };
    const body = { patientId: patient.id, currency: "YER", items: [], idempotencyKey: `template-adapter:${randomUUID()}`, templateSelection: selection };
    const preview = await authedMutation("/api/invoices/clinical-preview", h.sessions.admin, "POST", JSON.stringify(body));
    expect(preview.status).toBe(200);
    const reviewed = await preview.json() as { template: { version: string } };
    for (const forged of [
      { unitPriceMinor: 1 },
      { billingRule: "on_completion" },
      { sessions: [{ title: "موعد مزوّر", minutes: 1, afterDays: 0 }] },
    ]) {
      const response = await authedMutation("/api/invoices", h.sessions.admin, "POST", JSON.stringify({
        ...body, templateSelection: { ...selection, version: reviewed.template.version,
          steps: [{ ...selection.steps[0], ...forged }] },
      }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVOICE_TEMPLATE_INVALID" });
    }
    for (const table of ["invoices", "payments", "treatment_plans", "clinical_cases"]) {
      expect((await db.query(`SELECT id FROM ${table} WHERE patient_id = $1`, [patient.id])).rows).toEqual([]);
    }
  });

  it("refuses with an Arabic message: no teeth, unknown template", async () => {
    const noTeeth = await create({ templateId: "endo", teeth: [], steps: [{ key: "rct", include: true, serviceId: rctId }] });
    expect(noTeeth.status).toBe(400);
    expect((await noTeeth.json() as { message: string }).message).toBe("اختر السن أو الأسنان لخطوة «علاج الجذور».");
    // (مراجعة #117) لا قصٌّ صامت ولا سنٌّ غير صالح: يُرفض برسالة، ولا تُنشأ خطةٌ غير التي رآها الطبيب.
    const invalid = await create({ templateId: "endo", teeth: [19], steps: [{ key: "rct", include: true, serviceId: rctId }] });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "INVOICE_TEMPLATE_INVALID", message: "اختر أسنانًا صحيحة ضمن الحد المسموح." });
    const allTeeth = [11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28,
      31, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 55];
    const tooMany = await create({ templateId: "endo", teeth: allTeeth, steps: [{ key: "rct", include: true, serviceId: rctId }] });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ code: "INVOICE_TEMPLATE_INVALID", message: "اختر أسنانًا صحيحة ضمن الحد المسموح." });
    const unknown = await create({ templateId: "nope", teeth: [11], steps: [] });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: "INVOICE_TEMPLATE_INVALID", message: "قالب العلاج غير موجود؛ أعد اختيار القالب الحالي." });
  });

  it("HTTP exact receipt recovery survives authorized catalogue and template edits, refuses changed actor or intent, and writes no duplicate rows", async () => {
    const { rows: [patient] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض استعادة القالب الاصطناعي') RETURNING id`, [`T1-recover-${randomUUID()}`]);
    const settingsBefore = await (await authedGet("/api/settings", h.sessions.admin)).json() as Record<string, unknown> & { __versions: Record<string, string | null> };
    const catalog = await (await authedGet("/api/plan-templates", h.sessions.admin)).json() as { templates: { id: string; steps: { key: string; sessions: { title: string; minutes: number; afterDays: number }[] }[] }[] };
    const key = "plans.specialty_templates";
    const selection = { templateId: "endo", teeth: [18], doctorId: null, steps: [{ key: "rct", include: true, serviceId: rctId }] };
    const body = { patientId: patient.id, currency: "YER", items: [], idempotencyKey: `template-http-recovery:${randomUUID()}`, templateSelection: selection };
    const preview = await authedMutation("/api/invoices/clinical-preview", h.sessions.admin, "POST", JSON.stringify(body));
    expect(preview.status).toBe(200);
    const reviewed = await preview.json() as { template: { version: string } };
    const command = { ...body, templateSelection: { ...selection, version: reviewed.template.version } };
    const exact = JSON.stringify(command);
    const first = await authedMutation("/api/invoices", h.sessions.admin, "POST", exact);
    expect(first.status).toBe(201);
    const receipt = await first.json() as { id: number; clinical: { planId: number; links: unknown[] } };
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const table of ["invoices", "payments", "treatment_plans", "clinical_cases", "planned_visits"]) {
        result[table] = (await db.query(`SELECT * FROM ${table} WHERE patient_id = $1 ORDER BY id`, [patient.id])).rows;
      }
      result.items = (await db.query(`SELECT * FROM plan_items WHERE plan_id = $1 ORDER BY id`, [receipt.clinical.planId])).rows;
      result.sessions = (await db.query(`SELECT * FROM treatment_sessions WHERE plan_item_id IN (SELECT id FROM plan_items WHERE plan_id = $1) ORDER BY id`, [receipt.clinical.planId])).rows;
      result.invoiceItems = (await db.query(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [receipt.id])).rows;
      result.audit = (await db.query(`SELECT * FROM audit_log WHERE (entity = 'patient' AND entity_id = $1) OR (entity = 'invoice' AND entity_id = $2) ORDER BY id`, [String(patient.id), String(receipt.id)])).rows;
      return result;
    };
    const before = await snapshot();
    const saveSettings = async (value: unknown) => {
      const current = await (await authedGet("/api/settings", h.sessions.admin)).json() as { __versions: Record<string, string | null> };
      return authedMutation("/api/settings", h.sessions.admin, "PATCH", JSON.stringify({ [key]: value ?? "", __versions: { [key]: current.__versions[key] ?? null }, __reason: "تحقق اصطناعي من استعادة القالب" }));
    };
    try {
      expect((await authedMutation(`/api/services/${rctId}`, h.sessions.admin, "PATCH", JSON.stringify({ price: "55000" }))).status).toBe(200);
      const changed = structuredClone(catalog.templates);
      changed.find(one => one.id === "endo")!.steps.find(one => one.key === "rct")!.sessions[0].title += " — نسخة اختبار";
      expect((await saveSettings(JSON.stringify(changed))).status).toBe(200);
      const replay = await authedMutation("/api/invoices", h.sessions.admin, "POST", exact);
      expect(replay.status).toBe(200);
      const recovered = await replay.json() as { id: number; clinical: { planId: number; links: Record<string, unknown>[] }; replayed: boolean };
      expect(recovered).toMatchObject({ id: receipt.id, clinical: { planId: receipt.clinical.planId }, replayed: true });
      const identity = (links: unknown[]) => links.map(one => {
        const { line, kind, specialty, planItemId, caseId, scheduled } = one as Record<string, unknown>;
        return { line, kind, specialty, planItemId, caseId, scheduled };
      });
      expect(identity(recovered.clinical.links)).toEqual(identity(receipt.clinical.links));
      expect(recovered.clinical.links.every(link => link.planItemCreated === false && link.caseCreated === false)).toBe(true);
      expect(await snapshot()).toEqual(before);
      for (const [session, request] of [[h.sessions.reception, exact], [h.sessions.admin, JSON.stringify({ ...command, note: "نية مختلفة" })]] as const) {
        const refused = await authedMutation("/api/invoices", session, "POST", request);
        expect(refused.status).toBe(409);
        expect((await refused.json() as { message: string }).message).toEqual(expect.any(String));
        expect(await snapshot()).toEqual(before);
      }
      const stale = await authedMutation("/api/invoices", h.sessions.admin, "POST", JSON.stringify({ ...command, idempotencyKey: `new-stale:${randomUUID()}` }));
      expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "INVOICE_TEMPLATE_STALE" });
      expect(await snapshot()).toEqual(before);
    } finally {
      expect((await authedMutation(`/api/services/${rctId}`, h.sessions.admin, "PATCH", JSON.stringify({ price: "44000" }))).status).toBe(200);
      expect((await saveSettings(settingsBefore[key])).status).toBe(200);
    }
  });
});
