import type { SessionPayload } from "./auth";
import { ensureSchema, getPool, insertAuditRow, type DbClient } from "./db";
import { revalidateSessionInTransaction } from "./session";
import { isAdmin } from "./roles";
import { withTransaction } from "./transactions";
import { parsePatientNumber, parseNumberingFloor, parseNumberingVersion, numberingReason, PATIENT_NUMBER_MAXIMUM, type NumberingPreview, type PatientNumberSnapshot } from "./patient-numbering";

export class PatientNumberingError extends Error {
  constructor(readonly code: "invalid" | "forbidden" | "stale" | "duplicate" | "missing" | "busy", message: string) { super(message); }
}
/** Integration seam: canonical patients.number.edit / patients.numbering.configure.
 * Only server-admitted signed session payloads may enter; no caller-supplied roles. */
async function authorize(client: DbClient, session: SessionPayload) {
  const current = await revalidateSessionInTransaction(session, client);
  if (!current || !isAdmin(current.role)) throw new PatientNumberingError("forbidden", "لا توجد صلاحية لإدارة أرقام الملفات، أو انتهت الجلسة.");
}
async function numberingLocks(client: DbClient) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('patient_import'))");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('patient_numbering'))");
}
async function transaction<T>(session: SessionPayload, work: (client: DbClient) => Promise<T>): Promise<T> {
  await ensureSchema();
  try {
    return await withTransaction(getPool(), async client => {
      await authorize(client, session); // identity lock before domain locks
      await numberingLocks(client);
      await authorize(client, session); // expiry while waiting fails closed
      return work(client);
    });
  } catch (error) {
    if ((error as {code?: string}).code === "23505") throw new PatientNumberingError("duplicate", "رقم الملف مستخدم حاليًا أو سبق استخدامه؛ اختر رقمًا آخر.");
    if (["55P03", "40P01"].includes((error as {code?: string}).code ?? "")) throw new PatientNumberingError("busy", "هناك عملية ترقيم أخرى؛ حدّث المعاينة وأعد المحاولة.");
    throw error;
  }
}
async function preview(client: DbClient): Promise<NumberingPreview> {
  const {rows} = await client.query<{
    minimum_next: string; version: string; last_value: string; is_called: boolean;
    maximum_current: string; maximum_retired: string; next_number: string;
  }>(`SELECT COALESCE(policy.minimum_next,7000)::text AS minimum_next, COALESCE(policy.version,1)::text AS version, seq.last_value::text, seq.is_called,
    COALESCE((SELECT max(aqlan_patient_number_numeric(patient_number)) FROM patients),0)::text AS maximum_current,
    COALESCE((SELECT max(aqlan_patient_number_numeric(patient_number)) FROM retired_patient_numbers),0)::text AS maximum_retired,
    aqlan_patient_number_next()::text AS next_number
    FROM patient_number_seq seq LEFT JOIN patient_numbering_policy policy ON policy.singleton`);
  const row = rows[0];
  if (!row) throw new Error("patient numbering policy is missing");
  const exhausted = BigInt(row.next_number) > PATIENT_NUMBER_MAXIMUM;
  return {minimumNext: row.minimum_next, version: row.version, sequenceValue: row.last_value,
    sequenceCalled: row.is_called, maximumCurrent: row.maximum_current, maximumRetired: row.maximum_retired,
    nextNumber: exhausted ? null : parsePatientNumber(row.next_number), exhausted};
}
export function readNumberingPreview(session: SessionPayload) { return transaction(session, preview); }
export async function changeNumberingFloor(session: SessionPayload, input: {
  minimumNext: unknown; expectedVersion: unknown; expectedNextNumber: unknown; reason: unknown;
}): Promise<NumberingPreview> {
  const floor = parseNumberingFloor(input.minimumNext), version = parseNumberingVersion(input.expectedVersion), reason = numberingReason(input.reason);
  if (!floor || !version || !reason || typeof input.expectedNextNumber !== "string") throw new PatientNumberingError("invalid", "أدخل حدًا أدنى صحيحًا من 7000 وسبب التغيير ومعاينة حديثة.");
  return transaction(session, async client => {
    const before = await preview(client);
    await authorize(client, session);
    if (before.version !== version || before.nextNumber !== input.expectedNextNumber) throw new PatientNumberingError("stale", "تغيّر الترقيم منذ المعاينة؛ حدّثها قبل الحفظ.");
    if (BigInt(floor) <= BigInt(before.minimumNext)) throw new PatientNumberingError("invalid", "الحد الأدنى الجديد يجب أن يزيد عن الحد الحالي؛ لا يمكن إرجاع العداد للخلف.");
    await client.query("INSERT INTO patient_numbering_policy(singleton,minimum_next,version) VALUES(true,$1::bigint,2) ON CONFLICT(singleton) DO UPDATE SET minimum_next=EXCLUDED.minimum_next, version=patient_numbering_policy.version+1", [floor]);
    const after = await preview(client);
    await insertAuditRow(client, {action: "patient.numbering.configure", entity: "patient_numbering", entityId: "policy",
      actor: session.username, actorRole: session.role, details: {before, after, reason}});
    return after;
  });
}
async function snapshot(client: DbClient, patientId: number, lock = false): Promise<PatientNumberSnapshot> {
  const {rows} = await client.query<{id: number; patient_number: string; patient_number_version: string}>(
    `SELECT id, patient_number, patient_number_version::text FROM patients WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [patientId]);
  if (!rows[0]) throw new PatientNumberingError("missing", "لم يُعثر على ملف المريض.");
  return {patientId: rows[0].id, patientNumber: rows[0].patient_number, version: rows[0].patient_number_version};
}
function validId(patientId: number) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw new PatientNumberingError("invalid", "معرّف المريض غير صالح.");
}
export function readPatientNumber(session: SessionPayload, patientId: number) {
  validId(patientId);
  return transaction(session, client => snapshot(client, patientId));
}
export async function changePatientNumber(session: SessionPayload, patientId: number, input: {
  patientNumber: unknown; expectedVersion: unknown; expectedPatientNumber: unknown; reason: unknown;
}): Promise<PatientNumberSnapshot> {
  validId(patientId);
  const number = parsePatientNumber(input.patientNumber), version = parseNumberingVersion(input.expectedVersion), reason = numberingReason(input.reason);
  if (!number || !version || !reason || typeof input.expectedPatientNumber !== "string") throw new PatientNumberingError("invalid", "أدخل رقم ملف صحيحًا وسبب التعديل وأعد تحميل الرقم الحالي.");
  return transaction(session, async client => {
    const before = await snapshot(client, patientId, true);
    await authorize(client, session); // expiry while waiting on the exact patient row
    if (before.version !== version || before.patientNumber !== input.expectedPatientNumber) throw new PatientNumberingError("stale", "تغيّر رقم الملف منذ فتحه؛ حدّث الصفحة قبل المحاولة.");
    if (before.patientNumber === number) throw new PatientNumberingError("invalid", "رقم الملف الجديد مطابق للحالي.");
    await client.query("UPDATE patients SET patient_number=$2 WHERE id=$1", [patientId, number]);
    const after = await snapshot(client, patientId);
    await insertAuditRow(client, {action: "patient.number.change", entity: "patient", entityId: patientId,
      actor: session.username, actorRole: session.role, details: {before, after, reason,
        internalPatientIdUnchanged: true, oldNumberRetired: true}});
    return after;
  });
}
