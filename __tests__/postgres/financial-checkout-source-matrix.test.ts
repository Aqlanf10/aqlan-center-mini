import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { Currency } from "../../lib/money";
import type { AgreementSource } from "../../lib/approved-agreements";
import type { DebtTarget } from "../../lib/debt-installments-db";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { invoiceCatalogRequestFingerprint, invoiceCommandFingerprint, parseInvoiceCommand } from "../../lib/invoice-template";

const requestCookie = vi.hoisted(() => ({ token: undefined as string | undefined }));
// Only Next's request-cookie transport is synthetic. Token signature, expiry,
// current database credential/role validation and route authorization are real.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => requestCookie.token ? { value: requestCookie.token } : undefined }), headers: async () => new Headers() }));

assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_checkout_source_matrix_test");
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const agreement = await import("../../lib/approved-agreements");
const debts = await import("../../lib/debt-installments-db");
const legacy = await import("../../lib/legacy-balance-arrangements-db");
const { collectDebtInstallment } = await import("../../lib/debt-installment-collection");
const { createLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const { readInvoiceRevision, reviseInvoice } = await import("../../lib/invoice-revision-db");
const { readInvoiceSettlementPosition } = await import("../../lib/invoice-settlement-position");
const { readVisitCheckout } = await import("../../lib/checkout-db");
const { GET: getWalkout } = await import("../../app/api/visits/[id]/walkout/route");
const { clinicDateString } = await import("../../lib/schedule");
const { readCheckoutDueRecommendationInSnapshot } = await import("../../lib/checkout-due-recommendation-db");
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE), future = "2099-12-01";
const currencies = ["YER", "SAR", "USD"] as const;
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let serial = 0, session: SessionPayload;
const key = (purpose: string) => `checkout-matrix-${purpose}-${++serial}`;

beforeAll(async () => {
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-checkout-matrix-password");
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('checkout-matrix','Synthetic source matrix',$1,'admin',TRUE) RETURNING id", [hash]);
  session = { userId: user.id, username: "checkout-matrix", role: "admin", credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
  requestCookie.token = auth.createSessionToken(session);
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });
async function patient() { return (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic checkout source matrix') RETURNING id", [key("patient")]))[0].id as number; }
async function approved(patientId: number, currency: Currency, source: AgreementSource = { kind: "new" }, due = 400) {
  const plan = await db.createPlanV2({ patientId, title: "Synthetic approved source", specialty: null, primaryDoctorId: null, billingMode: "installments",
    baseCurrency: currency, startDate: today, note: null, createdBy: session.username, items: [],
    installments: due ? [{ dueDate: today, amountMinor: due }, { dueDate: future, amountMinor: 1000 - due }] : [{ dueDate: future, amountMinor: 1000 }] });
  if (!plan.ok) throw new Error(plan.message);
  await db.recordPlanConsent({ planId: plan.planId, actor: session.username, note: null });
  const saved = await agreement.approveAgreement({ planId: plan.planId, currency, expectedTotalMinor: 1000, source,
    reason: "Synthetic source matrix approval", idempotencyKey: key("approve"), session });
  return { planId: plan.planId, ...saved };
}
async function invoice(patientId: number, currency: Currency, visitId?: number) {
  const source = { patientId, currency, ...(visitId === undefined ? {} : { visitId }), items: [{ description: "Synthetic source fee", price: currency === "YER" ? "1000" : "10.00" }], discount: "0", idempotencyKey: key("invoice") };
  const parsed = parseInvoiceCommand(source, new Map(), new Set(), await db.getSettings(), true);
  if (!parsed.ok) throw new Error(parsed.message);
  const { authorityLines: _authority, template: _template, ...values } = parsed; void _authority; void _template;
  const saved = await createLinkedInvoice({ ...values, createdBy: session.username, actorRole: session.role, templates: DEFAULT_SPECIALTY_TEMPLATES,
    requestHash: invoiceCatalogRequestFingerprint(source, session), auditDetails: {}, catalogueAuthority: { source, fingerprint: invoiceCommandFingerprint(parsed), session } });
  if (!saved.ok) throw new Error(saved.reason);
  return saved.invoice;
}
async function schedule(target: DebtTarget, due = 300, remaining = 1000) {
  return debts.saveDebtRepayment({ target, terms: { mode: "installments", installments: due
    ? [{ dueDate: today, amountMinor: due, kind: "installment" }, { dueDate: future, amountMinor: remaining - due, kind: "installment" }]
    : [{ dueDate: future, amountMinor: remaining, kind: "installment" }] }, expectedVersion: 0, expectedRemainingMinor: remaining,
  reason: "Synthetic source schedule", idempotencyKey: key("schedule"), session });
}
async function receipt(patientId: number, currency: Currency, invoiceId: number, amountMinor: number) {
  const result = await db.recordPayment({ patientId, currency, invoiceId, amountMinor, kind: "payment", baseCurrency: "YER",
    exchangeRate: currency === "YER" ? 1 : currency === "SAR" ? 140 : 530, method: "cash", note: null, createdBy: session.username, idempotencyKey: key("receipt") });
  if (result.reason || !result.payment) throw new Error(`Synthetic receipt refused: ${result.reason}`);
  return result.payment;
}
const target = (patientId: number, currency: Currency, invoiceId: number): DebtTarget => ({ patientId, currency, invoiceId, openingCurrency: null });
async function balance(patientId: number, currency: Currency) {
  return db.ledgerBalancesByCurrency(patientId, await db.patientLedger(patientId), new Map())[currency].dueMinor;
}
const due = (row: Awaited<ReturnType<typeof debts.debtRepaymentWorkspace>>["arrangements"][number]) =>
  row.progress!.rows.filter(item => item.dueDate <= today).reduce((sum, item) => sum + item.remainingMinor, 0);
async function recommendation(patientId: number, visitInvoiceId: number | null = null) {
  const client = await db.getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await readCheckoutDueRecommendationInSnapshot(client, { patientId, visitInvoiceId, today });
    await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

describe("canonical source matrix before checkout integration", () => {
  it("multiple independent approved plans, invoices, and opening sources coexist within each currency without one collectible target", async () => {
    const patientId = await patient();
    for (const currency of currencies) {
      const first = await approved(patientId, currency), second = await approved(patientId, currency);
      await agreement.collectApprovedAgreement({ planId: first.planId, currency, amountMinor: 100, method: "cash", note: null, idempotencyKey: key("approved-pay"), session });
      const billed = await invoice(patientId, currency);
      const arranged = await schedule(target(patientId, currency, billed.id));
      await db.setPatientOpeningBalance({ patientId, currency, amountMinor: 500, asOfDate: today, note: null, createdBy: session.username, reason: "Synthetic independent opening" });
      expect(await legacy.createLegacyBalanceArrangement({ patientId, currency, cadence: "per_visit", installmentMinor: 200, firstDueDate: null, note: null, createdBy: session.username, today })).toMatchObject({ ok: true });
      expect(await balance(patientId, currency)).toBe(3400);
      const positions = await Promise.all([first, second].map(row => agreement.approvedAgreementPosition(row.planId, today)));
      expect(positions.map(row => row!.dueNowMinor)).toEqual([300, 400]);
      const debt = (await debts.debtRepaymentWorkspace(patientId, today)).arrangements.find(row => row.id === arranged.arrangementId)!;
      expect(due(debt)).toBe(300);
      const opening = (await legacy.listLegacyBalanceArrangements(patientId, today)).find(row => row.currency === currency)!;
      expect(opening.progress.suggestedMinor).toBe(200);
      expect(new Set([first.agreement.invoice_id, second.agreement.invoice_id, billed.id]).size).toBe(3);
      // 1,200 due by independent source, not a valid amount for any one modal target.
      expect(positions.reduce((sum, row) => sum + row!.dueNowMinor, 0) + due(debt) + opening.progress.suggestedMinor).toBe(1200);
    }
    expect((await db.patientLedger(patientId)).invoices).toHaveLength(9);
    expect((await db.patientLedger(patientId)).payments).toHaveLength(3);
    const result = await recommendation(patientId);
    expect(result.collectionAction).toBe("account");
    expect(result.currencies.map(row => [row.currency, row.currentBalanceMinor, row.dueNowMinor, row.sources.length]))
      .toEqual([["YER", 3400, 1200, 4], ["SAR", 3400, 1200, 4], ["USD", 3400, 1200, 4]]);
  });

  it("an approved invoice can also have a competing versioned schedule, so identity deduplication must not invent precedence", async () => {
    const patientId = await patient(), billed = await invoice(patientId, "SAR");
    const arranged = await schedule(target(patientId, "SAR", billed.id), 0);
    const approvedSource = await approved(patientId, "SAR", { kind: "invoice", invoiceId: billed.id });
    const approvedPosition = await agreement.approvedAgreementPosition(approvedSource.planId, today);
    const debt = (await debts.debtRepaymentWorkspace(patientId, today)).arrangements.find(row => row.id === arranged.arrangementId)!;
    expect(approvedPosition).toMatchObject({ invoiceId: billed.id, available: true, remainingMinor: 1000, dueNowMinor: 400 });
    expect(debt).toMatchObject({ target: { invoiceId: billed.id }, available: true, requiresReview: false });
    expect(due(debt)).toBe(0);
    expect(await balance(patientId, "SAR")).toBe(1000);
    expect((await db.patientLedger(patientId)).invoices).toHaveLength(1);
    expect((await recommendation(patientId, billed.id))).toMatchObject({ collectionAction: "account",
      currencies: [{ currency: "SAR", currentBalanceMinor: 1000, dueNowMinor: null, reasons: ["competing_authorities"] }] });
  });

  it("approved historical opening and legacy recurring suggestion overlap without separate principal", async () => {
    const patientId = await patient();
    await db.setPatientOpeningBalance({ patientId, currency: "USD", amountMinor: 700, asOfDate: today, note: null, createdBy: session.username, reason: "Synthetic historical opening" });
    const approval = await approved(patientId, "USD", { kind: "opening", historicalPaidMinor: 300 });
    expect(await legacy.createLegacyBalanceArrangement({ patientId, currency: "USD", cadence: "per_visit", installmentMinor: 200, firstDueDate: null, note: null, createdBy: session.username, today })).toMatchObject({ ok: true });
    expect(await agreement.approvedAgreementPosition(approval.planId, today)).toMatchObject({ openingCurrency: "USD", remainingMinor: 700, dueNowMinor: 100 });
    expect((await legacy.listLegacyBalanceArrangements(patientId, today))[0].progress.suggestedMinor).toBe(200);
    expect(await balance(patientId, "USD")).toBe(700);
    expect((await db.patientLedger(patientId)).invoices).toHaveLength(0);
    await expect(schedule({ patientId, currency: "USD", invoiceId: null, openingCurrency: "USD" }, 100, 700)).rejects.toThrow(/ترتيب سابق/);
    expect((await recommendation(patientId)).currencies[0]).toMatchObject({ currency: "USD", dueNowMinor: null,
      currentBalanceMinor: 700, knownRemainingMinor: 700, reasons: ["competing_authorities"] });
  });

  it("future-only sources have verified zero scheduled due and positive posted remaining", async () => {
    const patientId = await patient();
    const approval = await approved(patientId, "YER", { kind: "new" }, 0);
    const billed = await invoice(patientId, "USD");
    const arranged = await schedule(target(patientId, "USD", billed.id), 0);
    expect(await agreement.approvedAgreementPosition(approval.planId, today)).toMatchObject({ available: true, remainingMinor: 1000, dueNowMinor: 0 });
    const debt = (await debts.debtRepaymentWorkspace(patientId, today)).arrangements.find(row => row.id === arranged.arrangementId)!;
    expect(debt).toMatchObject({ requiresReview: false, remainingMinor: 1000 });
    expect(due(debt)).toBe(0);
    expect(await balance(patientId, "YER")).toBe(1000);
    expect(await balance(patientId, "USD")).toBe(1000);
    expect((await recommendation(patientId)).currencies.map(row => [row.currency, row.status, row.currentBalanceMinor, row.dueNowMinor]))
      .toEqual([["YER", "verified", 1000, 0], ["USD", "verified", 1000, 0]]);
  });

  it("cancelled repayment terms are not debt cancellation and cannot be used for further installment collection", async () => {
    const patientId = await patient(), billed = await invoice(patientId, "YER"), source = target(patientId, "YER", billed.id);
    const arranged = await schedule(source);
    await debts.saveDebtRepayment({ target: source, terms: { mode: "full", installments: [] }, expectedVersion: 1, expectedRemainingMinor: 1000,
      cancel: true, reason: "Synthetic cancelled schedule", idempotencyKey: key("cancel"), session });
    const row = (await debts.debtRepaymentWorkspace(patientId, today)).arrangements.find(entry => entry.id === arranged.arrangementId)!;
    expect(row).toMatchObject({ version: 2, status: "cancelled", remainingMinor: 1000, progress: null });
    await expect(collectDebtInstallment({ patientId, arrangementId: arranged.arrangementId, expectedVersion: 2, amountMinor: 100,
      currency: "YER", method: "cash", note: null, idempotencyKey: key("cancelled-pay"), session })).rejects.toThrow(/أُلغي/);
    expect(await balance(patientId, "YER")).toBe(1000);
    expect((await db.patientLedger(patientId)).payments).toHaveLength(0);
    expect(await recommendation(patientId)).toMatchObject({ collectionAction: "account",
      currencies: [{ currency: "YER", dueNowMinor: 0, knownRemainingMinor: 0, otherRemainingMinor: 1000 }] });
  });

  it("cancelled invoice is unavailable, while protected approved-source cancellation is refused", async () => {
    const patientId = await patient(), billed = await invoice(patientId, "SAR");
    const arranged = await schedule(target(patientId, "SAR", billed.id));
    expect(await db.setInvoiceStatus(billed.id, "cancelled", { actor: session.username, actorRole: session.role })).not.toBeNull();
    expect((await debts.debtRepaymentWorkspace(patientId, today)).arrangements.find(row => row.id === arranged.arrangementId)).toMatchObject({ available: false, requiresReview: true, remainingMinor: 0 });
    expect(await balance(patientId, "SAR")).toBe(0);
    expect((await recommendation(patientId)).currencies[0]).toMatchObject({ currency: "SAR", currentBalanceMinor: 0,
      dueNowMinor: null, status: "review_required", reasons: ["source_unavailable"] });
    const protectedSource = await approved(patientId, "USD");
    await expect(db.setInvoiceStatus(protectedSource.agreement.invoice_id!, "cancelled", { actor: session.username, actorRole: session.role })).rejects.toThrow(/review/);
    expect(await agreement.approvedAgreementPosition(protectedSource.planId, today)).toMatchObject({ available: true, remainingMinor: 1000, dueNowMinor: 400 });
  });

  it("current invoice descendant carries original receipts exactly once and the old schedule is not another due source", async () => {
    const patientId = await patient();
    const visit = await db.addVisit({ patientId, patientName: "Synthetic lineage checkout", patientPhone: null, note: null });
    const billed = await invoice(patientId, "YER", visit.id);
    const old = await schedule(target(patientId, "YER", billed.id));
    const paid = await receipt(patientId, "YER", billed.id, 100);
    const view = await readInvoiceRevision(billed.id, session);
    const result = await reviseInvoice(billed.id, { idempotencyKey: key("revision"), expectedSourceHash: view.sourceHash,
      reason: "Synthetic same-currency correction", lines: view.invoice.items.map(item => ({ itemId: item.id, quantity: item.quantity, unitPrice: "900" })), discount: "0",
      repaymentTerms: { mode: "installments", installments: [{ dueDate: today, amountMinor: 200, kind: "installment" }, { dueDate: future, amountMinor: 600, kind: "installment" }] }, expectedRemainingMinor: 800 }, session);
    if (!("corrected" in result) || !result.corrected) throw new Error("Synthetic invoice correction failed");
    const correctedId = result.corrected.id;
    const client = await db.getPool().connect();
    try {
      const position = await readInvoiceSettlementPosition(client, { patientId, currency: "YER", invoiceId: correctedId });
      expect(position).toMatchObject({ principalMinor: 900, settledMinor: 100, remainingMinor: 800, paymentIds: [paid.id] });
      expect(position.lineageInvoiceIds.sort((a, b) => a - b)).toEqual([billed.id, correctedId].sort((a, b) => a - b));
    } finally { client.release(); }
    const workspace = await debts.debtRepaymentWorkspace(patientId, today);
    expect(workspace.arrangements.find(row => row.id === old.arrangementId)).toMatchObject({ status: "cancelled", available: false });
    const current = workspace.arrangements.find(row => row.target.invoiceId === correctedId)!;
    expect(current).toMatchObject({ status: "active", available: true, requiresReview: false, remainingMinor: 800 });
    expect(due(current)).toBe(200);
    expect((await db.visitWalkout(visit.id))?.invoice?.id).toBe(correctedId);
    expect(await balance(patientId, "YER")).toBe(800);
    expect((await db.patientLedger(patientId)).payments).toHaveLength(1);
    expect(await recommendation(patientId, correctedId)).toMatchObject({ collectionAction: "account",
      currencies: [{ currency: "YER", currentBalanceMinor: 800, knownRemainingMinor: 800, dueNowMinor: 200,
        sources: [{ kind: "repayment_schedule", invoiceId: correctedId }] }] });
  });

  it("refund of pre-revision settlement makes schedule allocation unknown, not a zero scheduled due", async () => {
    const patientId = await patient(), billed = await invoice(patientId, "USD");
    const paid = await receipt(patientId, "USD", billed.id, 300);
    const arranged = await schedule(target(patientId, "USD", billed.id), 200, 700);
    expect((await db.recordPayment({ patientId, invoiceId: null, currency: "USD", kind: "refund", amountMinor: 100, baseCurrency: "YER", exchangeRate: 530,
      method: "cash", note: null, createdBy: session.username, reversalOfId: paid.id, idempotencyKey: key("refund") })).reason).toBeNull();
    const row = (await debts.debtRepaymentWorkspace(patientId, today)).arrangements.find(entry => entry.id === arranged.arrangementId)!;
    expect(row).toMatchObject({ requiresReview: true, remainingMinor: 800, progress: { requiresRevision: true, unallocatedMinor: 100 } });
    expect(await balance(patientId, "USD")).toBe(800);
    expect((await recommendation(patientId)).currencies[0]).toMatchObject({ currency: "USD", currentBalanceMinor: 800,
      dueNowMinor: null, status: "review_required", reasons: ["source_unavailable"] });
  });

  it("an ordinary unscheduled visit invoice retains exact inline collection while other unscheduled debt remains separate", async () => {
    const patientId = await patient();
    const visit = await db.addVisit({ patientId, patientName: "Synthetic ordinary checkout", patientPhone: null, note: null });
    const billed = await invoice(patientId, "SAR", visit.id);
    await invoice(patientId, "SAR");
    await receipt(patientId, "SAR", billed.id, 250);
    expect(await recommendation(patientId, billed.id)).toMatchObject({ visitInvoiceId: billed.id, collectionAction: "visit_invoice",
      currencies: [{ currency: "SAR", currentBalanceMinor: 1750, knownRemainingMinor: 750, otherRemainingMinor: 1000, dueNowMinor: 750,
        sources: [{ kind: "visit_invoice", invoiceId: billed.id }] }] });
  });

  it("legacy per-visit suggestion subtracts today's actual opening settlement once, not historical visit-day cash", async () => {
    const patientId = await patient();
    await db.setPatientOpeningBalance({ patientId, currency: "YER", amountMinor: 500, asOfDate: today, note: null, createdBy: session.username, reason: "Synthetic legacy checkout" });
    await legacy.createLegacyBalanceArrangement({ patientId, currency: "YER", cadence: "per_visit", installmentMinor: 200,
      firstDueDate: null, note: null, createdBy: session.username, today });
    const paid = await db.recordPayment({ patientId, invoiceId: null, openingCurrency: "YER", amountMinor: 100, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, kind: "payment", method: "cash", note: null, createdBy: session.username, idempotencyKey: key("opening-pay") });
    expect(paid.reason).toBeNull();
    expect(await recommendation(patientId)).toMatchObject({ collectionAction: "account", currencies: [{ currency: "YER", currentBalanceMinor: 400,
      knownRemainingMinor: 400, dueNowMinor: 100, sources: [{ kind: "legacy_opening", openingCurrency: "YER" }] }] });
  });

  it.each(["future", "today", "covered"] as const)("legacy monthly %s distinguishes a real scheduled zero from due today", async state => {
    const patientId = await patient();
    await db.setPatientOpeningBalance({ patientId, currency: "SAR", amountMinor: 500, asOfDate: today, note: null, createdBy: session.username, reason: "Synthetic monthly due" });
    await legacy.createLegacyBalanceArrangement({ patientId, currency: "SAR", cadence: "monthly", installmentMinor: 200,
      firstDueDate: state === "future" ? future : today, note: null, createdBy: session.username, today });
    if (state === "covered") expect((await db.recordPayment({ patientId, invoiceId: null, openingCurrency: "SAR", amountMinor: 200, currency: "SAR", baseCurrency: "YER",
      exchangeRate: 140, kind: "payment", method: "cash", note: null, createdBy: session.username, idempotencyKey: key("monthly-pay") })).reason).toBeNull();
    const remaining = state === "covered" ? 300 : 500;
    expect((await recommendation(patientId)).currencies[0]).toMatchObject({ currency: "SAR", currentBalanceMinor: remaining,
      knownRemainingMinor: remaining, dueNowMinor: state === "today" ? 200 : 0, status: "verified" });
    expect(await balance(patientId, "SAR")).toBe(remaining);
  });

  it("last partial per-visit installment subtracts today's receipt before capping by the remaining source", async () => {
    const patientId = await patient();
    await db.setPatientOpeningBalance({ patientId, currency: "USD", amountMinor: 500, asOfDate: today, note: null, createdBy: session.username, reason: "Synthetic last installment" });
    await legacy.createLegacyBalanceArrangement({ patientId, currency: "USD", cadence: "per_visit", installmentMinor: 200,
      firstDueDate: null, note: null, createdBy: session.username, today });
    // Fixture dates only, in this isolated synthetic database: preserve source
    // chronology while exercising the actual receipt writer and reader.
    await q("UPDATE legacy_balance_arrangements SET created_at=NOW()-INTERVAL '3 days' WHERE patient_id=$1", [patientId]);
    const old = await db.recordPayment({ patientId, invoiceId: null, openingCurrency: "USD", amountMinor: 300, currency: "USD", baseCurrency: "YER",
      exchangeRate: 530, kind: "payment", method: "cash", note: null, createdBy: session.username, idempotencyKey: key("old-opening-pay") });
    expect(old.reason).toBeNull();
    await q("UPDATE payments SET created_at=NOW()-INTERVAL '2 days' WHERE id=$1", [old.payment!.id]);
    expect((await db.recordPayment({ patientId, invoiceId: null, openingCurrency: "USD", amountMinor: 100, currency: "USD", baseCurrency: "YER",
      exchangeRate: 530, kind: "payment", method: "cash", note: null, createdBy: session.username, idempotencyKey: key("last-opening-pay") })).reason).toBeNull();
    expect((await legacy.listLegacyBalanceArrangements(patientId, today))[0].progress).toMatchObject({ arrangementRemainingMinor: 100, suggestedMinor: 100 });
    expect((await recommendation(patientId)).currencies[0]).toMatchObject({ currency: "USD", currentBalanceMinor: 100, knownRemainingMinor: 100, dueNowMinor: 100 });
    expect(await balance(patientId, "USD")).toBe(100);
  });

  it("a held recommendation cannot combine old source dues with a concurrently collected current balance", async () => {
    const patientId = await patient(), approval = await approved(patientId, "SAR");
    const client = await db.getPool().connect(), query = client.query.bind(client);
    let unlock!: () => void, firstRead!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const reached = new Promise<void>(resolve => { firstRead = resolve; });
    const hook = vi.spyOn(client, "query").mockImplementation(async (sql, values) => {
      const result = await query(sql, values);
      if (String(sql).includes("SELECT plan_id FROM approved_agreement_principals")) { firstRead(); await gate; }
      return result;
    });
    let pending: ReturnType<typeof readCheckoutDueRecommendationInSnapshot> | undefined;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      pending = readCheckoutDueRecommendationInSnapshot(client, { patientId, visitInvoiceId: null, today });
      await reached;
      await agreement.collectApprovedAgreement({ planId: approval.planId, currency: "SAR", amountMinor: 100, method: "cash", note: null, idempotencyKey: key("concurrent-pay"), session });
      unlock();
      const captured = await pending;
      await client.query("COMMIT");
      expect(captured.currencies[0]).toMatchObject({ currency: "SAR", currentBalanceMinor: 1000, knownRemainingMinor: 1000, dueNowMinor: 400 });
      expect((await recommendation(patientId)).currencies[0]).toMatchObject({ currency: "SAR", currentBalanceMinor: 900, knownRemainingMinor: 900, dueNowMinor: 300 });
      expect((await db.patientLedger(patientId)).payments).toHaveLength(1);
    } finally { unlock(); await pending?.catch(() => undefined); hook.mockRestore(); await client.query("ROLLBACK"); client.release(); }
  });
  it.each(currencies)("actual authorized GET exposes %s scheduled due150 separately from invoice remaining750", async currency => {
    const patientId = await patient(), visit = await db.addVisit({ patientId, patientName: "Synthetic checkout endpoint", patientPhone: null, note: null });
    const billed = await invoice(patientId, currency, visit.id); await schedule(target(patientId, currency, billed.id), 400); await receipt(patientId, currency, billed.id, 250);
    await q("UPDATE visits SET signed_at=NOW(),status='done' WHERE id=$1", [visit.id]);
    const before = await db.patientLedger(patientId);
    const response = await getWalkout(new Request(`http://localhost/api/visits/${visit.id}/walkout`), { params: Promise.resolve({ id: String(visit.id) }) });
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({ patientId, visitId: visit.id, signedToday: true, invoice: { id: billed.id, netMinor: 1000, currency },
      checkout: { invoicePaidMinor: 250, current: { [currency]: 750 } }, dueRecommendation: { patientId, visitInvoiceId: billed.id, collectionAction: "account",
        currencies: [{ currency, currentBalanceMinor: 750, knownRemainingMinor: 750, dueNowMinor: 150, status: "verified" }] } });
    expect(body.dueRecommendation.currencies[0].sources).toMatchObject([{ kind: "repayment_schedule", invoiceId: billed.id, currency }]);
    expect(await db.patientLedger(patientId)).toEqual(before);
  });

  it("actual route rejects expired or tampered signed session before source disclosure", async () => {
    const patientId = await patient(), visit = await db.addVisit({ patientId, patientName: "Synthetic auth refusal", patientPhone: null, note: null });
    const saved = requestCookie.token;
    try {
      for (const token of [auth.createSessionToken({ ...session, expiresAt: Date.now() - 1000 }), `${saved}tampered`]) {
        requestCookie.token = token;
        const response = await getWalkout(new Request(`http://localhost/api/visits/${visit.id}/walkout`), { params: Promise.resolve({ id: String(visit.id) }) });
        expect(response.status).toBe(401); expect(await response.text()).not.toContain("dueRecommendation");
      }
    } finally { requestCookie.token = saved; }
  });

  it("composed walkout ledger, source due and visit-day receipts share one held read snapshot", async () => {
    const patientId = await patient(), visit = await db.addVisit({ patientId, patientName: "Synthetic held checkout", patientPhone: null, note: null });
    const billed = await invoice(patientId, "YER", visit.id); await schedule(target(patientId, "YER", billed.id), 400);
    const pool = db.getPool(), client = await pool.connect(), query = client.query.bind(client);
    let unlock!: () => void, firstRead!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; }), reached = new Promise<void>(resolve => { firstRead = resolve; });
    const hook = vi.spyOn(client, "query").mockImplementation(async (sql, values) => {
      const result = await query(sql, values);
      if (String(sql).includes("SELECT plan_id FROM approved_agreement_principals")) { firstRead(); await gate; }
      return result;
    });
    const connect = vi.spyOn(pool, "connect").mockResolvedValueOnce(client);
    let pending: ReturnType<typeof readVisitCheckout> | undefined;
    try {
      pending = readVisitCheckout(visit.id); await reached;
      await receipt(patientId, "YER", billed.id, 100); unlock();
      const held = await pending;
      expect(held).toMatchObject({ today, walkout: { checkout: { current: { YER: 1000 }, invoicePaidMinor: 0, paymentsToday: [] } },
        dueRecommendation: { currencies: [{ currency: "YER", currentBalanceMinor: 1000, dueNowMinor: 400 }] } });
      const fresh = await readVisitCheckout(visit.id);
      expect(fresh).toMatchObject({ walkout: { checkout: { current: { YER: 900 }, invoicePaidMinor: 100 } },
        dueRecommendation: { currencies: [{ currency: "YER", currentBalanceMinor: 900, dueNowMinor: 300 }] } });
    } finally { unlock(); await pending?.catch(() => undefined); hook.mockRestore(); connect.mockRestore(); }
  });

});
