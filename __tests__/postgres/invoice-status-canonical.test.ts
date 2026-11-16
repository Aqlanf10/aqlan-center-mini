/** M2 slice 93a: invoice status on the canonical runtime, real PostgreSQL, synthetic data only.
 * Reopen finance.invoices.create; cancel finance.invoices.cancel with a reason and its audit
 * row in the same transaction; manual "paid" finance.invoices.mark-paid; no grant substitutes
 * for another; finance.locked_before by the invoice's clinic date; the patient scope decided
 * after the writer's locks (race proved through pg_stat_activity); revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-invoice-status-secret-93");
const db = await import("../../lib/db");
const writes = await import("../../lib/canonical-invoice-writes");

const VIEW = { "finance.invoices.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-IS-OWNER", role: "admin" },
  creator: { username: "SYN-IS-CREATE", role: "reception", patientScope: "all", grants: { ...VIEW, "finance.invoices.create": true } },
  canceller: { username: "SYN-IS-CANCEL", role: "accountant", patientScope: "all", grants: { ...VIEW, "finance.invoices.cancel": true } },
  payer: { username: "SYN-IS-PAID", role: "accountant", patientScope: "all", grants: { ...VIEW, "finance.invoices.mark-paid": true } },
  viewer: { username: "SYN-IS-VIEW", role: "accountant", patientScope: "all", grants: { ...VIEW, "finance.patient-ledger.view": true } },
  doctor: { username: "SYN-IS-DR", role: "doctor", doctor: true, patientScope: "own", grants: { ...VIEW, "finance.invoices.cancel": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const patient = async (doctor: number | null = null) => (await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN IS patient',$2) RETURNING id", [`SYN-IS-${++serial}`, doctor]))[0].id as number;
const invoice = async (patientId: number, status = "open", createdAt = "now()") => (await q(
  `INSERT INTO invoices(invoice_number,patient_id,base_currency,total_minor,discount_minor,created_by,status,created_at) VALUES($1,$2,'YER',40000,0,'SYN',$3,${createdAt}) RETURNING id`,
  [`SYN-IS-INV-${++serial}`, patientId, status]))[0].id as number;
const statusOf = async (id: number) => (await q("SELECT status FROM invoices WHERE id=$1", [id]))[0].status as string;
const audits = async (action: string, id: number) => (await q("SELECT actor, actor_role, details FROM audit_log WHERE action=$1 AND entity_id=$2::text", [action, id]));
const run = async (key: Key, id: number, body: Record<string, unknown>, pool?: Pool) =>
  writes.commandCanonicalInvoiceStatus(await fx.session(key), id, writes.parseCanonicalInvoiceStatus(body), pool as never);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
  await db.openShift({ openedBy: "SYN-IS-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("invoice status", () => {
  it("cancel needs finance.invoices.cancel and a reason; the audit row (with what was paid) commits with it", async () => {
    const p = await patient(), id = await invoice(p);
    const paid = await db.recordPayment({ patientId: p, invoiceId: id, openingCurrency: null, amountMinor: 10000, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, kind: "payment", method: "cash", note: null, createdBy: "SYN", idempotencyKey: `syn-is-pay-${++serial}` });
    expect(paid.reason).toBeNull();
    expect(() => writes.parseCanonicalInvoiceStatus({ status: "cancelled", reason: " " })).toThrow(expect.objectContaining({ code: "cancel_reason_required" }));
    const done = await run("canceller", id, { status: "cancelled", reason: "SYN duplicate invoice" }, fx.pool) as { status: string; cancellation: { paidOnInvoice: unknown[]; guidance: string | null } };
    expect(done).toMatchObject({ status: "cancelled", cancellation: { paidOnInvoice: [{ currency: "YER", netMinor: 10000 }], guidance: expect.stringContaining("رصيدًا دائنًا") } });
    expect(await audits("invoice.cancel", id)).toEqual([expect.objectContaining({ actor: "SYN-IS-CANCEL", actor_role: "accountant",
      details: expect.objectContaining({ السبب: "SYN duplicate invoice", المريض: p }) })]);
    expect(await refusal(run("canceller", id, { status: "open" }, fx.pool))).toMatchObject(denied);
    expect(await refusal(run("owner", id, { status: "open" }, fx.pool))).toMatchObject({ code: "invoice_cancelled_or_missing", status: 409 });
  });

  it("each decision needs its own grant: create reopens, mark-paid settles, neither cancels; the ledger never substitutes", async () => {
    const p = await patient(), id = await invoice(p);
    expect(await refusal(run("creator", id, { status: "cancelled", reason: "SYN no grant" }, fx.pool))).toMatchObject(denied);
    expect(await refusal(run("creator", id, { status: "paid" }, fx.pool))).toMatchObject(denied);
    expect(await refusal(run("canceller", id, { status: "paid" }, fx.pool))).toMatchObject(denied);
    for (const status of ["open", "paid", "cancelled"]) {
      expect(await refusal(run("viewer", id, { status, reason: "SYN viewer" }, fx.pool))).toMatchObject(denied);
    }
    await run("payer", id, { status: "paid" }, fx.pool);
    expect(await statusOf(id)).toBe("paid");
    expect(await audits("invoice.status", id)).toEqual([expect.objectContaining({ actor: "SYN-IS-PAID", details: expect.objectContaining({ إلى: "paid" }) })]);
    await run("creator", id, { status: "open" }, fx.pool);
    expect(await statusOf(id)).toBe("open");
  });

  it("finance.locked_before by the invoice's clinic date refuses and changes nothing", async () => {
    const p = await patient(), id = await invoice(p, "open", "'2026-01-15T09:00:00Z'");
    await q("INSERT INTO settings(key,value) VALUES('finance.locked_before','2026-02-01') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
    try {
      expect(await refusal(run("canceller", id, { status: "cancelled", reason: "SYN locked period" }, fx.pool))).toMatchObject({ code: "period_locked", status: 409 });
      expect(await statusOf(id)).toBe("open");
      expect(await audits("invoice.cancel", id)).toEqual([]);
    } finally { await q("DELETE FROM settings WHERE key='finance.locked_before'"); }
  });

  it("an own-scoped actor cancels only its patients' invoices; outside and missing read alike; revocation", async () => {
    const mine = await patient(fx.parties.doctor!), other = await patient();
    const outside = await invoice(other), inside = await invoice(mine);
    expect(await refusal(run("doctor", outside, { status: "cancelled", reason: "SYN outside" }, fx.pool))).toMatchObject({ code: "invoice_not_found", status: 404 });
    expect(await statusOf(outside)).toBe("open");
    expect(await refusal(run("doctor", 2147483000, { status: "cancelled", reason: "SYN missing" }, fx.pool))).toMatchObject({ status: 409 });
    await run("doctor", inside, { status: "cancelled", reason: "SYN mine" }, fx.pool);
    expect(await statusOf(inside)).toBe("cancelled");
    await fx.setGrants("canceller", VIEW, { patientScope: "all" });
    try {
      expect(await refusal(run("canceller", await invoice(other), { status: "cancelled", reason: "SYN revoked" }, fx.pool))).toMatchObject(denied);
    } finally { await fx.setGrants("canceller", { ...VIEW, "finance.invoices.cancel": true }, { patientScope: "all" }); }
  });

  it("the scope is decided after the writer's patient lock: a patient leaving the scope during the wait is refused", async () => {
    const p = await patient(fx.parties.doctor!), id = await invoice(p), session = await fx.session("doctor");
    const blocker = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [p]);
      // The racing command uses the application pool; the fixture's observer has one connection.
      pending = writes.commandCanonicalInvoiceStatus(session, id, { status: "cancelled", reason: "SYN race" }).then(() => null, error => error);
      for (let i = 0; ; i++) {
        if ((await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM patients WHERE id%'")).length) break;
        if (i > 500) throw new Error("Did not observe the writer's patient lock wait");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ code: "invoice_not_found", status: 404 });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
    expect(await statusOf(id)).toBe("open");
    expect(await audits("invoice.cancel", id)).toEqual([]);
  });
});
