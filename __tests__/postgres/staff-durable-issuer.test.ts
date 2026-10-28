/** Synthetic trusted-ready issuance evidence ONLY (OWNER_READINESS_AND_ISSUANCE.md §5).
 * Proves the private issuer's behaviour on real PostgreSQL; no owner provenance,
 * activation or live credential operation is implied. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { assertRealPostgresUrl } from "./_setup";
import { readSignedSessionEnvelope } from "../../lib/auth";
import { readVerifiedDurableSession, revalidateVerifiedDurableSession } from "../../lib/staff-durable-session";
import { withStaffOperation, assertStaffOperation } from "../../lib/staff-operation-runtime";
import { issueDurableStaffSessionIn } from "../../lib/staff-durable-issuer";
import { legacyStaffAccountKey, accountLimitKey } from "../../lib/loginLimit";
import { dropSyntheticSchema, installSyntheticCanonicalFixture, syntheticClaims, syntheticPool, syntheticSchemaName, waitForBlockedBy, type SyntheticAccount } from "./_canonical-ready-fixture";
assertRealPostgresUrl();

const accounts: SyntheticAccount[] = [
 { id: 1, username: "synthetic-owner", role: "admin", password: "owner-pass-1", displayName: "مالك تجريبي" },
 { id: 2, username: "synthetic-doctor", role: "doctor", password: "doctor-pass-2", partyId: 20, grants: { "staff.view": true } },
 { id: 3, username: "synthetic-reception", role: "reception", password: "reception-pass-3" },
 { id: 4, username: "Synthetic-Twin", role: "reception", password: "twin-pass-4" },
 { id: 5, username: "synthetic-twin", role: "reception", password: "twin-pass-4" },
 { id: 6, username: "synthetic-inactive", role: "reception", password: "inactive-pass-6", active: false },
];
const schema = syntheticSchemaName();
const pool = syntheticPool(schema);
const headers = () => new Headers();
const issue = (username: string, password: string) => issueDurableStaffSessionIn(pool, schema, { username, password, headers: headers() });
async function resetLimits() { await pool.query(`DELETE FROM ${schema}.login_limits; DELETE FROM ${schema}.staff_login_limits`); }
async function auditCount() { return Number((await pool.query(`SELECT count(*) FROM ${schema}.audit_log WHERE action='auth.canonical_login'`)).rows[0].count); }

beforeAll(async () => {
 await installSyntheticCanonicalFixture(pool, schema, { ownerId: 1, accounts, doctorParties: [20] });
});
beforeEach(async () => { vi.restoreAllMocks(); await resetLimits(); });
afterAll(async () => { vi.restoreAllMocks(); await dropSyntheticSchema(pool, schema); await pool.end(); });

it("issues an exact durable token from the proved current tuple, audited atomically", async () => {
 const before = await auditCount();
 const outcome = await issue("SYNTHETIC-DOCTOR", "doctor-pass-2");
 expect(outcome.kind).toBe("issued");
 if (outcome.kind !== "issued") return;
 expect(outcome.display).toEqual({ username: "synthetic-doctor", displayName: "synthetic-doctor", role: "doctor" });
 expect(outcome.maxAgeSeconds).toBeGreaterThan(60);
 const envelope = readSignedSessionEnvelope(outcome.token) as Record<string, unknown>;
 expect(Object.keys(envelope).sort()).toEqual(["durableIdentity", "expiresAt", "userId", "username"]);
 expect(envelope).not.toHaveProperty("role");
 const handle = readVerifiedDurableSession(outcome.token);
 const claims = revalidateVerifiedDurableSession(handle!);
 const current = await syntheticClaims(pool, schema, 2);
 expect(claims!.durableIdentity).toEqual(current.durableIdentity);
 expect(claims!.username).toBe("synthetic-doctor");
 // The issued token is admissible by the operation runtime for an exact granted action only.
 await withStaffOperation(pool, handle!, "staff.view", async (c, h) => { await assertStaffOperation(c, h, "staff.view"); }, schema);
 await expect(withStaffOperation(pool, handle!, "staff.permissions.edit", async () => { throw new Error("must not run"); }, schema)).rejects.toThrow("CAPABILITY_DENIED");
 expect(await auditCount()).toBe(before + 1);
 const { rows: [audit] } = await pool.query(`SELECT actor, actor_role, entity_id, details FROM ${schema}.audit_log WHERE action='auth.canonical_login' ORDER BY id DESC LIMIT 1`);
 expect(audit).toMatchObject({ actor: "synthetic-doctor", actor_role: "doctor", entity_id: "2" });
 expect(JSON.stringify(audit.details)).not.toMatch(/scrypt|password|token/i);
});

it("protected owner entry needs no invented grant and projects the stored display name", async () => {
 const outcome = await issue("synthetic-owner", "owner-pass-1");
 expect(outcome).toMatchObject({ kind: "issued", display: { username: "synthetic-owner", displayName: "مالك تجريبي", role: "admin" } });
});

it.each([
 ["wrong password", "synthetic-doctor", "wrong"],
 ["missing account", "synthetic-nobody", "doctor-pass-2"],
 ["inactive account", "synthetic-inactive", "inactive-pass-6"],
 ["ambiguous case-insensitive username", "synthetic-twin", "twin-pass-4"],
 ["over-long password", "synthetic-doctor", "x".repeat(2000)],
])("%s issues nothing and is not audited", async (_label, username, password) => {
 const before = await auditCount();
 expect(await issue(username, password)).toEqual({ kind: "invalid_credentials" });
 expect(await auditCount()).toBe(before);
});

it("both persistent limit layers apply before verification; success clears account counters only", async () => {
 for (let n = 0; n < 5; n += 1) expect(await issue("synthetic-reception", "wrong")).toEqual({ kind: "invalid_credentials" });
 const limited = await issue("synthetic-reception", "reception-pass-3");
 expect(limited.kind).toBe("rate_limited");
 if (limited.kind === "rate_limited") expect(limited.retryAfterSeconds).toBeGreaterThan(0);
 await resetLimits();
 // Synthetic source counter must survive a successful account login.
 await pool.query(`INSERT INTO ${schema}.login_limits(key,window_start,attempts) VALUES('synthetic-source-counter',NOW(),7)`);
 expect((await issue("synthetic-reception", "wrong")).kind).toBe("invalid_credentials");
 expect((await issue("synthetic-reception", "reception-pass-3")).kind).toBe("issued");
 const { rows: legacy } = await pool.query(`SELECT 1 FROM ${schema}.staff_login_limits WHERE account_key=$1`, [legacyStaffAccountKey("synthetic-reception")]);
 expect(legacy).toEqual([]);
 const shared = accountLimitKey("staff", "synthetic-reception");
 if (shared) expect((await pool.query(`SELECT 1 FROM ${schema}.login_limits WHERE key=$1`, [shared])).rows).toEqual([]);
 expect((await pool.query(`SELECT attempts FROM ${schema}.login_limits WHERE key='synthetic-source-counter'`)).rows).toEqual([{ attempts: 7 }]);
});

it("a password change committed while issuance waits on the fence never uses the old proof", async () => {
 const holder = await pool.connect();
 await holder.query("BEGIN");
 const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
 await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`aqlan.canonical.identity.substrate.v1:${schema}`]);
 const pending = issue("synthetic-reception", "reception-pass-3");
 try {
  expect((await waitForBlockedBy(pool, holderPid, 10_000)).length).toBeGreaterThan(0);
  await holder.query(`UPDATE ${schema}.users SET password_hash=password_hash||'-rotated' WHERE id=3`);
  await holder.query("COMMIT");
  expect(await pending).toEqual({ kind: "invalid_credentials" });
 } finally { await holder.query("ROLLBACK").catch(() => {}); holder.release(); await pending.catch(() => {}); }
 // Restore a usable credential for later cases.
 await pool.query(`UPDATE ${schema}.users SET password_hash=replace(password_hash,'-rotated','') WHERE id=3`);
});

it("a permission revision committed while issuance waits denies the stale candidate", async () => {
 const holder = await pool.connect();
 await holder.query("BEGIN");
 const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
 await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`aqlan.canonical.identity.substrate.v1:${schema}`]);
 const pending = issue("synthetic-doctor", "doctor-pass-2");
 try {
  expect((await waitForBlockedBy(pool, holderPid, 10_000)).length).toBeGreaterThan(0);
  await holder.query(`UPDATE ${schema}.users SET permissions=jsonb_set(permissions::jsonb,'{revision}','2')::text WHERE id=2`);
  await holder.query("COMMIT");
  expect(await pending).toEqual({ kind: "invalid_credentials" });
 } finally { await holder.query("ROLLBACK").catch(() => {}); holder.release(); await pending.catch(() => {}); }
 // A fresh login after the committed change reflects the new revision exactly.
 const fresh = await issue("synthetic-doctor", "doctor-pass-2");
 expect(fresh.kind).toBe("issued");
 if (fresh.kind === "issued") expect(revalidateVerifiedDurableSession(readVerifiedDurableSession(fresh.token)!)!.durableIdentity.permissionRevision).toBe(2);
});

it("malformed permission document or inactive provider denies after a password match without revealing it", async () => {
 await pool.query(`UPDATE ${schema}.users SET permissions='{"schemaVersion":1,"revision":3,"grants":{}}' WHERE id=2`);
 expect(await issue("synthetic-doctor", "doctor-pass-2")).toEqual({ kind: "invalid_credentials" });
 await pool.query(`UPDATE ${schema}.users SET permissions=$1 WHERE id=2`, [JSON.stringify({ schemaVersion: 1, revision: 4, patientScope: "none", appointmentScope: "none", grants: { "staff.view": true } })]);
 await pool.query(`UPDATE ${schema}.parties SET is_active=FALSE WHERE id=20`);
 expect(await issue("synthetic-doctor", "doctor-pass-2")).toEqual({ kind: "invalid_credentials" });
 await pool.query(`UPDATE ${schema}.parties SET is_active=TRUE WHERE id=20`);
 expect((await issue("synthetic-doctor", "doctor-pass-2")).kind).toBe("issued");
});

it("audit failure rolls back issuance and yields no token", async () => {
 const before = await auditCount();
 await pool.query(`ALTER TABLE ${schema}.audit_log ADD CONSTRAINT synthetic_audit_block CHECK (action<>'auth.canonical_login') NOT VALID`);
 try {
  await expect(issue("synthetic-reception", "reception-pass-3")).rejects.toThrow();
 } finally { await pool.query(`ALTER TABLE ${schema}.audit_log DROP CONSTRAINT synthetic_audit_block`); }
 expect(await auditCount()).toBe(before);
});

it("the protected owner row cannot be disabled or demoted underneath issuance", async () => {
 await expect(pool.query(`UPDATE ${schema}.users SET is_active=FALSE WHERE id=1`)).rejects.toThrow("owner account cannot be disabled or demoted");
 await expect(pool.query(`UPDATE ${schema}.users SET role='reception' WHERE id=1`)).rejects.toThrow("owner account cannot be disabled or demoted");
 expect((await issue("synthetic-reception", "reception-pass-3")).kind).toBe("issued");
});

it("quarantined, unsealed and drifted schemas answer unavailable before any password work", async () => {
 for (const stage of ["quarantined", "active-unsealed"] as const) {
  const other = syntheticSchemaName();
  const otherPool = syntheticPool(other, 3);
  try {
   await installSyntheticCanonicalFixture(otherPool, other, { ownerId: 1, accounts: accounts.slice(0, 3), doctorParties: [20], stage });
   expect(await issueDurableStaffSessionIn(otherPool, other, { username: "synthetic-owner", password: "owner-pass-1", headers: headers() })).toEqual({ kind: "unavailable" });
   // No limiter consumption for a state that cannot issue.
   expect((await otherPool.query(`SELECT count(*)::int AS n FROM ${other}.staff_login_limits`)).rows[0].n).toBe(0);
  } finally { await dropSyntheticSchema(otherPool, other); await otherPool.end(); }
 }
 await pool.query(`ALTER TABLE ${schema}.staff_identity_subjects DISABLE TRIGGER staff_identity_subjects_immutable`);
 try {
  expect(await issue("synthetic-owner", "owner-pass-1")).toEqual({ kind: "unavailable" });
 } finally { await pool.query(`ALTER TABLE ${schema}.staff_identity_subjects ENABLE TRIGGER staff_identity_subjects_immutable`); }
});
