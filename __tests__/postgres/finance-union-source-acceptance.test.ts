import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { Currency } from "../../lib/money";

/**
 * Union acceptance (#422 + #425 + #423 + #424): the conservative visit financial-source
 * projection from #424 must not advertise work as covered merely because #425's approved
 * agreement funds an orthodontic case, or because #423 corrected an invoice's currency.
 * Coverage needs explicit linkage; otherwise the projection stays truthfully unresolved.
 * Synthetic data only.
 */

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_finance_union_source_test");
const db = await import("../../lib/db");
const auth = await import("../../lib/auth");
const { approveAgreement } = await import("../../lib/approved-agreements");
const revision = await import("../../lib/invoice-revision-db");
const { getVisitFinancialContext } = await import("../../lib/visit-financial-context-db");
const { clinicDateString } = await import("../../lib/schedule");
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
let session: SessionPayload;
let doctorId = 0;
let serviceId = 0;
let serial = 0;

beforeAll(async () => {
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-union-sources");
  const [user] = await q<{ id: number }>(`INSERT INTO users(username, display_name, password_hash, role, is_active)
    VALUES ('union-source-admin', 'Synthetic union reviewer', $1, 'admin', TRUE) RETURNING id`, [hash]);
  session = { userId: user.id, username: "union-source-admin", role: "admin",
    credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  [{ id: doctorId }] = await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Synthetic union doctor') RETURNING id`);
  [{ id: serviceId }] = await q<{ id: number }>(`INSERT INTO services(name, category, price_minor, price_configured, is_active)
    VALUES ('Synthetic union service', 'rct', 10000, TRUE, TRUE) RETURNING id`);
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function patient() {
  serial += 1;
  const name = `Synthetic union patient ${serial}`;
  const [{ id }] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`UNION-${serial}`, name]);
  return { id, name };
}

describe("#424 projection stays conservative with #425 approved-agreement funding", () => {
  it("an adjustment INCLUDED under an approved agreement is not advertised as covered on the signed visit", async () => {
    const owner = await patient();
    const [{ id: planId }] = await q<{ id: number }>(`INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, consent_at, consent_by)
      VALUES ($1, 'Synthetic approved orthodontic agreement', 900000, 'YER', NOW(), 'synthetic') RETURNING id`, [owner.id]);
    await approveAgreement({ planId, expectedTotalMinor: 900000, currency: "YER", source: { kind: "new" },
      reason: "Synthetic full orthodontic approval", idempotencyKey: `union-approve-${serial}`, session });
    const opened = await db.createOrthoCase({ patientId: owner.id, appliance: "fixed_metal", arches: "both", slot: "022",
      bracketSystem: null, startDate: today, plannedMonths: 18, planId, note: null, createdBy: "doctor" });
    if (!opened.ok) throw new Error(opened.message);
    const visit = await db.addVisit({ patientName: owner.name, patientPhone: null, note: null, patientId: owner.id, doctorId });
    const saved = await db.recordAdjustment({ caseId: opened.id, visitId: null, doneOn: today, phase: null, upperWire: "016 NiTi",
      lowerWire: null, elastics: "none", elasticNote: null, done: "Synthetic periodic adjustment", nextWeeks: 4, note: null,
      recordedBy: "doctor", actorRole: "doctor" });
    if (!saved.ok) throw new Error(saved.message);
    // #425: the approved agreement funds the case, so the adjustment is classified INCLUDED and signing bills nothing.
    expect((await db.getClinicalVisit(visit.id))?.ortho?.adjustmentBillingClass).toBe("INCLUDED");
    const signed = await db.signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });
    expect(signed).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0, orthoBillingClass: "INCLUDED" });

    const context = await getVisitFinancialContext(visit.id, owner.id);
    expect(context?.signed).toBe(true);
    expect(context?.summary).not.toBe("verified");
    const adjustment = context?.work.find(line => line.kind === "orthodontic_adjustment");
    expect(adjustment).toMatchObject({ coverage: "unresolved", decision: "none", recordedClassification: "INCLUDED" });
    expect(adjustment?.reasons).toContain("adjustment_source_unresolved");
    expect(adjustment?.references.some(source => source.state === "current")).toBe(false);
  });
});

describe("#424 projection stays conservative with #423 cross-currency correction lineage", () => {
  async function procedureInvoice(currency: Currency) {
    const owner = await patient();
    const [{ id: visitId }] = await q<{ id: number }>(`INSERT INTO visits(patient_name, patient_id, status, signed_at, arrived_at, billing_currency)
      VALUES ($1, $2, 'done', NOW(), NOW(), $3) RETURNING id`, [owner.name, owner.id, currency]);
    const [{ id: procedureId }] = await q<{ id: string }>(`INSERT INTO visit_procedures(visit_id, service_id, quantity, unit_price_minor, tooth_code)
      VALUES ($1, $2, 1, 10000, 16) RETURNING id::text`, [visitId, serviceId]);
    const invoice = await db.createInvoice({ patientId: owner.id, baseCurrency: currency, discountMinor: 0, note: null, createdBy: session.username,
      items: [{ serviceId, doctorId: null, description: "Synthetic union line", quantity: 1, unitPriceMinor: 10000 }] });
    if (!invoice) throw new Error("invoice missing");
    // The explicit visit-procedure linkage #424 recognises as a direct source.
    await q(`UPDATE invoice_items SET source_type = 'visit_procedure', source_id = $2 WHERE invoice_id = $1`, [invoice.id, Number(procedureId)]);
    return { owner, visitId, invoiceId: invoice.id };
  }

  it("control: the exact same-currency source is verified before any correction", async () => {
    const { owner, visitId, invoiceId } = await procedureInvoice("YER");
    const context = await getVisitFinancialContext(visitId, owner.id);
    expect(context?.summary).toBe("verified");
    expect(context?.work[0].references).toContainEqual({ kind: "invoice", id: invoiceId, state: "current", path: "visit_procedure" });
  });

  it("read side: #423 offers no cross-currency correction for a visit-bound invoice, and the visit keeps its exact source", async () => {
    const { owner, visitId, invoiceId } = await procedureInvoice("SAR");
    const view = await revision.readInvoiceRevision(invoiceId, session);
    expect(view.currencyCorrection).toMatchObject({ available: false, targets: [], reasonCodes: ["INDEPENDENT_ITEM_SOURCE"] });
    expect(view.currencyCorrection?.message).toMatch(/[\u0600-\u06FF]/);
    // Read-side readiness only (the writer is exercised below); the exact original source remains the only, current one.
    expect(await q(`SELECT count(*)::int AS n FROM invoices WHERE patient_id = $1`, [owner.id])).toEqual([{ n: 1 }]);
    expect(await q(`SELECT count(*)::int AS n FROM invoice_corrections WHERE patient_id = $1`, [owner.id])).toEqual([{ n: 0 }]);
    const context = await getVisitFinancialContext(visitId, owner.id);
    expect(context?.summary).toBe("verified");
    expect(context?.work[0].references).toEqual([{ kind: "invoice", id: invoiceId, state: "current", path: "visit_procedure" }]);
  });
  it("writer: reviseInvoice rejects an unpaid SAR → USD correction of a visit-bound invoice and writes nothing", async () => {
    const { owner, visitId, invoiceId } = await procedureInvoice("SAR");
    const view = await revision.readInvoiceRevision(invoiceId, session);
    const state = async () => ({
      invoices: await q(`SELECT to_jsonb(i) AS row FROM invoices i WHERE patient_id = $1 ORDER BY id`, [owner.id]),
      items: await q(`SELECT to_jsonb(ii) AS row FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.patient_id = $1 ORDER BY ii.id`, [owner.id]),
      payments: await q(`SELECT to_jsonb(p) AS row FROM payments p WHERE patient_id = $1 ORDER BY id`, [owner.id]),
      corrections: await q(`SELECT to_jsonb(c) AS row FROM invoice_corrections c WHERE patient_id = $1 ORDER BY id`, [owner.id]),
      reclassifications: await q(`SELECT id FROM invoice_settlement_reclassifications WHERE patient_id = $1`, [owner.id]),
      arrangements: await q(`SELECT id FROM debt_repayment_arrangements WHERE patient_id = $1`, [owner.id]),
    });
    const before = await state();
    const attempt = revision.reviseInvoice(invoiceId, { idempotencyKey: `union-writer-${++serial}`, expectedSourceHash: view.sourceHash,
      currency: "USD", reason: "Synthetic: a visit-bound invoice must not change currency",
      lines: view.invoice.items.map(item => ({ itemId: item.id, quantity: 1, unitPrice: "80" })),
      discount: "0", repaymentTerms: { mode: "installments", installments: [{ dueDate: "2026-11-14", kind: "installment", amountMinor: 8000 }] },
      expectedRemainingMinor: 8000 }, session);
    await expect(attempt).rejects.toMatchObject({ code: "conflict", reasonCodes: ["INDEPENDENT_ITEM_SOURCE"] });
    expect(await state()).toEqual(before);
    const context = await getVisitFinancialContext(visitId, owner.id);
    expect(context?.summary).toBe("verified");
    expect(context?.work[0].references).toEqual([{ kind: "invoice", id: invoiceId, state: "current", path: "visit_procedure" }]);
  });
});
