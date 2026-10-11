/** Transaction-local admission for every retained export, recovery and download.
 * Manifest visibility alone grants no authority. Source locks precede cases;
 * the manifest lock is last. No renderer or artifact storage is invoked. */
import type { DbClient } from "./db";
import { authorizeJourney, discoverJourneyOwner, lockJourneyOwner, assertJourneyCurrent, journeyFail,
  type JourneyOwnerInput } from "./ortho-case-journey-authority";
import { createStudyAssessmentAccess, lockStudySourceUnion } from "./ortho-case-study-assessment-access";
import { prepareSavedStudySourceUnion } from "./ortho-case-study-source-union";
import { requireCurrentStudyRead } from "./ortho-case-study-access";
import { decodeStudySavedContent, type StudySavedContent } from "./ortho-case-study-capture";
import { readLockedStudyHistory, type StudyContentPolicy } from "./ortho-case-study-repository";
import { decodeStudyRenderSpecification } from "./ortho-case-study-render-manifest";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { journeyHash, journeyId } from "./ortho-case-journey-records";
import type { ArtifactManifestIdentity } from "./ortho-case-study-artifact-history";
const historyPolicy: StudyContentPolicy<StudySavedContent> = { decode: decodeStudySavedContent, authored: c => c.authored,
  requireCurrentRead: async () => journeyFail(500, "export_authority_not_prepared") };
interface ExportRow extends Record<string, unknown> {
  id: number; patient_id: number; recorded_patient_id: number; ortho_case_id: number; clinical_case_id: number;
  study_revision_id: number; study_kind: unknown; study_sha256: unknown; actor_user_id: unknown;
  created_at: unknown; command_id: unknown; request_fingerprint: unknown; content_sha256: unknown;
  rendering_contract_sha256: unknown; formats: unknown; content: unknown;
}
export async function lockCurrentStudyExport(client: DbClient, input: JourneyOwnerInput & { manifestId: number }, write: boolean) {
  if (!journeyId(input.manifestId)) journeyFail(400, "invalid_export_identity");
  const authority = await authorizeJourney(client, input, write), discovered = await discoverJourneyOwner(client, input);
  const { rows: [identity] } = await client.query<{ study_revision_id: number; bytes: number }>(
    `SELECT study_revision_id,octet_length(content::text) AS bytes FROM ortho_case_study_export_manifests
     WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 AND clinical_case_id=$4`,
    [input.manifestId, input.patientId, input.orthoCaseId, discovered.clinicalCaseId]);
  if (!identity) journeyFail(404, "export_not_found");
  if (!journeyId(identity.study_revision_id) || !Number.isSafeInteger(identity.bytes) || identity.bytes < 1 || identity.bytes > 8 * 1024 * 1024) journeyFail(409, "export_manifest_limit");
  const history = await readLockedStudyHistory(client, discovered, historyPolicy);
  const study = history.revisions.find(r => r.id === identity.study_revision_id);
  if (!study) journeyFail(500, "export_study_missing");
  const access = createStudyAssessmentAccess();
  await prepareSavedStudySourceUnion(client, discovered, authority, [study.content], access);
  await lockStudySourceUnion(client, discovered, authority, access);
  const owner = await lockJourneyOwner(client, input, write);
  if (owner.clinicalCaseId !== discovered.clinicalCaseId) journeyFail(409, "export_owner_changed");
  await requireCurrentStudyRead(client, owner, authority, study.content, access);
  const { rows: [row] } = await client.query<ExportRow>(`SELECT * FROM ortho_case_study_export_manifests
    WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 AND clinical_case_id=$4 ${write ? "FOR UPDATE" : "FOR SHARE"}`,
    [input.manifestId, owner.patientId, owner.orthoCaseId, owner.clinicalCaseId]);
  if (!row) journeyFail(404, "export_not_found");
  if (!journeyId(row.recorded_patient_id) || !journeyId(row.actor_user_id) || row.study_revision_id !== study.id
    || row.study_kind !== study.kind || row.study_sha256 !== study.contentHash || !journeyHash(row.content_sha256)
    || !journeyHash(row.rendering_contract_sha256) || !journeyHash(row.request_fingerprint)
    || typeof row.command_id !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(row.command_id)
    || !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime())) journeyFail(500, "invalid_export_record");
  const checked = decodeStudyRenderSpecification(row.content, study);
  if (!checked.ok || journeyContentHash(checked.value) !== row.content_sha256
    || journeyContentHash(checked.value.rendering) !== row.rendering_contract_sha256
    || journeyContentHash(row.formats) !== journeyContentHash(checked.value.formats)) journeyFail(500, "invalid_export_record");
  const manifest: ArtifactManifestIdentity = { id: row.id, patientId: owner.patientId, orthoCaseId: owner.orthoCaseId,
    clinicalCaseId: owner.clinicalCaseId, contentHash: row.content_sha256, renderingContractHash: row.rendering_contract_sha256,
    formats: checked.value.formats };
  assertJourneyCurrent(authority);
  return { owner, authority, study, manifest, specification: checked.value, createdAt: row.created_at.toISOString() };
}
