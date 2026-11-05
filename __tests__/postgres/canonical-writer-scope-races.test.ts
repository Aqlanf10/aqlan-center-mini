/** Scope decided after the real PostgreSQL waits, on the writing transaction, for the
 * canonical visit documentation (M2 slices 85–87) and debt writers (M2 slice 91) — the
 * mechanism of the reviewed fix 2fb7c07c. Synthetic data only. pg_stat_activity, not
 * timing, establishes each interleaving: a blocker changes the scope witness and holds a
 * lock the writer needs; the writer passed its early check before the change committed. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-writer-scope-race-secret");
const db = await import("../../lib/db");
const doc = await import("../../lib/canonical-visit-documentation");
const pay = await import("../../lib/canonical-payment-writes");
const accounts = {
  owner: { username: "SYN-WSR-OWNER", role: "admin" },
  doctor: { username: "SYN-WSR-DOC", role: "doctor", doctor: true, patientScope: "own", grants: {
    "clinical.visits.document": true, "clinical.visits.sign": true, "finance.payments.collect": true,
  } },
  other: { username: "SYN-WSR-OTHER", role: "doctor", doctor: true, patientScope: "own", grants: {} },
  collector: { username: "SYN-WSR-COLL", role: "reception", patientScope: "all", grants: { "finance.payments.collect": true } },
} as const;
let fx: CanonicalInventoryDatabase<keyof typeof accounts>;
let blockers: Pool;
let serial = 0;
// The fixture's observer pool has one connection: racing commands use the application
// pool, and blockers their own connections, so the observer can always see the wait.
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const outcome = (promise: Promise<unknown>) => promise.then(value => ({ value }), error => ({ error }));
const patient = async (doctor: number | null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN WSR patient',$2) RETURNING id", [`SYN-WSR-${++serial}`, doctor]))[0].id as number;
const visit = async (doctor: number, patientId: number) => (await q(
  "INSERT INTO visits(patient_name,doctor_id,patient_id) VALUES ('SYN WSR visit',$1,$2) RETURNING id", [doctor, patientId]))[0].id as number;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, accounts, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 5 });
  await db.openShift({ openedBy: "SYN-WSR-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

async function observedWait(text: string) {
  for (let i = 0; i < 500; i++) {
    if ((await q("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1", [`%${text}%`])).length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Did not observe PostgreSQL lock wait: ${text}`);
}
async function afterLockedChange(change: (client: PoolClient) => Promise<unknown>, start: () => Promise<unknown>, waiting: string) {
  const blocker = await blockers.connect();
  let pending: ReturnType<typeof outcome> | undefined;
  try {
    await blocker.query("BEGIN");
    await change(blocker);
    pending = outcome(start());
    await observedWait(waiting);
    await blocker.query("COMMIT");
    return await pending;
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await pending;
  }
}

it("visit documentation refuses a visit that leaves the clinician's scope during the writer's lock wait", async () => {
  // The patient's only link to the doctor is this visit; the blocker reassigns the visit.
  const p = await patient(null), v = await visit(fx.parties.doctor!, p), session = await fx.session("doctor");
  const result = await afterLockedChange(
    client => client.query("UPDATE visits SET doctor_id=$2 WHERE id=$1", [v, fx.parties.other]),
    () => doc.commandCanonicalVisitDocument(session, String(v), { action: "save", examination: "SYN after reassignment", doctorId: fx.parties.other }),
    "visits",
  );
  expect(result).toMatchObject({ error: { code: "visit_not_found", status: 404 } });
  expect((await q("SELECT examination FROM visits WHERE id=$1", [v]))[0].examination ?? null).toBeNull();
});

it("visit documentation refuses when the visit's patient changes during the wait (lock order kept)", async () => {
  const mine = await patient(fx.parties.doctor!), outside = await patient(null);
  const v = await visit(fx.parties.doctor!, mine), session = await fx.session("doctor");
  const result = await afterLockedChange(
    client => client.query("UPDATE visits SET doctor_id=$2, patient_id=$3 WHERE id=$1", [v, fx.parties.other, outside]),
    () => doc.commandCanonicalVisitDocument(session, String(v), { action: "save", examination: "SYN after relink", doctorId: fx.parties.doctor }),
    "visits",
  );
  expect(result).toMatchObject({ error: { status: expect.any(Number) } });
  expect([404, 409]).toContain((result as { error: { status: number } }).error.status);
  expect((await q("SELECT examination FROM visits WHERE id=$1", [v]))[0].examination ?? null).toBeNull();
});

async function arranged(p: number) {
  const invoiceId = (await q("INSERT INTO invoices(invoice_number,patient_id,base_currency,total_minor,discount_minor,created_by) VALUES($1,$2,'YER',50000,0,'SYN') RETURNING id", [`SYN-WSR-INV-${++serial}`, p]))[0].id as number;
  const write = { target: { patientId: p, currency: "YER" as const, invoiceId, openingCurrency: null },
    terms: { mode: "installments", installments: [{ dueDate: "2026-12-01", amountMinor: 50000, kind: "installment" }] },
    expectedVersion: 0, expectedRemainingMinor: 50000, reason: "SYN schedule", idempotencyKey: `syn-wsr-schedule-${++serial}` };
  return { write, done: await pay.commandCanonicalDebtRepayment(await fx.session("collector"), write, fx.pool) };
}

it("debt collection refuses a patient that leaves the clinician's scope while it waits for the shift", async () => {
  const p = await patient(fx.parties.doctor!), { done } = await arranged(p), session = await fx.session("doctor");
  const result = await afterLockedChange(
    async client => {
      await client.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [p]);
      await client.query("SELECT id FROM cashier_shifts WHERE status='open' FOR UPDATE");
    },
    () => pay.commandCanonicalDebtCollection(session, { patientId: p, arrangementId: done.arrangementId, expectedVersion: 1, amountMinor: 1000,
      currency: "YER", method: "cash", note: null, idempotencyKey: `syn-wsr-collect-${++serial}` }, {}),
    "cashier_shifts",
  );
  expect(result).toMatchObject({ error: { code: "patient_not_found", status: 404 } });
  expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1", [p]))[0].n).toBe(0);
});

it("a debt arrangement refuses a patient that leaves the clinician's scope while it waits for the patient lock", async () => {
  const p = await patient(fx.parties.doctor!), session = await fx.session("doctor");
  const invoiceId = (await q("INSERT INTO invoices(invoice_number,patient_id,base_currency,total_minor,discount_minor,created_by) VALUES($1,$2,'YER',30000,0,'SYN') RETURNING id", [`SYN-WSR-INV-${++serial}`, p]))[0].id as number;
  const write = { target: { patientId: p, currency: "YER" as const, invoiceId, openingCurrency: null },
    terms: { mode: "installments", installments: [{ dueDate: "2026-12-01", amountMinor: 30000, kind: "installment" }] },
    expectedVersion: 0, expectedRemainingMinor: 30000, reason: "SYN schedule", idempotencyKey: `syn-wsr-schedule-${++serial}` };
  const result = await afterLockedChange(
    client => client.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [p]),
    () => pay.commandCanonicalDebtRepayment(session, write),
    "FROM patients WHERE id",
  );
  expect(result).toMatchObject({ error: { code: "patient_not_found", status: 404 } });
  expect((await q("SELECT count(*)::int AS n FROM debt_repayment_arrangements WHERE patient_id=$1", [p]))[0].n).toBe(0);
});
