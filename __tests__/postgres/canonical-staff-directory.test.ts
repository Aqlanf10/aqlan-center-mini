/** Synthetic ready-owner evidence only. This file creates and drops its own
 * identity-checked disposable DATABASE, never the supplied test DB's public
 * schema. No bootstrap, issuer, route or complete writer closure is proved. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import type { DbClient, DbPool } from "../../lib/db";
import { openLegacyStaffFixture } from "./_legacy-staff-fixture";
import { STAFF_AUTHORIZATION_POLICY_VERSION } from "../../lib/staff-capability-catalogue";
import { staffIdentitySubstrateSql } from "../../lib/staff-identity-substrate-schema.mjs";
import { initializeStaffIdentitySubstrate, bindStaffAccountIncarnation } from "../../lib/staff-identity-substrate.mjs";
import { staffRuntimeSchemaSql } from "../../lib/staff-runtime-schema.mjs";
import { sessionCredentialVersion } from "../../lib/auth";
import { readVerifiedDurableSession } from "../../lib/staff-durable-session";
import { readCanonicalStaffDirectory } from "../../lib/canonical-staff-directory";
import { withStaffOperation } from "../../lib/staff-operation-runtime";
const bridge = vi.hoisted(() => ({ pool: undefined as unknown as DbPool }));
vi.mock("../../lib/db", () => ({ getPool: () => bridge.pool, usesSharedLocalDatabaseConnection: () => false }));
const FENCE = "aqlan.canonical.identity.substrate.v1:public";
const secret = "synthetic-directory-pg-secret-no-production-credential";
const doc = (grants: Record<string, boolean> = {}) => ({ schemaVersion: 2, confirmation: "owner", revision: 1, patientScope: "none", appointmentScope: "none", grants });
let fixture: Awaited<ReturnType<typeof openLegacyStaffFixture>> | undefined;
let pool: Pool;
let sqlLog: string[] = [], xidObservations: (string | null)[] = [];
let beforeDirectory: ((client: PoolClient) => Promise<void>) | undefined;
let beforeLease: ((client: PoolClient) => Promise<void>) | undefined;
let released: (boolean | undefined)[] = [];
function instrumentedPool(): DbPool {
 return {
  query: ((sql: string, values?: unknown[]) => pool.query(sql, values)) as DbPool["query"],
  connect: async () => {
   const client = await pool.connect();
   try { await beforeLease?.(client); } catch (error) { client.release(true); throw error; }
   const query: DbClient["query"] = async (sql, values) => {
    sqlLog.push(sql);
    if (sql.includes("FROM public.users u JOIN public.staff_identity_current")) await beforeDirectory?.(client);
    if (sql === "COMMIT") xidObservations.push((await client.query("SELECT pg_current_xact_id_if_assigned()::text AS xid")).rows[0].xid);
    const result = await client.query(sql, values);
    if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") xidObservations.push((await client.query("SELECT pg_current_xact_id_if_assigned()::text AS xid")).rows[0].xid);
    return result;
   };
   return { query, release: destroy => { released.push(destroy); client.release(destroy); } };
  },
 };
}
async function claims(userId = 2) {
 const { rows: [row] } = await pool.query(`SELECT u.id,u.username,u.password_hash,u.authorization_epoch::text,u.permissions,u.party_id,p.clinical_authority_epoch::text,
 h.realm_id::text,h.generation_id::text,h.registry_revision::text,c.binding_epoch::text,b.subject_id::text
 FROM public.users u CROSS JOIN public.staff_identity_state h CROSS JOIN public.staff_authority_control c
 JOIN public.staff_identity_current b ON b.user_id=$1 LEFT JOIN public.parties p ON p.id=u.party_id WHERE u.id=$1`, [userId]);
 return { userId: row.id, username: row.username, expiresAt: Date.now() + 60_000,
  durableIdentity: { schemaVersion: 2, policyVersion: STAFF_AUTHORIZATION_POLICY_VERSION, realmId: row.realm_id, subjectId: row.subject_id,
   generationId: row.generation_id, registryRevision: row.registry_revision, controlEpoch: row.binding_epoch, accountEpoch: row.authorization_epoch,
   permissionRevision: row.permissions.revision, credentialVersion: sessionCredentialVersion(row.password_hash),
   provider: row.party_id === null ? null : { partyId: row.party_id, clinicalEpoch: row.clinical_authority_epoch } } };
}
function verified(payload: unknown) {
 const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
 const handle = readVerifiedDurableSession(`${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`);
 if (!handle) throw new Error("Synthetic directory token fixture invalid");
 return handle;
}
async function session(userId = 2) { return verified(await claims(userId)); }
async function blockedBy(pid: number) {
 const deadline = performance.now() + 3000;
 while (performance.now() < deadline) {
  const { rows } = await pool.query("SELECT pid FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))", [pid]);
  if (rows.length) return rows.map(row => row.pid as number);
  await new Promise(resolve => setTimeout(resolve, 10));
 }
 throw new Error("Expected real PostgreSQL blocking barrier was not observed");
}
async function noLeakedFence() {
 const client = await pool.connect();
 try {
  expect((await client.query("SELECT count(*)::integer AS n FROM pg_catalog.pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())")).rows[0].n).toBe(0);
  await client.query("BEGIN");
  expect((await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired", [FENCE])).rows[0].acquired).toBe(true);
 } finally { await client.query("ROLLBACK"); client.release(); }
}
beforeAll(async () => {
 vi.stubEnv("SESSION_SECRET", secret);
 fixture = await openLegacyStaffFixture(process.env); pool = fixture.pool;
 expect((await pool.query("SELECT current_setting('server_version_num')::integer / 10000 AS major")).rows[0].major).toBe(18);
 expect((await pool.query("SELECT count(*)::integer AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0].n).toBe(0);
 expect((await pool.query("SELECT count(*)::integer AS n FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")).rows[0].n).toBe(0);
 const client = await pool.connect();
 try {
  await client.query("SET search_path TO public,pg_catalog");
  await client.query("CREATE TABLE public.parties(id SERIAL PRIMARY KEY,kind TEXT,name TEXT,is_active BOOLEAN);CREATE TABLE public.users(id SERIAL PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,role TEXT,is_active BOOLEAN,party_id INTEGER,permissions JSONB)");
  await client.query(readFileSync(new URL("../fixtures/staff-identity/frozen-0076.sql", import.meta.url), "utf8"));
  await client.query(staffIdentitySubstrateSql("public"));
  await client.query("INSERT INTO public.parties(id,kind,is_active) VALUES(20,'doctor',TRUE),(21,'doctor',FALSE),(22,'supplier',TRUE)");
  for (const [id, role, partyId, grants] of [[1, "admin", null, {}], [2, "doctor", 20, { "staff.view": true }], [3, "admin", null, {}], [4, "reception", 21, {}]] as const) {
   await client.query("INSERT INTO public.users(id,username,role,is_active,password_hash,party_id,permissions) VALUES($1,$2,$3,TRUE,'synthetic-directory-hash',$4,$5)", [id, `directory-${id}`, role, partyId, JSON.stringify(doc(grants))]);
  }
  await client.query("BEGIN");
  let state = await initializeStaffIdentitySubstrate(client, "public");
  for (const userId of [1, 2, 3, 4]) state = await bindStaffAccountIncarnation(client, { userId, currentSubjectId: null, expected: { generationId: state.generationId, registryRevision: state.registryRevision } }, "public");
  await client.query("COMMIT");
  await client.query(staffRuntimeSchemaSql("public"));
  // Explicit hypothetical synthetic provenance. Not a reusable owner-preparation API.
  await client.query("BEGIN");
  await client.query("UPDATE public.users SET authorization_mode='canonical'");
  await client.query("UPDATE public.staff_authority_control SET state='prepared',pending_owner_user_id=1,conversion_digest=repeat('a',64),recovery_reference='synthetic-directory-not-owner-bootstrap' WHERE singleton");
  await client.query("UPDATE public.staff_authority_control SET state='active',owner_user_id=1,pending_owner_user_id=NULL WHERE singleton");
  await client.query("UPDATE public.staff_identity_state SET status='ready',ready_owner_subject_id=(SELECT subject_id FROM public.staff_identity_current WHERE user_id=1),ready_control_epoch=(SELECT binding_epoch FROM public.staff_authority_control) WHERE singleton");
  await client.query("COMMIT");
 } finally { client.release(); }
 bridge.pool = instrumentedPool();
});
beforeEach(async () => {
 sqlLog = []; xidObservations = []; beforeDirectory = undefined; beforeLease = undefined; released = [];
 await pool.query("UPDATE public.users SET username='directory-2',password_hash='synthetic-directory-hash',is_active=TRUE,party_id=20,permissions=$1 WHERE id=2", [JSON.stringify(doc({ "staff.view": true }))]);
 await pool.query("UPDATE public.parties SET kind='doctor',is_active=TRUE WHERE id=20");
 await pool.query("UPDATE public.users SET is_active=FALSE,party_id=21,permissions=$1 WHERE id=4", [JSON.stringify({ malformed: "target document intentionally not admission" })]);
});
afterEach(async () => { beforeDirectory = undefined; beforeLease = undefined; vi.restoreAllMocks(); await noLeakedFence(); });
afterAll(async () => { vi.unstubAllEnvs(); await fixture?.close(); });

it("returns bounded plain canonical directory including inactive/malformed-permission targets and owner, without XID allocation", async () => {
 const result = await readCanonicalStaffDirectory(await session(), { limit: 2 });
 expect(result).toEqual({ rows: [
  { id: 1, username: "directory-1", role: "admin", isActive: true, clinicianPartyId: null },
  { id: 2, username: "directory-2", role: "doctor", isActive: true, clinicianPartyId: 20 },
 ], nextAfterUserId: 2 });
 const second = await readCanonicalStaffDirectory(await session(1), { afterUserId: 2, limit: 2 });
 expect(second.rows[1]).toEqual({ id: 4, username: "directory-4", role: "reception", isActive: false, clinicianPartyId: null });
 expect(second.nextAfterUserId).toBeNull();
 expect(xidObservations).toEqual([null, null, null, null]);
 expect(sqlLog.findIndex(sql => sql.includes("pg_advisory_lock_shared"))).toBeLessThan(sqlLog.indexOf("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
 expect(sqlLog.some(sql => /FOR SHARE|pg_current_xact_id\(|SAVEPOINT|CREATE |ALTER |INSERT |UPDATE |DELETE /i.test(sql))).toBe(false);
 expect(JSON.stringify([result, second])).not.toMatch(/password|credential|permission|durableIdentity|subjectId|generationId/);
 await pool.query("UPDATE public.users SET party_id=22 WHERE id=4");
 expect((await readCanonicalStaffDirectory(await session())).rows.find(row => row.id === 4)?.clinicianPartyId).toBeNull();
});
it("does not grant directory admission through an admin presentation role", async () => {
 await expect(readCanonicalStaffDirectory(await session(3))).rejects.toThrow("CAPABILITY_DENIED");
});
it.each(["realmId", "subjectId", "generationId", "registryRevision", "controlEpoch", "accountEpoch", "permissionRevision", "credentialVersion"])("rejects signed stale %s", async key => {
 const payload = await claims();
 const value = key.endsWith("Id") ? randomUUID() : key === "permissionRevision" ? 999 : key === "credentialVersion" ? "a".repeat(43) : "999";
 await expect(readCanonicalStaffDirectory(verified({ ...payload, durableIdentity: { ...payload.durableIdentity, [key]: value } }))).rejects.toThrow(/STAFF_OPERATION_/);
});
it("rejects renamed actor, stale provider incarnation and missing provider claim", async () => {
 const payload = await claims();
 await expect(readCanonicalStaffDirectory(verified({ ...payload, username: "wrong-name" }))).rejects.toThrow("USERNAME_STALE");
 for (const provider of [null, { partyId: 21, clinicalEpoch: "1" }, { partyId: 20, clinicalEpoch: "999" }]) {
  await expect(readCanonicalStaffDirectory(verified({ ...payload, durableIdentity: { ...payload.durableIdentity, provider } }))).rejects.toThrow("PROVIDER_STALE");
 }
});
it.each([
 "UPDATE public.users SET password_hash='rotated-synthetic' WHERE id=2",
 "UPDATE public.users SET permissions=jsonb_set(permissions,'{revision}','2') WHERE id=2",
 "UPDATE public.users SET is_active=FALSE WHERE id=2",
 "UPDATE public.parties SET is_active=FALSE WHERE id=20",
 "UPDATE public.parties SET kind='supplier' WHERE id=20",
])("rejects actual post-token authority mutation: %s", async sql => {
 const old = await session();
 await pool.query(sql);
 await expect(readCanonicalStaffDirectory(old)).rejects.toThrow(/STAFF_OPERATION_/);
});
it("rejects malformed current actor permissions and schema drift without repairing schema", async () => {
 await pool.query("UPDATE public.users SET permissions=$1 WHERE id=2", [JSON.stringify({ revision: 1, malformed: true })]);
 await expect(readCanonicalStaffDirectory(await session())).rejects.toThrow("PERMISSIONS_STALE");
 await pool.query("UPDATE public.users SET permissions=$1 WHERE id=2", [JSON.stringify(doc({ "staff.view": true }))]);
 await pool.query("ALTER TABLE public.staff_identity_subjects DISABLE TRIGGER staff_identity_subjects_immutable");
 try {
  await expect(readCanonicalStaffDirectory(await session())).rejects.toThrow("SCHEMA_DRIFT");
  expect((await pool.query("SELECT tgenabled FROM pg_catalog.pg_trigger WHERE tgrelid='public.staff_identity_subjects'::regclass AND tgname='staff_identity_subjects_immutable'")).rows[0].tgenabled).toBe("D");
 } finally { await pool.query("ALTER TABLE public.staff_identity_subjects ENABLE TRIGGER staff_identity_subjects_immutable"); }
});
it("waits outside RR and rejects token after an exclusive fenced revoker commits", async () => {
 const old = await session(); const writer = await pool.connect();
 let pending: Promise<unknown> | undefined;
 try {
  await writer.query("BEGIN");
  const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [FENCE]);
  pending = readCanonicalStaffDirectory(old).then(value => value, error => error);
  await blockedBy(pid);
  expect(sqlLog).not.toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await writer.query("UPDATE public.users SET password_hash='fenced-synthetic-revocation' WHERE id=2");
  await writer.query("COMMIT");
  expect(await pending).toMatchObject({ message: "STAFF_OPERATION_CREDENTIAL_OR_ACCOUNT_STALE" });
 } finally { await writer.query("ROLLBACK"); writer.release(); await pending; }
});
it("holds the shared session fence until an admitted read finishes, then a fresh read denies revoked credentials", async () => {
 const old = await session();
 let entered!: (pid: number) => void, resume!: () => void;
 const reached = new Promise<number>(resolve => { entered = resolve; });
 const hold = new Promise<void>(resolve => { resume = resolve; });
 beforeDirectory = async client => { entered((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid); await hold; };
 const read = readCanonicalStaffDirectory(old);
 const writer = await pool.connect(); let revoke: Promise<unknown> | undefined;
 try {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readerPid: number;
  try {
   readerPid = await Promise.race([reached, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Reader did not reach protected directory query")), 3000); })]);
  } finally { if (timer) clearTimeout(timer); }
  await writer.query("BEGIN");
  const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  revoke = writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [FENCE]);
  expect(await blockedBy(readerPid)).toContain(writerPid);
  resume(); expect((await read).rows).toHaveLength(4);
  await revoke;
  await writer.query("UPDATE public.users SET password_hash='after-admitted-read' WHERE id=2");
  await writer.query("COMMIT"); beforeDirectory = undefined;
  await expect(readCanonicalStaffDirectory(old)).rejects.toThrow("CREDENTIAL_OR_ACCOUNT_STALE");
 } finally { resume(); await read.catch(() => undefined); await revoke; await writer.query("ROLLBACK"); writer.release(); }
});
it("expires after a real fence wait and releases the session fence", async () => {
 const payload = await claims(), old = verified(payload); const writer = await pool.connect();
 let pending: Promise<unknown> | undefined;
 try {
  await writer.query("BEGIN"); const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [FENCE]);
  pending = readCanonicalStaffDirectory(old).then(value => value, error => error);
  await blockedBy(pid); vi.spyOn(Date, "now").mockReturnValue(payload.expiresAt + 1);
  await writer.query("COMMIT"); expect(await pending).toMatchObject({ message: "STAFF_DIRECTORY_SESSION_INVALID_OR_EXPIRED" });
 } finally { vi.restoreAllMocks(); await writer.query("ROLLBACK"); writer.release(); await pending; }
});
it("ends a previous borrower's stale RR transaction before fencing and admitting current authority", async () => {
 const old = await session();
 beforeLease = async client => {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const previous = (await client.query("SELECT authorization_epoch::text AS epoch FROM public.users WHERE id=2")).rows[0].epoch;
  const writer = await pool.connect();
  try {
   await writer.query("BEGIN");
   await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [FENCE]);
   await writer.query("UPDATE public.users SET password_hash='committed-after-dirty-snapshot' WHERE id=2");
   await writer.query("COMMIT");
  } finally { await writer.query("ROLLBACK"); writer.release(); }
  // Negative control: this abandoned transaction really still sees old authority.
  expect((await client.query("SELECT authorization_epoch::text AS epoch FROM public.users WHERE id=2")).rows[0].epoch).toBe(previous);
  expect((await pool.query("SELECT authorization_epoch::text AS epoch FROM public.users WHERE id=2")).rows[0].epoch).not.toBe(previous);
 };
 await expect(readCanonicalStaffDirectory(old)).rejects.toThrow("CREDENTIAL_OR_ACCOUNT_STALE");
 expect(sqlLog[0]).toBe("ROLLBACK");
 expect(sqlLog.indexOf("ROLLBACK")).toBeLessThan(sqlLog.findIndex(sql => sql.includes("pg_advisory_lock_shared")));
 expect(sqlLog.some(sql => sql.includes("FROM public.users u JOIN public.staff_identity_current"))).toBe(false);
 expect(released).toEqual([undefined]);
});
it("discards a lease carrying a leaked session advisory lock without unlocking another borrower's lock", async () => {
 let dirtyPid: number | undefined;
 beforeLease = async client => {
  dirtyPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await client.query("SELECT pg_advisory_lock_shared(hashtextextended($1,0))", [FENCE]);
 };
 await expect(readCanonicalStaffDirectory(await session())).rejects.toThrow("DIRTY_CONNECTION");
 expect(released).toEqual([true]);
 expect(sqlLog.some(sql => sql.includes("pg_advisory_lock_shared") || sql.includes("pg_advisory_unlock"))).toBe(false);
 expect(sqlLog).not.toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
 const deadline = performance.now() + 3000;
 let gone = false;
 while (performance.now() < deadline) {
  const { rows } = await pool.query("SELECT pid FROM pg_catalog.pg_locks WHERE pid=$1 AND locktype='advisory'", [dirtyPid]);
  if (rows.length === 0) { gone = true; break; }
  await new Promise(resolve => setTimeout(resolve, 10));
 }
 expect(gone).toBe(true);
});
it("shared proof extraction preserves writer XID, transaction fence, FOR SHARE and fresh precommit refusal", async () => {
 const recorded: string[] = [];
 const recording: DbPool = {
  query: ((sql: string, values?: unknown[]) => pool.query(sql, values)) as DbPool["query"],
  connect: async () => {
   const client = await pool.connect();
   return { query: ((sql: string, values?: unknown[]) => { recorded.push(sql); return client.query(sql, values); }) as DbClient["query"], release: destroy => client.release(destroy) };
  },
 };
 await withStaffOperation(recording, await session(), "staff.view", async client => {
  expect((await client.query("SELECT pg_current_xact_id_if_assigned()::text AS xid")).rows[0].xid).toMatch(/^[0-9]+$/);
 });
 expect(recorded.some(sql => sql.includes("pg_current_xact_id()"))).toBe(true);
 const fence = recorded.findIndex(sql => sql.includes("pg_advisory_xact_lock_shared"));
 const control = recorded.findIndex(sql => sql.includes("FROM public.staff_authority_control WHERE singleton FOR SHARE"));
 expect(fence).toBeGreaterThan(-1); expect(control).toBeGreaterThan(fence);
 expect(recorded.filter(sql => sql.includes("FROM public.users WHERE") && sql.includes("FOR SHARE")).length).toBeGreaterThanOrEqual(2);
 await expect(withStaffOperation(recording, await session(), "staff.view", async client => {
  await client.query("UPDATE public.users SET password_hash='must-rollback-writer-extraction' WHERE id=2");
 })).rejects.toThrow("CREDENTIAL_OR_ACCOUNT_STALE");
 expect((await pool.query("SELECT password_hash FROM public.users WHERE id=2")).rows[0].password_hash).toBe("synthetic-directory-hash");
});
