/** Restore protocol revision 3, positive round trip (P1, P2) and inert history (R4), on
 * owned PostgreSQL 18 databases; synthetic data only. This replaces the retired
 * same-realm suite (`inventory-authority-restore`).
 *
 * Canonical source with posted, cancelled and pending supplier history → backup (B1/B2)
 * → restore into an empty target under the hold (R1) → SYNTHETIC seal fixture (test
 * only) → the owner confirms the restored accounts through the real editor →
 * - P1: every business row of the source equals the target's (identity relations and
 *   columns excluded; permission documents equal except `confirmation: pending`);
 * - P2: the restored supplier history reads through the canonical runtime;
 * - R4: the pending source intent never executes (no realm/subject/generation
 *   continuity); a new nonce for the same invoice is durably refused; an independent
 *   invoice proceeds. */
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Client } from "pg";
import type { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { syntheticClaims, syntheticSign } from "./_canonical-ready-fixture";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { stagedRestore } from "../../lib/restore/staging";
import { STAFF_AUTHORITY_RELATIONS, STAFF_AUTHORITY_COLUMNS } from "../../lib/legacy-staff-schema.mjs";
import { readVerifiedDurableSession, type VerifiedDurableSession } from "../../lib/staff-durable-session";
import { updateStaffCapabilitiesIn } from "../../lib/staff-capability-editor";
import { staffIdentitySubstrateSql } from "../../lib/staff-identity-substrate-schema.mjs";
import { bindStaffAccountIncarnation, initializeStaffIdentitySubstrate } from "../../lib/staff-identity-substrate.mjs";
import { staffRuntimeSchemaSql } from "../../lib/staff-runtime-schema.mjs";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_CUSTODY_SQL } from "../../lib/inventory-domain/custody-schema-proposal";
import { INVENTORY_SUPPLIER_FINANCE_SQL } from "../../lib/inventory-domain/supplier-finance-schema-proposal";
import { INVENTORY_SUPPLIER_NUMBER_SQL } from "../../lib/inventory-domain/supplier-number-schema-proposal";
import { INVENTORY_COMMAND_LIFECYCLE_SQL } from "../../lib/inventory-domain/command-lifecycle-schema-proposal";
import { INVENTORY_SUPPLIER_TRANSPORT_SQL } from "../../lib/inventory-domain/supplier-transport-schema-proposal";
import { supplierInvoiceDigest } from "../../lib/inventory-domain/supplier-finance";
import { valuationSnapshot, type SupplierInvoiceRevision, type RequestRevision, type PurchaseOrder } from "../../lib/inventory-domain/procurement";
import { SUPPLIER_PROTOCOL, type SupplierIntent, type SupplierAction, type SupplierAdmission } from "../../lib/inventory-supplier-protocol";
import { ProtectedInventoryHistoryError } from "../../lib/inventory-domain/reset-protection";
import { OWNER_ONLY_OPERATIONS, STAFF_CAPABILITIES } from "../../lib/staff-capability-catalogue";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-restore-roundtrip-secret-2026");
const db = await import("../../lib/db");
const transport = await import("../../lib/inventory-domain/supplier-transport");
const { runCanonicalProcurementCommand } = await import("../../lib/inventory-domain/canonical-procurement-transport");

const MANAGER_GRANTS = {
  "inventory.requests.view": true, "inventory.requests.approve": true,
  "inventory.orders.view": true, "inventory.orders.manage": true, "inventory.receipts.post": true,
  "finance.suppliers.view": true, "inventory.supplier-invoices.record": true, "inventory.supplier-invoices.cancel": true,
};
const REQUESTER_GRANTS = { "inventory.references.view": true, "inventory.requests.view": true, "inventory.requests.create": true };
const ACCOUNTS = {
  owner: { username: "SYN-RT-OWNER", role: "admin" },
  manager: { username: "SYN-RT-MANAGER", role: "reception", grants: MANAGER_GRANTS },
  requester: { username: "SYN-RT-REQUESTER", role: "doctor", doctor: true, grants: REQUESTER_GRANTS },
} as const;
type Who = keyof typeof ACCOUNTS;
const PROPOSALS = [INVENTORY_PROCUREMENT_SQL, INVENTORY_CUSTODY_SQL, INVENTORY_SUPPLIER_FINANCE_SQL, INVENTORY_SUPPLIER_NUMBER_SQL, INVENTORY_COMMAND_LIFECYCLE_SQL, INVENTORY_SUPPLIER_TRANSPORT_SQL];

let fx: CanonicalInventoryDatabase<Who>;
let targets: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let directory: string;
let itemId = 0, location = "";
let posted: SupplierInvoiceRevision, cancelled: SupplierInvoiceRevision, pendingInvoice: SupplierInvoiceRevision;
let pendingAdmission: SupplierAdmission;
let sourceRows: Map<string, string[]>;
let sourceDocuments: Map<number, Record<string, unknown>>;
/** Sessions are minted against whichever database the runtime pool currently points to. */
let sessionPool: Pool;
let archivePath = "";
const key = () => randomUUID();

async function session(who: Who): Promise<VerifiedDurableSession> {
  if (sessionPool === fx.pool) return fx.session(who);
  const id = (await sessionPool.query<{ id: number }>("SELECT id FROM users WHERE username=$1", [ACCOUNTS[who].username])).rows[0].id;
  return readVerifiedDurableSession(syntheticSign(await syntheticClaims(sessionPool, "public", id)))!;
}
const command = async (who: Who, input: Parameters<typeof runCanonicalProcurementCommand>[2]) => runCanonicalProcurementCommand(await session(who), key(), input);
async function authorityOf(who: Who) {
  const id = (await sessionPool.query<{ id: number }>("SELECT id FROM users WHERE username=$1", [ACCOUNTS[who].username])).rows[0].id;
  const claims = await syntheticClaims(sessionPool, "public", id);
  return { realmId: claims.durableIdentity.realmId, subjectId: claims.durableIdentity.subjectId, executionEpochId: claims.durableIdentity.generationId };
}
const expectation = (invoice: SupplierInvoiceRevision) => ({ invoiceId: invoice.id, expectedVersion: invoice.version, expectedDigest: supplierInvoiceDigest(invoice), reason: "Synthetic reviewed supplier source" });
async function intentFor(invoice: SupplierInvoiceRevision, action: SupplierAction = "post", who: Who = "manager"): Promise<SupplierIntent> {
  return { protocol: SUPPLIER_PROTOCOL, authority: await authorityOf(who), nonce: key(), action, input: expectation(invoice) };
}
async function attempt(who: Who, intent: SupplierIntent) { return transport.admitSupplierIntentCanonical(await session(who), intent); }
async function admit(who: Who, intent: SupplierIntent) {
  const result = await attempt(who, intent);
  if ("status" in result) throw new Error(`Unexpected admission rejection: ${result.code}`);
  return result;
}
async function execute(who: Who, admission: SupplierAdmission) { return transport.executeSupplierIntentCanonical(await session(who), admission); }

async function supplierInvoice(supplierId?: number): Promise<SupplierInvoiceRevision> {
  const pool = db.getPool();
  const party = supplierId ?? (await pool.query("INSERT INTO parties(name,kind) VALUES($1,'supplier') RETURNING id", [`SYN-RT-${key()}`])).rows[0].id;
  const conversion = { itemId, version: 1, baseUnit: "piece", enteredUnit: "piece", baseUnitsPerEnteredUnit: "1", enteredPrecision: 0, basePrecision: 0 };
  const request: RequestRevision = { id: key(), version: 1, branchId: "clinic", requestedBy: (await pool.query("SELECT id FROM users WHERE username=$1", [ACCOUNTS.requester.username])).rows[0].id,
    reason: "Synthetic needed supplies", proposedSupplierPartyId: party, value: { currency: "SAR", amountMinor: 20000 }, lines: [{ id: key(), itemId, quantity: "2", conversion }] };
  await command("requester", { command: "request.submit", document: request });
  await command("manager", { command: "request.approve", approval: { requestId: request.id, version: 1, decisions: [{ lineId: request.lines[0].id, quantity: "2", reason: "Synthetic approval" }],
    valuation: valuationSnapshot({ purpose: "approval_estimate", currency: "SAR", amountMinor: 20000, rateToBase: "123.456789", capturedAt: "2026-10-26T01:00:00Z", sourceRef: "synthetic frozen quote" }) } });
  const order: PurchaseOrder = { id: key(), version: 1, branchId: "clinic", supplierPartyId: party, currency: "SAR", shippingMinor: 0, discountMinor: 0,
    lines: [{ id: key(), itemId, kind: "stock", quantity: "2", conversion, price: { state: "known", currency: "SAR", unitPriceMinor: 10000, reason: "Synthetic quote" },
      trackLot: true, requiresExpiry: false, minimumShelfLifeDays: 0, sources: [{ id: key(), requestId: request.id, requestLineId: request.lines[0].id, baseQuantity: "2" }] }] };
  await command("manager", { command: "order.issue", document: order });
  const receiptLine = key();
  await command("manager", { command: "receipt.post", document: { id: key(), version: 1, orderId: order.id, orderVersion: 1, branchId: "clinic", supplierPartyId: party, actualArrivalDate: "2026-10-26",
    lines: [{ orderLineId: order.lines[0].id, arrivedQuantity: "2", portions: [{ id: receiptLine, quantity: "2", disposition: "accepted", lotCode: "SYN-RT", expiryDate: null, locationId: location, damaged: false, reason: "Synthetic inspection" }] }] } });
  const lineId = key();
  const invoice: SupplierInvoiceRevision = { id: key(), version: 1, orderId: order.id, orderVersion: 1, branchId: "clinic", supplierPartyId: party, currency: "SAR",
    invoiceNumber: `SYN-RT-${key()}`, invoiceDate: "2026-10-26", missingNumberReason: null, shippingMinor: 0, discountMinor: 0,
    valuation: valuationSnapshot({ purpose: "invoice_valuation", currency: "SAR", amountMinor: 20000, rateToBase: "123.456789", capturedAt: "2026-10-26T01:00:00Z", sourceRef: "Synthetic invoice FX" }),
    lines: [{ id: lineId, orderLineId: order.lines[0].id, quantity: "2", price: order.lines[0].price, receiptAllocations: [{ id: key(), invoiceLineId: lineId, receiptLineId: receiptLine, baseQuantity: "2" }] }] };
  await command("manager", { command: "invoice.match", document: invoice });
  return invoice;
}

const EXCLUDED = new Set([...STAFF_AUTHORITY_RELATIONS, "schema_migrations"]);
/** Business rows per table, projected to the given columns (the source's), canonically ordered. */
async function businessRows(pool: Pool, columnsOf?: Map<string, string[]>): Promise<{ rows: Map<string, string[]>; columns: Map<string, string[]> }> {
  const tables = (await pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename).filter(table => !EXCLUDED.has(table));
  const rows = new Map<string, string[]>(), columns = new Map<string, string[]>();
  for (const table of tables) {
    const projected = columnsOf?.get(table) ?? (await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table])).rows
      .map(row => row.column_name)
      .filter(column => !(table === "users" && (STAFF_AUTHORITY_COLUMNS.users.includes(column) || column === "permissions"))
        && !(table === "parties" && STAFF_AUTHORITY_COLUMNS.parties.includes(column))
        && !(table === "inventory_command_bindings" && column === "created_xid"));
    columns.set(table, projected);
    if (columnsOf && !columnsOf.has(table)) continue;
    const select = projected.map(column => `"${column}"`).join(",");
    rows.set(table, (await pool.query<{ value: string }>(`SELECT to_jsonb(x)::text AS value FROM (SELECT ${select} FROM "${table}") x ORDER BY 1`)).rows.map(row => row.value));
  }
  return { rows, columns };
}
async function permissionDocuments(pool: Pool) {
  return new Map((await pool.query<{ id: number; permissions: string }>("SELECT id, permissions FROM users WHERE permissions IS NOT NULL")).rows.map(row => [row.id, JSON.parse(row.permissions) as Record<string, unknown>]));
}
async function useRuntimeDatabase(pool: Pool) {
  vi.stubEnv("DATABASE_URL", pool.options.connectionString!);
  await db.resetPoolForTesting();
  sessionPool = pool;
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  sessionPool = fx.pool;
  itemId = (await db.createInventoryItem({ name: `SYN-RT-${key()}`, category: "other", unit: "piece", minLevel: 0, note: null, createdBy: ACCOUNTS.owner.username })).id;
  await db.getPool().query("INSERT INTO inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES($1,1,'piece','piece',1,0,0)", [itemId]);
  location = `SYN-${key()}`;
  await db.getPool().query("INSERT INTO inventory_locations(id,branch_key,label,kind) VALUES($1,'clinic','Synthetic store','store')", [location]);
  await db.getPool().query("INSERT INTO inventory_approval_policies(id,branch_key,version,currency,limit_minor,allow_self_approval,created_by) VALUES($1,'clinic',1,'YER',1000000000,FALSE,$2)", [key(), fx.ids.owner]);
  await db.openShift({ openedBy: ACCOUNTS.manager.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  // Committed, cancelled and pending supplier history on the canonical source.
  posted = await supplierInvoice();
  await execute("manager", await admit("manager", await intentFor(posted)));
  cancelled = await supplierInvoice();
  await execute("manager", await admit("manager", await intentFor(cancelled)));
  await execute("manager", await admit("manager", await intentFor(cancelled, "cancel")));
  pendingInvoice = await supplierInvoice();
  pendingAdmission = await admit("manager", await intentFor(pendingInvoice));
  const snapshot = await businessRows(fx.pool);
  sourceRows = snapshot.rows;
  sourceDocuments = await permissionDocuments(fx.pool);

  targets = await openBackupTimestampFixture({ ...process.env });
  directory = await mkdtemp(join(tmpdir(), "aqlan-restore-roundtrip-"));
  const client = await fx.pool.connect();
  const blocks: Uint8Array[] = [];
  try { for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error("No synthetic documents"); } })) blocks.push(block); }
  finally { client.release(); }
  archivePath = join(directory, "canonical-roundtrip.tar.gz");
  await writeFile(archivePath, gzipSync(Buffer.concat(blocks)));
  const result = await stagedRestore({ archivePath, targetUrl: targets.archiveTarget.options.connectionString!, stagingDir: join(directory, "documents"),
    installUnregisteredProposals: async (target: Client) => { for (const sql of PROPOSALS) await target.query(sql); } });
  if (!result.ok) throw new Error(`restore failed: ${result.errors.join(" | ")}`);
}, 300_000);
afterAll(async () => {
  await db.resetPoolForTesting();
  await targets?.close();
  await fx?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("P1: the restored business rows equal the source", () => {
  it("every business table, row for row; documents equal except confirmation; the target stays held", async () => {
    const target = targets.archiveTarget;
    const { columns } = await businessRows(fx.pool);
    const restored = await businessRows(target, columns);
    expect([...restored.rows.keys()].sort()).toEqual([...sourceRows.keys()].sort());
    for (const [table, rows] of sourceRows) expect(restored.rows.get(table), table).toEqual(rows);
    expect(sourceRows.get("inventory_supplier_intents")?.length).toBeGreaterThanOrEqual(4);
    const documents = await permissionDocuments(target);
    expect([...documents.keys()].sort()).toEqual([...sourceDocuments.keys()].sort());
    for (const [id, document] of sourceDocuments) expect(documents.get(id)).toEqual({ ...document, confirmation: "pending" });
    expect((await target.query("SELECT count(*)::int AS n FROM staff_restore_hold")).rows[0].n).toBe(1);
  });
});

describe("carried over from the retired same-realm suite", () => {
  it("the raw SQL restore CLI refuses a canonical source's SQL before touching the target", async () => {
    const tar = gunzipSync(readFileSync(archivePath));
    const size = parseInt(tar.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim(), 8);
    expect(tar.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "")).toBe("database.sql");
    const sqlFile = join(directory, "canonical-source.sql");
    await writeFile(sqlFile, tar.subarray(512, 512 + size));
    const run = promisify(execFile)(process.execPath, ["scripts/restore.mjs", sqlFile], {
      env: { ...process.env, DATABASE_URL: targets.sqlTarget.options.connectionString!, SKIP_SEED: "true" }, maxBuffer: 2 * 1024 * 1024 });
    await expect(run).rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/الاستعادة المرحلية مع حجز الاستعادة/) });
    expect((await targets.sqlTarget.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0].n).toBe(0);
  });
  it("backup refuses a drifting derived number projection before emitting SQL", async () => {
    const client = await fx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE OR REPLACE VIEW inventory_supplier_number_sources AS
        SELECT duplicate_key,invoice_id,first_version,document,created_by,created_at
        FROM supplier_invoice_number_claims WHERE FALSE`);
      let emitted = 0;
      await expect((async () => { for await (const _part of db.backupSnapshotSqlLines(client)) emitted++; })()).rejects.toThrow("supplier_number_reconstruction_drift");
      expect(emitted).toBe(0);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});

describe("after a SYNTHETIC seal of the target (test fixture) and the owner's confirmation of each account", () => {
  beforeAll(async () => {
    const target = targets.archiveTarget;
    const c = await target.connect();
    try {
      await c.query(readFileSync(new URL("../fixtures/staff-identity/frozen-0076.sql", import.meta.url), "utf8"));
      await c.query(staffIdentitySubstrateSql("public"));
      await c.query("BEGIN");
      let h = await initializeStaffIdentitySubstrate(c, "public");
      for (const { id } of (await c.query<{ id: number }>("SELECT id FROM users ORDER BY id")).rows)
        h = await bindStaffAccountIncarnation(c, { userId: id, currentSubjectId: null, expected: { generationId: h.generationId, registryRevision: h.registryRevision } }, "public");
      await c.query("COMMIT");
      await c.query(staffRuntimeSchemaSql("public"));
      const ownerId = (await c.query<{ id: number }>("SELECT id FROM users WHERE username=$1", [ACCOUNTS.owner.username])).rows[0].id;
      await c.query("BEGIN");
      await c.query("UPDATE users SET authorization_mode='canonical'");
      await c.query("UPDATE staff_authority_control SET state='prepared',pending_owner_user_id=$1,conversion_digest=repeat('c',64),recovery_reference='synthetic-restore-roundtrip-seal' WHERE singleton", [ownerId]);
      await c.query("UPDATE staff_authority_control SET state='active',owner_user_id=$1,pending_owner_user_id=NULL WHERE singleton", [ownerId]);
      await c.query("COMMIT");
      await c.query("BEGIN");
      await c.query("UPDATE staff_identity_state SET status='ready',ready_owner_subject_id=(SELECT subject_id FROM staff_identity_current WHERE user_id=$1),ready_control_epoch=(SELECT binding_epoch FROM staff_authority_control) WHERE singleton", [ownerId]);
      await c.query("DELETE FROM staff_restore_hold");
      await c.query("COMMIT");
    } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
    await useRuntimeDatabase(target);
    // The owner confirms each restored account through the real editor (no automatic grant).
    const owner = await session("owner");
    for (const who of ["manager", "requester"] as const) {
      const { rows: [row] } = await target.query<{ id: number; permissions: string }>("SELECT id, permissions FROM users WHERE username=$1", [ACCOUNTS[who].username]);
      const document = JSON.parse(row.permissions) as { revision: number; patientScope: "none" | "own" | "all"; appointmentScope: "none" | "own" | "all"; grants: Record<string, boolean> };
      await updateStaffCapabilitiesIn(target, "public", owner, { targetUserId: row.id, expectedRevision: document.revision, patientScope: document.patientScope, appointmentScope: document.appointmentScope, grants: document.grants });
    }
  }, 180_000);

  it("P2: restored committed and cancelled supplier history reads through the canonical runtime", async () => {
    const postedView = await transport.readSupplierFinanceCanonical(await session("manager"), posted.orderId);
    expect(postedView.invoices[0]).toMatchObject({ status: "posted" });
    const cancelledView = await transport.readSupplierFinanceCanonical(await session("manager"), cancelled.orderId);
    expect(cancelledView.invoices[0]).toMatchObject({ status: "cancelled", effectiveMinor: 0 });
  });

  it("R4: the pending source intent never executes; a new nonce for its invoice is durably refused; an independent invoice proceeds", async () => {
    await expect(execute("manager", pendingAdmission)).rejects.toMatchObject({ code: "supplier_saved_authority_mismatch" });
    const other = await intentFor(pendingInvoice);
    const refused = await attempt("manager", other);
    expect(refused).toMatchObject({ status: "rejected", code: "supplier_invoice_intent_pending" });
    expect(await attempt("manager", other)).toEqual(refused);
    const independent = await supplierInvoice();
    const result = await execute("manager", await admit("manager", await intentFor(independent)));
    expect(result).toMatchObject({ status: "committed", result: { status: "posted" } });
  });

  it("R5 refusal (no recovery exists yet): neither a delegate holding supplier-invoices.cancel nor the owner releases a held source intent; nothing moves", async () => {
    const snapshot = async () => (await db.getPool().query(`SELECT
      (SELECT count(*) FROM inventory_command_retirements)::int AS retirements, (SELECT count(*) FROM inventory_command_bindings)::int AS bindings,
      (SELECT count(*) FROM inventory_supplier_intents)::int AS intents, (SELECT count(*) FROM inventory_supplier_intent_rejections)::int AS rejections,
      (SELECT count(*) FROM audit_log)::int AS audits`)).rows[0];
    const before = await snapshot();
    for (const who of ["manager", "owner"] as const) {
      await expect(transport.executeSupplierIntentCanonical(await session(who), pendingAdmission, "Synthetic release attempt")).rejects.toMatchObject({ code: "supplier_saved_authority_mismatch" });
      await expect(execute(who, pendingAdmission)).rejects.toMatchObject({ code: "supplier_saved_authority_mismatch" });
    }
    expect(await snapshot()).toEqual(before);
    // The reviewed recovery is not an operation of the live catalogue (no grant and no owner authority to call it).
    expect(STAFF_CAPABILITIES as readonly string[]).not.toContain("inventory.supplier-intent.recover");
    expect(OWNER_ONLY_OPERATIONS as readonly string[]).not.toContain("inventory.supplier-intent.recover");
    expect(Object.keys(transport).filter(name => /recover/i.test(name))).toEqual([]);
  });

  it("reset after restore refuses while inventory history exists, before any backup runs", async () => {
    const backup = vi.fn(async () => ({ ok: true as const, backupId: "must-not-run" }));
    await expect(db.resetClinicData({ actor: ACCOUNTS.owner.username, actorRole: "admin" }, backup)).rejects.toBeInstanceOf(ProtectedInventoryHistoryError);
    expect(backup).not.toHaveBeenCalled();
  });
});
