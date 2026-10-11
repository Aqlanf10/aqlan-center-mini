import type { SessionPayload } from "./auth";
import { findUserByUsername, type DbClient } from "./db";
import { canAccessPatient } from "./patient-access";
import { requireSession } from "./session";
export class OrthoLifecycleFault extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function lifecycleFail(status: number, code: string, message: string): never {
  throw new OrthoLifecycleFault(status, code, message);
}
export interface LifecycleOwner { patientId: number; session: SessionPayload }
export interface LifecycleAuthority { session: SessionPayload; actorId: number; actorName: string; writable: boolean; canLinkPlan: boolean; planVisible: boolean }
/** New-case intake has no Ortho ID. Never fabricate an ID to reuse an existing-case authorizer. */
export async function authorizeOrthoLifecycle(client: DbClient, input: LifecycleOwner, write: boolean): Promise<LifecycleAuthority> {
  if (!Number.isSafeInteger(input.patientId) || input.patientId <= 0) lifecycleFail(400, "invalid_patient", "رقم المريض غير صالح.");
  const patient = await client.query(`SELECT id FROM patients WHERE id=$1 ${write ? "FOR NO KEY UPDATE" : "FOR SHARE"}`, [input.patientId]);
  const session = await requireSession(client);
  if (!session || !Number.isSafeInteger(session.userId) || (session.userId ?? 0) <= 0 || session.expiresAt < Date.now()
    || session.userId !== input.session.userId || session.username !== input.session.username || session.role !== input.session.role)
    lifecycleFail(401, "session_changed", "انتهت الجلسة أو تغيرت صلاحياتها.");
  const actor = await findUserByUsername(session.username, client);
  if (!actor || !actor.isActive || actor.id !== session.userId || actor.role !== session.role
    || actor.username.toLowerCase() !== session.username.toLowerCase()) lifecycleFail(401, "session_changed", "تعذّر التحقق من الحساب الحالي.");
  const writable = session.role === "admin" || session.role === "doctor";
  if (!writable && session.role !== "reception") lifecycleFail(403, "clinical_read_denied", "عرض حالة التقويم غير متاح لهذا الدور.");
  if (write && !writable) lifecycleFail(403, "clinical_edit_denied", "تدوين بداية الحالة أو إلغائها متاح للطبيب والمدير.");
  if (!patient.rows[0]) lifecycleFail(404, "patient_missing", "ملف المريض غير متاح.");
  if (!await canAccessPatient(session, input.patientId, undefined, client)) lifecycleFail(403, "patient_access_denied", "غير مصرّح لك بملف هذا المريض.");
  // Same current policy as the canonical Ortho plan-link route; this is not clinical approval.
  const canLinkPlan = session.role === "admin" || session.role === "reception" || session.role === "doctor" && actor.permissions?.canEditPlans !== false;
  const planVisible = await canAccessPatient(session,input.patientId,"canViewPlans",client);
  return { session, actorId: actor.id, actorName: actor.displayName, writable, canLinkPlan, planVisible };
}
export function assertLifecycleCurrent(authority: LifecycleAuthority): void {
  if (authority.session.expiresAt < Date.now()) lifecycleFail(401, "session_expired", "انتهت الجلسة؛ أعد تسجيل الدخول.");
}
