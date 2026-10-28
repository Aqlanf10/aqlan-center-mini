import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { DbClient, DbPool } from "./db";
import { SESSION_DURATION_MS, signDurableSessionClaims, verifyPassword } from "./auth";
import { sessionCredentialVersion } from "./auth";
import { getPool, insertAuditRow, usesSharedLocalDatabaseConnection } from "./db";
import { withIsolation } from "./transactions";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { staffLifecycleLockKey } from "./legacy-staff-schema.mjs";
import { inspectStaffRuntimeSchema } from "./staff-runtime-probe.mjs";
import { readVerifiedDurableSession, revalidateVerifiedDurableSession, type DurableSessionClaims } from "./staff-durable-session";
import { loadLockedIssuanceAuthority, type ProvedAccountAuthority } from "./staff-authority-proof-internal";
import { STAFF_AUTHORIZATION_POLICY_VERSION } from "./staff-capability-catalogue";
import { accountLimitKey, legacyStaffAccountKey, loginLimitKeys, WINDOW_MINUTES } from "./loginLimit";
import { clearAccountLoginLimits, consumeSharedLoginLimits, consumeStaffAccountLimit } from "./login-limit-storage";

/**
 * جهة الإصدار الخاصة لجلسات الطاقم الموحّدة (canonical) — كلمة المرور ← جلسة موقّعة.
 *
 * OWNER_READINESS_AND_ISSUANCE.md §5. تقبل اسمًا وكلمة مرور محدودين فقط، لا ادعاءات
 * ولا دورًا ولا رقم مستخدم بوصفه سلطة. لا تهيئة مخطط أبدًا (لا ensureSchema): الحدّان
 * والبحث على جداول منصّبة سلفًا، وأي غياب أو انحراف يُغلق الباب.
 *
 *  1. جاهزية مقروءة قبل أي تحقق من كلمة المرور: حالة غير جاهزة ترد «صيانة» للجميع،
 *     فلا تكشف صحة كلمة مرورٍ في وضعٍ غير جاهز.
 *  2. الحدّان المستمران (المشترك ثم القديم) بالمفاتيح نفسها قبل scrypt.
 *  3. مرشّح أدنى بلا تهيئة؛ عملٌ وهمي للغائب أو الملتبس؛ التحقق خارج القفل مع حفظ
 *     صورة المرشّح (المعرّف، الاسم، التجزئة، حقبة الحساب).
 *  4. READ COMMITTED + السياج المشترك ثم إثبات كامل مرتّب الأقفال؛ أي تغيّر عن صورة
 *     المرشّح يرفض — لا تُستعمل كلمة مرورٍ قديمة لسلطةٍ جديدة.
 *  5. الادعاءات كلها من الصف المثبت؛ توقيع خاص ثم مرور الشكل الصارم ذهابًا وإيابًا؛
 *     إعادة إثبات وانتهاء بساعة الحائط قبل الالتزام؛ تدقيق ذري؛ لا توكن قبل الالتزام.
 *  6. بعد الالتزام وحده: تصفير عدّاد الحساب (لا المصدر) بأفضل جهد.
 */
export type DurableLoginOutcome =
 | { readonly kind: "issued"; readonly token: string; readonly maxAgeSeconds: number;
     readonly display: Readonly<{ username: string; displayName: string; role: string }> }
 | { readonly kind: "rate_limited"; readonly retryAfterSeconds: number }
 | { readonly kind: "invalid_credentials" }
 | { readonly kind: "unavailable" };

const DUMMY_HASH = "scrypt:0000:0000";
const MAX_USERNAME = 200;
const MAX_PASSWORD = 1024;
/** A token whose remaining life is shorter than this is not worth issuing. */
const MIN_REMAINING_MS = 60_000;
function refuse(reason: string): never { throw new Error(`STAFF_ISSUER_${reason}`); }

async function issuanceReady(pool: DbPool, s: string): Promise<boolean> {
 // SELECT-only readiness preview; NOT authority. The locked proof repeats all of it.
 try {
  await inspectStaffRuntimeSchema(pool, s);
  const { rows } = await pool.query<{ state: string; status: string; aligned: boolean }>(`SELECT c.state, h.status,
   (h.realm_id::text=c.realm_id AND h.ready_control_epoch IS NOT DISTINCT FROM c.binding_epoch) AS aligned
   FROM ${s}.staff_authority_control c CROSS JOIN ${s}.staff_identity_state h WHERE c.singleton AND h.singleton`);
  return rows.length === 1 && rows[0].state === "active" && rows[0].status === "ready" && rows[0].aligned === true;
 } catch { return false; }
}
interface Candidate { readonly id: number; readonly username: string; readonly passwordHash: string; readonly accountEpoch: string }
async function candidate(pool: DbPool, s: string, username: string): Promise<Candidate | null> {
 const { rows } = await pool.query<{ id: number; username: string; password_hash: string; authorization_epoch: string }>(
  `SELECT id, username, password_hash, authorization_epoch::text FROM ${s}.users
   WHERE LOWER(username)=LOWER($1) AND is_active AND authorization_mode='canonical' ORDER BY id LIMIT 2`, [username]);
 // Ambiguous case-insensitive matches never select an account by row order.
 if (rows.length !== 1 || typeof rows[0].password_hash !== "string" || !Number.isSafeInteger(rows[0].id)) return null;
 return Object.freeze({ id: rows[0].id, username: rows[0].username, passwordHash: rows[0].password_hash, accountEpoch: rows[0].authorization_epoch });
}
async function transactionId(client: DbClient): Promise<string> {
 await client.query("SAVEPOINT staff_issuer_transaction_check");
 await client.query("RELEASE SAVEPOINT staff_issuer_transaction_check");
 const { rows } = await client.query<{ xid: string; isolation: string }>("SELECT pg_current_xact_id()::text AS xid, current_setting('transaction_isolation') AS isolation");
 if (rows.length !== 1 || rows[0].isolation !== "read committed") refuse("TRANSACTION_REQUIRED");
 return rows[0].xid;
}
function claimsFrom(proof: ProvedAccountAuthority, expiresAt: number): DurableSessionClaims {
 return {
  userId: proof.user.id, username: proof.user.username, expiresAt,
  durableIdentity: {
   schemaVersion: 2, policyVersion: STAFF_AUTHORIZATION_POLICY_VERSION,
   realmId: proof.realmId, subjectId: proof.subjectId, generationId: proof.generationId,
   registryRevision: proof.registryRevision, controlEpoch: proof.controlEpoch,
   accountEpoch: proof.user.authorizationEpoch, permissionRevision: proof.document.revision,
   credentialVersion: sessionCredentialVersion(proof.user.passwordHash),
   provider: proof.provider === null ? null : { partyId: proof.provider.partyId, clinicalEpoch: proof.provider.clinicalEpoch },
  },
 };
}
function sameTuple(a: ProvedAccountAuthority, b: ProvedAccountAuthority): boolean {
 return a.realmId === b.realmId && a.generationId === b.generationId && a.registryRevision === b.registryRevision
  && a.controlEpoch === b.controlEpoch && a.ownerUserId === b.ownerUserId && a.readyOwnerSubjectId === b.readyOwnerSubjectId
  && a.subjectId === b.subjectId && isDeepStrictEqual(a.user, b.user) && isDeepStrictEqual(a.provider, b.provider)
  && isDeepStrictEqual(a.document, b.document);
}
function matchesCandidate(proof: ProvedAccountAuthority, captured: Candidate): boolean {
 return proof.user.id === captured.id && proof.user.username === captured.username
  && proof.user.passwordHash === captured.passwordHash && proof.user.authorizationEpoch === captured.accountEpoch;
}

/** Test seam: an explicit pool and validated synthetic schema, exactly like the
 * operation runtime. The public route always uses the application pool and "public". */
export async function issueDurableStaffSessionIn(
 pool: DbPool,
 schema: string,
 input: { readonly username: string; readonly password: string; readonly headers: Headers },
): Promise<DurableLoginOutcome> {
 const s = staffIdentitySchemaName(schema);
 const username = typeof input.username === "string" ? input.username.trim() : "";
 const password = typeof input.password === "string" ? input.password : "";
 if (!username || !password) return Object.freeze({ kind: "invalid_credentials" });
 if (!await issuanceReady(pool, s)) return Object.freeze({ kind: "unavailable" });

 const shared = loginLimitKeys("staff", username, input.headers);
 if (shared) {
  const decision = await consumeSharedLoginLimits(pool, shared, WINDOW_MINUTES, s);
  if (!decision.allowed) return Object.freeze({ kind: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds });
 }
 const legacyKey = legacyStaffAccountKey(username);
 const legacyDecision = await consumeStaffAccountLimit(pool, legacyKey, s);
 if (!legacyDecision.allowed) return Object.freeze({ kind: "rate_limited", retryAfterSeconds: legacyDecision.retryAfterSeconds });

 // Over-long input still costs one dummy derivation, like an absent account.
 const captured = username.length <= MAX_USERNAME && password.length <= MAX_PASSWORD ? await candidate(pool, s, username) : null;
 if (!captured) {
  await verifyPassword(password.slice(0, MAX_PASSWORD), DUMMY_HASH);
  return Object.freeze({ kind: "invalid_credentials" });
 }
 if (!await verifyPassword(password, captured.passwordHash)) return Object.freeze({ kind: "invalid_credentials" });

 let staged: { token: string; claims: DurableSessionClaims; proof: ProvedAccountAuthority } | null = null;
 try {
  staged = await withIsolation(pool, "READ COMMITTED", async client => {
   const xid = await transactionId(client);
   await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [staffLifecycleLockKey(s)]);
   const proof = await loadLockedIssuanceAuthority(client, captured.id, s);
   if (!matchesCandidate(proof, captured)) refuse("CANDIDATE_CHANGED");
   const expiresAt = Date.now() + SESSION_DURATION_MS;
   const claims = claimsFrom(proof, expiresAt);
   const token = signDurableSessionClaims(claims);
   const handle = readVerifiedDurableSession(token);
   const parsed = handle ? revalidateVerifiedDurableSession(handle) : null;
   if (!parsed || !isDeepStrictEqual(JSON.parse(JSON.stringify(parsed)), JSON.parse(JSON.stringify(claims)))) refuse("SHAPE_ROUNDTRIP");
   await insertAuditRow(client, {
    action: "auth.canonical_login", entity: "user", entityId: proof.user.id,
    actor: proof.user.username, actorRole: proof.user.role, entityLabel: proof.user.username,
    details: { subjectId: proof.subjectId, generationId: proof.generationId, registryRevision: proof.registryRevision,
     permissionRevision: proof.document.revision, owner: proof.access.isOwner },
   }, s);
   // Fresh precommit proof under the same XID; wall-clock expiry after every wait.
   const final = await loadLockedIssuanceAuthority(client, captured.id, s);
   if (!sameTuple(proof, final) || !matchesCandidate(final, captured)) refuse("AUTHORITY_CHANGED");
   if (await transactionId(client) !== xid) refuse("TRANSACTION_CHANGED");
   if (expiresAt - Date.now() < MIN_REMAINING_MS || !revalidateVerifiedDurableSession(handle!)) refuse("EXPIRED_BEFORE_COMMIT");
   return { token, claims, proof };
  });
 } catch (error) {
  // After a password match every refusal answers like a wrong password: neither a
  // changed candidate, a malformed account document nor a racing lifecycle change
  // may reveal that the password was right. Only the reason code is logged.
  if (error instanceof Error && /^STAFF_(OPERATION|ISSUER|RUNTIME)_[A-Z_]+$/.test(error.message)) {
   console.warn(`[staff-issuer] issuance refused: ${error.message}`);
   return Object.freeze({ kind: "invalid_credentials" });
  }
  throw error;
 }
 // Committed. Account counters only, best effort: failure never creates or blocks a token.
 try {
  const sharedAccount = accountLimitKey("staff", username);
  await clearAccountLoginLimits(pool, legacyKey, sharedAccount ? [sharedAccount] : [], s);
 } catch { /* تصفير العدّاد تحسين — تعذّره لا يمنع دخولًا صحيحًا. */ }
 const remaining = staged.claims.expiresAt - Date.now();
 if (remaining < MIN_REMAINING_MS) return Object.freeze({ kind: "unavailable" });
 return Object.freeze({
  kind: "issued", token: staged.token, maxAgeSeconds: Math.floor(remaining / 1000),
  display: Object.freeze({ username: staged.proof.user.username, displayName: staged.proof.user.displayName || staged.proof.user.username, role: staged.proof.user.role }),
 });
}

/** The only issuance entry for routes: the application pool and the public schema.
 * A shared in-process local database cannot provide the required isolation. */
export async function issueDurableStaffSession(input: { readonly username: string; readonly password: string; readonly headers: Headers }): Promise<DurableLoginOutcome> {
 if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) return Object.freeze({ kind: "unavailable" });
 return issueDurableStaffSessionIn(getPool(), "public", input);
}
