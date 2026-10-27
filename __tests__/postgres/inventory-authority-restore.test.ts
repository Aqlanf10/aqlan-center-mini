import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { migrate } from "../../lib/migrations";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { stagedRestore } from "../../lib/restore/staging";
import { withTransaction } from "../../lib/transactions";
import { createSessionToken, readSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { STAFF_AUTHORITY_SQL } from "../../lib/staff-authority-schema-proposal";
import { bootstrapStaffIdentityInTransaction, readStaffIdentityClaims } from "../../lib/staff-authenticated-identity";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_CUSTODY_SQL } from "../../lib/inventory-domain/custody-schema-proposal";
import { INVENTORY_SUPPLIER_FINANCE_SQL } from "../../lib/inventory-domain/supplier-finance-schema-proposal";
import { INVENTORY_COMMAND_LIFECYCLE_SQL } from "../../lib/inventory-domain/command-lifecycle-schema-proposal";
import { INVENTORY_SUPPLIER_TRANSPORT_SQL } from "../../lib/inventory-domain/supplier-transport-schema-proposal";
import { valuationSnapshot, type PurchaseOrder, type RequestRevision, type SupplierInvoiceRevision } from "../../lib/inventory-domain/procurement";
import { supplierInvoiceDigest } from "../../lib/inventory-domain/supplier-finance";
import { admitSupplierIntent, executeSupplierIntent } from "../../lib/inventory-domain/supplier-transport";
import { SUPPLIER_PROTOCOL, type SupplierAdmission, type SupplierAction, type SupplierIntent, type SupplierRejectedIntent } from "../../lib/inventory-supplier-protocol";
import { ProtectedInventoryHistoryError } from "../../lib/inventory-domain/reset-protection";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
const db = await import("../../lib/db");
const store = await import("../../lib/inventory-domain/procurement-store");
const originalUrl = process.env.DATABASE_URL, originalSeed = process.env.SKIP_SEED;
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let directory: string, archivePath: string, signed: SessionPayload;
let committed: SupplierAdmission, pending: SupplierAdmission, retired: SupplierAdmission;
let refusedIntent: SupplierIntent, refused: SupplierRejectedIntent;
let originalResult: Record<string, unknown> | undefined;
let snapshot: Record<string, unknown>;
const admin = { userId: 501, username: "SYN-RESTORE-ADMIN", role: "admin" };
const doctor = { userId: 502, username: "SYN-RESTORE-DOCTOR", role: "doctor" };
const key = () => randomUUID();
const proposals = [INVENTORY_PROCUREMENT_SQL, INVENTORY_CUSTODY_SQL, INVENTORY_SUPPLIER_FINANCE_SQL,
  INVENTORY_COMMAND_LIFECYCLE_SQL, STAFF_AUTHORITY_SQL, INVENTORY_SUPPLIER_TRANSPORT_SQL];

async function schema(pool: Pool) {
  await migrate(pool, { apply: true });
  // Explicit disposable installation until migration-number coordination completes.
  // The final registered-migration rehearsal must replace this preparation step.
  for (const sql of proposals) await pool.query(sql);
}
async function runtime(pool: Pool) {
  await db.resetPoolForTesting();
  process.env.DATABASE_URL = pool.options.connectionString!;
  process.env.SKIP_SEED = "true";
}
async function sign() {
  return readSessionToken(createSessionToken({ ...admin, expiresAt: Date.now() + 3_600_000,
    credentialVersion: sessionCredentialVersion("synthetic-restore-hash"),
    authority: await readStaffIdentityClaims(admin.userId) }))!;
}
async function savedRows(pool: Pool) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('schema_migrations','staff_authority_identity','staff_execution_epochs') ORDER BY tablename")).rows;
  const result: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    const projection = tablename === "inventory_command_bindings" ? "to_jsonb(t)-'created_xid'" : "to_jsonb(t)";
    result[tablename] = (await pool.query(`SELECT (${projection})::text AS value FROM "${tablename}" t ORDER BY (${projection})::text`)).rows;
  }
  return result;
}
async function archive(pool: Pool, name: string) {
  const client = await pool.connect();
  try {
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error("No synthetic documents"); } })) blocks.push(block);
    const file = join(directory, name);
    await writeFile(file, gzipSync(Buffer.concat(blocks)));
    return file;
  } finally { client.release(); }
}
async function invoice() {
  const conversion = { itemId: 701, version: 1, baseUnit: "piece", enteredUnit: "piece", baseUnitsPerEnteredUnit: "1", enteredPrecision: 0, basePrecision: 0 };
  const request: RequestRevision = { id: key(), version: 1, branchId: "clinic", requestedBy: doctor.userId,
    reason: "Synthetic restore supplies", proposedSupplierPartyId: 601, value: { currency: "SAR", amountMinor: 20000 },
    lines: [{ id: key(), itemId: 701, quantity: "2", conversion }] };
  await store.submitPurchaseRequest(doctor, key(), request);
  await store.approvePurchaseRequest(admin, key(), { requestId: request.id, version: 1,
    decisions: [{ lineId: request.lines[0].id, quantity: "2", reason: "Synthetic independent approval" }],
    valuation: valuationSnapshot({ purpose: "approval_estimate", currency: "SAR", amountMinor: 20000,
      rateToBase: "100.5", capturedAt: "2026-10-26T01:00:00Z", sourceRef: "Synthetic frozen quote" }) });
  const order: PurchaseOrder = { id: key(), version: 1, branchId: "clinic", supplierPartyId: 601, currency: "SAR", shippingMinor: 0, discountMinor: 0,
    lines: [{ id: key(), itemId: 701, kind: "stock", quantity: "2", conversion,
      price: { state: "known", currency: "SAR", unitPriceMinor: 10000, reason: "Synthetic quote" }, trackLot: true, requiresExpiry: false, minimumShelfLifeDays: 0,
      sources: [{ id: key(), requestId: request.id, requestLineId: request.lines[0].id, baseQuantity: "2" }] }] };
  await store.issuePurchaseOrder(admin, key(), order);
  const receiptLine = key(), lineId = key();
  await store.postInspectedReceipt(admin, key(), { id: key(), version: 1, orderId: order.id, orderVersion: 1,
    branchId: "clinic", supplierPartyId: 601, actualArrivalDate: "2026-10-26",
    lines: [{ orderLineId: order.lines[0].id, arrivedQuantity: "2", portions: [{ id: receiptLine, quantity: "2", disposition: "accepted",
      lotCode: "SYN-RESTORE", expiryDate: null, locationId: "SYN-RESTORE-STORE", damaged: false, reason: "Synthetic receipt inspection" }] }] });
  const document: SupplierInvoiceRevision = { id: key(), version: 1, orderId: order.id, orderVersion: 1, branchId: "clinic", supplierPartyId: 601,
    currency: "SAR", invoiceNumber: `SYN-${key()}`, invoiceDate: "2026-10-26", missingNumberReason: null, shippingMinor: 0, discountMinor: 0,
    valuation: valuationSnapshot({ purpose: "invoice_valuation", currency: "SAR", amountMinor: 20000, rateToBase: "100.5", capturedAt: "2026-10-26T01:00:00Z", sourceRef: "Synthetic frozen invoice FX" }),
    lines: [{ id: lineId, orderLineId: order.lines[0].id, quantity: "2", price: order.lines[0].price,
      receiptAllocations: [{ id: key(), invoiceLineId: lineId, receiptLineId: receiptLine, baseQuantity: "2" }] }] };
  await store.recordSupplierInvoiceMatch(admin, key(), document);
  return document;
}
async function admission(document: SupplierInvoiceRevision, action: SupplierAction = "post", next?: SupplierInvoiceRevision) {
  const result = await admitSupplierIntent(signed, { protocol: SUPPLIER_PROTOCOL, authority: signed.authority!, nonce: key(), action,
    input: { invoiceId: document.id, expectedVersion: document.version, expectedDigest: supplierInvoiceDigest(document),
      reason: "Synthetic source-backed review", ...(next ? { document: next } : {}) } });
  if ("status" in result) throw new Error("Synthetic restore intent unexpectedly refused");
  return result;
}

beforeAll(async () => {
  vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
  vi.stubEnv("SESSION_SECRET", "synthetic-inventory-restore-secret-2026");
  fixture = await openBackupTimestampFixture({ ...process.env });
  directory = await mkdtemp(join(tmpdir(), "inventory-application-restore-"));
  await schema(fixture.source); await runtime(fixture.source);
  await fixture.source.query("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(501,'SYN-RESTORE-ADMIN','Synthetic admin','synthetic-restore-hash','admin'),(502,'SYN-RESTORE-DOCTOR','Synthetic doctor','synthetic-restore-hash','doctor')");
  await withTransaction(db.getPool(), c => bootstrapStaffIdentityInTransaction(c, "Synthetic archive identity initialization"));
  await fixture.source.query("INSERT INTO parties(id,name,kind) VALUES(601,'Synthetic restore supplier','supplier'); INSERT INTO inventory_items(id,name,unit,is_active,created_by) VALUES(701,'Synthetic restore item','piece',TRUE,'SYN-RESTORE-ADMIN'); INSERT INTO inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES(701,1,'piece','piece',1,0,0); INSERT INTO inventory_locations(id,branch_key,label,kind) VALUES('SYN-RESTORE-STORE','clinic','Synthetic store','store')");
  await fixture.source.query("INSERT INTO inventory_approval_policies(id,branch_key,version,currency,limit_minor,allow_self_approval,created_by) VALUES($1,'clinic',1,'YER',100000000,FALSE,501)", [key()]);
  signed = await sign();
  const first = await invoice(), revised = { ...first, version: 2, invoiceDate: "2026-10-25" };
  await executeSupplierIntent(signed, await admission(first, "revise", revised));
  committed = await admission(revised);
  originalResult = (await executeSupplierIntent(signed, committed)).result;
  const cancelled = await invoice();
  await executeSupplierIntent(signed, await admission(cancelled));
  await executeSupplierIntent(signed, await admission(cancelled, "cancel"));
  pending = await admission(await invoice());
  refusedIntent = { protocol: SUPPLIER_PROTOCOL, authority: signed.authority!, nonce: key(),
    action: pending.envelope.action, input: pending.envelope.input };
  const refusal = await admitSupplierIntent(signed, refusedIntent);
  if (!("status" in refusal)) throw new Error("Conflicting synthetic intent unexpectedly admitted");
  refused = refusal;
  expect(refused).toMatchObject({ status: "rejected", code: "supplier_invoice_intent_pending", intent: refusedIntent });
  expect(await admitSupplierIntent(signed, refusedIntent)).toEqual(refused);
  retired = await admission(await invoice());
  await executeSupplierIntent(signed, retired, "Synthetic explicit retirement");
  // Real physical order disagrees with version order; no trigger is disabled.
  await fixture.source.query("CREATE INDEX synthetic_invoice_revision_reverse ON supplier_invoice_revisions(invoice_id,version DESC); CLUSTER supplier_invoice_revisions USING synthetic_invoice_revision_reverse; DROP INDEX synthetic_invoice_revision_reverse");
  snapshot = await savedRows(fixture.source);
  archivePath = await archive(fixture.source, "synthetic-source.tar.gz");
  const client = await fixture.source.connect();
  try {
    let sql = ""; for await (const part of db.backupSqlLines(client)) sql += part;
    const bindingInsert = sql.split("\n").find(line => line.startsWith('INSERT INTO "inventory_command_bindings"'))
      ?? sql.split("\n").find(line => line.startsWith("INSERT INTO inventory_command_bindings"));
    expect(bindingInsert).toBeDefined(); expect(bindingInsert).not.toContain("created_xid");
    await writeFile(join(directory, "synthetic-source.sql"), sql);
  } finally { client.release(); }
}, 120_000);

afterAll(async () => {
  await db.resetPoolForTesting();
  process.env.DATABASE_URL = originalUrl; process.env.SKIP_SEED = originalSeed;
  vi.unstubAllEnvs();
  try { await fixture?.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
});

async function assertRestored(pool: Pool) {
  expect(await savedRows(pool)).toEqual(snapshot);
  const source = (await fixture.source.query("SELECT * FROM staff_authority_identity")).rows[0];
  const restored = (await pool.query("SELECT * FROM staff_authority_identity")).rows[0];
  expect(restored.realm_id).toBe(source.realm_id);
  expect(restored.created_at).toEqual(source.created_at);
  expect(restored.execution_epoch_id).not.toBe(source.execution_epoch_id);
  const oldEpochs = (await fixture.source.query("SELECT * FROM staff_execution_epochs ORDER BY id")).rows;
  expect((await pool.query("SELECT * FROM staff_execution_epochs WHERE id=ANY($1::uuid[]) ORDER BY id", [oldEpochs.map(row => row.id)])).rows).toEqual(oldEpochs);
  expect(Number((await pool.query("SELECT count(*) AS n FROM staff_execution_epochs")).rows[0].n)).toBe(oldEpochs.length + 1);
  await runtime(pool);
  await expect(executeSupplierIntent(signed, committed)).rejects.toMatchObject({ code: "supplier_reauthentication_required" });
  const fresh = await sign();
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await admitSupplierIntent(fresh, refusedIntent)).toEqual(refused);
  }
  expect(Number((await pool.query("SELECT count(*) AS n FROM inventory_supplier_intents WHERE intent_nonce=$1", [refusedIntent.nonce])).rows[0].n)).toBe(0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const replay = await executeSupplierIntent(fresh, committed);
    expect(replay.digest).toBe(committed.digest); expect(replay.envelope).toEqual(committed.envelope);
    expect(replay.result).toMatchObject({ ...originalResult, replayed: true });
  }
  expect(await executeSupplierIntent(fresh, retired)).toMatchObject({ status: "retired", reason: "Synthetic explicit retirement", digest: retired.digest });
  await expect(executeSupplierIntent(fresh, pending)).rejects.toMatchObject({ code: "supplier_saved_authority_mismatch" });
  await expect(executeSupplierIntent(fresh, pending, "Cannot retire rolled-back uncertainty")).rejects.toMatchObject({ code: "supplier_saved_authority_mismatch" });
  expect(await savedRows(pool)).toEqual(snapshot);
}

it("actual archive INSERT restore preserves business history and source identity while fencing stale execution", async () => {
  await schema(fixture.archiveTarget);
  const result = await stagedRestore({ archivePath, targetUrl: fixture.archiveTarget.options.connectionString!,
    stagingDir: join(directory, "restored-documents"), allowNonEmptyTarget: true });
  expect(result.errors).toEqual([]); expect(result.ok).toBe(true);
  await assertRestored(fixture.archiveTarget);
}, 120_000);

it("legacy SQL CLI applies the same atomic epoch fence and a second restore gets a distinct execution epoch", async () => {
  await schema(fixture.sqlTarget);
  const result = await promisify(execFile)(process.execPath, ["scripts/restore.mjs", join(directory, "synthetic-source.sql")], {
    env: { ...process.env, DATABASE_URL: fixture.sqlTarget.options.connectionString!, SKIP_SEED: "true" }, maxBuffer: 2 * 1024 * 1024,
  });
  expect(result.stdout).toContain("تمت الاستعادة");
  await assertRestored(fixture.sqlTarget);
  expect((await fixture.sqlTarget.query("SELECT execution_epoch_id FROM staff_authority_identity")).rows[0].execution_epoch_id)
    .not.toBe((await fixture.archiveTarget.query("SELECT execution_epoch_id FROM staff_authority_identity")).rows[0].execution_epoch_id);
}, 120_000);

it("recorded inventory history refuses reset before backup and leaves authority and historical receipts intact", async () => {
  await runtime(fixture.sqlTarget);
  const identity = (await fixture.sqlTarget.query("SELECT * FROM staff_authority_identity")).rows;
  const backup = vi.fn(async () => ({ ok: true as const, backupId: "must-not-run" }));
  await expect(db.resetClinicData({ actor: admin.username, actorRole: admin.role }, backup)).rejects.toBeInstanceOf(ProtectedInventoryHistoryError);
  expect(backup).not.toHaveBeenCalled();
  expect((await fixture.sqlTarget.query("SELECT * FROM staff_authority_identity")).rows).toEqual(identity);
  expect(await savedRows(fixture.sqlTarget)).toEqual(snapshot);
});
