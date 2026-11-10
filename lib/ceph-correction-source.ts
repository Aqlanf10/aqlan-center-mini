import type { DbClient } from "./db";
import { canonicalJourneyJSON, journeyContentHash } from "./ortho-case-journey-hash";
import { parseCephCompletionSnapshot } from "./ceph-completion-snapshot";
import { readCephCorrectionSourceProvenance } from "./ceph-completion-provenance";
import { parseCephCorrectionOrigin, type CephCorrectionOrigin, type CephCorrectionSourceRead } from "./ceph-correction-origin";

export interface CephCorrectionStoredColumns {
  id: number; patient_id: number; ortho_case_id: number | null; document_id: number;
  corrects_analysis_id?: number | string | null; correction_source?: unknown;
  correction_source_canonical?: string | null; correction_source_sha256?: string | null;
}
/** Old rows have no recorded origin. A present corrupt origin is never downgraded. */
export function readStoredCephCorrectionOrigin(row: CephCorrectionStoredColumns): CephCorrectionOrigin | null {
  if (row.corrects_analysis_id == null && row.correction_source == null && row.correction_source_canonical == null && row.correction_source_sha256 == null) return null;
  const origin = parseCephCorrectionOrigin(row.correction_source);
  if (!origin || Number(row.corrects_analysis_id) !== origin.parentAnalysisId || origin.parentAnalysisId === Number(row.id)
    || origin.documentId !== row.document_id || origin.orthoCaseId !== row.ortho_case_id
    || canonicalJourneyJSON(origin) !== row.correction_source_canonical || journeyContentHash(origin) !== row.correction_source_sha256) throw Error("invalid_ceph_correction_origin");
  return origin;
}
/** Caller supplies one consistent snapshot, or holds current authority and parent
 * locks. Hidden-image copying remains allowed; this never authorizes image display. */
export async function readCephCorrectionSource(client: Pick<DbClient, "query">, analysisId: number,
  mode: "snapshot" | "locked", recordedPatientId?: number): Promise<CephCorrectionSourceRead> {
  const suffix = mode === "locked" ? " FOR SHARE NOWAIT" : "";
  const { rows: [source] } = await client.query<CephCorrectionStoredColumns & Record<string, unknown>>(
    `SELECT *,xray_date::text AS xray_date_text,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text,
      to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at_text
      FROM ceph_analyses WHERE id=$1${suffix}`, [analysisId]);
  if (!source || source.status !== "completed") return { state: "unavailable", reason: "parent_not_completed" };
  try {
    const previousOrigin = readStoredCephCorrectionOrigin(source);
    const { rows: landmarks } = await client.query<{ code: string; x: number; y: number; source: string | null; confirmedBy: string; confirmedAt: string }>(
      `SELECT code,x,y,source,confirmed_by AS "confirmedBy",to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "confirmedAt" FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code LIMIT 257${suffix}`, [analysisId]);
    const { rows: diagnoses } = await client.query<{ skeletal: string | null; dental: string | null; softTissue: string | null; note: string | null; finalDx: string }>(
      `SELECT skeletal,dental,soft_tissue AS "softTissue",note,final_dx AS "finalDx" FROM ceph_diagnoses WHERE analysis_id=$1 LIMIT 2${suffix}`, [analysisId]);
    const { rows: measurements } = await client.query<{ code: string; value: number }>(
      `SELECT code,value FROM ceph_measurements WHERE analysis_id=$1 ORDER BY code LIMIT 257${suffix}`, [analysisId]);
    if (landmarks.length > 256 || measurements.length > 256 || diagnoses.length > 1) return { state: "unavailable", reason: "parent_source_budget" };
    const { rows: [image] } = await client.query<{ id: number; patient_id: number; ortho_case_id:number|null; sha256: string | null; width: number | null; height: number | null; removed_at: Date | null }>(
      `SELECT id,patient_id,ortho_case_id,sha256,width,height,removed_at FROM patient_documents WHERE id=$1${suffix}`, [source.document_id]);
    if (!image || image.patient_id !== source.patient_id || image.ortho_case_id !== null && image.ortho_case_id !== source.ortho_case_id) return { state: "unavailable", reason: "parent_image_scope_changed" };
    const calibration = [source.cal_x1, source.cal_y1, source.cal_x2, source.cal_y2, source.cal_mm].every(v => v === null)
      ? null : { x1: source.cal_x1, y1: source.cal_y1, x2: source.cal_x2, y2: source.cal_y2, mm: source.cal_mm };
    const snapshot = parseCephCompletionSnapshot({ patientId: source.patient_id, documentId: source.document_id,
      refSet: source.ref_set ?? "builtin_default", calibration, mmPerPixel: source.mm_per_pixel,
      landmarks, diagnosis: diagnoses[0] ?? null });
    const seal = await readCephCorrectionSourceProvenance(client, analysisId, "completed", snapshot ? { snapshot, measurements } : undefined);
    if (seal.state !== "versioned" && seal.state !== "unversioned") return { state: "unavailable", reason: "parent_seal_unavailable" };
    const identityPatientId = recordedPatientId ?? source.patient_id;
    const observed = { schemaVersion: 1, analysisId, recordedPatientId: identityPatientId,
      orthoCaseId: source.ortho_case_id, documentId: source.document_id, phase: source.phase, xrayDate: source.xray_date_text,
      device: source.device, refSet: source.ref_set, studyKind: source.study_kind, note: source.note,
      createdBy: source.created_by, createdAt: source.created_at_text, completedBy: source.completed_by, completedAt: source.completed_at_text,
      calibration, mmPerPixel: source.mm_per_pixel, landmarks, diagnoses, measurements,
      image: { id: image.id, orthoCaseId:image.ortho_case_id, sha256: image.sha256, width: image.width, height: image.height }, previousOrigin };
    if (canonicalJourneyJSON(observed).length > 2 * 1024 * 1024) return { state: "unavailable", reason: "parent_source_budget" };
    const origin: CephCorrectionOrigin = { schemaVersion: 1, parentAnalysisId: analysisId, recordedPatientId: identityPatientId,
      orthoCaseId: source.ortho_case_id, documentId: source.document_id,
      parentCompletion: seal.state === "versioned" ? { state: "versioned", witnessVersion: seal.witness.schemaVersion, witnessSha256: seal.witnessSha256 }
        : { state: "unversioned", reason: "historical_completion_without_witness" }, sourceSnapshotSha256: journeyContentHash(observed) };
    if (!parseCephCorrectionOrigin(origin)) return { state: "unavailable", reason: "parent_identity_invalid" };
    return { state: "available", origin, token: { schemaVersion: 1, analysisId, patientId: source.patient_id,
      orthoCaseId: source.ortho_case_id, documentId: source.document_id, sourceSha256: journeyContentHash(origin) } };
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") throw error;
    return { state: "unavailable", reason: "parent_source_integrity_unavailable" };
  }
}
/** Bounded discovery only; callers lock the complete source union before using it. */
export async function discoverCephCorrectionAncestors(client: Pick<DbClient,'query'>, analysisId:number,
  scope:{patientId:number;orthoCaseId:number|null;documentId?:number}):Promise<number[]> {
  const ids:number[]=[],seen=new Set<number>([analysisId]);let id=analysisId;
  while(true){
    const {rows:[row]}=await client.query<CephCorrectionStoredColumns>('SELECT * FROM ceph_analyses WHERE id=$1 AND patient_id=$2 AND ortho_case_id IS NOT DISTINCT FROM $3',[id,scope.patientId,scope.orthoCaseId]);
    if(!row && id===analysisId)return ids;
    if(!row || scope.documentId!==undefined && row.document_id!==scope.documentId)throw Error('ceph_correction_ancestor_unavailable');
    const origin=readStoredCephCorrectionOrigin(row);if(!origin)return ids;
    if(seen.has(origin.parentAnalysisId)||ids.length>=64)throw Error('ceph_correction_ancestor_unavailable');
    seen.add(origin.parentAnalysisId);ids.push(origin.parentAnalysisId);id=origin.parentAnalysisId;
  }
}
/** Rechecks immutable links, current ownership and the exact original source
 * under the caller's snapshot/locks. Legal patient merge keeps recorded identity. */
export async function requireCephCorrectionAncestry(client:Pick<DbClient,'query'>,row:CephCorrectionStoredColumns,
  mode:'snapshot'|'locked',allowed?:ReadonlySet<string>):Promise<void>{
  let origin=readStoredCephCorrectionOrigin(row);const seen=new Set<number>([row.id]);let depth=0;
  while(origin){
    if(seen.has(origin.parentAnalysisId)||++depth>64 || allowed && !allowed.has(`ceph_study:${origin.parentAnalysisId}`))throw Error('ceph_correction_ancestor_unavailable');
    seen.add(origin.parentAnalysisId);
    const proof=await readCephCorrectionSource(client,origin.parentAnalysisId,mode,origin.recordedPatientId);
    if(proof.state!=='available'||proof.token.patientId!==row.patient_id||proof.token.orthoCaseId!==row.ortho_case_id
      || proof.token.documentId!==row.document_id || journeyContentHash(proof.origin)!==journeyContentHash(origin))throw Error('ceph_correction_ancestor_changed');
    const {rows:[parent]}=await client.query<CephCorrectionStoredColumns>('SELECT * FROM ceph_analyses WHERE id=$1',[origin.parentAnalysisId]);
    if(!parent)throw Error('ceph_correction_ancestor_unavailable');origin=readStoredCephCorrectionOrigin(parent);
  }
}
