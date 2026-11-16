import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DbPool } from "../lib/db";
import { assertStaffOperation, withStaffOperation, type StaffOperationHandle } from "../lib/staff-operation-runtime";
import { STAFF_AUTHORIZATION_POLICY_VERSION } from "../lib/staff-capability-catalogue";
import { sessionCredentialVersion } from "../lib/auth";
import { readVerifiedDurableSession, type VerifiedDurableSession } from "../lib/staff-durable-session";
import { readCanonicalStaffDirectory } from "../lib/canonical-staff-directory";

const db = vi.hoisted(() => ({ connect: vi.fn(), factory: vi.fn(), shared: false, probe: vi.fn() }));
vi.mock("../lib/db", () => ({ getPool: () => { db.factory(); return { connect: db.connect }; }, usesSharedLocalDatabaseConnection: () => db.shared }));
vi.mock("../lib/staff-runtime-probe.mjs", () => ({ inspectStaffRuntimeSchema: db.probe }));
const secret = "synthetic-directory-unit-secret-at-least-32-characters";
const realm = "11111111-1111-4111-8111-111111111111";
const generation = "22222222-2222-4222-8222-222222222222";
const ownerSubject = "33333333-3333-4333-8333-333333333333";
const actorSubject = "44444444-4444-4444-8444-444444444444";
const document = (grants: Record<string, boolean> = { "staff.view": true }) => ({ schemaVersion: 2, confirmation: "owner", revision: 1, patientScope: "none", appointmentScope: "none", grants });
const claims = () => ({ userId: 2, username: "synthetic-actor", expiresAt: Date.now() + 60_000, durableIdentity: { schemaVersion: 2, policyVersion: STAFF_AUTHORIZATION_POLICY_VERSION, realmId: realm, subjectId: actorSubject, generationId: generation, registryRevision: "3", controlEpoch: "2", accountEpoch: "1", permissionRevision: 1, credentialVersion: sessionCredentialVersion("synthetic-hash"), provider: null as null | { partyId: number; clinicalEpoch: string } } });
function session(payload = claims()) {
 const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
 const handle = readVerifiedDurableSession(`${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`);
 if (!handle) throw new Error("invalid synthetic token");
 return handle;
}
function fixture() {
 const state = {
  control: { state: "active", realm_id: realm, owner_user_id: 1, binding_epoch: "2" },
  identity: { status: "ready", realm_id: realm, generation_id: generation, registry_revision: "3", ready_owner_subject_id: ownerSubject, ready_control_epoch: "2" },
  integrity: true,
  owner: { id: 1, username: "synthetic-owner", role: "admin", is_active: true, authorization_mode: "canonical", authorization_epoch: "1", password_hash: "synthetic-owner-hash", permissions: document({}), party_id: null as number | null },
  actor: { id: 2, username: "synthetic-actor", role: "reception", is_active: true, authorization_mode: "canonical", authorization_epoch: "1", password_hash: "synthetic-hash", permissions: document(), party_id: null as number | null },
  bindings: [{ user_id: 1, subject_id: ownerSubject }, { user_id: 2, subject_id: actorSubject }],
  provider: { id: 20, kind: "doctor", is_active: true, clinical_authority_epoch: "1" },
  directory: [{ id: 1, username: "synthetic-owner", role: "admin", is_active: true, clinician_party_id: null as number | null }, { id: 2, username: "synthetic-actor", role: "reception", is_active: true, clinician_party_id: null as number | null }],
  virtualId: "7/100", isolation: "repeatable read", readOnly: "on", inRecovery: false as boolean | undefined, advisoryLocks: 0 as unknown, unlocked: true,
  hook: undefined as undefined | ((sql: string, values: unknown[] | undefined) => Promise<unknown> | unknown),
 };
 const sqls: string[] = [];
 const release = vi.fn();
 const query = vi.fn(async (sql: string, values?: unknown[]) => {
  sqls.push(sql);
  const override = await state.hook?.(sql, values);
  if (override !== undefined) return override;
  if (sql.includes("pg_advisory_unlock_shared")) return { rows: [{ unlocked: state.unlocked }] };
  if (sql.includes("AS advisory_locks")) return { rows: [{ advisory_locks: state.advisoryLocks }] };
  if (sql.includes("pg_locks")) return { rows: [{ virtualxid: state.virtualId, virtual_xid: state.virtualId, identity: state.virtualId, isolation: state.isolation, read_only: state.readOnly, readonly: state.readOnly, in_recovery: state.inRecovery }] };
  if (sql.includes("pg_current_xact_id()")) return { rows: [{ xid: "100", isolation: "read committed" }] };
  if (sql.includes("FROM public.staff_authority_control")) return { rows: [state.control] };
  if (sql.includes("FROM public.staff_identity_state")) return { rows: [state.identity] };
  if (sql.includes("WITH RECURSIVE chain")) return { rows: [{ valid: state.integrity }] };
  if (sql.includes("FROM public.users WHERE id=ANY")) return { rows: [state.owner, state.actor] };
  if (sql.includes("FROM public.staff_identity_current WHERE user_id=ANY")) return { rows: state.bindings };
  if (sql.includes("FROM public.parties WHERE id=$1")) return { rows: [state.provider] };
  if (/FROM public\.users\s+u\b/.test(sql)) return { rows: state.directory };
  if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)/.test(sql) || (sql.includes("pg_advisory_lock_shared") || sql.includes("pg_advisory_xact_lock_shared"))) return { rows: [] };
  throw new Error(`Unhandled synthetic query: ${sql}`);
 });
 db.connect.mockResolvedValue({ query, release });
 return { state, sqls, query, release };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => {
 vi.stubEnv("SESSION_SECRET", secret);
 db.factory.mockReset(); db.connect.mockReset(); db.probe.mockReset().mockResolvedValue({ version: 2, schema: "public", fingerprint: "synthetic" }); db.shared = false;
 f = fixture();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("admits exact signed staff.view and returns bounded display data after commit and confirmed unlock", async () => {
 const result = await readCanonicalStaffDirectory(session());
 expect(result).toBeDefined();
 expect(JSON.stringify(result)).toContain("synthetic-owner");
 expect(JSON.stringify(result)).not.toMatch(/password|hash|credential|permission|token|subject|epoch|realm/i);
 expect(f.sqls.findIndex(s => s.includes("pg_advisory_lock_shared"))).toBeLessThan(f.sqls.findIndex(s => s.startsWith("BEGIN")));
 expect(f.sqls.some(s => s === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")).toBe(true);
 expect(f.sqls.join("\n")).not.toMatch(/FOR SHARE|pg_current_xact_id\(|ensureSchema|CREATE |INSERT |UPDATE |DELETE |SAVEPOINT/i);
 expect(f.sqls.findIndex(s => s === "COMMIT")).toBeLessThan(f.sqls.findIndex(s => s.includes("pg_advisory_unlock_shared")));
 expect(f.release).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledWith();
});

it.each([
 ["control state", () => { f.state.control.state = "prepared"; }],
 ["control realm", () => { f.state.control.realm_id = ownerSubject; }],
 ["control epoch", () => { f.state.control.binding_epoch = "9"; }],
 ["quarantine", () => { f.state.identity.status = "quarantined"; }],
 ["generation", () => { f.state.identity.generation_id = ownerSubject; }],
 ["registry", () => { f.state.identity.registry_revision = "8"; }],
 ["ready control", () => { f.state.identity.ready_control_epoch = "9"; }],
 ["history", () => { f.state.integrity = false; }],
 ["inactive owner", () => { f.state.owner.is_active = false; }],
 ["noncanonical owner", () => { f.state.owner.authorization_mode = "legacy"; }],
 ["owner role", () => { f.state.owner.role = "reception"; }],
 ["ready owner subject", () => { f.state.identity.ready_owner_subject_id = actorSubject; }],
 ["inactive actor", () => { f.state.actor.is_active = false; }],
 ["noncanonical actor", () => { f.state.actor.authorization_mode = "legacy"; }],
 ["actor incarnation", () => { f.state.bindings[1].subject_id = ownerSubject; }],
 ["renamed actor", () => { f.state.actor.username = "renamed"; }],
 ["credential", () => { f.state.actor.password_hash = "rotated"; }],
 ["account epoch", () => { f.state.actor.authorization_epoch = "9"; }],
 ["permission revision", () => { f.state.actor.permissions.revision = 2; }],
 ["malformed permissions", () => { f.state.actor.permissions = { ...document(), schemaVersion: 9 }; }],
 ["missing grant", () => { f.state.actor.permissions = document({}); }],
 ["admin role not a grant", () => { f.state.actor.role = "admin"; f.state.actor.permissions = document({}); }],
] as const)("refuses %s before directory SQL", async (_label, mutate) => {
 mutate(); await expect(readCanonicalStaffDirectory(session())).rejects.toThrow(/^STAFF_OPERATION_/);
 expect(f.sqls.some(s => /FROM public\.users\s+u\b/.test(s))).toBe(false);
 expect(f.sqls).not.toContain("COMMIT"); expect(f.sqls).toContain("ROLLBACK");
});

it("refuses copied handles and arbitrary session JSON before borrowing", async () => {
 await expect(readCanonicalStaffDirectory({ ...session() })).rejects.toThrow();
 await expect(readCanonicalStaffDirectory(claims() as unknown as VerifiedDurableSession)).rejects.toThrow();
 expect(db.connect).not.toHaveBeenCalled();
});
it("refuses shared local connections without using them", async () => {
 db.shared = true; await expect(readCanonicalStaffDirectory(session())).rejects.toThrow();
 expect(f.query).not.toHaveBeenCalled();
});
it("schema drift denies without invoking a repair/bootstrap path", async () => {
 db.probe.mockRejectedValue(new Error("STAFF_RUNTIME_SCHEMA_DRIFT"));
 await expect(readCanonicalStaffDirectory(session())).rejects.toThrow();
 expect(f.sqls.some(s => /FROM public\.users\s+u\b/.test(s))).toBe(false);
});
it.each(["inactive", "kind", "incarnation", "missing claims"])("refuses linked provider %s mismatch", async kind => {
 const p = claims(); p.durableIdentity.provider = { partyId: 20, clinicalEpoch: "1" }; f.state.actor.party_id = 20;
 if (kind === "inactive") f.state.provider.is_active = false;
 if (kind === "kind") f.state.provider.kind = "supplier";
 if (kind === "incarnation") f.state.provider.clinical_authority_epoch = "2";
 if (kind === "missing claims") p.durableIdentity.provider = null;
 await expect(readCanonicalStaffDirectory(session(p))).rejects.toThrow();
});
it("rejects claimed provider when current link is absent", async () => {
 const p = claims(); p.durableIdentity.provider = { partyId: 20, clinicalEpoch: "1" };
 await expect(readCanonicalStaffDirectory(session(p))).rejects.toThrow();
});
it("admits matching active doctor while directory provider labels remain display-only", async () => {
 const p = claims(); p.durableIdentity.provider = { partyId: 20, clinicalEpoch: "1" }; f.state.actor.party_id = 20;
 await expect(readCanonicalStaffDirectory(session(p))).resolves.toBeDefined();
 const sql = f.sqls.find(s => /FROM public\.users\s+u\b/.test(s))!;
 expect(sql).toMatch(/LEFT JOIN public\.parties/); expect(sql).toMatch(/kind\s*=\s*'doctor'/); expect(sql).toMatch(/is_active/);
});
it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.1 }, { afterUserId: -1 }, { afterUserId: 0.1 }, { afterUserId: Number.MAX_SAFE_INTEGER + 1 }, { limit: NaN }, { action: "staff.permissions.edit" }])("rejects malformed pagination %j", async page => {
 await expect(readCanonicalStaffDirectory(session(), page)).rejects.toThrow();
 expect(db.connect).not.toHaveBeenCalled();
});
it.each(["isolation", "readonly", "missing", "ambiguous", "changed"])("refuses %s transaction identity and discards uncertain ownership", async kind => {
 let probes = 0;
 f.state.hook = sql => {
  if (!sql.includes("pg_locks") || sql.includes("AS advisory_locks")) return;
  probes++;
  if (kind === "missing") return { rows: [] };
  if (kind === "ambiguous") return { rows: [{ virtualxid: "1/1" }, { virtualxid: "1/2" }] };
  if (kind === "isolation") f.state.isolation = "read committed";
  if (kind === "readonly") f.state.readOnly = "off";
  if (kind === "changed" && probes > 1) f.state.virtualId = "7/101";
 };
 await expect(readCanonicalStaffDirectory(session())).rejects.toThrow();
 expect(f.release).toHaveBeenCalledWith(true);
});
it.each(["COMMIT", "ROLLBACK", "unlock", "false unlock", "fence"])("does not publish when %s fails", async point => {
 let rollbacks = 0;
 f.state.hook = sql => {
  if (sql === "ROLLBACK") rollbacks++;
  if ((point === "COMMIT" && sql === "COMMIT") || (point === "ROLLBACK" && sql === "ROLLBACK" && rollbacks > 1) || (point === "unlock" && sql.includes("pg_advisory_unlock_shared")) || (point === "fence" && sql.includes("pg_advisory_lock_shared"))) throw new Error("sensitive-driver-details");
 };
 if (point === "ROLLBACK") f.state.integrity = false;
 if (point === "false unlock") f.state.unlocked = false;
 await expect(readCanonicalStaffDirectory(session())).rejects.toThrow();
 expect(f.release).toHaveBeenCalledWith(true);
});
it.each(["fence", "admission", "directory", "commit", "unlock"])("rechecks expiry at %s and never returns data", async stage => {
 const p = claims(); const verified = session(p);
 f.state.hook = sql => {
  const match = stage === "fence" ? sql.includes("pg_advisory_lock_shared") : stage === "admission" ? sql.includes("WITH RECURSIVE chain") : stage === "directory" ? /FROM public\.users\s+u\b/.test(sql) : stage === "commit" ? sql === "COMMIT" : sql.includes("pg_advisory_unlock_shared");
  if (match) vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
 };
 await expect(readCanonicalStaffDirectory(verified)).rejects.toThrow(/SESSION/);
});
it("returns an exact frozen plain display projection, including inactive and malformed-permission targets", async () => {
 f.state.directory[1].is_active = false;
 Object.assign(f.state.directory[1], { password_hash: "must-not-escape", permissions: { malformed: true }, token: "must-not-escape", subject_id: actorSubject });
 const result = await readCanonicalStaffDirectory(session());
 expect(result).toEqual({ rows: [
  { id: 1, username: "synthetic-owner", role: "admin", isActive: true, clinicianPartyId: null },
  { id: 2, username: "synthetic-actor", role: "reception", isActive: false, clinicianPartyId: null },
 ], nextAfterUserId: null });
 expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.rows)).toBe(true); expect(Object.isFrozen(result.rows[0])).toBe(true);
 const sql = f.sqls.find(s => /FROM public\.users\s+u\b/.test(s))!;
 expect(sql).toMatch(/JOIN public\.staff_identity_current/);
 expect(sql).toMatch(/u.authorization_mode='canonical'/);
 expect(sql).not.toMatch(/u\.is_active\s*=|u\.permissions|u\.password_hash/);
});
it("keyset limit fetches one sentinel but publishes at most 100 rows", async () => {
 f.state.directory = Array.from({ length: 101 }, (_, i) => ({ id: i + 11, username: `synthetic-${i}`, role: "reception", is_active: true, clinician_party_id: null }));
 const result = await readCanonicalStaffDirectory(session(), { afterUserId: 10, limit: 100 });
 expect(result.rows).toHaveLength(100); expect(result.nextAfterUserId).toBe(110);
 const call = f.query.mock.calls.find(([sql]) => /FROM public\.users\s+u\b/.test(sql))!;
 expect(call[1]).toEqual([10, 101]);
});
it.each(["duplicate", "unordered", "oversized username", "oversized role", "null username", "bad active", "bad provider", "extra rows"])("rejects malformed or unbounded directory result: %s", async kind => {
 if (kind === "duplicate") f.state.directory[1].id = 1;
 if (kind === "unordered") f.state.directory.reverse();
 if (kind === "oversized username") f.state.directory[0].username = "x".repeat(201);
 if (kind === "oversized role") f.state.directory[0].role = "x".repeat(65);
 if (kind === "null username") Object.assign(f.state.directory[0], { username: null });
 if (kind === "bad active") Object.assign(f.state.directory[0], { is_active: "true" });
 if (kind === "bad provider") f.state.directory[0].clinician_party_id = -1;
 if (kind === "extra rows") f.state.directory = Array.from({ length: 52 }, (_, i) => ({ id: i + 1, username: `synthetic-${i}`, role: "reception", is_active: true, clinician_party_id: null }));
 await expect(readCanonicalStaffDirectory(session())).rejects.toThrow("RESULT_BOUNDS");
 expect(f.sqls).not.toContain("COMMIT");
});
it("does not invoke a pagination getter or accept symbols/prototype objects", async () => {
 const getter = vi.fn(() => 5);
 const pages = [Object.defineProperty({}, "limit", { get: getter }), { [Symbol("hidden")]: 1 }, Object.create({ limit: 5 })];
 for (const page of pages) await expect(readCanonicalStaffDirectory(session(), page)).rejects.toThrow("PAGE_INVALID");
 expect(getter).not.toHaveBeenCalled(); expect(db.connect).not.toHaveBeenCalled();
});
it("bounds pool acquisition and destroys a lease that arrives after timeout", async () => {
 vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
 let deliver!: (client: { query: typeof f.query; release: typeof f.release }) => void;
 db.connect.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
 const outcome = readCanonicalStaffDirectory(session()).catch(error => error);
 await vi.advanceTimersByTimeAsync(5_001);
 expect(await outcome).toMatchObject({ message: "STAFF_DIRECTORY_DEADLINE" });
 deliver({ query: f.query, release: f.release });
 await Promise.resolve(); await Promise.resolve();
 expect(f.release).toHaveBeenCalledExactlyOnceWith(true); expect(f.query).not.toHaveBeenCalled();
});
it.each(["fence", "admission", "directory", "unlock"])("times out an unresolved %s query, discards once and queues no cleanup", async stage => {
 vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
 f.state.hook = sql => {
  const matches = stage === "fence" ? sql.includes("pg_advisory_lock_shared") : stage === "admission" ? sql.includes("WITH RECURSIVE chain") : stage === "directory" ? /FROM public\.users\s+u\b/.test(sql) : sql.includes("pg_advisory_unlock_shared");
  if (matches) return new Promise(() => {});
 };
 const outcome = readCanonicalStaffDirectory(session()).catch(error => error);
 await vi.advanceTimersByTimeAsync(5_001);
 expect(await outcome).toMatchObject({ message: "STAFF_DIRECTORY_DEADLINE" });
 expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
 expect(f.sqls.filter(sql => sql === "ROLLBACK")).toHaveLength(1);
 if (stage !== "unlock") expect(f.sqls.some(s => s.includes("pg_advisory_unlock_shared"))).toBe(false);
});
it("sanitizes driver failures and disposes a dropped connection", async () => {
 let dropped = false;
 f.state.hook = sql => {
  if (/FROM public\.users\s+u\b/.test(sql)) dropped = true;
  if (dropped) throw new Error("password=do-not-echo database=private");
 };
 await expect(readCanonicalStaffDirectory(session())).rejects.toThrow("STAFF_DIRECTORY_READ_FAILED");
 expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
});
it("sequential pool reuse reacquires and releases exactly one fence for each read", async () => {
 await readCanonicalStaffDirectory(session());
 await readCanonicalStaffDirectory(session());
 expect(f.sqls.filter(s => s.includes("pg_advisory_lock_shared"))).toHaveLength(2);
 expect(f.sqls.filter(s => s.includes("pg_advisory_unlock_shared"))).toHaveLength(2);
 expect(f.sqls.filter(s => s === "COMMIT")).toHaveLength(2);
 expect(f.release).toHaveBeenCalledTimes(2);
});
it("bounds serialized bytes as well as row count and raw field sizes", async () => {
 f.state.directory = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, username: "\u0001".repeat(200), role: "\u0001".repeat(64), is_active: true, clinician_party_id: null }));
 await expect(readCanonicalStaffDirectory(session(), { limit: 100 })).rejects.toThrow("RESULT_BOUNDS");
 expect(f.sqls).not.toContain("COMMIT");
});
it.each([{ limit: null }, { afterUserId: null }, { limit: undefined }, { afterUserId: undefined }])("rejects explicitly invalid optional fields %j", async page => {
 await expect(readCanonicalStaffDirectory(session(), page as never)).rejects.toThrow("PAGE_INVALID");
 expect(db.connect).not.toHaveBeenCalled();
});
it.each(["replica", "unknown", "became replica"])("requires proved primary on each identity check: %s", async state => {
 let probes = 0;
 f.state.hook = sql => {
  if (!sql.includes("pg_locks") || sql.includes("AS advisory_locks")) return;
  probes++;
  if (state === "replica" || (state === "became replica" && probes > 1)) f.state.inRecovery = true;
  if (state === "unknown") f.state.inRecovery = undefined;
 };
 await expect(readCanonicalStaffDirectory(session())).rejects.toThrow("TRANSACTION_CHANGED");
 expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
 expect(f.sqls).not.toContain("COMMIT");
});
it("backward wall clock cannot extend the initially admitted token lifetime", async () => {
 const start = Date.now();
 const p = { ...claims(), expiresAt: start + 500 };
 const verified = session(p);
 const monotonic = vi.spyOn(performance, "now").mockReturnValue(1_000);
 vi.spyOn(Date, "now").mockReturnValue(start);
 f.state.hook = sql => {
  if (/FROM public\.users\s+u\b/.test(sql)) {
   monotonic.mockReturnValue(1_501);
   vi.spyOn(Date, "now").mockReturnValue(start - 60_000);
  }
 };
 await expect(readCanonicalStaffDirectory(verified)).rejects.toThrow("SESSION_INVALID_OR_EXPIRED");
 expect(f.sqls).not.toContain("COMMIT"); expect(f.sqls).toContain("ROLLBACK");
});
it("writer extraction preserves XID then shared xact fence then ordered FOR SHARE authority and private handles", async () => {
 const pool = { connect: db.connect, query: f.query } as unknown as DbPool;
 let escaped: StaffOperationHandle | undefined;
 let borrowed: Parameters<typeof assertStaffOperation>[0] | undefined;
 await withStaffOperation(pool, session(), "staff.view", async (client, handle) => {
  escaped = handle; borrowed = client;
  await expect(assertStaffOperation(client, { ...handle }, "staff.view")).rejects.toThrow("HANDLE_INVALID");
  await expect(assertStaffOperation(client, handle, "staff.permissions.edit")).rejects.toThrow("HANDLE_INVALID");
  await assertStaffOperation(client, handle, "staff.view");
 });
 expect(f.sqls[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
 const xid = f.sqls.findIndex(sql => sql.includes("pg_current_xact_id()"));
 const fence = f.sqls.findIndex(sql => sql.includes("pg_advisory_xact_lock_shared"));
 const control = f.sqls.findIndex(sql => sql.includes("FROM public.staff_authority_control"));
 const identity = f.sqls.findIndex(sql => sql.includes("FROM public.staff_identity_state"));
 const users = f.sqls.findIndex(sql => sql.includes("FROM public.users WHERE id=ANY"));
 const bindings = f.sqls.findIndex(sql => sql.includes("FROM public.staff_identity_current WHERE user_id=ANY"));
 expect(xid).toBeLessThan(fence); expect(fence).toBeLessThan(control); expect(control).toBeLessThan(identity); expect(identity).toBeLessThan(users); expect(users).toBeLessThan(bindings);
 for (const index of [control, identity, users, bindings]) expect(f.sqls[index]).toMatch(/FOR SHARE$/);
 expect(f.sqls.filter(sql => sql.includes("FROM public.staff_authority_control"))).toHaveLength(3);
 expect(f.sqls.filter(sql => sql.includes("pg_advisory_xact_lock_shared"))).toHaveLength(3);
 expect(f.sqls).toContain("COMMIT");
 await expect(assertStaffOperation(borrowed!, escaped!, "staff.view")).rejects.toThrow("HANDLE_INVALID");
});
it("writer now refuses expiration immediately after shared fence wait, before catalogue/authority work", async () => {
 const p = claims(); const verified = session(p);
 const work = vi.fn();
 f.state.hook = sql => {
  if (sql.includes("pg_advisory_xact_lock_shared")) vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
 };
 const pool = { connect: db.connect, query: f.query } as unknown as DbPool;
 await expect(withStaffOperation(pool, verified, "staff.view", work)).rejects.toThrow("STAFF_OPERATION_SESSION_OR_ACTION_INVALID");
 expect(work).not.toHaveBeenCalled(); expect(db.probe).not.toHaveBeenCalled();
 expect(f.sqls.some(sql => sql.includes("FROM public.staff_authority_control"))).toBe(false);
 expect(f.sqls).toContain("ROLLBACK"); expect(f.sqls).not.toContain("COMMIT");
});
it("writer still freshly validates authority after callback rather than trusting snapshot evidence", async () => {
 const pool = { connect: db.connect, query: f.query } as unknown as DbPool;
 await expect(withStaffOperation(pool, session(), "staff.view", async () => {
  f.state.actor.authorization_epoch = "2";
 })).rejects.toThrow("CREDENTIAL_OR_ACCOUNT_STALE");
 expect(f.sqls).toContain("ROLLBACK"); expect(f.sqls).not.toContain("COMMIT");
});
it("enforces the aggregate ten-second budget across individually short queries", async () => {
 let elapsed = 1_000;
 const monotonic = vi.spyOn(performance, "now").mockReturnValue(elapsed);
 f.state.hook = () => { elapsed += 1_500; monotonic.mockReturnValue(elapsed); };
 await expect(readCanonicalStaffDirectory(session())).rejects.toThrow("DEADLINE");
 expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
 expect(f.sqls).not.toContain("COMMIT");
 expect(f.query.mock.calls.length).toBeLessThanOrEqual(7);
});
it("suppresses buffered result when the final normal release throws", async () => {
 f.release.mockImplementation(() => { throw new Error("sensitive release internals"); });
 await expect(readCanonicalStaffDirectory(session())).rejects.toThrow("STAFF_DIRECTORY_READ_FAILED");
 expect(f.sqls).toContain("COMMIT"); expect(f.sqls.some(sql => sql.includes("pg_advisory_unlock_shared"))).toBe(true);
 expect(f.release).toHaveBeenCalledTimes(1);
});
it.each(["held lock", "missing count", "string count", "negative count", "multiple rows"])("discards unproved clean lease: %s", async kind => {
 if (kind === "held lock") f.state.advisoryLocks = 1;
 if (kind === "string count") f.state.advisoryLocks = "0";
 if (kind === "negative count") f.state.advisoryLocks = -1;
 f.state.hook = sql => {
  if (!sql.includes("AS advisory_locks")) return;
  if (kind === "missing count") return { rows: [] };
  if (kind === "multiple rows") return { rows: [{ advisory_locks: 0 }, { advisory_locks: 0 }] };
 };
 await expect(readCanonicalStaffDirectory(session())).rejects.toThrow("DIRTY_CONNECTION");
 expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
 expect(f.sqls).not.toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
 expect(f.sqls.some(sql => sql.includes("pg_advisory_lock_shared") || sql.includes("pg_advisory_unlock_shared"))).toBe(false);
});
it("ends prior transaction and proves no advisory locks before taking its own fence", async () => {
 await readCanonicalStaffDirectory(session());
 expect(f.sqls[0]).toBe("ROLLBACK"); expect(f.sqls[1]).toContain("AS advisory_locks");
 expect(f.sqls[2]).toContain("pg_advisory_lock_shared"); expect(f.sqls[3]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
});
it("discards if initial lease cleanup rollback fails without attempting a fence", async () => {
 f.state.hook = sql => { if (sql === "ROLLBACK") throw new Error("initial rollback failed"); };
 await expect(readCanonicalStaffDirectory(session())).rejects.toThrow("READ_FAILED");
 expect(f.release).toHaveBeenCalledExactlyOnceWith(true); expect(f.sqls).toEqual(["ROLLBACK"]);
});
it("destroys an acquired but not-yet-proved-clean lease if session expired during acquisition", async () => {
 const p = claims(); const verified = session(p);
 db.connect.mockImplementation(async () => {
  vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
  return { query: f.query, release: f.release };
 });
 await expect(readCanonicalStaffDirectory(verified)).rejects.toThrow("SESSION_INVALID_OR_EXPIRED");
 expect(f.release).toHaveBeenCalledExactlyOnceWith(true); expect(f.query).not.toHaveBeenCalled();
});

it("refuses explicit local mode before pool construction or queries", async () => {
 vi.stubEnv("USE_LOCAL_DB", "true");
 await expect(readCanonicalStaffDirectory(session())).rejects.toThrow("EXCLUSIVE_CONNECTION_REQUIRED");
 expect(db.factory).not.toHaveBeenCalled(); expect(db.connect).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
});
it("refuses already-shared local connection before pool construction", async () => {
 db.shared = true;
 await expect(readCanonicalStaffDirectory(session())).rejects.toThrow("EXCLUSIVE_CONNECTION_REQUIRED");
 expect(db.factory).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
});
