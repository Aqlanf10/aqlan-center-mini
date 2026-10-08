import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";

/**
 * (INV-LINK D) ما يراه الطاقم بعد فاتورةٍ علاجية — على PostgreSQL 18:
 * المعاينة قبل الحفظ تطابق ما يفعله الحفظ، والحالة «تحتاج تقييمًا» حتى يبدأ العلاج، وفتح حالة التقويم
 * يجسر الحالة الأولية (ولا يبقى للمريض سياقان)، والخطوة التالية «بدء التقييم السريري».
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { createLinkedInvoice, previewInvoiceLinkage } = await import("../../lib/invoice-linkage-db");
const { ensureSchema, getPool, resetPoolForTesting, createOrthoCase, patientWorkflow, listPatientCases } = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let ortho = 0;
let rct = 0;
let doctor = 0;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  doctor = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'طبيب المعاينة') RETURNING id`))[0].id;
  const service = async (name: string, category: string) => (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 100000, TRUE, TRUE, $2) RETURNING id`, [name, category]))[0].id;
  ortho = await service("تقويم ثابت", "ortho");
  rct = await service("علاج عصب", "rct");
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

const newPatient = async (n: string) => (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`, [n]))[0].id;
const line = (serviceId: number, category: string, price: number, toothCode: number | null = null, caseId: number | null = null, scope: string | null = null) =>
  ({ serviceId, category, doctorId: doctor, description: category, quantity: 1, unitPriceMinor: price, toothCode, caseId, scope, sessions: null });
const create = (patientId: number, items: ReturnType<typeof line>[]) => createLinkedInvoice({
  patientId, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "reception", actorRole: "reception",
  items, templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: null, requestHash: null, auditDetails: {},
});

describe("preview mirrors the save", () => {
  it("new item + new intake case, then existing case, then already billed", async () => {
    const patient = await newPatient("PRE-1");
    const before = await previewInvoiceLinkage({ patientId: patient, baseCurrency: "YER", items: [line(rct, "rct", 80_000, 36)] });
    expect(before[0]).toMatchObject({ kind: "clinical", specialtyLabel: "علاج جذور", item: { mode: "new" }, case: { mode: "new" }, refusal: null });
    expect((await create(patient, [line(rct, "rct", 80_000, 36)])).ok).toBe(true);
    const again = await previewInvoiceLinkage({ patientId: patient, baseCurrency: "YER", items: [line(rct, "rct", 80_000, 36), line(rct, "rct", 80_000, 46)] });
    expect(again[0].refusal).toBe("already_billed");
    // another tooth is another endodontic episode: the open case of 36 is not offered for 46
    expect(again[1]).toMatchObject({ item: { mode: "new" }, case: { mode: "new" }, refusal: null });
    const financial = await previewInvoiceLinkage({ patientId: patient, baseCurrency: "YER", items: [{ serviceId: null, category: null, quantity: 1, unitPriceMinor: 1, toothCode: null, caseId: null }] });
    expect(financial[0]).toMatchObject({ kind: "financial", item: null, case: null });
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patient])).toHaveLength(1); // preview wrote nothing
  });
  it("two open cases ask for a choice", async () => {
    const patient = await newPatient("PRE-2");
    for (const title of ["أ", "ب"]) await q(`INSERT INTO clinical_cases (patient_id, specialty, title, site, created_by) VALUES ($1, 'endodontics', $2, '11', 'dr')`, [patient, title]);
    const [preview] = await previewInvoiceLinkage({ patientId: patient, baseCurrency: "YER", items: [line(rct, "rct", 80_000, 11)] });
    expect(preview.case?.mode).toBe("choose");
    expect(preview.case?.options).toHaveLength(2);
    expect(preview.refusal).toBe("ambiguous_case");
  });
});

describe("preview refusals equal the save's refusals", () => {
  it("amount/shape mismatch and a conflicting case choice are announced before saving", async () => {
    const patient = await newPatient("PRE-3");
    const [kase] = await q<{ id: number }>(`INSERT INTO clinical_cases (patient_id, specialty, title, site, created_by) VALUES ($1, 'endodontics', 'أ', '26', 'dr') RETURNING id`, [patient]);
    const [other] = await q<{ id: number }>(`INSERT INTO clinical_cases (patient_id, specialty, title, site, created_by) VALUES ($1, 'endodontics', 'ب', '26', 'dr') RETURNING id`, [patient]);
    const [plan] = await q<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, status, consent_at, base_currency) VALUES ($1, 'خطة', 80000, 'active', NOW(), 'YER') RETURNING id`, [patient]);
    await q(`INSERT INTO plan_items (plan_id, service_id, service_name, category, tooth_code, quantity, unit_price_minor, session_count, case_id)
             VALUES ($1, $2, 'علاج عصب', 'rct', 26, 2, 40000, 3, $3)`, [plan.id, rct, kase.id]);
    for (const [items, refusal] of [
      [[line(rct, "rct", 80_000, 26)], "amount_mismatch"],
      [[line(rct, "rct", 40_000, 26)], "shape_mismatch"],
      [[{ ...line(rct, "rct", 40_000, 26, other.id), quantity: 2 }], "case_mismatch"],
    ] as const) {
      const [preview] = await previewInvoiceLinkage({ patientId: patient, baseCurrency: "YER", items: [...items] });
      expect(preview.refusal).toBe(refusal);
      expect(await create(patient, [...items])).toEqual({ ok: false, reason: refusal, line: 0 });
    }
  });
});

describe("needs-assessment, next action and ortho bridging", () => {
  it("the invoice's ortho case needs assessment until the doctor opens the ortho case, which bridges it", async () => {
    const patient = await newPatient("UI-ORTHO");
    const created = await create(patient, [line(ortho, "ortho", 30_000_000, null, null, "both")]);
    if (!created.ok) throw new Error("create");
    const cases = await listPatientCases(patient);
    expect(cases.filter((c) => c.needsAssessment).map((c) => c.specialty)).toEqual(["orthodontics"]);
    const summary = await patientWorkflow(patient, "2026-10-06");
    expect(summary.assessmentCases).toEqual([expect.objectContaining({ specialty: "orthodontics" })]);

    const opened = await createOrthoCase({
      patientId: patient, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null,
      startDate: "2026-10-06", plannedMonths: 18, planId: null, note: null, createdBy: "dr",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const [kase] = await q<{ ortho_case_id: number; title: string }>(`SELECT ortho_case_id, title FROM clinical_cases WHERE patient_id = $1`, [patient]);
    expect(kase).toEqual({ ortho_case_id: opened.id, title: "تقويم الأسنان" });
    expect((await listPatientCases(patient)).some((c) => c.needsAssessment)).toBe(false);
    expect((await patientWorkflow(patient, "2026-10-06")).assessmentCases).toEqual([]);
    const funded = await q<{ funded: boolean }>(`SELECT ${db.ORTHO_CASE_FUNDED_SQL} AS funded FROM ortho_cases c WHERE c.id = $1`, [opened.id]);
    expect(funded[0].funded).toBe(false); // bridging identity does not create an unlimited financial package
    expect((await q(`SELECT consent_at FROM treatment_plans WHERE id = $1`, [created.planId]))[0]).toEqual({ consent_at: null });
    expect(await q(`SELECT 1 FROM audit_log WHERE action = 'ortho.plan_link'`)).toHaveLength(1);
  });

  describe("an ordinary ortho case reused by a current invoice (Dot review 5461388673)", () => {
    const ordinaryCase = async (patient: number, site: string) => {
      const made = await db.createClinicalCase({ patientId: patient, actor: "dr", specialty: "orthodontics", title: "تقويم",
        site, problem: null, responsiblePartyId: null, orthoCaseId: null });
      if (!made.ok) throw new Error(made.reason);
      return made.case.id;
    };
    const intake = (patient: number, arches: "upper" | "lower" | "both") => createOrthoCase({
      patientId: patient, appliance: "fixed_metal", arches, slot: "022", bracketSystem: null,
      startDate: "2026-10-06", plannedMonths: 18, planId: null, note: null, createdBy: "dr",
    });

    it("bridges the reused case on a matching intake, keeping the case and item identity, with no second ortho context", async () => {
      const patient = await newPatient("UI-ORTHO-REUSED");
      const caseA = await ordinaryCase(patient, "الفكّان");
      const created = await create(patient, [line(ortho, "ortho", 30_000_000, null, null, "both")]);
      if (!created.ok) throw new Error("create");
      expect(created.links[0].caseId).toBe(caseA); // the invoice legitimately reused the ordinary case
      const [{ origin, title }] = await q<{ origin: string; title: string }>(`SELECT origin, title FROM clinical_cases WHERE id = $1`, [caseA]);
      expect(origin).not.toBe("invoice");
      const opened = await intake(patient, "both");
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(await q(`SELECT id, ortho_case_id, origin, title FROM clinical_cases WHERE patient_id = $1 ORDER BY id`, [patient]))
        .toEqual([{ id: caseA, ortho_case_id: opened.id, origin, title }]); // origin and title are not rewritten
      expect(await q(`SELECT details->>'المصدر' AS source FROM audit_log WHERE action = 'ortho.plan_link' AND entity_id = $1`,
        [String(patient)])).toEqual([{ source: "حالة قائمة أعادت الفاتورة استخدامها" }]);
      expect(await q(`SELECT case_id FROM plan_items WHERE id = $1`, [created.links[0].planItemId])).toEqual([{ case_id: caseA }]);
      expect(await q(`SELECT 1 FROM ortho_cases WHERE patient_id = $1`, [patient])).toHaveLength(1);
    });

    it("refuses a mismatched intake arch for the reused case and writes no ortho case", async () => {
      const patient = await newPatient("UI-ORTHO-REUSED-MISMATCH");
      const caseA = await ordinaryCase(patient, "الفكّان");
      const created = await create(patient, [line(ortho, "ortho", 30_000_000, null, null, "both")]);
      if (!created.ok) throw new Error("create");
      expect(created.links[0].caseId).toBe(caseA);
      const opened = await intake(patient, "upper");
      expect(opened.ok).toBe(false);
      expect(await q(`SELECT 1 FROM ortho_cases WHERE patient_id = $1`, [patient])).toHaveLength(0);
      expect(await q(`SELECT ortho_case_id FROM clinical_cases WHERE id = $1`, [caseA])).toEqual([{ ortho_case_id: null }]);
    });

    it("does not treat an ordinary case as invoice work when its only invoice was cancelled, nor when none links it", async () => {
      const unlinked = await newPatient("UI-ORTHO-UNLINKED");
      await ordinaryCase(unlinked, "الفكّان");
      const free = await intake(unlinked, "upper");
      expect(free.ok).toBe(true); // unchanged behaviour: no verified invoice linkage, no bridge candidate

      const cancelled = await newPatient("UI-ORTHO-CANCELLED");
      const caseA = await ordinaryCase(cancelled, "الفكّان");
      const created = await create(cancelled, [line(ortho, "ortho", 30_000_000, null, null, "both")]);
      if (!created.ok) throw new Error("create");
      await q(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [created.invoice.id]);
      const opened = await intake(cancelled, "upper");
      expect(opened.ok).toBe(true);
      expect(await q(`SELECT ortho_case_id FROM clinical_cases WHERE id = $1`, [caseA])).toEqual([{ ortho_case_id: null }]);
    });
  });

  it("an endo intake case stops needing assessment once a signed visit works on it", async () => {
    const patient = await newPatient("UI-ENDO");
    const created = await create(patient, [line(rct, "rct", 80_000, 36)]);
    if (!created.ok) throw new Error("create");
    expect((await listPatientCases(patient)).find((c) => c.id === created.links[0].caseId)?.needsAssessment).toBe(true);
    expect(await db.recordPlanConsent({ planId: created.planId!, actor: "reception", note: "موافقة سريرية صريحة" })).toMatchObject({ ok: true });
    const visit = await db.addVisit({ patientId: patient, patientName: "م", patientPhone: null, note: null, doctorId: doctor });
    expect(await db.setVisitProcedures({ visitId: visit.id, procedures: [{ serviceId: rct, toothCode: 36,
      surfaces: null, quantity: 1, unitPriceMinor: 0, priceReason: null, doctorId: doctor, note: null,
      planItemId: created.links[0].planItemId }] })).toBe(true);
    expect(await db.signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "dr", signerDoctorPartyId: doctor }))
      .toMatchObject({ reason: null, invoiceId: null });
    expect((await listPatientCases(patient)).find((c) => c.id === created.links[0].caseId)?.needsAssessment).toBe(false);
  });

  it("cancellation before ortho intake preserves clinical assessment without restoring financial coverage", async () => {
    const patient = await newPatient("UI-ORTHO-CANCEL");
    const created = await create(patient, [line(ortho, "ortho", 30_000_000, null, null, "both")]);
    if (!created.ok) throw new Error("create");
    const caseId = created.links[0].caseId;
    const itemId = created.links[0].planItemId;
    const pending = [expect.objectContaining({ id: caseId, specialty: "orthodontics" })];
    expect((await patientWorkflow(patient, "2026-10-07")).assessmentCases).toEqual(pending);

    await db.setInvoiceStatus(created.invoice.id, "cancelled", { actor: "admin", actorRole: "admin" });
    const financialState = async () => ({
      invoices: await q(`SELECT id, status FROM invoices WHERE patient_id = $1 ORDER BY id`, [patient]),
      plans: await q(`SELECT id, consent_at FROM treatment_plans WHERE patient_id = $1 ORDER BY id`, [patient]),
      items: await q(`SELECT i.id, i.plan_id, i.case_id, i.billing_status, i.billed_invoice_id, i.origin_invoice_id
        FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1 ORDER BY i.id`, [patient]),
      invoiceItems: await q(`SELECT i.id FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id
        WHERE v.patient_id = $1 ORDER BY i.id`, [patient]),
      installments: await q(`SELECT i.id FROM plan_installments i JOIN treatment_plans t ON t.id = i.plan_id
        WHERE t.patient_id = $1 ORDER BY i.id`, [patient]),
    });
    const cancelled = await financialState();
    expect(cancelled).toMatchObject({
      invoices: [{ id: created.invoice.id, status: "cancelled" }],
      plans: [{ id: created.planId, consent_at: null }],
      items: [{ id: itemId, plan_id: created.planId, case_id: caseId,
        billing_status: "needs_financial_review", billed_invoice_id: created.invoice.id, origin_invoice_id: created.invoice.id }],
      installments: [],
    });
    expect(cancelled.invoiceItems).toHaveLength(1);
    expect((await patientWorkflow(patient, "2026-10-07")).assessmentCases).toEqual(pending);
    expect((await listPatientCases(patient)).map((c) => ({ id: c.id, needsAssessment: c.needsAssessment })))
      .toEqual([{ id: caseId, needsAssessment: true }]);
    expect(await q(`SELECT id FROM ortho_cases WHERE patient_id = $1`, [patient])).toEqual([]);

    const opened = await createOrthoCase({
      patientId: patient, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null,
      startDate: "2026-10-07", plannedMonths: 18, planId: null, note: null, createdBy: "dr",
    });
    if (!opened.ok) throw new Error(opened.message);
    expect(await q(`SELECT id, origin, ortho_case_id FROM clinical_cases WHERE patient_id = $1`, [patient]))
      .toEqual([{ id: caseId, origin: "invoice", ortho_case_id: opened.id }]);
    expect(await q(`SELECT id, plan_id, ${db.ORTHO_CASE_FUNDED_SQL} AS funded
      FROM ortho_cases c WHERE c.patient_id = $1`, [patient]))
      .toEqual([{ id: opened.id, plan_id: null, funded: false }]);
    expect((await listPatientCases(patient)).map((c) => ({ id: c.id, needsAssessment: c.needsAssessment })))
      .toEqual([{ id: caseId, needsAssessment: false }]);
    expect((await patientWorkflow(patient, "2026-10-07")).assessmentCases).toEqual([]);
    expect(await financialState()).toEqual(cancelled);
    // Bridging a surviving clinical record cannot make the cancelled item billable again.
    expect(await create(patient, [line(ortho, "ortho", 30_000_000, null, caseId, "both")]))
      .toEqual({ ok: false, reason: "needs_financial_review", line: 0 });
    expect(await financialState()).toEqual(cancelled);
  });
});

describe("unknown site and provider are never treated as clinical/financial approval", () => {
  it("a blank case site is refused equally by preview and save rather than guessed to match a tooth", async () => {
    const patient = await newPatient("PRE-UNKNOWN-SITE");
    const [{ id: caseId }] = await q<{ id: number }>(`INSERT INTO clinical_cases (patient_id, specialty, title, created_by)
      VALUES ($1, 'endodontics', 'موضع غير محسوم', 'dr') RETURNING id`, [patient]);
    for (const chosen of [null, caseId]) {
      const items = [line(rct, "rct", 80000, 36, chosen)];
      expect((await previewInvoiceLinkage({ patientId: patient, baseCurrency: "YER", items }))[0].refusal).toBe("bad_site");
      expect(await create(patient, items)).toEqual({ ok: false, reason: "bad_site", line: 0 });
    }
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patient])).toEqual([]);
  });

  it("missing provider remains explicit financial review; preview stays read-only and the invoice invents no clinical consent", async () => {
    const patient = await newPatient("PRE-UNKNOWN-PROVIDER");
    const items = [{ ...line(rct, "rct", 80000, 36), doctorId: null }];
    const [preview] = await previewInvoiceLinkage({ patientId: patient, baseCurrency: "YER", items });
    expect(preview).toMatchObject({ financialReviewRequired: true, refusal: null });
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patient])).toEqual([]);
    const created = await createLinkedInvoice({ patientId: patient, baseCurrency: "YER", discountMinor: 0, note: null,
      createdBy: "reception", actorRole: "reception", items, templates: DEFAULT_SPECIALTY_TEMPLATES,
      idempotencyKey: null, requestHash: null, auditDetails: {} });
    if (!created.ok) throw new Error(created.reason);
    expect((await q(`SELECT doctor_id, billing_status FROM plan_items WHERE id = $1`, [created.links[0].planItemId]))[0])
      .toEqual({ doctor_id: null, billing_status: "needs_financial_review" });
    expect((await q(`SELECT consent_at FROM treatment_plans WHERE id = $1`, [created.planId]))[0]).toEqual({ consent_at: null });
  });
});
