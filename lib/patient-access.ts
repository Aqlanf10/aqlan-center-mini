import { doctorOwnsPatient, findUserByUsername } from "./db";
import type { SessionPayload } from "./auth";
import type { DoctorPermissions } from "./doctor-permissions";

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
