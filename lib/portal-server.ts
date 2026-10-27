import { getPatient } from "./db";
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
  const payload = readPortalToken(store.get(PORTAL_COOKIE)?.value);
  if (!payload) return null;
  // File-number edits invalidate the old login alias, never transfer an ID/session.
  try {
    const patient = await getPatient(payload.patientId);
    return patient?.patientNumber === payload.patientNumber ? payload : null;
  } catch { return null; }
}
