import "server-only";
import { cookies, headers } from "next/headers";
import type { DbClient, DbPool } from "./db";
import { getPool, usesSharedLocalDatabaseConnection } from "./db";
import { SESSION_COOKIE, hasCanonicalSessionMarker, readSignedSessionEnvelope, verifyPassword } from "./auth";
import { withIsolation } from "./transactions";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { staffLifecycleLockKey } from "./legacy-staff-schema.mjs";
import { readVerifiedDurableSession, revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import { loadLockedOwnerSessionAuthority, loadLockedSessionAuthority, loadReadOnlyOwnerSessionAuthority } from "./staff-authority-proof-internal";
import { hasStaffCapability, patientCapabilityConstraint, appointmentCapabilityConstraint } from "./staff-capabilities";
import { STAFF_CAPABILITIES, type OwnerOnlyOperation, type StaffCapability } from "./staff-capability-catalogue";

/**
 * قاعدة اختيار واحدة لمغلّف الجلسة، وقبول الجلسة الموحّدة الحالي.
 *
 * الاختيار (CONTRACT.md، OWNER_READINESS_AND_ISSUANCE.md §5):
 *  - كوكي موقّعة صحيحة تُختار وحدها: إن حملت علامة موحّدة فهي "canonical" ولا تسقط
 *    أبدًا إلى Bearer مهما فشل قبولها؛ وإن كانت قديمة فهي "legacy".
 *  - بلا كوكي صالحة: ترويسة Bearer الموقّعة بالقاعدة نفسها.
 *  - مغلّف موحّد غير مطابق للشكل الصارم ⇒ "denied" (لا ترجمة ولا رجوع).
 *
 * القبول الموحّد = توقيع صحيح + إثبات قاعدة البيانات الحالي داخل معاملة READ COMMITTED
 * تحت السياج المشترك، بمقارنة كل مرساة موقّعة بالصف المثبت. الإسقاط الناتج للعرض
 * (الاسم والقائمة) فقط — لا يُقبل منحةً ولا يُعاد إلى الخادم سلطةً.
 */
export type StaffEnvelopeSelection =
 | { readonly kind: "none" }
 | { readonly kind: "legacy"; readonly token: string }
 | { readonly kind: "canonical"; readonly handle: VerifiedDurableSession }
 | { readonly kind: "denied" };

function classify(token: string | undefined): StaffEnvelopeSelection | null {
 const envelope = readSignedSessionEnvelope(token);
 if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
 if (!hasCanonicalSessionMarker(envelope)) return Object.freeze({ kind: "legacy", token: token! });
 const handle = readVerifiedDurableSession(token);
 return handle ? Object.freeze({ kind: "canonical", handle }) : Object.freeze({ kind: "denied" });
}
/** Pure selection over raw transport values (unit-tested); the request wrapper reads them. */
export function selectStaffEnvelope(cookieToken: string | undefined, authorization: string | null | undefined): StaffEnvelopeSelection {
 const fromCookie = classify(cookieToken);
 if (fromCookie) return fromCookie;
 if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
  const fromBearer = classify(authorization.slice(7).trim());
  if (fromBearer) return fromBearer;
 }
 return Object.freeze({ kind: "none" });
}
export async function selectRequestStaffEnvelope(): Promise<StaffEnvelopeSelection> {
 let cookieToken: string | undefined;
 let authorization: string | null = null;
 try { cookieToken = (await cookies()).get(SESSION_COOKIE)?.value; } catch { /* outside a request */ }
 try { authorization = (await headers()).get("authorization"); } catch { /* outside a request */ }
 return selectStaffEnvelope(cookieToken, authorization);
}

export interface CanonicalStaffView {
 readonly userId: number;
 readonly username: string;
 readonly displayName: string;
 /** Display label only (never authority). */
 readonly roleLabel: string;
 readonly isOwner: boolean;
 /** Exact current grants (owner: every capability), for navigation projection only. */
 readonly capabilities: readonly StaffCapability[];
 readonly patientScope: "none" | "own" | "all";
 readonly appointmentScope: "none" | "own" | "all";
 readonly clinicianPartyId: number | null;
 readonly expiresAt: number;
}
async function transactionId(client: DbClient): Promise<string> {
 await client.query("SAVEPOINT staff_session_transaction_check");
 await client.query("RELEASE SAVEPOINT staff_session_transaction_check");
 const { rows } = await client.query<{ xid: string; isolation: string }>("SELECT pg_current_xact_id()::text AS xid, current_setting('transaction_isolation') AS isolation");
 if (rows.length !== 1 || rows[0].isolation !== "read committed") throw new Error("STAFF_OPERATION_TRANSACTION_REQUIRED");
 return rows[0].xid;
}
const scopeOf = (constraint: { kind: string }) => constraint.kind === "all" ? "all" : constraint.kind === "own" ? "own" : "none";

/** Test seam with explicit pool/schema (same contract as the operation runtime). */
export async function admitCanonicalStaffSessionIn(pool: DbPool, schema: string, handle: VerifiedDurableSession): Promise<CanonicalStaffView | null> {
 const s = staffIdentitySchemaName(schema);
 try {
  return await withIsolation(pool, "READ COMMITTED", async client => {
   const xid = await transactionId(client);
   await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [staffLifecycleLockKey(s)]);
   const proof = await loadLockedSessionAuthority(client, handle, s);
   const claims = revalidateVerifiedDurableSession(handle);
   if (!claims || await transactionId(client) !== xid) throw new Error("STAFF_OPERATION_SESSION_EXPIRED");
   return Object.freeze({
    userId: proof.user.id, username: proof.user.username, displayName: proof.user.displayName || proof.user.username,
    roleLabel: proof.user.role, isOwner: proof.access.isOwner,
    capabilities: Object.freeze(STAFF_CAPABILITIES.filter(capability => hasStaffCapability(proof.access, capability))),
    patientScope: scopeOf(patientCapabilityConstraint(proof.access)), appointmentScope: scopeOf(appointmentCapabilityConstraint(proof.access)),
    clinicianPartyId: proof.provider?.partyId ?? null, expiresAt: claims.expiresAt,
   });
  });
 } catch (error) {
  // Any refusal (stale anchor, revoked grant, schema drift, expiry) is "not admitted".
  if (error instanceof Error && /^STAFF_(OPERATION|RUNTIME)_[A-Z_]+$/.test(error.message)) return null;
  throw error;
 }
}
/** Live admission of the request's selected canonical envelope, or null. */
export async function admitCanonicalStaffSession(handle: VerifiedDurableSession): Promise<CanonicalStaffView | null> {
 if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) return null;
 return admitCanonicalStaffSessionIn(getPool(), "public", handle);
}

/** Same-transaction self-scoped execution: proves the caller's live canonical session
 * under the shared lifecycle fence, executes `work(client, view)` on the same client/XID,
 * and re-verifies session expiry and XID before commit. Used by `self` routes (`GET /api/hr/me`,
 * own password change, own print log, own access projection) without capability grants. */
export async function withCanonicalSelfSessionIn<T>(
 pool: DbPool,
 schema: string,
 handle: VerifiedDurableSession,
 work: (client: DbClient, view: CanonicalStaffView) => Promise<T>,
): Promise<{ readonly ok: true; readonly view: CanonicalStaffView; readonly value: T } | { readonly ok: false }> {
 const s = staffIdentitySchemaName(schema);
 try {
  return await withIsolation(pool, "READ COMMITTED", async client => {
   const xid = await transactionId(client);
   await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [staffLifecycleLockKey(s)]);
   const proof = await loadLockedSessionAuthority(client, handle, s);
   const claims = revalidateVerifiedDurableSession(handle);
   if (!claims || await transactionId(client) !== xid) throw new Error("STAFF_OPERATION_SESSION_EXPIRED");
   const view: CanonicalStaffView = Object.freeze({
    userId: proof.user.id, username: proof.user.username, displayName: proof.user.displayName || proof.user.username,
    roleLabel: proof.user.role, isOwner: proof.access.isOwner,
    capabilities: Object.freeze(STAFF_CAPABILITIES.filter(capability => hasStaffCapability(proof.access, capability))),
    patientScope: scopeOf(patientCapabilityConstraint(proof.access)), appointmentScope: scopeOf(appointmentCapabilityConstraint(proof.access)),
    clinicianPartyId: proof.provider?.partyId ?? null, expiresAt: claims.expiresAt,
   });
   const value = await work(client, view);
   if (!revalidateVerifiedDurableSession(handle) || await transactionId(client) !== xid) {
    throw new Error("STAFF_OPERATION_SESSION_EXPIRED");
   }
   return Object.freeze({ ok: true as const, view, value });
  });
 } catch (error) {
  if (error instanceof Error && /^STAFF_(OPERATION|RUNTIME)_[A-Z_]+$/.test(error.message)) return Object.freeze({ ok: false as const });
  throw error;
 }
}

export async function withCanonicalSelfSession<T>(
 handle: VerifiedDurableSession,
 work: (client: DbClient, view: CanonicalStaffView) => Promise<T>,
): Promise<{ readonly ok: true; readonly view: CanonicalStaffView; readonly value: T } | { readonly ok: false }> {
 if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) return Object.freeze({ ok: false as const });
 return withCanonicalSelfSessionIn(getPool(), "public", handle, work);
}

export type CanonicalOwnerAdmissionOutcome<T> =
 | { readonly ok: true; readonly view: CanonicalStaffView; readonly value: T }
 | { readonly ok: false; readonly reason: "unauthenticated" | "forbidden" | "unavailable" };

/** Same-transaction owner-only operation execution (`READ COMMITTED` + shared lifecycle fence).
 * Distinguishes unauthenticated/stale sessions (`401`) from non-owner canonical staff (`403`). */
export async function withCanonicalOwnerOperationIn<T>(
 pool: DbPool,
 schema: string,
 handle: VerifiedDurableSession,
 operation: OwnerOnlyOperation,
 work: (
  client: DbClient,
  view: CanonicalStaffView,
  verifyOwnPassword: (candidatePassword: string) => Promise<boolean>,
 ) => Promise<T>,
): Promise<CanonicalOwnerAdmissionOutcome<T>> {
 const s = staffIdentitySchemaName(schema);
 try {
  return await withIsolation(pool, "READ COMMITTED", async client => {
   const xid = await transactionId(client);
   await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [staffLifecycleLockKey(s)]);
   const proof = await loadLockedOwnerSessionAuthority(client, handle, s, operation);
   const claims = revalidateVerifiedDurableSession(handle);
   if (!claims || await transactionId(client) !== xid) throw new Error("STAFF_OPERATION_SESSION_EXPIRED");
   const view: CanonicalStaffView = Object.freeze({
    userId: proof.user.id, username: proof.user.username, displayName: proof.user.displayName || proof.user.username,
    roleLabel: proof.user.role, isOwner: proof.access.isOwner,
    capabilities: Object.freeze(STAFF_CAPABILITIES.filter(capability => hasStaffCapability(proof.access, capability))),
    patientScope: scopeOf(patientCapabilityConstraint(proof.access)), appointmentScope: scopeOf(appointmentCapabilityConstraint(proof.access)),
    clinicianPartyId: proof.provider?.partyId ?? null, expiresAt: claims.expiresAt,
   });
   const value = await work(client, view, candidate => verifyPassword(candidate, proof.user.passwordHash));
   const finalProof = await loadLockedOwnerSessionAuthority(client, handle, s, operation);
   if (finalProof.user.authorizationEpoch !== proof.user.authorizationEpoch || !revalidateVerifiedDurableSession(handle) || await transactionId(client) !== xid) {
    throw new Error("STAFF_OPERATION_SESSION_EXPIRED");
   }
   return Object.freeze({ ok: true as const, view, value });
  });
 } catch (error) {
  if (error instanceof Error && error.message === "STAFF_OPERATION_CAPABILITY_DENIED") {
   return Object.freeze({ ok: false as const, reason: "forbidden" as const });
  }
  if (error instanceof Error && /^STAFF_RUNTIME_[A-Z_]+$/.test(error.message)) {
   return Object.freeze({ ok: false as const, reason: "unavailable" as const });
  }
  if (error instanceof Error && /^STAFF_OPERATION_[A-Z_]+$/.test(error.message)) {
   return Object.freeze({ ok: false as const, reason: "unauthenticated" as const });
  }
  throw error;
 }
}

export async function withCanonicalOwnerOperation<T>(
 handle: VerifiedDurableSession,
 operation: OwnerOnlyOperation,
 work: (
  client: DbClient,
  view: CanonicalStaffView,
  verifyOwnPassword: (candidatePassword: string) => Promise<boolean>,
 ) => Promise<T>,
): Promise<CanonicalOwnerAdmissionOutcome<T>> {
 if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
  return Object.freeze({ ok: false as const, reason: "unavailable" as const });
 }
 return withCanonicalOwnerOperationIn(getPool(), "public", handle, operation, work);
}

/** Zero-write `READ ONLY` owner-only admission for filesystem/archive backup endpoints
 * that must never mutate PostgreSQL (`lib/backupReadOnly.ts`). */
export async function admitCanonicalOwnerReadOnlyIn(
 pool: DbPool,
 schema: string,
 handle: VerifiedDurableSession,
 operation: OwnerOnlyOperation,
): Promise<CanonicalOwnerAdmissionOutcome<null>> {
 const s = staffIdentitySchemaName(schema);
 let client: DbClient | undefined;
 let inTx = false;
 let discard = false;
 try {
  client = await pool.connect();
  await client.query("ROLLBACK");
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY");
  inTx = true;
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL lock_timeout = '5s'");
  const { rows: [ro] } = await client.query<{ read_only: string; in_recovery: boolean }>(
   "SELECT current_setting('transaction_read_only') AS read_only, pg_catalog.pg_is_in_recovery() AS in_recovery",
  );
  if (!ro || ro.read_only !== "on" || ro.in_recovery !== false) {
   throw new Error("STAFF_RUNTIME_READ_ONLY_REQUIRED");
  }
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [staffLifecycleLockKey(s)]);
  const proof = await loadReadOnlyOwnerSessionAuthority(client, handle, s, operation);
  const claims = revalidateVerifiedDurableSession(handle);
  if (!claims) throw new Error("STAFF_OPERATION_SESSION_EXPIRED");
  const view: CanonicalStaffView = Object.freeze({
   userId: proof.user.id, username: proof.user.username, displayName: proof.user.displayName || proof.user.username,
   roleLabel: proof.user.role, isOwner: proof.access.isOwner,
   capabilities: Object.freeze(STAFF_CAPABILITIES.filter(capability => hasStaffCapability(proof.access, capability))),
   patientScope: scopeOf(patientCapabilityConstraint(proof.access)), appointmentScope: scopeOf(appointmentCapabilityConstraint(proof.access)),
   clinicianPartyId: proof.provider?.partyId ?? null, expiresAt: claims.expiresAt,
  });
  await client.query("COMMIT");
  inTx = false;
  return Object.freeze({ ok: true as const, view, value: null });
 } catch (error) {
  if (inTx && client) {
   try { await client.query("ROLLBACK"); inTx = false; } catch { discard = true; }
  }
  if (error instanceof Error && error.message === "STAFF_OPERATION_CAPABILITY_DENIED") {
   return Object.freeze({ ok: false as const, reason: "forbidden" as const });
  }
  if (error instanceof Error && /^STAFF_OPERATION_[A-Z_]+$/.test(error.message)) {
   return Object.freeze({ ok: false as const, reason: "unauthenticated" as const });
  }
  return Object.freeze({ ok: false as const, reason: "unavailable" as const });
 } finally {
  if (client) {
   try { client.release(discard); } catch { /* ignore release failure */ }
  }
 }
}

export async function admitCanonicalOwnerReadOnly(
 handle: VerifiedDurableSession,
 operation: OwnerOnlyOperation,
): Promise<CanonicalOwnerAdmissionOutcome<null>> {
 if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
  return Object.freeze({ ok: false as const, reason: "unavailable" as const });
 }
 let pool: DbPool;
 try { pool = getPool(); } catch { return Object.freeze({ ok: false as const, reason: "unavailable" as const }); }
 return admitCanonicalOwnerReadOnlyIn(pool, "public", handle, operation);
}
