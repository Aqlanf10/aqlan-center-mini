import { createHash } from "node:crypto";
import { ensureSchema, getPool, insertAuditRow } from "./db";
import { cookies } from "next/headers";
import { PORTAL_COOKIE, readPortalToken, type PortalPayload } from "./portal";

/**
 * جلسة البوابة على الخادم — بصلابة جلسة الطاقم لا أقل.
 *
 * `middleware` قد يمرر ما عدا المسارات المعلنة، فالحارس الحقيقي هنا: كل مسار
 * بوابة يستدعي `requirePortalSession()` قبل أي قراءة، والتوقيع بمجال منفصل عن
 * توقيع الطاقم فتوكن الطاقم لا يفتح البوابة ولا العكس.
 */
export async function requirePortalSession(): Promise<PortalPayload | null> {
  const store = await cookies();
  const token = store.get(PORTAL_COOKIE)?.value;
  const payload = readPortalToken(token);
  if (!payload || !token) return null;
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `SELECT p.id FROM patients p WHERE p.id=$1 AND p.patient_number=$2 AND NOT EXISTS (
        SELECT 1 FROM audit_log WHERE entity='portal_session' AND entity_id=$3 AND action='portal.session_revoked')`,
      [payload.patientId, payload.patientNumber, createHash("sha256").update(token).digest("hex")]);
    return rows.length === 1 ? payload : null;
  } catch { return null; }
}

/** Fail closed: do not report logout success unless this copied token is revoked too.
 * The existing indexed audit store contains only a one-way fingerprint, never the token.
 * Staff sessions, permissions and the pending identity subsystem are unaffected.
 */
export async function revokePortalSession(): Promise<void> {
  const token = (await cookies()).get(PORTAL_COOKIE)?.value;
  const payload = readPortalToken(token);
  if (!payload || !token) return;
  await ensureSchema();
  await insertAuditRow(getPool(), { action: "portal.session_revoked", entity: "portal_session",
    entityId: createHash("sha256").update(token).digest("hex"), actor: "بوابة المريض",
    details: { expiresAt: payload.expiresAt } });
}
