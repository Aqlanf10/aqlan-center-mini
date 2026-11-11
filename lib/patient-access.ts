import { doctorOwnsPatient, findUserByUsername, patientHasVisitToday, type DbClient } from "./db";
import type { SessionPayload } from "./auth";
import type { DoctorPermissions } from "./doctor-permissions";
import { canViewMoney } from "./roles";

/** خطأ محكوم عند محاولة وصول أو كتابة خارج نطاق مرضى الطبيب المقيّد. */
export class PatientOutOfScopeError extends Error {
  readonly status = 403;
  constructor(message = "هذا المريض خارج نطاق صلاحيتك السريرية.") {
    super(message);
    this.name = "PatientOutOfScopeError";
  }
}

export type RestrictedDoctorScope =
  | { restricted: false; doctorPartyId: null; blockAllPatients: false }
  | { restricted: true; doctorPartyId: number | null; blockAllPatients: boolean };

/**
 * يحسم نطاق الطبيب المقيّد من قاعدة البيانات (أو داخل المعاملة الجارية):
 * - غير الطبيب، أو الطبيب الممنوح `canViewAllPatients === true`: غير مقيّد (`restricted: false`).
 * - الطبيب المقيّد: يعيد `doctorPartyId` الفاعل، أو `blockAllPatients: true` عند غياب الربط/تعطيل الحساب (فشل مغلق).
 */
export async function resolveRestrictedDoctorScope(
  session: SessionPayload,
  client?: DbClient,
): Promise<RestrictedDoctorScope> {
  if (session.role !== "doctor") {
    return { restricted: false, doctorPartyId: null, blockAllPatients: false };
  }
  if (client && session.expiresAt < Date.now()) {
    return { restricted: true, doctorPartyId: null, blockAllPatients: true };
  }
  try {
    const user = client
      ? await findUserByUsername(session.username, client)
      : await findUserByUsername(session.username);
    if (
      !user ||
      !user.isActive ||
      user.id !== session.userId ||
      user.role !== "doctor" ||
      (client && session.expiresAt < Date.now())
    ) {
      return { restricted: true, doctorPartyId: null, blockAllPatients: true };
    }
    if (user.permissions?.canViewAllPatients === true) {
      return { restricted: false, doctorPartyId: null, blockAllPatients: false };
    }
    const partyId =
      typeof user.partyId === "number" && Number.isSafeInteger(user.partyId) && user.partyId > 0
        ? user.partyId
        : null;
    return { restricted: true, doctorPartyId: partyId, blockAllPatients: partyId === null };
  } catch {
    return { restricted: true, doctorPartyId: null, blockAllPatients: true };
  }
}

/** حارس مشترك للبيانات الطبية والطباعة؛ فشل القراءة أو غياب الربط لا يفتح ملفًا. */
export async function canAccessPatient(
  session: SessionPayload,
  patientId: number,
  permission?: keyof DoctorPermissions,
  client?: DbClient,
  ownershipLockMode?: "nowait",
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
    const allowed = await (client ? (ownershipLockMode ? doctorOwnsPatient(user.partyId, patientId, client, ownershipLockMode) : doctorOwnsPatient(user.partyId, patientId, client)) : doctorOwnsPatient(user.partyId, patientId));
    return allowed && (!client || session.expiresAt >= Date.now());
  } catch (error) {
    // A composed writer may already hold another planned row. Its ownership
    // witnesses must fail closed without waiting in the opposite row order.
    if (ownershipLockMode === "nowait" && (error as { code?: string }).code === "55P03") throw error;
    return false;
  }
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
