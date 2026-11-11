import { cookies } from "next/headers";
import { getPatient } from "./db";
import {
  PORTAL_ADMIN_PREVIEW_COOKIE,
  PORTAL_COOKIE,
  readPortalAdminPreviewToken,
  readPortalToken,
  type PortalPayload,
} from "./portal";
import {
  getPortalStaffAccess,
  verifyLivePortalPatientSession,
} from "./portal-security";
import { requireSessionStrict } from "./session";

/**
 * جلسة البوابة على الخادم — بصلابة جلسة الطاقم وإبطالٍ فوري على القاعدة.
 *
 * مساران معزولان ومفحوصان حيًّا في كل طلب:
 *  ١) **معاينة إدارية للقراءة فقط (`aqlan_portal_preview`)**: مقترنة بجلسة الموظف الحية
 *     (`requireSessionStrict`) وبتحقق حي من صلاحية المالك أو الإدارة المخوّلة (`canPreviewPortal`).
 *     تُرجع `session.adminPreview` ليُظهر الشريط الإداري ويمنع أي عملية كتابة باسم المريض.
 *  ٢) **جلسة المريض الفعلية (`aqlan_portal_session`)**: مفحوصة حيًّا مقابل `patient_portal_accounts`
 *     (`status = 'active'`، ومطابقة `credential_version`، وعدم إبطال الجلسة أو تغيّر الهاتف أو حذف/دمج الملف).
 */
export async function requirePortalSession(): Promise<PortalPayload | null> {
  const store = await cookies();

  const previewRaw = store.get(PORTAL_ADMIN_PREVIEW_COOKIE)?.value;
  if (previewRaw) {
    const preview = readPortalAdminPreviewToken(previewRaw);
    if (preview) {
      const staffSession = await requireSessionStrict();
      if (staffSession && staffSession.userId === preview.staffUserId) {
        const access = await getPortalStaffAccess(staffSession.userId);
        if (access?.isActive && access.canPreviewPortal) {
          const patient = await getPatient(preview.patientId);
          if (patient) {
            return {
              patientId: patient.id,
              patientNumber: patient.patientNumber,
              fullName: patient.fullName,
              expiresAt: preview.expiresAt,
              adminPreview: {
                staffUserId: access.userId,
                staffUsername: access.username,
                staffDisplayName: access.displayName,
                staffRole: access.role,
                reason: preview.reason,
                startedAt: preview.startedAt,
                expiresAt: preview.expiresAt,
              },
            };
          }
        }
      }
    }
  }

  const parsed = readPortalToken(store.get(PORTAL_COOKIE)?.value);
  if (!parsed) return null;

  const live = await verifyLivePortalPatientSession(parsed);
  if (!live) return null;

  return {
    ...parsed,
    patientId: live.patientId,
    patientNumber: live.patientNumber,
    fullName: live.fullName,
  };
}
