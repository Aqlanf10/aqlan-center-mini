import "server-only";
import { parseCephCompletionSnapshot, type CephCompletionSnapshot } from "./ceph-completion-snapshot";
import { cephProvenanceHash, readCephCompletionSources } from "./ceph-completion-provenance";
import type { CephSourceIdentity } from "./ceph-source-review";
import { readCephCorrectionSource, requireCephCorrectionAncestry, type CephCorrectionStoredColumns } from "./ceph-correction-source";
import type { CephCorrectionSourceToken } from "./ceph-correction-origin";
import type { DbClient } from "./db";

/**
 * Canonical ceph writes use staging's protected writers, which need the exact reviewed snapshot,
 * source identity and correction token. Those carry internal identifiers (image document, case) that
 * the canonical study read never discloses. The read therefore returns only a fingerprint computed
 * here; the command recomputes the same values inside the admitted operation, refuses on any
 * difference, and hands the recomputed values to staging's writer, which re-checks them under its
 * own locks. Read and command share this one builder, so equal state means an equal fingerprint.
 */
type Query = Pick<DbClient, "query">;
export type CephReviewUnavailable = { state: "unavailable"; reason: string };

export async function cephCompletionReviewWith(q: Query, studyId: number): Promise<
  { state: "available"; snapshot: CephCompletionSnapshot; sources: CephSourceIdentity; fingerprint: string } | CephReviewUnavailable> {
  const { rows: [row] } = await q.query<{ patient_id: number; document_id: number | null; ref_set: string; status: string;
    cal_x1: number | null; cal_y1: number | null; cal_x2: number | null; cal_y2: number | null; cal_mm: number | null; mm_per_pixel: number | null }>(
    "SELECT patient_id,document_id,ref_set,status,cal_x1,cal_y1,cal_x2,cal_y2,cal_mm,mm_per_pixel FROM ceph_analyses WHERE id=$1", [studyId]);
  // A completed study is rebuilt too, so a lost-response replay of the same completion reaches staging's
  // read-only replay rule; the canonical read itself only offers this fingerprint for drafts.
  if (!row || (row.status !== "draft" && row.status !== "completed") || row.document_id === null) return { state: "unavailable", reason: "image_or_reference_source_unavailable" };
  // pg returns BIGINT identities as text; the snapshot contract takes numbers.
  const patientId = Number(row.patient_id), documentId = Number(row.document_id);
  const calibration = [row.cal_x1, row.cal_y1, row.cal_x2, row.cal_y2, row.cal_mm].every(n => n !== null)
    ? { x1: row.cal_x1!, y1: row.cal_y1!, x2: row.cal_x2!, y2: row.cal_y2!, mm: row.cal_mm! } : null;
  const landmarks = (await q.query<{ code: string; x: number; y: number; source: string }>(
    "SELECT code,x,y,source FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code", [studyId])).rows;
  const { rows: [d] } = await q.query<{ skeletal: string | null; dental: string | null; soft_tissue: string | null; note: string | null; final_dx: string }>(
    "SELECT skeletal,dental,soft_tissue,note,final_dx FROM ceph_diagnoses WHERE analysis_id=$1", [studyId]);
  const snapshot = parseCephCompletionSnapshot({ patientId, documentId, refSet: row.ref_set,
    calibration, mmPerPixel: row.mm_per_pixel, landmarks: landmarks.map(p => ({ code: p.code, x: p.x, y: p.y, source: p.source })),
    diagnosis: d ? { skeletal: d.skeletal, dental: d.dental, softTissue: d.soft_tissue, note: d.note, finalDx: d.final_dx } : null });
  if (!snapshot) return { state: "unavailable", reason: "saved_draft_not_completable" };
  const sources = await readCephCompletionSources(q, { patientId, documentId, refSet: row.ref_set });
  if (sources.state !== "available") return sources;
  return { state: "available", snapshot, sources: sources.identity,
    fingerprint: cephProvenanceHash({ schemaVersion: 1, kind: "ceph-completion-review", snapshot, sources: sources.identity }) };
}

export async function cephCorrectionReviewWith(q: Query, studyId: number): Promise<
  { state: "available"; token: CephCorrectionSourceToken; fingerprint: string } | CephReviewUnavailable> {
  const source = await readCephCorrectionSource(q, studyId, "snapshot");
  if (source.state !== "available") return source;
  try {
    const stored = (await q.query<CephCorrectionStoredColumns>("SELECT * FROM ceph_analyses WHERE id=$1", [studyId])).rows[0];
    if (!stored) throw new Error("missing");
    await requireCephCorrectionAncestry(q, stored, "snapshot");
  } catch { return { state: "unavailable", reason: "correction_ancestry_unavailable" }; }
  return { state: "available", token: source.token,
    fingerprint: cephProvenanceHash({ schemaVersion: 1, kind: "ceph-correction-review", token: source.token, origin: source.origin }) };
}

export const isCephReviewFingerprint = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
