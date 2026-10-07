import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/**
 * (INV-LINK B) الفاتورة العلاجية على التطبيق المبني: الربط السريري في الرد، مفتاح الإعادة، والرفض العربي
 * بلا تفاصيل داخلية. والأدوار كما كانت (الطبيب لا يصدر فاتورة).
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let orthoService = 0;
let rctService = 0;
let doctorId = 0;
const stamp = Date.now();

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ party_id: doctorId }] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`));
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'فاتورة علاجية') RETURNING id`, [`IL-${stamp}`]));
  const service = async (name: string, category: string) => (await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 3000000, TRUE, TRUE, $2) RETURNING id`,
    [`${name} ${stamp}`, category])).rows[0].id;
  orthoService = await service("تقويم ثابت", "ortho");
  rctService = await service("علاج عصب", "rct");
}, 120_000);
afterAll(async () => { await db?.end(); });

const post = (who: "reception" | "admin" | "doctorA", body: Record<string, unknown>) =>
  authedMutation("/api/invoices", h.sessions[who], "POST", JSON.stringify({ patientId, currency: "YER", ...body }));
const json = async (response: Response) => await response.json() as Record<string, unknown> & { message?: string };

describe("(INV-LINK B) POST /api/invoices — invoice-first clinical linkage", () => {
  it("an ortho invoice returns its clinical linkage; the same key replays the same invoice", async () => {
    const body = { items: [{ serviceId: orthoService, doctorId, scope: "both" }], idempotencyKey: `inv:http-${stamp}` };
    const created = await post("reception", body);
    expect(created.status).toBe(201);
    const first = await json(created) as { id: number; clinical: { planId: number; links: { kind: string; planItemCreated: boolean; caseCreated: boolean; specialty: string }[] } };
    expect(first.clinical.links[0]).toMatchObject({ kind: "clinical", specialty: "orthodontics", planItemCreated: true, caseCreated: true });
    expect((await db.query(`SELECT consent_at FROM treatment_plans WHERE id = $1`, [first.clinical.planId])).rows)
      .toEqual([{ consent_at: null }]);
    expect((await db.query(`SELECT doctor_id FROM invoice_items WHERE invoice_id = $1`, [first.id])).rows).toEqual([{ doctor_id: doctorId }]);

    const replay = await post("reception", body);
    expect(replay.status).toBe(200);
    expect((await json(replay)).id).toBe(first.id);

    const conflict = await post("reception", { ...body, items: [{ serviceId: orthoService, doctorId, scope: "both", quantity: 2 }] });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).message).toContain("أُرسل سابقًا");
    const { rows } = await db.query(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patientId]);
    expect(rows).toHaveLength(1);
  });

  it("the same treatment invoiced again from another tab is refused in Arabic", async () => {
    const before = (await db.query(`SELECT id FROM invoices WHERE patient_id = $1 ORDER BY id`, [patientId])).rows;
    const response = await post("reception", { items: [{ serviceId: orthoService, doctorId, scope: "both" }], idempotencyKey: `inv:tab2-${stamp}` });
    expect(response.status).toBe(409);
    const payload = await json(response);
    expect(payload.message).toContain("له فاتورة قائمة");
    expect(JSON.stringify(payload)).not.toMatch(/SELECT|plan_items|stack|Error:/i);
    expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1 ORDER BY id`, [patientId])).rows).toEqual(before);
  });

  it("validation: bad key, bad tooth, bad case are Arabic 400s; doctors still cannot issue invoices", async () => {
    expect((await post("reception", { items: [{ serviceId: rctService, toothCode: 36 }], idempotencyKey: "bad key!" })).status).toBe(400);
    const tooth = await post("reception", { items: [{ serviceId: rctService, toothCode: 19 }] });
    expect(tooth.status).toBe(400);
    expect((await json(tooth)).message).toContain("السن");
    const kase = await post("reception", { items: [{ serviceId: rctService, toothCode: 36, caseId: "x" }] });
    expect(kase.status).toBe(400);
    expect((await post("doctorA", { items: [{ serviceId: rctService, toothCode: 36 }] })).status).toBe(403);
  });

  it("an RCT line on tooth 36 links to a new endo case; a description-only line stays financial", async () => {
    const response = await post("admin", { items: [{ serviceId: rctService, toothCode: 36, doctorId }, { description: "رسوم ملف", price: "1000" }] });
    expect(response.status).toBe(201);
    const payload = await json(response) as { clinical: { links: { kind: string; specialty: string | null; caseId: number | null }[] } };
    expect(payload.clinical.links.map((l) => l.kind)).toEqual(["clinical", "financial"]);
    expect(payload.clinical.links[0].specialty).toBe("endodontics");
    const { rows } = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action = 'invoice.create' AND details::text LIKE '%الربط_بالعلاج%' ORDER BY id DESC LIMIT 1`);
    expect(rows).toHaveLength(1);
  });

  it("(INV-LINK TOOTH) fail closed: a tooth-bound line without a tooth, a multi-tooth endo line and a bad scope are Arabic 400s; preview agrees", async () => {
    const invoicesBefore = Number((await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM invoices WHERE patient_id = $1`, [patientId])).rows[0].n);
    const noTooth = await post("reception", { items: [{ serviceId: rctService }] });
    expect(noTooth.status).toBe(400);
    expect((await json(noTooth)).message).toContain("البند 1: ");
    expect((await json(await post("reception", { items: [{ serviceId: rctService }] }))).message).toContain("حدّد السن");
    const split = await post("reception", { items: [{ serviceId: rctService, toothCode: 36, episodeTeeth: [36, 46] }] });
    expect(split.status).toBe(400);
    expect((await json(split)).message).toContain("قسّم البند");
    const scope = await post("reception", { items: [{ serviceId: orthoService, toothCode: 11 }] });
    expect(scope.status).toBe(400);
    const shape = await post("reception", { items: [{ serviceId: rctService, toothCode: 36, episodeTeeth: "36" }] });
    expect(shape.status).toBe(400);
    expect(Number((await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM invoices WHERE patient_id = $1`, [patientId])).rows[0].n)).toBe(invoicesBefore);
    // a fresh patient: the ortho of the main patient is already pre-billed by an earlier test (would preview already_billed)
    const { rows: [{ id: fresh }] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'معاينة الأسنان') RETURNING id`, [`ILT-${stamp}`]);
    const preview = await authedMutation("/api/invoices/clinical-preview", h.sessions.reception, "POST",
      JSON.stringify({ patientId: fresh, currency: "YER", items: [{ serviceId: rctService, doctorId }, { serviceId: orthoService, doctorId, scope: "upper" }] }));
    expect(preview.status).toBe(200);
    const lines = (await preview.json() as { lines: { refusal: string | null; refusalMessage: string | null }[] }).lines;
    expect(lines[0].refusal).toBe("tooth_required");
    expect(lines[0].refusalMessage).toContain("حدّد السن");
    expect(lines[1].refusal).toBeNull();
  });

  it.each(["omitted", "null"] as const)("%s financial provider creates explicit review without inventing clinical consent or a treating doctor", async (provider) => {
    const { rows: [{ id: fresh }] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'طبيب مالي غير محدد') RETURNING id`, [`IL-NOPROV-${provider}-${stamp}`]);
    const body = { patientId: fresh, currency: "YER", items: [{ serviceId: rctService, toothCode: 46, ...(provider === "null" ? { doctorId: null } : {}) }] };
    const preview = await authedMutation("/api/invoices/clinical-preview", h.sessions.reception, "POST", JSON.stringify(body));
    expect(preview.status).toBe(200);
    expect((await preview.json() as { lines: unknown[] }).lines[0]).toMatchObject({ financialReviewRequired: true, refusal: null });
    expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [fresh])).rows).toEqual([]);
    const created = await post("reception", body);
    expect(created.status).toBe(201);
    const result = await created.json() as { id: number; clinical: { planId: number; links: { planItemId: number }[] } };
    expect((await db.query(`SELECT doctor_id, billing_status FROM plan_items WHERE id = $1`, [result.clinical.links[0].planItemId])).rows)
      .toEqual([{ doctor_id: null, billing_status: "needs_financial_review" }]);
    expect((await db.query(`SELECT consent_at FROM treatment_plans WHERE id = $1`, [result.clinical.planId])).rows).toEqual([{ consent_at: null }]);
    expect((await db.query(`SELECT doctor_id FROM invoice_items WHERE invoice_id = $1`, [result.id])).rows).toEqual([{ doctor_id: null }]);
  });

  it.each(["price", "quantity", "toothCode", "caseId", "doctorId", "sessions"] as const)(
    "explicit malformed %s is refused by both preview and save, never normalized into another request", async (field) => {
      const { rows: [{ id: fresh }] } = await db.query<{ id: number }>(
        `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'تحقق الطلب') RETURNING id`, [`IL-MAL-${field}-${stamp}`]);
      const body = { patientId: fresh, currency: "YER", items: [{ serviceId: rctService, toothCode: 36, doctorId, [field]: "not-a-number" }] };
      const preview = await authedMutation("/api/invoices/clinical-preview", h.sessions.reception, "POST", JSON.stringify(body));
      const saved = await post("reception", body);
      expect(preview.status).toBe(400);
      expect(saved.status).toBe(400);
      for (const response of [preview, saved]) {
        const payload = await response.json();
        expect(payload.message).toMatch(/[؀-ۿ]/);
        expect(JSON.stringify(payload)).not.toMatch(/SELECT|stack|Error:/i);
      }
      expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [fresh])).rows).toEqual([]);
    });

  it.each(["consultation", "catalogue_unknown"] as const)(
    "catalogue drift to %s cannot erase therapeutic lineage; unrelated financial-only work remains allowed", async (category) => {
      const { rows: [{ id: fresh }] } = await db.query<{ id: number }>(
        `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'اختبار تغيّر التصنيف') RETURNING id`, [`IL-DRIFT-${category}-${stamp}`]);
      const { rows: [{ id: changedService }] } = await db.query<{ id: number }>(`INSERT INTO services
        (name, price_minor, is_active, price_configured, category) VALUES ($1, 3000000, TRUE, TRUE, 'rct') RETURNING id`,
      [`خدمة ذات تاريخ علاجي ${category} ${stamp}`]);
      const body = { patientId: fresh, currency: "YER", items: [{ serviceId: changedService, toothCode: 36, doctorId }] };
      const created = await post("reception", body);
      expect(created.status).toBe(201);
      const original = await created.json() as { id: number; clinical: { planId: number; links: { planItemId: number; caseId: number }[] } };
      const snapshot = async () => ({
        invoices: (await db.query(`SELECT id, status, total_minor::text, discount_minor::text FROM invoices WHERE patient_id = $1 ORDER BY id`, [fresh])).rows,
        plans: (await db.query(`SELECT id, status, consent_at FROM treatment_plans WHERE patient_id = $1 ORDER BY id`, [fresh])).rows,
        items: (await db.query(`SELECT pi.id, pi.plan_id, pi.service_id, pi.category, pi.case_id, pi.origin_invoice_id,
          pi.billed_invoice_id, pi.billing_status FROM plan_items pi JOIN treatment_plans tp ON tp.id = pi.plan_id
          WHERE tp.patient_id = $1 ORDER BY pi.id`, [fresh])).rows,
        cases: (await db.query(`SELECT id, specialty, site, status FROM clinical_cases WHERE patient_id = $1 ORDER BY id`, [fresh])).rows,
      });
      const before = await snapshot();
      // Deliberate catalogue fixture update, not a financial/clinical history rewrite.
      // The real API must read this new category and still honour the old work identity.
      await db.query(`UPDATE services SET category = $2 WHERE id = $1`, [changedService, category]);
      const preview = await authedMutation("/api/invoices/clinical-preview", h.sessions.reception, "POST", JSON.stringify(body));
      expect(preview.status).toBe(200);
      const lines = (await preview.json() as { lines: { kind: string; refusal: string | null; financialReviewRequired: boolean; refusalMessage: string }[] }).lines;
      expect(lines).toEqual([expect.objectContaining({ kind: "financial", refusal: "needs_financial_review", financialReviewRequired: true })]);
      expect(lines[0].refusalMessage).toContain("مراجعة مالية");
      expect(await snapshot()).toEqual(before); // preview is read-only
      const duplicate = await post("reception", body);
      expect(duplicate.status).toBe(409);
      const refusal = await json(duplicate);
      expect(refusal.message).toContain("مراجعة مالية");
      expect(JSON.stringify(refusal)).not.toMatch(/SELECT|plan_items|stack|Error:/i);
      expect(await snapshot()).toEqual(before);
      expect(before.items).toEqual([expect.objectContaining({ id: original.clinical.links[0].planItemId,
        service_id: changedService, category: "rct", billed_invoice_id: original.id, case_id: original.clinical.links[0].caseId })]);

      // Positive boundary: this patient's unrelated consultation and manual fee stay
      // financial-only. Historical lineage for another service must not block them.
      const { rows: [{ id: unrelatedService }] } = await db.query<{ id: number }>(`INSERT INTO services
        (name, price_minor, is_active, price_configured, category) VALUES ($1, 100000, TRUE, TRUE, 'consultation') RETURNING id`,
      [`كشف مستقل ${category} ${stamp}`]);
      const financialBody = { patientId: fresh, currency: "YER", items: [
        { serviceId: unrelatedService }, { description: "رسوم ملف مستقلة", price: "1000" },
      ] };
      const financialPreview = await authedMutation("/api/invoices/clinical-preview", h.sessions.reception, "POST", JSON.stringify(financialBody));
      expect(financialPreview.status).toBe(200);
      expect((await financialPreview.json() as { lines: unknown[] }).lines)
        .toEqual([expect.objectContaining({ kind: "financial", refusal: null }), expect.objectContaining({ kind: "financial", refusal: null })]);
      const financial = await post("reception", financialBody);
      expect(financial.status).toBe(201);
      const financialResult = await financial.json() as { id: number; clinical: { links: { kind: string }[] } };
      expect(financialResult.clinical.links.map((line) => line.kind)).toEqual(["financial", "financial"]);
      expect((await db.query(`SELECT plan_item_id FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [financialResult.id])).rows)
        .toEqual([{ plan_item_id: null }, { plan_item_id: null }]);
      const afterFinancial = await snapshot();
      expect(afterFinancial.plans).toEqual(before.plans);
      expect(afterFinancial.items).toEqual(before.items);
      expect(afterFinancial.cases).toEqual(before.cases);

      // The guard is patient-scoped: the reclassified service has no retained
      // therapeutic lineage for a different patient and remains financial-only there.
      const { rows: [{ id: otherPatient }] } = await db.query<{ id: number }>(
        `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'بلا تاريخ لهذه الخدمة') RETURNING id`, [`IL-DRIFT-OTHER-${category}-${stamp}`]);
      const otherBody = { patientId: otherPatient, currency: "YER", items: [{ serviceId: changedService }] };
      const otherPreview = await authedMutation("/api/invoices/clinical-preview", h.sessions.reception, "POST", JSON.stringify(otherBody));
      expect(otherPreview.status).toBe(200);
      expect((await otherPreview.json() as { lines: unknown[] }).lines).toEqual([expect.objectContaining({ kind: "financial", refusal: null })]);
      const otherInvoice = await post("reception", otherBody);
      expect(otherInvoice.status).toBe(201);
      expect((await otherInvoice.json() as { clinical: { links: { kind: string }[] } }).clinical.links.map((line) => line.kind)).toEqual(["financial"]);
      expect((await db.query(`SELECT id FROM treatment_plans WHERE patient_id = $1`, [otherPatient])).rows).toEqual([]);
      expect((await db.query(`SELECT id FROM clinical_cases WHERE patient_id = $1`, [otherPatient])).rows).toEqual([]);
    });
});
