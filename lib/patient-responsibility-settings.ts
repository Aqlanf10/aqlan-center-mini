import { readResponsibilityRevision } from "./responsibility-revision";
import { createHash } from "node:crypto";
import { ensureSchema, getPool, insertAuditRow, type DbClient } from "./db";
import { revalidateSessionInTransaction } from "./session";
import { parseDoctorPermissions } from "./doctor-permissions";
import { canAccessPatient } from "./patient-access";
import type { SessionPayload } from "./auth";
export type ResponsibilityTarget = { patientId: number; kind: "clinical" | "ortho"; sourceId: number };
/** A read-only proposal for a case without a responsible doctor. Never written: only a confirmed save by
 * someone holding canConfirmCaseResponsibility (the audited command below) records responsibility. */
export type ResponsibilitySuggestion = { doctorId: number; doctorName: string; basis: "plan_items" | "primary_doctor" };
export interface ResponsibilitySettings extends ResponsibilityTarget {
 doctorId: number | null; doctorName: string | null; sourceFingerprint: string; doctors: { id: number; name: string }[];
 suggestion: ResponsibilitySuggestion | null; suggestionNote: string | null;
 /** The actor's current grant, re-read in this transaction; the UI offers confirmation only when true. */
 canConfirm: boolean;
}
export class ResponsibilityError extends Error { constructor(public status: number, message: string) { super(message); } }
function reject(status: number, message: string): never { throw new ResponsibilityError(status, message); }
type Clinical = { id: number; patient_id: number; ortho_case_id: number | null; specialty: string; responsible_party_id: number | null; status: string };
type Ortho = { id: number; patient_id: number; responsible_doctor_id: number | null; status: string };
async function source(client: DbClient, target: ResponsibilityTarget, lock: boolean) {
 let orthoId: number | null = target.kind === "ortho" ? target.sourceId : null;
 if (target.kind === "clinical") {
  const { rows: [preview] } = await client.query<Clinical>("SELECT id, patient_id, ortho_case_id, responsible_party_id, status, specialty FROM clinical_cases WHERE id=$1", [target.sourceId]);
  if (!preview || preview.patient_id !== target.patientId) reject(404, "الحالة غير موجودة.");
  orthoId = preview.ortho_case_id;
 }
 const suffix = lock ? " FOR UPDATE NOWAIT" : "";
 let ortho: Ortho | null = null;
 if (orthoId !== null) {
  const { rows: [row] } = await client.query<Ortho>(`SELECT id, patient_id, responsible_doctor_id, status FROM ortho_cases WHERE id=$1${suffix}`, [orthoId]);
  if (!row || row.patient_id !== target.patientId) reject(409, "تغيّر ربط الحالة. حدّث الملف.");
  ortho = row;
 }
 const { rows: bridges } = await client.query<Clinical>(`SELECT id, patient_id, ortho_case_id, responsible_party_id, status, specialty FROM clinical_cases
   WHERE ${orthoId !== null ? "ortho_case_id=$1" : "id=$1"} ORDER BY id${suffix}`, [orthoId ?? target.sourceId]);
 if ((target.kind === "clinical" && !bridges.some(row => row.id === target.sourceId)) || bridges.some(row => row.patient_id !== target.patientId || row.ortho_case_id !== orthoId)) reject(409, "روابط الحالة تحتاج مراجعة.");
 if (ortho && (bridges.length > 1 || bridges.some(row => row.specialty !== "orthodontics"))) reject(409, "ربط حالة التقويم ملتبس أو غير تخصصي؛ راجع الروابط قبل تعديل المسؤولية.");
 if ((!ortho && !bridges.length) || ortho?.status === "cancelled" || bridges.some(row => row.status === "cancelled")) reject(409, "الحالة غير متاحة لتغيير المسؤولية.");
 const doctorId = ortho ? (ortho.responsible_doctor_id ?? (bridges.length === 1 ? bridges[0].responsible_party_id : null)) : bridges[0].responsible_party_id;
 const revision = await readResponsibilityRevision(client, target.patientId, bridges.map(row => row.id), ortho?.id ?? null);
 const sourceFingerprint = createHash("sha256").update(JSON.stringify({ target, ortho, bridges, revision })).digest("hex");
 return { ortho, bridges, doctorId, sourceFingerprint };
}
/** One active doctor recorded on the case's live plan items, else the patient's active primary doctor.
 * Several item doctors are never resolved by guessing: no suggestion, an explicit note instead. */
async function suggest(client: DbClient, patientId: number, caseIds: number[]): Promise<{ suggestion: ResponsibilitySuggestion | null; note: string | null }> {
 const { rows: items } = await client.query<{ doctor_id: number; name: string; active: boolean }>(`SELECT DISTINCT i.doctor_id, p.name, (p.kind='doctor' AND p.is_active) AS active
   FROM plan_items i JOIN parties p ON p.id=i.doctor_id WHERE i.case_id=ANY($1::int[]) AND i.status<>'cancelled' ORDER BY i.doctor_id`, [caseIds]);
 if (items.length > 1) return { suggestion: null, note: "بنود هذه الحالة مسجّلة لأكثر من طبيب؛ اختر الطبيب المسؤول يدويًا." };
 if (items.length === 1 && items[0].active) return { suggestion: { doctorId: items[0].doctor_id, doctorName: items[0].name, basis: "plan_items" }, note: null };
 const { rows: [primary] } = await client.query<{ id: number; name: string }>(`SELECT p.id, p.name FROM patients pt JOIN parties p ON p.id=pt.primary_doctor_id
   WHERE pt.id=$1 AND p.kind='doctor' AND p.is_active`, [patientId]);
 const inactive = items.length === 1 ? "طبيب بنود الحالة غير نشط" : null;
 if (primary) return { suggestion: { doctorId: primary.id, doctorName: primary.name, basis: "primary_doctor" }, note: inactive && `${inactive}؛ المقترح هو الطبيب الأساسي للمريض.` };
 return { suggestion: null, note: inactive && `${inactive} ولا يوجد طبيب أساسي نشط؛ اختر الطبيب يدويًا.` };
}
/** Current authority, decided by the actor's live users.permissions (managed in settings), not by a role name.
 * Re-read under the actor's row lock in this transaction: a grant revoked after the window opened stops the save. */
async function authority(client: DbClient, admitted: SessionPayload, patientId: number, need: "view" | "confirm") {
 const session = await revalidateSessionInTransaction(admitted, client);
 if (!session) reject(403, "انتهت صلاحية الجلسة. سجّل الدخول من جديد.");
 const { rows: [actor] } = await client.query<{ role: string; permissions: unknown }>("SELECT role, permissions FROM users WHERE id=$1 AND is_active FOR SHARE", [session.userId]);
 if (!actor || actor.role !== session.role) reject(403, "انتهت صلاحية الجلسة. سجّل الدخول من جديد.");
 const granted = parseDoctorPermissions(actor.permissions, actor.role);
 const canConfirm = granted.canConfirmCaseResponsibility === true;
 if (need === "confirm" && !canConfirm) reject(403, "اعتماد الطبيب المسؤول يحتاج صلاحية تمنحها الإدارة من الإعدادات.");
 if (need === "view" && !canConfirm && granted.canViewResponsibilitySuggestion !== true) reject(403, "عرض مسؤولية الحالة يحتاج صلاحية تمنحها الإدارة من الإعدادات.");
 if (!await canAccessPatient(session, patientId, undefined, client)) reject(403, "غير مصرّح لك بملف هذا المريض.");
 return { session, canConfirm };
}
export async function patientResponsibilitySettings(target: ResponsibilityTarget, admitted: SessionPayload,
 command?: { expectedSourceFingerprint: string; doctorId: number; reason: string }): Promise<ResponsibilitySettings> {
 if (!Number.isSafeInteger(target.patientId) || target.patientId <= 0 || !Number.isSafeInteger(target.sourceId) || target.sourceId <= 0 || !["clinical", "ortho"].includes(target.kind)) reject(400, "مرجع الحالة غير صالح.");
 if (command && (!/^[a-f0-9]{64}$/.test(command.expectedSourceFingerprint) || !Number.isSafeInteger(command.doctorId) || command.doctorId <= 0 || command.reason.trim().length < 3 || command.reason.trim().length > 500)) reject(400, "اختر الطبيب واكتب سبب التغيير.");
 await ensureSchema(); const client = await getPool().connect();
 try {
  const need = command ? "confirm" as const : "view" as const;
  await client.query("BEGIN"); const { session } = await authority(client, admitted, target.patientId, need);
  const before = await source(client, target, !!command);
  if (command) {
   if (before.sourceFingerprint !== command.expectedSourceFingerprint) reject(409, "تغيّرت المسؤولية منذ عرضها. حدّث البيانات وراجع اختيارك.");
   const { rows: doctor } = await client.query("SELECT id FROM parties WHERE id=$1 AND kind='doctor' AND is_active FOR SHARE NOWAIT", [command.doctorId]);
   if (!doctor.length) reject(409, "الطبيب المختار غير متاح. حدّث القائمة.");
   if (before.ortho) await client.query("UPDATE ortho_cases SET responsible_doctor_id=$2 WHERE id=$1", [before.ortho.id, command.doctorId]);
   if (before.bridges.length) await client.query("UPDATE clinical_cases SET responsible_party_id=$2 WHERE id=ANY($1::int[])", [before.bridges.map(row => row.id), command.doctorId]);
   await authority(client, admitted, target.patientId, "confirm");
   await insertAuditRow(client, { action: "case.responsibility_change", entity: "patient", entityId: target.patientId,
    actor: session.username, actorRole: session.role, entityLabel: `الحالة ${target.kind}:${target.sourceId}`, details: { target, previous: { ortho: before.ortho, clinical: before.bridges }, doctorId: command.doctorId, reason: command.reason.trim(), actorUserId: session.userId } });
  }
  const after = command ? await source(client, target, false) : before;
  const { canConfirm } = await authority(client, admitted, target.patientId, need);
  const { rows: doctors } = canConfirm ? await client.query<{ id: number; name: string }>("SELECT id,name FROM parties WHERE kind='doctor' AND is_active ORDER BY name,id") : { rows: [] };
  const { rows: names } = after.doctorId === null ? { rows: [] } : await client.query<{ name: string }>("SELECT name FROM parties WHERE id=$1", [after.doctorId]);
  const proposal = after.doctorId === null ? await suggest(client, target.patientId, after.bridges.map(row => row.id)) : { suggestion: null, note: null };
  await client.query("COMMIT");
  return { ...target, doctorId: after.doctorId, doctorName: names[0]?.name ?? null, sourceFingerprint: after.sourceFingerprint, doctors,
   suggestion: proposal.suggestion, suggestionNote: proposal.note, canConfirm };
 } catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  if ((error as { code?: string }).code === "55P03") reject(409, "يجري تحديث الحالة. أعد المحاولة بعد لحظة.");
  throw error;
 } finally { client.release(); }
}
