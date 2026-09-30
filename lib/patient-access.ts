import { doctorOwnsPatient, findUserByUsername } from "./db";
import type { SessionPayload } from "./auth";
import type { DoctorPermissions } from "./doctor-permissions";
import { canViewMoney } from "./roles";

/** حارس مشترك للبيانات الطبية والطباعة؛ فشل القراءة أو غياب الربط لا يفتح ملفًا. */
export async function canAccessPatient(
  session: SessionPayload,
  patientId: number,
  permission?: keyof DoctorPermissions,
): Promise<boolean> {
  if (session.role === "admin" || session.role === "reception") return true;
  if (session.role !== "doctor") return false;
  try {
    const user = await findUserByUsername(session.username);
    if (!user || !user.isActive) return false;
    if (permission && user.permissions?.[permission] !== true) return false;
    if (user.permissions?.canViewAllPatients) return true;
    if (!user.partyId) return false;
    return await doctorOwnsPatient(user.partyId, patientId);
  } catch { return false; }
}

/**
 * (PAT-4) من يرى مال مريضٍ بعينه — القاعدة نفسها التي يحرس بها `/api/patients/[id]/ledger` كشف
 * الحساب: من يقرأ المال (المدير والاستقبال والكاشير والمحاسب)، والطبيب بصلاحية «مدفوعات مرضاي»
 * وحدها ومع عزله (مرضاه فقط). لا قاعدة جديدة — استخراجٌ للقائمة كما هي.
 */
export async function canViewPatientMoney(session: SessionPayload, patientId: number): Promise<boolean> {
  if (session.role === "doctor") return canAccessPatient(session, patientId, "canViewPatientPayments");
  return canViewMoney(session.role);
}
