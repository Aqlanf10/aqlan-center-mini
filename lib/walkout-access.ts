import type { SessionPayload } from "./auth";
import { canAccessPatient } from "./patient-access";
import { canHandleMoney } from "./roles";

/**
 * (CHAIR-1 Slice 5) من يرى ملخّص المغادرة — وفيه أسعارٌ وسندات ورصيد.
 *
 * من يلمس المال (المدير والاستقبال) لأي مريض، والطبيب لمرضاه بصلاحية «مدفوعات مرضاي» وحدها.
 * زيارة المشي بلا ملف: لمن يلمس المال وحده. الفحص في الخادم لا في الشاشة.
 */
export async function canSeeWalkout(session: SessionPayload, patientId: number | null): Promise<boolean> {
  if (canHandleMoney(session.role) && session.role !== "cashier") return true;
  if (session.role !== "doctor" || patientId === null) return false;
  return canAccessPatient(session, patientId, "canViewPatientPayments");
}
