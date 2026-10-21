import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { Currency } from "../../lib/money";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";

/**
 * Advisory similar-collection review on real PostgreSQL 18, through the real HTTP route handlers.
 * Synthetic patients, users and shift only. The review runs inside each writer transaction after
 * the open-shift lock and the exact-key replay check (lib/similar-collection.ts). Concurrency is
 * made deterministic by holding the shift row from a separate connection, then releasing it.
 */
assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_similar_collection_test");
// Up to three writers wait on the shift at once; each holds its own pooled connection.
process.env.DB_POOL_MAX = "10";
const auth = vi.hoisted(() => ({ session: null as SessionPayload | null }));
vi.mock("@/lib/session", async (original) => ({ ...await original<typeof import("../../lib/session")>(), requireSession: async () => auth.session }));
const db = await import("../../lib/db");
const authLib = await import("../../lib/auth");
const agreements = await import("../../lib/approved-agreements");
const { createLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const { saveDebtRepayment } = await import("../../lib/debt-installments-db");
const { clinicDateString } = await import("../../lib/schedule");
const payments = await import("../../app/api/payments/route");
const plans = await import("../../app/api/plans/[id]/route");
const debt = await import("../../app/api/patients/[id]/debt-repayments/[arrangementId]/collect/route");
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);
let session: SessionPayload;
let doctorId: number;
let serviceId: number;
let serial = 0;
const q = async <R = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as R[];
const key = (purpose: string) => `similar-${purpose}-${++serial}`;
const H = "x-collection-similarity-review";

beforeAll(async () => {
  await db.ensureSchema();
  const hash = await authLib.hashPassword("synthetic-similar-password");
  const [user] = await q<{ id: number }>("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('similar-admin','Synthetic similar',$1,'admin',TRUE) RETURNING id", [hash]);
  session = { userId: user.id, username: "similar-admin", role: "admin", credentialVersion: authLib.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
  auth.session = session;
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  db.invalidateSettingsCache();
  doctorId = (await q<{ id: number }>("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic similar provider') RETURNING id"))[0].id;
  serviceId = (await q<{ id: number }>("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('Synthetic similar RCT',100000,TRUE,TRUE,'rct') RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function patient() {
  return (await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic similar patient') RETURNING id", [key("patient")]))[0].id;
}
async function invoice(patientId: number, currency: Currency = "YER", totalMinor = 1_000_000) {
  const [row] = await q<{ id: number }>("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES($1,$2,$3,0,$4) RETURNING id",
    [key("inv"), patientId, totalMinor, currency]);
  await q("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Synthetic service',1,$2,$2)", [row.id, totalMinor]);
  return row.id;
}
type Sent = { status: number; body: Record<string, unknown> };
async function send(handler: (request: Request, ...rest: never[]) => Promise<Response>, url: string, body: Record<string, unknown>, idempotencyKey: string, review?: string, ...rest: unknown[]): Promise<Sent> {
  const headers: Record<string, string> = { "content-type": "application/json", "idempotency-key": idempotencyKey };
  if (review !== undefined) headers[H] = review;
  const response = await (handler as (request: Request, ...args: unknown[]) => Promise<Response>)(new Request(`http://localhost${url}`, { method: "POST", headers, body: JSON.stringify(body) }), ...rest);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
const pay = (body: Record<string, unknown>, k: string, review?: string) => send(payments.POST, "/api/payments", { kind: "payment", method: "cash", ...body }, k, review);
async function effects(patientId: number) {
  const [row] = await q<{ payments: number; audits: number; refunds: number }>(`SELECT
    (SELECT COUNT(*)::int FROM payments WHERE patient_id=$1 AND kind='payment') AS payments,
    (SELECT COUNT(*)::int FROM payments WHERE patient_id=$1 AND kind='refund') AS refunds,
    (SELECT COUNT(*)::int FROM audit_log a WHERE a.entity='payment' AND a.entity_id IN (SELECT id::text FROM payments WHERE patient_id=$1)) AS audits`, [patientId]);
  return { ...row, drawer: (await db.getOpenShift())!.expected };
}
const ids = (body: Record<string, unknown>) => (body.receipts as { id: number }[]).map((receipt) => receipt.id);

/**
 * Holds the open shift row like an in-flight writer. A separate autocommit monitor counts waiters:
 * pg_stat_activity is snapshotted once per transaction, so the holder itself cannot observe them.
 */
async function holdShift() {
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  const monitor = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect(); await monitor.connect();
  await holder.query("BEGIN");
  await holder.query("SELECT id FROM cashier_shifts WHERE status='open' FOR UPDATE");
  const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  let released = false;
  return {
    async waiting(count: number) {
      for (let i = 0; i < 400; i++) {
        const { rows: [{ n }] } = await monitor.query<{ n: number }>(
          "SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid NOT IN ($1, pg_backend_pid()) AND wait_event_type = 'Lock' AND query LIKE '%cashier_shifts%FOR UPDATE%'", [pid]);
        if (n >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`expected ${count} writers waiting on the shift lock`);
    },
    async release() {
      if (released) return; released = true;
      try { await holder.query("COMMIT"); } finally { await holder.end(); await monitor.end(); }
    },
  };
}

describe("advisory similar-collection review: payments route", () => {
  it("first collection proceeds; a second same patient/amount/currency is asked to review, with nothing written", async () => {
    const p = await patient(); const inv = await invoice(p);
    const first = await pay({ patientId: p, invoiceId: inv, amount: "71593", currency: "YER" }, key("first"));
    expect(first.status).toBe(201);
    const before = await effects(p);
    const second = await pay({ patientId: p, invoiceId: inv, amount: "71593", currency: "YER" }, key("second"));
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ reason: "similar_collection_review_required", windowHours: 24 });
    expect(typeof second.body.message).toBe("string");
    expect(ids(second.body)).toEqual([first.body.id]);
    expect((second.body.receipts as Record<string, unknown>[])[0]).toMatchObject({ receiptNumber: first.body.receiptNumber, amountMinor: 71593, currency: "YER", createdBy: session.username });
    expect(await effects(p)).toEqual(before);
  });

  it("confirming exactly the reported receipts records an independent payment; a stale confirmation is asked again", async () => {
    const p = await patient(); const inv = await invoice(p);
    const a = await pay({ patientId: p, invoiceId: inv, amount: "500", currency: "YER" }, key("a"));
    const k = key("b");
    const asked = await pay({ patientId: p, invoiceId: inv, amount: "500", currency: "YER" }, k, "none");
    expect(asked.status).toBe(409);
    const confirmed = await pay({ patientId: p, invoiceId: inv, amount: "500", currency: "YER" }, k, `ids:${ids(asked.body).join(",")}`);
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.id).not.toBe(a.body.id);
    // A third collection that only confirms the first receipt has a stale view: asked again, nothing written.
    const before = await effects(p);
    const stale = await pay({ patientId: p, invoiceId: inv, amount: "500", currency: "YER" }, key("c"), `ids:${a.body.id}`);
    expect(stale.status).toBe(409);
    expect(ids(stale.body)).toEqual([confirmed.body.id, a.body.id]);
    expect(await effects(p)).toEqual(before);
  });

  it("an exact-key retry of a committed request replays its receipt, even after similar receipts appeared and without a review header", async () => {
    const p = await patient(); const inv = await invoice(p);
    const k = key("orig");
    const original = await pay({ patientId: p, invoiceId: inv, amount: "900", currency: "YER" }, k);
    const other = await pay({ patientId: p, invoiceId: inv, amount: "900", currency: "YER" }, key("other"), `ids:${original.body.id}`);
    expect(other.status).toBe(201);
    const before = await effects(p);
    const replay = await pay({ patientId: p, invoiceId: inv, amount: "900", currency: "YER" }, k);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(original.body.id);
    expect((await effects(p)).payments).toBe(before.payments);
  });

  it("two devices with distinct keys racing: the shift lock serializes them, one records and the other is asked to review", async () => {
    const p = await patient(); const inv = await invoice(p);
    const before = await effects(p);
    const lock = await holdShift();
    const racing = [key("dev-a"), key("dev-b")].map((k) => pay({ patientId: p, invoiceId: inv, amount: "1234", currency: "YER" }, k, "none"));
    try { await lock.waiting(2); } finally { await lock.release(); }
    const results = await Promise.all(racing);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const saved = results.find((r) => r.status === 201)!;
    expect(ids(results.find((r) => r.status === 409)!.body)).toEqual([saved.body.id]);
    expect((await effects(p)).payments).toBe(before.payments + 1);
  });

  it("a same-key retry while the original is still in flight is answered by replay, never by a review refusal", async () => {
    const p = await patient(); const inv = await invoice(p);
    const prior = await pay({ patientId: p, invoiceId: inv, amount: "4321", currency: "YER" }, key("prior"));
    const k = key("inflight");
    const review = `ids:${prior.body.id}`;
    const lock = await holdShift();
    let original!: Promise<Sent>, retry!: Promise<Sent>, recovery!: Promise<Sent>;
    try {
      original = pay({ patientId: p, invoiceId: inv, amount: "4321", currency: "YER" }, k, review);
      await lock.waiting(1);
      retry = pay({ patientId: p, invoiceId: inv, amount: "4321", currency: "YER" }, k, review);
      await lock.waiting(2);
      recovery = pay({ patientId: p, invoiceId: inv, amount: "4321", currency: "YER" }, k); // reload: no header
      await lock.waiting(3);
    } finally { await lock.release(); }
    const [o, r, s] = await Promise.all([original, retry, recovery]);
    const saved = [o, r, s].filter((one) => one.status === 201);
    expect(saved).toHaveLength(1);
    expect([o, r, s].filter((one) => one.status === 200).map((one) => one.body.id)).toEqual([saved[0].body.id, saved[0].body.id]);
    expect((await q("SELECT id FROM payments WHERE idempotency_key=$1", [k]))).toHaveLength(1);
  });

  it("only same patient, native amount and currency in the last 24h; fully refunded receipts drop out, partial refunds stay", async () => {
    const p = await patient(); const other = await patient();
    const yer = await invoice(p); const sar = await invoice(p, "SAR", 100_000); const otherInv = await invoice(other);
    const base = await pay({ patientId: p, invoiceId: yer, amount: "600", currency: "YER" }, key("base"));
    expect((await pay({ patientId: p, invoiceId: sar, amount: "6.00", currency: "SAR" }, key("sar"))).status).toBe(201);
    expect((await pay({ patientId: other, invoiceId: otherInv, amount: "600", currency: "YER" }, key("other-patient"))).status).toBe(201);
    expect((await pay({ patientId: p, invoiceId: yer, amount: "601", currency: "YER" }, key("other-amount"))).status).toBe(201);
    // A partial refund does not hide the receipt; refunds themselves are never advisory-reviewed.
    auth.session = session;
    const partial = await send(payments.POST, "/api/payments", { kind: "refund", method: "cash", patientId: p, reversalOfId: base.body.id, amount: "100", currency: "YER" }, key("partial"));
    expect(partial.status).toBe(201);
    expect(ids((await pay({ patientId: p, invoiceId: yer, amount: "600", currency: "YER" }, key("probe1"))).body)).toEqual([base.body.id]);
    const rest = await send(payments.POST, "/api/payments", { kind: "refund", method: "cash", patientId: p, reversalOfId: base.body.id, amount: "500", currency: "YER" }, key("rest"));
    expect(rest.status).toBe(201);
    expect((await pay({ patientId: p, invoiceId: yer, amount: "600", currency: "YER" }, key("after-full-refund"))).status).toBe(201);
    // Outside the window: a synthetic receipt dated 25 hours ago is not similar.
    const p2 = await patient(); const inv2 = await invoice(p2);
    const old = await pay({ patientId: p2, invoiceId: inv2, amount: "700", currency: "YER" }, key("old"));
    await q("ALTER TABLE payments DISABLE TRIGGER payments_append_only");
    try { await q("UPDATE payments SET created_at = NOW() - INTERVAL '25 hours' WHERE id=$1", [old.body.id]); }
    finally { await q("ALTER TABLE payments ENABLE TRIGGER payments_append_only"); }
    expect((await pay({ patientId: p2, invoiceId: inv2, amount: "700", currency: "YER" }, key("fresh"))).status).toBe(201);
  });

  it("a malformed review header is refused before any write", async () => {
    const p = await patient(); const inv = await invoice(p);
    const before = await effects(p);
    for (const bad of ["ids:", "ids:0", "ids:1,1", "yes", "ids:-4"]) {
      const response = await pay({ patientId: p, invoiceId: inv, amount: "10", currency: "YER" }, key("bad"), bad);
      expect(response.status, bad).toBe(400);
      expect(typeof response.body.message).toBe("string");
    }
    expect(await effects(p)).toEqual(before);
  });
});

describe("advisory review covers every human collection entry point", () => {
  async function approvedPlan(patientId: number) {
    const result = await db.createPlanV2({ patientId, title: "Synthetic approved", specialty: null, primaryDoctorId: doctorId,
      billingMode: "installments", baseCurrency: "YER", startDate: today, note: null, createdBy: session.username,
      items: [{ serviceId, serviceName: "Synthetic similar RCT", category: "rct", toothCode: 36, surfaces: null,
        quantity: 1, unitPriceMinor: 100000, billingRule: "per_session", sessionCount: 2, note: null }],
      installments: [{ dueDate: today, amountMinor: 40000 }, { dueDate: "2099-12-01", amountMinor: 60000 }] });
    if (!result.ok) throw new Error(result.message);
    await db.recordPlanConsent({ planId: result.planId, actor: session.username, note: null });
    await agreements.approveAgreement({ planId: result.planId, expectedTotalMinor: 100000, currency: "YER", source: { kind: "new" },
      reason: "Synthetic explicit approval", idempotencyKey: key("approve"), session });
    return result.planId;
  }

  it("approved agreement via /api/payments and /api/plans/[id]: asked to review, nothing written, confirmation records", async () => {
    const p = await patient(); const planId = await approvedPlan(p);
    const first = await pay({ patientId: p, planId, amount: "250", currency: "YER" }, key("plan-a"));
    expect(first.status).toBe(201);
    const before = await effects(p);
    const viaPayments = await pay({ patientId: p, planId, amount: "250", currency: "YER" }, key("plan-b"));
    expect(viaPayments.status).toBe(409);
    expect(ids(viaPayments.body)).toEqual([first.body.id]);
    const k = key("plan-c");
    const viaPlans = await send(plans.POST, `/api/plans/${planId}`, { amount: "250", currency: "YER", method: "cash" }, k, undefined, { params: Promise.resolve({ id: String(planId) }) });
    expect(viaPlans.status).toBe(409);
    expect(await effects(p)).toEqual(before);
    const confirmed = await send(plans.POST, `/api/plans/${planId}`, { amount: "250", currency: "YER", method: "cash" }, k, `ids:${first.body.id}`, { params: Promise.resolve({ id: String(planId) }) });
    expect(confirmed.status).toBe(201);
    expect((await effects(p)).payments).toBe(before.payments + 1);
  });

  it("debt repayment collection: asked to review, nothing written, confirmation records, exact replay unaffected", async () => {
    const p = await patient();
    const saved = await createLinkedInvoice({ patientId: p, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: session.username,
      actorRole: session.role, items: [{ serviceId, category: "rct", doctorId, description: "Synthetic invoice-origin RCT", quantity: 1,
        unitPriceMinor: 100000, toothCode: 36, caseId: null, sessions: null, surfaces: null }],
      templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: key("linked"), requestHash: key("linked-hash"), auditDetails: {} });
    if (!saved.ok) throw new Error("synthetic invoice failed");
    const schedule = await saveDebtRepayment({ target: { patientId: p, currency: "YER", invoiceId: saved.invoice.id, openingCurrency: null },
      terms: { mode: "installments", installments: [{ dueDate: today, amountMinor: 40000, kind: "installment" }, { dueDate: "2099-12-01", amountMinor: 60000, kind: "installment" }] },
      expectedVersion: 0, expectedRemainingMinor: 100000, reason: "Synthetic schedule", idempotencyKey: key("schedule"), session });
    const params = { params: Promise.resolve({ id: String(p), arrangementId: String(schedule.arrangementId) }) };
    const url = `/api/patients/${p}/debt-repayments/${schedule.arrangementId}/collect`;
    const body = { amount: "300", currency: "YER", method: "cash", note: null, expectedVersion: 1 };
    const k1 = key("debt-1");
    const first = await send(debt.POST, url, body, k1, undefined, params);
    expect(first.status).toBe(201);
    const firstId = (first.body.payment as { id: number }).id;
    const before = await effects(p);
    const k2 = key("debt-2");
    const asked = await send(debt.POST, url, body, k2, undefined, params);
    expect(asked.status).toBe(409);
    expect(ids(asked.body)).toEqual([firstId]);
    expect(await effects(p)).toEqual(before);
    const confirmed = await send(debt.POST, url, body, k2, `ids:${firstId}`, params);
    expect(confirmed.status).toBe(201);
    const replay = await send(debt.POST, url, body, k1, undefined, params);
    expect(replay.status).toBe(200);
    expect((replay.body.payment as { id: number }).id).toBe(firstId);
    expect((await effects(p)).payments).toBe(before.payments + 1);
  });
});
