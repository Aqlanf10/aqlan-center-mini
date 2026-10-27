import "server-only";
import { performance } from "node:perf_hooks";
import { getPool, usesSharedLocalDatabaseConnection, type DbClient } from "./db";
import { revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import { loadStaffDirectorySnapshotAuthority } from "./staff-authority-proof-internal";

export interface CanonicalStaffDirectoryRow {
 readonly id: number;
 readonly username: string;
 /** Display label only: neither owner identity nor edit permission. */
 readonly role: string;
 readonly isActive: boolean;
 /** Display-only current active doctor link; never record-scope authority. */
 readonly clinicianPartyId: number | null;
}
export interface CanonicalStaffDirectoryPage {
 readonly rows: readonly Readonly<CanonicalStaffDirectoryRow>[];
 readonly nextAfterUserId: number | null;
}
const FENCE = "aqlan.canonical.identity.substrate.v1:public";
const TOTAL_MS = 10_000;
const QUERY_MS = 5_000;
const MAX_BYTES = 128 * 1024;
const IDENTITY_SQL = `SELECT virtualxid::text AS virtualxid,
 current_setting('transaction_isolation') AS isolation,
 current_setting('transaction_read_only') AS read_only, pg_catalog.pg_is_in_recovery() AS in_recovery
 FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
 AND locktype='virtualxid' AND mode='ExclusiveLock' AND granted`;
function refuse(reason: string): never { throw new Error(`STAFF_DIRECTORY_${reason}`); }
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
function pagination(page: {afterUserId?: number; limit?: number}) {
 if (!page || Object.getPrototypeOf(page) !== Object.prototype) refuse("PAGE_INVALID");
 const fields = Object.getOwnPropertyDescriptors(page);
 if (Reflect.ownKeys(fields).some(key => typeof key !== "string" || !["afterUserId", "limit"].includes(key)) ||
  Object.values(fields).some(field => !("value" in field))) refuse("PAGE_INVALID");
 const afterUserId = fields.afterUserId === undefined ? 0 : fields.afterUserId.value;
 const limit = fields.limit === undefined ? 50 : fields.limit.value;
 if ((afterUserId !== 0 && !id(afterUserId)) || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) refuse("PAGE_INVALID");
 return {afterUserId, limit};
}
function sessionAlive(session: VerifiedDurableSession) {
 const claims = revalidateVerifiedDurableSession(session);
 if (!claims) refuse("SESSION_INVALID_OR_EXPIRED");
 return claims;
}
/** Fixed server-internal owning reader. No caller SQL, pool/schema override,
 * callbacks, streaming, authority-bearing result or reusable read handle.
 * Requires a clean exclusive primary/session-pool lease. This is a synthetic
 * prerequisite, NOT activation or complete authority-writer fence closure.
 * Each keyset page has its own snapshot; pages are not one consistent export. */
export async function readCanonicalStaffDirectory(
 session: VerifiedDurableSession,
 page: {afterUserId?: number; limit?: number} = {},
): Promise<Readonly<CanonicalStaffDirectoryPage>> {
 const {afterUserId, limit} = pagination(page);
 const started = performance.now();
 const initialClaims = sessionAlive(session);
 const expiryDeadline = started + (initialClaims.expiresAt - Date.now());
 const deadline = started + TOTAL_MS;
 function alive() {
  sessionAlive(session);
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
 async function bounded<T>(work: Promise<T>): Promise<T> {
  const remaining = Math.min(QUERY_MS, deadline - performance.now());
  if (remaining <= 0) { void work.catch(() => undefined); discard(); refuse("DEADLINE"); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
   return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
     try { discard(); } catch { /* Disposal failure never publishes a result. */ }
     reject(new Error("STAFF_DIRECTORY_DEADLINE"));
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
 let result: Readonly<CanonicalStaffDirectoryPage> | undefined;
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
  await loadStaffDirectorySnapshotAuthority({query}, session);
  await assertIdentity();
  const {rows} = await query<{id: number; username: unknown; role: unknown; is_active: unknown; clinician_party_id: unknown}>(`
   SELECT u.id,
    CASE WHEN octet_length(u.username)<=800 THEN u.username ELSE NULL END AS username,
    CASE WHEN octet_length(u.role)<=64 THEN u.role ELSE NULL END AS role,
    u.is_active, p.id AS clinician_party_id
   FROM public.users u JOIN public.staff_identity_current b ON b.user_id=u.id
   LEFT JOIN public.parties p ON p.id=u.party_id AND p.kind='doctor' AND p.is_active=TRUE
   WHERE u.authorization_mode='canonical' AND u.id>$1 ORDER BY u.id LIMIT $2`, [afterUserId, limit + 1]);
  if (rows.length > limit + 1) refuse("RESULT_BOUNDS");
  let previous = afterUserId;
  const projected = rows.map(row => {
   if (!id(row.id) || row.id <= previous || typeof row.username !== "string" || row.username.length < 1 || row.username.length > 200 ||
    Buffer.byteLength(row.username, "utf8") > 800 || typeof row.role !== "string" || row.role.length < 1 || Buffer.byteLength(row.role, "utf8") > 64 ||
    typeof row.is_active !== "boolean" || (row.clinician_party_id !== null && !id(row.clinician_party_id))) refuse("RESULT_BOUNDS");
   previous = row.id;
   return Object.freeze({id: row.id, username: row.username, role: row.role, isActive: row.is_active, clinicianPartyId: row.clinician_party_id as number | null});
  });
  result = Object.freeze({rows: Object.freeze(projected.slice(0, limit)), nextAfterUserId: projected.length > limit ? projected[limit - 1].id : null});
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_BYTES) refuse("RESULT_BOUNDS");
  await assertIdentity();
  await query("COMMIT");
  began = false;
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
  if (failure instanceof Error && /^(STAFF_DIRECTORY_|STAFF_OPERATION_|STAFF_RUNTIME_)[A-Z_]+$/.test(failure.message)) throw failure;
  refuse("READ_FAILED");
 }
 if (!result || destroyed || locked || began || !released) refuse("CLEANUP_FAILED");
 if (performance.now() >= deadline) refuse("DEADLINE");
 alive();
 return result;
}
