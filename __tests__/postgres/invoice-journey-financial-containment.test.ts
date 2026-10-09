import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";

/** Independent negative witnesses. These assert the intended safety contract, not the old
 * behaviour (cancellation silently rebilled; any ortho invoice funded all adjustments).
 * Normal transitions use real services. Deliberately labelled historical/corrupt fixtures
 * below simulate old persisted records that safe readers must also handle.
 */
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const { createLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const { ensureSchema, getPool, resetPoolForTesting } = db;

async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, values)).rows as T[];
}
let doctorId = 0;
let fillingId = 0;
let orthoId = 0;
let serial = 0;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  doctorId = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'طبيب شاهد القبول') RETURNING id`))[0].id;
  for (const category of ["filling", "ortho"] as const) {
    const id = (await q<{ id: number }>(`INSERT INTO services
      (name, category, price_minor, price_configured, is_active)
      VALUES ($1, $1, 100000, TRUE, TRUE) RETURNING id`, [category]))[0].id;
    if (category === "filling") fillingId = id; else orthoId = id;
  }
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function patient() {
  serial += 1;
  return (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'مريض قبول اصطناعي') RETURNING id`, [`INV-CONTAIN-${serial}`]))[0].id;
}
function input(patientId: number, category: "filling" | "ortho" = "filling", quantity = 1) {
  return {
    patientId, baseCurrency: "YER" as const, discountMinor: 0, note: null,
    createdBy: "acceptance-reception", actorRole: "reception", templates: DEFAULT_SPECIALTY_TEMPLATES,
    idempotencyKey: null, requestHash: null, auditDetails: {},
    items: [{ serviceId: category === "filling" ? fillingId : orthoId, category,
      doctorId, description: category, quantity, unitPriceMinor: 100000,
      toothCode: category === "filling" ? 26 : null, surfaces: category === "filling" ? "MO" : null,
      scope: category === "ortho" ? "both" as const : null, caseId: null, sessions: null }],
  };
}
async function invoiced(patientId: number, category: "filling" | "ortho" = "filling", quantity = 1) {
  const result = await createLinkedInvoice(input(patientId, category, quantity));
  if (!result.ok) throw new Error(`Fixture invoice refused: ${result.reason}`);
  const planItemId = result.links[0].planItemId;
  if (!planItemId || !result.planId) throw new Error("Invoice did not return its treatment identity");
  return { ...result, planItemId, planId: result.planId };
}
async function consent(planId: number) {
  expect(await db.recordPlanConsent({ planId, actor: "acceptance-reception", note: "موافقة اصطناعية صريحة" }))
    .toMatchObject({ ok: true });
}
async function staged(patientId: number, planItemId: number | null, quantity = 1) {
  const visit = await db.addVisit({ patientId, patientName: "مريض قبول اصطناعي", patientPhone: null, note: null, doctorId });
  expect(await db.setVisitProcedures({ visitId: visit.id, procedures: [{
    serviceId: fillingId, toothCode: 26, surfaces: "MO", quantity, unitPriceMinor: 100000,
    priceReason: null, doctorId, note: null, planItemId,
  }] })).toBe(true);
  return visit.id;
}
const sign = (visitId: number) => db.signClinicalVisit({
  visitId, baseCurrency: "YER", signedBy: "acceptance-doctor", signerDoctorPartyId: doctorId, signerRole: "doctor",
});
async function durable(patientId: number, visitId: number) {
  return {
    invoices: await q(`SELECT id, status, total_minor::text FROM invoices WHERE patient_id = $1 ORDER BY id`, [patientId]),
    visit: await q(`SELECT signed_at, signed_by, invoice_id FROM visits WHERE id = $1`, [visitId]),
    procedures: await q(`SELECT id, plan_item_id, service_id, doctor_id, tooth_code, surfaces, quantity,
      unit_price_minor::text, note FROM visit_procedures WHERE visit_id = $1 ORDER BY id`, [visitId]),
    sessions: await q(`SELECT ts.id, ts.status, ts.visit_id FROM treatment_sessions ts
      JOIN plan_items pi ON pi.id = ts.plan_item_id JOIN treatment_plans tp ON tp.id = pi.plan_id
      WHERE tp.patient_id = $1 ORDER BY ts.id`, [patientId]),
    chart: await q(`SELECT id, tooth_code, condition, stage, surfaces FROM tooth_conditions WHERE patient_id = $1 ORDER BY id`, [patientId]),
    cases: await q(`SELECT id, status, site FROM clinical_cases WHERE patient_id = $1 ORDER BY id`, [patientId]),
  };
}

describe("Invoice-origin clinical work is financially contained", () => {
  it("an ordinary unlinked clinical draft has no financial review invented by a NULL plan-item join", async () => {
    const patientId = await patient();
    const visitId = await staged(patientId, null);
    const walkout = await db.visitWalkout(visitId);
    expect(walkout?.lines).toHaveLength(1);
    expect(walkout?.lines[0]).toMatchObject({ financialReviewRequired: false, included: false });
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toEqual([]);
  });

  it("invoice acceptance is not clinical consent; truthful drafts survive but sign requires explicit consent", async () => {
    const patientId = await patient();
    const created = await invoiced(patientId);
    expect((await q(`SELECT consent_at FROM treatment_plans WHERE id = $1`, [created.planId]))[0]).toEqual({ consent_at: null });
    const visit = await db.addVisit({ patientId, patientName: "مريض قبول اصطناعي", patientPhone: null, note: null, doctorId });
    const draftView = await db.getClinicalVisit(visit.id);
    expect(draftView?.outstanding.find((item) => item.planItemId === created.planItemId))
      .toMatchObject({ toothCode: 26, surfaces: "MO", clinicalConsentRecorded: false });
    const procedure = { serviceId: fillingId, toothCode: 26, surfaces: "MO", quantity: 1,
      unitPriceMinor: 0, priceReason: null, doctorId, note: null, planItemId: created.planItemId };
    expect(await db.setVisitProcedures({ visitId: visit.id, procedures: [procedure] })).toBe(true);
    const before = await durable(patientId, visit.id);
    await expect(sign(visit.id)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await durable(patientId, visit.id)).toEqual(before);
    await consent(created.planId);
    expect(await db.setVisitProcedures({ visitId: visit.id, procedures: [procedure] })).toBe(true);
    expect(await sign(visit.id)).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0 });
    expect((await db.getClinicalVisit(visit.id))?.procedures[0]).toMatchObject({
      planItemId: created.planItemId, toothCode: 26, surfaces: "MO", doctorId,
    });
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toHaveLength(1);
  });

  it("unknown financial provider is not silently assigned to the first clinician; truthful draft care remains saved", async () => {
    const patientId = await patient();
    const request = input(patientId);
    const created = await createLinkedInvoice({ ...request, items: request.items.map((item) => ({ ...item, doctorId: null })) });
    if (!created.ok || !created.planId || !created.links[0].planItemId) throw new Error("Expected the invoice-origin review identity");
    await consent(created.planId);
    const visitId = await staged(patientId, created.links[0].planItemId);
    const before = await durable(patientId, visitId);
    await expect(sign(visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await durable(patientId, visitId)).toEqual(before);
    const walkout = await db.visitWalkout(visitId);
    expect(walkout?.lines[0]).toMatchObject({ financialReviewRequired: true });
    expect(walkout?.lines[0].billingClass).not.toBe("INCLUDED");
    expect(await q(`SELECT doctor_id FROM invoice_items WHERE invoice_id = $1`, [created.invoice.id])).toEqual([{ doctor_id: null }]);
    expect(await q(`SELECT doctor_id FROM visit_procedures WHERE visit_id = $1`, [visitId])).toEqual([{ doctor_id: doctorId }]);
  });

  it("an unlinked prepaid SINGLE-session procedure cannot silently create a second obligation", async () => {
    const patientId = await patient();
    const created = await invoiced(patientId);
    await consent(created.planId);
    const visitId = await staged(patientId, null);
    const before = await durable(patientId, visitId);
    expect(await sign(visitId)).toMatchObject({ reason: "plan_session_unlinked", invoiceId: null });
    expect(await durable(patientId, visitId)).toEqual(before);
  });

  it("cancel AFTER staging preserves origin and refuses signing without rebilling or advancing clinical work", async () => {
    const patientId = await patient();
    const created = await invoiced(patientId);
    await consent(created.planId);
    const visitId = await staged(patientId, created.planItemId);
    expect(await db.setInvoiceStatus(created.invoice.id, "cancelled", { actor: "acceptance-admin", actorRole: "admin" })).not.toBeNull();
    expect((await q(`SELECT billing_status, billed_invoice_id, origin_invoice_id FROM plan_items WHERE id = $1`, [created.planItemId]))[0])
      .toEqual({ billing_status: "needs_financial_review", billed_invoice_id: created.invoice.id, origin_invoice_id: created.invoice.id });
    const before = await durable(patientId, visitId);
    await expect(sign(visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await durable(patientId, visitId)).toEqual(before);
    const repeated = await createLinkedInvoice(input(patientId));
    expect(repeated.ok).toBe(false);
    expect(await durable(patientId, visitId)).toEqual(before);
    const walkout = await db.visitWalkout(visitId);
    expect(walkout?.lines[0]).toMatchObject({ financialReviewRequired: true });
    expect(walkout?.lines[0].billingClass).not.toBe("INCLUDED");
    expect(await q(`SELECT pi.id FROM plan_items pi JOIN treatment_plans tp ON tp.id = pi.plan_id WHERE tp.patient_id = $1`, [patientId]))
      .toEqual([{ id: created.planItemId }]);
  });

  it.each(["quantity", "unit_price"] as const)("%s correction retains lineage but cannot cover the old full treatment", async (change) => {
    const patientId = await patient();
    const created = await invoiced(patientId, "filling", 2);
    await consent(created.planId);
    const visitId = await staged(patientId, created.planItemId, 2);
    const [{ id: invoiceItemId }] = await q<{ id: number }>(`SELECT id FROM invoice_items WHERE invoice_id = $1`, [created.invoice.id]);
    const corrected = await db.correctInvoice({ invoiceId: created.invoice.id, actor: "acceptance-admin", actorRole: "admin",
      reason: "تصحيح اصطناعي لشكل الالتزام", lines: [{ itemId: invoiceItemId,
        quantity: change === "quantity" ? 1 : 2, unitPriceMinor: change === "unit_price" ? 50000 : 100000 }] });
    if (!corrected.ok) throw new Error(corrected.message);
    expect(await q(`SELECT plan_item_id FROM invoice_items WHERE invoice_id = $1`, [corrected.corrected.id]))
      .toEqual([{ plan_item_id: created.planItemId }]);
    expect((await q(`SELECT billing_status, origin_invoice_id FROM plan_items WHERE id = $1`, [created.planItemId]))[0])
      .toEqual({ billing_status: "needs_financial_review", origin_invoice_id: created.invoice.id });
    const before = await durable(patientId, visitId);
    await expect(sign(visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await durable(patientId, visitId)).toEqual(before);
    expect((await createLinkedInvoice(input(patientId, "filling", 2))).ok).toBe(false);
    expect(await durable(patientId, visitId)).toEqual(before);
  });

  it("an ordinary ortho invoice is not an unlimited funded adjustment package", async () => {
    const patientId = await patient();
    const created = await invoiced(patientId, "ortho");
    await consent(created.planId);
    const opened = await db.createOrthoCase({ patientId, appliance: "fixed_metal", arches: "both", slot: "022",
      bracketSystem: null, startDate: "2026-10-07", plannedMonths: 18, planId: created.planId,
      note: "حالة اصطناعية", createdBy: "acceptance-doctor" });
    if (!opened.ok) throw new Error(opened.message);
    expect((await q<{ funded: boolean }>(`SELECT ${db.ORTHO_CASE_FUNDED_SQL} AS funded FROM ortho_cases c WHERE c.id = $1`, [opened.id]))[0].funded)
      .toBe(false);
    expect(await q(`SELECT id FROM clinical_cases WHERE patient_id = $1`, [patientId])).toHaveLength(1);
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toHaveLength(1);
  });

  it.each(["successive", "same_request"] as const)("overlapping Ortho both→upper scopes cannot duplicate one obligation (%s)", async (mode) => {
    const patientId = await patient();
    const request = input(patientId, "ortho");
    if (mode === "successive") await invoiced(patientId, "ortho");
    const upper = { ...request.items[0], scope: "upper" };
    const result = await createLinkedInvoice({ ...request,
      items: mode === "same_request" ? [...request.items, upper] : [upper] });
    expect(result.ok).toBe(false);
    const count = mode === "successive" ? 1 : 0;
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toHaveLength(count);
    expect(await q(`SELECT pi.id FROM plan_items pi JOIN treatment_plans tp ON tp.id = pi.plan_id WHERE tp.patient_id = $1`, [patientId]))
      .toHaveLength(count);
    expect(await q(`SELECT id FROM clinical_cases WHERE patient_id = $1`, [patientId])).toHaveLength(count);
  });

  it.each(["successive", "same_request"] as const)("disjoint Ortho upper/lower work remains legitimate (%s)", async (mode) => {
    const patientId = await patient();
    const request = input(patientId, "ortho");
    const upper = { ...request.items[0], scope: "upper" };
    const lower = { ...request.items[0], scope: "lower" };
    if (mode === "successive") {
      expect((await createLinkedInvoice({ ...request, items: [upper] })).ok).toBe(true);
    }
    const result = await createLinkedInvoice({ ...request,
      items: mode === "same_request" ? [upper, lower] : [lower] });
    expect(result.ok).toBe(true);
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toHaveLength(mode === "successive" ? 2 : 1);
    expect(await q(`SELECT pi.id FROM plan_items pi JOIN treatment_plans tp ON tp.id = pi.plan_id WHERE tp.patient_id = $1`, [patientId]))
      .toHaveLength(2);
    const cases = await q<{ site: string }>(`SELECT site FROM clinical_cases WHERE patient_id = $1`, [patientId]);
    expect(cases.map((row) => row.site).sort()).toEqual(["الفك العلوي", "الفك السفلي"].sort());
  });

  it("historical cancellation with cleared invoice IDs still has invoice-line history and cannot be rebilled", async () => {
    const patientId = await patient();
    const plan = await db.createPlanV2({ patientId, title: "خطة سابقة اصطناعية", specialty: null, primaryDoctorId: doctorId,
      billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-10-07", note: null,
      items: [{ serviceId: fillingId, serviceName: "filling", category: "filling", toothCode: 26, surfaces: "MO",
        quantity: 1, unitPriceMinor: 100000, billingRule: "per_session", sessionCount: 1, note: null }],
      installments: [], createdBy: "acceptance-reception" });
    if (!plan.ok) throw new Error(plan.message);
    await consent(plan.planId);
    const originalItems = await q<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1`, [plan.planId]);
    const result = await createLinkedInvoice(input(patientId));
    if (!result.ok || !result.links[0].planItemId) throw new Error("Expected invoice to reuse the existing plan item");
    const created = { ...result, planItemId: result.links[0].planItemId };
    expect(created.planItemId).toBe(originalItems[0].id);
    const visitId = await staged(patientId, created.planItemId);
    await db.setInvoiceStatus(created.invoice.id, "cancelled", { actor: "acceptance-admin", actorRole: "admin" });
    // Historical fixture, not the desired cancellation writer: older versions cleared
    // these columns on a reused plan-origin item, but retained its invoice_items lineage.
    await q(`UPDATE plan_items SET billed_invoice_id = NULL, origin_invoice_id = NULL,
      billing_status = 'unbilled', origin = NULL WHERE id = $1`, [created.planItemId]);
    expect(await q(`SELECT plan_item_id FROM invoice_items WHERE invoice_id = $1`, [created.invoice.id]))
      .toEqual([{ plan_item_id: created.planItemId }]);
    const before = await durable(patientId, visitId);
    await expect(sign(visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect((await createLinkedInvoice(input(patientId))).ok).toBe(false);
    expect(await db.schedulePlanInstallments({ planId: plan.planId, count: 2, everyDays: 30, firstDueDate: "2026-10-07" }))
      .toMatchObject({ ok: false });
    expect(await q(`SELECT id FROM plan_installments WHERE plan_id = $1`, [plan.planId])).toEqual([]);
    expect(await durable(patientId, visitId)).toEqual(before);
  });

  it.each(["source_type", "source_id"] as const)("matching amount with wrong %s is not proof of prepaid coverage", async (field) => {
    const patientId = await patient();
    const created = await invoiced(patientId);
    await consent(created.planId);
    const visitId = await staged(patientId, created.planItemId);
    // Explicit corrupt fixture: the plan_item_id hint and amount remain plausible,
    // but the authoritative source identity no longer names this plan item.
    if (field === "source_type") {
      await q(`UPDATE invoice_items SET source_type = NULL WHERE invoice_id = $1`, [created.invoice.id]);
    } else {
      await q(`UPDATE invoice_items SET source_id = $2 WHERE invoice_id = $1`, [created.invoice.id, created.planItemId + 1000000]);
    }
    const before = await durable(patientId, visitId);
    await expect(sign(visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await durable(patientId, visitId)).toEqual(before);
    const walkout = await db.visitWalkout(visitId);
    expect(walkout?.lines[0]).toMatchObject({ financialReviewRequired: true });
    expect(walkout?.lines[0].billingClass).not.toBe("INCLUDED");
  });

  it("an authorized-style header discount retains exact clinical coverage and the original net obligation", async () => {
    const patientId = await patient();
    const created = await createLinkedInvoice({ ...input(patientId), discountMinor: 10000 });
    if (!created.ok || !created.planId || !created.links[0].planItemId) throw new Error("Discount fixture failed");
    expect(created.invoice.totalMinor - created.invoice.discountMinor).toBe(90000);
    await consent(created.planId);
    const visitId = await staged(patientId, created.links[0].planItemId);
    expect(await sign(visitId)).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0 });
    expect(await q(`SELECT total_minor::int, discount_minor::int FROM invoices WHERE patient_id = $1`, [patientId]))
      .toEqual([{ total_minor: 100000, discount_minor: 10000 }]);
  });

  it("removing an unrelated line in a discounted correction preserves unchanged linked work coverage", async () => {
    const patientId = await patient();
    const request = input(patientId);
    const created = await createLinkedInvoice({ ...request, discountMinor: 15000, items: [...request.items, {
      serviceId: null, category: null, doctorId: null, description: "رسم منفصل اصطناعي", quantity: 1, unitPriceMinor: 50000,
      toothCode: null, caseId: null, sessions: null,
    }] });
    if (!created.ok || !created.planId || !created.links[0].planItemId) throw new Error("Mixed discount fixture failed");
    await consent(created.planId);
    const visitId = await staged(patientId, created.links[0].planItemId);
    const [{ id }] = await q<{ id: number }>(`SELECT id FROM invoice_items WHERE invoice_id = $1 AND plan_item_id = $2`, [created.invoice.id, created.links[0].planItemId]);
    const correction = await db.correctInvoice({ invoiceId: created.invoice.id, actor: "admin", actorRole: "admin",
      reason: "حذف الرسم المنفصل", lines: [{ itemId: id, quantity: 1, unitPriceMinor: 100000 }] });
    if (!correction.ok) throw new Error(correction.message);
    // Existing correction policy preserves the header discount, capped at the new total.
    expect(correction.corrected.totalMinor - correction.corrected.discountMinor).toBe(85000);
    expect(await sign(visitId)).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0 });
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toHaveLength(2);
    expect((await q(`SELECT billing_status, billed_invoice_id, origin_invoice_id FROM plan_items WHERE id = $1`, [created.links[0].planItemId]))[0])
      .toEqual({ billing_status: "billed", billed_invoice_id: correction.corrected.id, origin_invoice_id: created.invoice.id });
  });

  it("a full header discount cannot hide a quantity change even when the net remains zero", async () => {
    const patientId = await patient();
    const created = await createLinkedInvoice({ ...input(patientId, "filling", 2), discountMinor: 200000 });
    if (!created.ok || !created.planId || !created.links[0].planItemId) throw new Error("Full discount fixture failed");
    await consent(created.planId);
    const visitId = await staged(patientId, created.links[0].planItemId, 2);
    const [{ id }] = await q<{ id: number }>(`SELECT id FROM invoice_items WHERE invoice_id = $1`, [created.invoice.id]);
    const correction = await db.correctInvoice({ invoiceId: created.invoice.id, actor: "admin", actorRole: "admin",
      reason: "تصحيح الكمية رغم الخصم الكامل", lines: [{ itemId: id, quantity: 1, unitPriceMinor: 100000 }] });
    if (!correction.ok) throw new Error(correction.message);
    expect(created.invoice.totalMinor - created.invoice.discountMinor).toBe(0);
    expect(correction.corrected.totalMinor - correction.corrected.discountMinor).toBe(0);
    const before = await durable(patientId, visitId);
    await expect(sign(visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
    expect(await durable(patientId, visitId)).toEqual(before);
  });
});
