import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import { MINOR_UNITS, type Currency } from "../../lib/money";

/**
 * Reversal of ONE allocation of a split (distributed) agreement collection, on PostgreSQL 18 with
 * synthetic data, through the real route handlers (the session gate is the only stub). One tender on
 * an approved agreement that has a recorded upgrade is split by the existing writer into a receipt on
 * the original principal invoice and a receipt on the agreement-delta invoice. Each allocation is
 * reversed independently — full void and partial correction (ReceiptCorrection) and partial refund
 * (API) — separately in YER, SAR and USD. Existing policy is the oracle:
 *  - supported reversals move native cash, patient debt, the cash journal account, the reversed
 *    allocation's invoice and agreement paid/remaining by exactly the reversed amount, and earned
 *    commission by exactly the doctor's configured percent of it, never touch the sibling allocation, any invoice, the schedule, the amendment history or
 *    the split-collection receipt, replay without writes, and refuse a changed payload without writes;
 *  - the original split-collection key, retried late, returns the same complete receipt set;
 *  - unsupported reversals are refused explicitly with zero writes (whole-database content hash) and no
 *    audit row; the audit log is append-only and every replay addition is accounted for.
 */
assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_split_allocation_reversal_test");
process.env.DB_POOL_MAX = "10";
const auth = vi.hoisted(() => ({ session: null as SessionPayload | null }));
vi.mock("@/lib/session", async (original) => ({ ...await original<typeof import("../../lib/session")>(), requireSession: async () => auth.session }));
const db = await import("../../lib/db");
const authLib = await import("../../lib/auth");
const approve = await import("../../lib/approved-agreements");
const amendments = await import("../../lib/agreement-amendment-db");
const { readInvoiceSettlementPosition } = await import("../../lib/invoice-settlement-position");
const { DEFAULT_DOCTOR_COMMISSION_CONFIG } = await import("../../lib/doctor-permissions");
const { clinicDateString } = await import("../../lib/schedule");
const paymentsRoute = await import("../../app/api/payments/route");
const correctRoute = await import("../../app/api/payments/[id]/correct/route");

const CURRENCIES: Currency[] = ["YER", "SAR", "USD"];
const EVER = ["2000-01-01", "2100-12-31"] as const;
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);
/** Fixture amounts (minor units, any currency): agreement 10 × 500.00 upgraded to 10 × 800.00, 1,800.00 paid before the upgrade. */
const PAID_BEFORE = 180_000, SPLIT_TENDER = 400_000, ORIGINAL_SHARE = 320_000, DELTA_SHARE = 80_000;
const major = (minor: number, currency: Currency) => String(minor / MINOR_UNITS[currency]);
let session: SessionPayload;
let serial = 0;
const key = (purpose: string) => `split-reversal-${purpose}-${++serial}`;
const q = async <R = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as R[];

beforeAll(async () => {
  await db.ensureSchema();
  const hash = await authLib.hashPassword("synthetic-split-reversal-password");
  const [user] = await q<{ id: number }>("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('split-reversal-admin','Synthetic split admin',$1,'admin',TRUE) RETURNING id", [hash]);
  session = { userId: user.id, username: "split-reversal-admin", role: "admin", credentialVersion: authLib.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 } as SessionPayload;
  auth.session = session;
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  // Synthetic local FX settings, never live currency rates.
  await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  db.invalidateSettingsCache();
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

// ── whole-database state and projections ─────────────────────────────────────────────────────
let stateSql: string | null = null;
/** One content hash per table. The payments route's documented replay-trace line is checked apart. */
async function databaseState(): Promise<Record<string, string>> {
  if (stateSql === null) {
    const tables = await q<{ name: string }>("SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1");
    stateSql = tables.map(({ name }) => `SELECT '${name}' AS t, count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${name} x${
      name === "public.audit_log" ? " WHERE x.action <> 'payment.idempotent_replay'" : ""}`).join(" UNION ALL ");
  }
  return Object.fromEntries((await q<{ t: string; h: string }>(stateSql)).map((row) => [row.t, row.h]));
}
const changedTables = (before: Record<string, string>, after: Record<string, string>) => Object.keys(after).filter((table) => before[table] !== after[table]).sort();
/**
 * The audit log is append-only: rows up to a mark never change, and every row after it is accounted
 * for. The only row a replay may add is the payments route's documented best-effort trace naming the
 * replayed receipt; a rejected request adds nothing.
 */
async function auditMark() {
  const [row] = await q<{ id: string; h: string }>("SELECT coalesce(max(id),0)::text AS id, coalesce(md5(string_agg(a::text, '|' ORDER BY a.id)), '') AS h FROM audit_log a");
  return { id: Number(row.id), hash: row.h };
}
async function auditSince(mark: { id: number; hash: string }) {
  const [prefix] = await q<{ h: string }>("SELECT coalesce(md5(string_agg(a::text, '|' ORDER BY a.id)), '') AS h FROM audit_log a WHERE a.id <= $1", [mark.id]);
  expect(prefix.h, "audit rows up to the mark are unchanged").toBe(mark.hash);
  return q<{ action: string; entity: string; entity_id: string }>("SELECT action, entity, entity_id FROM audit_log WHERE id > $1 ORDER BY id", [mark.id]);
}

type Fixture = { patientId: number; planId: number; doctorId: number; currency: Currency; originalInvoiceId: number; deltaInvoiceId: number };
async function invoiceRemaining(f: Fixture, invoiceId: number) {
  const client = await db.getPool().connect();
  try { return (await readInvoiceSettlementPosition(client as never, { patientId: f.patientId, invoiceId, currency: f.currency })).remainingMinor; }
  finally { client.release(); }
}
/** Every projection a reversal may move, read through the product's own readers. */
async function position(f: Fixture) {
  const journal = new Map<string, number>();
  for (const entry of await db.journalEntries(...EVER)) for (const line of entry.lines) {
    const id = `${line.accountCode}:${line.currency}`;
    journal.set(id, (journal.get(id) ?? 0) + (line.side === "debit" ? line.amountMinor : -line.amountMinor));
  }
  const commission = (await db.commissionReport(...EVER)).filter((row) => row.doctorId === f.doctorId && row.currency === f.currency);
  const agreement = (await approve.approvedAgreementPosition(f.planId, today))!;
  return {
    drawer: (await db.getOpenShift())!.expected[f.currency],
    due: (await db.computeDebtRows([f.patientId], true)).filter((row) => row.currency === f.currency).reduce((sum, row) => sum + row.dueMinor, 0),
    originalRemaining: await invoiceRemaining(f, f.originalInvoiceId),
    deltaRemaining: await invoiceRemaining(f, f.deltaInvoiceId),
    agreementTotal: agreement.totalMinor, agreementPaid: agreement.paidMinor, agreementRemaining: agreement.remainingMinor,
    accrued: commission.reduce((sum, row) => sum + row.accruedMinor, 0),
    earned: commission.reduce((sum, row) => sum + row.earnedMinor, 0),
    journal,
    // Rows a reversal must never rewrite.
    frozen: JSON.stringify(await q(`SELECT
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM invoices i WHERE i.patient_id=$1) AS invoices,
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM plan_installments s WHERE s.plan_id=$2) AS schedule,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM agreement_delta_amendments a WHERE a.plan_id=$2) AS amendments,
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.idempotency_key) FROM agreement_delta_collection_receipts c WHERE c.plan_id=$2) AS collections`, [f.patientId, f.planId])),
  };
}
const journalDelta = (before: Map<string, number>, after: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...new Set([...before.keys(), ...after.keys()])].map((id): [string, number] => [id, (after.get(id) ?? 0) - (before.get(id) ?? 0)]).filter(([, value]) => value !== 0));

// ── real route handlers and the synthetic split ──────────────────────────────────────────────
type Sent = { status: number; body: Record<string, unknown> };
async function post(handler: (request: Request, context: never) => Promise<Response>, url: string, body: Record<string, unknown>, idempotencyKey: string | null, params?: Record<string, string>): Promise<Sent> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-collection-similarity-review": "none" };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await handler(new Request(`http://localhost${url}`, { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve(params ?? {}) } as never);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
async function fixture(currency: Currency): Promise<Fixture> {
  const [{ id: patientId }] = await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic split reversal patient') RETURNING id", [key("patient")]);
  const service = async (price: number) => (await q<{ id: number }>("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES($1,$2,TRUE,TRUE,'prostho') RETURNING id", [key("service"), price]))[0].id;
  const oldServiceId = await service(50_000), newServiceId = await service(80_000);
  const [{ id: doctorId }] = await q<{ id: number }>("INSERT INTO parties(kind,name,commission_percent) VALUES('doctor',$1,20) RETURNING id", [key("doctor")]);
  await q("INSERT INTO doctor_commission_history(party_id,percent,config,effective_from,source) VALUES($1,20,$2::jsonb,now()-interval '1 day','baseline')",
    [doctorId, JSON.stringify({ ...DEFAULT_DOCTOR_COMMISSION_CONFIG, defaultPercent: 20, deductLabCost: false, deductMaterialCost: false, basis: "collected_cash" })]);
  const plan = await db.createPlanV2({ patientId, title: "Synthetic ten crowns", specialty: null, primaryDoctorId: null, billingMode: "installments", baseCurrency: currency,
    startDate: "2026-10-01", note: null, createdBy: session.username, items: [], installments: [{ dueDate: "2026-10-01", amountMinor: 250_000 }, { dueDate: "2026-12-01", amountMinor: 250_000 }] });
  if (!plan.ok) throw new Error(plan.message);
  await q("INSERT INTO plan_items(plan_id,service_id,service_name,quantity,unit_price_minor,billing_rule,session_count,doctor_id) VALUES($1,$2,'Ten crowns',10,50000,'once',1,$3)", [plan.planId, oldServiceId, doctorId]);
  expect(await db.recordPlanConsent({ planId: plan.planId, actor: session.username, note: null })).toMatchObject({ ok: true });
  const approved = await approve.approveAgreement({ planId: plan.planId, expectedTotalMinor: 500_000, currency, source: { kind: "new" }, reason: "Synthetic approved treatment", idempotencyKey: key("approve"), session });
  await approve.collectApprovedAgreement({ planId: plan.planId, amountMinor: PAID_BEFORE, currency, method: "cash", note: null, idempotencyKey: key("paid"), session });
  const view = await amendments.readAgreementAmendment(plan.planId, session);
  const upgrade = await amendments.saveAgreementAmendment(plan.planId, { idempotencyKey: key("upgrade"), expectedSourceHash: view.sourceHash, newServiceId, newUnitMinor: 80_000,
    reason: "Synthetic documented upgrade consent" }, session);
  return { patientId, planId: plan.planId, doctorId, currency, originalInvoiceId: approved.agreement.invoice_id!, deltaInvoiceId: upgrade.deltaInvoiceId };
}
/** The split collection through the real payments door; returns its key, request body and receipts. */
async function splitCollection(f: Fixture) {
  const splitKey = key("collect");
  const body = { kind: "payment", patientId: f.patientId, planId: f.planId, amount: major(SPLIT_TENDER, f.currency), currency: f.currency, method: "cash" };
  const sent = await post(paymentsRoute.POST, "/api/payments", body, splitKey);
  expect(sent.status, JSON.stringify(sent.body)).toBe(201);
  const ids = sent.body.paymentIds as number[];
  const rows = await q<{ id: number; invoice_id: number; amount: number }>("SELECT id, invoice_id, amount_minor::int AS amount FROM payments WHERE id = ANY($1::int[]) ORDER BY id", [ids]);
  expect(rows.map((row) => [row.invoice_id, row.amount])).toEqual([[f.originalInvoiceId, ORIGINAL_SHARE], [f.deltaInvoiceId, DELTA_SHARE]]);
  return { splitKey, body, ids, byTarget: { original: rows[0], delta: rows[1] } };
}

/**
 * The doctor's configured commission policy, read from its history row, not restated here: earned
 * commission is `percent` of the cash collected on that doctor's invoice lines (basis collected_cash,
 * lab/material deductions off), and accrual is `percent` of the doctor's billed work. Precondition:
 * every line of both agreement invoices is this doctor's, so the whole tender and agreement count.
 */
async function commissionPolicy(f: Fixture) {
  const [policy] = await q<{ percent: string; config: { basis: string; deductLabCost: boolean; deductMaterialCost: boolean } }>(
    "SELECT percent::text, config FROM doctor_commission_history WHERE party_id=$1 ORDER BY effective_from DESC, id DESC LIMIT 1", [f.doctorId]);
  expect(policy.config).toMatchObject({ basis: "collected_cash", deductLabCost: false, deductMaterialCost: false });
  expect(await q("SELECT DISTINCT doctor_id FROM invoice_items WHERE invoice_id = ANY($1::int[])", [[f.originalInvoiceId, f.deltaInvoiceId]])).toEqual([{ doctor_id: f.doctorId }]);
  const percent = Number(policy.percent);
  return { share: (minor: number) => Math.round((minor * percent) / 100) };
}

type Target = "original" | "delta";
type Reversal = { name: string; ui: string; reversed: (allocation: number) => number;
  send: (f: Fixture, paymentId: number, allocation: number, k: string | null, changed?: boolean) => Promise<Sent> };
const REVERSALS: Reversal[] = [
  { name: "full void", ui: "ReceiptCorrection «إبطال» (POST /api/payments/[id]/correct mode=void)", reversed: (allocation) => allocation,
    send: (_f, paymentId, _allocation, k, changed) => post(correctRoute.POST, `/api/payments/${paymentId}/correct`,
      { mode: "void", reason: changed ? "Synthetic changed void reason" : "Synthetic money never received" }, k, { id: String(paymentId) }) },
  { name: "partial correction to 60%", ui: "ReceiptCorrection «تصحيح», original target (mode=correct)", reversed: (allocation) => allocation - Math.round(allocation * 0.6),
    send: (f, paymentId, allocation, k, changed) => post(correctRoute.POST, `/api/payments/${paymentId}/correct`,
      { mode: "correct", reason: "Synthetic wrong amount", amount: major(Math.round(allocation * 0.6) + (changed ? MINOR_UNITS[f.currency] : 0), f.currency), currency: f.currency, method: "cash", target: "original" },
      k, { id: String(paymentId) }) },
  { name: "partial refund of 40%", ui: "API only, manager (POST /api/payments kind=refund)", reversed: (allocation) => Math.round(allocation * 0.4),
    send: (f, paymentId, allocation, k, changed) => post(paymentsRoute.POST, "/api/payments",
      { kind: "refund", patientId: f.patientId, reversalOfId: paymentId, amount: major(Math.round(allocation * 0.4) + (changed ? MINOR_UNITS[f.currency] : 0), f.currency), currency: f.currency, method: "cash" }, k) },
];

describe.each(CURRENCIES)("%s split collection", (currency) => {
  describe.each(["original", "delta"] as Target[])("reversing the %s allocation", (target) => {
    it.each(REVERSALS)("$name moves only that allocation, by exactly the reversed amount; replays, conflicts and the late split retry write nothing", async (reversal) => {
      const f = await fixture(currency);
      const p0 = await position(f);
      const split = await splitCollection(f);
      const p1 = await position(f);
      const sibling: Target = target === "original" ? "delta" : "original";
      const allocation = split.byTarget[target], other = split.byTarget[sibling];
      const allocationRows = await q("SELECT * FROM payments WHERE id = ANY($1::int[]) ORDER BY id", [split.ids]);
      // The split itself is meaningful for every projection asserted below.
      expect(p1.drawer - p0.drawer).toBe(SPLIT_TENDER);
      const policy = await commissionPolicy(f);
      expect(p1.earned - p0.earned).toBe(policy.share(SPLIT_TENDER));
      expect(p1.accrued).toBe(policy.share(p1.agreementTotal));

      const k = key("reverse");
      const sent = await reversal.send(f, allocation.id, allocation.amount, k);
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      const X = reversal.reversed(allocation.amount);
      const p2 = await position(f);
      const s2 = await databaseState();

      // Native cash and the patient's debt move by exactly X; the agreement and the reversed invoice reopen by X.
      expect(p1.drawer - p2.drawer).toBe(X);
      expect(p2.due - p1.due).toBe(X);
      expect([p1.agreementPaid - p2.agreementPaid, p2.agreementRemaining - p1.agreementRemaining]).toEqual([X, X]);
      const remainingKey = target === "original" ? "originalRemaining" : "deltaRemaining";
      const siblingKey = target === "original" ? "deltaRemaining" : "originalRemaining";
      expect(p2[remainingKey] - p1[remainingKey]).toBe(X);
      expect(p2[siblingKey]).toBe(p1[siblingKey]);
      // Books: the cash-side account falls by X and the reversal entries balance.
      const splitBooks = journalDelta(p0.journal, p1.journal), reversalBooks = journalDelta(p1.journal, p2.journal);
      const cashAccount = Object.keys(splitBooks).find((id) => id.endsWith(`:${currency}`) && splitBooks[id] === SPLIT_TENDER && reversalBooks[id] !== undefined);
      expect(cashAccount, JSON.stringify({ splitBooks, reversalBooks })).toBeDefined();
      expect(reversalBooks[cashAccount!]).toBe(-X);
      expect(Object.values(reversalBooks).reduce((sum, value) => sum + value, 0)).toBe(0);
      // Commission under the configured policy: accrual untouched; earned falls by exactly percent × X.
      expect(p2.accrued).toBe(p1.accrued);
      expect(p1.earned - p2.earned).toBe(policy.share(X));
      // Invoices, schedule, amendment history and the split-collection receipt are never rewritten;
      // both original allocation receipts are byte-identical and the sibling has no reversal.
      expect(p2.frozen).toBe(p1.frozen);
      expect(await q("SELECT * FROM payments WHERE id = ANY($1::int[]) ORDER BY id", [split.ids])).toEqual(allocationRows);
      expect(await q("SELECT id FROM payments WHERE reversal_of_id=$1", [other.id])).toEqual([]);

      // A lost-response retry of the reversal replays it; the same key with a changed payload writes nothing.
      const mark = await auditMark();
      const replay = await reversal.send(f, allocation.id, allocation.amount, k);
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(changedTables(s2, await databaseState())).toEqual([]);
      const changed = await reversal.send(f, allocation.id, allocation.amount, k, true);
      expect(changed.status, JSON.stringify(changed.body)).toBe(409);
      expect(String(changed.body.message)).toMatch(/[؀-ۿ]/);
      expect(changedTables(s2, await databaseState())).toEqual([]);
      // The original split key, retried late, returns the same complete receipt set and collects nothing.
      const late = await post(paymentsRoute.POST, "/api/payments", split.body, split.splitKey);
      expect(late.status, JSON.stringify(late.body)).toBe(200);
      expect(late.body.paymentIds).toEqual(split.ids);
      const lateChanged = await post(paymentsRoute.POST, "/api/payments", { ...split.body, amount: major(SPLIT_TENDER + MINOR_UNITS[currency], currency) }, split.splitKey);
      expect(lateChanged.status, JSON.stringify(lateChanged.body)).toBe(409);
      expect(changedTables(s2, await databaseState())).toEqual([]);
      expect((await position(f)).drawer).toBe(p2.drawer);
      // Audit: append-only, and the only addition is the payments route's replay trace for a refund
      // replay (naming that refund). Correction replays, the late split retry and every rejection add none.
      const refundId = reversal.name.includes("refund") ? String(sent.body.id) : null;
      expect(await auditSince(mark)).toEqual(refundId ? [{ action: "payment.idempotent_replay", entity: "payment", entity_id: refundId }] : []);
    }, 120_000);
  });

  it("voiding both allocations returns every projection to its pre-split state, sibling by sibling", async () => {
    const f = await fixture(currency);
    const p0 = await position(f);
    const split = await splitCollection(f);
    const afterSplit = await position(f);
    for (const target of ["delta", "original"] as Target[]) {
      const before = await position(f);
      const sent = await REVERSALS[0].send(f, split.byTarget[target].id, split.byTarget[target].amount, key("void-both"));
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      const after = await position(f);
      const untouched = target === "delta" ? "originalRemaining" : "deltaRemaining";
      expect(after[untouched]).toBe(before[untouched]);
    }
    const p2 = await position(f);
    for (const field of ["drawer", "due", "originalRemaining", "deltaRemaining", "agreementPaid", "agreementRemaining", "earned"] as const) expect(p2[field], field).toBe(p0[field]);
    expect(p2.accrued).toBe(afterSplit.accrued);
    expect(p2.frozen).toBe(afterSplit.frozen);
  }, 120_000);

  it("concurrent reversals: the same key commits once; two different keys cannot void one allocation twice", async () => {
    const f = await fixture(currency);
    const split = await splitCollection(f);
    const delta = split.byTarget.delta, original = split.byTarget.original;
    const k = key("concurrent-same");
    const same = await Promise.all([1, 2].map(() => REVERSALS[2].send(f, delta.id, delta.amount, k)));
    expect(same.map((sent) => sent.status).sort()).toEqual([200, 201]);
    expect(same[0].body.id).toBe(same[1].body.id);
    const p1 = await position(f);
    const distinct = await Promise.all([key("concurrent-a"), key("concurrent-b")].map((kk) => REVERSALS[0].send(f, original.id, original.amount, kk)));
    expect(distinct.map((sent) => sent.status).sort()).toEqual([201, 409]);
    const p2 = await position(f);
    expect(p1.drawer - p2.drawer).toBe(original.amount);
    expect(p2.deltaRemaining).toBe(p1.deltaRemaining);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM payments WHERE reversal_of_id=$1", [original.id]))[0].n).toBe(1);
  }, 120_000);

  it("unsupported reversals are refused explicitly with zero writes", async () => {
    const f = await fixture(currency);
    const split = await splitCollection(f);
    const delta = split.byTarget.delta, original = split.byTarget.original;
    const other: Currency = currency === "YER" ? "SAR" : "YER";
    const refusals: [string, () => Promise<Sent>][] = [
      ["refund beyond the allocation (still within the split total)", () => post(paymentsRoute.POST, "/api/payments",
        { kind: "refund", patientId: f.patientId, reversalOfId: delta.id, amount: major(delta.amount + MINOR_UNITS[currency], currency), currency, method: "cash" }, key("over"))],
      ["refund in another currency", () => post(paymentsRoute.POST, "/api/payments",
        { kind: "refund", patientId: f.patientId, reversalOfId: delta.id, amount: major(100, other), currency: other, method: "cash" }, key("currency"))],
      ["correction redirected to the plan", () => post(correctRoute.POST, `/api/payments/${delta.id}/correct`,
        { mode: "correct", reason: "Synthetic plan target", amount: major(delta.amount, currency), currency, method: "cash", planId: f.planId }, key("plan"), { id: String(delta.id) })],
      ...(currency === "YER" ? [] : [["correction into another currency (foreign agreement)", () => post(correctRoute.POST, `/api/payments/${original.id}/correct`,
        { mode: "correct", reason: "Synthetic currency", amount: major(1000, other), currency: other, method: "cash", target: "original" }, key("fx"), { id: String(original.id) })] as [string, () => Promise<Sent>]]),
    ];
    for (const [label, send] of refusals) {
      const s0 = await databaseState(); const mark = await auditMark();
      const refused = await send();
      expect(refused.status, `${label}: ${JSON.stringify(refused.body)}`).toBe(409);
      expect(String(refused.body.message), label).toMatch(/[؀-ۿ]/);
      expect(changedTables(s0, await databaseState()), label).toEqual([]);
      expect(await auditSince(mark), label).toEqual([]);
    }
    // After a full void, any further void or refund of that allocation is refused, with zero writes.
    expect((await REVERSALS[0].send(f, delta.id, delta.amount, key("void"))).status).toBe(201);
    const s1 = await databaseState(); const mark1 = await auditMark();
    for (const [label, send] of [
      ["second void", () => REVERSALS[0].send(f, delta.id, delta.amount, key("void-again"))],
      ["refund after void", () => REVERSALS[2].send(f, delta.id, delta.amount, key("refund-after"))],
    ] as [string, () => Promise<Sent>][]) {
      const refused = await send();
      expect(refused.status, `${label}: ${JSON.stringify(refused.body)}`).toBe(409);
      expect(changedTables(s1, await databaseState()), label).toEqual([]);
    }
    expect(await auditSince(mark1)).toEqual([]);
  }, 120_000);

  /* Correcting the delta allocation onto its sibling (the fully-settled original invoice) is refused by the
     approved-source guard (assertApprovedReceiptLimit, a typed DebtRepaymentError "invalid"). The correction
     route answers it exactly as /api/payments answers that error: 400, code "invalid", the guard's Arabic
     reason — and nothing is written (regression for the former generic 500 «أعد المحاولة»). */
  it("a correction onto the settled sibling invoice is an explicit 400 invalid refusal with zero writes", async () => {
    const f = await fixture(currency);
    const split = await splitCollection(f);
    const s0 = await databaseState(); const mark = await auditMark(); const p0 = await position(f);
    const body = { mode: "correct", reason: "Synthetic move to sibling", amount: major(DELTA_SHARE, currency), currency, method: "cash", invoiceId: f.originalInvoiceId };
    for (const k of [key("sibling"), key("sibling-again")]) {
      const sent = await post(correctRoute.POST, `/api/payments/${split.byTarget.delta.id}/correct`, body, k, { id: String(split.byTarget.delta.id) });
      expect(sent.status, JSON.stringify(sent.body)).toBe(400);
      expect(sent.body.code).toBe("invalid");
      expect(String(sent.body.message)).toBe("المبلغ يتجاوز متبقي المصدر أو الحساب.");
    }
    expect(changedTables(s0, await databaseState())).toEqual([]);
    expect(await auditSince(mark)).toEqual([]);
    const p1 = await position(f);
    expect([p1.drawer, p1.due, p1.originalRemaining, p1.deltaRemaining, p1.agreementRemaining, p1.earned, p1.frozen])
      .toEqual([p0.drawer, p0.due, p0.originalRemaining, p0.deltaRemaining, p0.agreementRemaining, p0.earned, p0.frozen]);
  }, 120_000);
});
