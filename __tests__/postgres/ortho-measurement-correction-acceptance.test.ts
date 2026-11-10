import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import { syntheticStudyCommand } from "../fixtures/ortho-case-study";
import { saveConfirmedStudy } from "../helpers/ortho-study-submit";
import { openOrthoAssessment } from "../../lib/ortho-assessment-intake-store";
import { appendOrthoAssessment, getOrthoAssessment } from "../../lib/ortho-assessment-store";
import type { AssessmentRevisionV2 } from "../../lib/ortho-assessment-persisted-v2";
import { getOrthoProblemSources } from "../../lib/ortho-problem-source-store";
import { saveJournaledProblemSource, transitionProblemSubmission } from "../../lib/ortho-problem-submission-store";
import type { ProblemSourceCommand } from "../../lib/ortho-problem-sources";
import { appendOrthoTreatmentStrategy, getOrthoTreatmentStrategy } from "../../lib/ortho-treatment-strategy-store";
import type { StrategyCommand } from "../../lib/ortho-treatment-strategy";
import { getOrthoStudySourceChoices } from "../../lib/ortho-case-study-inventory";
import { getOrthoCaseStudy } from "../../lib/ortho-case-study-store";
import type { StudyRevisionRef, StudySourceKind } from "../../lib/ortho-case-study";
import { journeyContentHash } from "../../lib/ortho-case-journey-hash";
import type { ModelAnalysisEvidence } from "../../lib/ortho-study-model-analysis-evidence";
import { reserveStudyExport, readStudyExportArtifact } from "../../lib/ortho-study-export-archive-store";
import { runStudyExport } from "../../lib/ortho-study-export-runner";
import { readStudyExportArtifactBytes } from "../../lib/ortho-study-export-artifact-storage";

// Request transport only is mocked. All calculations, permissions, journals,
// source capture, PPTX rendering and immutable artifact storage are production code.
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }),
  headers: async () => new Headers(),
}));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let storageRoot = "";
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-correction-lineage-secret-at-least-32-characters");
  // A fresh private directory under the test checkout satisfies the real durable
  // storage policy; /tmp is deliberately not used or mocked as durable storage.
  storageRoot = await mkdtemp(join(process.cwd(), ".synthetic-correction-export-"));
  vi.stubEnv("DOCUMENTS_DIR", storageRoot);
  f = await openPeriodontalFixture(process.env, { pristine: true });
  await f.db.ensureSchema();
});
afterAll(async () => {
  try { await f?.close(); }
  finally { try { if (storageRoot) await rm(storageRoot, { recursive: true, force: true }); } finally { vi.unstubAllEnvs(); } }
});

function resultOf(revision: AssessmentRevisionV2, id: string) {
  const result = revision.content.results.find(row => row.analysisId === id);
  if (!result || result.result.state !== "ready" || result.result.witness.result.state !== "calculated") throw Error(`Missing calculated synthetic result: ${id}`);
  expect(result.result.witness.clinicalApproval).toBe("unapproved");
  return result;
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function pptxEvidence(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const slideNames = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const noteNames = Object.keys(zip.files).filter(name => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name));
  expect(slideNames.length).toBeGreaterThan(1);
  expect(noteNames).toHaveLength(slideNames.length);
  const slides = (await Promise.all(slideNames.map(name => zip.file(name)!.async("string")))).join("\n");
  const noteXml = await Promise.all(noteNames.map(name => zip.file(name)!.async("string")));
  const notes = noteXml.join("\n");
  const decode = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const modelAnalyses = noteXml.flatMap(xml => {
    const payload = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(match => decode(match[1])).find(text => text.startsWith("{"));
    expect(payload).toBeDefined();
    return (JSON.parse(payload!) as { modelAnalyses: ModelAnalysisEvidence[] }).modelAnalyses;
  });
  expect(slides.includes("<a:tbl>")).toBe(true); // Actual editable clinical tables, not synthetic placeholder bytes.
  // Native text wraps into multiple runs. Reconstruct text instead of requiring
  // a phrase to occupy one XML run (or dumping the entire package on failure).
  const slideText = [...slides.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(match => match[1])
    .join("").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&").replace(/[\s\u2066-\u2069]/g, "");
  return { slideText, notes, modelAnalyses, pageCount: slideNames.length };
}

// O40 documentary subset: saved analyses remain draft/unapproved. This does not
// invent an analysis-approval transition or automatic refresh of unsaved drafts.
it("recomputes shared measurements into an explicitly reviewed new study while prior revisions and the real archived PPTX remain unchanged", async () => {
  const username = `synthetic-correction-${randomUUID()}`, password = "Synthetic credential";
  const patientId: number = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic correction patient') RETURNING id", [randomUUID()])).rows[0].id;
  const actorId: number = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic reviewer',$2,'admin') RETURNING id", [username, password])).rows[0].id;
  const session: SessionPayload = { userId: actorId, username, role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3_600_000 };
  request.token = createSessionToken(session);
  const intake = await openOrthoAssessment({ patientId, session, command: { schemaVersion: 1, clientRequestId: randomUUID(), reason: "Synthetic diagnostic intake" } });
  if (!intake.ok) throw Error(JSON.stringify(intake));
  const owner = { patientId, orthoCaseId: intake.orthoCaseId, clinicalCaseId: intake.clinicalCaseId, session, actorId };
  const unrelatedState = async () => ({
    clinical: (await f.pool.query("SELECT * FROM clinical_cases WHERE id=$1", [owner.clinicalCaseId])).rows,
    ortho: (await f.pool.query("SELECT * FROM ortho_cases WHERE id=$1", [owner.orthoCaseId])).rows,
    counts: (await f.pool.query(`SELECT
      (SELECT count(*)::int FROM invoices) invoices, (SELECT count(*)::int FROM payments) payments,
      (SELECT count(*)::int FROM patient_opening_balances) opening_balances,
      (SELECT count(*)::int FROM treatment_plans) plans, (SELECT count(*)::int FROM plan_items) plan_items,
      (SELECT count(*)::int FROM appointments) appointments, (SELECT count(*)::int FROM visits) visits`)).rows,
  });
  const untouched = await unrelatedState();
  const initialCommand = { ...assessmentCommandV2(), commandId: randomUUID() };
  const initial = await appendOrthoAssessment({ ...owner, command: initialCommand });
  if (!initial.ok) throw Error(JSON.stringify(initial));
  const initialSources = await getOrthoProblemSources(owner);
  if (!initialSources.ok) throw Error(JSON.stringify(initialSources));
  expect(initialSources.problems).toEqual([]);
  const firstCandidate = initialSources.candidates.find(candidate => candidate.ref.kind === "assessment_analysis" && candidate.ref.member === "space_upper");
  if (!firstCandidate) throw Error("Initial saved upper-arch result was not offered for review");
  expect(firstCandidate.proposedLabel).toBeNull();
  expect(firstCandidate.ref).toMatchObject({ id: initial.revision.id, version: `sha256:${initial.revision.contentHash}` });
  const review = async (command: ProblemSourceCommand) => {
    const saved = await saveJournaledProblemSource({ ...owner, command });
    if (!saved.ok) throw Error(JSON.stringify(saved));
    expect(await transitionProblemSubmission({ ...owner, commandId: command.commandId,
      requestFingerprint: journeyContentHash(command), action: "acknowledge" })).toMatchObject({ ok: true });
    return saved;
  };
  const firstReview = await review({ schemaVersion: 1, commandId: randomUUID(), source: firstCandidate.ref,
    expectedReviewId: null, action: "create", problemId: null, label: "Synthetic clinician-reviewed concern",
    reason: "Explicit synthetic review of the saved calculation; not engine approval", clinicianReviewed: true });
  const strategyCommand: StrategyCommand = { schemaVersion: 1, commandId: randomUUID(), expectedRevisionId: null,
    reason: "Synthetic initial clinician-authored strategy", rows: [{ problemId: firstReview.problemId,
      objective: "Synthetic original objective", strategy: "Synthetic original approach", rationale: null, planItemIds: [] }] };
  const firstStrategy = await appendOrthoTreatmentStrategy({ ...owner, command: strategyCommand });
  if (!firstStrategy.ok) throw Error(JSON.stringify(firstStrategy));

  const documentStudy = async (ids: [StudySourceKind, number][], previous: StudyRevisionRef | null) => {
    const command = syntheticStudyCommand();
    const previousRef = previous ? { id: previous.id, contentHash: previous.contentHash } : null;
    command.expectedHead = previousRef; command.baseDocumentedRevision = previousRef;
    for (const [kind, id] of ids) {
      const offered = await getOrthoStudySourceChoices({ ...owner, kind });
      if (!offered.ok || offered.state !== "available") throw Error(JSON.stringify(offered));
      const selection = offered.choices.find(choice => choice.id === id)?.selection;
      if (!selection) throw Error(`Synthetic source missing: ${kind}/${id}`);
      command.content.sources.push(selection);
    }
    command.content.panels = [
      { instanceId: "measurements", layoutKey: "model-measurements", kinds: ["assessment"] },
      { instanceId: "reviewed-strategy", layoutKey: "problem-plan-strategy", kinds: ["problem_review", "strategy"] },
    ].map(({ instanceId, layoutKey, kinds }) => ({ instanceId, layoutKey, included: true, state: "available" as const,
      sourceKeys: command.content.sources.filter(source => kinds.includes(source.kind)).map(source => source.key), images: [], comment: "" }));
    const draft = await saveConfirmedStudy({ ...owner, command });
    if (!draft.ok) throw Error(JSON.stringify(draft));
    const draftRef = { id: draft.revision.id, contentHash: draft.revision.contentHash };
    const saved = await saveConfirmedStudy({ ...owner, command: { ...command, clientRequestId: randomUUID(), kind: "documented", expectedHead: draftRef, documentedFrom: draftRef } });
    if (!saved.ok) throw Error(JSON.stringify(saved));
    expect(saved.revision.content).toEqual(draft.revision.content);
    return saved.revision;
  };
  const archive = async (revision: StudyRevisionRef) => {
    const reserved = await reserveStudyExport({ ...owner, command: { schemaVersion: 1, clientRequestId: randomUUID(),
      revisionId: revision.id, revisionHash: revision.contentHash, format: "illustrated-pptx" } });
    if (!reserved.ok) throw Error(JSON.stringify(reserved));
    const run = await runStudyExport({ ...owner, jobId: reserved.job.id, expectedGeneration: 0 });
    if (!run.ok) throw Error(JSON.stringify(run));
    expect(run.job.state).toBe("ready");
    const stored = await readStudyExportArtifact({ ...owner, jobId: reserved.job.id });
    if (!stored.ok) throw Error(JSON.stringify(stored));
    const bytes = await readStudyExportArtifactBytes(stored.reference);
    expect(digest(bytes)).toBe(stored.reference.sha256);
    const evidence = await pptxEvidence(bytes);
    expect(stored.job.artifact?.pageCount).toBe(evidence.pageCount);
    expect(evidence.notes).toContain(revision.contentHash);
    return { ...stored, bytes, evidence };
  };
  const firstStudy = await documentStudy([["assessment", initial.revision.id], ["problem_review", firstReview.reviewId], ["strategy", firstStrategy.revision.revisionId]], null);
  const firstArchive = await archive(firstStudy);
  expect(firstArchive.evidence.slideText.includes("Syntheticoriginalapproach")).toBe(true);
  expect(firstArchive.evidence.slideText).toContain("المسافةالمطلوبة70mm");
  expect(firstArchive.evidence.slideText).not.toContain('"requiredMm"');
  const firstUpperEvidence = firstArchive.evidence.modelAnalyses.find(row => row.exactWitness.selection.id === "space_upper");
  expect(firstUpperEvidence?.exactWitness.stored).toEqual(resultOf(initial.revision, "space_upper"));
  expect(firstUpperEvidence?.source).toMatchObject({ id: initial.revision.id, contentHash: initial.revision.contentHash });
  expect(firstArchive.evidence.notes).toContain(initial.revision.contentHash);
  const oldArtifactRow = (await f.pool.query("SELECT * FROM ortho_study_export_artifacts WHERE job_id=$1", [firstArchive.job.id])).rows;
  const originalReview = (await getOrthoProblemSources(owner));
  if (!originalReview.ok) throw Error(JSON.stringify(originalReview));
  const oldReview = originalReview.reviews.find(row => row.id === firstReview.reviewId);
  expect(oldReview?.currentSourceState).toBe("current");

  const correctionCommand = structuredClone(initialCommand);
  correctionCommand.commandId = randomUUID(); correctionCommand.expectedRevisionId = initial.revision.id;
  correctionCommand.reason = "Synthetic direct correction of FDI 11 width from 7 mm to 8 mm";
  const correctedWidth = correctionCommand.content.observations.observations.find(row => row.id === "width_11");
  if (!correctedWidth || correctedWidth.value.state !== "measured") throw Error("Synthetic measured width missing");
  correctedWidth.value.value = 8;
  const corrected = await appendOrthoAssessment({ ...owner, command: correctionCommand });
  if (!corrected.ok) throw Error(JSON.stringify(corrected));
  expect(corrected.revision).toMatchObject({ version: 2, supersedesRevisionId: initial.revision.id });
  expect(corrected.revision.contentHash).not.toBe(initial.revision.contentHash);
  expect(corrected.revision.content.draft.analyses.every(row => row.state === "draft")).toBe(true);
  expect(resultOf(initial.revision, "space_upper").result).toMatchObject({ witness: { result: { requiredMm: 70, availableMm: 70, availableMinusRequiredMm: 0 } } });
  expect(resultOf(corrected.revision, "space_upper").result).toMatchObject({ witness: { result: { requiredMm: 71, availableMm: 70, availableMinusRequiredMm: -1 } } });
  expect(resultOf(corrected.revision, "bolton_anterior").result).toMatchObject({ witness: { result: { upperMm: 43, lowerMm: 42, ratioPercent: expect.closeTo(42 / 43 * 100, 12) } } });
  expect(resultOf(corrected.revision, "bolton_overall").result).toMatchObject({ witness: { result: { upperMm: 85, lowerMm: 84, ratioPercent: expect.closeTo(84 / 85 * 100, 12) } } });
  for (const id of ["space_upper", "bolton_anterior", "bolton_overall"]) {
    expect(resultOf(corrected.revision, id).resultHash).not.toBe(resultOf(initial.revision, id).resultHash);
    expect(resultOf(corrected.revision, id).result.dependencyObservationIds).toContain("width_11");
  }
  expect(resultOf(corrected.revision, "space_lower")).toEqual(resultOf(initial.revision, "space_lower"));
  expect(resultOf(corrected.revision, "space_lower").result.dependencyObservationIds).not.toContain("width_11");

  const changedSources = await getOrthoProblemSources(owner);
  if (!changedSources.ok) throw Error(JSON.stringify(changedSources));
  expect(changedSources.problems).toEqual(originalReview.problems);
  expect(changedSources.reviews).toHaveLength(1); // No automatic diagnosis/review or strategy revision.
  expect(changedSources.reviews[0]).toEqual({ ...oldReview, currentSourceState: "newer_version" });
  expect(await getOrthoTreatmentStrategy(owner)).toMatchObject({ ok: true, revision: firstStrategy.revision, history: [{ revisionId: firstStrategy.revision.revisionId }] });
  const newCandidate = changedSources.candidates.find(candidate => candidate.ref.kind === "assessment_analysis" && candidate.ref.member === "space_upper");
  if (!newCandidate) throw Error("Corrected result was not offered for explicit review");
  expect(newCandidate.identity).toBe(firstCandidate.identity);
  expect(newCandidate.ref).toMatchObject({ id: corrected.revision.id, version: `sha256:${corrected.revision.contentHash}` });
  expect(newCandidate.snapshot).not.toEqual(firstCandidate.snapshot);
  expect(newCandidate.proposedLabel).toBeNull();
  const secondReview = await review({ schemaVersion: 1, commandId: randomUUID(), source: newCandidate.ref,
    expectedReviewId: firstReview.reviewId, action: "link", problemId: firstReview.problemId, label: null,
    reason: "Synthetic explicit review of corrected result", clinicianReviewed: true });
  expect(secondReview.problemId).toBe(firstReview.problemId);
  const secondStrategy = await appendOrthoTreatmentStrategy({ ...owner, command: { ...strategyCommand,
    commandId: randomUUID(), expectedRevisionId: firstStrategy.revision.revisionId,
    reason: "Synthetic explicit strategy revision after corrected source review",
    rows: [{ ...strategyCommand.rows[0], strategy: "Synthetic revised approach" }] } });
  if (!secondStrategy.ok) throw Error(JSON.stringify(secondStrategy));
  expect(secondStrategy.revision).toMatchObject({ version: 2, supersedesRevisionId: firstStrategy.revision.revisionId });
  // Strategy has a problem snapshot, not a reviewId contract. The study captures
  // the exact review and strategy independently rather than fabricating that link.
  const secondStudy = await documentStudy([["assessment", corrected.revision.id], ["problem_review", secondReview.reviewId], ["strategy", secondStrategy.revision.revisionId]], firstStudy);
  expect(secondStudy.contentHash).not.toBe(firstStudy.contentHash);
  expect(secondStudy.content.sources.map(source => [source.selection.kind, source.selection.id])).toEqual([
    ["assessment", corrected.revision.id], ["problem_review", secondReview.reviewId], ["strategy", secondStrategy.revision.revisionId],
  ]);
  const secondArchive = await archive(secondStudy);
  expect(secondArchive.evidence.slideText.includes("Syntheticrevisedapproach")).toBe(true);
  expect(secondArchive.evidence.slideText.includes("Syntheticoriginalapproach")).toBe(false);
  expect(secondArchive.evidence.slideText).toContain("المسافةالمطلوبة71mm");
  expect(secondArchive.evidence.slideText).not.toContain('"requiredMm"');
  const correctedUpperEvidence = secondArchive.evidence.modelAnalyses.find(row => row.exactWitness.selection.id === "space_upper");
  expect(correctedUpperEvidence?.exactWitness.stored).toEqual(resultOf(corrected.revision, "space_upper"));
  expect(correctedUpperEvidence?.source).toMatchObject({ id: corrected.revision.id, contentHash: corrected.revision.contentHash });
  expect(secondArchive.evidence.notes).toContain(corrected.revision.contentHash);
  expect(secondArchive.reference.sha256).not.toBe(firstArchive.reference.sha256);

  expect(await getOrthoAssessment({ ...owner, revisionId: initial.revision.id, acceptedSchemas: [2] })).toMatchObject({ ok: true, revision: initial.revision });
  expect(await getOrthoTreatmentStrategy({ ...owner, revisionId: firstStrategy.revision.revisionId })).toMatchObject({ ok: true, revision: firstStrategy.revision });
  const finalReviews = await getOrthoProblemSources(owner);
  if (!finalReviews.ok) throw Error(JSON.stringify(finalReviews));
  expect(finalReviews.reviews).toHaveLength(2);
  expect(finalReviews.reviews.find(row => row.id === firstReview.reviewId)).toEqual({ ...oldReview, currentSourceState: "newer_version" });
  expect(finalReviews.reviews.find(row => row.id === secondReview.reviewId)).toMatchObject({ supersedesReviewId: firstReview.reviewId, source: newCandidate, currentSourceState: "current" });
  const priorStudy = await getOrthoCaseStudy({ ...owner, revisionId: firstStudy.id, exportAccess: true });
  if (!priorStudy.ok) throw Error(JSON.stringify(priorStudy));
  expect(priorStudy.revision).toEqual(firstStudy);
  const rereadArchive = await readStudyExportArtifact({ ...owner, jobId: firstArchive.job.id });
  if (!rereadArchive.ok) throw Error(JSON.stringify(rereadArchive));
  expect(rereadArchive).toEqual({ ok: true, job: firstArchive.job, reference: firstArchive.reference });
  expect(await readStudyExportArtifactBytes(rereadArchive.reference)).toEqual(firstArchive.bytes);
  expect((await f.pool.query("SELECT * FROM ortho_study_export_artifacts WHERE job_id=$1", [firstArchive.job.id])).rows).toEqual(oldArtifactRow);
  const secondManifest = (await f.pool.query("SELECT manifest FROM ortho_study_export_artifacts WHERE job_id=$1", [secondArchive.job.id])).rows[0].manifest;
  expect(secondManifest).toMatchObject({ revisionId: secondStudy.id, revisionHash: secondStudy.contentHash,
    sourceSelections: secondStudy.content.sources.map(source => source.selection) });
  expect(await unrelatedState()).toEqual(untouched);
});
