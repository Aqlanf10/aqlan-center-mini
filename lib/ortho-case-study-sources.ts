/** Canonical transaction-local study capture. No renderer, file reads, schedule,
 * consent or financial writes. Unsupported facts are explicitly unavailable. */
import type { DbClient } from "./db";
import { STUDY_TEMPLATE_HASH } from "./ortho-case-study-template";
import { journeyClinicalSources } from "./ortho-case-journey-clinical-sources";
import { decodeDecisionSavedContent, requireDecisionRead } from "./ortho-case-decision-content";
import { decodeRetentionSavedContent } from "./ortho-retention-history-store";
import { journeyContentHash, journeyHistory } from "./ortho-case-journey-history";
import { lockJourneyPlan, type JourneyPlanSource } from "./ortho-case-journey-plan-source";
import { JourneyFault, journeyFail, type JourneyAuthority, type JourneyOwner, type JourneyOwnerInput } from "./ortho-case-journey-authority";
import { journeyHash, journeyId } from "./ortho-case-journey-records";
import type { StudyDraftContent, StudySourceSelection } from "./ortho-case-study";
import { addStudyPlanTargets, addStudySourceTargets, lockStudySourceUnion, type StudyAssessmentAccess } from "./ortho-case-study-assessment-access";
import { studyPgPositiveInteger } from "./ortho-case-study-pg-values";

export interface StudySourceCapture {
  selection: StudySourceSelection;
  state: "available" | "unavailable";
  unavailableReason: "source_missing_or_outside_case" | "source_schema_unavailable" | "document_removed" | "ceph_review_projection_unavailable" | null;
  access: { images: boolean; plans: boolean };
  /** Only canonical readers below create payloads. The persisted capture decoder
   * must validate this kind-specific payload before exposing saved history. */
  payload: unknown;
}
export interface StudyExternalSources {
  plans: Map<number, JourneyPlanSource>;
  documents: Map<number, Record<string, unknown>>;
  ceph: Map<number, Record<string, unknown>>;
  visits: Map<number, number | null>;
}
const selectedIds = (content: StudyDraftContent, kind: StudySourceSelection["kind"]) =>
  [...new Set(content.sources.filter(s => s.kind === kind).map(s => s.id))].sort((a, b) => a - b);
const iso = (raw: unknown): string | null => {
  if (raw === null) return null;
  const value = raw instanceof Date ? raw.toISOString() : raw;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) journeyFail(500, "invalid_study_source_date");
  return value;
};
const text = (raw: unknown, max = 4000): string | null => {
  if (raw === null) return null;
  if (typeof raw !== "string" || raw.length > max) journeyFail(500, "invalid_study_source_text");
  return raw;
};

/** Called after patient/current account/access locks and before case/bridge locks. */
export async function lockStudyExternalSources(client: DbClient, input: JourneyOwnerInput, discoveredOwner: JourneyOwner,
  authority: JourneyAuthority, content: StudyDraftContent, assessmentAccess: StudyAssessmentAccess): Promise<StudyExternalSources> {
  if (STUDY_TEMPLATE_HASH !== content.template.contentHash) journeyFail(409, "study_template_changed");
  const external: StudyExternalSources = { plans: new Map(), documents: new Map(), ceph: new Map(), visits: new Map() };
  const adjustmentIds = selectedIds(content, "adjustment");
  if (adjustmentIds.length) {
    const { rows } = await client.query<{ id: number; visit_id: number | null }>(
      "SELECT id,visit_id FROM ortho_adjustments WHERE case_id=$1 AND id=ANY($2::int[]) ORDER BY id", [input.orthoCaseId, adjustmentIds]);
    for (const row of rows) external.visits.set(row.id, row.visit_id);
    addStudySourceTargets(assessmentAccess, rows.flatMap(r => r.visit_id === null ? [] : [{ kind: "clinical_visit" as const, id: r.visit_id }]));
  }
  const selectedPlans = selectedIds(content, "plan_consent");
  addStudyPlanTargets(assessmentAccess, selectedPlans);
  addStudySourceTargets(assessmentAccess, content.sources.flatMap(s => s.kind === "document" || s.kind === "ceph_study" ? [{ kind: s.kind, id: s.id }] : []));
  await lockStudySourceUnion(client, discoveredOwner, authority, assessmentAccess, async () => {
    for (const id of selectedPlans) {
      try { external.plans.set(id, await lockJourneyPlan(client, input, authority, id)); }
      catch (error) {
        if (!(error instanceof JourneyFault) || error.code !== "plan_scope_mismatch") throw error;
      }
    }
  });
  for (const id of external.visits.values()) if (id !== null && !assessmentAccess.current?.has(`clinical_visit:${id}`)) journeyFail(409, "study_visit_scope_changed");
  if (!authority.canViewImages && content.sources.some(s => s.kind === "document" || s.kind === "ceph_study")) journeyFail(403, "study_images_restricted");
  for (const id of selectedIds(content, "ceph_study")) {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id,patient_id,ortho_case_id,document_id,status,phase,xray_date::text,device,ref_set,study_kind,note,
       created_at,created_by,completed_at,completed_by,corrects_analysis_id FROM ceph_analyses
       WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3`, [id, input.patientId, input.orthoCaseId]);
    if (rows[0]) external.ceph.set(id, rows[0]);
  }
  const cephDocumentIds = [...external.ceph.values()].map(row => {
    if (!journeyId(row.document_id)) journeyFail(500, "invalid_ceph_document"); return row.document_id;
  });
  for (const id of [...new Set([...selectedIds(content, "document"), ...cephDocumentIds])].sort((a, b) => a - b)) {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id,patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,width,height,removed_at
       FROM patient_documents WHERE id=$1 AND patient_id=$2
         AND (ortho_case_id=$3 OR (ortho_case_id IS NULL AND id=ANY($4::int[])))`, [id, input.patientId, input.orthoCaseId, cephDocumentIds]);
    if (rows[0]) external.documents.set(id, rows[0]);
  }
  // Match the assessment source graph: backing documents precede studies.
  // Discovery is not authority; recheck the exact linkage after the child wait.
  for (const id of selectedIds(content, "ceph_study")) {
    const discovered = external.ceph.get(id);
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id,patient_id,ortho_case_id,document_id,status,phase,xray_date::text,device,ref_set,study_kind,note,
       created_at,created_by,completed_at,completed_by,corrects_analysis_id FROM ceph_analyses
       WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3`, [id, input.patientId, input.orthoCaseId]);
    if (!rows[0]) { external.ceph.delete(id); continue; }
    if (!discovered || rows[0].document_id !== discovered.document_id) journeyFail(409, "study_ceph_document_changed");
    external.ceph.set(id, rows[0]);
  }
  return external;
}

async function captureSources(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority,
  content: StudyDraftContent, external: StudyExternalSources, assessmentAccess: StudyAssessmentAccess, discoverHash: boolean): Promise<StudySourceCapture[]> {
  const needsClinical = content.sources.some(s => ["assessment", "diagnosis", "strategy"].includes(s.kind));
  const requested = (["assessment", "diagnosis", "strategy"] as const).filter(kind => content.sources.some(s => s.kind === kind));
  const clinical = needsClinical ? await journeyClinicalSources(client, owner, authority, requested, assessmentAccess, true) : null;
  const decisions = content.sources.some(s => s.kind === "decision")
    ? (await journeyHistory(client, "ortho_decision_revisions", owner, decodeDecisionSavedContent)).revisions : [];
  const retention = content.sources.some(s => s.kind === "retention_event")
    ? (await journeyHistory(client, "ortho_retention_entries", owner, decodeRetentionSavedContent)).revisions : [];
  const captures: StudySourceCapture[] = [];
  for (const selection of content.sources) {
    let payload: unknown = null, actualHash: string | null = null;
    const access = { images: false, plans: false };
    let reason: StudySourceCapture["unavailableReason"] = "source_missing_or_outside_case";
    if (selection.kind === "assessment") {
      if (clinical!.unavailableAssessments.get(selection.id) === selection.version) reason = "source_schema_unavailable";
      const row = clinical!.assessments.find(r => r.id === selection.id && r.version === selection.version);
      if (row) {
        access.images = await clinical!.assessmentUsesImaging(row);
        if (!await clinical!.readableAssessment(row)) journeyFail(403, "study_assessment_restricted");
        // Includes exact stored schema2 results/witnesses. No analysis is recomputed here.
        payload = row; actualHash = row.contentHash;
      }
    } else if (selection.kind === "diagnosis") {
      const row = clinical!.diagnoses.find(r => r.id === selection.id && r.version === selection.version);
      if (row) { payload = row; actualHash = journeyContentHash(row.content); }
    } else if (selection.kind === "strategy") {
      const row = clinical!.strategies.find(r => r.id === selection.id && r.version === selection.version);
      if (row) {
        if (!clinical!.readableStrategy(row)) journeyFail(403, "study_strategy_restricted");
        access.plans = row.rows.some(r => r.planItems.length > 0);
        payload = row; actualHash = journeyContentHash(row.rows);
      }
    } else if (selection.kind === "decision") {
      const row = decisions.find(r => r.id === selection.id && r.version === selection.version);
      if (row) { requireDecisionRead(authority, [row.content]); Object.assign(access, { images: row.content.sourceAccess.imaging, plans: row.content.sourceAccess.plans }); payload = row; actualHash = row.contentHash; }
    } else if (selection.kind === "retention_event") {
      const row = retention.find(r => r.id === selection.id && r.version === selection.version);
      if (row) { access.images = row.content.payload.documentIds.length > 0; payload = row; actualHash = row.contentHash; }
    } else if (selection.kind === "plan_consent") {
      access.plans = true;
      const plan = external.plans.get(selection.id);
      if (plan && owner.planId === plan.planId) {
        const items = plan.items.filter(item => item.caseId === owner.clinicalCaseId);
        payload = { ...plan, items, itemScope: "selected_clinical_case_only", excludedItemCount: plan.items.length - items.length,
          consentScope: "existing_whole_plan_observation" };
        actualHash = plan.consent.observationHash;
      }
    } else if (selection.kind === "document") {
      access.images = true; const doc = external.documents.get(selection.id);
      if (doc && doc.removed_at !== null) reason = "document_removed";
      else if (doc) {
        const sizeBytes = studyPgPositiveInteger(doc.size_bytes);
        if (!journeyHash(doc.sha256)
          || !(doc.width === null || journeyId(doc.width)) || !(doc.height === null || journeyId(doc.height))) journeyFail(500, "invalid_study_document");
        payload = { id: selection.id, title: text(doc.title, 500), mimeType: text(doc.mime_type, 100), sizeBytes,
          contentHash: doc.sha256, width: doc.width, height: doc.height };
        actualHash = doc.sha256;
      }
    } else if (selection.kind === "ceph_study") {
      access.images = true;
      const row = external.ceph.get(selection.id);
      if (row) {
        if (!journeyId(row.document_id) || typeof row.status !== "string" || !["draft", "completed", "discarded"].includes(row.status)) journeyFail(500, "invalid_ceph_source");
        const document = external.documents.get(row.document_id);
        if (!document) journeyFail(409, "ceph_document_scope_changed");
        if (!journeyHash(document.sha256)) journeyFail(500, "invalid_ceph_document_hash");
        const { rows: measurements } = await client.query<{ code: string; value: number }>(
          "SELECT code,value FROM ceph_measurements WHERE analysis_id=$1 ORDER BY code LIMIT 257", [selection.id]);
        if (measurements.length > 256 || new Set(measurements.map(m => m.code)).size !== measurements.length
          || measurements.some(m => typeof m.code !== "string" || !m.code || m.code.length > 100 || !Number.isFinite(m.value))) journeyFail(500, "invalid_ceph_measurements");
        const { rows: diagnoses } = await client.query<Record<string, unknown>>(
          "SELECT skeletal,dental,soft_tissue,note,final_dx,created_by,created_at,updated_at FROM ceph_diagnoses WHERE analysis_id=$1 LIMIT 2", [selection.id]);
        if (diagnoses.length > 1) journeyFail(500, "invalid_ceph_diagnosis");
        const dx = diagnoses[0];
        payload = { id: selection.id, status: row.status, phase: text(row.phase, 100), acquisitionDate: text(row.xray_date, 20),
          device: text(row.device, 500), referenceSetKey: text(row.ref_set, 200), studyKind: text(row.study_kind, 100), note: text(row.note),
          createdAt: iso(row.created_at), createdBy: text(row.created_by, 200), completedAt: iso(row.completed_at), completedBy: text(row.completed_by, 200),
          correctsStudyId: row.corrects_analysis_id === null ? null : studyPgPositiveInteger(row.corrects_analysis_id),
          image: { documentId: row.document_id, contentHash: document.sha256, state: document.removed_at === null ? "available" : "removed" },
          measurements: measurements.map(m => ({ code: m.code, value: m.value, unit: null, provenance: "stored_measurement_unit_not_versioned" })),
          diagnosis: dx ? { skeletal: text(dx.skeletal), dental: text(dx.dental), softTissue: text(dx.soft_tissue), note: text(dx.note),
            finalDx: text(dx.final_dx), createdBy: text(dx.created_by, 200), createdAt: iso(dx.created_at), updatedAt: iso(dx.updated_at) } : null,
          interpretation: { state: "unavailable", reason: "review_and_reference_witness_not_versioned" },
          historicalCompletionMeaning: "stored_completion_not_new_clinical_validation" };
        actualHash = journeyContentHash(payload);
      }
    } else if (selection.kind === "adjustment" && external.visits.has(selection.id)) {
      const { rows: [row] } = await client.query<Record<string, unknown>>(`SELECT a.id,a.visit_id,a.done_on::text,a.phase,a.upper_wire,a.lower_wire,a.done,a.note,
        to_char(v.signed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS signed_at
        FROM ortho_adjustments a LEFT JOIN visits v ON v.id=a.visit_id WHERE a.id=$1 AND a.case_id=$2 FOR SHARE OF a`, [selection.id, owner.orthoCaseId]);
      if (!row || row.visit_id !== external.visits.get(selection.id)) journeyFail(409, "study_session_changed");
      payload = { id: selection.id, visitId: row.visit_id, doneOn: text(row.done_on, 20), phase: text(row.phase),
        upperWire: text(row.upper_wire), lowerWire: text(row.lower_wire), done: text(row.done), note: text(row.note), signedAt: iso(row.signed_at) };
      actualHash = journeyContentHash(payload);
    }
    if (access.images && !authority.canViewImages || access.plans && !authority.canViewPlans) journeyFail(403, "study_source_restricted");
    if (!discoverHash && actualHash !== null && actualHash !== selection.contentHash) journeyFail(409, "study_source_version_changed");
    captures.push({ selection: discoverHash && actualHash !== null ? { ...selection, contentHash: actualHash } : selection, state: payload === null ? "unavailable" : "available", unavailableReason: payload === null ? reason : null, access, payload });
  }
  return captures;
}

/** Saved commands always enforce the user's exact previously offered source hash. */
export function captureStudySources(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority,
  content: StudyDraftContent, external: StudyExternalSources, assessmentAccess: StudyAssessmentAccess) {
  return captureSources(client, owner, authority, content, external, assessmentAccess, false);
}
/** Internal inventory discovery only. The inventory reader constructs its IDs
 * from bounded owned SQL, then obtains the canonical hash through the same
 * capture implementation. This function never persists a study. Unavailable
 * entries must not expose the discovery placeholder as a verified hash. */
export function captureStudyInventorySources(client: DbClient, owner: JourneyOwner, authority: JourneyAuthority,
  content: StudyDraftContent, external: StudyExternalSources, assessmentAccess: StudyAssessmentAccess) {
  return captureSources(client, owner, authority, content, external, assessmentAccess, true);
}
