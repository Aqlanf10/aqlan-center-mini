import "server-only";
import { doctorOwnsPatient, getPool, insertAuditRow, patientInDoctorScopeWith, updateCephCalibrationInTransaction, updateCephDiagnosisInTransaction, updateCephLandmarksInTransaction, type CephCalibrationInput } from "./db";
import { isCephLandmarkCode, type LandmarkCode } from "./ceph";
import { cephDraftVersionWith } from "./canonical-ceph-draft-version";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";
export class CanonicalCephEditRefusal extends Error {
  constructor(readonly code: "invalid_ceph_edit" | "ceph_edit_not_found" | "ceph_edit_conflict" | "ceph_edit_reference_invalid", readonly status: 400 | 404 | 409, message: string) { super(message); this.name = "CanonicalCephEditRefusal"; }
}
const missing = () => new CanonicalCephEditRefusal("ceph_edit_not_found", 404, "المسودة غير متاحة ضمن مرضاك.");
const conflict = () => new CanonicalCephEditRefusal("ceph_edit_conflict", 409, "تغيّرت المسودة أو تعذّر تثبيت حالتها. أعد قراءتها وراجع التعديلات قبل حفظ جديد.");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
type Diagnosis = { skeletal: string | null; dental: string | null; softTissue: string | null; note: string | null; finalDx: string };
type Landmark = { code: LandmarkCode; x: number; y: number; source: "manual" | "suggested" };
export function parseCanonicalCephEdit(rawId: string, body: unknown) {
  const id = Number(rawId), invalid = () => new CanonicalCephEditRefusal("invalid_ceph_edit", 400, "راجع حقول المسودة وقيمها؛ لا نحذف معالم غير صالحة أو نختصر التشخيص تلقائيًا.");
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || id > 2147483647 || !object(body)) throw invalid();
  const keys = Object.keys(body);
  if (keys.length < 2 || keys.some(key => !["expectedVersion", "calibration", "landmarks", "diagnosis"].includes(key)) || typeof body.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedVersion)) throw invalid();
  let calibration: CephCalibrationInput | undefined, landmarks: Landmark[] | undefined, diagnosis: Diagnosis | undefined;
  if (Object.hasOwn(body, "calibration")) {
    const c = body.calibration;
    if (!object(c) || Object.keys(c).sort().join(",") !== "mm,x1,x2,y1,y2" || !finite(c.x1) || !finite(c.y1) || !finite(c.x2) || !finite(c.y2) || !finite(c.mm) || c.mm <= 0) throw invalid();
    const px = Math.hypot(c.x2 - c.x1, c.y2 - c.y1), scale = c.mm / px;
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(scale) || scale <= 0) throw invalid();
    calibration = { x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, mm: c.mm };
  }
  if (Object.hasOwn(body, "landmarks")) {
    if (!Array.isArray(body.landmarks) || !body.landmarks.length || body.landmarks.length > 256) throw invalid();
    const seen = new Set<string>(); landmarks = body.landmarks.map(p => {
      if (!object(p) || Object.keys(p).sort().join(",") !== "code,source,x,y" || !isCephLandmarkCode(p.code) || !finite(p.x) || !finite(p.y) || (p.source !== "manual" && p.source !== "suggested") || seen.has(p.code)) throw invalid();
      seen.add(p.code); return { code: p.code, x: p.x, y: p.y, source: p.source as Landmark["source"] };
    });
  }
  if (Object.hasOwn(body, "diagnosis")) {
    const d = body.diagnosis;
    if (!object(d) || Object.keys(d).sort().join(",") !== "dental,finalDx,note,skeletal,softTissue" || typeof d.finalDx !== "string" || !d.finalDx.trim() || d.finalDx.trim().length > 2000) throw invalid();
    const clean = (value: unknown): string | null => { if (value === null) return null; if (typeof value !== "string" || value.trim().length > 2000) throw invalid(); return value.trim() || null; };
    diagnosis = { skeletal: clean(d.skeletal), dental: clean(d.dental), softTissue: clean(d.softTissue), note: clean(d.note), finalDx: d.finalDx.trim() };
  }
  return { id, expectedVersion: body.expectedVersion, calibration, landmarks, diagnosis };
}

/** Atomic explicit edits of one observed draft. No completion, engine invocation or image authority. */
export async function commandCanonicalCephEdit(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalCephEdit(rawId, body), action = "clinical.ceph.analyze" as const;
  try {
    return await withStaffOperation(pool, session, action, async (client, handle) => {
      let scope = await staffOperationPatientScope(client, handle, action);
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const { rows: [initial] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM ceph_analyses WHERE id=$1 AND status<>'discarded'", [input.id]);
      if (!initial || scope.kind === "own" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, initial.patient_id)) throw missing();
      const patient = await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [initial.patient_id]);
      scope = await staffOperationPatientScope(client, handle, action);
      if (!patient.rows.length) throw missing();
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      if (scope.kind === "own" && !await doctorOwnsPatient(scope.clinicianPartyId, initial.patient_id, client, "nowait")) throw missing();
      const { rows: [study] } = await client.query<{ status: string; document_id: number; ortho_case_id: number | null }>("SELECT status,document_id,ortho_case_id FROM ceph_analyses WHERE id=$1 AND patient_id=$2 AND status<>'discarded' FOR UPDATE NOWAIT", [input.id, initial.patient_id]);
      if (!study) throw missing();
      if (study.status !== "draft") throw conflict();
      const invalidReference = () => new CanonicalCephEditRefusal("ceph_edit_reference_invalid", 409, "تعذّر التحقق من مراجع المسودة الحالية؛ لم تُحفظ تعديلات.");
      const document = await client.query("SELECT id FROM patient_documents WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT", [study.document_id, initial.patient_id]);
      if (document.rows.length !== 1) throw invalidReference();
      if (study.ortho_case_id !== null) {
        const ortho = await client.query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT", [study.ortho_case_id, initial.patient_id]);
        if (ortho.rows.length !== 1) throw invalidReference();
      }
      if (await cephDraftVersionWith(client, input.id, true) !== input.expectedVersion) throw conflict();
      const actor = await staffOperationIdentity(client, handle, action);
      const audit = (entityLabel: string) => insertAuditRow(client, { action: "ceph.update", entity: "ceph_analysis", entityId: input.id, entityLabel, actor: actor.username, actorRole: actor.role });
      if (input.calibration) {
        const c = input.calibration, result = await updateCephCalibrationInTransaction(client, input.id, c); if (!result.ok) throw conflict();
        await audit(`معايرة ${c.mm} مم على ${Math.hypot(c.x2 - c.x1, c.y2 - c.y1).toFixed(1)} بكسل`);
      }
      if (input.landmarks) {
        const result = await updateCephLandmarksInTransaction(client, input.id, input.landmarks, actor.username); if (!result.ok) throw conflict();
        await audit(`كتابة ${input.landmarks.length} معلمًا (${input.landmarks.map(p => p.code).join("، ")})`);
      }
      if (input.diagnosis) {
        const result = await updateCephDiagnosisInTransaction(client, input.id, input.diagnosis, actor.username); if (!result.ok) throw conflict();
        await audit(`تشخيص منظّم: ${input.diagnosis.finalDx.slice(0, 80)}`);
      }
      // Keep the existing saved-study read limits after the requested changes.
      // Otherwise a valid observed draft could become inaccessible to its own editor.
      const budget = (await client.query<{ landmarks: string; measurements: string; bytes: string }>(`SELECT
        (SELECT count(*)::text FROM ceph_landmarks WHERE analysis_id=$1) landmarks,
        (SELECT count(*)::text FROM ceph_measurements WHERE analysis_id=$1) measurements,
        (octet_length(to_jsonb(a)::text)
          +COALESCE((SELECT sum(octet_length(to_jsonb(l)::text)) FROM ceph_landmarks l WHERE analysis_id=$1),0)
          +COALESCE((SELECT sum(octet_length(to_jsonb(m)::text)) FROM ceph_measurements m WHERE analysis_id=$1),0)
          +COALESCE((SELECT sum(octet_length(to_jsonb(d)::text)) FROM ceph_diagnoses d WHERE analysis_id=$1),0))::text bytes
        FROM ceph_analyses a WHERE id=$1`, [input.id])).rows[0];
      if (!budget || !Object.values(budget).every(value => Number.isSafeInteger(Number(value)) && Number(value) >= 0)
        || Number(budget.landmarks) > 256 || Number(budget.measurements) > 256 || Number(budget.bytes) > 2 * 1024 * 1024) throw conflict();
      await assertStaffOperation(client, handle, action);
      return { ok: true as const, studyId: input.id, status: "draft" as const };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "CEPH_DRAFT_VERSION_LIMIT") throw conflict();
    if (error && typeof error === "object" && "code" in error && ["55P03", "40P01", "40001"].includes(String(error.code))) throw conflict();
    throw error;
  }
}
