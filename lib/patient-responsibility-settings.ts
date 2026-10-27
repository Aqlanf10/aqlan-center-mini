import { readResponsibilityRevision } from "./responsibility-revision";
import { createHash } from "node:crypto";
import { ensureSchema, getPool, insertAuditRow, type DbClient } from "./db";
import { revalidateSessionInTransaction } from "./session";
import type { SessionPayload } from "./auth";
export type ResponsibilityTarget = { patientId: number; kind: "clinical" | "ortho"; sourceId: number };
export interface ResponsibilitySettings extends ResponsibilityTarget {
 doctorId: number | null; doctorName: string | null; sourceFingerprint: string; doctors: { id: number; name: string }[];
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
async function authority(client: DbClient, admitted: SessionPayload) {
 const session = await revalidateSessionInTransaction(admitted, client);
 if (!session || session.role !== "admin") reject(403, "تحديد الطبيب المسؤول للمدير فقط بجلسة سارية.");
 return session;
}
export async function patientResponsibilitySettings(target: ResponsibilityTarget, admitted: SessionPayload,
 command?: { expectedSourceFingerprint: string; doctorId: number; reason: string }): Promise<ResponsibilitySettings> {
 if (admitted.role !== "admin") reject(403, "تحديد الطبيب المسؤول للمدير فقط.");
 if (!Number.isSafeInteger(target.patientId) || target.patientId <= 0 || !Number.isSafeInteger(target.sourceId) || target.sourceId <= 0 || !["clinical", "ortho"].includes(target.kind)) reject(400, "مرجع الحالة غير صالح.");
 if (command && (!/^[a-f0-9]{64}$/.test(command.expectedSourceFingerprint) || !Number.isSafeInteger(command.doctorId) || command.doctorId <= 0 || command.reason.trim().length < 3 || command.reason.trim().length > 500)) reject(400, "اختر الطبيب واكتب سبب التغيير.");
 await ensureSchema(); const client = await getPool().connect();
 try {
  await client.query("BEGIN"); const session = await authority(client, admitted);
  const before = await source(client, target, !!command);
  if (command) {
   if (before.sourceFingerprint !== command.expectedSourceFingerprint) reject(409, "تغيّرت المسؤولية منذ عرضها. حدّث البيانات وراجع اختيارك.");
   const { rows: doctor } = await client.query("SELECT id FROM parties WHERE id=$1 AND kind='doctor' AND is_active FOR SHARE NOWAIT", [command.doctorId]);
   if (!doctor.length) reject(409, "الطبيب المختار غير متاح. حدّث القائمة.");
   if (before.ortho) await client.query("UPDATE ortho_cases SET responsible_doctor_id=$2 WHERE id=$1", [before.ortho.id, command.doctorId]);
   if (before.bridges.length) await client.query("UPDATE clinical_cases SET responsible_party_id=$2 WHERE id=ANY($1::int[])", [before.bridges.map(row => row.id), command.doctorId]);
   await authority(client, admitted);
   await insertAuditRow(client, { action: "case.responsibility_change", entity: "patient", entityId: target.patientId,
    actor: session.username, actorRole: session.role, entityLabel: `الحالة ${target.kind}:${target.sourceId}`, details: { target, previous: { ortho: before.ortho, clinical: before.bridges }, doctorId: command.doctorId, reason: command.reason.trim(), actorUserId: session.userId } });
  }
  const after = command ? await source(client, target, false) : before;
  const { rows: doctors } = await client.query<{ id: number; name: string }>("SELECT id,name FROM parties WHERE kind='doctor' AND is_active ORDER BY name,id");
  const { rows: names } = after.doctorId === null ? { rows: [] } : await client.query<{ name: string }>("SELECT name FROM parties WHERE id=$1", [after.doctorId]);
  await authority(client, admitted); await client.query("COMMIT");
  return { ...target, doctorId: after.doctorId, doctorName: names[0]?.name ?? null, sourceFingerprint: after.sourceFingerprint, doctors };
 } catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  if ((error as { code?: string }).code === "55P03") reject(409, "يجري تحديث الحالة. أعد المحاولة بعد لحظة.");
  throw error;
 } finally { client.release(); }
}
