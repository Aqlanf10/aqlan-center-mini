import { doctorOwnsPatient, findUserByUsername, patientHasVisitToday, type DbClient } from "./db";
import type { SessionPayload } from "./auth";
import type { DoctorPermissions } from "./doctor-permissions";
import { canViewMoney } from "./roles";

/** حارس مشترك للبيانات الطبية والطباعة؛ فشل القراءة أو غياب الربط لا يفتح ملفًا. */
export async function canAccessPatient(
  session: SessionPayload,
  patientId: number,
  permission?: keyof DoctorPermissions,
  client?: DbClient,
): Promise<boolean> {
  if (client && session.expiresAt < Date.now()) return false;
  if (session.role === "admin" || session.role === "reception") return true;
  /* (P0-F) المساعد السريري: مرضى زيارات اليوم وحدهم — وبلا صلاحيات طبيبٍ إضافية (مدفوعات، أشعة…). */
  if (session.role === "assistant") {
    if (permission) return false;
    const allowed = await (client ? patientHasVisitToday(patientId, client) : patientHasVisitToday(patientId)).catch(() => false);
    return allowed && (!client || session.expiresAt >= Date.now());
  }
  if (session.role !== "doctor") return false;
  try {
    const user = client ? await findUserByUsername(session.username, client) : await findUserByUsername(session.username);
    if (!user || !user.isActive || (client && session.expiresAt < Date.now())) return false;
    if (permission && user.permissions?.[permission] !== true) return false;
    if (user.permissions?.canViewAllPatients) return true;
    if (!user.partyId) return false;
    const allowed = await (client ? doctorOwnsPatient(user.partyId, patientId, client) : doctorOwnsPatient(user.partyId, patientId));
    return allowed && (!client || session.expiresAt >= Date.now());
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
