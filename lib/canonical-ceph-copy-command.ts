import "server-only";
import { doctorOwnsPatient, duplicateCephAnalysisInTransaction, getPool, insertAuditRow, patientInDoctorScopeWith } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalCephCopyRefusal extends Error {
  constructor(readonly code: "invalid_ceph_copy" | "ceph_copy_not_found" | "ceph_copy_conflict" | "ceph_copy_reference_invalid" | "ceph_copy_limit" | "ceph_copy_stored_data_invalid", readonly status: 400 | 404 | 409, message: string) {
    super(message); this.name = "CanonicalCephCopyRefusal";
  }
}
const missing = () => new CanonicalCephCopyRefusal("ceph_copy_not_found", 404, "الدراسة غير متاحة ضمن مرضاك.");
const conflict = () => new CanonicalCephCopyRefusal("ceph_copy_conflict", 409, "تعذّر إنشاء نسخة التصحيح من الحالة الحالية. حدّث الدراسات وتحقق من المسودة قبل طلب جديد.");
const invalidReference = () => new CanonicalCephCopyRefusal("ceph_copy_reference_invalid", 409, "تعذّر التحقق من مراجع الدراسة؛ لم تُنشأ نسخة جزئية.");
const invalidSource = () => new CanonicalCephCopyRefusal("ceph_copy_stored_data_invalid", 409, "بيانات المعايرة أو المعالم المحفوظة غير صالحة للنسخ؛ لم تُغيّر الدراسة الأصلية.");
export function parseCanonicalCephCopy(rawId: string, body: unknown) {
  const id = Number(rawId);
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
    throw new CanonicalCephCopyRefusal("invalid_ceph_copy", 400, "طلب نسخة التصحيح يقبل رقم الدراسة فقط، دون تعديل محتواها.");
  }
  return id;
}

/** A fresh correction intention, not a durable request receipt. Source facts are copied, never recomputed. */
export async function commandCanonicalCephCopy(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const studyId = parseCanonicalCephCopy(rawId, body), action = "clinical.ceph.analyze" as const;
  try {
    return await withStaffOperation(pool, session, action, async (client, handle) => {
      let scope = await staffOperationPatientScope(client, handle, action);
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const { rows: [initial] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM ceph_analyses WHERE id=$1 AND status<>'discarded'", [studyId]);
      if (!initial || scope.kind === "own" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, initial.patient_id)) throw missing();
      const patient = await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [initial.patient_id]);
      scope = await staffOperationPatientScope(client, handle, action);
      if (!patient.rows.length) throw missing();
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      if (scope.kind === "own" && !await doctorOwnsPatient(scope.clinicianPartyId, initial.patient_id, client, "nowait")) throw missing();
      const { rows: [source] } = await client.query<{ patient_id: number; document_id: number; ortho_case_id: number | null; status: string; cal_x1: number | null; cal_y1: number | null; cal_x2: number | null; cal_y2: number | null; cal_mm: number | null; mm_per_pixel: number | null }>(
        "SELECT patient_id,document_id,ortho_case_id,status,cal_x1,cal_y1,cal_x2,cal_y2,cal_mm,mm_per_pixel FROM ceph_analyses WHERE id=$1 AND patient_id=$2 AND status<>'discarded' FOR UPDATE NOWAIT", [studyId, initial.patient_id]);
      if (!source) throw missing();
      if (source.status !== "completed") throw conflict();
      // A retained unavailable image remains unavailable; copying creates no file or new retention policy.
      const document = await client.query("SELECT id FROM patient_documents WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT", [source.document_id, initial.patient_id]);
      if (!document.rows.length) throw invalidReference();
      if (source.ortho_case_id !== null) {
        const ortho = await client.query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT", [source.ortho_case_id, initial.patient_id]);
        if (!ortho.rows.length) throw invalidReference();
      }
      const { rows: [budget] } = await client.query<{ landmarks: string; bytes: string }>(`SELECT
        (SELECT count(*)::text FROM ceph_landmarks WHERE analysis_id=$1) AS landmarks,
        (octet_length(to_jsonb(a)::text) + COALESCE((SELECT sum(octet_length(to_jsonb(l)::text)) FROM ceph_landmarks l WHERE analysis_id=$1),0))::text AS bytes
        FROM ceph_analyses a WHERE id=$1`, [studyId]);
      if (!budget || Number(budget.landmarks) > 256 || !Number.isFinite(Number(budget.bytes)) || Number(budget.bytes) > 2 * 1024 * 1024) {
        throw new CanonicalCephCopyRefusal("ceph_copy_limit", 409, "الدراسة تتجاوز حد النسخ الآمن؛ لم تُختصر معالمها أو بياناتها.");
      }
      // Match the saved reader's structural validity for copied facts only. Approved results are not copied.
      const calibration = [source.cal_x1, source.cal_y1, source.cal_x2, source.cal_y2, source.cal_mm];
      const present = calibration.filter(n => n !== null).length;
      if (present !== 0 && present !== 5 || calibration.some(n => n !== null && !Number.isFinite(n)) ||
          source.cal_mm !== null && source.cal_mm <= 0 ||
          source.mm_per_pixel !== null && (!Number.isFinite(source.mm_per_pixel) || source.mm_per_pixel <= 0)) throw invalidSource();
      // Hold the checked children through the copy. The source lock also fences new FK children.
      const landmarks = await client.query<{ code: string; x: number; y: number }>(
        "SELECT code,x,y FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY id FOR SHARE NOWAIT", [studyId]);
      if (landmarks.rows.some(p => !p.code.length || p.code.length > 100 || !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw invalidSource();
      const actor = await staffOperationIdentity(client, handle, action);
      const result = await duplicateCephAnalysisInTransaction(client, studyId, actor.username);
      if (!result.ok) throw conflict();
      const createdId = Number(result.id);
      if (!Number.isSafeInteger(createdId) || createdId <= 0) throw conflict();
      await insertAuditRow(client, { action: "ceph.create", entity: "ceph_analysis", entityId: createdId, entityLabel: `نسخة تصحيح عن #${studyId}`, actor: actor.username, actorRole: actor.role });
      await assertStaffOperation(client, handle, action);
      return { ok: true as const, studyId: createdId };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["55P03", "40P01", "40001", "23505"].includes(String(error.code))) throw conflict();
    throw error;
  }
}
