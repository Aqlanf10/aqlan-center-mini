import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";

/**
 * (INV-LINK C) التوقيع يستهلك هوية العلاج نفسها ولا يفوتر مرةً ثانية — على PostgreSQL 18.
 * زيارةٌ على بندٍ قبلته فاتورةٌ حيّة: الإجراء يُسجَّل سريريًّا، الجلسة تتقدم، الطبيب يُثبَّت، ولا فاتورة #2.
 * بعد إلغاء الفاتورة يعود البند إلى الفوترة العادية (لا تغطية مُتوهَّمة). وشدّات التقويم على باقةٍ مفوترة مشمولة.
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
    items: [{ serviceId, category, doctorId: null, description: category, quantity: 1, unitPriceMinor: price, toothCode: tooth, caseId: null, sessions: null }],
    templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: null, requestHash: null, auditDetails: {},
  });
  if (!result.ok) throw new Error(result.reason);
  return result;
};
const visitOn = async (patientId: number, planItemId: number, caseId: number | null) => {
  const visit = await addVisit({ patientName: "م", patientPhone: null, note: null, patientId });
  await q(`UPDATE visits SET doctor_id = $2, case_id = $3, diagnosis = 'متابعة علاج الجذور' WHERE id = $1`, [visit.id, doctor, caseId]);
  await setVisitProcedures({
    visitId: visit.id,
    procedures: [{ serviceId: rct, toothCode: 36, surfaces: null, quantity: 1, unitPriceMinor: 0, priceReason: null, doctorId: null, note: null, planItemId }],
  });
  return visit.id;
};
const sign = (visitId: number) => signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr", signerDoctorPartyId: doctor });

describe("endo: the visit consumes the invoiced treatment item", () => {
  it("two sessions sign with no second invoice; progress and provider advance on the same item", async () => {
    const patient = await newPatient("SIGN-ENDO");
    const created = await invoiceFor(patient, rct, "rct", 80_000, 36);
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

  it("after the invoice is cancelled the item is billed normally at sign-off (no phantom coverage)", async () => {
    const patient = await newPatient("SIGN-CANCEL");
    const created = await invoiceFor(patient, rct, "rct", 90_000, 36);
    await setInvoiceStatus(created.invoice.id, "cancelled", { actor: "admin", actorRole: "admin" });
    const visit = await visitOn(patient, created.links[0].planItemId!, created.links[0].caseId);
    const signed = await sign(visit);
    expect(signed.reason).toBeNull();
    expect(signed.invoiceId).not.toBeNull();
    expect(await q(`SELECT 1 FROM clinical_cases WHERE patient_id = $1`, [patient])).toHaveLength(1);
  });
});

describe("ortho: adjustments on an invoice-paid package are included, not pending decisions", () => {
  it("an ortho case linked to the invoiced plan (or bridged case) classifies as funded", async () => {
    const patient = await newPatient("SIGN-ORTHO");
    const created = await invoiceFor(patient, ortho, "ortho", 30_000_000, null);
    const [{ id: viaPlan }] = await q<{ id: number }>(
      `INSERT INTO ortho_cases (patient_id, created_by, plan_id) VALUES ($1, 'dr', $2) RETURNING id`, [patient, created.planId]);
    const funded = async (caseId: number) => (await q<{ funded: boolean }>(
      `SELECT ${db.ORTHO_CASE_FUNDED_SQL} AS funded FROM ortho_cases c WHERE c.id = $1`, [caseId]))[0].funded;
    expect(await funded(viaPlan)).toBe(true);

    // bridge path: no plan link on the ortho case, but its clinical case carries the invoiced item
    await q(`UPDATE ortho_cases SET status = 'completed', closed_at = NOW(), plan_id = NULL WHERE id = $1`, [viaPlan]);
    const [{ id: bridged }] = await q<{ id: number }>(`INSERT INTO ortho_cases (patient_id, created_by) VALUES ($1, 'dr') RETURNING id`, [patient]);
    expect(await funded(bridged)).toBe(false);
    await q(`UPDATE clinical_cases SET ortho_case_id = $2 WHERE id = $1`, [created.links[0].caseId, bridged]);
    expect(await funded(bridged)).toBe(true);

    await setInvoiceStatus(created.invoice.id, "cancelled", { actor: "admin", actorRole: "admin" });
    expect(await funded(bridged)).toBe(false); // cancelled invoice ⇒ back to explicit billing decisions
  });
});
