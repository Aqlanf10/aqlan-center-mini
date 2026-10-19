import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { AgreementSource } from "../../lib/approved-agreements";
import type { Currency } from "../../lib/money";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_patient_agreement_summary_test");
const db = await import("../../lib/db");
const auth = await import("../../lib/auth");
const agreements = await import("../../lib/approved-agreements");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
const today = "2026-10-19";
let session: SessionPayload;
let serial = 0;

beforeAll(async () => {
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-summary-password");
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('summary-admin','Synthetic summary',$1,'admin',TRUE) RETURNING id", [hash]);
  session = { userId: user.id, username: "summary-admin", role: "admin", credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
});
afterAll(async () => { await db.resetPoolForTesting(); });

async function fixture(currency: Currency, total: number, items: boolean, patientId?: number, clinical = false) {
  patientId ??= (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic summary patient') RETURNING id", [`SUMMARY-${++serial}`]))[0].id;
  const plan = await db.createPlanV2({
    patientId: patientId!, title: "Synthetic summary plan", specialty: null, primaryDoctorId: null,
    billingMode: clinical ? "per_procedure" : "installments", baseCurrency: currency, startDate: "2026-10-01", note: null, createdBy: session.username,
    items: items ? [{ serviceId: null, serviceName: "Synthetic treatment", category: null, toothCode: null, surfaces: null, quantity: 1,
      unitPriceMinor: total, billingRule: "on_completion", sessionCount: 1, note: null }] : [],
    installments: clinical ? [] : [{ dueDate: "2026-10-01", amountMinor: total / 2 }, { dueDate: "2026-12-01", amountMinor: total / 2 }],
  });
  if (!plan.ok) throw new Error(plan.message);
  return { patientId: patientId!, planId: plan.planId, currency, total };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const consent = (f: Fixture) => db.recordPlanConsent({ planId: f.planId, actor: session.username, note: null });
const approve = (f: Fixture, source: AgreementSource = { kind: "new" }) => agreements.approveAgreement({
  planId: f.planId, expectedTotalMinor: f.total, currency: f.currency, source,
  reason: "Synthetic summary approval", idempotencyKey: `summary-approve-${++serial}`, session,
});
const collect = (f: Fixture, amountMinor: number) => agreements.collectApprovedAgreement({
  planId: f.planId, amountMinor, currency: f.currency, method: "cash", note: null,
  idempotencyKey: `summary-collect-${++serial}`, session,
});
const financialRows = () => q(`SELECT
  (SELECT count(*) FROM invoices)::int AS invoices,
  (SELECT count(*) FROM payments)::int AS payments,
  (SELECT count(*) FROM approved_agreement_principals)::int AS principals,
  (SELECT count(*) FROM patient_opening_balances)::int AS openings,
  (SELECT count(*) FROM debt_repayment_revisions)::int AS revisions`);
async function readWithoutWrites(patientId: number) {
  const before = await financialRows();
  const summary = await db.patientWorkflow(patientId, today);
  expect(await financialRows()).toEqual(before);
  return summary;
}

it("keeps 100000 clinical + 200000 item-installment proposals as 300000 planned, including consent-only", async () => {
  const clinical = await fixture("YER", 100_000, true, undefined, true);
  const installment = await fixture("YER", 200_000, true, clinical.patientId);
  const before = await financialRows();
  const first = await readWithoutWrites(clinical.patientId);
  expect(first.financial?.byCurrency.YER).toMatchObject({ agreedMinor: 300_000, remainingTreatmentMinor: 300_000,
    approvedAgreements: null, classicInstallments: null, balanceMinor: 0, invoicedMinor: 0, paidMinor: 0 });
  expect(await consent(clinical)).toMatchObject({ ok: true });
  expect(await consent(installment)).toMatchObject({ ok: true });
  const consented = await readWithoutWrites(clinical.patientId);
  expect(consented.financial).toEqual(first.financial);
  expect(await financialRows()).toEqual(before);
  expect((await db.patientLedger(clinical.patientId)).invoices).toEqual([]);
});

it.each([false, true])("shows 1500 SAR / 500 paid / 1000 remaining for item-based=%s, unaffected by estimates or clinical completion", async (items) => {
  const f = await fixture("SAR", 150_000, items);
  await fixture("SAR", 70_000, true, f.patientId, true);
  await consent(f);
  await approve(f);
  await collect(f, 50_000);
  const expected = { count: 1, available: true, reviewCount: 0, totalMinor: 150_000, paidMinor: 50_000, remainingMinor: 100_000, dueNowMinor: 25_000 };
  const first = await readWithoutWrites(f.patientId);
  expect(first.financial?.byCurrency.SAR).toMatchObject({ agreedMinor: 220_000, approvedAgreements: expected, classicInstallments: null, balanceMinor: 100_000 });
  // Compatibility fields deliberately keep the previous active fixed-plan semantics.
  expect(first.financial?.byCurrency.SAR).toMatchObject({ agreementPaidMinor: items ? 0 : 50_000,
    agreementRemainingMinor: items ? 0 : 100_000 });
  expect(first.financial?.approvedAgreements).toBeNull(); // Base view stays YER, not a foreign sum.
  await q("UPDATE treatment_plans SET status='completed' WHERE id=$1", [f.planId]);
  const completed = await readWithoutWrites(f.patientId);
  expect(completed.activePlans.map(p => p.id)).not.toContain(f.planId);
  expect(completed.financial?.byCurrency.SAR).toMatchObject({ agreementPaidMinor: 0, agreementRemainingMinor: 0 });
  expect(completed.financial?.byCurrency.SAR).toMatchObject({ agreedMinor: 70_000, approvedAgreements: expected, balanceMinor: 100_000 });
  await collect(f, 10_000);
  expect((await readWithoutWrites(f.patientId)).financial?.byCurrency.SAR.approvedAgreements).toMatchObject({ totalMinor: 150_000, paidMinor: 60_000, remainingMinor: 90_000 });
});

it("retains historical opening settlement in the approved trio, without adding it to current receipts", async () => {
  const f = await fixture("SAR", 150_000, false);
  await consent(f);
  await db.setPatientOpeningBalance({ patientId: f.patientId, currency: "SAR", amountMinor: 100_000, asOfDate: "2026-09-01",
    note: null, createdBy: session.username, reason: "Synthetic historical opening" });
  await approve(f, { kind: "opening", historicalPaidMinor: 50_000 });
  await collect(f, 10_000);
  expect((await readWithoutWrites(f.patientId)).financial?.byCurrency.SAR).toMatchObject({
    approvedAgreements: { totalMinor: 150_000, paidMinor: 60_000, remainingMinor: 90_000, dueNowMinor: 15_000 },
    invoicedMinor: 0, paidMinor: 10_000, openingMinor: 100_000, balanceMinor: 90_000,
  });
});

it("uses refund-adjusted approved settlement and never a stale plan progress total", async () => {
  const f = await fixture("SAR", 150_000, true);
  await consent(f); await approve(f);
  const receipt = await collect(f, 50_000);
  expect(await db.recordPayment({ patientId: f.patientId, invoiceId: null, planId: null, openingCurrency: null,
    kind: "refund", amountMinor: 10_000, currency: "SAR", baseCurrency: "YER", exchangeRate: 140, method: "cash",
    note: null, createdBy: session.username, reversalOfId: receipt.paymentId })).toMatchObject({ reason: null });
  expect((await readWithoutWrites(f.patientId)).financial?.byCurrency.SAR).toMatchObject({
    approvedAgreements: { totalMinor: 150_000, paidMinor: 40_000, remainingMinor: 110_000 }, balanceMinor: 110_000,
  });
});

it("keeps every currency separate and marks the whole approved settlement unavailable when one source needs review", async () => {
  const yer = await fixture("YER", 1500, false);
  const sar = await fixture("SAR", 150_000, true, yer.patientId);
  const sarSecond = await fixture("SAR", 30_000, false, yer.patientId);
  const usd = await fixture("USD", 150_000, false, yer.patientId);
  for (const f of [yer, sar, sarSecond, usd]) { await consent(f); await approve(f); await collect(f, f.total / 3); }
  const first = await readWithoutWrites(yer.patientId);
  expect(first.financial?.byCurrency.YER.approvedAgreements).toMatchObject({ totalMinor: 1500, paidMinor: 500, remainingMinor: 1000 });
  expect(first.financial?.byCurrency.SAR.approvedAgreements).toMatchObject({ totalMinor: 180_000, paidMinor: 60_000, remainingMinor: 120_000 });
  expect(first.financial?.byCurrency.USD.approvedAgreements).toMatchObject({ totalMinor: 150_000, paidMinor: 50_000, remainingMinor: 100_000 });
  expect(first.financial?.approvedAgreements).toEqual(first.financial?.byCurrency.YER.approvedAgreements);
  const position = agreements.approvedAgreementPosition;
  // Fault injection at the canonical read boundary, without mutating protected financial records.
  const unavailable = vi.spyOn(agreements, "approvedAgreementPosition").mockImplementation(async (...args) => {
    const result = await position(...args);
    return result && args[0] === sar.planId ? { ...result, available: false } : result;
  });
  try {
    const review = await readWithoutWrites(yer.patientId);
    expect(review.financial?.byCurrency.SAR.approvedAgreements).toEqual({ count: 2, available: false, reviewCount: 1,
      totalMinor: 180_000, paidMinor: null, remainingMinor: null, dueNowMinor: null });
    expect(review.financial?.byCurrency.SAR.classicInstallments).toBeNull();
    expect(review.financial?.byCurrency.SAR.balanceMinor).toBe(120_000);
    expect(review.financial?.byCurrency.USD).toEqual(first.financial?.byCurrency.USD);
  } finally { unavailable.mockRestore(); }
});

it.each([false, true])("keeps classic installment references distinct for item-based=%s", async (items) => {
  const f = await fixture("SAR", 150_000, items);
  const collected = await db.recordPlanInstallment({ patientId: f.patientId, planId: f.planId, planTitle: "Synthetic classic",
    installmentNumber: 1, amountMinor: 50_000, currency: "SAR", baseCurrency: "YER", exchangeRate: 140,
    method: "cash", note: null, createdBy: session.username, actorRole: "admin", idempotencyKey: `summary-classic-${++serial}` });
  expect(collected).toHaveProperty("paymentId");
  expect((await db.getPlan(f.planId, today))?.debtSource).toBe("classic_installments");
  expect((await readWithoutWrites(f.patientId)).financial?.byCurrency.SAR).toMatchObject({ agreedMinor: 150_000,
    approvedAgreements: null, classicInstallments: { count: 1, totalMinor: 150_000, paidMinor: 50_000, remainingMinor: 100_000 },
    invoicedMinor: 50_000, paidMinor: 50_000, balanceMinor: 0 });
});
