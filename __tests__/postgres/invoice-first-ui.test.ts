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
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const service = async (name: string, category: string) => (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 100000, TRUE, TRUE, $2) RETURNING id`, [name, category]))[0].id;
  ortho = await service("تقويم ثابت", "ortho");
  rct = await service("علاج عصب", "rct");
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

const newPatient = async (n: string) => (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`, [n]))[0].id;
const line = (serviceId: number, category: string, price: number, toothCode: number | null = null, caseId: number | null = null) =>
  ({ serviceId, category, doctorId: null, description: category, quantity: 1, unitPriceMinor: price, toothCode, caseId, sessions: null });
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
    for (const title of ["أ", "ب"]) await q(`INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, 'endodontics', $2, 'dr')`, [patient, title]);
    const [preview] = await previewInvoiceLinkage({ patientId: patient, baseCurrency: "YER", items: [line(rct, "rct", 80_000, 11)] });
    expect(preview.case?.mode).toBe("choose");
    expect(preview.case?.options).toHaveLength(2);
    expect(preview.refusal).toBe("ambiguous_case");
  });
});

describe("preview refusals equal the save's refusals", () => {
  it("shape mismatch and a conflicting case choice are announced before saving", async () => {
    const patient = await newPatient("PRE-3");
    const [kase] = await q<{ id: number }>(`INSERT INTO clinical_cases (patient_id, specialty, title, site, created_by) VALUES ($1, 'endodontics', 'أ', '26', 'dr') RETURNING id`, [patient]);
    const [other] = await q<{ id: number }>(`INSERT INTO clinical_cases (patient_id, specialty, title, site, created_by) VALUES ($1, 'endodontics', 'ب', '26', 'dr') RETURNING id`, [patient]);
    const [plan] = await q<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, status, consent_at, base_currency) VALUES ($1, 'خطة', 80000, 'active', NOW(), 'YER') RETURNING id`, [patient]);
    await q(`INSERT INTO plan_items (plan_id, service_id, service_name, category, tooth_code, quantity, unit_price_minor, session_count, case_id)
             VALUES ($1, $2, 'علاج عصب', 'rct', 26, 2, 40000, 3, $3)`, [plan.id, rct, kase.id]);
    for (const [items, refusal] of [
      [[line(rct, "rct", 80_000, 26)], "shape_mismatch"],
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
    const created = await create(patient, [line(ortho, "ortho", 30_000_000)]);
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
    expect(funded[0].funded).toBe(true);
    expect(await q(`SELECT 1 FROM audit_log WHERE action = 'ortho.plan_link'`)).toHaveLength(1);
  });

  it("an endo intake case stops needing assessment once a signed visit works on it", async () => {
    const patient = await newPatient("UI-ENDO");
    const created = await create(patient, [line(rct, "rct", 80_000, 36)]);
    if (!created.ok) throw new Error("create");
    expect((await listPatientCases(patient)).find((c) => c.id === created.links[0].caseId)?.needsAssessment).toBe(true);
    await q(`INSERT INTO visits (patient_name, patient_id, case_id, signed_at, signed_by) VALUES ('م', $1, $2, NOW(), 'dr')`, [patient, created.links[0].caseId]);
    expect((await listPatientCases(patient)).find((c) => c.id === created.links[0].caseId)?.needsAssessment).toBe(false);
  });
});
