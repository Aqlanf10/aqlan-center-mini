import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Pool } from "pg";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { migrate } from "../../lib/migrations";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { stagedRestore } from "../../lib/restore/staging";
import { withTransaction } from "../../lib/transactions";
import { finalizeRestoredStaffIdentityInTransaction } from "../../lib/staff-authority-lifecycle.mjs";
import { readStaffIdentityClaims } from "../../lib/staff-authenticated-identity";
import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { revalidateSessionInTransaction } from "../../lib/session";
import { authenticateSupplierSession } from "../../lib/inventory-domain/authenticated-session";
import { STAFF_AUTHORITY_SQL } from "../../lib/staff-authority-schema-proposal";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_CUSTODY_SQL } from "../../lib/inventory-domain/custody-schema-proposal";
import { INVENTORY_SUPPLIER_FINANCE_SQL } from "../../lib/inventory-domain/supplier-finance-schema-proposal";
import { INVENTORY_COMMAND_LIFECYCLE_SQL } from "../../lib/inventory-domain/command-lifecycle-schema-proposal";
import { INVENTORY_SUPPLIER_TRANSPORT_SQL } from "../../lib/inventory-domain/supplier-transport-schema-proposal";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
const db = await import("../../lib/db");
const originalUrl = process.env.DATABASE_URL, originalSeed = process.env.SKIP_SEED;
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let directory: string, oldArchive: string, invalidArchive: string;
const proposals = [INVENTORY_PROCUREMENT_SQL, INVENTORY_CUSTODY_SQL, INVENTORY_SUPPLIER_FINANCE_SQL,
  INVENTORY_COMMAND_LIFECYCLE_SQL, STAFF_AUTHORITY_SQL, INVENTORY_SUPPLIER_TRANSPORT_SQL];
async function install(pool: Pool) { for (const sql of proposals) await pool.query(sql); }
async function archive(pool: Pool, name: string) {
  const client = await pool.connect();
  try {
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error("No synthetic files"); } })) blocks.push(block);
    const file = join(directory, name); await writeFile(file, gzipSync(Buffer.concat(blocks))); return file;
  } finally { client.release(); }
}
async function authority(pool: Pool) {
  return { identity: (await pool.query("SELECT * FROM staff_authority_identity ORDER BY singleton")).rows,
    epochs: (await pool.query("SELECT * FROM staff_execution_epochs ORDER BY id")).rows,
    subjects: (await pool.query("SELECT id,staff_subject_id FROM users ORDER BY id")).rows };
}
beforeAll(async () => {
  vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
  vi.stubEnv("SESSION_SECRET", "synthetic-maintenance-identity-secret-2026");
  fixture = await openBackupTimestampFixture({ ...process.env });
  directory = await mkdtemp(join(tmpdir(), "inventory-authority-maintenance-"));
  for (const pool of [fixture.source, fixture.sqlTarget, fixture.archiveTarget]) await migrate(pool, { apply: true });
  await fixture.source.query("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(501,'SYN-OLD-ADMIN','Synthetic prior-version admin','synthetic-maintenance-hash','admin')");
  oldArchive = await archive(fixture.source, "synthetic-old-archive.tar.gz");
  for (const pool of [fixture.source, fixture.sqlTarget, fixture.archiveTarget]) await install(pool);
  // Deliberately incomplete source evidence: a realm-bound command with no realm
  // identity. This must never be silently repaired as a new installation.
  const subject = (await fixture.source.query("SELECT staff_subject_id FROM users WHERE id=501")).rows[0].staff_subject_id;
  await fixture.source.query("INSERT INTO inventory_command_bindings(scope,actor_id,operation_key,payload_hash,realm_id,subject_id,username,management) VALUES('synthetic.restore',501,$1,$2,$3,$4,'SYN-OLD-ADMIN',TRUE)",
    [randomUUID(), "a".repeat(64), randomUUID(), subject]);
  invalidArchive = await archive(fixture.source, "synthetic-invalid-identity.tar.gz");
}, 120_000);
afterAll(async () => {
  await db.resetPoolForTesting(); process.env.DATABASE_URL = originalUrl; process.env.SKIP_SEED = originalSeed;
  vi.unstubAllEnvs();
  try { await fixture?.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
});

it("pre-identity backup restores with new subjects and explicit managed initialization, without inventing command provenance", async () => {
  const result = await stagedRestore({ archivePath: oldArchive, targetUrl: fixture.sqlTarget.options.connectionString!,
    stagingDir: join(directory, "old-documents"), allowNonEmptyTarget: true });
  expect(result.errors).toEqual([]); expect(result.ok).toBe(true);
  const state = await authority(fixture.sqlTarget);
  expect(state.identity).toHaveLength(1); expect(state.subjects).toHaveLength(1);
  expect(state.subjects[0].staff_subject_id).toMatch(/^[a-f0-9-]{36}$/);
  expect((await fixture.sqlTarget.query("SELECT count(*)::int AS n FROM inventory_command_bindings")).rows[0].n).toBe(0);
  expect((await fixture.sqlTarget.query("SELECT count(*)::int AS n FROM inventory_supplier_intents")).rows[0].n).toBe(0);
  process.env.DATABASE_URL = fixture.sqlTarget.options.connectionString!; process.env.SKIP_SEED = "true";
  await db.resetPoolForTesting();
}, 120_000);

it("identity-dependent history without source identity rolls back the whole restored dataset", async () => {
  const result = await stagedRestore({ archivePath: invalidArchive, targetUrl: fixture.archiveTarget.options.connectionString!,
    stagingDir: join(directory, "invalid-documents"), allowNonEmptyTarget: true });
  expect(result.ok).toBe(false); expect(result.readyForCutover).toBe(false);
  expect(result.errors.join(" ")).toContain("bound_history_without_staff_authority");
  for (const table of ["users", "staff_authority_identity", "staff_execution_epochs", "inventory_command_bindings", "audit_log"])
    expect((await fixture.archiveTarget.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
}, 120_000);

it("partial identity schema refuses without provisioning or changing an established identity", async () => {
  const before = await authority(fixture.sqlTarget), c = await fixture.sqlTarget.connect();
  try {
    await c.query("BEGIN"); await c.query("ALTER TABLE staff_execution_epochs RENAME TO synthetic_hidden_epochs");
    await expect(finalizeRestoredStaffIdentityInTransaction(c)).rejects.toMatchObject({ code: "partial_staff_authority_schema" });
  } finally { await c.query("ROLLBACK"); c.release(); }
  expect(await authority(fixture.sqlTarget)).toEqual(before);
});

it("backup failure and mandatory reset-audit failure preserve the prior epoch and wipeable operational rows", async () => {
  await fixture.sqlTarget.query("INSERT INTO visits(patient_name,status) VALUES('Synthetic unlinked reset rollback visit','waiting')");
  const before = await authority(fixture.sqlTarget);
  const refused = await db.resetClinicData({ actor: "SYN-OLD-ADMIN", actorRole: "admin" }, async () => ({ ok: false as const, failure: "synthetic-backup-failure" }));
  expect(refused).toEqual({ ok: false, failure: "synthetic-backup-failure" });
  expect(await authority(fixture.sqlTarget)).toEqual(before);
  await fixture.sqlTarget.query("CREATE FUNCTION synthetic_identity_audit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='system.reset' THEN RAISE EXCEPTION 'synthetic audit refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_identity_audit_refusal BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_identity_audit_refusal()");
  try {
    await expect(db.resetClinicData({ actor: "SYN-OLD-ADMIN", actorRole: "admin" }, async () => ({ ok: true as const, backupId: "synthetic-local-backup" }))).rejects.toThrow("synthetic audit refusal");
  } finally { await fixture.sqlTarget.query("DROP TRIGGER synthetic_identity_audit_refusal ON audit_log; DROP FUNCTION synthetic_identity_audit_refusal()"); }
  expect(await authority(fixture.sqlTarget)).toEqual(before);
  expect((await fixture.sqlTarget.query("SELECT patient_name FROM visits")).rows).toEqual([{ patient_name: "Synthetic unlinked reset rollback visit" }]);
});

it("legacy empty-history reset rotates its inventory epoch but cannot reopen held staff authentication", async () => {
  const before = await authority(fixture.sqlTarget);
  const signed: SessionPayload = { userId: 501, username: "SYN-OLD-ADMIN", role: "admin", expiresAt: Date.now() + 3_600_000,
    credentialVersion: sessionCredentialVersion("synthetic-maintenance-hash"), authority: await readStaffIdentityClaims(501) };
  const result = await db.resetClinicData({ actor: signed.username, actorRole: signed.role }, async () => ({ ok: true as const, backupId: "synthetic-local-backup" }));
  expect(result.ok).toBe(true);
  const after = await authority(fixture.sqlTarget);
  expect(after.identity[0].realm_id).toBe(before.identity[0].realm_id);
  expect(after.identity[0].execution_epoch_id).not.toBe(before.identity[0].execution_epoch_id);
  expect(after.subjects).toEqual(before.subjects); expect(after.epochs).toHaveLength(before.epochs.length + 1);
  expect((await fixture.sqlTarget.query("SELECT count(*)::int AS n FROM patients")).rows[0].n).toBe(0);
  expect((await fixture.sqlTarget.query("SELECT count(*)::int AS n FROM visits")).rows[0].n).toBe(0);
  // The old independent authority footprint is a global legacy-authentication
  // hold. Rotating or rereading its claims must not revive that obsolete path.
  const fresh = { ...signed, authority: await readStaffIdentityClaims(501) };
  for (const claims of [signed, fresh]) {
    await expect(withTransaction(db.getPool(), c => revalidateSessionInTransaction(claims, c)))
      .rejects.toThrow("LEGACY_STAFF_AUTHORITY_SCHEMA_HELD");
    await expect(withTransaction(db.getPool(), c => authenticateSupplierSession(c, claims)))
      .rejects.toThrow("LEGACY_STAFF_AUTHORITY_SCHEMA_HELD");
  }
  expect(await authority(fixture.sqlTarget)).toEqual(after);
});

it("patient-number history refuses reset before backup and preserves execution authority", async () => {
  await fixture.sqlTarget.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-PROTECTED-IDENTITY','Synthetic protected patient')");
  const before = await authority(fixture.sqlTarget);
  const patients = (await fixture.sqlTarget.query("SELECT * FROM patients ORDER BY id")).rows;
  const backup = vi.fn(async () => ({ ok: true as const, backupId: "synthetic-local-backup" }));
  await expect(db.resetClinicData({ actor: "SYN-OLD-ADMIN", actorRole: "admin" }, backup))
    .rejects.toMatchObject({ name: "ProtectedPatientNumberHistoryError" });
  expect(backup).not.toHaveBeenCalled();
  expect(await authority(fixture.sqlTarget)).toEqual(before);
  expect((await fixture.sqlTarget.query("SELECT * FROM patients ORDER BY id")).rows).toEqual(patients);
});
