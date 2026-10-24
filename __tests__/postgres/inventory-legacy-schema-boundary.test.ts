vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../../lib/auth";
import type { InventoryMovementInput } from "../../lib/db";
import { InventorySchemaNotReady } from "../../lib/inventory-domain/legacy-write-guard";
import { purchaseTestSession } from "./_inventory-purchase-session";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";

const auth = vi.hoisted(() => ({ session: null as SessionPayload | null }));
vi.mock("../../lib/session", async importOriginal => ({
  ...await importOriginal<typeof import("../../lib/session")>(),
  requireSession: async () => auth.session,
}));

assertRealPostgresUrl();
stubPostgresEnv();
const isolatedUrl = await createIsolatedDatabase("aqlan_inventory_legacy_schema");
vi.stubEnv("DATABASE_URL", isolatedUrl);
vi.stubEnv("TEST_DATABASE_URL", isolatedUrl);
const db = await import("../../lib/db");
const { POST: movementPost } = await import("../../app/api/inventory/[id]/movements/route");
const { POST: clinicalPost } = await import("../../app/api/visits/[id]/clinical/route");

let session: SessionPayload, doctorParty: number, supplier: number;
const key = () => randomUUID();

async function proposalSchemaAbsent() {
  const { rows: [schema] } = await db.getPool().query(
    "SELECT to_regclass('stock_lots')::text AS lots, to_regclass('inventory_locations')::text AS locations, to_regclass('purchase_orders')::text AS orders",
  );
  expect(schema).toEqual({ lots: null, locations: null, orders: null });
}

beforeAll(async () => {
  vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "false");
  vi.stubEnv("SESSION_SECRET", process.env.SESSION_SECRET);
  // The runtime baseline is deliberately installed without either proposal.
  await db.ensureSchema();
  await proposalSchemaAbsent();
  session = await purchaseTestSession(`SYN-LEGACY-SCHEMA-${key()}`, "admin");
  doctorParty = (await db.getPool().query("INSERT INTO parties(name,kind) VALUES('Synthetic schema-boundary doctor','doctor') RETURNING id")).rows[0].id;
  supplier = (await db.getPool().query("INSERT INTO parties(name,kind) VALUES('Synthetic schema-boundary supplier','supplier') RETURNING id")).rows[0].id;
});
beforeEach(async () => {
  vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "false");
  auth.session = session;
  await proposalSchemaAbsent();
});
afterAll(async () => {
  await db.resetPoolForTesting();
  vi.unstubAllEnvs();
});

async function fixture() {
  // Await every fixture write; avoid fire-and-forget item-creation audits
  // racing the before/after snapshots that prove the refusal is side-effect-free.
  const itemId = (await db.getPool().query(
    "INSERT INTO inventory_items(name,category,unit,created_by) VALUES($1,'other','unit',$2) RETURNING id",
    [`SYN-LEGACY-SCHEMA-${key()}`, session.username],
  )).rows[0].id as number;
  expect(await db.createInventoryMovement({ itemId, kind: "in", qty: 10, createdBy: session.username })).toMatchObject({ ok: true });
  const patientId = (await db.getPool().query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic schema-boundary patient') RETURNING id", [key()])).rows[0].id;
  const serviceId = (await db.getPool().query("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic schema-boundary filling','filling',10000,TRUE,TRUE) RETURNING id")).rows[0].id;
  await db.getPool().query("INSERT INTO service_materials(service_id,item_id,qty_per_unit,created_by) VALUES($1,$2,1,$3)", [serviceId, itemId, session.username]);
  const visit = await db.addVisit({ patientName: "Synthetic schema-boundary patient", patientPhone: null, note: null, patientId, doctorId: doctorParty });
  await db.getPool().query("UPDATE visits SET diagnosis='Synthetic filling' WHERE id=$1", [visit.id]);
  expect(await db.setVisitProcedures({ visitId: visit.id, procedures: [{ serviceId, toothCode: 11, doctorId: doctorParty, quantity: 1, unitPriceMinor: 10000, surfaces: null, priceReason: null, note: null, planItemId: null }] })).toBe(true);
  return { itemId, visitId: visit.id };
}

const effectTables = ["inventory_movements", "payables", "expenses", "audit_log", "invoices", "invoice_items", "visits", "tooth_conditions", "lab_orders", "inventory_purchase_receipts"] as const;
type Effects = Record<typeof effectTables[number], unknown[]>;
async function effects(): Promise<Effects> {
  // Compare full rows, not just counts, so an update to an existing stock,
  // invoice, signature, audit or payable record cannot hide behind equal counts.
  const projections = effectTables.map(table =>
    `(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY ${table === "inventory_purchase_receipts" ? "t.request_key" : "t.id"}), '[]'::jsonb) FROM ${table} t) AS ${table}`,
  );
  return (await db.getPool().query<Effects>(`SELECT ${projections.join(", ")}`)).rows[0];
}
async function stockBalance(itemId: number) {
  return (await db.getPool().query<{ balance: string }>(
    "SELECT COALESCE(SUM(CASE WHEN kind='out' THEN -qty ELSE qty END),0)::text AS balance FROM inventory_movements WHERE item_id=$1", [itemId],
  )).rows[0].balance;
}
const movementRequest = (itemId: number, body: unknown, headers: Record<string, string> = {}) => movementPost(
  new Request(`http://test.invalid/api/inventory/${itemId}/movements`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: String(itemId) }) },
);
const clinicalRequest = (visitId: number) => clinicalPost(
  new Request(`http://test.invalid/api/visits/${visitId}/clinical`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sign" }) }),
  { params: Promise.resolve({ id: String(visitId) }) },
);
const purchase = () => ({
  requestKey: key(),
  body: { protocol: "inventory-purchase-v1", purchase: { kind: "in", qty: 2, unitCost: "100", supplierPartyId: supplier } },
});
const purchaseHeaders = (requestKey: string) => ({
  "Idempotency-Key": requestKey, "X-Purchase-Actor": encodeURIComponent(session.username), "X-Purchase-Actor-Id": String(session.userId),
});
async function expectSafeFailure(response: Response, message: string) {
  expect(response.status).toBe(500);
  const result = await response.json();
  expect(result).toEqual({ message });
  expect(JSON.stringify(result)).not.toMatch(/stock_lots|inventory_items|to_regclass|SELECT|FROM|SQLSTATE|42P01|55P03|relation|stack/i);
  return result;
}
async function expectNoReceipt(requestKey: string) {
  expect((await db.getPool().query("SELECT outcome,movement_id FROM inventory_purchase_receipts WHERE request_key=$1::uuid", [requestKey])).rows).toEqual([]);
}

// Ordering is intentional: only the last case installs the real proposal, and
// only in this isolated synthetic database, to prove a transient failure recovers.
describe.sequential("legacy writers with an entirely absent inventory proposal schema", () => {
  it.each([undefined, "false", "TRUE", " true"])("preserves legacy issue and signing when the gate is %j", async gate => {
    const f = await fixture();
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", gate);
    const before = await effects();
    const issue = await movementRequest(f.itemId, { kind: "out", qty: 1 });
    expect(issue.status).toBe(201);
    expect(await issue.json()).toMatchObject({ ok: true, balance: 9 });
    const signed = await clinicalRequest(f.visitId);
    expect(signed.status).toBe(200);
    const after = await effects();
    expect(after.inventory_movements).toHaveLength(before.inventory_movements.length + 2);
    expect(after.invoices).toHaveLength(before.invoices.length + 1);
    expect((await db.getClinicalVisit(f.visitId))?.status).toBe("signed");
    expect(Number(await stockBalance(f.itemId))).toBe(8);
    await proposalSchemaAbsent();
  });

  it.each([
    { kind: "out", qty: 1 },
    { kind: "in", qty: 1 },
    { kind: "in", qty: 1, isReturn: true },
    { kind: "adjust", qty: 1, reason: "Synthetic adjustment" },
    { kind: "adjust", qty: -1, reason: "Synthetic adjustment" },
  ] satisfies Array<Partial<InventoryMovementInput>>)("fails enabled manual $kind/$qty/$isReturn closed before stock or financial effects", async mutation => {
    const f = await fixture();
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const before = await effects();
    await expectSafeFailure(await movementRequest(f.itemId, mutation), "تعذّر تسجيل الحركة. أعد المحاولة.");
    expect(await effects()).toEqual(before);
    expect(Number(await stockBalance(f.itemId))).toBe(10);
    await proposalSchemaAbsent();
  });

  it("throws the typed missing-schema failure from the internal supplier purchase writer without creating a payable", async () => {
    const f = await fixture();
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const before = await effects();
    await expect(db.createInventoryMovement({ itemId: f.itemId, kind: "in", qty: 2, unitCostMinor: 100, supplierPartyId: supplier, createdBy: session.username })).rejects.toBeInstanceOf(InventorySchemaNotReady);
    expect(await effects()).toEqual(before);
    await proposalSchemaAbsent();
  });

  it("fails enabled clinical signing closed without invoice, signature, stock or visit-sign audit effects", async () => {
    const f = await fixture();
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const before = await effects();
    await expectSafeFailure(await clinicalRequest(f.visitId), "تعذّر حفظ الزيارة.");
    expect(await effects()).toEqual(before);
    expect((await db.getClinicalVisit(f.visitId))?.status).not.toBe("signed");
    expect(Number(await stockBalance(f.itemId))).toBe(10);
    await expect(db.signClinicalVisit({ visitId: f.visitId, baseCurrency: "YER", signedBy: session.username, signerRole: "admin" })).rejects.toBeInstanceOf(InventorySchemaNotReady);
    expect(await effects()).toEqual(before);
    await proposalSchemaAbsent();
  });

  it("does not turn an unavailable schema into a durable keyed-purchase rejection on repeated attempts", async () => {
    const f = await fixture(), request = purchase();
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const before = await effects();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expectSafeFailure(await movementRequest(f.itemId, request.body, purchaseHeaders(request.requestKey)), "تعذّر تسجيل الحركة. أعد المحاولة.");
      await expectNoReceipt(request.requestKey);
      expect(await effects()).toEqual(before);
    }
    expect(Number(await stockBalance(f.itemId))).toBe(10);
    await proposalSchemaAbsent();
  });

  it("commits the exact failed purchase key once after genuine schema readiness returns, then replays it without new effects", async () => {
    const f = await fixture(), request = purchase();
    const headers = purchaseHeaders(request.requestKey);
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const before = await effects();
    await expectSafeFailure(await movementRequest(f.itemId, request.body, headers), "تعذّر تسجيل الحركة. أعد المحاولة.");
    await expectNoReceipt(request.requestKey);
    expect(await effects()).toEqual(before);
    await proposalSchemaAbsent();

    // Recovery setup is test-only and uses the actual additive schema rather
    // than a fake stock_lots table. No runtime writer is allowed to install it.
    const { INVENTORY_PROCUREMENT_SQL } = await import("../../lib/inventory-domain/schema-proposal");
    await db.getPool().query(INVENTORY_PROCUREMENT_SQL);
    expect((await db.getPool().query("SELECT to_regclass('stock_lots') IS NOT NULL AS ready")).rows[0].ready).toBe(true);
    const committed = await movementRequest(f.itemId, request.body, headers);
    expect(committed.status).toBe(201);
    const result = await committed.json();
    expect(result).toMatchObject({ status: "committed", requestKey: request.requestKey, replayed: false, payableCreated: true });
    const after = await effects();
    expect(after.inventory_movements).toHaveLength(before.inventory_movements.length + 1);
    expect(after.payables).toHaveLength(before.payables.length + 1);
    expect(after.audit_log).toHaveLength(before.audit_log.length + 1);
    expect(after.inventory_purchase_receipts).toHaveLength(before.inventory_purchase_receipts.length + 1);
    expect(after.invoices).toEqual(before.invoices);
    expect(after.visits).toEqual(before.visits);
    expect(Number(await stockBalance(f.itemId))).toBe(12);
    expect((await db.getPool().query("SELECT outcome,movement_id FROM inventory_purchase_receipts WHERE request_key=$1::uuid", [request.requestKey])).rows).toEqual([{ outcome: "committed", movement_id: result.movementId }]);

    const replay = await movementRequest(f.itemId, request.body, headers);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ ...result, replayed: true });
    expect(await effects()).toEqual(after);
  });
});
