import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { Currency } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { applyRuntimeMigrationFiles, loadMigrationFiles } from "../../lib/migrations";
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_amended_plan_summary_test");
let session: SessionPayload;
vi.mock("../../lib/session", async original => ({ ...await original<typeof import("../../lib/session")>(), requireSession: async () => session }));
vi.mock("../../components/PrintHeader", () => ({ PrintHeader: () => null }));
vi.mock("../../components/PrintButton", () => ({ PrintButton: () => null }));
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const { createLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const { approveAgreement, collectApprovedAgreement } = await import("../../lib/approved-agreements");
const { readAgreementAmendment, saveAgreementAmendment } = await import("../../lib/agreement-amendment-db");
const patientRoute = await import("../../app/api/patients/[id]/plans/route");
const printPage = (await import("../../app/print/plan/[id]/page")).default;
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let serial = 0;
beforeAll(async () => {
  await db.ensureSchema();
  const files = await loadMigrationFiles();
  await applyRuntimeMigrationFiles(db.getPool(), files.filter(file => file.version === "0066"));
  const hash = await auth.hashPassword("synthetic-summary-only-password");
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('summary-admin','Synthetic summary admin',$1,'admin',TRUE) RETURNING id", [hash]);
  session = { userId: user.id, username: "summary-admin", role: "admin", credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3600000 };
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
}, 180000);
afterAll(async () => db.resetPoolForTesting());
async function fixture(currency: Currency, discountMinor = 0) {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic summary patient') RETURNING id", [`SUMMARY-${++serial}`]);
  const [doctor] = await q("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic summary provider') RETURNING id");
  const [service] = await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('Synthetic metal crown',500000,TRUE,TRUE,'crown') RETURNING id");
  const [upgrade] = await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('Synthetic zirconia crown',800000,TRUE,TRUE,'crown') RETURNING id");
  const created = await createLinkedInvoice({ patientId: patient.id, baseCurrency: currency, discountMinor, note: null, createdBy: session.username, actorRole: "admin", items: [{ serviceId: service.id, category: "crown", doctorId: doctor.id, description: "Synthetic metal crown", quantity: 1, unitPriceMinor: 500000, toothCode: 36, caseId: null, sessions: null, surfaces: null, episodeTeeth: null, scope: null }], templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: null, requestHash: null, auditDetails: {} });
  if (!created.ok || created.planId === null) throw Error(`Synthetic invoice-first linkage failed: ${JSON.stringify(created)}`);
  expect(await db.recordPlanConsent({ planId: created.planId, actor: session.username, note: "Synthetic consent only" })).toMatchObject({ ok: true });
  if (discountMinor) {
    await expect(approveAgreement({ planId: created.planId, expectedTotalMinor: 500000, currency, source: { kind: "invoice", invoiceId: created.invoice.id }, reason: "Synthetic mismatch refusal", idempotencyKey: `summary-discount-approval-${serial}`, session })).rejects.toThrow();
    const receipt = await db.recordPayment({ patientId: patient.id, invoiceId: created.invoice.id, kind: "payment", amountMinor: 180000, currency, baseCurrency: "YER", exchangeRate: 1, method: "cash", note: "Synthetic discounted receipt", createdBy: session.username });
    expect(receipt.reason).toBeFalsy();
    return { patientId: patient.id as number, planId: created.planId, invoiceId: created.invoice.id, paymentId: receipt.payment!.id, serviceId: upgrade.id as number, currency };
  }
  await approveAgreement({ planId: created.planId, expectedTotalMinor: 500000 - discountMinor, currency, source: { kind: "invoice", invoiceId: created.invoice.id }, reason: "Synthetic full source matching", idempotencyKey: `summary-approval-${serial}`, session });
  const receipt = await collectApprovedAgreement({ planId: created.planId, amountMinor: 180000, currency, method: "cash", note: "Synthetic initial receipt", idempotencyKey: `summary-payment-${serial}`, session });
  return { patientId: patient.id as number, planId: created.planId, invoiceId: created.invoice.id, paymentId: receipt.paymentId, serviceId: upgrade.id as number, currency };
}
async function amend(f: Awaited<ReturnType<typeof fixture>>, price: number) {
  const view = await readAgreementAmendment(f.planId, session);
  return saveAgreementAmendment(f.planId, { idempotencyKey: `summary-upgrade-${++serial}`, expectedSourceHash: view.sourceHash, newServiceId: f.serviceId, newUnitMinor: price, reason: "Synthetic documented upgrade consent" }, session);
}
async function assertParity(f: Awaited<ReturnType<typeof fixture>>, total: number, paid: number, original = 500000) {
  const today = "2099-12-31";
  const plan = await db.getPlan(f.planId, today);
  expect(plan).toMatchObject({ totalMinor: original, paidMinor: paid, progress: { totalMinor: total, paidMinor: paid, remainingMinor: total - paid }, approvedAgreement: { available: true, totalMinor: total, paidMinor: paid, remainingMinor: total - paid } });
  const response = await patientRoute.GET(new Request(`http://localhost/api/patients/${f.patientId}/plans`), { params: Promise.resolve({ id: String(f.patientId) }) });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.plans[0]).toMatchObject({ totalMinor: original, progress: { totalMinor: total, paidMinor: paid, remainingMinor: total - paid } });
  expect((await db.computeDebtRows([f.patientId])).find(row => row.currency === f.currency)?.dueMinor).toBe(total - paid);
  const html = renderToStaticMarkup(await printPage({ params: Promise.resolve({ id: String(f.planId) }) }));
  expect(html).toContain('data-testid="current-plan-financial-summary"');
  const summary = html.split('data-testid="current-plan-financial-summary"')[1].split('data-testid="original-plan-agreement"')[0];
  for (const amount of [total, paid, total - paid]) expect(summary).toContain(formatMoney(amount, f.currency));
  expect(summary).not.toContain(formatMoney(original - paid, f.currency));
  expect(html).toContain("قيمة الاتفاق الأصلي قبل التعديلات");
  expect(html).toContain(formatMoney(original, f.currency));
  return plan;
}
it.each(["YER", "SAR", "USD"] as const)("keeps %s invoice-first approved history and current plan/API/print parity through repeated upgrades and refund", async currency => {
  const f = await fixture(currency);
  const originalPlan = await immutablePlanRows(f.planId);
  const original = await q("SELECT to_jsonb(i) AS value FROM invoices i WHERE id=$1", [f.invoiceId]);
  const approval = await q("SELECT to_jsonb(a) AS value FROM approved_agreement_principals a WHERE plan_id=$1", [f.planId]);
  const receipt = await q("SELECT to_jsonb(p) AS value FROM payments p WHERE id=$1", [f.paymentId]);
  await amend(f, 800000);
  await assertParity(f, 800000, 180000);
  await amend(f, 900000);
  await assertParity(f, 900000, 180000);
  const refund = await db.recordPayment({ patientId: f.patientId, invoiceId: null, planId: null, openingCurrency: null, kind: "refund", amountMinor: 20000, currency, baseCurrency: "YER", exchangeRate: 999, method: "cash", note: "Synthetic refund", createdBy: session.username, reversalOfId: f.paymentId });
  expect(refund.reason).toBeFalsy();
  await assertParity(f, 900000, 160000);
  expect(await q("SELECT to_jsonb(i) AS value FROM invoices i WHERE id=$1", [f.invoiceId])).toEqual(original);
  expect(await q("SELECT to_jsonb(a) AS value FROM approved_agreement_principals a WHERE plan_id=$1", [f.planId])).toEqual(approval);
  expect(await q("SELECT to_jsonb(p) AS value FROM payments p WHERE id=$1", [f.paymentId])).toEqual(receipt);
  expect(await q("SELECT id FROM agreement_delta_amendments WHERE plan_id=$1", [f.planId])).toHaveLength(2);
  expect(await immutablePlanRows(f.planId)).toEqual(originalPlan);
  expect(await db.setPlanStatus(f.planId, "completed", { actor: session.username, actorRole: session.role, reason: null })).toBe("ok");
  expect((await assertParity(f, 900000, 160000))?.status).toBe("completed");
});

async function scheduledFixture() {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic scheduled summary') RETURNING id", [`SCHEDULE-${++serial}`]);
  const [service] = await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('Synthetic scheduled crown',500000,TRUE,TRUE,'crown') RETURNING id");
  const p = await db.createPlanV2({ patientId: patient.id, title: "Synthetic scheduled agreement", specialty: null, primaryDoctorId: null, billingMode: "installments", baseCurrency: "YER", startDate: "2026-10-01", note: null, createdBy: session.username,
    items: [{ serviceId: service.id, serviceName: "Synthetic scheduled crown", category: "crown", toothCode: 36, surfaces: null, quantity: 1, unitPriceMinor: 500000, billingRule: "on_completion", sessionCount: 1, note: null }],
    installments: [{ dueDate: "2026-10-01", amountMinor: 250000 }, { dueDate: "2026-12-01", amountMinor: 250000 }] });
  if (!p.ok) throw Error(p.message);
  const draft = await db.getPlan(p.planId, "2026-10-21");
  expect(draft).toMatchObject({ approvedAgreement: null, debtSource: null, totalMinor: 500000, progress: { totalMinor: 500000, paidMinor: 0, remainingMinor: 500000 } });
  expect(await db.recordPlanConsent({ planId: p.planId, actor: session.username, note: "Synthetic scheduled consent" })).toMatchObject({ ok: true });
  const a = await approveAgreement({ planId: p.planId, expectedTotalMinor: 500000, currency: "YER", source: { kind: "new" }, reason: "Synthetic scheduled approval", idempotencyKey: `schedule-approval-${serial}`, session });
  const receipt = await collectApprovedAgreement({ planId: p.planId, amountMinor: 180000, currency: "YER", method: "cash", note: null, idempotencyKey: `schedule-paid-${serial}`, session });
  return { patientId: patient.id as number, planId: p.planId, invoiceId: a.agreement.invoice_id!, paymentId: receipt.paymentId, serviceId: service.id as number, currency: "YER" as const };
}
async function immutablePlanRows(planId: number) {
  return {
    plan: await q("SELECT to_jsonb(p) AS value FROM treatment_plans p WHERE id=$1", [planId]),
    items: await q("SELECT to_jsonb(p) AS value FROM plan_items p WHERE plan_id=$1 ORDER BY id", [planId]),
    installments: await q("SELECT to_jsonb(p) AS value FROM plan_installments p WHERE plan_id=$1 ORDER BY id", [planId]),
  };
}
it("keeps original schedule coverage independent of delta receipts and refund, with current due from the approved source", async () => {
  const f = await scheduledFixture();
  const before = await immutablePlanRows(f.planId);
  const amendment = await amend(f, 800000);
  let p = (await db.getPlan(f.planId, "2026-10-21"))!;
  expect(p.approvedAgreement).toMatchObject({ originalTotalMinor: 500000, originalPaidMinor: 180000, totalMinor: 800000, paidMinor: 180000, remainingMinor: 620000, dueNowMinor: 370000 });
  expect(p.progress).toMatchObject({ dueToDateMinor: 250000, overdueMinor: 70000, nextDueDate: "2026-12-01", nextDueAmountMinor: 250000, paidCount: 0, count: 2 });
  const deltaReceipt = await db.recordPayment({ patientId: f.patientId, invoiceId: amendment.deltaInvoiceId, kind: "payment", amountMinor: 300000, currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: "Synthetic delta only", createdBy: session.username });
  expect(deltaReceipt.reason).toBeFalsy();
  p = (await db.getPlan(f.planId, "2026-10-21"))!;
  expect(p.approvedAgreement).toMatchObject({ originalPaidMinor: 180000, paidMinor: 480000, remainingMinor: 320000, dueNowMinor: 70000 });
  expect(p.progress).toMatchObject({ paidMinor: 480000, remainingMinor: 320000, paidCount: 0, overdueMinor: 70000, nextDueAmountMinor: 250000 });
  const refund = await db.recordPayment({ patientId: f.patientId, invoiceId: null, kind: "refund", amountMinor: 100000, currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: "Synthetic delta refund", createdBy: session.username, reversalOfId: deltaReceipt.payment!.id });
  expect(refund.reason).toBeFalsy();
  p = (await db.getPlan(f.planId, "2026-10-21"))!;
  expect(p.approvedAgreement).toMatchObject({ originalPaidMinor: 180000, paidMinor: 380000, remainingMinor: 420000, dueNowMinor: 170000 });
  expect(p.progress).toMatchObject({ paidCount: 0, overdueMinor: 70000 });
  expect(await immutablePlanRows(f.planId)).toEqual(before);
});
it("settles 620000 once across original and delta without attributing 800000 to the original schedule", async () => {
  const f = await scheduledFixture();
  await amend(f, 800000);
  const before = await immutablePlanRows(f.planId);
  const command = { planId: f.planId, amountMinor: 620000, currency: "YER" as const, method: "cash" as const, note: null, idempotencyKey: `summary-split-${++serial}`, session };
  const saved = await collectApprovedAgreement(command);
  expect(saved).toHaveProperty("paymentIds");
  expect(await collectApprovedAgreement(command)).toMatchObject({ replayed: true });
  const p = (await db.getPlan(f.planId, "2026-10-21"))!;
  expect(p.approvedAgreement).toMatchObject({ originalPaidMinor: 500000, totalMinor: 800000, paidMinor: 800000, remainingMinor: 0 });
  expect(p.progress).toMatchObject({ totalMinor: 800000, paidMinor: 800000, remainingMinor: 0, paidCount: 2, count: 2 });
  expect(await immutablePlanRows(f.planId)).toEqual(before);
});
it("fails closed when the approved reader is unavailable or missing, with no invoice fallback", async () => {
  const f = await scheduledFixture();
  await amend(f, 800000);
  const agreements = await import("../../lib/approved-agreements");
  const actual = agreements.approvedAgreementPosition;
  const before = await immutablePlanRows(f.planId);
  const spy = vi.spyOn(agreements, "approvedAgreementPosition").mockImplementation(async (...args) => {
    const result = await actual(...args); return result && args[0] === f.planId ? { ...result, available: false } : result;
  });
  try {
    const p = (await db.getPlan(f.planId, "2026-10-21"))!;
    expect(p).toMatchObject({ debtSource: null, invoiceFinancial: null, approvedAgreement: { available: false } });
    const workflow = await db.patientWorkflow(f.patientId, "2026-10-21");
    expect(workflow.activePlans.find(plan => plan.id === f.planId)).toMatchObject({ nextDueDate: null, overdueMinor: null });
    expect(workflow.alerts.some(alert => alert.kind === "overdue_installment")).toBe(false);
    const { planLedgerSummary } = await import("../../lib/plans");
    expect(planLedgerSummary(p)).toMatchObject({ agreementReviewRequired: true, installments: null });
    expect(planLedgerSummary(p)).not.toHaveProperty("currentAgreement");
    const { statementAgreements } = await import("../../lib/statement-lines");
    expect(statementAgreements([{ ...p, totalFromItems: false }])).toEqual([]);
    const { arrivalPanel } = await import("../../lib/arrival-panel-db");
    const arrival = await arrivalPanel(f.patientId, { includeMoney: true });
    expect(arrival?.money?.lines.flatMap(row => row.planInstallments)).toEqual([]);
    const html = renderToStaticMarkup(await printPage({ params: Promise.resolve({ id: String(f.planId) }) }));
    expect(html).toContain("الرصيد الحالي غير متاح");
    for (const amount of [500000, 800000, 180000, 320000, 620000]) expect(html).not.toContain(formatMoney(amount, "YER"));
    spy.mockResolvedValue(null);
    await expect(db.getPlan(f.planId, "2026-10-21")).rejects.toThrow("Approved plan financial source unavailable");
  } finally { spy.mockRestore(); }
  expect(await immutablePlanRows(f.planId)).toEqual(before);
});
it("keeps a discounted invoice net separate from the clinical subtotal and refuses a mismatched approval", async () => {
  const f = await fixture("YER", 50000);
  const p = (await db.getPlan(f.planId, "2026-10-21"))!;
  expect(p).toMatchObject({ totalMinor: 500000, approvedAgreement: null, debtSource: "invoice", progress: { totalMinor: 450000, paidMinor: 180000, remainingMinor: 270000 } });
  const html = renderToStaticMarkup(await printPage({ params: Promise.resolve({ id: String(f.planId) }) }));
  expect(html).toContain(formatMoney(450000, "YER"));expect(html).toContain(formatMoney(270000, "YER"));
  expect(html).not.toContain("قيمة الاتفاق الأصلي قبل التعديلات");
  expect(await q("SELECT plan_id FROM approved_agreement_principals WHERE plan_id=$1", [f.planId])).toEqual([]);
  expect((await db.computeDebtRows([f.patientId])).find(row => row.currency === "YER")?.dueMinor).toBe(270000);
});
