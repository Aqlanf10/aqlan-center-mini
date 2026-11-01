/** Synthetic-only persisted assessment fixtures. No production writer is bypassed
 * outside disposable test databases. Uses the existing version-pinned serializer. */
import { randomUUID } from "node:crypto";
import type { DbClient } from "../../lib/db";
import { assessmentCommandV2 } from "./ortho-assessment-schema2";
import { createPersistedAssessmentV2, assessmentJsonHash } from "../../lib/ortho-assessment-persisted-v2";
import type { AssessmentSourceV2 } from "../../lib/ortho-assessment-v2";
export async function seedCanonicalAssessment(q: Pick<DbClient, "query">, input: {
  patientId: number; caseId: number; bridgeId: number; actorId: number;
  version?: number; previous?: number | null; sources?: AssessmentSourceV2[]; reason?: string;
  badHash?: boolean; schemaVersion?: number;
}) {
  const draft = assessmentCommandV2().content;
  for (let n = 0; n < (input.sources?.length ?? 0); n++) draft.observations.observations[Math.floor(n / 32)].provenance!.sources.push(input.sources![n]);
  const parsed = createPersistedAssessmentV2(draft); if (!parsed.ok) throw new Error(parsed.code);
  const content = parsed.value, hash = assessmentJsonHash(content);
  const row = (await q.query<{ id: number }>(`INSERT INTO ortho_assessment_revisions
    (patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,schema_version,version,supersedes_revision_id,actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,content_sha256,content)
    VALUES($1,$1,$2,$3,$4,$5,$6,$7,'SYN assessment recorder',$8,'current',$9,$10,$11,$12::jsonb) RETURNING id`,
  [input.patientId, input.caseId, input.bridgeId, input.schemaVersion ?? 2, input.version ?? 1, input.previous ?? null, input.actorId,
    input.reason ?? "تقييم اصطناعي محفوظ", randomUUID(), "a".repeat(64), input.badHash ? "0".repeat(64) : hash, JSON.stringify(content)])).rows[0];
  return { id: row.id, hash, content };
}
