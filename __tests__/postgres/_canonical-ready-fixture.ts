/** Synthetic trusted-ready canonical fixture ONLY. It proves code behaviour against a
 * real PostgreSQL schema; it is not a preparation service, appoints no real owner
 * and carries no live provenance (OWNER_READINESS_AND_ISSUANCE.md §2/§7).
 * users.permissions is TEXT, exactly as in the clinic schema (lib/db.ts). */
import { readFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { hashPassword } from "../../lib/auth";
import { staffIdentitySubstrateSql } from "../../lib/staff-identity-substrate-schema.mjs";
import { initializeStaffIdentitySubstrate, bindStaffAccountIncarnation } from "../../lib/staff-identity-substrate.mjs";
import { staffRuntimeSchemaSql } from "../../lib/staff-runtime-schema.mjs";
import { sessionCredentialVersion } from "../../lib/auth";
import { STAFF_AUTHORIZATION_POLICY_VERSION } from "../../lib/staff-capability-catalogue";

export interface SyntheticAccount {
 readonly id: number;
 readonly username: string;
 readonly role: string;
 readonly password: string;
 readonly displayName?: string;
 readonly partyId?: number | null;
 readonly grants?: Record<string, boolean>;
 readonly patientScope?: "none" | "own" | "all";
 readonly appointmentScope?: "none" | "own" | "all";
 /** Default `owner` (already confirmed by the owner); `pending` grants nothing. */
 readonly confirmation?: "owner" | "pending";
 readonly active?: boolean;
}
export interface SyntheticReadyOptions {
 readonly ownerId: number;
 readonly accounts: readonly SyntheticAccount[];
 readonly doctorParties?: readonly number[];
 /** Stop before activation/seal to exercise quarantined or partial states. */
 readonly stage?: "quarantined" | "active-unsealed" | "ready";
 /** Extra base tables the scenario needs (created before substrate install). */
 readonly extraSql?: string;
}
export const syntheticSchemaName = () => `aqlan_identity_${randomBytes(8).toString("hex")}`;
export function syntheticPool(schema: string, max = 8) {
 return new Pool({ connectionString: process.env.TEST_DATABASE_URL, ssl: false, max, options: `-c search_path=${schema},pg_catalog` });
}
export const capabilityDocument = (account: Pick<SyntheticAccount, "grants" | "patientScope" | "appointmentScope" | "confirmation">, revision = 1) => ({
 schemaVersion: 2, confirmation: account.confirmation ?? "owner", revision, patientScope: account.patientScope ?? "none", appointmentScope: account.appointmentScope ?? "none", grants: account.grants ?? {},
});
export async function installSyntheticCanonicalFixture(pool: Pool, schema: string, options: SyntheticReadyOptions): Promise<void> {
 const c = await pool.connect();
 try {
  await c.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},pg_catalog`);
  await c.query(`CREATE TABLE ${schema}.parties(id SERIAL PRIMARY KEY,kind TEXT,name TEXT,is_active BOOLEAN);
   CREATE TABLE ${schema}.users(id SERIAL PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT,password_hash TEXT,role TEXT,is_active BOOLEAN,party_id INTEGER,permissions TEXT);
   CREATE TABLE ${schema}.audit_log(id BIGSERIAL PRIMARY KEY,action TEXT NOT NULL,entity TEXT,entity_id TEXT,summary TEXT NOT NULL,details JSONB,actor TEXT NOT NULL,actor_role TEXT,source_ip TEXT,user_agent TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
   CREATE TABLE ${schema}.staff_login_limits(account_key TEXT PRIMARY KEY,window_started_at TIMESTAMPTZ NOT NULL,attempts INTEGER NOT NULL);
   CREATE TABLE ${schema}.login_limits(key TEXT PRIMARY KEY,window_start TIMESTAMPTZ NOT NULL,attempts INTEGER NOT NULL);
   ${options.extraSql ?? ""}`);
  await c.query(readFileSync(new URL("../fixtures/staff-identity/frozen-0076.sql", import.meta.url), "utf8"));
  await c.query(staffIdentitySubstrateSql(schema));
  for (const party of options.doctorParties ?? []) await c.query(`INSERT INTO ${schema}.parties(id,kind,name,is_active) VALUES($1,'doctor',$2,TRUE)`, [party, `synthetic-doctor-${party}`]);
  for (const account of options.accounts) {
   await c.query(`INSERT INTO ${schema}.users(id,username,display_name,role,is_active,password_hash,party_id,permissions) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [account.id, account.username, account.displayName ?? null, account.role, account.active ?? true, await hashPassword(account.password), account.partyId ?? null, JSON.stringify(capabilityDocument(account))]);
  }
  await c.query("BEGIN");
  let h = await initializeStaffIdentitySubstrate(c, schema);
  for (const account of [...options.accounts].sort((a, b) => a.id - b.id)) {
   h = await bindStaffAccountIncarnation(c, { userId: account.id, currentSubjectId: null, expected: { generationId: h.generationId, registryRevision: h.registryRevision } }, schema);
  }
  await c.query("COMMIT");
  await c.query(staffRuntimeSchemaSql(schema));
  if (options.stage === "quarantined") return;
  // Explicit hypothetical trusted-ready fixture, not a preparation API.
  await c.query("BEGIN");
  await c.query(`UPDATE ${schema}.users SET authorization_mode='canonical'`);
  await c.query(`UPDATE ${schema}.staff_authority_control SET state='prepared',pending_owner_user_id=$1,conversion_digest=repeat('a',64),recovery_reference='synthetic-fixture-not-bootstrap' WHERE singleton`, [options.ownerId]);
  await c.query(`UPDATE ${schema}.staff_authority_control SET state='active',owner_user_id=$1,pending_owner_user_id=NULL WHERE singleton`, [options.ownerId]);
  await c.query("COMMIT");
  if (options.stage === "active-unsealed") return;
  await c.query(`UPDATE ${schema}.staff_identity_state SET status='ready',ready_owner_subject_id=(SELECT subject_id FROM ${schema}.staff_identity_current WHERE user_id=$1),ready_control_epoch=(SELECT binding_epoch FROM ${schema}.staff_authority_control) WHERE singleton`, [options.ownerId]);
 } finally { c.release(); }
}
export async function dropSyntheticSchema(pool: Pool, schema: string) {
 await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}
/** Current claims for an account, read directly for negative/positive token fixtures. */
export async function syntheticClaims(pool: Pool, schema: string, userId: number, expiresInMs = 60_000) {
 const { rows: [r] } = await pool.query(`SELECT u.id,u.username,u.password_hash,u.authorization_epoch::text,u.permissions,u.party_id,p.clinical_authority_epoch::text,
  h.realm_id::text,h.generation_id::text,h.registry_revision::text,c.binding_epoch::text,b.subject_id::text
  FROM ${schema}.users u CROSS JOIN ${schema}.staff_identity_state h CROSS JOIN ${schema}.staff_authority_control c
  JOIN ${schema}.staff_identity_current b ON b.user_id=$1 LEFT JOIN ${schema}.parties p ON p.id=u.party_id WHERE u.id=$1`, [userId]);
 return { userId: r.id, username: r.username, expiresAt: Date.now() + expiresInMs, durableIdentity: { schemaVersion: 2, policyVersion: STAFF_AUTHORIZATION_POLICY_VERSION, realmId: r.realm_id, subjectId: r.subject_id, generationId: r.generation_id, registryRevision: r.registry_revision, controlEpoch: r.binding_epoch, accountEpoch: r.authorization_epoch, permissionRevision: JSON.parse(r.permissions).revision, credentialVersion: sessionCredentialVersion(r.password_hash), provider: r.party_id === null ? null : { partyId: r.party_id, clinicalEpoch: r.clinical_authority_epoch } } };
}
/** Test-only HMAC signer over the test SESSION_SECRET (never the production signer). */
export function syntheticSign(payload: unknown) {
 const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
 return `${body}.${createHmac("sha256", process.env.SESSION_SECRET!).update(body).digest("base64url")}`;
}
export async function waitForBlockedBy(pool: Pool, holderPid: number, timeoutMs = 3000) {
 const deadline = performance.now() + timeoutMs;
 while (performance.now() < deadline) {
  const { rows } = await pool.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))", [holderPid]);
  if (rows.length) return rows.map(r => r.pid);
  await new Promise(resolve => setTimeout(resolve, 10));
 }
 throw new Error("real PostgreSQL blocking barrier was not observed");
}
