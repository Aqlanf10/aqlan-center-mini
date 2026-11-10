import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { clinicDateString } from "../../lib/schedule";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import { syntheticStudyCommand } from "../fixtures/ortho-case-study";
import { saveConfirmedStudy } from "../helpers/ortho-study-submit";
import { openOrthoAssessment, startOrthoTreatment } from "../../lib/ortho-assessment-intake-store";
import { appendOrthoAssessment } from "../../lib/ortho-assessment-store";
import { getOrthoProblemSources } from "../../lib/ortho-problem-source-store";
import { saveJournaledProblemSource, transitionProblemSubmission } from "../../lib/ortho-problem-submission-store";
import type { ProblemSourceCommand } from "../../lib/ortho-problem-sources";
import { appendOrthoTreatmentStrategy, getOrthoTreatmentStrategy } from "../../lib/ortho-treatment-strategy-store";
import type { StrategyCommand } from "../../lib/ortho-treatment-strategy";
import { saveJournaledRetention, transitionRetentionSubmission } from "../../lib/ortho-retention-submission-store";
import { getOrthoRetentionEvents } from "../../lib/ortho-retention-event-store";
import type { RetentionPersistenceCommand } from "../../lib/ortho-retention-command";
import { getOrthoStudySourceChoices } from "../../lib/ortho-case-study-inventory";
import { getOrthoCaseStudy } from "../../lib/ortho-case-study-store";
import { studyTextPresentation } from "../../lib/ortho-study-text-export";
import { journeyContentHash } from "../../lib/ortho-case-journey-hash";
import type { StudySourceKind } from "../../lib/ortho-case-study";

// Only the Next request transport is supplied. Clinical writes, authorization,
// source capture and replay all use the production services against PostgreSQL.
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }),
  headers: async () => new Headers(),
}));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-integrated-journey-secret-at-least-32-characters");
  f = await openPeriodontalFixture(process.env, { pristine: true });
  await f.db.ensureSchema();
});
afterAll(async () => { try { await f?.close(); } finally { vi.unstubAllEnvs(); } });

const financialAndSchedule = async () => (await f.pool.query(`SELECT
  (SELECT count(*)::int FROM invoices) invoices,
  (SELECT count(*)::int FROM payments) payments,
  (SELECT count(*)::int FROM patient_opening_balances) opening_balances,
  (SELECT count(*)::int FROM treatment_plans) plans,
  (SELECT count(*)::int FROM plan_items) plan_items,
  (SELECT count(*)::int FROM appointments) appointments`)).rows;

it("carries one intake identity through reviewed assessment, strategy, a real session and retention into immutable study sources", async () => {
  const username = `synthetic-journey-${randomUUID()}`, password = "Synthetic credential";
  const patientId: number = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic integrated journey') RETURNING id", [randomUUID()])).rows[0].id;
  const actorId: number = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic clinician',$2,'admin') RETURNING id", [username, password])).rows[0].id;
  const session: SessionPayload = { userId: actorId, username, role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3_600_000 };
  request.token = createSessionToken(session);
  const before = await financialAndSchedule();
  const intakeCommand = { schemaVersion: 1 as const, clientRequestId: randomUUID(), reason: "Synthetic diagnostic intake" };
  const intake = await openOrthoAssessment({ patientId, session, command: intakeCommand });
  if (!intake.ok) throw Error(JSON.stringify(intake));
  const owner = { patientId, orthoCaseId: intake.orthoCaseId, clinicalCaseId: intake.clinicalCaseId, session, actorId };
  expect(await openOrthoAssessment({ patientId, session, command: intakeCommand })).toMatchObject({ ...intake, mode: "replayed" });
  expect((await f.pool.query("SELECT status,phase,appliance,start_date,plan_id FROM ortho_cases WHERE id=$1", [owner.orthoCaseId])).rows)
    .toEqual([{ status: "assessment", phase: "assessment", appliance: null, start_date: null, plan_id: null }]);

  // An independent negative-case fixture belongs to the SAME patient: patient
  // equality alone must never authorize borrowing its neighboring episode.
  const neighborOrtho: number = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'completed','synthetic negative fixture') RETURNING id", [patientId])).rows[0].id;
  const neighborClinical: number = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic negative fixture',$2,'synthetic') RETURNING id", [patientId, neighborOrtho])).rows[0].id;
  const neighbor = { ...owner, orthoCaseId: neighborOrtho, clinicalCaseId: neighborClinical };

  const assessmentCommand = { ...assessmentCommandV2(), commandId: randomUUID() };
  const assessment = await appendOrthoAssessment({ ...owner, command: assessmentCommand });
  if (!assessment.ok) throw Error(JSON.stringify(assessment));
  expect(await appendOrthoAssessment({ ...owner, command: assessmentCommand })).toMatchObject({ ok: true, replayed: true, revision: { id: assessment.revision.id } });
  const sources = await getOrthoProblemSources(owner);
  if (!sources.ok) throw Error(JSON.stringify(sources));
  expect(sources.problems).toEqual([]); // Measurements do not create diagnoses.
  const observation = sources.candidates.find(candidate => candidate.ref.kind === "assessment_observation" && candidate.ref.id === assessment.revision.id && candidate.ref.member === "width_11");
  expect(observation).toBeDefined();
  if (!observation) throw Error("Saved assessment observation was not offered for explicit review");
  const problemCommand: ProblemSourceCommand = { schemaVersion: 1, commandId: randomUUID(), source: observation.ref,
    expectedReviewId: null, action: "create", problemId: null, label: "Synthetic clinician-reviewed concern",
    reason: "Synthetic explicit clinical review; measurement is not an automatic diagnosis", clinicianReviewed: true };
  const problem = await saveJournaledProblemSource({ ...owner, command: problemCommand });
  if (!problem.ok) throw Error(JSON.stringify(problem));
  expect(await saveJournaledProblemSource({ ...owner, command: problemCommand })).toMatchObject({ ok: true, replayed: true, reviewId: problem.reviewId, problemId: problem.problemId });
  expect(await transitionProblemSubmission({ ...owner, commandId: problemCommand.commandId, requestFingerprint: journeyContentHash(problemCommand), action: "acknowledge" })).toMatchObject({ ok: true });

  const strategyCommand: StrategyCommand = { schemaVersion: 1, commandId: randomUUID(), expectedRevisionId: null,
    reason: "Synthetic clinician-authored plan", rows: [{ problemId: problem.problemId,
      objective: "Synthetic objective linked to the reviewed concern", strategy: "Synthetic clinician-authored approach",
      rationale: null, planItemIds: [] }] };
  const strategy = await appendOrthoTreatmentStrategy({ ...owner, command: strategyCommand });
  if (!strategy.ok) throw Error(JSON.stringify(strategy));
  expect(strategy.revision.rows[0]).toMatchObject({ problem: { id: problem.problemId, label: problemCommand.label }, objective: strategyCommand.rows[0].objective });
  expect(await appendOrthoTreatmentStrategy({ ...owner, command: strategyCommand })).toMatchObject({ ok: true, replayed: true, revision: { revisionId: strategy.revision.revisionId } });
  expect(await appendOrthoTreatmentStrategy({ ...neighbor, command: { ...strategyCommand, commandId: randomUUID() } })).toMatchObject({ ok: false });
  expect(await getOrthoTreatmentStrategy(neighbor)).toMatchObject({ ok: true, revision: null, history: [] });

  const today = clinicDateString(new Date(), f.db.CLINIC_TIME_ZONE);
  const startCommand = { schemaVersion: 1 as const, clientRequestId: randomUUID(), reason: "Synthetic explicit treatment start",
    confirmed: true as const, appliance: "aligners" as const, arches: "upper" as const, slot: null,
    startDate: today, plannedMonths: 12, bracketSystem: "" };
  expect(await startOrthoTreatment({ ...owner, command: startCommand })).toMatchObject({ ok: true, mode: "started", orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId });
  expect(await startOrthoTreatment({ ...owner, command: startCommand })).toMatchObject({ ok: true, mode: "replayed" });
  const visit = await f.db.addVisit({ patientName: "Synthetic integrated journey", patientPhone: null, note: null, patientId });
  const sessionCommand = { caseId: owner.orthoCaseId, visitId: visit.id, doneOn: today, phase: null, upperWire: null, lowerWire: null,
    elastics: "none" as const, elasticNote: null, done: "Synthetic actual session documentation", nextWeeks: 4,
    note: "Synthetic session note", recordedBy: username, actorRole: session.role, request: { key: randomUUID(), patientId, session } };
  const adjustment = await f.db.recordAdjustment(sessionCommand);
  if (!adjustment.ok) throw Error(JSON.stringify(adjustment));
  expect(adjustment).toMatchObject({ created: true, visitId: visit.id });
  expect(await f.db.recordAdjustment(sessionCommand)).toMatchObject({ ok: true, created: false, replayed: true, id: adjustment.id, visitId: visit.id });
  expect((await f.db.getClinicalVisit(visit.id))?.ortho?.visitAdjustmentId).toBe(adjustment.id);
  expect(await f.db.signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: username, signerRole: session.role }))
    .toMatchObject({ reason: null, invoiceId: null, duesMinor: 0 });
  expect((await f.pool.query("SELECT status,signed_by FROM visits WHERE id=$1", [visit.id])).rows).toEqual([{ status: "done", signed_by: username }]);

  const retentionDescription = "Synthetic documented retention device";
  const retentionCommand: RetentionPersistenceCommand = { schemaVersion: 2, clientRequestId: randomUUID(), expectedHeadId: null,
    reason: "Synthetic recorded device delivery", arch: "upper", supersedesEntryId: null, archCorrectionReason: null, expectedDocuments: [],
    content: { kind: "device_delivery", occurrence: { occurredOn: null, dateProvenance: "unknown", sourceNote: "" },
      note: "Synthetic documentary retention event", documentIds: [], deviceType: "removable",
      description: retentionDescription, extent: "Synthetic upper", labOrderId: null } };
  const retention = await saveJournaledRetention({ ...owner, command: retentionCommand });
  if (!retention.ok) throw Error(JSON.stringify(retention));
  expect(await saveJournaledRetention({ ...owner, command: retentionCommand })).toMatchObject({ ok: true, replayed: true, entryId: retention.entryId });
  expect(await transitionRetentionSubmission({ ...owner, commandId: retentionCommand.clientRequestId, requestFingerprint: journeyContentHash(retentionCommand), action: "acknowledge" })).toMatchObject({ ok: true });
  expect(await getOrthoRetentionEvents(owner)).toMatchObject({ ok: true, history: [{ id: retention.entryId }] });
  expect(retention.revision.content.payload.occurrence).toEqual(retentionCommand.content.occurrence);
  // Recording retention is documentary; this scenario does not assert a
  // completion/reopening workflow or infer a clinical date from recording time.
  expect((await f.pool.query("SELECT status,retainer,retainer_on FROM ortho_cases WHERE id=$1", [owner.orthoCaseId])).rows)
    .toEqual([{ status: "active", retainer: null, retainer_on: null }]);

  const milestones: [StudySourceKind, number][] = [["assessment", assessment.revision.id], ["problem_review", problem.reviewId],
    ["strategy", strategy.revision.revisionId], ["adjustment", adjustment.id], ["retention_event", retention.entryId]];
  const studyCommand = syntheticStudyCommand();
  for (const [kind, id] of milestones) {
    const offered = await getOrthoStudySourceChoices({ ...owner, kind });
    if (!offered.ok || offered.state !== "available") throw Error(JSON.stringify(offered));
    const selection = offered.choices.find(choice => choice.id === id)?.selection;
    if (!selection) throw Error(`Journey milestone ${kind}/${id} was not offered for its own case`);
    studyCommand.content.sources.push(selection);
    const other = await getOrthoStudySourceChoices({ ...neighbor, kind });
    expect(other).toMatchObject({ ok: true, choices: [] });
  }
  studyCommand.content.panels = [
    { instanceId: "assessment", layoutKey: "interview", kinds: ["assessment"] },
    { instanceId: "reviewed-plan", layoutKey: "problem-plan-strategy", kinds: ["problem_review", "strategy"] },
    { instanceId: "session", layoutKey: "visit", kinds: ["adjustment"] },
    { instanceId: "retention", layoutKey: "retention", kinds: ["retention_event"] },
  ].map(({ instanceId, layoutKey, kinds }) => ({ instanceId, layoutKey, included: true, state: "available" as const,
    sourceKeys: studyCommand.content.sources.filter(source => kinds.includes(source.kind)).map(source => source.key), images: [], comment: "" }));
  const draft = await saveConfirmedStudy({ ...owner, command: studyCommand });
  if (!draft.ok) throw Error(JSON.stringify(draft));
  expect(await saveConfirmedStudy({ ...owner, command: studyCommand })).toMatchObject({ ok: true, replayed: true, revision: { id: draft.revision.id } });
  const draftRef = { id: draft.revision.id, contentHash: draft.revision.contentHash };
  const documentedCommand = { ...studyCommand, clientRequestId: randomUUID(), kind: "documented" as const, expectedHead: draftRef, documentedFrom: draftRef };
  const documented = await saveConfirmedStudy({ ...owner, command: documentedCommand });
  if (!documented.ok) throw Error(JSON.stringify(documented));
  expect(documented.revision.content).toEqual(draft.revision.content);
  expect(documented.revision.content.sources.map(source => [source.selection.kind, source.selection.id])).toEqual(milestones);
  const text = JSON.stringify(studyTextPresentation(documented.revision, owner));
  for (const fact of [problemCommand.label, strategyCommand.rows[0].objective, strategyCommand.rows[0].strategy,
    sessionCommand.done, retentionDescription]) expect(text).toContain(fact);

  const laterStrategy = await appendOrthoTreatmentStrategy({ ...owner, command: { ...strategyCommand, commandId: randomUUID(),
    expectedRevisionId: strategy.revision.revisionId, rows: [{ ...strategyCommand.rows[0], objective: "Later objective outside the saved presentation" }] } });
  if (!laterStrategy.ok) throw Error(JSON.stringify(laterStrategy));
  const historical = await getOrthoCaseStudy({ ...owner, revisionId: documented.revision.id });
  if (!historical.ok || !historical.revision) throw Error(JSON.stringify(historical));
  expect(historical.revision.contentHash).toBe(documented.revision.contentHash);
  expect(historical.revision.content).toEqual(documented.revision.content);
  expect(JSON.stringify(studyTextPresentation(historical.revision, owner))).toBe(text);
  expect(text).not.toContain("Later objective outside the saved presentation");
  expect(await saveConfirmedStudy({ ...owner, command: documentedCommand })).toMatchObject({ ok: true, replayed: true, revision: { id: documented.revision.id } });

  // Read-only relational witnesses prove this was one composition, not several
  // unrelated fixtures whose individual writers happened to succeed.
  expect((await f.pool.query(`SELECT c.patient_id,c.ortho_case_id,p.case_id AS problem_case,a.visit_id,v.patient_id AS visit_patient
    FROM clinical_cases c JOIN patient_problems p ON p.case_id=c.id
    JOIN ortho_adjustments a ON a.case_id=c.ortho_case_id JOIN visits v ON v.id=a.visit_id
    WHERE c.id=$1 AND p.id=$2 AND a.id=$3`, [owner.clinicalCaseId, problem.problemId, adjustment.id])).rows)
    .toEqual([{ patient_id: patientId, ortho_case_id: owner.orthoCaseId, problem_case: owner.clinicalCaseId, visit_id: visit.id, visit_patient: patientId }]);
  for (const [table, column, expected] of [
    ["clinical_cases", "ortho_case_id", 1], ["ortho_case_intake_events", "ortho_case_id", 2],
    ["ortho_assessment_revisions", "ortho_case_id", 1], ["ortho_problem_source_reviews", "ortho_case_id", 1],
    ["ortho_strategy_revisions", "ortho_case_id", 2], ["ortho_adjustments", "case_id", 1],
    ["ortho_retention_entries", "ortho_case_id", 1], ["ortho_case_study_revisions", "ortho_case_id", 2],
  ] as const) {
    expect((await f.pool.query(`SELECT count(*)::int n FROM ${table} WHERE ${column}=$1`, [owner.orthoCaseId])).rows[0].n, table).toBe(expected);
  }
  expect((await f.pool.query("SELECT count(*)::int n FROM patient_problems WHERE case_id=$1", [owner.clinicalCaseId])).rows[0].n).toBe(1);
  expect((await f.pool.query("SELECT count(*)::int n FROM visits WHERE patient_id=$1", [patientId])).rows[0].n).toBe(1);
  expect(await getOrthoProblemSources(neighbor)).toMatchObject({ ok: true, problems: [], reviews: [] });
  expect(await financialAndSchedule()).toEqual(before);
});
