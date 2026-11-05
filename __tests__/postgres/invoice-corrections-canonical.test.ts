/** M2 slice 93c (G4-8): archiving or restoring and correcting an issued invoice on the canonical
 * runtime, real PostgreSQL, synthetic data only. Archive/restore by finance.invoices.cancel,
 * correction by finance.invoices.correct; neither implies the other; the administrator label and
 * view grants never act; inside the invoice's patient scope (outside = missing), decided after the
 * patient row lock (race test); audits in the transaction; replay; durable archive rejections
 * commit before the refusal; revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-invoice-corrections-secret-93c");
const db = await import("../../lib/db");
const fixes = await import("../../lib/canonical-invoice-corrections");

const VIEW = { "finance.invoices.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-IX-OWNER", role: "admin" },
  archivist: { username: "SYN-IX-ARCH", role: "reception", patientScope: "all", grants: { ...VIEW, "finance.invoices.cancel": true } },
  corrector: { username: "SYN-IX-CORR", role: "accountant", patientScope: "all", grants: { ...VIEW, "finance.invoices.correct": true } },
  label: { username: "SYN-IX-LABEL", role: "admin", patientScope: "all", grants: {} },
  viewer: { username: "SYN-IX-VIEW", role: "accountant", patientScope: "all", grants: { ...VIEW, "finance.patient-ledger.view": true } },
  doctor: { username: "SYN-IX-DR", role: "doctor", doctor: true, patientScope: "own", grants: { ...VIEW, "finance.invoices.cancel": true, "finance.invoices.correct": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };

async function invoice(paid = 10000, primaryDoctor: number | null = null) {
  const patientId = (await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN IX patient',$2) RETURNING id", [`SYN-IX-${++serial}`, primaryDoctor]))[0].id as number;
  const made = await db.createInvoice({ patientId, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "SYN-IX-OWNER",
    items: [{ serviceId: null, doctorId: null, description: "SYN IX service", quantity: 1, unitPriceMinor: 10000 }] } as never);
  if (!made) throw new Error("SYN invoice missing");
  if (paid) expect((await db.recordPayment({ patientId, invoiceId: made.id, kind: "payment", amountMinor: paid, currency: "YER", baseCurrency: "YER",
    exchangeRate: 1, method: "cash", note: null, createdBy: "SYN-IX-OWNER", idempotencyKey: `syn-ix-paid-${++serial}` })).reason).toBeNull();
  return { invoiceId: made.id as number, patientId };
}
const archiveCommand = (action: "archive" | "restore" = "archive", expectedVersion = 0) =>
  ({ action, expectedVersion, reason: "SYN documentary organization", idempotencyKey: `syn-ix-arch-${++serial}` });
async function correction(key: Key, invoiceId: number, after: number) {
  const view = await fixes.readCanonicalInvoiceRevision(await fx.session(key), String(invoiceId)) as { sourceHash: string; settledMinor: number; invoice: { items: { id: number }[] } };
  const remaining = Math.max(0, after - view.settledMinor);
  return { idempotencyKey: `syn-ix-corr-${++serial}`, expectedSourceHash: view.sourceHash, reason: "SYN correct the agreed amount",
    lines: view.invoice.items.map(item => ({ itemId: item.id, quantity: 1, unitPrice: String(after) })), discount: "0", discountReason: null,
    repaymentTerms: remaining > 0 ? { mode: "installments", installments: [{ dueDate: "2026-12-14", kind: "installment", amountMinor: remaining }] } : { mode: "full", installments: [] },
    expectedRemainingMinor: remaining };
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
  await db.openShift({ openedBy: "SYN-IX-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("archive and restore", () => {
  it("finance.invoices.cancel archives a settled invoice with its audit; the key replays; restore follows", async () => {
    const o = await invoice(), session = await fx.session("archivist"), command = archiveCommand();
    const saved = await fixes.commandCanonicalInvoiceArchive(session, String(o.invoiceId), command);
    expect(saved).toMatchObject({ replayed: false, noop: false, receipt: { action: "archive", version: 1, archived: true } });
    expect(await q("SELECT actor FROM audit_log WHERE action='invoice.archive' AND entity_id=$1::text", [o.invoiceId])).toEqual([{ actor: "SYN-IX-ARCH" }]);
    expect(await fixes.commandCanonicalInvoiceArchive(session, String(o.invoiceId), command)).toMatchObject({ replayed: true });
    expect(await fixes.commandCanonicalInvoiceArchive(session, String(o.invoiceId), archiveCommand("restore", 1))).toMatchObject({ receipt: { action: "restore", version: 2 } });
  });

  it("a durable rejection commits its evidence before the refusal; correct, label and view grants never archive", async () => {
    const o = await invoice(4000), command = archiveCommand();
    expect(await refusal(fixes.commandCanonicalInvoiceArchive(await fx.session("archivist"), String(o.invoiceId), command))).toMatchObject({ code: "policy_decision_required" });
    expect(await q("SELECT 1 FROM invoice_archive_rejections WHERE idempotency_key=$1", [command.idempotencyKey])).toHaveLength(1);
    const settled = await invoice();
    for (const key of ["corrector", "label", "viewer"] as const) {
      expect(await refusal(fixes.commandCanonicalInvoiceArchive(await fx.session(key), String(settled.invoiceId), archiveCommand()))).toMatchObject(denied);
    }
    expect(await q("SELECT 1 FROM invoice_archive_events WHERE invoice_id=$1", [settled.invoiceId])).toEqual([]);
  });
});

describe("correction", () => {
  it("finance.invoices.correct reads and corrects with its audit, receipts untouched; the key replays", async () => {
    const o = await invoice(4000), session = await fx.session("corrector"), request = await correction("corrector", o.invoiceId, 14000);
    const receipts = await q("SELECT to_jsonb(p) AS r FROM payments p WHERE patient_id=$1 ORDER BY id", [o.patientId]);
    const result = await fixes.commandCanonicalInvoiceRevision(session, String(o.invoiceId), request);
    expect(result).toMatchObject({ replayed: false, beforeMinor: 10000, afterMinor: 14000, settledMinor: 4000, remainingMinor: 10000, createdBy: "SYN-IX-CORR" });
    expect(await q("SELECT actor FROM audit_log WHERE action='invoice.correct' AND entity_id=$1::text", [o.invoiceId])).toEqual([{ actor: "SYN-IX-CORR" }]);
    expect(await q("SELECT to_jsonb(p) AS r FROM payments p WHERE patient_id=$1 ORDER BY id", [o.patientId])).toEqual(receipts);
    expect(await fixes.commandCanonicalInvoiceRevision(session, String(o.invoiceId), request)).toEqual({ ...result, replayed: true });
  });

  it("cancel, label and view grants never correct or read the correction context; nothing changes", async () => {
    const o = await invoice(0), request = await correction("corrector", o.invoiceId, 6000);
    for (const key of ["archivist", "label", "viewer"] as const) {
      expect(await refusal(fixes.readCanonicalInvoiceRevision(await fx.session(key), String(o.invoiceId)))).toMatchObject(denied);
      expect(await refusal(fixes.commandCanonicalInvoiceRevision(await fx.session(key), String(o.invoiceId), request))).toMatchObject(denied);
    }
    expect(await q("SELECT 1 FROM invoice_corrections WHERE original_invoice_id=$1", [o.invoiceId])).toEqual([]);
  });
});

describe("scope", () => {
  it("an own actor acts on its patient's invoice; another patient's reads like a missing invoice; revocation", async () => {
    const mine = await invoice(10000, fx.parties.doctor!), outside = await invoice();
    expect(await fixes.commandCanonicalInvoiceArchive(await fx.session("doctor"), String(mine.invoiceId), archiveCommand())).toMatchObject({ replayed: false });
    const outsideRead = await refusal(fixes.readCanonicalInvoiceRevision(await fx.session("doctor"), String(outside.invoiceId)));
    const missingRead = await refusal(fixes.readCanonicalInvoiceRevision(await fx.session("doctor"), "2000000000"));
    expect(outsideRead).toMatchObject({ code: "missing" });
    expect(outsideRead?.message).toBe(missingRead?.message);
    expect(await refusal(fixes.commandCanonicalInvoiceArchive(await fx.session("doctor"), String(outside.invoiceId), archiveCommand()))).toMatchObject({ code: "missing" });
    const request = await correction("corrector", outside.invoiceId, 12000);
    expect(await refusal(fixes.commandCanonicalInvoiceRevision(await fx.session("doctor"), String(outside.invoiceId), request))).toMatchObject({ code: "missing" });
    await fx.setGrants("corrector", {}, { patientScope: "all" });
    try { expect(await refusal(fixes.commandCanonicalInvoiceRevision(await fx.session("corrector"), String(outside.invoiceId), request))).toMatchObject(denied); }
    finally { await fx.setGrants("corrector", { ...VIEW, "finance.invoices.correct": true }, { patientScope: "all" }); }
    expect(await q("SELECT 1 FROM invoice_archive_events WHERE invoice_id=$1", [outside.invoiceId])).toEqual([]);
    expect(await q("SELECT 1 FROM invoice_corrections WHERE original_invoice_id=$1", [outside.invoiceId])).toEqual([]);
  });

  for (const act of ["archive", "correct"] as const) {
    it(`refuses a patient that leaves the actor's scope while the ${act} writer waits for the patient row`, async () => {
      const o = await invoice(10000, fx.parties.doctor!), session = await fx.session("doctor");
      const request = act === "archive" ? archiveCommand() : await correction("doctor", o.invoiceId, 12000);
      const blocker: PoolClient = await blockers.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [o.patientId]);
        pending = refusal(act === "archive" ? fixes.commandCanonicalInvoiceArchive(session, String(o.invoiceId), request)
          : fixes.commandCanonicalInvoiceRevision(session, String(o.invoiceId), request));
        let waiting = false;
        for (let i = 0; i < 500 && !waiting; i++) {
          waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM patients WHERE id=$1 FOR NO KEY UPDATE%'")).length > 0;
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await blocker.query("COMMIT");
        expect(await pending).toMatchObject({ code: "missing" });
      } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
      expect(await q("SELECT 1 FROM invoice_archive_events WHERE invoice_id=$1", [o.invoiceId])).toEqual([]);
      expect(await q("SELECT 1 FROM invoice_corrections WHERE original_invoice_id=$1", [o.invoiceId])).toEqual([]);
    });
  }
});
