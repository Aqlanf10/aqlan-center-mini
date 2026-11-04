import { createHash } from 'node:crypto';
import type { SessionPayload } from './auth';
import { ensureSchema, findUserByUsername, getPool, insertAuditRow, type DbClient } from './db';
import { revalidateSessionInTransaction } from './session';
import { canAccessPatient } from './patient-access';
import { clinicalCapabilityOf } from './clinical-identity';
import { withTransaction } from './transactions';
import { resolveClinicZone } from './clinicZone';
import { parseRadiologyCenters, RADIOLOGY_CENTERS_KEY } from './radiology-centers';
import { canonicalRadiologyRequest, decodeRadiologySnapshot, type RadiologyRequestDraft, type RadiologyRequestSnapshot } from './radiology-request';
export class RadiologyRequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function refuse(status: number, message: string): never { throw new RadiologyRequestError(status, message); }
type Row = { command_key: string; actor_user_id: number; actor_username: string; patient_id: number; visit_id: number | null; doctor_party_id: number; payload_sha256: string; snapshot: RadiologyRequestSnapshot; created_at: Date };
const publicRecord = (row: Row) => ({ id: row.command_key, patientId: row.patient_id, visitId: row.visit_id, snapshot: decodeRadiologySnapshot(row.snapshot,row.patient_id,row.visit_id,row.doctor_party_id), createdAt: row.created_at.toISOString() });
async function authorize(client: DbClient, admitted: SessionPayload, patientId: number, visitId: number | null, issue: boolean) {
  const session = await revalidateSessionInTransaction(admitted, client);
  if (!session) refuse(403, 'تغيّرت صلاحية الجلسة؛ سجّل الدخول من جديد.');
  const user = await findUserByUsername(session.username, client);
  if (!user) refuse(403, 'الحساب غير متاح.');
  const capability = clinicalCapabilityOf({ role: user.role, doctorPartyId: user.partyId });
  let doctor: { id: number; name: string } | null = null;
  if (capability.ok && capability.partyId) {
    const { rows } = await client.query<{ id: number; name: string; kind: string; is_active: boolean }>('SELECT id,name,kind,is_active FROM parties WHERE id=$1 FOR SHARE NOWAIT', [capability.partyId]);
    if (rows[0]?.kind === 'doctor' && rows[0].is_active && rows[0].name.trim()) doctor = rows[0];
  }
  if (!doctor && (issue || user.role !== 'reception' || user.permissions?.canPrintRadiologyRequests !== true)) refuse(403, 'لا تملك صلاحية إصدار أو طباعة طلبات الأشعة.');
  if (visitId !== null) {
    const { rows } = await client.query<{ patient_id: number | null }>('SELECT patient_id FROM visits WHERE id=$1 FOR SHARE NOWAIT', [visitId]);
    if (rows[0]?.patient_id !== patientId) refuse(404, 'الزيارة لا تطابق الملف.');
  }
  const { rows: patients } = await client.query<{ full_name: string }>('SELECT full_name FROM patients WHERE id=$1 FOR SHARE NOWAIT', [patientId]);
  if (!patients[0]) refuse(404, 'المريض غير موجود.');
  if (!await canAccessPatient(session, patientId, undefined, client, 'nowait')) refuse(403, 'غير مصرح بالوصول إلى هذا الملف.');
  if (session.expiresAt < Date.now()) refuse(403, 'انتهت الجلسة.');
  return { session, doctor, patientName: patients[0].full_name };
}
function finalAuthority(session: SessionPayload) { if (session.expiresAt < Date.now()) refuse(403, 'انتهت الجلسة.'); }
/** One key lock, one inserted immutable row + one awaited audit, all or nothing.
 * No lease/reclaim, no pending row, no automatic replay under a new key. */
export async function issueRadiologyRequest(session: SessionPayload, key: string, draft: RadiologyRequestDraft) {
  await ensureSchema();
  const hash = createHash('sha256').update(JSON.stringify([session.userId, session.username, canonicalRadiologyRequest(draft)])).digest('hex');
  return withTransaction(getPool(), async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`radiology-request:${key}`]);
    const authority = await authorize(client, session, draft.patientId, draft.visitId, true);
    const { rows: previous } = await client.query<Row>('SELECT * FROM radiology_requests WHERE command_key=$1::uuid', [key]);
    if (previous[0]) {
      const row = previous[0];
      if (row.actor_user_id !== session.userId || row.actor_username !== session.username || row.patient_id !== draft.patientId || row.visit_id !== draft.visitId || row.payload_sha256 !== hash || row.doctor_party_id !== authority.doctor!.id) refuse(409, 'مفتاح الطلب لا يطابق هذا السياق؛ راجع السجل.');
      finalAuthority(authority.session);
      return { ...publicRecord(row), replayed: true };
    }
    const { rows: settings } = await client.query<{ key: string; value: string }>('SELECT key,value FROM settings WHERE key=ANY($1::text[]) ORDER BY key FOR SHARE NOWAIT', [[RADIOLOGY_CENTERS_KEY,'clinic.name','clinic.address','clinic.phone']]);
    const map = Object.fromEntries(settings.map(row => [row.key, row.value]));
    const centers = parseRadiologyCenters(map[RADIOLOGY_CENTERS_KEY] ?? '');
    if (!centers.ok) refuse(409, 'إعداد مراكز الأشعة غير صالح؛ راجع الإعدادات.');
    const center = centers.centers.find(row => row.id === draft.centerId && row.active);
    if (!center) refuse(409, 'مركز الأشعة غير موجود أو أُوقف؛ حدّث القائمة.');
    if (!map['clinic.name']?.trim()) refuse(409, 'أكمل اسم المركز في الإعدادات قبل الإصدار.');
    const snapshot: RadiologyRequestSnapshot = { ...draft, version:1, patientName: authority.patientName, doctorId: authority.doctor!.id, doctorName: authority.doctor!.name,
      centerName: center.name, centerAddress: center.address, clinicName: map['clinic.name'], clinicAddress: map['clinic.address'] ?? '', clinicPhone: map['clinic.phone'] ?? '', timeZone: resolveClinicZone(process.env.CLINIC_TIME_ZONE) };
    decodeRadiologySnapshot(snapshot,draft.patientId,draft.visitId,authority.doctor!.id);
    const { rows: [saved] } = await client.query<Row>(`INSERT INTO radiology_requests(command_key,actor_user_id,actor_username,patient_id,visit_id,doctor_party_id,payload_sha256,snapshot)
      VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`, [key, session.userId, session.username, draft.patientId, draft.visitId, authority.doctor!.id, hash, JSON.stringify(snapshot)]);
    await insertAuditRow(client, { action: 'radiology_request.create', entity: 'radiology_request', entityId: key, actor: session.username, actorRole: session.role,
      details: { patientId: draft.patientId, visitId: draft.visitId, doctorId: authority.doctor!.id, centerId: draft.centerId } });
    finalAuthority(authority.session);
    return { ...publicRecord(saved), replayed: false };
  });
}
/** GET never issues. Absence is unknown: the original request may still commit. */
export async function recoverRadiologyRequest(session: SessionPayload, key: string, patientId: number, visitId: number | null) {
  return withTransaction(getPool(), async client => {
    const authority = await authorize(client, session, patientId, visitId, true);
    const { rows: [row] } = await client.query<Row>('SELECT * FROM radiology_requests WHERE command_key=$1::uuid', [key]);
    if (!row) return { state: 'unknown' as const };
    if (row.actor_user_id !== session.userId || row.actor_username !== session.username || row.patient_id !== patientId || row.visit_id !== visitId || row.doctor_party_id !== authority.doctor!.id) refuse(409, 'مفتاح الطلب لا يطابق هذا السياق.');
    finalAuthority(authority.session);
    return { state: 'completed' as const, ...publicRecord(row) };
  });
}
export async function readRadiologyRequest(session: SessionPayload, key: string, patientId: number) {
  return withTransaction(getPool(), async client => {
    const authority = await authorize(client, session, patientId, null, false);
    const { rows: [row] } = await client.query<Row>('SELECT * FROM radiology_requests WHERE command_key=$1::uuid AND patient_id=$2', [key, patientId]);
    if (!row) refuse(404, 'طلب الأشعة غير موجود.');
    finalAuthority(authority.session);
    return publicRecord(row);
  });
}
export async function listRadiologyRequests(session: SessionPayload, patientId: number, visitId: number | null, before: string | null = null) {
  return withTransaction(getPool(), async client => {
    const authority = await authorize(client, session, patientId, visitId, false);
    // Cursor resolves within the authorized scope; timestamp + UUID is stable and chronological.
    const { rows } = await client.query<Row>(`SELECT * FROM radiology_requests WHERE patient_id=$1 AND ($2::int IS NULL OR visit_id=$2) AND ($3::uuid IS NULL OR (created_at,command_key)<(SELECT created_at,command_key FROM radiology_requests WHERE command_key=$3::uuid AND patient_id=$1 AND ($2::int IS NULL OR visit_id=$2))) ORDER BY created_at DESC,command_key DESC LIMIT 51`, [patientId, visitId, before]);
    const page = rows.slice(0,50).map(row=>({...row,snapshot:decodeRadiologySnapshot(row.snapshot,row.patient_id,row.visit_id,row.doctor_party_id)}));
    finalAuthority(authority.session);
    return { canIssue: Boolean(authority.doctor), requests: page.map(row => ({ id: row.command_key, visitId: row.visit_id, doctorName: row.snapshot.doctorName, centerName: row.snapshot.centerName,
      createdAtLabel: new Intl.DateTimeFormat('ar-YE', { timeZone: row.snapshot.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(row.created_at) })), nextCursor: rows.length > 50 ? page.at(-1)!.command_key : null };
  });
}
export async function radiologyRequestOptions(session: SessionPayload, patientId: number, visitId: number | null) {
  return withTransaction(getPool(), async client => {
    const authority = await authorize(client, session, patientId, visitId, true);
    const { rows } = await client.query<{ value: string }>('SELECT value FROM settings WHERE key=$1 FOR SHARE NOWAIT', [RADIOLOGY_CENTERS_KEY]);
    const parsed = parseRadiologyCenters(rows[0]?.value ?? '[]');
    if (!parsed.ok) refuse(409, 'إعداد المراكز غير صالح.');
    finalAuthority(authority.session);
    return { actor: { userId: authority.session.userId, username: authority.session.username }, doctor: authority.doctor, centers: parsed.centers.filter(center => center.active) };
  });
}
/** App-controlled print action: a new grant/scope check and awaited audit.
 * A browser's native Ctrl+P on already-disclosed content cannot be revoked. */
export async function authorizeRadiologyPrint(session:SessionPayload,key:string,patientId:number) {
 return withTransaction(getPool(),async client=>{
  const authority=await authorize(client,session,patientId,null,false);
  const {rows:[row]}=await client.query<Row>('SELECT * FROM radiology_requests WHERE command_key=$1::uuid AND patient_id=$2',[key,patientId]);
  if(!row)refuse(404,'طلب الأشعة غير موجود.');
  publicRecord(row);
  await insertAuditRow(client,{action:'radiology_request.print',entity:'radiology_request',entityId:key,actor:authority.session.username,actorRole:authority.session.role,details:{patientId}});
  finalAuthority(authority.session);
  return {allowed:true as const,id:key,patientId};
 });
}
