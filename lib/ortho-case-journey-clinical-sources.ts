import type { DbClient } from "./db";
import { decodeAnyAssessmentRevision, type AnyAssessmentRevision } from "./ortho-assessment-persisted-v2";
import { createStudyAssessmentAccess, requirePreparedAssessmentAccess, type StudyAssessmentAccess } from "./ortho-case-study-assessment-access";
import { decodeStrategyRevision, type StrategyRevision } from "./ortho-treatment-strategy";
import { journeyFail, type JourneyAuthority } from "./ortho-case-journey-authority";
import { journeyContentHash, JOURNEY_HISTORY_LIMITS } from "./ortho-case-journey-history";
import { journeyHash, journeyId, type DecisionContent, type JourneyScope } from "./ortho-case-journey-records";
export interface JourneyDiagnosis { id: number; version: number; createdAt: string; createdBy: string; content: Record<string, string | null> }
const iso = (value: unknown): string => {
  const s = value instanceof Date ? value.toISOString() : value;
  if (typeof s !== "string" || !Number.isFinite(Date.parse(s))) journeyFail(500, "invalid_source_date"); return s;
};
function lineage<T extends { id: number; version: number; supersedesRevisionId: number | null }>(revisions: T[]) {
  const seen = new Set<number>();
  for (let index = 0; index < revisions.length; index++) {
    const row = revisions[index], previous = revisions[index + 1];
    if (seen.has(row.id) || row.version !== (previous?.version ?? 0) + 1 || row.supersedesRevisionId !== (previous?.id ?? null)) journeyFail(500, "invalid_source_lineage");
    seen.add(row.id);
  }
}
export async function journeyClinicalSources(client: DbClient, scope: JourneyScope, authority: JourneyAuthority,
  requested: readonly ("assessment" | "strategy" | "diagnosis")[] = ["assessment", "strategy", "diagnosis"],
  assessmentAccess: StudyAssessmentAccess = createStudyAssessmentAccess(), allowUnsupportedAssessments = false) {
  const tables = { assessment: "ortho_assessment_revisions", strategy: "ortho_strategy_revisions", diagnosis: "patient_diagnoses" } as const;
  for (const kind of [...new Set(requested)]) {
    const table = tables[kind];
    const { rows: [size] } = await client.query<{ count: string; bytes: string }>(
      `SELECT COUNT(*)::text AS count,COALESCE(SUM(octet_length(to_jsonb(s)::text)),0)::text AS bytes FROM ${table} s WHERE ortho_case_id=$1`, [scope.orthoCaseId]);
    if (!size || !/^\d+$/.test(size.count) || !/^\d+$/.test(size.bytes)) journeyFail(500, "invalid_source_history_size");
    if (BigInt(size.count) > BigInt(JOURNEY_HISTORY_LIMITS.rows) || BigInt(size.bytes) > BigInt(JOURNEY_HISTORY_LIMITS.contentBytes)) journeyFail(409, "source_history_limit_exceeded");
  }
  const assessmentRows = requested.includes("assessment") ? (await client.query<Record<string, unknown>>(`SELECT * FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version DESC`, [scope.orthoCaseId])).rows : [];
  const unavailableAssessments = new Map<number, number>();
  const assessmentLineage = assessmentRows.map(row => {
    if (!journeyId(row.id) || !journeyId(row.version) || row.patient_id !== scope.patientId || row.ortho_case_id !== scope.orthoCaseId
      || row.clinical_case_id !== scope.clinicalCaseId || !journeyHash(row.content_sha256)
      || row.supersedes_revision_id !== null && !journeyId(row.supersedes_revision_id)) journeyFail(500, "invalid_assessment_source_identity");
    return { id: row.id, version: row.version, supersedesRevisionId: row.supersedes_revision_id as number | null };
  });
  lineage(assessmentLineage);
  const assessments: AnyAssessmentRevision[] = assessmentRows.flatMap(row => {
    const parsed = decodeAnyAssessmentRevision({ id: row.id, patientId: row.patient_id, recordedPatientId: row.recorded_patient_id,
      orthoCaseId: row.ortho_case_id, clinicalCaseId: row.clinical_case_id, schemaVersion: row.schema_version,
      version: row.version, supersedesRevisionId: row.supersedes_revision_id, recordingContext: row.recording_context,
      createdAt: iso(row.created_at), createdBy: row.created_by, reason: row.reason, contentHash: row.content_sha256, content: row.content }, scope);
    if (!parsed.ok) {
      if (allowUnsupportedAssessments && (parsed.code === "unsupported_schema" || parsed.code === "unsupported_payload_verifier")) {
        unavailableAssessments.set(row.id as number, row.version as number); return [];
      }
      journeyFail(500, parsed.code);
    }
    return [parsed.value];
  });
  const strategyRows = requested.includes("strategy") ? (await client.query<Record<string, unknown>>(`SELECT * FROM ortho_strategy_revisions WHERE ortho_case_id=$1 ORDER BY version DESC`, [scope.orthoCaseId])).rows : [];
  const strategies: StrategyRevision[] = strategyRows.map(row => {
    const parsed = decodeStrategyRevision({ id: row.id, patientId: row.patient_id, recordedPatientId: row.recorded_patient_id,
      orthoCaseId: row.ortho_case_id, clinicalCaseId: row.clinical_case_id, schemaVersion: row.schema_version,
      version: row.version, supersedesRevisionId: row.supersedes_revision_id, recordingContext: row.recording_context,
      createdAt: iso(row.created_at), createdBy: row.created_by, reason: row.reason, rows: row.rows }, scope);
    if (!parsed.ok) journeyFail(500, parsed.code); return parsed.value;
  });
  lineage(strategies);
  const diagnosisRows = requested.includes("diagnosis") ? (await client.query<Record<string, unknown>>(`SELECT id,patient_id,ortho_case_id,version,content,created_at,created_by FROM patient_diagnoses WHERE ortho_case_id=$1 ORDER BY version DESC,id DESC`, [scope.orthoCaseId])).rows : [];
  const diagnoses: JourneyDiagnosis[] = diagnosisRows.map(row => {
    if (!journeyId(row.id) || !journeyId(row.version) || row.patient_id !== scope.patientId || row.ortho_case_id !== scope.orthoCaseId
      || typeof row.created_by !== "string" || !row.content || typeof row.content !== "object" || Array.isArray(row.content)) journeyFail(500, "invalid_diagnosis_source");
    const content: Record<string, string | null> = {}, allowed = ["skeletal", "dental", "crowding", "overjet", "bite", "note"];
    for (const [key, value] of Object.entries(row.content)) {
      if (!allowed.includes(key) || value !== null && (typeof value !== "string" || value.length > (key === "note" ? 1000 : 200))) journeyFail(500, "invalid_diagnosis_content");
      content[key] = value as string | null;
    }
    if (!Object.values(content).some(v => typeof v === "string" && v.trim())) journeyFail(500, "empty_diagnosis_source");
    return { id: row.id, version: row.version, createdAt: iso(row.created_at), createdBy: row.created_by, content };
  });
  if (new Set(diagnoses.map(r => r.id)).size !== diagnoses.length) journeyFail(500, "duplicate_diagnosis_source");
  // Graphs must already have been resolved before the case/bridge lock.
  const assessmentUsesImaging = async (revision: AnyAssessmentRevision): Promise<boolean> =>
    requirePreparedAssessmentAccess(assessmentAccess, revision, authority, true);
  const readableAssessment = async (revision: AnyAssessmentRevision) => !(await assessmentUsesImaging(revision)) || authority.canViewImages;
  const readableStrategy = (revision: StrategyRevision) => authority.canViewPlans || !revision.rows.some(row => row.planItems.length > 0);
  return { assessments, unavailableAssessments, strategies, diagnoses, readableAssessment, readableStrategy, assessmentUsesImaging };
}
export async function exactDecisionReferences(client: DbClient, scope: JourneyScope, authority: JourneyAuthority, content: DecisionContent, assessmentAccess: StudyAssessmentAccess) {
  const requested = (["assessment", "strategy", "diagnosis"] as const).filter(kind => content[kind] !== null);
  const sources = await journeyClinicalSources(client, scope, authority, requested, assessmentAccess);
  const assessment = content.assessment === null ? null : sources.assessments.find(r => r.id === content.assessment!.id && r.version === content.assessment!.version && r.contentHash === content.assessment!.contentHash);
  const strategy = content.strategy === null ? null : sources.strategies.find(r => r.id === content.strategy!.id && r.version === content.strategy!.version && journeyContentHash(r.rows) === content.strategy!.contentHash);
  const diagnosis = content.diagnosis === null ? null : sources.diagnoses.find(r => r.id === content.diagnosis!.id && r.version === content.diagnosis!.version);
  if (assessment === undefined || strategy === undefined || diagnosis === undefined) journeyFail(409, "clinical_reference_changed");
  if (assessment && !await sources.readableAssessment(assessment) || strategy && !sources.readableStrategy(strategy)) journeyFail(403, "clinical_reference_restricted");
  return { assessment, strategy, diagnosis, assessmentUsesImaging: assessment ? await sources.assessmentUsesImaging(assessment) : false };
}
