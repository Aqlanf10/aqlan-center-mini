/** M2 slice 90d (G4-4): deferring a visit's payment and proving a collection attempt's
 * outcome on the canonical runtime, real PostgreSQL, synthetic data only. Both are money
 * decisions under finance.payments.collect (never visits.manage or a view grant), inside the
 * patient scope; outside reads like missing; the deferral decides the scope on the locked
 * visit row (a race test shows it); audits in the transaction; revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-defer-retire-secret-90d");
const db = await import("../../lib/db");
const visits = await import("../../lib/canonical-visits");
const rc = await import("../../lib/canonical-receipt-writes");

const ACCOUNTS = {
  owner: { username: "SYN-DR-OWNER", role: "admin" },
  collector: { username: "SYN-DR-COLL", role: "reception", patientScope: "all", grants: { "finance.payments.collect": true } },
  manager: { username: "SYN-DR-MGR", role: "reception", patientScope: "all", grants: { "visits.manage": true, "finance.payments.view": true, "finance.invoices.view": true } },
  doctor: { username: "SYN-DR-DR", role: "doctor", doctor: true, patientScope: "own", grants: { "finance.payments.collect": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const patient = async (doctor: number | null = null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN DR patient',$2) RETURNING id", [`SYN-DR-${++serial}`, doctor]))[0].id as number;
const visit = async (patientId: number, signed = true) => (await q(
  "INSERT INTO visits(patient_name,patient_id,signed_at) VALUES('SYN DR visit',$1,$2) RETURNING id", [patientId, signed ? new Date() : null]))[0].id as number;
const deferAudits = async (visitId: number) => q("SELECT actor, details->>'السبب' AS reason FROM audit_log WHERE action='visit.payment_deferred' AND entity_id=$1::text", [visitId]);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
  await db.openShift({ openedBy: "SYN-DR-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("deferring a visit's payment", () => {
  it("finance.payments.collect defers a signed visit with its reason audited; a second deferral is already done", async () => {
    const v = await visit(await patient());
    expect(await visits.commandCanonicalVisitDefer(await fx.session("collector"), v, visits.parseCanonicalVisitDefer({ reason: "  SYN later  " })))
      .toMatchObject({ ok: true, already: false });
    expect(await deferAudits(v)).toEqual([{ actor: "SYN-DR-COLL", reason: "SYN later" }]);
    expect(await visits.commandCanonicalVisitDefer(await fx.session("collector"), v, { reason: null })).toMatchObject({ ok: true, already: true });
    expect(await deferAudits(v)).toHaveLength(1);
  });

  it("an unsigned visit is refused; visits.manage and view grants never defer; nothing is audited", async () => {
    const unsigned = await visit(await patient(), false), signed = await visit(await patient());
    expect(await refusal(visits.commandCanonicalVisitDefer(await fx.session("collector"), unsigned, { reason: null }))).toMatchObject({ code: "visit_not_signed", status: 409 });
    expect(await refusal(visits.commandCanonicalVisitDefer(await fx.session("manager"), signed, { reason: null }))).toMatchObject(denied);
    expect(await deferAudits(unsigned)).toEqual([]); expect(await deferAudits(signed)).toEqual([]);
  });

  it("an own collector defers its patient's visit; another patient's and a missing visit read alike (404); revocation", async () => {
    const mine = await visit(await patient(fx.parties.doctor!)), outside = await visit(await patient());
    expect(await visits.commandCanonicalVisitDefer(await fx.session("doctor"), mine, { reason: null })).toMatchObject({ ok: true });
    for (const id of [outside, 2_000_000_000]) {
      expect(await refusal(visits.commandCanonicalVisitDefer(await fx.session("doctor"), id, { reason: null }))).toMatchObject({ code: "visit_not_found", status: 404 });
    }
    expect(await deferAudits(outside)).toEqual([]);
    await fx.setGrants("collector", {}, { patientScope: "all" });
    try { expect(await refusal(visits.commandCanonicalVisitDefer(await fx.session("collector"), outside, { reason: null }))).toMatchObject(denied); }
    finally { await fx.setGrants("collector", { "finance.payments.collect": true }, { patientScope: "all" }); }
  });

  it("refuses a visit whose patient leaves the scope while the deferral waits for the visit row", async () => {
    const p = await patient(fx.parties.doctor!), v = await visit(p), session = await fx.session("doctor");
    const blocker: PoolClient = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [p]);
      await blocker.query("SELECT id FROM visits WHERE id=$1 FOR UPDATE", [v]);
      pending = refusal(visits.commandCanonicalVisitDefer(session, v, { reason: null }));
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT v.id, v.patient_id, v.patient_name%'")).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ code: "visit_not_found", status: 404 });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
    expect(await deferAudits(v)).toEqual([]);
  });
});

describe("proving a collection attempt", () => {
  const attempt = (patientId: number, key: string, originalActor = "SYN-DR-COLL") => ({ idempotencyKey: key, patientId, operation: "payment",
    requestBody: JSON.stringify({ patientId, amount: "10", currency: "YER" }), originalActor });
  const retirements = async (key: string) => q("SELECT retired_by FROM collection_attempt_retirements WHERE idempotency_key=$1", [key]);

  it("retires the actor's own uncertain attempt with its audit; the answer repeats; a committed key reads committed", async () => {
    const p = await patient(), key = `syn-dr-retire-${++serial}`;
    expect(await rc.commandCanonicalRetireAttempt(await fx.session("collector"), attempt(p, key))).toBe("retired");
    expect(await retirements(key)).toEqual([{ retired_by: "SYN-DR-COLL" }]);
    expect((await q("SELECT actor FROM audit_log WHERE action='payment.attempt_retire' AND details->>'idempotencyKey'=$1", [key]))).toEqual([{ actor: "SYN-DR-COLL" }]);
    expect(await rc.commandCanonicalRetireAttempt(await fx.session("collector"), attempt(p, key))).toBe("retired");
    const paidKey = `syn-dr-paid-${++serial}`;
    expect((await db.recordPayment({ patientId: p, invoiceId: null, openingCurrency: null, amountMinor: 1000 + serial, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, kind: "payment", method: "cash", note: null, createdBy: "SYN-DR-COLL", idempotencyKey: paidKey })).reason).toBeNull();
    expect(await rc.commandCanonicalRetireAttempt(await fx.session("collector"), attempt(p, paidKey))).toBe("committed");
  });

  it("another actor's attempt, view grants and an outside patient are refused; outside reads like missing; nothing is retired", async () => {
    const p = await patient(), key = `syn-dr-refuse-${++serial}`;
    expect(await refusal(rc.commandCanonicalRetireAttempt(await fx.session("collector"), attempt(p, key, "SYN-SOMEONE-ELSE")))).toMatchObject({ status: 409 });
    expect(await refusal(rc.commandCanonicalRetireAttempt(await fx.session("manager"), attempt(p, key, "SYN-DR-MGR")))).toMatchObject(denied);
    const outside = await refusal(rc.commandCanonicalRetireAttempt(await fx.session("doctor"), attempt(p, key, "SYN-DR-DR"))) as { status: number; message: string };
    const missing = await refusal(rc.commandCanonicalRetireAttempt(await fx.session("doctor"), attempt(2_000_000_000, key, "SYN-DR-DR"))) as { status: number; message: string };
    expect(outside).toMatchObject({ status: 400 });
    expect({ status: outside.status, message: outside.message }).toEqual({ status: missing.status, message: missing.message });
    expect(await retirements(key)).toEqual([]);
    const mine = await patient(fx.parties.doctor!), ownKey = `syn-dr-own-${++serial}`;
    expect(await rc.commandCanonicalRetireAttempt(await fx.session("doctor"), attempt(mine, ownKey, "SYN-DR-DR"))).toBe("retired");
  });
});
