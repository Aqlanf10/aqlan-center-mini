import type { SessionPayload } from "./auth";
import { findUserByUsername, type DbClient } from "./db";
import { canAccessPatient } from "./patient-access";
import { requireSession } from "./session";
/** Newly authored after filesystem discontinuity. Requires fresh independent review. */
export class AssessmentStoreFault extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function assessmentFail(status: number, code: string, message: string): never {
  throw new AssessmentStoreFault(status, code, message);
}
export interface AssessmentAuthority {
  session: SessionPayload; actorId: number; actorName: string;
  clinicalWritable: boolean; imagingVisible: boolean;
}
export interface AssessmentOwnerInput { session: SessionPayload; patientId: number; orthoCaseId: number }
export const assessmentPositiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
/** Call first within the transaction, before source/case locks. Initial route
 * identity is admission only; patient→current user/access witnesses is held order.
 */
export async function authorizeAssessment(client: DbClient, input: AssessmentOwnerInput, write: boolean): Promise<AssessmentAuthority> {
  if (!assessmentPositiveId(input.patientId) || !assessmentPositiveId(input.orthoCaseId))
    assessmentFail(400,"invalid_scope","معرّف المريض أو حالة التقويم غير صالح.");
  const patient = await client.query<{ id: number }>(
    `SELECT id FROM patients WHERE id = $1 ${write ? "FOR NO KEY UPDATE" : "FOR SHARE"}`, [input.patientId]);
  // Even a missing patient is not reported before current session/role validation.
  const session = await requireSession(client);
  if (!session || !assessmentPositiveId(session.userId) || session.expiresAt < Date.now()
    || session.userId !== input.session.userId || session.username !== input.session.username || session.role !== input.session.role)
    assessmentFail(401,"session_expired","انتهت الجلسة أو تغيرت صلاحياتها.");
  const actor = await findUserByUsername(session.username,client);
  if (!actor || !actor.isActive || actor.id !== session.userId || actor.role !== session.role
    || actor.username.toLowerCase() !== session.username.toLowerCase()) assessmentFail(401,"session_expired","تعذّر التحقق من الحساب الحالي.");
  const clinicalWritable = session.role === "doctor" || session.role === "admin";
  if (!clinicalWritable && session.role !== "reception") assessmentFail(403,"clinical_read_denied","عرض التقييم غير متاح لهذا الدور.");
  if (write && !clinicalWritable) assessmentFail(403,"clinical_edit_denied","تدوين التقييم متاح للطبيب والمدير فقط.");
  if (!patient.rows[0]) assessmentFail(404,"patient_not_found","لم يُعثر على ملف المريض.");
  if (!await canAccessPatient(session,input.patientId,undefined,client)) assessmentFail(403,"patient_access_denied","غير مصرّح لك بملف هذا المريض.");
  const imagingVisible = await canAccessPatient(session,input.patientId,"canViewXrays",client);
  return { session,actorId:actor.id,actorName:actor.displayName,clinicalWritable,imagingVisible };
}
export function assertAssessmentAuthorityCurrent(authority: AssessmentAuthority): void {
  // User/positive access witnesses remain held; time expiry must still be checked.
  if (authority.session.expiresAt < Date.now()) assessmentFail(401,"session_expired","انتهت الجلسة؛ أعد تسجيل الدخول.");
}
