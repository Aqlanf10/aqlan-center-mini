/** M2 slice 93b (G4-1, G4-8): creating an invoice on the canonical runtime, real PostgreSQL,
 * synthetic data only. finance.invoices.create inside the patient scope; prices by grants
 * (discount within the ceiling, beyond it, increase); lab work and repayment terms by their own
 * grants; view grants and labels never write; the audit in the transaction; replay; outside
 * reads like missing, decided after the writer's patient lock (race test); revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-invoice-create-secret-93b");
const db = await import("../../lib/db");
const inv = await import("../../lib/canonical-invoice-create");

const CREATE = { "finance.invoices.create": true, "finance.invoices.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-IC-OWNER", role: "admin" },
  clerk: { username: "SYN-IC-CLERK", role: "reception", patientScope: "all", grants: CREATE },
  discounter: { username: "SYN-IC-DISC", role: "reception", patientScope: "all", grants: { ...CREATE, "finance.discounts.apply": true } },
  raiser: { username: "SYN-IC-RAISE", role: "reception", patientScope: "all", grants: { ...CREATE, "finance.price-increases.apply": true } },
  viewer: { username: "SYN-IC-VIEW", role: "accountant", patientScope: "all", grants: { "finance.invoices.view": true, "finance.patient-ledger.view": true } },
  label: { username: "SYN-IC-LABEL", role: "admin", patientScope: "all", grants: {} },
  doctor: { username: "SYN-IC-DR", role: "doctor", doctor: true, patientScope: "own", grants: CREATE },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serviceId = 0;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const patient = async (doctor: number | null = null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN IC patient',$2) RETURNING id", [`SYN-IC-${++serial}`, doctor]))[0].id as number;
const body = (patientId: number, item: Record<string, unknown> = { serviceId, price: "20000", quantity: 1 }, extra: Record<string, unknown> = {}) =>
  ({ patientId, currency: "YER", items: [item], discount: "0", idempotencyKey: `syn-ic-${++serial}-key`, ...extra });
const invoicesOf = async (patientId: number) => q("SELECT id, created_by, total_minor::int AS total FROM invoices WHERE patient_id=$1 ORDER BY id", [patientId]);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
  await q("INSERT INTO settings(key,value) VALUES('billing.max_discount_percent','10') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  db.invalidateSettingsCache();
  serviceId = (await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('SYN IC service',20000,TRUE,TRUE,NULL) RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("creating an invoice", () => {
  it("finance.invoices.create invoices at the catalogue price with its audit; the key replays", async () => {
    const p = await patient(), request = body(p);
    const made = await inv.commandCanonicalInvoiceCreate(await fx.session("clerk"), request) as unknown as { id: number; replayed: boolean };
    expect(made).toMatchObject({ replayed: false, patientId: p });
    expect(await invoicesOf(p)).toEqual([{ id: made.id, created_by: "SYN-IC-CLERK", total: 20000 }]);
    expect((await q("SELECT actor FROM audit_log WHERE action='invoice.create' AND entity_id=$1::text", [made.id]))).toEqual([{ actor: "SYN-IC-CLERK" }]);
    expect(await inv.commandCanonicalInvoiceCreate(await fx.session("clerk"), request)).toMatchObject({ id: made.id, replayed: true });
    expect(await invoicesOf(p)).toHaveLength(1);
  });

  it("prices by grants: a discount needs discounts.apply within the ceiling; beyond it or above the catalogue is refused without its grant", async () => {
    const p = await patient();
    const lower = (price: string) => body(p, { serviceId, price, priceReason: "SYN reason", quantity: 1 });
    expect(await refusal(inv.commandCanonicalInvoiceCreate(await fx.session("clerk"), lower("19000")))).toMatchObject({ code: "price_authority", status: 400 });
    const discounted = await inv.commandCanonicalInvoiceCreate(await fx.session("discounter"), lower("19000")) as unknown as { id: number };
    expect((await q("SELECT details->>'أسعار_معدلة' AS o FROM audit_log WHERE action='invoice.create' AND entity_id=$1::text", [discounted.id]))[0].o).toContain("19000");
    expect(await refusal(inv.commandCanonicalInvoiceCreate(await fx.session("discounter"), lower("15000")))).toMatchObject({ code: "price_authority", status: 400 });
    expect(await refusal(inv.commandCanonicalInvoiceCreate(await fx.session("discounter"), lower("21000")))).toMatchObject({ code: "price_authority", status: 400 });
    expect(await inv.commandCanonicalInvoiceCreate(await fx.session("raiser"), lower("21000"))).toMatchObject({ replayed: false });
    // The administrator label grants nothing; the protected owner holds every grant.
    expect(await refusal(inv.commandCanonicalInvoiceCreate(await fx.session("label"), lower("15000")))).toMatchObject(denied);
    expect(await inv.commandCanonicalInvoiceCreate(await fx.session("owner"), lower("15000"))).toMatchObject({ replayed: false });
    expect((await invoicesOf(p)).map(row => row.total)).toEqual([19000, 21000, 15000]);
  });

  it("lab work needs clinical.visits.document and repayment terms finance.payments.collect; view grants never write", async () => {
    const p = await patient();
    expect(await refusal(inv.commandCanonicalInvoiceCreate(await fx.session("clerk"), body(p, { serviceId, price: "20000", quantity: 1, labWork: {} }))))
      .toMatchObject({ code: "lab_work_not_allowed", status: 403 });
    expect(await refusal(inv.commandCanonicalInvoiceCreate(await fx.session("clerk"), body(p, undefined, { repaymentTerms: { mode: "full" } }))))
      .toMatchObject({ code: "repayment_not_allowed", status: 403 });
    expect(await refusal(inv.commandCanonicalInvoiceCreate(await fx.session("viewer"), body(p)))).toMatchObject(denied);
    expect(await invoicesOf(p)).toEqual([]);
  });

  it("an own creator invoices its patient; another patient reads like missing; revocation", async () => {
    const mine = await patient(fx.parties.doctor!), outside = await patient();
    expect(await inv.commandCanonicalInvoiceCreate(await fx.session("doctor"), body(mine))).toMatchObject({ replayed: false });
    expect(await refusal(inv.commandCanonicalInvoiceCreate(await fx.session("doctor"), body(outside)))).toMatchObject({ code: "patient_not_found", status: 404 });
    await fx.setGrants("clerk", {}, { patientScope: "all" });
    try { expect(await refusal(inv.commandCanonicalInvoiceCreate(await fx.session("clerk"), body(outside)))).toMatchObject(denied); }
    finally { await fx.setGrants("clerk", CREATE, { patientScope: "all" }); }
    expect(await invoicesOf(outside)).toEqual([]);
  });

  it("refuses a patient that leaves the creator's scope while the writer waits for the patient row", async () => {
    const p = await patient(fx.parties.doctor!), session = await fx.session("doctor");
    const blocker: PoolClient = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [p]);
      pending = refusal(inv.commandCanonicalInvoiceCreate(session, body(p)));
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM patients WHERE id = $1 FOR NO KEY UPDATE%'")).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ code: "patient_not_found", status: 404 });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
    expect(await invoicesOf(p)).toEqual([]);
  });
});

describe("the clinical preview", () => {
  it("reads under finance.invoices.create with the same price controls as the save; scope and lab work as creation; nothing is written", async () => {
    const p = await patient(), outside = await patient(), mine = await patient(fx.parties.doctor!);
    const preview = await inv.readCanonicalInvoicePreview(await fx.session("clerk"), body(p)) as { lines: unknown[]; planChoices: unknown[] };
    expect(preview.lines).toHaveLength(1);
    const lower = body(p, { serviceId, price: "19000", priceReason: "SYN reason", quantity: 1 });
    expect(await refusal(inv.readCanonicalInvoicePreview(await fx.session("clerk"), lower))).toMatchObject({ code: "price_authority", status: 400 });
    expect(await inv.readCanonicalInvoicePreview(await fx.session("discounter"), lower)).toHaveProperty("lines");
    expect(await refusal(inv.readCanonicalInvoicePreview(await fx.session("viewer"), body(p)))).toMatchObject({ message: expect.stringMatching(/CAPABILITY_DENIED$/) });
    expect(await refusal(inv.readCanonicalInvoicePreview(await fx.session("doctor"), body(outside)))).toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await inv.readCanonicalInvoicePreview(await fx.session("doctor"), body(mine))).toHaveProperty("lines");
    expect(await refusal(inv.readCanonicalInvoicePreview(await fx.session("clerk"), body(p, { serviceId, price: "20000", quantity: 1, labWork: {} }))))
      .toMatchObject({ code: "lab_work_not_allowed", status: 403 });
    expect(await invoicesOf(p)).toEqual([]);
  });
});
