import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P1-C) قرار فوترة شدّة التقويم خارج العقد على PostgreSQL 18:
 * التوقيع يحفظ لقطة التصنيف؛ سطر «شدّة تقويم» مفوتَر ⇒ «فوتِرت» بفاتورتها؛ «بلا رسوم» بسببٍ مكتوب؛
 * وبلا قرار تبقى معلّقة (لا منع للتوقيع) وتظهر في قائمة المتابعة حتى يُحسم قرارها مرةً واحدة مُدقَّقة.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, openShift, addVisit, recordAdjustment, setVisitProcedures,
  signClinicalVisit, visitWalkout, listPendingOrthoDecisions, decideOrthoAdjustmentBilling, getClinicalVisit,
} = db;
const { clinicDateString } = await import("../../lib/schedule");
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let doctorId = 0;
let adjustService = 0;
let sequence = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  doctorId = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. التقويم') RETURNING id`))[0].id;
  adjustService = (await q<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, price_configured) VALUES ('شدّة تقويم (زيارة)', 'ortho', 10000, TRUE) RETURNING id`))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function orthoVisit(options: { legacy?: boolean } = {}) {
  sequence += 1;
  const name = `مريض تقويم ${sequence}`;
  const patientId = (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`OC-${sequence}`, name]))[0].id;
  const caseId = (await q<{ id: number }>(
    options.legacy
      ? `INSERT INTO ortho_cases (patient_id, created_by, baseline_kind, baseline_recorded_at, legacy_financial_mode, responsible_doctor_id)
         VALUES ($1, 'migration', 'legacy', NOW(), 'prepaid_included', $2) RETURNING id`
      : `INSERT INTO ortho_cases (patient_id, created_by, responsible_doctor_id) VALUES ($1, 'doctor', $2) RETURNING id`,
    [patientId, doctorId]))[0].id;
  const visit = await addVisit({ patientName: name, patientPhone: null, note: null, patientId, doctorId });
  const saved = await recordAdjustment({
    caseId, visitId: null, doneOn: today, phase: null, upperWire: "016 NiTi", lowerWire: null,
    elastics: "none", elasticNote: null, done: "شدّة", nextWeeks: 4, note: null, recordedBy: "doctor", actorRole: "doctor",
  });
  if (!saved.ok) throw new Error(saved.message);
  return { patientId, visitId: visit.id, adjustmentId: saved.id };
}

const sign = (visitId: number, decision: { decision: "no_charge"; reason: string } | null = null) =>
  signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId, outsideContractDecision: decision });

describe("(P1-C) outside-contract adjustment decision", () => {
  it("no decision: the sign is not blocked; the adjustment is pending until decided once (no charge, audited)", async () => {
    const { visitId, adjustmentId } = await orthoVisit();
    const signed = await sign(visitId);
    expect(signed).toMatchObject({ reason: null, invoiceId: null, orthoBillingClass: "OUTSIDE_CONTRACT", orthoBillingDecision: null });
    expect((await visitWalkout(visitId))?.orthoAdjustment).toMatchObject({ billingClass: "OUTSIDE_CONTRACT", pendingDecision: true });
    expect((await listPendingOrthoDecisions()).map((row) => row.adjustmentId)).toContain(adjustmentId);

    expect(await decideOrthoAdjustmentBilling({ adjustmentId, decision: "no_charge", reason: "x", invoiceNumber: null, actor: "dr", actorRole: "doctor" }))
      .toMatchObject({ ok: false, status: 400 });
    expect(await decideOrthoAdjustmentBilling({ adjustmentId, decision: "no_charge", reason: "متابعة مجانية بعد كسر", invoiceNumber: null, actor: "dr", actorRole: "doctor" }))
      .toEqual({ ok: true, decision: "no_charge" });
    expect((await visitWalkout(visitId))?.orthoAdjustment).toMatchObject({ billingClass: "NO_CHARGE", decision: "no_charge", pendingDecision: false });
    expect((await listPendingOrthoDecisions()).map((row) => row.adjustmentId)).not.toContain(adjustmentId);
    expect(await decideOrthoAdjustmentBilling({ adjustmentId, decision: "no_charge", reason: "مرة ثانية", invoiceNumber: null, actor: "dr", actorRole: "doctor" }))
      .toMatchObject({ ok: false, status: 409 });
    const [audit] = await q<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'ortho.billing_decision' AND entity_id = $1`, [String(adjustmentId)]);
    expect(audit.details).toMatchObject({ القرار: "بلا رسوم", السبب: "متابعة مجانية بعد كسر" });
  });

  it("an invoiced «شدّة تقويم» line decides it as billed, linked to that invoice", async () => {
    const { visitId, adjustmentId } = await orthoVisit();
    await setVisitProcedures({
      visitId,
      procedures: [{ serviceId: adjustService, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 10000, priceReason: null, doctorId, note: null, planItemId: null }],
    });
    const signed = await sign(visitId);
    expect(signed).toMatchObject({ reason: null, duesMinor: 10000, orthoBillingDecision: "billed" });
    expect(await q(`SELECT billing_class, billing_decision, billing_invoice_id FROM ortho_adjustments WHERE id = $1`, [adjustmentId]))
      .toEqual([{ billing_class: "OUTSIDE_CONTRACT", billing_decision: "billed", billing_invoice_id: signed.invoiceId }]);
    expect((await visitWalkout(visitId))?.orthoAdjustment).toMatchObject({ billingClass: "NEW_BILLABLE", pendingDecision: false });
  });

  it("no charge at sign needs a written reason; with one it is recorded", async () => {
    const { visitId, adjustmentId } = await orthoVisit();
    expect((await sign(visitId, { decision: "no_charge", reason: "لا" })).reason).toBe("invalid_decision_reason");
    expect((await q<{ signed_at: Date | null }>(`SELECT signed_at FROM visits WHERE id = $1`, [visitId]))[0].signed_at).toBeNull();
    expect(await sign(visitId, { decision: "no_charge", reason: "شدّة تعويضية — كسر حاصرة" }))
      .toMatchObject({ reason: null, invoiceId: null, orthoBillingDecision: "no_charge" });
    expect(await q(`SELECT billing_decision, billing_decision_reason, billing_decided_by FROM ortho_adjustments WHERE id = $1`, [adjustmentId]))
      .toEqual([{ billing_decision: "no_charge", billing_decision_reason: "شدّة تعويضية — كسر حاصرة", billing_decided_by: "doctor" }]);
  });

  it("billed after the sign needs an existing invoice of the same patient", async () => {
    const { visitId, adjustmentId } = await orthoVisit();
    await sign(visitId);
    const other = await orthoVisit();
    await setVisitProcedures({
      visitId: other.visitId,
      procedures: [{ serviceId: adjustService, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 10000, priceReason: null, doctorId, note: null, planItemId: null }],
    });
    const foreign = await sign(other.visitId);
    const [foreignInvoice] = await q<{ invoice_number: string }>(`SELECT invoice_number FROM invoices WHERE id = $1`, [foreign.invoiceId]);
    expect(await decideOrthoAdjustmentBilling({ adjustmentId, decision: "billed", reason: null, invoiceNumber: foreignInvoice.invoice_number, actor: "reception", actorRole: "reception" }))
      .toMatchObject({ ok: false, status: 409 });
    const { patientId } = (await q<{ patientId: number }>(`SELECT patient_id AS "patientId" FROM visits WHERE id = $1`, [visitId]))[0];
    const own = (await q<{ id: number; invoice_number: string }>(
      `INSERT INTO invoices (invoice_number, patient_id, base_currency, total_minor, discount_minor, created_by)
       VALUES ('INV-OC-OWN', $1, 'YER', 10000, 0, 'reception') RETURNING id, invoice_number`, [patientId]))[0];
    expect(await decideOrthoAdjustmentBilling({ adjustmentId, decision: "billed", reason: null, invoiceNumber: own.invoice_number, actor: "reception", actorRole: "reception" }))
      .toEqual({ ok: true, decision: "billed" });
    expect((await q<{ billing_invoice_id: number }>(`SELECT billing_invoice_id FROM ortho_adjustments WHERE id = $1`, [adjustmentId]))[0].billing_invoice_id).toBe(own.id);
  });

  it("an included (legacy prepaid) adjustment is snapshotted, never pending, and cannot be decided", async () => {
    const { visitId, adjustmentId } = await orthoVisit({ legacy: true });
    expect(await sign(visitId)).toMatchObject({ orthoBillingClass: "LEGACY_INCLUDED", orthoBillingDecision: null });
    expect((await q(`SELECT billing_class, billing_decision FROM ortho_adjustments WHERE id = $1`, [adjustmentId])))
      .toEqual([{ billing_class: "LEGACY_INCLUDED", billing_decision: null }]);
    expect((await visitWalkout(visitId))?.orthoAdjustment).toMatchObject({ billingClass: "LEGACY_INCLUDED", pendingDecision: false });
    /* اللقطة مجمَّدة: تغيير طريقة المال لاحقًا لا يعيد كتابة تصنيف زيارةٍ موقّعة. */
    await q(`UPDATE ortho_cases SET legacy_financial_mode = 'per_session' WHERE id = (SELECT case_id FROM ortho_adjustments WHERE id = $1)`, [adjustmentId]);
    expect((await getClinicalVisit(visitId))?.ortho?.adjustmentBillingClass).toBe("LEGACY_INCLUDED");
    expect((await visitWalkout(visitId))?.orthoAdjustment?.billingClass).toBe("LEGACY_INCLUDED");
    expect(await decideOrthoAdjustmentBilling({ adjustmentId, decision: "no_charge", reason: "لا يلزم", invoiceNumber: null, actor: "dr", actorRole: "doctor" }))
      .toMatchObject({ ok: false, status: 409 });
  });
});
