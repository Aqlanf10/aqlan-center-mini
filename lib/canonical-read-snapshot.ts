import "server-only";
import { performance } from "node:perf_hooks";
import { getPool, usesSharedLocalDatabaseConnection, type DbClient } from "./db";
import { revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import { loadCanonicalRecordSnapshotAuthority, loadCanonicalSnapshotAuthority } from "./staff-authority-proof-internal";
import { appointmentCapabilityConstraint, canPerformOwnerOperation, hasStaffCapability, patientCapabilityConstraint, type StaffRecordConstraint } from "./staff-capabilities";
import { canonicalRecordReadRule, isCanonicalRecordRead, type CanonicalRecordRead } from "./canonical-record-reads";
import type { OwnerOnlyOperation, StaffCapability } from "./staff-capability-catalogue";
import type { StaffRuntimeAction } from "./staff-operation-runtime";

/**
 * Generic owning canonical READ snapshot (CANONICAL_READ_SNAPSHOTS.md, "Proposed
 * owning protocol"). Extracted unchanged from the bounded staff-directory reader so
 * every canonical read (directory, inventory, procurement, custody, supplier finance)
 * shares one reviewed lifetime:
 *  1. clean exclusive primary lease; ROLLBACK any abandoned transaction; prove zero
 *     self-held advisory locks (unknown locks discard the lease, never unlock);
 *  2. shared SESSION lifecycle fence BEFORE `BEGIN ISOLATION LEVEL REPEATABLE READ
 *     READ ONLY` (no stale snapshot pinned behind a waiting revoker);
 *  3. private virtual-XID/mode/primary identity probe before admission, before the
 *     domain read and before COMMIT (no permanent XID, no row locks, no DDL);
 *  4. the writer runtime's exact authority predicates in the same snapshot, for the
 *     exact registered read action, or for a registered record read
 *     (`lib/canonical-record-reads.ts`: capabilities plus a non-`none` record scope);
 *  5. one registered server-internal domain reader that receives only a guarded,
 *     serialized `query` facade (closed once the reader returns) and the admitted
 *     scope (current grants and linked clinician) from that same proof;
 *  6. a bounded plain-data result, COMMIT, exactly one confirmed fence unlock, and an
 *     expiry check before publication. Any uncertainty destroys the lease.
 * There is no caller SQL from the request, no client/pool/schema/isolation override,
 * no streaming and no reusable handle. Scope is snapshot-time scope: the result is
 * fence-linearized against authority writers, not cancelled by a later revocation.
 */
const FENCE = "aqlan.canonical.identity.substrate.v1:public";
const TOTAL_MS = 10_000;
const QUERY_MS = 5_000;
const IDENTITY_SQL = `SELECT virtualxid::text AS virtualxid,
 current_setting('transaction_isolation') AS isolation,
 current_setting('transaction_read_only') AS read_only, pg_catalog.pg_is_in_recovery() AS in_recovery
 FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
 AND locktype='virtualxid' AND mode='ExclusiveLock' AND granted`;
/** Statements a domain reader may never send through the facade. Defence in depth:
 * READ ONLY already rejects writes; these also keep transaction control, locks and
 * session state with the owner. */
const FORBIDDEN_SQL = /^\s*(BEGIN|START|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE|SET|RESET|LOCK|DISCARD|LISTEN|NOTIFY|COPY|DO|CALL)\b|\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b|pg_advisory|pg_current_xact_id\s*\(|set_config\s*\(|nextval\s*\(|setval\s*\(/i;

export type CanonicalSnapshotQuery = Pick<DbClient, "query">;
/** Admitted scope, valid only inside the reader callback. Display/visibility data from
 * the same-snapshot proof; never a reusable or mutation grant. */
export interface CanonicalSnapshotScope {
 readonly userId: number;
 readonly username: string;
 /** Display label only. */
 readonly role: string;
 readonly realmId: string;
 readonly subjectId: string;
 readonly generationId: string;
 readonly clinicianPartyId: number | null;
 /** Same-snapshot record constraints. A domain read that returns patient or
  * appointment rows must filter by these; `none` never reaches a record read. */
 readonly patientScope: StaffRecordConstraint;
 readonly appointmentScope: StaffRecordConstraint;
 granted(capability: StaffCapability): boolean;
 /** Same-snapshot answer: is the actor the protected owner, for this owner-only
  * operation? Display of what the owner may change; never a mutation grant. */
 ownerMay(operation: OwnerOnlyOperation): boolean;
}
export interface CanonicalSnapshotOptions {
 /** Bounded error-code prefix, e.g. `STAFF_DIRECTORY` → `STAFF_DIRECTORY_DEADLINE`. */
 readonly errorPrefix: string;
 /** Maximum serialized result size in bytes. */
 readonly maxBytes: number;
}

export async function runCanonicalReadSnapshot<T>(
 session: VerifiedDurableSession,
 action: StaffRuntimeAction | CanonicalRecordRead,
 read: (query: CanonicalSnapshotQuery, scope: CanonicalSnapshotScope) => Promise<T>,
 options: CanonicalSnapshotOptions,
): Promise<T> {
 const prefix = options.errorPrefix;
 if (!/^[A-Z][A-Z_]*[A-Z]$/.test(prefix) || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new Error("CANONICAL_SNAPSHOT_OPTIONS_INVALID");
 function refuse(reason: string): never { throw new Error(`${prefix}_${reason}`); }
 function sessionAlive() {
  const claims = revalidateVerifiedDurableSession(session);
  if (!claims) refuse("SESSION_INVALID_OR_EXPIRED");
  return claims;
 }
 const started = performance.now();
 const initialClaims = sessionAlive();
 const expiryDeadline = started + (initialClaims.expiresAt - Date.now());
 const deadline = started + TOTAL_MS;
 function alive() {
  sessionAlive();
  if (performance.now() >= expiryDeadline) refuse("SESSION_INVALID_OR_EXPIRED");
 }
 if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) refuse("EXCLUSIVE_CONNECTION_REQUIRED");
 const pool = (() => {
  try { return getPool(); } catch { refuse("CONNECTION_UNAVAILABLE"); }
 })();
 if (usesSharedLocalDatabaseConnection()) refuse("EXCLUSIVE_CONNECTION_REQUIRED");
 let client: DbClient | undefined;
 let released = false, destroyed = false, locked = false, began = false, cleanLease = false;
 let identity: string | undefined;
 function discard() {
  destroyed = true;
  if (client && !released) {
   released = true;
   try { client.release(true); } catch { /* Already tainted: never publish or recycle. */ }
  }
 }
 async function bounded<R>(work: Promise<R>): Promise<R> {
  const remaining = Math.min(QUERY_MS, deadline - performance.now());
  if (remaining <= 0) { void work.catch(() => undefined); discard(); refuse("DEADLINE"); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
   return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
     try { discard(); } catch { /* Disposal failure never publishes a result. */ }
     reject(new Error(`${prefix}_DEADLINE`));
    }, remaining);
   })]);
  } finally { if (timer) clearTimeout(timer); }
 }
 const query: DbClient["query"] = async (sql, values) => {
  if (!client || destroyed || released) refuse("CONNECTION_UNAVAILABLE");
  if (performance.now() >= deadline) { discard(); refuse("DEADLINE"); }
  try { return await bounded(client.query(sql, values)); }
  catch (error) { discard(); throw error; } // Unknown driver outcome is never recycled.
 };
 async function assertIdentity() {
  alive();
  const {rows} = await query<{virtualxid: string; isolation: string; read_only: string; in_recovery: boolean}>(IDENTITY_SQL);
  if (rows.length !== 1 || typeof rows[0].virtualxid !== "string" || !/^[0-9]+\/[0-9]+$/.test(rows[0].virtualxid) ||
   rows[0].isolation !== "repeatable read" || rows[0].read_only !== "on" || rows[0].in_recovery !== false || (identity !== undefined && rows[0].virtualxid !== identity)) {
   discard(); refuse("TRANSACTION_CHANGED");
  }
  identity = rows[0].virtualxid;
  alive();
 }
 let result: T | undefined;
 let failure: unknown;
 try {
  // A timeout cannot leak a subsequently acquired pool lease.
  const lease = pool.connect().then(acquired => {
   if (destroyed) { acquired.release(true); refuse("DEADLINE"); }
   client = acquired;
   return acquired;
  });
  await bounded(lease);
  alive();
  // We exclusively own this lease; end an abandoned prior transaction before
  // taking our fence. Never inherit a stale RR snapshot from a dirty borrower.
  await query("ROLLBACK");
  const cleanliness = await query<{advisory_locks: number}>(`SELECT count(*)::integer AS advisory_locks
   FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
   AND locktype='advisory' AND granted`);
  if (cleanliness.rows.length !== 1 || cleanliness.rows[0].advisory_locks !== 0) {
   discard(); refuse("DIRTY_CONNECTION");
  }
  cleanLease = true;
  try { await query("SELECT pg_advisory_lock_shared(hashtextextended($1,0))", [FENCE]); locked = true; }
  catch (error) { discard(); throw error; } // Acquisition outcome may be uncertain.
  alive();
  began = true; // BEGIN transport failure still requires cleanup/disposal.
  await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await query("SET LOCAL statement_timeout = '5s'");
  await query("SET LOCAL lock_timeout = '5s'");
  await assertIdentity();
  // Same shared invariants as the writer, without its row locks/XID allocation.
  const rule = isCanonicalRecordRead(action) ? canonicalRecordReadRule(action) : null;
  const proof = rule
   ? await loadCanonicalRecordSnapshotAuthority({query}, session, rule.need, rule.anyOf)
   : await loadCanonicalSnapshotAuthority({query}, session, action as StaffRuntimeAction);
  const patientScope = patientCapabilityConstraint(proof.access);
  const appointmentScope = appointmentCapabilityConstraint(proof.access);
  if (rule && (rule.record === "patient" ? patientScope : appointmentScope).kind === "none") {
   throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  }
  await assertIdentity();
  // Private, serialized facade for this one reader; closed before COMMIT.
  let open = true, inflight = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const facade: CanonicalSnapshotQuery = {
   query: ((sql: string, values?: unknown[]) => {
    if (!open) refuse("READ_CLOSED");
    if (typeof sql !== "string" || FORBIDDEN_SQL.test(sql)) refuse("READ_STATEMENT_FORBIDDEN");
    inflight++;
    const run = chain.then(async () => {
     if (!open) refuse("READ_CLOSED");
     alive();
     return query(sql, values);
    }).finally(() => { inflight--; });
    chain = run.catch(() => undefined);
    return run;
   }) as DbClient["query"],
  };
  const access = proof.access;
  const scope: CanonicalSnapshotScope = Object.freeze({
   userId: proof.identity.userId, username: proof.identity.username, role: proof.identity.role,
   realmId: proof.identity.realmId, subjectId: proof.identity.subjectId, generationId: proof.identity.generationId,
   clinicianPartyId: access.clinicianPartyId,
   patientScope, appointmentScope,
   granted: (capability: StaffCapability) => open && hasStaffCapability(access, capability),
   ownerMay: (operation: OwnerOnlyOperation) => open && canPerformOwnerOperation(access, operation),
  });
  let value: T;
  try { value = await read(facade, scope); }
  finally { open = false; }
  await chain;
  if (inflight !== 0) refuse("READ_DETACHED");
  if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > options.maxBytes) refuse("RESULT_BOUNDS");
  await assertIdentity();
  await query("COMMIT");
  began = false;
  result = value;
  alive();
 } catch (error) {
  failure = error;
  result = undefined;
  if (client && !cleanLease) discard();
 } finally {
  if (!destroyed && client) {
   if (began) {
    try { await query("ROLLBACK"); began = false; }
    catch (error) { failure ??= error; discard(); }
   }
   if (locked && !destroyed) {
    try {
     const {rows} = await query<{unlocked: boolean}>("SELECT pg_advisory_unlock_shared(hashtextextended($1,0)) AS unlocked", [FENCE]);
     if (rows.length !== 1 || rows[0].unlocked !== true) refuse("UNLOCK_FAILED");
     locked = false;
    } catch (error) { failure ??= error; discard(); }
   }
   if (!released) {
    released = true;
    try { client.release(); } catch (error) { failure ??= error; }
   }
  }
 }
 // No buffered data is published on uncertainty, cleanup failure or expiry.
 if (failure) {
  if (failure instanceof Error && new RegExp(`^(${prefix}_|STAFF_OPERATION_|STAFF_RUNTIME_)[A-Z_]+$`).test(failure.message)) throw failure;
  if (isDomainRefusal(failure)) throw failure;
  refuse("READ_FAILED");
 }
 if (result === undefined || destroyed || locked || began || !released) refuse("CLEANUP_FAILED");
 if (performance.now() >= deadline) refuse("DEADLINE");
 alive();
 return result;
}

/** Bounded domain refusals (for example `InventoryDomainError`) may pass through: they
 * carry a fixed code and no driver text. Raw driver errors never do. */
function isDomainRefusal(error: unknown): boolean {
 if (!(error instanceof Error) || error.name === "DatabaseError") return false;
 const code = (error as Error & { code?: unknown }).code;
 return typeof code === "string" && /^[a-z][a-z_]*$/.test(code);
}
