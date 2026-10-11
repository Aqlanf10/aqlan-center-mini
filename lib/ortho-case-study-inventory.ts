/** Bounded, authorized source choices for the persisted study editor. No full
 * clinical payload, file path, financial value, consent grant or write is returned. */
import type { DbClient } from "./db";
import { CASE_TEMPLATE_VERSION } from "./ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "./ortho-case-study-template";
import { STUDY_SOURCE_KINDS, type StudySourceKind, type StudyDraftContent } from "./ortho-case-study";
import { studyPgPositiveInteger } from "./ortho-case-study-pg-values";
import { journeyId } from "./ortho-case-journey-records";
import { authorizeJourney, assertJourneyCurrent, discoverJourneyOwner, lockJourneyOwner, journeyFail, journeyTransaction, type JourneyOwnerInput, type JourneyOwner } from "./ortho-case-journey-authority";
import { createStudyAssessmentAccess } from "./ortho-case-study-assessment-access";
import { prepareIncomingStudySourceUnion } from "./ortho-case-study-source-union";
import { lockStudyExternalSources, captureStudyInventorySources } from "./ortho-case-study-sources";
import { requireCurrentStudyRead } from "./ortho-case-study-access";
import type { StudySavedContent } from "./ortho-case-study-capture";
export const STUDY_SOURCE_PAGE_SIZE = 25;
type Candidate = { id: unknown; version: unknown };
async function candidates(client: DbClient, owner: JourneyOwner, kind: StudySourceKind, afterId: number): Promise<Candidate[]> {
  // Closed identifiers, never client-controlled SQL fragments.
  const versioned = { assessment: "ortho_assessment_revisions", diagnosis: "patient_diagnoses", strategy: "ortho_strategy_revisions",
    decision: "ortho_decision_revisions", retention_event: "ortho_retention_entries" } as const;
  if (Object.hasOwn(versioned, kind)) {
    const table = versioned[kind as keyof typeof versioned];
    return (await client.query<Candidate>(`SELECT id,version FROM ${table} WHERE ortho_case_id=$1 AND id>$2 ORDER BY id LIMIT 26`, [owner.orthoCaseId, afterId])).rows;
  }
  if (kind === "document") return (await client.query<Candidate>(`SELECT id,NULL::integer AS version FROM patient_documents
    WHERE patient_id=$1 AND ortho_case_id=$2 AND removed_at IS NULL AND id>$3 ORDER BY id LIMIT 26`, [owner.patientId, owner.orthoCaseId, afterId])).rows;
  if (kind === "ceph_study") return (await client.query<Candidate>(`SELECT id,NULL::integer AS version FROM ceph_analyses
    WHERE patient_id=$1 AND ortho_case_id=$2 AND id>$3 ORDER BY id LIMIT 26`, [owner.patientId, owner.orthoCaseId, afterId])).rows;
  if (kind === "adjustment") return (await client.query<Candidate>(`SELECT id,NULL::integer AS version FROM ortho_adjustments
    WHERE case_id=$1 AND id>$2 ORDER BY id LIMIT 26`, [owner.orthoCaseId, afterId])).rows;
  if (kind === "plan_consent" && owner.planId !== null) return (await client.query<Candidate>(`SELECT id,NULL::integer AS version FROM treatment_plans
    WHERE id=$1 AND patient_id=$2 AND id>$3 LIMIT 1`, [owner.planId, owner.patientId, afterId])).rows;
  return [];
}
export async function getOrthoStudySourceChoices(input: JourneyOwnerInput & { kind: StudySourceKind; afterId?: number }) {
  return journeyTransaction(false, async client => {
    if (typeof input.kind !== "string" || !STUDY_SOURCE_KINDS.includes(input.kind)
      || input.afterId !== undefined && !journeyId(input.afterId)) journeyFail(400, "invalid_study_inventory_query");
    const authority = await authorizeJourney(client, input, false), discovered = await discoverJourneyOwner(client, input);
    if ((input.kind === "document" || input.kind === "ceph_study") && !authority.canViewImages
      || input.kind === "plan_consent" && !authority.canViewPlans) {
      const owner = await lockJourneyOwner(client, input, false);
      if (owner.clinicalCaseId !== discovered.clinicalCaseId) journeyFail(409, "study_owner_changed");
      assertJourneyCurrent(authority);
      return { ok: true as const, patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId,
        kind: input.kind, state: "restricted" as const, choices: [], nextAfterId: null };
    }
    const rawRows = await candidates(client, discovered, input.kind, input.afterId ?? 0);
    if (rawRows.length > STUDY_SOURCE_PAGE_SIZE + 1) journeyFail(500, "invalid_study_inventory_rows");
    // In particular ceph_analyses.id is BIGSERIAL and pg returns int8 as text.
    // Normalize only canonical positive safe decimal values; never SQL-cast to int4.
    const rows = rawRows.map(row => ({ id: studyPgPositiveInteger(row.id),
      version: row.version === null ? null : studyPgPositiveInteger(row.version) }));
    const page = rows.slice(0, STUDY_SOURCE_PAGE_SIZE), more = rows.length > STUDY_SOURCE_PAGE_SIZE;
    const content: StudyDraftContent = { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH },
      identityDisclosure: "case_only", sources: page.map(row => ({ key: `${input.kind}_${row.id}`, kind: input.kind, id: row.id, version: row.version,
        contentHash: "0".repeat(64) })), panels: [], groups: [], mediaUses: [], comment: "" };
    const access = createStudyAssessmentAccess();
    await prepareIncomingStudySourceUnion(client, discovered, authority, content, access);
    const external = await lockStudyExternalSources(client, input, discovered, authority, content, access);
    const owner = await lockJourneyOwner(client, input, false);
    if (owner.clinicalCaseId !== discovered.clinicalCaseId || owner.planId !== discovered.planId) journeyFail(409, "study_owner_changed");
    const sources = await captureStudyInventorySources(client, owner, authority, content, external, access);
    const clock = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]?.now;
    if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) journeyFail(500, "invalid_capture_clock");
    const authored = { ...content, sources: sources.map(source => source.selection) };
    const capture: StudySavedContent = { schemaVersion: 1, capturedAt: clock.toISOString(), recordedPatientId: owner.patientId,
      orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId, caseStatusAtCapture: owner.status, authored, sources };
    // Includes current nested assessment, plan, retention-document and linked
    // visit membership. No historical access flag alone authorizes a choice.
    await requireCurrentStudyRead(client, owner, authority, capture, access);
    assertJourneyCurrent(authority);
    return { ok: true as const, patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId,
      kind: input.kind, state: "available" as const,
      choices: sources.map(source => ({ id: source.selection.id, version: source.selection.version, kind: source.selection.kind,
        state: source.state, unavailableReason: source.unavailableReason,
        // Missing/unsupported source hashes are never invented or offered as valid selections.
        selection: source.state === "available" ? source.selection : null })),
      nextAfterId: more ? page[page.length - 1].id : null };
  });
}
