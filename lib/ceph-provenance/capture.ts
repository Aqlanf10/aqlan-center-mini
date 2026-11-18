/**
 * Server-side capture and reading of the completion witness (step 3 of the provenance branch).
 *
 * `sealCephCompletion` runs INSIDE the completion transaction, after the analysis row has been marked completed:
 * it reads the saved inputs back from the database (never from the request), the image digest, the reference set
 * under SHARE locks, and inserts one immutable record whose seal time is the analysis completion time itself.
 * Unknown historical landmark codes are kept in the database untouched and are simply not part of the snapshot.
 */
import type { DbClient } from "../db";
import { isCephLandmarkCode } from "../ceph";
import { cephContentHash } from "./canonical-json";
import { parseCephCompletionSnapshot, type CephCompletionSnapshot } from "./snapshot";
import {
  buildCephCompletionWitness, cephSourceIdentity, decodeCephCompletionWitness,
  type CephCompletionWitness, type CephReferenceSnapshot, type CephSourceIdentity,
} from "./witness";

type Query = Pick<DbClient, "query">;
const sha = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);

async function readReferenceSet(q: Query, key: string): Promise<CephReferenceSnapshot | null> {
  const { rows: [set] } = await q.query<{ id: number; key: string; name: string; population: string | null; age_min: number | null; age_max: number | null; sex: string | null; version: string }>(
    "SELECT id,key,name,population,age_min,age_max,sex,version FROM ceph_reference_sets WHERE key=$1 AND active=TRUE", [key]);
  if (!set) return null;
  const { rows: values } = await q.query<{ code: string; mean: number; sd: number }>(
    "SELECT code,mean,sd FROM ceph_reference_values WHERE set_id=$1 ORDER BY code", [set.id]);
  return { key: set.key, name: set.name, population: set.population, ageMin: set.age_min, ageMax: set.age_max, sex: set.sex, version: set.version,
    values: values.map((v) => ({ code: v.code, mean: Number(v.mean), sd: Number(v.sd) })) };
}

/** What a draft's completion would be bound to now: shown to the clinician and sent back on completion. */
export async function readCephCompletionSources(q: Query, scope: { patientId: number; documentId: number; refSet: string }): Promise<CephSourceIdentity | null> {
  const { rows: [image] } = await q.query<{ id: number; sha256: string }>("SELECT id,sha256 FROM patient_documents WHERE id=$1 AND patient_id=$2", [scope.documentId, scope.patientId]);
  if (!image || !sha(image.sha256)) return null;
  return cephSourceIdentity({ documentId: image.id, sha256: image.sha256 }, scope.refSet, await readReferenceSet(q, scope.refSet));
}

async function readSnapshot(q: Query, analysisId: number): Promise<CephCompletionSnapshot | null> {
  const { rows: [a] } = await q.query<{ patient_id: number; document_id: number; ortho_case_id: number | null; ref_set: string; cal_x1: number | null; cal_y1: number | null; cal_x2: number | null; cal_y2: number | null; cal_mm: number | null; mm_per_pixel: number | null }>(
    "SELECT patient_id,document_id,ortho_case_id,ref_set,cal_x1,cal_y1,cal_x2,cal_y2,cal_mm,mm_per_pixel FROM ceph_analyses WHERE id=$1", [analysisId]);
  if (!a) return null;
  const { rows: landmarks } = await q.query<{ code: string; x: number; y: number; source: "manual" | "suggested" }>(
    "SELECT code,x,y,source FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code", [analysisId]);
  const { rows: [d] } = await q.query<{ skeletal: string | null; dental: string | null; soft_tissue: string | null; note: string | null; final_dx: string }>(
    "SELECT skeletal,dental,soft_tissue,note,final_dx FROM ceph_diagnoses WHERE analysis_id=$1", [analysisId]);
  const calibration = [a.cal_x1, a.cal_y1, a.cal_x2, a.cal_y2, a.cal_mm].every((n) => n !== null)
    ? { x1: a.cal_x1!, y1: a.cal_y1!, x2: a.cal_x2!, y2: a.cal_y2!, mm: a.cal_mm! } : null;
  return parseCephCompletionSnapshot({
    patientId: a.patient_id, documentId: a.document_id, orthoCaseId: a.ortho_case_id, refSet: a.ref_set, calibration, mmPerPixel: a.mm_per_pixel,
    landmarks: landmarks.filter((p) => isCephLandmarkCode(p.code)).map((p) => ({ code: p.code, x: p.x, y: p.y, source: p.source })),
    diagnosis: d ? { skeletal: d.skeletal, dental: d.dental, softTissue: d.soft_tissue, note: d.note, finalDx: d.final_dx } : null,
  });
}

async function readReviews(q: Query, analysisId: number) {
  const { rows } = await q.query<{ code: string; confirmedBy: string; confirmedAt: string }>(
    `SELECT code,confirmed_by AS "confirmedBy",to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "confirmedAt"
     FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code`, [analysisId]);
  return rows.filter((r) => isCephLandmarkCode(r.code));
}

export class CephProvenanceSourcesChanged extends Error { constructor() { super("ceph_reviewed_sources_changed"); } }

/** Caller holds the analysis, patient and document locks and has just marked the analysis completed. */
export async function sealCephCompletion(client: DbClient, input: {
  analysisId: number; actor: CephCompletionWitness["actor"]; approvedDraftVersion: string;
  expectedSources: CephSourceIdentity | null; measurements: readonly { code: string; value: number }[];
}): Promise<{ witnessSha256: string }> {
  const snapshot = await readSnapshot(client, input.analysisId);
  if (!snapshot) throw new Error("ceph_provenance_snapshot_unavailable");
  const { rows: [image] } = await client.query<{ documentId: number; sha256: string; width: number | null; height: number | null }>(
    `SELECT id AS "documentId",sha256,width,height FROM patient_documents WHERE id=$1 AND patient_id=$2 FOR SHARE`, [snapshot.documentId, snapshot.patientId]);
  if (!image || !sha(image.sha256)) throw new Error("ceph_provenance_image_unavailable");
  await client.query("LOCK TABLE ceph_reference_sets, ceph_reference_values IN SHARE MODE");
  const referenceSet = await readReferenceSet(client, snapshot.refSet);
  const { rows: [sealed] } = await client.query<{ at: string; status: string; completed_by: string | null }>(
    `SELECT to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,status,completed_by FROM ceph_analyses WHERE id=$1`, [input.analysisId]);
  if (!sealed || sealed.status !== "completed" || sealed.completed_by !== input.actor.username || !sealed.at) throw new Error("ceph_provenance_signature_unavailable");
  let witness: CephCompletionWitness;
  try {
    witness = buildCephCompletionWitness({ analysisId: input.analysisId, actor: input.actor, sealedAt: sealed.at, approvedDraftVersion: input.approvedDraftVersion,
      snapshot, image: { documentId: image.documentId, sha256: image.sha256, width: image.width, height: image.height },
      landmarkReviews: await readReviews(client, input.analysisId), referenceSet, measurements: input.measurements, expectedSources: input.expectedSources });
  } catch (error) {
    if (error instanceof Error && error.message === "ceph_reviewed_sources_changed") throw new CephProvenanceSourcesChanged();
    throw error;
  }
  const witnessSha256 = cephContentHash(witness);
  await client.query(
    `INSERT INTO ceph_completion_provenance(analysis_id,schema_version,witness,witness_sha256,approved_draft_version,actor_user_id,sealed_by,sealed_at)
     SELECT $1,1,$2::jsonb,$3,$4,$5,$6,completed_at FROM ceph_analyses WHERE id=$1`,
    [input.analysisId, JSON.stringify(witness), witnessSha256, input.approvedDraftVersion, input.actor.userId, input.actor.username]);
  return { witnessSha256 };
}

/** A same-actor retry of the same approved draft version returns the original receipt instead of a conflict. */
export async function findCephCompletionReplay(q: Query, analysisId: number, approvedDraftVersion: string, actorUserId: number): Promise<boolean> {
  const { rows } = await q.query("SELECT 1 FROM ceph_completion_provenance WHERE analysis_id=$1 AND approved_draft_version=$2 AND actor_user_id=$3", [analysisId, approvedDraftVersion, actorUserId]);
  return rows.length === 1;
}

export type CephProvenanceState =
  | { readonly state: "not-completed" }
  | { readonly state: "unversioned" }
  | { readonly state: "integrity-unavailable"; readonly reason: string }
  | { readonly state: "versioned"; readonly witnessSha256: string; readonly sealedAt: string; readonly sealedBy: string;
      readonly engineVersion: string; readonly sourceIdentityMeaning: CephCompletionWitness["sourceIdentityMeaning"];
      readonly measurementsWithAssumption: number; readonly measurementsWithLegacyDefinitionDifference: number };

/** Reads the seal and checks it against what is stored now. Never consults the current engine or reference set. */
export async function readCephProvenanceState(q: Query, analysisId: number): Promise<CephProvenanceState> {
  const { rows: [a] } = await q.query<{ status: string; completed_by: string | null; completed_at: string | null }>(
    `SELECT status,completed_by,to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at FROM ceph_analyses WHERE id=$1`, [analysisId]);
  if (!a || a.status !== "completed") return { state: "not-completed" };
  const { rows: [p] } = await q.query<{ witness: unknown; witness_sha256: string; sealed_by: string; actor_user_id: number }>(
    "SELECT witness,witness_sha256,sealed_by,actor_user_id FROM ceph_completion_provenance WHERE analysis_id=$1", [analysisId]);
  if (!p) return { state: "unversioned" };
  const witness = decodeCephCompletionWitness(p.witness, p.witness_sha256);
  if (!witness || witness.analysisId !== analysisId || witness.actor.username !== p.sealed_by || witness.actor.userId !== p.actor_user_id
    || witness.sealedAt !== a.completed_at || a.completed_by !== p.sealed_by) return { state: "integrity-unavailable", reason: "invalid_completion_witness" };
  const current = await readSnapshot(q, analysisId);
  if (!current || cephContentHash({ ...current, patientId: witness.recordedPatientId }) !== cephContentHash(witness.snapshot)) return { state: "integrity-unavailable", reason: "stored_inputs_differ_from_witness" };
  const { rows: image } = await q.query<{ sha256: string }>("SELECT sha256 FROM patient_documents WHERE id=$1", [witness.image.documentId]);
  if (image[0]?.sha256 !== witness.image.sha256) return { state: "integrity-unavailable", reason: "source_image_changed" };
  const { rows: stored } = await q.query<{ code: string; value: number }>("SELECT code,value FROM ceph_measurements WHERE analysis_id=$1", [analysisId]);
  const byCode = new Map(stored.map((m) => [m.code, Number(m.value)]));
  if (witness.measurements.some((m) => byCode.get(m.code) !== m.value)) return { state: "integrity-unavailable", reason: "stored_values_differ_from_witness" };
  return { state: "versioned", witnessSha256: p.witness_sha256, sealedAt: witness.sealedAt, sealedBy: witness.actor.username,
    engineVersion: witness.sourceIdentity.engineVersion, sourceIdentityMeaning: witness.sourceIdentityMeaning,
    measurementsWithAssumption: witness.measurements.filter((m) => m.completeness === "measured-with-assumption").length,
    measurementsWithLegacyDefinitionDifference: witness.measurements.filter((m) => m.legacyDefinitionDiffers).length };
}

export async function readCephCompletionSourcesForAnalysis(q: Query, analysisId: number): Promise<CephSourceIdentity | null> {
  const { rows: [a] } = await q.query<{ patient_id: number; document_id: number; ref_set: string }>("SELECT patient_id,document_id,ref_set FROM ceph_analyses WHERE id=$1", [analysisId]);
  return a ? readCephCompletionSources(q, { patientId: a.patient_id, documentId: a.document_id, refSet: a.ref_set }) : null;
}
