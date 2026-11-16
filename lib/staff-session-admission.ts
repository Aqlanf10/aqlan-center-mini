import "server-only";
import { cookies, headers } from "next/headers";
import type { DbClient, DbPool } from "./db";
import { getPool, usesSharedLocalDatabaseConnection } from "./db";
import { SESSION_COOKIE, hasCanonicalSessionMarker, readSignedSessionEnvelope } from "./auth";
import { withIsolation } from "./transactions";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { staffLifecycleLockKey } from "./legacy-staff-schema.mjs";
import { readVerifiedDurableSession, revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import { loadLockedSessionAuthority } from "./staff-authority-proof-internal";
import { hasStaffCapability, patientCapabilityConstraint, appointmentCapabilityConstraint } from "./staff-capabilities";
import { STAFF_CAPABILITIES, type StaffCapability } from "./staff-capability-catalogue";

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
