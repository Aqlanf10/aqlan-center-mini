/** M2 slice 93b-2 (G4-1, G4-8): adding a service to an issued invoice on the canonical runtime,
 * real PostgreSQL, synthetic data only. finance.invoices.create (never the administrator label
 * or a view grant) inside the invoice's patient scope; prices by grants; the read and preview
 * on one snapshot; the addition is a new dated invoice with its audit; replay; a stale attempt's
 * rejection evidence commits before the refusal; outside reads like missing, decided after the
 * patient row lock (race test); revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-invoice-add-service-secret-93b2");
const db = await import("../../lib/db");
const add = await import("../../lib/canonical-invoice-add-service");

const CREATE = { "finance.invoices.create": true, "finance.invoices.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-AS-OWNER", role: "admin" },
  clerk: { username: "SYN-AS-CLERK", role: "reception", patientScope: "all", grants: CREATE },
  discounter: { username: "SYN-AS-DISC", role: "reception", patientScope: "all", grants: { ...CREATE, "finance.discounts.apply": true } },
  viewer: { username: "SYN-AS-VIEW", role: "accountant", patientScope: "all", grants: { "finance.invoices.view": true, "finance.patient-ledger.view": true } },
  label: { username: "SYN-AS-LABEL", role: "admin", patientScope: "all", grants: {} },
  doctor: { username: "SYN-AS-DR", role: "doctor", doctor: true, patientScope: "own", grants: CREATE },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serviceId = 0, doctorId = 0, serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string; terminal?: boolean }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };

async function original(primaryDoctor: number | null = null) {
  const patientId = (await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN AS patient',$2) RETURNING id", [`SYN-AS-${++serial}`, primaryDoctor]))[0].id as number;
  const invoice = await db.createInvoice({ patientId, baseCurrency: "YER", discountMinor: 0, note: "SYN original", createdBy: "SYN-AS-OWNER",
    items: [{ serviceId: null, doctorId, description: "SYN original work", quantity: 1, unitPriceMinor: 10000 }] } as never);
  if (!invoice) throw new Error("SYN original missing");
  await q("UPDATE invoices SET created_at='2026-10-01T12:00:00Z' WHERE id=$1", [invoice.id]);
  return { invoiceId: invoice.id as number, patientId };
}
async function body(key: Key, invoiceId: number, extra: Record<string, unknown> = {}) {
  const view = await add.readCanonicalInvoiceAddService(await fx.session(key), String(invoiceId));
  return { idempotencyKey: `syn-as-${++serial}-key`, expectedSourceHash: view.sourceHash, reason: "SYN new service requested", serviceId, doctorId,
    price: "2000", priceReason: null, discount: "0", discountReason: null, currency: "YER", ...extra };
}
const invoicesOf = async (patientId: number) => q("SELECT id FROM invoices WHERE patient_id=$1 ORDER BY id", [patientId]);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
  await q("INSERT INTO settings(key,value) VALUES('billing.max_discount_percent','10') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  db.invalidateSettingsCache();
  doctorId = (await q("INSERT INTO parties(kind,name) VALUES ('doctor','SYN AS doctor') RETURNING id"))[0].id;
  serviceId = (await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES ('SYN AS consultation','consultation',2000,TRUE,TRUE) RETURNING id"))[0].id;
  await db.openShift({ openedBy: "SYN-AS-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("adding a service", () => {
  it("finance.invoices.create reads, previews and adds a new dated invoice with its audit; the key replays", async () => {
    const o = await original(), session = await fx.session("clerk"), request = await body("clerk", o.invoiceId);
    const preview = await add.previewCanonicalInvoiceAddService(session, String(o.invoiceId), request) as { addedNetMinor: number; requestHash: string };
    expect(preview).toMatchObject({ addedNetMinor: 2000 });
    const made = await add.commandCanonicalInvoiceAddService(session, String(o.invoiceId), request);
    expect(made).toMatchObject({ originalInvoiceId: o.invoiceId, addedNetMinor: 2000, createdBy: "SYN-AS-CLERK", requestHash: preview.requestHash, replayed: false });
    expect(await q("SELECT actor FROM audit_log WHERE action='invoice.service_add' AND entity_id=$1::text", [o.invoiceId])).toEqual([{ actor: "SYN-AS-CLERK" }]);
    expect(await add.commandCanonicalInvoiceAddService(session, String(o.invoiceId), request)).toEqual({ ...made, replayed: true });
    expect(await invoicesOf(o.patientId)).toHaveLength(2);
  });

  it("prices by grants: a discount needs discounts.apply; the label and view grants never add", async () => {
    const o = await original();
    const lower = { price: "1900", priceReason: "SYN reason" };
    expect(await refusal(add.commandCanonicalInvoiceAddService(await fx.session("clerk"), String(o.invoiceId), await body("clerk", o.invoiceId, lower))))
      .toMatchObject({ code: "invalid" });
    expect(await add.commandCanonicalInvoiceAddService(await fx.session("discounter"), String(o.invoiceId), await body("discounter", o.invoiceId, lower)))
      .toMatchObject({ addedNetMinor: 1900 });
    for (const key of ["label", "viewer"] as const) {
      expect(await refusal(add.readCanonicalInvoiceAddService(await fx.session(key), String(o.invoiceId)))).toMatchObject(denied);
    }
    expect(await invoicesOf(o.patientId)).toHaveLength(2);
  });

  it("a stale attempt commits its rejection evidence and refuses; nothing is issued", async () => {
    const o = await original(), request = await body("clerk", o.invoiceId);
    expect((await db.recordPayment({ patientId: o.patientId, invoiceId: o.invoiceId, kind: "payment", amountMinor: 1000, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, method: "cash", note: null, createdBy: "SYN-AS-OWNER", idempotencyKey: `syn-as-paid-${++serial}` })).reason).toBeNull();
    expect(await refusal(add.commandCanonicalInvoiceAddService(await fx.session("clerk"), String(o.invoiceId), request))).toMatchObject({ code: "stale", terminal: true });
    expect(await q("SELECT 1 FROM invoice_service_addition_rejections WHERE idempotency_key=$1", [request.idempotencyKey])).toHaveLength(1);
    expect(await invoicesOf(o.patientId)).toHaveLength(1);
  });

  it("an own creator adds to its patient's invoice; another patient's reads like a missing invoice; revocation", async () => {
    const mine = await original(fx.parties.doctor!), outside = await original();
    expect(await add.commandCanonicalInvoiceAddService(await fx.session("doctor"), String(mine.invoiceId), await body("doctor", mine.invoiceId))).toMatchObject({ replayed: false });
    const outsideRead = await refusal(add.readCanonicalInvoiceAddService(await fx.session("doctor"), String(outside.invoiceId)));
    const missingRead = await refusal(add.readCanonicalInvoiceAddService(await fx.session("doctor"), "2000000000"));
    expect(outsideRead).toMatchObject({ code: "missing" });
    expect({ code: outsideRead?.code, message: outsideRead?.message }).toEqual({ code: missingRead?.code, message: missingRead?.message });
    const forged = { ...(await body("clerk", outside.invoiceId)) };
    expect(await refusal(add.commandCanonicalInvoiceAddService(await fx.session("doctor"), String(outside.invoiceId), forged))).toMatchObject({ code: "missing" });
    await fx.setGrants("clerk", {}, { patientScope: "all" });
    try { expect(await refusal(add.commandCanonicalInvoiceAddService(await fx.session("clerk"), String(outside.invoiceId), forged))).toMatchObject(denied); }
    finally { await fx.setGrants("clerk", CREATE, { patientScope: "all" }); }
    expect(await invoicesOf(outside.patientId)).toHaveLength(1);
  });

  it("refuses a patient that leaves the creator's scope while the addition waits for the patient row", async () => {
    const o = await original(fx.parties.doctor!), session = await fx.session("doctor"), request = await body("doctor", o.invoiceId);
    const blocker: PoolClient = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [o.patientId]);
      pending = refusal(add.commandCanonicalInvoiceAddService(session, String(o.invoiceId), request));
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM patients WHERE id=$1 FOR NO KEY UPDATE%'")).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ code: "missing" });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
    expect(await invoicesOf(o.patientId)).toHaveLength(1);
  });
});
