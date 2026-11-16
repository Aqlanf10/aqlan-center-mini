/** Restore protocol revision 3 (docs/inventory/CANONICAL-RESTORE-PROTOCOL-20261028.md),
 * B1/B2 and R1 on owned, provenance-verified PostgreSQL 18 databases; synthetic data
 * only. Dot 6486144288 constraints 1, 3 and 5:
 * - a target that ever held an identity (here: a READY canonical database with an
 *   admitted session) is refused before anything is written, and the session admitted
 *   before the attempt was genuinely valid;
 * - imported permission documents are historical data: every one becomes `pending`;
 * - the hold's release never trusts a session or transaction setting; a non-owner
 *   application/replay principal cannot remove, change or bypass it.
 * The synthetic seal at the end is a TEST FIXTURE, not an application path. */
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { syntheticClaims, syntheticSign, waitForBlockedBy } from "./_canonical-ready-fixture";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { stagedRestore } from "../../lib/restore/staging";
import { readLegacyStaffSchema, readStaffEntryMode } from "../../lib/legacy-staff-schema.mjs";
import { readVerifiedDurableSession } from "../../lib/staff-durable-session";
import { withStaffOperation } from "../../lib/staff-operation-runtime";
import { admitCanonicalStaffSessionIn } from "../../lib/staff-session-admission";
import { staffIdentitySubstrateSql } from "../../lib/staff-identity-substrate-schema.mjs";
import { bindStaffAccountIncarnation, initializeStaffIdentitySubstrate } from "../../lib/staff-identity-substrate.mjs";
import { staffRuntimeSchemaSql } from "../../lib/staff-runtime-schema.mjs";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-restore-hold-secret-2026");
const db = await import("../../lib/db");

const ACCOUNTS = {
  owner: { username: "SYN-RH-OWNER", role: "admin" },
  reception: { username: "SYN-RH-RECEPTION", role: "reception", patientScope: "all", grants: { "staff.view": true, "patients.create": true } },
} as const;
let fx: CanonicalInventoryDatabase<keyof typeof ACCOUNTS>;
let targets: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let directory: string;
let archivePath: string;
let databaseSql = "";
let manifest: Record<string, unknown> = {};

async function archive(pool: Pool): Promise<string> {
  const client = await pool.connect();
  try {
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error("No synthetic documents"); } })) blocks.push(block);
    const file = join(directory, `canonical-${Date.now()}.tar.gz`);
    await writeFile(file, gzipSync(Buffer.concat(blocks)));
    return file;
  } finally { client.release(); }
}
/** Tar entries of an uncompressed archive (synthetic, small): name → text. */
function entries(file: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (let offset = 0; offset + 512 <= file.length;) {
    const name = file.subarray(offset, offset + 100).toString("utf8").replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(file.subarray(offset + 124, offset + 136).toString("utf8").replace(/\0.*$/s, "").trim(), 8);
    out.set(name, file.subarray(offset + 512, offset + 512 + size).toString("utf8"));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
const urlOf = (pool: Pool) => pool.options.connectionString!;
const restore = (targetUrl: string) => stagedRestore({ archivePath, targetUrl, stagingDir: join(directory, `staging-${Date.now()}-${Math.random()}`) });
async function relationExists(pool: Pool, name: string) {
  return (await pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${name}`])).rows[0].present as boolean;
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  await fx.pool.query("INSERT INTO patients(patient_number,full_name,phone) VALUES('SYN-RH-1','مريض استعادة تجريبي','0500000000')");
  targets = await openBackupTimestampFixture({ ...process.env });
  directory = await mkdtemp(join(tmpdir(), "aqlan-restore-hold-"));
  archivePath = await archive(fx.pool);
  const tar = entries(gunzipSync(readFileSync(archivePath)));
  databaseSql = tar.get("database.sql") ?? "";
  manifest = JSON.parse(tar.get("manifest.json") ?? "{}");
}, 240_000);
afterAll(async () => {
  await targets?.close();
  await fx?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("B1/B2: identity is not data", () => {
  it("the backup carries no authority relation and no identity column, only a provenance line", async () => {
    for (const table of ["staff_authority_control", "staff_identity_state", "staff_identity_subjects", "staff_identity_current", "staff_identity_binding_events", "staff_identity_generations"]) {
      expect(databaseSql).not.toMatch(new RegExp(`INSERT INTO "?${table}"?`));
      expect(databaseSql).toContain(`-- ${table}: target-owned authority`);
    }
    const usersInsert = databaseSql.split("\n").find(line => /^INSERT INTO "?users"?/.test(line)) ?? "";
    expect(usersInsert).not.toMatch(/authorization_mode|authorization_epoch|staff_subject_id/);
    const partiesInsert = databaseSql.split("\n").find(line => /^INSERT INTO "?parties"?/.test(line)) ?? "";
    expect(partiesInsert).not.toMatch(/clinical_authority_epoch/);
    const { rows: [state] } = await fx.pool.query("SELECT realm_id::text AS realm, generation_id::text AS generation, registry_revision::text AS revision FROM staff_identity_state");
    expect(manifest.identityProvenance).toMatchObject({ sourceRealm: state.realm, sourceGeneration: state.generation, registryRevision: state.revision, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});

describe("R1: the hold comes first; previously-ready and non-empty targets are refused", () => {
  it("a READY target with an admitted canonical operation: the hold waits for it, then refuses; nothing is written", async () => {
    const session = await fx.session("owner");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let pid = 0;
    // The operation is admitted (shared lifecycle fence) on the target before the restore starts.
    const operation = withStaffOperation(db.getPool(), session, "staff.view", async client => {
      pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await held;
      return "admitted";
    });
    while (!pid) await new Promise(resolve => setTimeout(resolve, 5));
    const attempt = restore(urlOf(fx.pool));
    expect((await waitForBlockedBy(fx.pool, pid, 15_000)).length).toBeGreaterThan(0);
    release();
    await expect(operation).resolves.toBe("admitted");
    const result = await attempt;
    expect(result).toMatchObject({ ok: false, restoreHold: false, migrationsApplied: [] });
    expect(result.errors.join(" ")).toMatch(/هوية موحّدة/);
    expect(await relationExists(fx.pool, "staff_restore_hold")).toBe(false);
    // The canonical session admitted before the attempt is still the valid one it was.
    await expect(withStaffOperation(db.getPool(), session, "staff.view", async () => "still-valid")).resolves.toBe("still-valid");
  });
  it("a non-empty marker-free target is refused before any schema or data", async () => {
    await targets.sqlTarget.query("CREATE TABLE synthetic_preexisting (id integer)");
    const result = await restore(urlOf(targets.sqlTarget));
    expect(result).toMatchObject({ ok: false, restoreHold: false, migrationsApplied: [] });
    expect(await relationExists(targets.sqlTarget, "staff_restore_hold")).toBe(false);
    expect(await relationExists(targets.sqlTarget, "schema_migrations")).toBe(false);
  });
});

describe("restore into an empty target: held, inert, documents pending", () => {
  it("the restore commits the hold before migrating and replaying; the target stays held", async () => {
    const result = await restore(urlOf(targets.archiveTarget));
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ ok: true, restoreHold: true });
    const target = targets.archiveTarget;
    expect((await target.query("SELECT state FROM staff_restore_hold")).rows).toEqual([{ state: "held" }]);
    expect(await readStaffEntryMode(target)).toBe("canonical");
    await expect(readLegacyStaffSchema(target)).rejects.toThrow("LEGACY_STAFF_AUTHORITY_SCHEMA_HELD");
    // No source authority row or relation arrived; no identity column either.
    for (const table of ["staff_authority_control", "staff_identity_state", "staff_identity_current"]) expect(await relationExists(target, table)).toBe(false);
    const { rows: columns } = await target.query("SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name IN ('authorization_mode','authorization_epoch')");
    expect(columns).toEqual([]);
    // Business rows survive; every imported permission document is pending.
    expect((await target.query("SELECT full_name FROM patients WHERE patient_number='SYN-RH-1'")).rows).toEqual([{ full_name: "مريض استعادة تجريبي" }]);
    const { rows: documents } = await target.query<{ permissions: string }>("SELECT permissions FROM users WHERE permissions IS NOT NULL");
    expect(documents.length).toBeGreaterThan(1);
    for (const row of documents) expect(JSON.parse(row.permissions)).toMatchObject({ schemaVersion: 2, confirmation: "pending" });
  });
  it("the hold survives a new connection, and a second restore into the held target is refused", async () => {
    const result = await restore(urlOf(targets.archiveTarget));
    expect(result).toMatchObject({ ok: false, restoreHold: false });
    expect((await targets.archiveTarget.query("SELECT count(*)::int AS n FROM staff_restore_hold")).rows[0].n).toBe(1);
  });
  it("a non-owner application or replay principal cannot release, change or bypass the hold, whatever it sets", async () => {
    const role = `aqlan_restore_app_${process.pid}`;
    const client: PoolClient = await targets.archiveTarget.connect();
    try {
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${role}`);
      await client.query(`SET ROLE ${role}`);
      const refused = async (sql: string) => {
        await client.query("SAVEPOINT attack");
        try { await client.query(sql); throw new Error(`accepted: ${sql}`); }
        catch (error) { expect((error as Error).message).not.toMatch(/^accepted/); }
        finally { await client.query("ROLLBACK TO SAVEPOINT attack"); }
      };
      await client.query("BEGIN");
      for (const marker of ["aqlan.restore_seal", "aqlan.staff_restore_release", "aqlan.seal"]) await client.query("SELECT set_config($1, 'on', true)", [marker]);
      await refused("DELETE FROM staff_restore_hold");
      await refused("UPDATE staff_restore_hold SET state = 'held'");
      await refused("TRUNCATE staff_restore_hold");
      await refused("ALTER TABLE staff_restore_hold DISABLE TRIGGER ALL");
      await refused("DROP TABLE staff_restore_hold");
      await refused("SET LOCAL session_replication_role = replica");
      await client.query("ROLLBACK");
      // A look-alike "ready" identity in another schema reached through search_path is ignored.
      await client.query("RESET ROLE");
      await client.query(`GRANT CREATE ON DATABASE "${(await client.query("SELECT current_database() AS d")).rows[0].d}" TO ${role}`);
      await client.query(`SET ROLE ${role}`);
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA attack_${process.pid}`);
      await client.query(`CREATE TABLE attack_${process.pid}.staff_identity_state (singleton boolean, status text)`);
      await client.query(`INSERT INTO attack_${process.pid}.staff_identity_state VALUES (true, 'ready')`);
      await client.query(`SET LOCAL search_path = attack_${process.pid}, public`);
      await refused("DELETE FROM public.staff_restore_hold");
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("RESET ROLE");
      await client.query(`REVOKE CREATE ON DATABASE "${(await client.query("SELECT current_database() AS d")).rows[0].d}" FROM ${role}`).catch(() => undefined);
      await client.query(`DROP OWNED BY ${role}`);
      await client.query(`DROP ROLE ${role}`);
      client.release();
    }
    expect((await targets.archiveTarget.query("SELECT count(*)::int AS n FROM staff_restore_hold")).rows[0].n).toBe(1);
  });
  it("the owner of the table cannot delete it either before the target's own seal (no transaction-local exception)", async () => {
    const client = await targets.archiveTarget.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('aqlan.restore_seal', 'on', true)");
      await expect(client.query("DELETE FROM staff_restore_hold")).rejects.toThrow(/released only by the reviewed seal/);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("SYNTHETIC seal fixture: a target-owned identity sealed ready releases the hold in the same transaction; pending documents grant nothing", async () => {
    const target = targets.archiveTarget;
    const c = await target.connect();
    let ownerId = 0;
    try {
      await c.query(readFileSync(new URL("../fixtures/staff-identity/frozen-0076.sql", import.meta.url), "utf8"));
      await c.query(staffIdentitySubstrateSql("public"));
      await c.query("BEGIN");
      let h = await initializeStaffIdentitySubstrate(c, "public");
      for (const { id } of (await c.query<{ id: number }>("SELECT id FROM users ORDER BY id")).rows)
        h = await bindStaffAccountIncarnation(c, { userId: id, currentSubjectId: null, expected: { generationId: h.generationId, registryRevision: h.registryRevision } }, "public");
      await c.query("COMMIT");
      await c.query(staffRuntimeSchemaSql("public"));
      ownerId = (await c.query<{ id: number }>("SELECT id FROM users WHERE username=$1", [ACCOUNTS.owner.username])).rows[0].id;
      await c.query("BEGIN");
      await c.query("UPDATE users SET authorization_mode='canonical'");
      await c.query("UPDATE staff_authority_control SET state='prepared',pending_owner_user_id=$1,conversion_digest=repeat('b',64),recovery_reference='synthetic-restore-seal-fixture' WHERE singleton", [ownerId]);
      await c.query("UPDATE staff_authority_control SET state='active',owner_user_id=$1,pending_owner_user_id=NULL WHERE singleton", [ownerId]);
      await c.query("COMMIT");
      // The target realm is new: no source realm, generation or subject was adopted.
      const { rows: [realm] } = await c.query("SELECT realm_id::text AS realm FROM staff_authority_control");
      expect(realm.realm).not.toBe((manifest.identityProvenance as { sourceRealm: string }).sourceRealm);
      await c.query("BEGIN");
      await c.query("UPDATE staff_identity_state SET status='ready',ready_owner_subject_id=(SELECT subject_id FROM staff_identity_current WHERE user_id=$1),ready_control_epoch=(SELECT binding_epoch FROM staff_authority_control) WHERE singleton", [ownerId]);
      await c.query("DELETE FROM staff_restore_hold");
      await c.query("COMMIT");
    } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
    expect((await target.query("SELECT count(*)::int AS n FROM staff_restore_hold")).rows[0].n).toBe(0);
    const owner = readVerifiedDurableSession(syntheticSign(await syntheticClaims(target, "public", ownerId)))!;
    expect(await admitCanonicalStaffSessionIn(target, "public", owner)).toMatchObject({ isOwner: true });
    const receptionId = (await target.query<{ id: number }>("SELECT id FROM users WHERE username=$1", [ACCOUNTS.reception.username])).rows[0].id;
    const reception = readVerifiedDurableSession(syntheticSign(await syntheticClaims(target, "public", receptionId)))!;
    // Imported grants are historical: nothing is effective until the owner confirms the account.
    expect(await admitCanonicalStaffSessionIn(target, "public", reception)).toMatchObject({ capabilities: [], patientScope: "none" });
  });
});
