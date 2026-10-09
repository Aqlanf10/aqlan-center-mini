import { findUserByUsername, type DbClient } from "./db";
import type { SessionPayload } from "./auth";
import { canAccessPatient } from "./patient-access";

/**
 * (ORTHO-ID-2) تفويض ربط دراسة السيفالو بالحالة — يُنفَّذ **داخل معاملة الحفظ** لا في المسار قبلها.
 *
 * الحساب يُقرأ حيًّا بقفل مشترك (`findUserByUsername(..., client)`): حسابٌ عُطّل أو دورٌ تغيّر أثناء انتظار الطلب ⇒ منع.
 * ثم الحارس القانوني نفسه `canAccessPatient(..., "canUploadXrays", client)` بأقفال شهود الملكية: صلاحية أشعةٍ سُحبت أو
 * مريضٌ لم يعد مريض الطبيب ⇒ منع؛ وانتهاء الجلسة يُرفض لأن الحارس يقرأ `expiresAt` عند تمرير اتصال المعاملة.
 * تعديلٌ متزامن للحساب أو الملكية إما يسبق هذا الفحص فيراه، أو ينتظر انتهاء معاملة الربط — لا يتسلل بينهما.
 */
export function cephLinkAuthorizer(session: SessionPayload) {
  return async (client: DbClient, patientId: number): Promise<boolean> => {
    const user = await findUserByUsername(session.username, client);
    if (!user || user.role !== session.role) return false;
    return canAccessPatient(session, patientId, "canUploadXrays", client);
  };
}
