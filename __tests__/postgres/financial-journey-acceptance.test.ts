import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { Currency } from "../../lib/money";
import type { AgreementSource } from "../../lib/approved-agreements";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { invoiceCatalogRequestFingerprint, invoiceCommandFingerprint, parseInvoiceCommand } from "../../lib/invoice-template";

/** Synthetic integration witnesses, not production repairs. All principal and receipt
 * transitions use production functions. Direct SQL creates only synthetic identities,
 * configured catalogue data, and an explicitly labelled historical opening source.
 * Checkout limitation assertions describe the current narrower contract; they do not
 * certify it as a complete account-wide scheduled-due recommendation. */
assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_financial_journey_test");
const db = await import("../../lib/db");
const auth = await import("../../lib/auth");
const agreements = await import("../../lib/approved-agreements");
const { createLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const { saveDebtRepayment, debtRepaymentWorkspace } = await import("../../lib/debt-installments-db");
const { collectDebtInstallment } = await import("../../lib/debt-installment-collection");
const { visitCheckoutSummary } = await import("../../lib/checkout-db");
const { buildReport, parseFilters } = await import("../../lib/reports");
const { clinicDateString } = await import("../../lib/schedule");
const currencies = ["YER", "SAR", "USD"] as const;
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);
const future = "2099-12-01";
let session: SessionPayload;
let serial = 0;
let doctorId: number;
let serviceId: number;
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
const key = (purpose: string) => `journey-${purpose}-${++serial}`;

beforeAll(async () => {
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-journey-password");
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('journey-admin','Synthetic journey',$1,'admin',TRUE) RETURNING id", [hash]);
  session = { userId: user.id, username: "journey-admin", role: "admin", credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  doctorId = (await q("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic journey provider') RETURNING id"))[0].id;
  serviceId = (await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('Synthetic journey RCT',1000,TRUE,TRUE,'rct') RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function patient() {
  return (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic financial journey') RETURNING id", [key("patient")]))[0].id as number;
}
async function approvedPlan(patientId: number, currency: Currency, source: AgreementSource = { kind: "new" }) {
  const result = await db.createPlanV2({ patientId, title: "Synthetic full principal", specialty: null, primaryDoctorId: doctorId,
    billingMode: "installments", baseCurrency: currency, startDate: today, note: null, createdBy: session.username,
    items: [{ serviceId, serviceName: "Synthetic journey RCT", category: "rct", toothCode: 36, surfaces: null,
      quantity: 1, unitPriceMinor: 1000, billingRule: "per_session", sessionCount: 2, note: null }],
    installments: [{ dueDate: today, amountMinor: 400 }, { dueDate: future, amountMinor: 600 }] });
  if (!result.ok) throw new Error(result.message);
  await db.recordPlanConsent({ planId: result.planId, actor: session.username, note: null });
  const approval = { planId: result.planId, expectedTotalMinor: 1000, currency, source,
    reason: "Synthetic explicit principal approval", idempotencyKey: key("approve"), session };
  const saved = await agreements.approveAgreement(approval);
  expect((await agreements.approveAgreement(approval)).replayed).toBe(true);
  return { planId: result.planId, approval, saved };
}
async function position(patientId: number) {
  const ledger = await db.patientLedger(patientId);
  return db.ledgerBalancesByCurrency(patientId, ledger, new Map());
}
async function statement(patientId: number) {
  return buildReport("patient-statement", parseFilters(new URLSearchParams({ patientId: String(patientId), preset: "custom", from: "2000-01-01", to: "2099-12-31" })));
}
async function durable(patientId: number) {
  return q(`SELECT
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i WHERE patient_id=$1) AS invoices,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p WHERE patient_id=$1) AS payments,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY plan_id) FROM approved_agreement_principals a WHERE patient_id=$1) AS approvals,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY currency) FROM patient_opening_balances o WHERE patient_id=$1) AS openings,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM debt_repayment_revisions r JOIN debt_repayment_arrangements a ON a.id=r.arrangement_id WHERE a.patient_id=$1) AS revisions`, [patientId]);
}
async function collectApproved(planId: number, currency: Currency, amountMinor: number) {
  const command = { planId, currency, amountMinor, method: "cash" as const, note: null, idempotencyKey: key("approved-pay"), session };
  const saved = await agreements.collectApprovedAgreement(command);
  expect(await agreements.collectApprovedAgreement(command)).toMatchObject({ paymentId: saved.paymentId, replayed: true });
  return saved;
}

describe("principal to receipt to statements, with native currencies and no extra debt", () => {
  it("one account keeps three approved principals, allocations, and report balances separate through partial payment and refund", async () => {
    const patientId = await patient();
    const fixtures = [];
    for (const currency of currencies) {
      const plan = await approvedPlan(patientId, currency);
      const paid = await collectApproved(plan.planId, currency, 250);
      expect(paid.payment).toMatchObject({ invoiceId: plan.saved.agreement.invoice_id, planId: null, openingCurrency: null, amountMinor: 250, currency });
      fixtures.push({ currency, ...plan, paid });
    }
    const before = await durable(patientId);
    const workflow = await db.patientWorkflow(patientId, today);
    const balances = await position(patientId);
    const report = await statement(patientId);
    for (const { currency, planId } of fixtures) {
      expect(await db.getPlan(planId, today)).toMatchObject({ debtSource: "approved_agreement", paidMinor: 250,
        approvedAgreement: { totalMinor: 1000, paidMinor: 250, remainingMinor: 750, dueNowMinor: 150, available: true } });
      expect(balances[currency].dueMinor).toBe(750);
      expect(workflow.financial?.byCurrency[currency]).toMatchObject({ balanceMinor: 750,
        approvedAgreements: { count: 1, totalMinor: 1000, paidMinor: 250, remainingMinor: 750, dueNowMinor: 150 } });
      expect(report.kpis.find(kpi => kpi.key === (currency === "YER" ? "balance" : `balance-${currency}`))?.minor).toBe(750);
    }
    expect(await durable(patientId)).toEqual(before);
    const sar = fixtures.find(f => f.currency === "SAR")!;
    const refund = await db.recordPayment({ patientId, invoiceId: null, kind: "refund", amountMinor: 100, currency: "SAR", baseCurrency: "YER", exchangeRate: 999,
      method: "cash", note: "Synthetic refund only", createdBy: session.username, reversalOfId: sar.paid.paymentId, idempotencyKey: key("refund") });
    expect(refund.reason).toBeNull();
    expect(await agreements.approvedAgreementPosition(sar.planId, today)).toMatchObject({ paidMinor: 150, remainingMinor: 850, dueNowMinor: 250 });
    const after = await position(patientId);
    expect(currencies.map(currency => after[currency].dueMinor)).toEqual([750, 850, 750]);
    expect((await db.patientLedger(patientId)).invoices).toHaveLength(3);
    expect((await db.patientLedger(patientId)).payments).toHaveLength(4);
    const afterReport = await statement(patientId);
    expect(currencies.map(currency => afterReport.kpis.find(kpi => kpi.key === (currency === "YER" ? "balance" : `balance-${currency}`))?.minor)).toEqual([750, 850, 750]);
  });

  it.each(currencies)("%s historical approval uses opening principal without posting historical cash twice", async currency => {
    const patientId = await patient();
    await db.setPatientOpeningBalance({ patientId, currency, amountMinor: 700, asOfDate: today, note: "Synthetic historical source",
      createdBy: session.username, reason: "Synthetic historical source" });
    const plan = await approvedPlan(patientId, currency, { kind: "opening", historicalPaidMinor: 300 });
    const paid = await collectApproved(plan.planId, currency, 100);
    expect(paid.payment).toMatchObject({ invoiceId: null, planId: null, openingCurrency: currency });
    expect(await agreements.approvedAgreementPosition(plan.planId, today)).toMatchObject({ totalMinor: 1000, paidMinor: 400, remainingMinor: 600, dueNowMinor: 0 });
    const ledger = await db.patientLedger(patientId);
    expect(ledger.invoices).toHaveLength(0);
    expect(ledger.payments).toHaveLength(1);
    expect((await position(patientId))[currency].dueMinor).toBe(600);
    expect((await statement(patientId)).kpis.find(kpi => kpi.key === (currency === "YER" ? "balance" : `balance-${currency}`))?.minor).toBe(600);
  });

  it.each(currencies)("%s approved included clinical work does not post a second invoice; checkout omission is explicit", async currency => {
    const patientId = await patient();
    const plan = await approvedPlan(patientId, currency);
    await collectApproved(plan.planId, currency, 250);
    const [item] = await q("SELECT id FROM plan_items WHERE plan_id=$1", [plan.planId]);
    const visit = await db.addVisit({ patientId, patientName: "Synthetic journey", patientPhone: null, note: null, doctorId });
    await q("UPDATE visits SET diagnosis='Synthetic journey coverage',billing_currency=$2 WHERE id=$1", [visit.id, currency]);
    expect(await db.setVisitProcedures({ visitId: visit.id, procedures: [{ serviceId, toothCode: 36, surfaces: null, quantity: 1,
      unitPriceMinor: 500, priceReason: null, doctorId, note: null, planItemId: item.id }] })).toBe(true);
    expect(await db.signClinicalVisit({ visitId: visit.id, baseCurrency: currency, signedBy: session.username })).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0 });
    const before = await durable(patientId);
    const walkout = await db.visitWalkout(visit.id);
    expect(walkout).not.toBeNull();
    expect(walkout!.lines).toEqual([expect.objectContaining({ included: true, billingClass: "INCLUDED", currency })]);
    const checkout = await visitCheckoutSummary(walkout!);
    const agreement = await agreements.approvedAgreementPosition(plan.planId, today);
    expect(checkout.find(row => row.currency === currency)).toMatchObject({ currentBalanceMinor: 750, todayRemainingMinor: 0, dueNowMinor: 0 });
    expect(agreement).toMatchObject({ remainingMinor: 750, dueNowMinor: 150 });
    console.info("SYNTHETIC_CHECKOUT_AGREEMENT_GAP", JSON.stringify({ currency, principal: 1000, paid: 250, totalRemaining: 750, scheduledDueNow: agreement!.dueNowMinor, checkoutDueNow: checkout.find(row => row.currency === currency)!.dueNowMinor }));
    expect(await durable(patientId)).toEqual(before);
    expect((await db.patientLedger(patientId)).invoices).toHaveLength(1);
  });
});

describe("invoice-backed installment collection and visit checkout", () => {
  it.each(currencies)("%s invoice-origin plan projects the same scheduled debt without classifying it as an approved or classic principal", async currency => {
    const patientId = await patient();
    const saved = await createLinkedInvoice({ patientId, baseCurrency: currency, discountMinor: 0, note: null, createdBy: session.username,
      actorRole: session.role, items: [{ serviceId, category: "rct", doctorId, description: "Synthetic invoice-origin RCT", quantity: 1,
        unitPriceMinor: 1000, toothCode: 36, caseId: null, sessions: null, surfaces: null }],
      templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: key("linked-invoice"), requestHash: key("linked-hash"), auditDetails: {} });
    if (!saved.ok || saved.planId === null) throw new Error("Synthetic invoice did not create its clinical plan");
    const schedule = await saveDebtRepayment({ target: { patientId, currency, invoiceId: saved.invoice.id, openingCurrency: null },
      terms: { mode: "installments", installments: [{ dueDate: today, amountMinor: 400, kind: "installment" }, { dueDate: future, amountMinor: 600, kind: "installment" }] },
      expectedVersion: 0, expectedRemainingMinor: 1000, reason: "Synthetic linked repayment", idempotencyKey: key("linked-schedule"), session });
    const paid = await collectDebtInstallment({ patientId, arrangementId: schedule.arrangementId, expectedVersion: 1, amountMinor: 250,
      currency, method: "cash", note: null, idempotencyKey: key("linked-pay"), session });
    expect(paid.payment).toMatchObject({ invoiceId: saved.invoice.id, planId: null, currency, amountMinor: 250 });
    const before = await durable(patientId);
    expect(await db.getPlan(saved.planId, today)).toMatchObject({ debtSource: "invoice", approvedAgreement: null, installments: [],
      paidMinor: 250, invoiceFinancial: { kind: "invoice_backed", paidMinor: 250, remainingMinor: 750 },
      progress: { totalMinor: 1000, paidMinor: 250, remainingMinor: 750, dueToDateMinor: 400, nextDueDate: today, nextDueAmountMinor: 150 } });
    expect((await db.patientWorkflow(patientId, today)).financial?.byCurrency[currency]).toMatchObject({ balanceMinor: 750,
      approvedAgreements: null, classicInstallments: null });
    expect((await statement(patientId)).kpis.find(kpi => kpi.key === (currency === "YER" ? "balance" : `balance-${currency}`))?.minor).toBe(750);
    expect(await durable(patientId)).toEqual(before);
    expect((await db.patientLedger(patientId)).invoices).toHaveLength(1);
    expect((await db.patientLedger(patientId)).payments).toHaveLength(1);
  });

  it("classic installments retain an unposted plan reference, not hidden full principal or double debt", async () => {
    const patientId = await patient();
    const created = await db.createPlanV2({ patientId, title: "Synthetic classic reference", specialty: null, primaryDoctorId: null,
      billingMode: "installments", baseCurrency: "YER", startDate: today, note: null, createdBy: session.username, items: [],
      installments: [{ dueDate: today, amountMinor: 400 }, { dueDate: future, amountMinor: 600 }] });
    if (!created.ok) throw new Error(created.message);
    const saved = await db.recordPlanInstallment({ planId: created.planId, patientId, installmentNumber: 1, planTitle: "Synthetic classic reference",
      amountMinor: 400, currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null,
      createdBy: session.username, actorRole: session.role, idempotencyKey: key("classic-pay") });
    expect(saved).not.toHaveProperty("reason");
    const before = await durable(patientId);
    expect(await db.getPlan(created.planId, today)).toMatchObject({ debtSource: "classic_installments", approvedAgreement: null,
      invoiceFinancial: null, progress: { totalMinor: 1000, paidMinor: 400, remainingMinor: 600 } });
    expect((await db.patientWorkflow(patientId, today)).financial?.byCurrency.YER).toMatchObject({ balanceMinor: 0,
      approvedAgreements: null, classicInstallments: { totalMinor: 1000, paidMinor: 400, remainingMinor: 600 } });
    expect((await statement(patientId)).kpis.find(kpi => kpi.key === "balance")?.minor).toBe(0);
    expect(await durable(patientId)).toEqual(before);
    const ledger = await db.patientLedger(patientId);
    expect(ledger.invoices).toHaveLength(1);
    expect(ledger.payments).toHaveLength(1);
    expect(ledger.invoices[0].totalMinor).toBe(400);
    expect(ledger.payments[0]).toMatchObject({ planId: created.planId, invoiceId: ledger.invoices[0].id, amountMinor: 400 });
  });

  it.each(currencies)("%s explicit visit invoice retains one principal and receipt but checkout currently asks full remaining, not scheduled due", async currency => {
    const patientId = await patient();
    const visit = await db.addVisit({ patientId, patientName: "Synthetic scheduled checkout", patientPhone: null, note: null, doctorId });
    const source = { patientId, visitId: visit.id, currency, items: [{ description: "Synthetic separately charged fee", price: currency === "YER" ? "1000" : "10.00" }], discount: "0", idempotencyKey: key("invoice") };
    const parsed = parseInvoiceCommand(source, new Map(), new Set(), await db.getSettings(), true);
    if (!parsed.ok) throw new Error(parsed.message);
    const { authorityLines: _authority, template: _template, ...values } = parsed; void _authority; void _template;
    const request = { ...values, createdBy: session.username, actorRole: session.role, templates: DEFAULT_SPECIALTY_TEMPLATES,
      requestHash: invoiceCatalogRequestFingerprint(source, session), auditDetails: {}, catalogueAuthority: { source, fingerprint: invoiceCommandFingerprint(parsed), session } };
    const saved = await createLinkedInvoice(request);
    if (!saved.ok) throw new Error(saved.reason);
    expect((await createLinkedInvoice(request))).toMatchObject({ ok: true, replayed: true, invoice: { id: saved.invoice.id } });
    const schedule = await saveDebtRepayment({ target: { patientId, currency, invoiceId: saved.invoice.id, openingCurrency: null },
      terms: { mode: "installments", installments: [{ dueDate: today, amountMinor: 400, kind: "installment" }, { dueDate: future, amountMinor: 600, kind: "installment" }] },
      expectedVersion: 0, expectedRemainingMinor: 1000, reason: "Synthetic future installment", idempotencyKey: key("schedule"), session });
    const collection = { patientId, arrangementId: schedule.arrangementId, expectedVersion: 1, amountMinor: 250, currency, method: "cash" as const,
      note: null, idempotencyKey: key("installment"), session };
    const paid = await collectDebtInstallment(collection);
    expect(await collectDebtInstallment(collection)).toMatchObject({ replayed: true, payment: { id: paid.payment!.id } });
    expect(paid.payment).toMatchObject({ invoiceId: saved.invoice.id, planId: null, openingCurrency: null, amountMinor: 250, currency });
    const before = await durable(patientId);
    const workspace = await debtRepaymentWorkspace(patientId, today);
    const entry = workspace.arrangements.find(row => row.id === schedule.arrangementId)!;
    expect(entry.requiresReview).toBe(false);
    expect(entry.progress?.rows.map(row => row.remainingMinor)).toEqual([150, 600]);
    expect(entry.remainingMinor).toBe(750);
    const walkout = await db.visitWalkout(visit.id);
    expect(walkout!.invoice).toMatchObject({ id: saved.invoice.id, netMinor: 1000, currency });
    const line = (await visitCheckoutSummary(walkout!)).find(row => row.currency === currency)!;
    expect(line).toMatchObject({ currentBalanceMinor: 750, newBillableMinor: 1000, todayRemainingMinor: 750, dueNowMinor: 750 });
    const scheduledDueNow = entry.progress!.rows.filter(row => row.dueDate <= today).reduce((sum, row) => sum + row.remainingMinor, 0);
    expect(scheduledDueNow).toBe(150);
    console.info("SYNTHETIC_CHECKOUT_INVOICE_SCHEDULE_GAP", JSON.stringify({ currency, totalRemaining: 750, scheduledDueNow, checkoutDueNow: line.dueNowMinor }));
    expect((await position(patientId))[currency].dueMinor).toBe(750);
    expect((await statement(patientId)).kpis.find(kpi => kpi.key === (currency === "YER" ? "balance" : `balance-${currency}`))?.minor).toBe(750);
    expect(await durable(patientId)).toEqual(before);
    expect((await db.patientLedger(patientId)).invoices).toHaveLength(1);
    expect((await db.patientLedger(patientId)).payments).toHaveLength(1);
  });
});
