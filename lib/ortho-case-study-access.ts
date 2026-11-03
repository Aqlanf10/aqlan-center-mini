/** Fresh section/source authority for saved study reads, documentation and
 * export/recovery/download. Never authorizes from recorded patient identity. */
import type { DbClient } from "./db";
import { decodeAnyAssessmentRevision } from "./ortho-assessment-persisted-v2";
import { requirePreparedAssessmentAccess, type StudyAssessmentAccess } from "./ortho-case-study-assessment-access";
import { assertJourneyCurrent, journeyFail, type JourneyAuthority, type JourneyOwner } from "./ortho-case-journey-authority";
import type { StudySavedContent } from "./ortho-case-study-capture";
import { decodeDecisionSavedContent, requireCurrentDecisionRead } from "./ortho-case-decision-content";
import { decodeRetentionSavedContent } from "./ortho-retention-history-store";

export async function requireCurrentStudyRead(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority, saved: StudySavedContent, assessmentAccess: StudyAssessmentAccess) {
  if (saved.orthoCaseId !== owner.orthoCaseId || saved.clinicalCaseId !== owner.clinicalCaseId) journeyFail(403, "study_scope_restricted");
  assertJourneyCurrent(authority);
  for (const source of saved.sources) {
    if (source.access.images && !authority.canViewImages || source.access.plans && !authority.canViewPlans) journeyFail(403, "study_section_restricted");
    if (source.state !== "available") continue;
    if (source.selection.kind === "assessment") {
      const parsed = decodeAnyAssessmentRevision(source.payload, { patientId: saved.recordedPatientId,
        orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId });
      if (!parsed.ok) journeyFail(500, "invalid_study_assessment");
      requirePreparedAssessmentAccess(assessmentAccess, parsed.value, authority, false);
    } else if (source.selection.kind === "decision") {
      const parsed = decodeDecisionSavedContent((source.payload as { content: unknown }).content);
      if (!parsed.ok) journeyFail(500, "invalid_study_decision");
      requireCurrentDecisionRead(authority, [parsed.value], assessmentAccess);
    } else if (source.selection.kind === "retention_event") {
      const parsed = decodeRetentionSavedContent((source.payload as { content: unknown }).content);
      if (!parsed.ok) journeyFail(500, "invalid_study_retention");
      if (parsed.value.payload.documentIds.length && !authority.canViewImages) journeyFail(403, "study_retention_images_restricted");
      for (const documentId of parsed.value.payload.documentIds) {
        if (!assessmentAccess.current?.has(`document:${documentId}`)) journeyFail(403, "study_retention_source_restricted");
        const { rows } = await client.query<{ id: number }>(`SELECT d.id FROM patient_documents d WHERE d.id=$1 AND d.patient_id=$2
          AND d.removed_at IS NULL AND (d.ortho_case_id=$3 OR (d.ortho_case_id IS NULL AND EXISTS(
            SELECT 1 FROM ceph_analyses c WHERE c.document_id=d.id AND c.patient_id=$2 AND c.ortho_case_id=$3)))`,
        [documentId, owner.patientId, owner.orthoCaseId]);
        if (!rows[0]) journeyFail(403, "study_retention_source_restricted");
      }
    }
    if (source.selection.kind === "document") {
      const { rows } = await client.query<{ id: number }>(`SELECT d.id FROM patient_documents d WHERE d.id=$1 AND d.patient_id=$2
        AND d.removed_at IS NULL AND d.sha256=$3 AND (d.ortho_case_id=$4 OR (d.ortho_case_id IS NULL AND EXISTS(
          SELECT 1 FROM ceph_analyses c WHERE c.document_id=d.id AND c.patient_id=$2 AND c.ortho_case_id=$4)))`,
      [source.selection.id, owner.patientId, source.selection.contentHash, owner.orthoCaseId]);
      if (!rows[0]) journeyFail(403, "study_document_restricted");
    } else if (source.selection.kind === "ceph_study") {
      const { rows } = await client.query<{ id: number }>(`SELECT c.id FROM ceph_analyses c JOIN patient_documents d ON d.id=c.document_id
        WHERE c.id=$1 AND c.patient_id=$2 AND c.ortho_case_id=$3 AND d.patient_id=$2 AND d.removed_at IS NULL`,
      [source.selection.id, owner.patientId, owner.orthoCaseId]);
      if (!rows[0]) journeyFail(403, "study_ceph_source_restricted");
    } else if (source.selection.kind === "plan_consent") {
      if (!assessmentAccess.currentPlanIds.has(source.selection.id)) journeyFail(403, "study_plan_source_restricted");
    } else if (source.selection.kind === "adjustment") {
      const visitId = (source.payload as { visitId: number | null }).visitId;
      const { rows } = await client.query<{ id: number; visit_id: number | null }>(
        "SELECT id,visit_id FROM ortho_adjustments WHERE id=$1 AND case_id=$2", [source.selection.id, owner.orthoCaseId]);
      if (!rows[0] || rows[0].visit_id !== visitId || visitId !== null && !assessmentAccess.current?.has(`clinical_visit:${visitId}`))
        journeyFail(403, "study_adjustment_source_restricted");
    }
  }
  assertJourneyCurrent(authority);
}
