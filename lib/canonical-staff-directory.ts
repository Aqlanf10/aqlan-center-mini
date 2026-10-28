import "server-only";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";

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
const MAX_BYTES = 128 * 1024;
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
/** Fixed server-internal owning reader on the generic canonical RR snapshot
 * (`lib/canonical-read-snapshot.ts`, which owns lease, fence, identity, admission,
 * bounds and cleanup). No caller SQL, pool/schema override, callbacks, streaming,
 * authority-bearing result or reusable read handle. This is a synthetic
 * prerequisite, NOT activation or complete authority-writer fence closure.
 * Each keyset page has its own snapshot; pages are not one consistent export. */
export async function readCanonicalStaffDirectory(
 session: VerifiedDurableSession,
 page: {afterUserId?: number; limit?: number} = {},
): Promise<Readonly<CanonicalStaffDirectoryPage>> {
 const {afterUserId, limit} = pagination(page);
 return runCanonicalReadSnapshot(session, "staff.view", async ({query}) => {
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
  return Object.freeze({rows: Object.freeze(projected.slice(0, limit)), nextAfterUserId: projected.length > limit ? projected[limit - 1].id : null});
 }, {errorPrefix: "STAFF_DIRECTORY", maxBytes: MAX_BYTES});
}
