import type { DbClient } from "./db";
import type { SessionPayload } from "./auth";
import { canAccessPatient } from "./patient-access";
import { revalidateSessionInTransaction } from "./session";

/**
 * (ORTHO-ID-2) تفويض ربط دراسة السيفالو بالحالة — يُنفَّذ **داخل معاملة الحفظ** لا في المسار قبلها.
 *
 * 1) الهوية: `revalidateSessionInTransaction` — نفس مُحقِّق الجلسة المعتمد في النظام على اتصال المعاملة: المستخدم نفسه
 *    فعّال وبالدور نفسه، وإصدار بيانات الدخول (credentialVersion) ما زال إصدار الجلسة؛ فتغيّر كلمة المرور أثناء انتظار
 *    الطلب يجعل الجلسة قديمة ⇒ رفض. القراءة بقفل مشترك على صف المستخدم فلا يتسلل تعديلٌ بين الفحص والكتابة.
 * 2) النطاق: الحارس القانوني `canAccessPatient(..., "canUploadXrays", client)` بأقفال شهود الملكية — صلاحية أشعةٍ سُحبت أو
 *    مريضٌ لم يعد مريض الطبيب ⇒ رفض؛ وانتهاء الجلسة يُرفض لأن الحارس يقرأ `expiresAt` عند تمرير اتصال المعاملة.
 */
export function cephLinkAuthorizer(session: SessionPayload) {
  return async (client: DbClient, patientId: number): Promise<boolean> => {
    const live = await revalidateSessionInTransaction(session, client);
    if (!live) return false;
    return canAccessPatient(live, patientId, "canUploadXrays", client);
  };
}

/**
 * (ORTHO-ID-3) المُفوِّض نفسه لكل كتابة سيفالو تُنفَّذ داخل معاملتها: إنشاء دراسة، اعتمادها، رفضها، تصحيحها. صلاحية الأشعة
 * والجلسة والمريض تُفحص على **هوية الدراسة الحالية** داخل المعاملة لا على ما رآه المسار قبلها.
 */
export const cephWriteAuthorizer = cephLinkAuthorizer;
