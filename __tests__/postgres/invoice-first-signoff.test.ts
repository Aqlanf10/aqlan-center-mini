import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";

/**
 * (INV-LINK C) التوقيع يستهلك هوية العلاج نفسها ولا يفوتر مرةً ثانية — على PostgreSQL 18.
 * زيارةٌ على بندٍ قبلته فاتورةٌ حيّة: الإجراء يُسجَّل سريريًّا، الجلسة تتقدم، الطبيب يُثبَّت، ولا فاتورة #2.
 * الإلغاء يحفظ تاريخ الفاتورة ويمنع إعادة الفوترة الضمنية. فاتورة تقويم عادية لا تصنع باقة شدّات مفتوحة.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { createLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const { ensureSchema, getPool, resetPoolForTesting, addVisit, setVisitProcedures, signClinicalVisit, setInvoiceStatus } = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let doctor = 0;
let rct = 0;
let ortho = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  doctor = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. أحمد') RETURNING id`))[0].id;
  const service = async (name: string, category: string) => (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 100000, TRUE, TRUE, $2) RETURNING id`, [name, category]))[0].id;
  rct = await service("علاج عصب", "rct");
  ortho = await service("تقويم ثابت", "ortho");
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

const newPatient = async (n: string) => (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`, [n]))[0].id;
const invoiceFor = async (patientId: number, serviceId: number, category: string, price: number, tooth: number | null) => {
  const result = await createLinkedInvoice({
    patientId, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "reception", actorRole: "reception",
    items: [{ serviceId, category, doctorId: doctor, description: category, quantity: 1, unitPriceMinor: price, toothCode: tooth,
      scope: category === "ortho" ? "both" : null, caseId: null, sessions: null }],
    templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: null, requestHash: null, auditDetails: {},
  });
  if (!result.ok) throw new Error(result.reason);
  return result;
};
const visitOn = async (patientId: number, planItemId: number, caseId: number | null, toothCode = 36) => {
  const visit = await addVisit({ patientName: "م", patientPhone: null, note: null, patientId });
  await q(`UPDATE visits SET doctor_id = $2, case_id = $3, diagnosis = 'متابعة علاج الجذور' WHERE id = $1`, [visit.id, doctor, caseId]);
  await setVisitProcedures({
    visitId: visit.id,
    procedures: [{ serviceId: rct, toothCode, surfaces: null, quantity: 1, unitPriceMinor: 0, priceReason: null, doctorId: doctor, note: null, planItemId }],
  });
  return visit.id;
};
const sign = (visitId: number) => signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr", signerDoctorPartyId: doctor });

describe("endo: the visit consumes the invoiced treatment item", () => {
  it("two sessions sign with no second invoice; progress and provider advance on the same item", async () => {
    const patient = await newPatient("SIGN-ENDO");
    const created = await invoiceFor(patient, rct, "rct", 80_000, 36);
    expect(await db.recordPlanConsent({ planId: created.planId!, actor: "reception", note: "موافقة سريرية صريحة" })).toMatchObject({ ok: true });
    const itemId = created.links[0].planItemId!;
    const caseId = created.links[0].caseId;

    const v1 = await visitOn(patient, itemId, caseId);
    const first = await sign(v1);
    expect(first.reason).toBeNull();
    expect(first.invoiceId).toBeNull(); // pre-billed: no invoice #2
    const v2 = await visitOn(patient, itemId, caseId);
    const second = await sign(v2);
    expect(second.reason).toBeNull();
    expect(second.invoiceId).toBeNull();

    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patient])).toHaveLength(1);
    const [item] = await q<{ billing_status: string; billed_invoice_id: number; doctor_id: number | null }>(
      `SELECT billing_status, billed_invoice_id, doctor_id FROM plan_items WHERE id = $1`, [itemId]);
    expect(item).toMatchObject({ billing_status: "billed", billed_invoice_id: created.invoice.id });
    const sessions = await q<{ status: string; visit_id: number | null }>(
      `SELECT status, visit_id FROM treatment_sessions WHERE plan_item_id = $1 ORDER BY sequence`, [itemId]);
    expect(sessions.filter((s) => s.status === "done").map((s) => s.visit_id)).toEqual([v1, v2]);
    const procedures = await q<{ doctor_id: number; plan_item_id: number }>(
      `SELECT doctor_id, plan_item_id FROM visit_procedures WHERE visit_id = ANY($1::int[])`, [[v1, v2]]);
    expect(procedures).toEqual([{ doctor_id: doctor, plan_item_id: itemId }, { doctor_id: doctor, plan_item_id: itemId }]);
    // the procedures are clinical records only: no invoice line sources them
    expect(await q(`SELECT 1 FROM invoice_items WHERE source_type = 'visit_procedure'`)).toHaveLength(0);
  });

  it("cancelling an already-staged invoice-origin item requires review and cannot generate a replacement charge at sign-off", async () => {
    const patient = await newPatient("SIGN-CANCEL");
    const created = await invoiceFor(patient, rct, "rct", 90_000, 36);
    expect(await db.recordPlanConsent({ planId: created.planId!, actor: "reception", note: "موافقة سريرية صريحة" })).toMatchObject({ ok: true });
    const visit = await visitOn(patient, created.links[0].planItemId!, created.links[0].caseId);
    await setInvoiceStatus(created.invoice.id, "cancelled", { actor: "admin", actorRole: "admin" });
    const procedures = await q(`SELECT * FROM visit_procedures WHERE visit_id = $1`, [visit]);
    await expect(sign(visit)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await q(`SELECT * FROM visit_procedures WHERE visit_id = $1`, [visit])).toEqual(procedures);
    expect(await q(`SELECT signed_at, invoice_id FROM visits WHERE id = $1`, [visit])).toEqual([{ signed_at: null, invoice_id: null }]);
    expect(await q(`SELECT id FROM treatment_sessions WHERE visit_id = $1 AND status = 'done'`, [visit])).toEqual([]);
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patient])).toHaveLength(1);
    expect((await q(`SELECT billing_status, billed_invoice_id FROM plan_items WHERE id = $1`, [created.links[0].planItemId]))[0])
      .toEqual({ billing_status: "needs_financial_review", billed_invoice_id: created.invoice.id });
    expect(await q(`SELECT 1 FROM clinical_cases WHERE patient_id = $1`, [patient])).toHaveLength(1);
  });

  it.each([36, 46])("a separately created linked item cannot bypass protected work on the same tooth; tooth %i boundary", async (tooth) => {
    const patient = await newPatient(`SIGN-ALTERNATE-${tooth}`);
    const original = await invoiceFor(patient, rct, "rct", 90_000, 36);
    expect(await db.recordPlanConsent({ planId: original.planId!, actor: "reception", note: "موافقة أصلية" })).toMatchObject({ ok: true });
    const separate = await db.createPlanV2({ patientId: patient, title: "بند مستقل للاختبار", specialty: null, primaryDoctorId: doctor,
      billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-10-07", note: null, createdBy: "dr", installments: [],
      items: [{ serviceId: rct, serviceName: "علاج عصب", category: "rct", toothCode: tooth, surfaces: null,
        quantity: 1, unitPriceMinor: 90_000, billingRule: "on_completion", sessionCount: 1, note: null }] });
    if (!separate.ok) throw new Error(separate.message);
    expect(await db.recordPlanConsent({ planId: separate.planId, actor: "reception", note: "موافقة البند المستقل" })).toMatchObject({ ok: true });
    const [{ id: alternateItem }] = await q<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1`, [separate.planId]);
    const visitId = await visitOn(patient, alternateItem, null, tooth);
    const before = await q(`SELECT * FROM visit_procedures WHERE visit_id = $1`, [visitId]);
    if (tooth === 36) {
      expect((await db.getClinicalVisit(visitId))?.sessionPricing[0]).toMatchObject({ financialReviewRequired: true });
      await expect(sign(visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
      expect(await q(`SELECT signed_at, invoice_id FROM visits WHERE id = $1`, [visitId])).toEqual([{ signed_at: null, invoice_id: null }]);
      expect(await q(`SELECT id FROM treatment_sessions WHERE visit_id = $1 AND status = 'done'`, [visitId])).toEqual([]);
      expect(await q(`SELECT * FROM visit_procedures WHERE visit_id = $1`, [visitId])).toEqual(before);
      expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patient])).toHaveLength(1);
    } else {
      const signed = await sign(visitId);
      expect(signed.reason).toBeNull();
      expect(signed.invoiceId).not.toBeNull();
      expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patient])).toHaveLength(2);
    }
    expect(await q(`SELECT doctor_id FROM invoice_items WHERE invoice_id = $1`, [original.invoice.id])).toEqual([{ doctor_id: doctor }]);
  });
});

describe("ortho: invoice-origin work does not imply an unlimited adjustment package", () => {
  it("neither the invoiced plan nor the bridged case proves general adjustment funding", async () => {
    const patient = await newPatient("SIGN-ORTHO");
    const created = await invoiceFor(patient, ortho, "ortho", 30_000_000, null);
    const [{ id: viaPlan }] = await q<{ id: number }>(
      `INSERT INTO ortho_cases (patient_id, created_by, plan_id) VALUES ($1, 'dr', $2) RETURNING id`, [patient, created.planId]);
    const funded = async (caseId: number) => (await q<{ funded: boolean }>(
      `SELECT ${db.ORTHO_CASE_FUNDED_SQL} AS funded FROM ortho_cases c WHERE c.id = $1`, [caseId]))[0].funded;
    expect(await funded(viaPlan)).toBe(false);

    // bridge path: no plan link on the ortho case, but its clinical case carries the invoiced item
    await q(`UPDATE ortho_cases SET status = 'completed', closed_at = NOW(), plan_id = NULL WHERE id = $1`, [viaPlan]);
    const [{ id: bridged }] = await q<{ id: number }>(`INSERT INTO ortho_cases (patient_id, created_by) VALUES ($1, 'dr') RETURNING id`, [patient]);
    expect(await funded(bridged)).toBe(false);
    await q(`UPDATE clinical_cases SET ortho_case_id = $2 WHERE id = $1`, [created.links[0].caseId, bridged]);
    expect(await funded(bridged)).toBe(false);

    await setInvoiceStatus(created.invoice.id, "cancelled", { actor: "admin", actorRole: "admin" });
    expect(await funded(bridged)).toBe(false); // cancelled invoice ⇒ back to explicit billing decisions
  });

  it("the existing explicit installment agreement remains a legitimate funded package", async () => {
    const patient = await newPatient("SIGN-ORTHO-AGREEMENT");
    const plan = await db.createPlanV2({ patientId: patient, title: "اتفاق تقويم", specialty: "orthodontics", primaryDoctorId: doctor,
      billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-10-07", note: null, createdBy: "reception", installments: [],
      items: [{ serviceId: ortho, serviceName: "تقويم ثابت", category: "ortho", toothCode: null, surfaces: null,
        quantity: 1, unitPriceMinor: 30000000, billingRule: "per_session", sessionCount: 12, note: "النطاق: الفكّان" }] });
    if (!plan.ok) throw new Error(plan.message);
    expect(await db.recordPlanConsent({ planId: plan.planId, actor: "reception", note: "موافقة صريحة" })).toMatchObject({ ok: true });
    expect(await db.schedulePlanInstallments({ planId: plan.planId, count: 3, everyDays: 30, firstDueDate: "2026-10-07" })).toMatchObject({ ok: true });
    const opened = await db.createOrthoCase({ patientId: patient, appliance: "fixed_metal", arches: "both", slot: "022",
      bracketSystem: null, startDate: "2026-10-07", plannedMonths: 18, planId: plan.planId, note: null, createdBy: "dr" });
    if (!opened.ok) throw new Error(opened.message);
    expect((await q<{ funded: boolean }>(`SELECT ${db.ORTHO_CASE_FUNDED_SQL} AS funded FROM ortho_cases c WHERE c.id = $1`, [opened.id]))[0].funded).toBe(true);
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patient])).toEqual([]);
  });
});
