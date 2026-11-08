import type { DbClient } from "./db";
import { journeyFail, type JourneyOwner } from "./ortho-case-journey-authority";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { canonicalJourneyJSON } from "./ortho-case-journey-json";
import { readStoredFacialRevision } from "./ortho-facial-store";
import { facialImageBasis } from "./ortho-facial-image";
import { problemSourceIdentity, type ProblemSourceCandidate } from "./ortho-problem-sources";

/** Discover only heads, including draft heads: never fall back to a previously
 * reviewed note after its clinician has saved a newer draft. Patient lock held. */
export async function discoverFacialProblemSources(client: DbClient, scope: JourneyOwner) {
  const rows = (await client.query<{ id: number; document_id: number; bytes: number }>(`SELECT DISTINCT ON (document_id) id,document_id,
    octet_length(command::text)+octet_length(results::text) AS bytes FROM ortho_facial_revisions
    WHERE patient_id=$1 AND ortho_case_id=$2 ORDER BY document_id,version DESC LIMIT 21`, [scope.patientId, scope.orthoCaseId])).rows;
  if (rows.length > 20 || rows.some(r => !Number.isSafeInteger(Number(r.bytes)) || Number(r.bytes) > 262144)) journeyFail(409, "problem_source_budget");
  return rows;
}

/** Called after the complete external-source union has locked documents before
 * ceph/visits. Only explicit clinician prose is offered, never derived diagnosis. */
export async function readFacialProblemSources(client: DbClient, scope: JourneyOwner, heads: Awaited<ReturnType<typeof discoverFacialProblemSources>>): Promise<ProblemSourceCandidate[]> {
  const out: ProblemSourceCandidate[] = [];
  for (const head of heads) {
    const raw = (await client.query("SELECT * FROM ortho_facial_revisions WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3", [head.id, scope.patientId, scope.orthoCaseId])).rows[0];
    if (!raw) journeyFail(409, "facial_history_invalid");
    const revision = readStoredFacialRevision(raw, scope);
    if (revision.command.content.review.state !== "reviewed" || !revision.command.content.review.note.trim()) continue;
    if (revision.results.measures.some(m => m.state === "invalid_geometry")) journeyFail(409, "facial_history_invalid");
    const doc = (await client.query<{ id: number; sha256: string; storage_key: string; mime_type: string; size_bytes: unknown }>(`SELECT id,sha256,storage_key,mime_type,size_bytes FROM patient_documents
      WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 AND removed_at IS NULL
      AND (photo_stage IS NULL OR photo_stage<>'archived') AND photo_view='extraoral_frontal'`, [head.document_id, scope.patientId, scope.orthoCaseId])).rows[0];
    if (!doc) continue;
    const image = (await facialImageBasis(doc)).basis;
    if (canonicalJourneyJSON(image) !== canonicalJourneyJSON(revision.command.content.image)) journeyFail(409, "facial_image_changed");
    const ref = { kind: "facial_review" as const, id: revision.id, member: `document_${revision.documentId}_review`, version: `sha256:${journeyContentHash(revision)}` };
    out.push({ identity: problemSourceIdentity(ref), ref, category: "مراجعة وجه يدوية محفوظة", title: `ملاحظة الطبيب · صورة #${revision.documentId}`,
      summary: revision.command.content.review.note, proposedLabel: null, site: null, target: { kind: "case" },
      snapshot: { revision, limitation: "Manual 2D photographic description, not calibrated anatomy or automatic diagnosis" },
      sourceActor: revision.createdBy, sourceDate: revision.createdAt, available: true, requiresImages: true });
  }
  return out;
}
