import { getPortalSessionPatient, getSettings } from "./db";
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
  // File-number edits, phone changes, and portal toggle invalidate old sessions immediately.
  try {
    const settings = await getSettings();
    if (settings["portal.enabled"] === "false") return null;
    const patient = await getPortalSessionPatient(payload.patientId);
    if (!patient || patient.patientNumber !== payload.patientNumber) return null;
    if ((patient.portalSecretVersion ?? 0) !== (payload.secretVersion ?? 0)) return null;
    if (!(patient.phone?.trim() || patient.altPhone?.trim())) return null;
    return payload;
  } catch { return null; }
}
