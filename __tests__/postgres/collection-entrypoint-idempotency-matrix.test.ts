import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import { MINOR_UNITS, type Currency } from "../../lib/money";

/**
 * Mandate §6, test-only: every collection door the product actually exposes, driven through its
 * real HTTP route handler on PostgreSQL 18 (synthetic users, patients and shift only; the session
 * gate is the only stub). For each door and each of YER / SAR / USD separately:
 *  - a lost-response retry (sequential and concurrent) of the same key replays the same receipt(s)
 *    and leaves EVERY table byte-identical (content hash of the whole database, not a row count);
 *  - the same key with a changed amount or method is refused and leaves every table byte-identical;
 *  - an equal payment with a new key is first asked for the advisory similar-receipt review
 *    (nothing written), then, once the reported receipts are confirmed, records an independent
 *    receipt; both keys keep replaying their own receipts.
 * Existing policy is the oracle: the writers decide the outcomes, the test only compares states.
 */
assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_collection_entrypoint_matrix_test");
process.env.DB_POOL_MAX = "10";
const auth = vi.hoisted(() => ({ session: null as SessionPayload | null }));
vi.mock("@/lib/session", async (original) => ({ ...await original<typeof import("../../lib/session")>(), requireSession: async () => auth.session }));
const db = await import("../../lib/db");
const authLib = await import("../../lib/auth");
const agreements = await import("../../lib/approved-agreements");
const amendments = await import("../../lib/agreement-amendment-db");
const { saveDebtRepayment } = await import("../../lib/debt-installments-db");
const { REVERSED_INSTALLMENT_RECOVERY_PURPOSE } = await import("../../lib/reversed-installment-recovery");
const { clinicDateString } = await import("../../lib/schedule");
const paymentsRoute = await import("../../app/api/payments/route");
const plansRoute = await import("../../app/api/plans/[id]/route");
const debtRoute = await import("../../app/api/patients/[id]/debt-repayments/[arrangementId]/collect/route");
const correctRoute = await import("../../app/api/payments/[id]/correct/route");

const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);
const CURRENCIES: Currency[] = ["YER", "SAR", "USD"];
/** One native tender per currency (whole major units) and the smallest changed amount. */
const TENDER: Record<Currency, number> = { YER: 5_000, SAR: 10_000, USD: 10_000 };
const major = (minor: number, currency: Currency) => String(minor / MINOR_UNITS[currency]);
let session: SessionPayload;
let serial = 0;
const key = (purpose: string) => `matrix-${purpose}-${++serial}`;
const q = async <R = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as R[];

beforeAll(async () => {
  await db.ensureSchema();
  const hash = await authLib.hashPassword("synthetic-collection-matrix-password");
  const [user] = await q<{ id: number }>("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('matrix-admin','Synthetic matrix admin',$1,'admin',TRUE) RETURNING id", [hash]);
  session = { userId: user.id, username: "matrix-admin", role: "admin", credentialVersion: authLib.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
  auth.session = session;
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  // Synthetic local FX settings, never live currency rates.
  await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  db.invalidateSettingsCache();
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

// ---------------------------------------------------------------------------------------------
// Whole-database state: one content hash per table. "No writes" means every table is identical.
// ---------------------------------------------------------------------------------------------
let stateSql: string | null = null;
async function databaseState(): Promise<Record<string, string>> {
  if (stateSql === null) {
    const tables = await q<{ name: string }>("SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1");
    // The ordinary payments route's documented best-effort replay trace is the only row a replay may add;
    // it is compared separately (replayTraces), never silently.
    stateSql = tables.map(({ name }) => `SELECT '${name}' AS t, count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${name} x${
      name === "public.audit_log" ? " WHERE x.action <> 'payment.idempotent_replay'" : ""}`).join(" UNION ALL ");
  }
  return Object.fromEntries((await q<{ t: string; h: string }>(stateSql)).map((row) => [row.t, row.h]));
}
const changedTables = (before: Record<string, string>, after: Record<string, string>) =>
  Object.keys(after).filter((table) => before[table] !== after[table]).sort();
const drawer = async () => ({ ...(await db.getOpenShift())!.expected });
/** Receipt ids named by replay-trace audit rows, one entry per row. */
const replayTraces = async () => (await q<{ entity_id: string }>("SELECT entity_id FROM audit_log WHERE action = 'payment.idempotent_replay' ORDER BY id")).map((row) => Number(row.entity_id));

// ---------------------------------------------------------------------------------------------
// The real route handlers.
// ---------------------------------------------------------------------------------------------
type Sent = { status: number; body: Record<string, unknown> };
async function post(handler: (request: Request, context: never) => Promise<Response>, url: string, body: Record<string, unknown>,
  idempotencyKey: string | null, review?: string, params?: Record<string, string>): Promise<Sent> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (idempotencyKey !== null) headers["idempotency-key"] = idempotencyKey;
  if (review !== undefined) headers["x-collection-similarity-review"] = review;
  const request = new Request(`http://localhost${url}`, { method: "POST", headers, body: JSON.stringify(body) });
  const response = await handler(request, { params: Promise.resolve(params ?? {}) } as never);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
/** Receipt ids of a successful response, in the writer's own order (split collections have several). */
function receiptIds(body: Record<string, unknown>): number[] {
  if (Array.isArray(body.paymentIds)) return body.paymentIds as number[];
  if (typeof body.paymentId === "number") return [body.paymentId];
  const payment = body.payment as { id?: number } | undefined;
  if (payment && typeof payment.id === "number") return [payment.id];
  if (typeof body.id === "number") return [body.id];
  throw new Error(`No receipt identity in ${JSON.stringify(body).slice(0, 300)}`);
}

// ---------------------------------------------------------------------------------------------
// Synthetic fixtures for each door.
// ---------------------------------------------------------------------------------------------
async function patient(label: string) {
  return (await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id", [key("patient"), `Synthetic ${label}`]))[0].id;
}
async function invoice(patientId: number, currency: Currency, totalMinor: number) {
  const [row] = await q<{ id: number }>("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES($1,$2,$3,0,$4) RETURNING id",
    [key("inv"), patientId, totalMinor, currency]);
  await q("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Synthetic service',1,$2,$2)", [row.id, totalMinor]);
  return row.id;
}
async function installmentPlan(patientId: number, currency: Currency, installmentMinor: number) {
  const plan = await db.createPlanV2({ patientId, title: "Synthetic installment plan", specialty: null, primaryDoctorId: null, billingMode: "installments",
    baseCurrency: currency, startDate: today, note: null, createdBy: session.username, items: [],
    installments: [{ dueDate: today, amountMinor: installmentMinor }, { dueDate: "2099-12-01", amountMinor: installmentMinor }] });
  if (!plan.ok) throw new Error(plan.message);
  expect(await db.recordPlanConsent({ planId: plan.planId, actor: session.username, note: null })).toMatchObject({ ok: true });
  return plan.planId;
}
async function approvedPlan(patientId: number, currency: Currency, totalMinor: number, primaryDoctorId: number | null = null) {
  const planId = await installmentPlan(patientId, currency, totalMinor / 2);
  // Approval attributes its principal invoice to the plan's doctor as it stands at approval.
  if (primaryDoctorId !== null) await q("UPDATE treatment_plans SET primary_doctor_id=$1 WHERE id=$2", [primaryDoctorId, planId]);
  await agreements.approveAgreement({ planId, expectedTotalMinor: totalMinor, currency, source: { kind: "new" }, reason: "Synthetic financial confirmation", idempotencyKey: key("approve"), session });
  return planId;
}
/** An approved agreement whose recorded upgrade adds a delta invoice: one tender splits across both sources. */
async function splitAgreement(patientId: number, currency: Currency, unit: number) {
  const oldServiceId = (await q<{ id: number }>("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES($1,$2,TRUE,TRUE,'prostho') RETURNING id", [key("old-crown"), 5 * unit]))[0].id;
  const newServiceId = (await q<{ id: number }>("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES($1,$2,TRUE,TRUE,'prostho') RETURNING id", [key("zircon"), 8 * unit]))[0].id;
  const plan = await db.createPlanV2({ patientId, title: "Synthetic crowns", specialty: null, primaryDoctorId: null, billingMode: "installments", baseCurrency: currency,
    startDate: today, note: null, createdBy: session.username, items: [], installments: [{ dueDate: today, amountMinor: 10 * unit }, { dueDate: "2099-12-01", amountMinor: 40 * unit }] });
  if (!plan.ok) throw new Error(plan.message);
  await q("INSERT INTO plan_items(plan_id,service_id,service_name,quantity,unit_price_minor,billing_rule,session_count,doctor_id) VALUES($1,$2,'Ten crowns',10,$3,'once',1,NULL)", [plan.planId, oldServiceId, 5 * unit]);
  expect(await db.recordPlanConsent({ planId: plan.planId, actor: session.username, note: null })).toMatchObject({ ok: true });
  await agreements.approveAgreement({ planId: plan.planId, expectedTotalMinor: 50 * unit, currency, source: { kind: "new" }, reason: "Synthetic approved treatment", idempotencyKey: key("approve"), session });
  // Most of the original principal is paid first, so the next tender reaches the delta invoice too.
  const paid = await agreements.collectApprovedAgreement({ planId: plan.planId, amountMinor: 49 * unit, currency, method: "cash", note: null, idempotencyKey: key("paid"), session });
  expect(paid.paymentId).toBeTruthy();
  const view = await amendments.readAgreementAmendment(plan.planId, session);
  await amendments.saveAgreementAmendment(plan.planId, { idempotencyKey: key("upgrade"), expectedSourceHash: view.sourceHash, newServiceId, newUnitMinor: 8 * unit,
    reason: "Synthetic documented upgrade consent" }, session);
  return plan.planId;
}
async function debtArrangement(patientId: number, currency: Currency, totalMinor: number, opening: boolean) {
  const invoiceId = opening ? null : await invoice(patientId, currency, totalMinor);
  if (opening) await q("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES($1,$2,$3,'2026-10-01','synthetic')", [patientId, currency, totalMinor]);
  const target = { patientId, currency, invoiceId, openingCurrency: opening ? currency : null };
  const saved = await saveDebtRepayment({ target, terms: { mode: "installments", installments: [{ dueDate: today, amountMinor: totalMinor, kind: "installment" }] },
    expectedVersion: 0, expectedRemainingMinor: totalMinor, reason: "Synthetic schedule", idempotencyKey: key("schedule"), session });
  return { arrangementId: saved.arrangementId, version: 1 };
}
/** An issued installment whose receipt was voided by the manager: its original invoice is recovered, never re-issued. */
async function reversedInstallment(patientId: number, currency: Currency, installmentMinor: number) {
  const planId = await installmentPlan(patientId, currency, installmentMinor);
  const issued = await post(plansRoute.POST, `/api/plans/${planId}`, { amount: major(installmentMinor, currency), currency, method: "cash", note: null }, key("issue"), "none", { id: String(planId) });
  expect(issued.status).toBe(201);
  const [paymentId] = receiptIds(issued.body);
  const voided = await post(correctRoute.POST, `/api/payments/${paymentId}/correct`, { mode: "void", reason: "Synthetic money never received" }, key("void"), undefined, { id: String(paymentId) });
  expect(voided.status).toBe(201);
  const [{ invoice_id: invoiceId }] = await q<{ invoice_id: number }>("SELECT invoice_id FROM payments WHERE id=$1", [paymentId]);
  return invoiceId;
}

// ---------------------------------------------------------------------------------------------
// Doors: every human collection entry point (UI or API) that creates a new receipt.
// ---------------------------------------------------------------------------------------------
type Intent = { amountMinor: number; method: "cash" | "transfer" };
type Door = { name: string; ui: string; setup: (currency: Currency) => Promise<(intent: Intent, idempotencyKey: string | null, review?: string) => Promise<Sent>> };
const DOORS: Door[] = [
  { name: "invoice receipt (POST /api/payments invoiceId)", ui: "CollectPaymentModal: finance, patient ledger, arrival, today visit, summary",
    async setup(currency) {
      const patientId = await patient("invoice receipt"); const invoiceId = await invoice(patientId, currency, 40 * TENDER[currency]);
      return (intent, k, review) => post(paymentsRoute.POST, "/api/payments", { kind: "payment", patientId, invoiceId, amount: major(intent.amountMinor, currency), currency, method: intent.method }, k, review);
    } },
  { name: "opening-balance receipt (POST /api/payments openingCurrency)", ui: "CollectPaymentModal, opening target",
    async setup(currency) {
      const patientId = await patient("opening receipt");
      await q("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES($1,$2,$3,'2026-10-01','synthetic')", [patientId, currency, 40 * TENDER[currency]]);
      return (intent, k, review) => post(paymentsRoute.POST, "/api/payments", { kind: "payment", patientId, openingCurrency: currency, amount: major(intent.amountMinor, currency), currency, method: intent.method }, k, review);
    } },
  { name: "installment via POST /api/payments planId", ui: "CollectPaymentModal plan target, PatientPlans collect",
    async setup(currency) {
      const patientId = await patient("installment payments door"); const planId = await installmentPlan(patientId, currency, 20 * TENDER[currency]);
      return (intent, k, review) => post(paymentsRoute.POST, "/api/payments", { kind: "payment", patientId, planId, amount: major(intent.amountMinor, currency), currency, method: intent.method }, k, review);
    } },
  { name: "installment via POST /api/plans/[id]", ui: "PatientPlans «تحصيل قسط»",
    async setup(currency) {
      const patientId = await patient("installment plan door"); const planId = await installmentPlan(patientId, currency, 20 * TENDER[currency]);
      return (intent, k, review) => post(plansRoute.POST, `/api/plans/${planId}`, { amount: major(intent.amountMinor, currency), currency, method: intent.method, note: null }, k, review, { id: String(planId) });
    } },
  { name: "approved agreement via POST /api/payments planId", ui: "CollectPaymentModal plan target on an approved agreement",
    async setup(currency) {
      const patientId = await patient("approved payments door"); const planId = await approvedPlan(patientId, currency, 40 * TENDER[currency]);
      return (intent, k, review) => post(paymentsRoute.POST, "/api/payments", { kind: "payment", patientId, planId, amount: major(intent.amountMinor, currency), currency, method: intent.method }, k, review);
    } },
  { name: "approved agreement via POST /api/plans/[id]", ui: "PatientPlans collect on an approved agreement",
    async setup(currency) {
      const patientId = await patient("approved plan door"); const planId = await approvedPlan(patientId, currency, 40 * TENDER[currency]);
      return (intent, k, review) => post(plansRoute.POST, `/api/plans/${planId}`, { amount: major(intent.amountMinor, currency), currency, method: intent.method, note: null }, k, review, { id: String(planId) });
    } },
  { name: "distributed (split) agreement collection via POST /api/payments planId", ui: "CollectPaymentModal plan target after a recorded upgrade",
    async setup(currency) {
      const patientId = await patient("split agreement"); const planId = await splitAgreement(patientId, currency, TENDER[currency]);
      return (intent, k, review) => post(paymentsRoute.POST, "/api/payments", { kind: "payment", patientId, planId, amount: major(intent.amountMinor, currency), currency, method: intent.method }, k, review);
    } },
  { name: "debt schedule on an invoice (POST /api/patients/[id]/debt-repayments/[arrangementId]/collect)", ui: "DebtRepaymentPanel",
    async setup(currency) {
      const patientId = await patient("invoice debt"); const { arrangementId, version } = await debtArrangement(patientId, currency, 40 * TENDER[currency], false);
      return (intent, k, review) => post(debtRoute.POST, `/api/patients/${patientId}/debt-repayments/${arrangementId}/collect`,
        { amount: major(intent.amountMinor, currency), currency, method: intent.method, note: null, expectedVersion: version }, k, review, { id: String(patientId), arrangementId: String(arrangementId) });
    } },
  { name: "legacy opening-balance debt schedule (same debt collect route)", ui: "DebtRepaymentPanel, legacy opening",
    async setup(currency) {
      const patientId = await patient("legacy opening debt"); const { arrangementId, version } = await debtArrangement(patientId, currency, 40 * TENDER[currency], true);
      return (intent, k, review) => post(debtRoute.POST, `/api/patients/${patientId}/debt-repayments/${arrangementId}/collect`,
        { amount: major(intent.amountMinor, currency), currency, method: intent.method, note: null, expectedVersion: version }, k, review, { id: String(patientId), arrangementId: String(arrangementId) });
    } },
  { name: "re-collection of a reversed installment (POST /api/payments purpose=reversed-installment-recovery)", ui: "none (API only)",
    async setup(currency) {
      const patientId = await patient("reversed installment recovery"); const invoiceId = await reversedInstallment(patientId, currency, 8 * TENDER[currency]);
      return (intent, k, review) => post(paymentsRoute.POST, "/api/payments", { purpose: REVERSED_INSTALLMENT_RECOVERY_PURPOSE, patientId, invoiceId, amount: major(intent.amountMinor, currency), currency, method: intent.method }, k, review);
    } },
];

describe.each(DOORS)("$name", (door) => {
  it("a missing, blank or malformed key is refused with an Arabic message before any write", async () => {
    const send = await door.setup("YER");
    const s0 = await databaseState();
    for (const bad of [null, "", "   ", "short", "has spaces in it", "x".repeat(129)]) {
      const refused = await send({ amountMinor: TENDER.YER, method: "cash" }, bad, "none");
      expect(refused.status, `${JSON.stringify(bad)} ${JSON.stringify(refused.body)}`).toBe(400);
      expect(String(refused.body.message)).toMatch(/[\u0600-\u06FF]/);
    }
    expect(changedTables(s0, await databaseState())).toEqual([]);
  }, 60_000);

  it.each(CURRENCIES)("%s: lost-response retries replay, changed same-key intents write nothing, equal new-key payments need review then stand alone", async (currency) => {
    const send = await door.setup(currency);
    const A = TENDER[currency];
    const unit = MINOR_UNITS[currency];
    const k1 = key("k1");
    const s0 = await databaseState(); const d0 = await drawer(); const t0 = await replayTraces();

    const first = await send({ amountMinor: A, method: "cash" }, k1);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const ids1 = receiptIds(first.body);
    const s1 = await databaseState(); const d1 = await drawer();
    expect(changedTables(s0, s1)).toContain("public.payments");
    expect(d1[currency] - d0[currency]).toBe(A);

    // Lost response: the receipt committed, the reply never arrived; the client resends the saved request.
    const retry = await send({ amountMinor: A, method: "cash" }, k1);
    const concurrent = await Promise.all([send({ amountMinor: A, method: "cash" }, k1), send({ amountMinor: A, method: "cash" }, k1)]);
    for (const replay of [retry, ...concurrent]) {
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(receiptIds(replay.body)).toEqual(ids1);
    }
    expect(changedTables(s1, await databaseState())).toEqual([]);
    // A replay adds at most its own trace line, naming only the replayed receipt.
    expect((await replayTraces()).slice(t0.length).every((id) => id === ids1[0])).toBe(true);

    // The same key for a different amount or method is a conflict with an Arabic message, and writes nothing.
    for (const changed of [{ amountMinor: A + unit, method: "cash" as const }, { amountMinor: A, method: "transfer" as const }]) {
      const refused = await send(changed, k1);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(String(refused.body.message)).toMatch(/[؀-ۿ]/);
      expect(changedTables(s1, await databaseState())).toEqual([]);
    }

    // An equal payment under a new key is legitimate, but first the operator reviews the similar receipt.
    const k2 = key("k2");
    const asked = await send({ amountMinor: A, method: "cash" }, k2, "none");
    expect(asked.status, JSON.stringify(asked.body)).toBe(409);
    expect(asked.body.reason).toBe("similar_collection_review_required");
    const reported = (asked.body.receipts as { id: number }[]).map((receipt) => receipt.id);
    expect(reported).toContain(ids1[0]);
    expect(changedTables(s1, await databaseState())).toEqual([]);
    const confirmed = await send({ amountMinor: A, method: "cash" }, k2, `ids:${reported.join(",")}`);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    const ids2 = receiptIds(confirmed.body);
    expect(ids2.filter((id) => ids1.includes(id))).toEqual([]);
    const s2 = await databaseState();
    expect((await drawer())[currency] - d0[currency]).toBe(2 * A);

    // Each key keeps replaying its own receipts, with or without a review header, and writes nothing.
    expect(receiptIds((await send({ amountMinor: A, method: "cash" }, k2)).body)).toEqual(ids2);
    expect(receiptIds((await send({ amountMinor: A, method: "cash" }, k1, "none")).body)).toEqual(ids1);
    expect(changedTables(s2, await databaseState())).toEqual([]);
    const stored = await q<{ amount: string; currency: string }>("SELECT SUM(amount_minor)::text AS amount, MIN(currency) AS currency FROM payments WHERE id = ANY($1::int[])", [[...ids1, ...ids2]]);
    expect(stored).toEqual([{ amount: String(2 * A), currency }]);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// Reversal effects: full void and partial reversal of a receipt from each collection door.
// ---------------------------------------------------------------------------------------------
const EVER = ["2000-01-01", "2100-12-31"] as const;
async function commissionDoctor() {
  const [{ id }] = await q<{ id: number }>("INSERT INTO parties(kind,name,commission_percent) VALUES('doctor',$1,30) RETURNING id", [key("doctor")]);
  const config = { ...(await import("../../lib/doctor-permissions")).DEFAULT_DOCTOR_COMMISSION_CONFIG,
    defaultPercent: 30, deductLabCost: false, deductMaterialCost: false, basis: "collected_cash" };
  await q("INSERT INTO doctor_commission_history(party_id,percent,config,effective_from,source) VALUES($1,30,$2::jsonb,now()-interval '1 day','baseline')", [id, JSON.stringify(config)]);
  return id;
}
/** Every projection a receipt or its reversal can move, read from the product's own readers. */
async function position(patientId: number, currency: Currency, doctorId: number) {
  const plans = await q<{ id: number; approved: boolean }>(
    "SELECT t.id, EXISTS(SELECT 1 FROM approved_agreement_principals a WHERE a.plan_id=t.id) AS approved FROM treatment_plans t WHERE t.patient_id=$1 ORDER BY t.id", [patientId]);
  const commission = (await db.commissionReport(...EVER)).filter((row) => row.doctorId === doctorId && row.currency === currency);
  const journal = new Map<string, number>();
  for (const entry of await db.journalEntries(...EVER)) for (const line of entry.lines) {
    const id = `${line.accountCode}:${line.currency}`;
    journal.set(id, (journal.get(id) ?? 0) + (line.side === "debit" ? line.amountMinor : -line.amountMinor));
  }
  return {
    drawer: (await drawer())[currency],
    due: (await db.computeDebtRows([patientId], true)).filter((row) => row.currency === currency).reduce((sum, row) => sum + row.dueMinor, 0),
    invoices: await q("SELECT id, total_minor, discount_minor, base_currency, status FROM invoices WHERE patient_id=$1 ORDER BY id", [patientId]),
    schedule: await q("SELECT i.* FROM plan_installments i JOIN treatment_plans t ON t.id=i.plan_id WHERE t.patient_id=$1 ORDER BY i.id", [patientId]),
    planPaid: await Promise.all(plans.map(async (plan) => (await db.getPlan(plan.id, today))!.progress.paidMinor)),
    agreementRemaining: await Promise.all(plans.filter((plan) => plan.approved).map(async (plan) => (await agreements.approvedAgreementPosition(plan.id, today))!.remainingMinor)),
    debt: (await (await import("../../lib/debt-installments-db")).listDebtRepayments(patientId, today)).map((row) => ({ remainingMinor: row.remainingMinor, requiresReview: row.requiresReview })),
    accrued: commission.reduce((sum, row) => sum + row.accruedMinor, 0),
    earned: commission.reduce((sum, row) => sum + row.earnedMinor, 0),
    journal,
  };
}
const journalDelta = (before: Map<string, number>, after: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...new Set([...before.keys(), ...after.keys()])].map((id): [string, number] => [id, (after.get(id) ?? 0) - (before.get(id) ?? 0)]).filter(([, value]) => value !== 0));

type Origin = { name: string; plans: boolean; agreement: boolean; debt: boolean; commission: boolean;
  /** Existing policy for a new-key collection through the same door after a full void. */
  recollect: { status: 201 } | { status: 409; reason?: string };
  setup: (currency: Currency, doctorId: number) => Promise<{ patientId: number; collect: (amountMinor: number, k: string, review?: string) => Promise<Sent> }> };
const ORIGINS: Origin[] = [
  { name: "invoice receipt", plans: false, agreement: false, debt: false, commission: true, recollect: { status: 201 }, async setup(currency, doctorId) {
    const patientId = await patient("reversal invoice"); const invoiceId = await invoice(patientId, currency, 40 * TENDER[currency]);
    await q("UPDATE invoice_items SET doctor_id=$1 WHERE invoice_id=$2", [doctorId, invoiceId]);
    return { patientId, collect: (amountMinor, k, review) => post(paymentsRoute.POST, "/api/payments", { kind: "payment", patientId, invoiceId, amount: major(amountMinor, currency), currency, method: "cash" }, k, review) };
  } },
  { name: "opening-balance receipt", plans: false, agreement: false, debt: false, commission: false, recollect: { status: 201 }, async setup(currency) {
    const patientId = await patient("reversal opening");
    await q("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES($1,$2,$3,'2026-10-01','synthetic')", [patientId, currency, 40 * TENDER[currency]]);
    return { patientId, collect: (amountMinor, k, review) => post(paymentsRoute.POST, "/api/payments", { kind: "payment", patientId, openingCurrency: currency, amount: major(amountMinor, currency), currency, method: "cash" }, k, review) };
  } },
  { name: "installment receipt", plans: true, agreement: false, debt: false, commission: true,
    // An issued installment whose receipt was reversed is recovered on its original invoice, never re-issued.
    recollect: { status: 409, reason: "issued_installment_recovery_required" }, async setup(currency, doctorId) {
    const patientId = await patient("reversal installment"); const planId = await installmentPlan(patientId, currency, 20 * TENDER[currency]);
    await q("UPDATE treatment_plans SET primary_doctor_id=$1 WHERE id=$2", [doctorId, planId]);
    return { patientId, collect: (amountMinor, k, review) => post(plansRoute.POST, `/api/plans/${planId}`, { amount: major(amountMinor, currency), currency, method: "cash", note: null }, k, review, { id: String(planId) }) };
  } },
  { name: "approved agreement receipt", plans: true, agreement: true, debt: false, commission: true, recollect: { status: 201 }, async setup(currency, doctorId) {
    const patientId = await patient("reversal agreement"); const planId = await approvedPlan(patientId, currency, 40 * TENDER[currency], doctorId);
    return { patientId, collect: (amountMinor, k, review) => post(plansRoute.POST, `/api/plans/${planId}`, { amount: major(amountMinor, currency), currency, method: "cash", note: null }, k, review, { id: String(planId) }) };
  } },
  { name: "debt schedule receipt", plans: false, agreement: false, debt: true, commission: true,
    // A refunded collection puts the schedule under review; the schedule must be revised before collecting.
    recollect: { status: 409 }, async setup(currency, doctorId) {
    const patientId = await patient("reversal debt"); const { arrangementId, version } = await debtArrangement(patientId, currency, 40 * TENDER[currency], false);
    await q("UPDATE invoice_items SET doctor_id=$1 WHERE invoice_id IN (SELECT id FROM invoices WHERE patient_id=$2)", [doctorId, patientId]);
    return { patientId, collect: (amountMinor, k, review) => post(debtRoute.POST, `/api/patients/${patientId}/debt-repayments/${arrangementId}/collect`,
      { amount: major(amountMinor, currency), currency, method: "cash", note: null, expectedVersion: version }, k, review, { id: String(patientId), arrangementId: String(arrangementId) }) };
  } },
];
type Reversal = { name: string; ui: string; fraction: number;
  send: (paymentId: number, patientId: number, currency: Currency, amountMinor: number, k: string, change?: boolean) => Promise<Sent> };
const REVERSALS: Reversal[] = [
  { name: "full void (POST /api/payments/[id]/correct mode=void)", ui: "ReceiptCorrection «إبطال»", fraction: 1,
    send: (paymentId, _patientId, _currency, _amount, k, change) => post(correctRoute.POST, `/api/payments/${paymentId}/correct`,
      { mode: "void", reason: change ? "Synthetic changed void reason" : "Synthetic money never received" }, k, undefined, { id: String(paymentId) }) },
  { name: "partial reversal by correction to a smaller amount (mode=correct, original target)", ui: "ReceiptCorrection «تصحيح»", fraction: 0.4,
    send: (paymentId, _patientId, currency, amountMinor, k, change) => post(correctRoute.POST, `/api/payments/${paymentId}/correct`,
      { mode: "correct", reason: "Synthetic wrong amount", amount: major(amountMinor - Math.round(amountMinor * 0.4) + (change ? MINOR_UNITS[currency] : 0), currency), currency, method: "cash", target: "original" },
      k, undefined, { id: String(paymentId) }) },
  { name: "partial refund (POST /api/payments kind=refund)", ui: "none (API only, manager)", fraction: 0.4,
    send: (paymentId, patientId, currency, amountMinor, k, change) => post(paymentsRoute.POST, "/api/payments",
      { kind: "refund", patientId, reversalOfId: paymentId, amount: major(Math.round(amountMinor * 0.4) + (change ? MINOR_UNITS[currency] : 0), currency), currency, method: "cash" }, k) },
];

describe.each(ORIGINS)("reversal of a $name", (origin) => {
  describe.each(REVERSALS)("$name", (reversal) => {
    it.each(CURRENCIES)("%s: moves cash, debt, books, plan, agreement, schedule and commission exactly by the reversed amount; replays and conflicts write nothing", async (currency) => {
      const doctorId = await commissionDoctor();
      const { patientId, collect } = await origin.setup(currency, doctorId);
      const N = 4 * TENDER[currency];
      const X = Math.round(N * reversal.fraction);
      const p0 = await position(patientId, currency, doctorId);
      const k1 = key("origin");
      const collected = await collect(N, k1, "none");
      expect(collected.status, JSON.stringify(collected.body)).toBe(201);
      const [originId] = receiptIds(collected.body);
      const [originRow] = await q("SELECT * FROM payments WHERE id=$1", [originId]);
      const p1 = await position(patientId, currency, doctorId);
      expect(p1.drawer - p0.drawer).toBe(N);
      // Every projection asserted below is populated for this origin (no vacuous comparison).
      expect(p1.planPaid.length > 0).toBe(origin.plans);
      expect(p1.agreementRemaining.length > 0).toBe(origin.agreement);
      expect(p1.debt.length > 0).toBe(origin.debt);
      expect(p1.earned > p0.earned).toBe(origin.commission);

      const k2 = key("reversal");
      const reversed = await reversal.send(originId, patientId, currency, N, k2);
      expect(reversed.status, JSON.stringify(reversed.body)).toBe(201);
      const p2 = await position(patientId, currency, doctorId);
      const s2 = await databaseState();

      // Cash and the patient's debt move by exactly the reversed amount, in the receipt's own currency.
      expect(p1.drawer - p2.drawer).toBe(X);
      expect(p2.due - p1.due).toBe(X);
      // The books: the cash-side account falls by X and its counter-account rises by X, nothing else moves.
      const receiptBooks = journalDelta(p0.journal, p1.journal);
      const reversalBooks = journalDelta(p1.journal, p2.journal);
      const cashAccount = Object.keys(receiptBooks).find((id) => id.endsWith(`:${currency}`) && receiptBooks[id] === N && reversalBooks[id] !== undefined);
      expect(cashAccount, JSON.stringify({ receiptBooks, reversalBooks })).toBeDefined();
      expect(reversalBooks[cashAccount!]).toBe(-X);
      expect(Object.values(reversalBooks).reduce((sum, value) => sum + value, 0)).toBe(0);
      // Documents and schedules are never rewritten by a reversal.
      expect(p2.invoices).toEqual(p1.invoices);
      expect(p2.schedule).toEqual(p1.schedule);
      if (origin.plans) expect(p2.planPaid.map((paid, index) => p1.planPaid[index] - paid)).toEqual(p1.planPaid.map(() => X));
      if (origin.agreement) expect(p2.agreementRemaining.map((remaining, index) => remaining - p1.agreementRemaining[index])).toEqual(p1.agreementRemaining.map(() => X));
      if (origin.debt) expect(p2.debt.map((row) => row.requiresReview)).toEqual(p1.debt.map(() => true));
      // Commission: accrual is untouched; earned commission returns by the reversed share of the receipt.
      expect(p2.accrued).toBe(p1.accrued);
      if (reversal.fraction === 1) expect(p2.earned).toBe(p0.earned);
      // The original receipt is append-only: byte-identical after its reversal.
      expect((await q("SELECT * FROM payments WHERE id=$1", [originId]))[0]).toEqual(originRow);

      // A lost-response retry of the reversal replays it; a changed reversal under its key writes nothing.
      const replay = await reversal.send(originId, patientId, currency, N, k2);
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(changedTables(s2, await databaseState())).toEqual([]);
      const changed = await reversal.send(originId, patientId, currency, N, k2, true);
      expect(changed.status, JSON.stringify(changed.body)).toBe(409);
      expect(changedTables(s2, await databaseState())).toEqual([]);
      // The original collection's own lost response, arriving after the reversal, replays the original
      // receipt and never re-collects it.
      const late = await collect(N, k1);
      expect(late.status, JSON.stringify(late.body)).toBe(200);
      expect(receiptIds(late.body)[0]).toBe(originId);
      expect(changedTables(s2, await databaseState())).toEqual([]);
      expect((await position(patientId, currency, doctorId)).drawer).toBe(p2.drawer);

      if (reversal.fraction === 1) {
        // Re-collection after the void, under a new key, follows the door's existing policy.
        const again = await collect(N, key("recollect"), "none");
        expect(again.status, JSON.stringify(again.body)).toBe(origin.recollect.status);
        if (origin.recollect.status === 201) {
          const p3 = await position(patientId, currency, doctorId);
          expect([p3.drawer, p3.due, p3.planPaid, p3.agreementRemaining, p3.earned]).toEqual([p1.drawer, p1.due, p1.planPaid, p1.agreementRemaining, p1.earned]);
          expect(p3.invoices).toEqual(p1.invoices);
        } else {
          if (origin.recollect.reason) expect(again.body.reason).toBe(origin.recollect.reason);
          expect(String(again.body.message)).toMatch(/[\u0600-\u06FF]/);
          expect(changedTables(s2, await databaseState())).toEqual([]);
        }
      }
      if (reversal.fraction < 1) {
        // Commission oracle for a partial reversal: a twin patient who simply paid N − X through the
        // same door earns exactly the same commission (existing engine, no hand-written percentage).
        const twinDoctor = await commissionDoctor();
        const twin = await origin.setup(currency, twinDoctor);
        const twinBefore = await position(twin.patientId, currency, twinDoctor);
        expect((await twin.collect(N - X, key("twin"), "none")).status).toBe(201);
        expect(p2.earned - p0.earned).toBe((await position(twin.patientId, currency, twinDoctor)).earned - twinBefore.earned);
      }
    }, 120_000);
  });
});

describe("receipt correction without a key (the key is optional on this door)", () => {
  it.each(["void", "correct"] as const)("%s: a lost-response retry without a key is refused as already reversed and writes nothing", async (mode) => {
    const patientId = await patient("keyless correction"); const invoiceId = await invoice(patientId, "SAR", 40 * TENDER.SAR);
    const collected = await post(paymentsRoute.POST, "/api/payments", { kind: "payment", patientId, invoiceId, amount: major(TENDER.SAR, "SAR"), currency: "SAR", method: "cash" }, key("keyless"), "none");
    const [paymentId] = receiptIds(collected.body);
    const body = mode === "void" ? { mode, reason: "Synthetic money never received" }
      : { mode, reason: "Synthetic wrong amount", amount: major(TENDER.SAR / 2, "SAR"), currency: "SAR", method: "cash", target: "original" };
    const first = await post(correctRoute.POST, `/api/payments/${paymentId}/correct`, body, null, undefined, { id: String(paymentId) });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const s1 = await databaseState(); const d1 = await drawer();
    const retry = await post(correctRoute.POST, `/api/payments/${paymentId}/correct`, body, null, undefined, { id: String(paymentId) });
    expect(retry.status, JSON.stringify(retry.body)).toBe(409);
    expect(String(retry.body.message)).toMatch(/[\u0600-\u06FF]/);
    expect(changedTables(s1, await databaseState())).toEqual([]);
    expect(await drawer()).toEqual(d1);
  }, 60_000);
});
