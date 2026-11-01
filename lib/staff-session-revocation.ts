import "server-only";
import { createHash } from "node:crypto";
import type { DbClient, DbPool } from "./db";
import { hashPassword, verifyPassword } from "./auth";
import { getPool, insertAuditRow, usesSharedLocalDatabaseConnection } from "./db";
import { withIsolation } from "./transactions";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { staffLifecycleLockKey } from "./legacy-staff-schema.mjs";
import { inspectStaffRuntimeSchema } from "./staff-runtime-probe.mjs";
import { revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import { loadLockedSessionAuthority, type ProvedAccountAuthority } from "./staff-authority-proof-internal";
import { clearAccountLoginLimits, consumeStaffAccountLimit } from "./login-limit-storage";

/**
 * Canonical staff-session revocation for `POST /api/auth/logout` (peer-review #4,
 * independent finding 6). Kept OUT of the private durable issuer: revocation never
 * signs or mints a token, so the issuer's import boundary stays unchanged.
 *
 * Semantics: logout revokes every durable session of the account (same as the legacy
 * `session_version` bump), but ONLY when the presented token is currently valid against
 * the locked live authority tuple. An already-revoked, expired or stale token fails
 * `loadLockedSessionAuthority` before any write and is a strict no-op, so it can never
 * revoke sessions issued after its own revocation.
 *
 * Mechanism: the capability document's `revision` is advanced by one with identical
 * grants and scopes. The 0076 trigger then raises `authorization_epoch`, invalidating all
 * outstanding durable claims of this account only. No grant, scope, owner binding or
 * credential changes. Reviewer note: this reuses the permission revision as the
 * revocation counter (no new schema); a dedicated revocation column would need an M4
 * migration and is listed as remaining work.
 */
function refuse(reason: string): never {
  throw new Error(`STAFF_RUNTIME_${reason}`);
}

async function revocationReady(pool: DbPool, s: string): Promise<boolean> {
  try {
    await inspectStaffRuntimeSchema(pool, s);
    const { rows } = await pool.query<{ state: string; status: string; aligned: boolean }>(
      `SELECT c.state, h.status,
        (h.realm_id::text=c.realm_id AND h.ready_control_epoch IS NOT DISTINCT FROM c.binding_epoch) AS aligned
       FROM ${s}.staff_authority_control c CROSS JOIN ${s}.staff_identity_state h WHERE c.singleton AND h.singleton`,
    );
    return rows.length === 1 && rows[0].state === "active" && rows[0].status === "ready" && rows[0].aligned === true;
  } catch {
    return false;
  }
}

async function readCommittedXid(client: DbClient): Promise<string> {
  const { rows } = await client.query<{ xid: string; isolation: string }>(
    "SELECT pg_current_xact_id()::text AS xid, current_setting('transaction_isolation') AS isolation",
  );
  if (rows.length !== 1 || rows[0].isolation !== "read committed") refuse("TRANSACTION_REQUIRED");
  return rows[0].xid;
}

export async function revokeCanonicalStaffSessionIn(
  pool: DbPool,
  schema: string,
  handle: VerifiedDurableSession,
): Promise<boolean> {
  const s = staffIdentitySchemaName(schema);
  if (!revalidateVerifiedDurableSession(handle)) return false;
  if (!(await revocationReady(pool, s))) return false;
  try {
    return await withIsolation(pool, "READ COMMITTED", async (client) => {
      const xid = await readCommittedXid(client);
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [staffLifecycleLockKey(s)]);
      const before = await loadLockedSessionAuthority(client, handle, s);
      const nextPermissions = JSON.stringify({
        schemaVersion: before.document.schemaVersion,
        revision: before.document.revision + 1,
        confirmation: before.document.confirmation,
        patientScope: before.document.patientScope,
        appointmentScope: before.document.appointmentScope,
        grants: before.document.grants,
      });
      const { rows } = await client.query<{ id: number }>(
        `UPDATE ${s}.users
            SET permissions = $2
          WHERE id = $1
            AND authorization_mode = 'canonical'
            AND authorization_epoch::text = $3
          RETURNING id`,
        [before.user.id, nextPermissions, before.user.authorizationEpoch],
      );
      if (rows.length !== 1) refuse("CANDIDATE_CHANGED");
      await insertAuditRow(client, {
        action: "auth.canonical_logout",
        entity: "user",
        entityId: before.user.id,
        actor: before.user.username,
        actorRole: before.user.role,
        entityLabel: before.user.username,
        details: { subjectId: before.subjectId, sessionsRevoked: true },
      }, s);
      if ((await readCommittedXid(client)) !== xid) refuse("TRANSACTION_CHANGED");
      return true;
    });
  } catch (error) {
    if (error instanceof Error && /^STAFF_(OPERATION|ISSUER|RUNTIME)_[A-Z_]+$/.test(error.message)) {
      return false;
    }
    throw error;
  }
}

export async function revokeCanonicalStaffSession(handle: VerifiedDurableSession): Promise<boolean> {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) return false;
  return revokeCanonicalStaffSessionIn(getPool(), "public", handle);
}

const DUMMY_HASH = "scrypt:0000:0000";
const MAX_PASSWORD = 1024;

export type CanonicalPasswordRotationOutcome =
  | { readonly kind: "changed"; readonly username: string }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "wrong_password" }
  | { readonly kind: "rate_limited"; readonly retryAfterSeconds: number }
  | { readonly kind: "invalid_input"; readonly error: string }
  | { readonly kind: "unavailable" };

interface PasswordCandidate {
  readonly id: number;
  readonly username: string;
  readonly passwordHash: string;
  readonly accountEpoch: string;
  readonly subjectId: string;
  readonly realmId: string;
  readonly controlEpoch: string;
  readonly generationId: string;
  readonly providerPartyId: number | null;
  readonly providerEpoch: string | null;
}

async function readPasswordCandidate(pool: DbPool, s: string, username: string): Promise<PasswordCandidate | null> {
  const { rows } = await pool.query<{
    id: number;
    username: string;
    password_hash: string;
    authorization_epoch: string;
    subject_id: string | null;
    realm_id: string | null;
    binding_epoch: string | null;
    generation_id: string | null;
    party_id: number | null;
    clinical_epoch: string | null;
  }>(
    `SELECT u.id, u.username, u.password_hash, u.authorization_epoch::text, b.subject_id::text,
      c.realm_id::text, c.binding_epoch::text, h.generation_id::text, u.party_id, p.clinical_authority_epoch::text AS clinical_epoch
     FROM ${s}.users u
     LEFT JOIN ${s}.staff_identity_current b ON b.user_id=u.id
     CROSS JOIN ${s}.staff_authority_control c CROSS JOIN ${s}.staff_identity_state h
     LEFT JOIN ${s}.parties p ON p.id=u.party_id
     WHERE LOWER(u.username)=LOWER($1) AND u.is_active AND u.authorization_mode='canonical' AND c.singleton AND h.singleton
     ORDER BY u.id LIMIT 2`,
    [username],
  );
  if (rows.length !== 1) return null;
  const r = rows[0];
  if (
    typeof r.password_hash !== "string" ||
    !Number.isSafeInteger(r.id) ||
    typeof r.subject_id !== "string" ||
    typeof r.realm_id !== "string" ||
    typeof r.binding_epoch !== "string" ||
    typeof r.generation_id !== "string"
  ) {
    return null;
  }
  return Object.freeze({
    id: r.id,
    username: r.username,
    passwordHash: r.password_hash,
    accountEpoch: r.authorization_epoch,
    subjectId: r.subject_id,
    realmId: r.realm_id,
    controlEpoch: r.binding_epoch,
    generationId: r.generation_id,
    providerPartyId: r.party_id,
    providerEpoch: r.party_id === null ? null : r.clinical_epoch,
  });
}

function matchesPasswordCandidate(proved: ProvedAccountAuthority, c: PasswordCandidate): boolean {
  const currentParty = proved.provider ? proved.provider.partyId : null;
  const currentProviderEpoch = proved.provider ? proved.provider.clinicalEpoch : null;
  return (
    proved.user.id === c.id &&
    proved.user.username === c.username &&
    proved.user.passwordHash === c.passwordHash &&
    proved.user.authorizationEpoch === c.accountEpoch &&
    proved.subjectId === c.subjectId &&
    proved.realmId === c.realmId &&
    proved.controlEpoch === c.controlEpoch &&
    proved.generationId === c.generationId &&
    currentParty === c.providerPartyId &&
    currentProviderEpoch === c.providerEpoch
  );
}

/**
 * Self-service password rotation for an active canonical session (`POST /api/auth/password`).
 * Never imports or calls the private durable signer: updates `users.password_hash` under the
 * exclusive lifecycle fence (bumping `authorization_epoch` so all prior durable tokens are
 * revoked) and writes an atomic audit row. Fresh session cookie issuance then flows solely
 * through the reviewed login route entrypoint.
 */
export async function rotateCanonicalStaffOwnPasswordIn(
  pool: DbPool,
  schema: string,
  input: { readonly handle: VerifiedDurableSession; readonly currentPassword: string; readonly newPassword: string },
): Promise<CanonicalPasswordRotationOutcome> {
  const s = staffIdentitySchemaName(schema);
  const initialClaims = revalidateVerifiedDurableSession(input.handle);
  if (!initialClaims) return Object.freeze({ kind: "unauthenticated" });
  const currentPassword = typeof input.currentPassword === "string" ? input.currentPassword : "";
  const newPassword = typeof input.newPassword === "string" ? input.newPassword : "";
  if (!currentPassword || currentPassword.length > MAX_PASSWORD) {
    return Object.freeze({ kind: "invalid_input", error: "أدخل كلمة المرور الحالية وكلمة المرور الجديدة" });
  }
  if (newPassword.length < 8) {
    return Object.freeze({ kind: "invalid_input", error: "كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل" });
  }
  if (newPassword.length > MAX_PASSWORD) {
    return Object.freeze({ kind: "invalid_input", error: "كلمة المرور طويلة جداً" });
  }
  if (!(await revocationReady(pool, s))) return Object.freeze({ kind: "unavailable" });

  const rlKey = createHash("sha256").update(`password-change:${initialClaims.username.toLowerCase()}`).digest("hex");
  const rlDecision = await consumeStaffAccountLimit(pool, rlKey, s);
  if (!rlDecision.allowed) {
    return Object.freeze({ kind: "rate_limited", retryAfterSeconds: rlDecision.retryAfterSeconds });
  }

  const captured = await readPasswordCandidate(pool, s, initialClaims.username);
  if (!captured || captured.id !== initialClaims.userId) {
    await verifyPassword(currentPassword, DUMMY_HASH);
    return Object.freeze({ kind: "unauthenticated" });
  }
  const passwordOk = await verifyPassword(currentPassword, captured.passwordHash);
  if (!passwordOk) {
    try {
      await withIsolation(pool, "READ COMMITTED", async (client) => {
        await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [staffLifecycleLockKey(s)]);
        await loadLockedSessionAuthority(client, input.handle, s);
      });
      return Object.freeze({ kind: "wrong_password" });
    } catch (error) {
      if (error instanceof Error && /^STAFF_(OPERATION|RUNTIME)_[A-Z_]+$/.test(error.message)) {
        return Object.freeze({ kind: "unauthenticated" });
      }
      throw error;
    }
  }

  const nextPasswordHash = await hashPassword(newPassword);
  let committedUsername = "";
  try {
    committedUsername = await withIsolation(pool, "READ COMMITTED", async (client) => {
      const xid = await readCommittedXid(client);
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [staffLifecycleLockKey(s)]);
      const before = await loadLockedSessionAuthority(client, input.handle, s);
      if (!matchesPasswordCandidate(before, captured)) refuse("CANDIDATE_CHANGED");
      const { rows } = await client.query<{ id: number }>(
        `UPDATE ${s}.users
            SET password_hash = $2
          WHERE id = $1
            AND authorization_mode = 'canonical'
            AND authorization_epoch::text = $3
          RETURNING id`,
        [before.user.id, nextPasswordHash, before.user.authorizationEpoch],
      );
      if (rows.length !== 1) refuse("CANDIDATE_CHANGED");
      await insertAuditRow(client, {
        action: "user.update",
        entity: "user",
        entityId: before.user.id,
        actor: before.user.username,
        actorRole: before.user.role,
        entityLabel: before.user.username,
        details: {
          التغيير: "غيّر كلمة مروره بنفسه",
          selfPasswordChange: true,
          subjectId: before.subjectId,
          sessionsRevoked: true,
        },
      }, s);
      if ((await readCommittedXid(client)) !== xid) refuse("TRANSACTION_CHANGED");
      return before.user.username;
    });
  } catch (error) {
    if (error instanceof Error && /^STAFF_OPERATION_[A-Z_]+$/.test(error.message)) {
      return Object.freeze({ kind: "unauthenticated" });
    }
    if (error instanceof Error && /^STAFF_(ISSUER|RUNTIME)_[A-Z_]+$/.test(error.message)) {
      return Object.freeze({ kind: "unavailable" });
    }
    throw error;
  }

  try {
    await clearAccountLoginLimits(pool, rlKey, [], s);
  } catch { /* best-effort counter reset */ }

  return Object.freeze({ kind: "changed", username: committedUsername });
}

export async function rotateCanonicalStaffOwnPassword(input: {
  readonly handle: VerifiedDurableSession;
  readonly currentPassword: string;
  readonly newPassword: string;
}): Promise<CanonicalPasswordRotationOutcome> {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
    return Object.freeze({ kind: "unavailable" });
  }
  return rotateCanonicalStaffOwnPasswordIn(getPool(), "public", input);
}
