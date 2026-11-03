import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import { appendOrthoAssessment } from "../../lib/ortho-assessment-store";
import { getOrthoProblemSources, appendOrthoProblemSource } from "../../lib/ortho-problem-source-store";
import { appendOrthoTreatmentStrategy } from "../../lib/ortho-treatment-strategy-store";
import { startOrthoRetention } from "../../lib/ortho-retention-transition-store";
import { appendOrthoRetentionEvent } from "../../lib/ortho-retention-event-store";
import { getOrthoStudySourceChoices } from "../../lib/ortho-case-study-inventory";
import { saveOrthoCaseStudy, getOrthoCaseStudy } from "../../lib/ortho-case-study-store";
import { CASE_TEMPLATE_VERSION } from "../../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../../lib/ortho-case-study-template";
import type { StudySaveCommand, StudySourceSelection } from "../../lib/ortho-case-study";
import type { ProblemSourceCandidate, ProblemSourceCommand } from "../../lib/ortho-problem-sources";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, n = 0;
beforeAll(async () => { vi.stubEnv("SESSION_SECRET", "synthetic-problem-source-secret-at-least-32-characters"); f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema(); });
afterAll(async () => { try { await f?.close(); } finally { vi.unstubAllEnvs(); } });
async function setup() {
  const seq = ++n, password = "Synthetic source review credential";
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic linked problem patient') RETURNING id", [`SYN-PROBLEM-${seq}`])).rows[0].id;
  const userId = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic specialist',$2,'admin') RETURNING id", [`synthetic-problem-${seq}`, password])).rows[0].id;
  const session: SessionPayload = { userId, username: `synthetic-problem-${seq}`, role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 600000 }; request.token = createSessionToken(session);
  const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'active','synthetic') RETURNING id", [patientId])).rows[0].id;
  const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic source bridge',$2,'synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id;
  const scope = { patientId, orthoCaseId, clinicalCaseId, session };
  const documentId = (await f.pool.query(`INSERT INTO patient_documents(patient_id,ortho_case_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,photo_view)
    VALUES($1,$2,'imaging','Synthetic source image','image/png',1,$3,'synthetic/problem-source.png','synthetic','panoramic') RETURNING id`, [patientId, orthoCaseId, "a".repeat(64)])).rows[0].id;
  const command = assessmentCommandV2(); command.commandId = randomUUID();
  command.content.observations.observations.push({ id: `panoramic_v1_${documentId}_tooth_13`, definition: "clinical_finding", definitionVersion: 1, unit: "qualitative", label: "Synthetic tooth finding", target: { kind: "tooth", tooth: 13 },
    value: { state: "recorded", text: "Synthetic clinician observation" }, occurredOn: { state: "known", date: "2026-01-01" }, provenance: { performer: { state: "documented", attribution: "Synthetic reader" }, method: { kind: "direct_examination", version: 1, description: "Synthetic source reading" }, sources: [{ kind: "document", id: documentId, version: `sha256:${"a".repeat(64)}` }], copiedFrom: null } });
  const saved = await appendOrthoAssessment({ ...scope, command }); if (!saved.ok) throw Error(saved.code);
  await f.pool.query("INSERT INTO patient_diagnoses(patient_id,ortho_case_id,version,content,created_by) VALUES($1,$2,1,$3::jsonb,'Synthetic specialist')", [patientId, orthoCaseId, JSON.stringify({ skeletal: "Synthetic clinical diagnosis", dental: null, crowding: null, overjet: null, bite: null, note: null })]);
  const studyId = (await f.pool.query("INSERT INTO ceph_analyses(patient_id,document_id,ortho_case_id,created_by) VALUES($1,$2,$3,'synthetic') RETURNING id", [patientId, documentId, orthoCaseId])).rows[0].id;
  await f.pool.query("INSERT INTO ceph_diagnoses(analysis_id,final_dx,created_by) VALUES($1,'Synthetic saved ceph interpretation','synthetic')", [studyId]);
  return { scope, command, revision: saved.revision, documentId, studyId, userId };
}
const review = (candidate: ProblemSourceCandidate, overrides: Partial<ProblemSourceCommand> = {}): ProblemSourceCommand => ({ schemaVersion: 1, commandId: randomUUID(), source: candidate.ref, expectedReviewId: null,
  action: "create", problemId: null, label: "Synthetic reviewed problem", reason: "Explicit synthetic clinician review", clinicianReviewed: true, ...overrides });
const counts = async (patientId: number) => (await f.pool.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT count(*)::int FROM visits WHERE patient_id=$1) visits", [patientId])).rows;
describe("source -> clinician review -> shared problem -> existing treatment strategy", () => {
  it("reuses one problem for independently reviewed panoramic, measurement, clinical and ceph sources and a plan goal", async () => {
    const x = await setup(), before = await counts(x.scope.patientId), read = await getOrthoProblemSources(x.scope); if (!read.ok) throw Error(read.code);
    expect(new Set(read.candidates.map(c => c.ref.kind))).toEqual(new Set(["assessment_observation", "assessment_analysis", "clinical_diagnosis", "ceph_diagnosis"]));
    expect(read.candidates.find(c => c.ref.kind === "assessment_analysis")!.proposedLabel).toBeNull();
    expect((await f.pool.query("SELECT id FROM patient_problems WHERE patient_id=$1", [x.scope.patientId])).rows).toEqual([]);
    const pano = read.candidates.find(c => c.category === "قراءة بانوراما")!, command = review(pano), saved = await appendOrthoProblemSource({ ...x.scope, command }); if (!saved.ok) throw Error(saved.code);
    expect(saved.replayed).toBe(false);
    expect(await appendOrthoProblemSource({ ...x.scope, command })).toEqual({ ...saved, replayed: true });
    for (const kind of ["assessment_analysis", "clinical_diagnosis", "ceph_diagnosis"]) {
      const source = read.candidates.find(c => c.ref.kind === kind)!;
      const linked = await appendOrthoProblemSource({ ...x.scope, command: review(source, { action: "link", problemId: saved.problemId, label: null }) });
      expect(linked).toMatchObject({ ok: true, problemId: saved.problemId });
    }
    const strategy = await appendOrthoTreatmentStrategy({ ...x.scope, command: { schemaVersion: 1, commandId: randomUUID(), expectedRevisionId: null, reason: "Synthetic source-derived plan review",
      rows: [{ problemId: saved.problemId, objective: "Synthetic reviewed objective", strategy: "Clinician authored strategy without automatic treatment", planItemIds: [], rationale: "Source reviewed" }] } });
    expect(strategy).toMatchObject({ ok: true, revision: { rows: [{ problem: { id: saved.problemId } }] } });
    const reopened = await getOrthoProblemSources(x.scope); if (!reopened.ok) throw Error(reopened.code);
    expect(reopened.problems).toHaveLength(1); expect(reopened.reviews).toHaveLength(4);
    expect(reopened.reviews.every(r => r.currentSourceState === "current")).toBe(true);
    expect(reopened.reviews.find(r => r.source.category === "قراءة بانوراما")?.source.target).toEqual({ kind: "tooth", tooth: 13 });
    expect(await counts(x.scope.patientId)).toEqual(before);
    // Continue the same case through an actual clinical session, retention and
    // a saved study. This proves service integration, not a full browser journey.
    const visitId = (await f.pool.query("INSERT INTO visits(patient_id,case_id,patient_name,status) VALUES($1,$2,'Synthetic linked visit','waiting') RETURNING id", [x.scope.patientId, x.scope.clinicalCaseId])).rows[0].id;
    const adjustment = await f.db.recordAdjustment({ caseId: x.scope.orthoCaseId, visitId, doneOn: "2026-10-01", phase: "finishing", upperWire: null, lowerWire: null, elastics: "none", elasticNote: null, done: "Synthetic clinician documented session", nextWeeks: 4, note: null, recordedBy: "Synthetic specialist", actorRole: "admin" });
    expect(adjustment).toMatchObject({ ok: true, visitId, created: true });
    expect(await startOrthoRetention({ ...x.scope, command: { schemaVersion: 1, clientRequestId: randomUUID(), expectedPhase: "finishing", confirmed: true, reason: "Synthetic explicit retention decision", retentionPlan: "Synthetic reviewed retention plan", occurrence: { occurredOn: "2026-10-02", dateProvenance: "historical_source", sourceNote: "Synthetic fixture" } } })).toMatchObject({ ok: true });
    const retention = await appendOrthoRetentionEvent({ ...x.scope, command: { schemaVersion: 1, clientRequestId: randomUUID(), expectedHeadId: null, reason: "Synthetic device delivery", arch: "upper", supersedesEntryId: null, archCorrectionReason: null, content: { kind: "device_delivery", occurrence: { occurredOn: null, dateProvenance: "unknown", sourceNote: "Original delivery date unknown" }, note: "", documentIds: [], deviceType: "fixed", description: "Synthetic device", extent: "Upper arch", labOrderId: null } } });
    expect(retention.ok).toBe(true);
    const sources: StudySourceSelection[] = [];
    for (const kind of ["assessment", "strategy", "adjustment", "retention_event"] as const) {
      const inventory = await getOrthoStudySourceChoices({ ...x.scope, kind }); if (!inventory.ok) throw Error(inventory.code);
      expect(inventory.choices).toHaveLength(1); expect(inventory.choices[0].state).toBe("available"); sources.push(inventory.choices[0].selection!);
    }
    const studyCommand: StudySaveCommand = { schemaVersion: 1, clientRequestId: randomUUID(), expectedHead: null, baseDocumentedRevision: null, kind: "draft", documentedFrom: null, reason: "Synthetic connected study capture", content: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH }, identityDisclosure: "case_only", sources, groups: [], mediaUses: [], comment: "Synthetic case sources remain selected explicitly", panels: [{ instanceId: "review1", layoutKey: "interview", included: true, state: "available", sourceKeys: sources.map(s => s.key), images: [], comment: "Integration capture only, no clinical conclusion inferred" }] } };
    const study = await saveOrthoCaseStudy({ ...x.scope, command: studyCommand }); if (!study.ok) throw Error(study.code);
    const ref = { id: study.revision.id, contentHash: study.revision.contentHash };
    const documented = await saveOrthoCaseStudy({ ...x.scope, command: { ...studyCommand, clientRequestId: randomUUID(), kind: "documented", expectedHead: ref, documentedFrom: ref } }); if (!documented.ok) throw Error(documented.code);
    const restored = await getOrthoCaseStudy({ ...x.scope, revisionId: documented.revision.id }); if (!restored.ok) throw Error(restored.code);
    expect(restored.revision!.content.authored.sources).toEqual(sources);
    expect(JSON.stringify(restored.revision!.content.sources.find(s => s.selection.kind === "strategy"))).toContain(command.label!);
    expect((await counts(x.scope.patientId))[0]).toEqual({ invoices: 0, payments: 0, visits: 1 });
    expect((await getOrthoProblemSources(x.scope))).toMatchObject({ ok: true, problems: [{ id: saved.problemId }] });
  });
  it("preserves approved problem text when a source changes and requires a new explicit linked review", async () => {
    const x = await setup(), first = await getOrthoProblemSources(x.scope); if (!first.ok) throw Error(first.code);
    const pano = first.candidates.find(c => c.category === "قراءة بانوراما")!, command = review(pano), saved = await appendOrthoProblemSource({ ...x.scope, command }); if (!saved.ok) throw Error(saved.code);
    const correction = structuredClone(x.command); correction.commandId = randomUUID(); correction.expectedRevisionId = x.revision.id;
    correction.content.observations.observations.find(o => o.id === pano.ref.member)!.value = { state: "recorded", text: "Synthetic corrected source finding" };
    expect(await appendOrthoAssessment({ ...x.scope, command: correction })).toMatchObject({ ok: true });
    const changed = await getOrthoProblemSources(x.scope); if (!changed.ok) throw Error(changed.code);
    expect(changed.reviews[0]).toMatchObject({ currentSourceState: "newer_version", problemLabel: command.label });
    expect(changed.problems[0].label).toBe(command.label);
    const latest = changed.candidates.find(c => c.identity === pano.identity)!;
    expect(await appendOrthoProblemSource({ ...x.scope, command: review(latest, { expectedReviewId: saved.reviewId }) })).toMatchObject({ ok: false, code: "problem_source_has_problem" });
    expect(await appendOrthoProblemSource({ ...x.scope, command: review(latest, { action: "link", problemId: saved.problemId, label: null, expectedReviewId: saved.reviewId }) })).toMatchObject({ ok: true });
    expect(await appendOrthoProblemSource({ ...x.scope, command })).toEqual({ ...saved, replayed: true });
    expect((await f.pool.query("SELECT label FROM patient_problems WHERE id=$1", [saved.problemId])).rows[0].label).toBe(command.label);
    await expect(f.pool.query("UPDATE ortho_problem_source_reviews SET reason='mutated' WHERE id=$1", [saved.reviewId])).rejects.toThrow();
  });
  it("serializes competing reviews, rejects forged sources and revokes current authority", async () => {
    const x = await setup(), read = await getOrthoProblemSources(x.scope); if (!read.ok) throw Error(read.code);
    const candidate = read.candidates.find(c => c.ref.kind === "clinical_diagnosis")!;
    const results = await Promise.all([1, 2].map(() => appendOrthoProblemSource({ ...x.scope, command: review(candidate) })));
    expect(results.filter(r => r.ok)).toHaveLength(1); expect(results.filter(r => !r.ok)).toMatchObject([{ code: "problem_review_changed" }]);
    const other = read.candidates.find(c => c.ref.kind === "assessment_analysis")!;
    expect(await appendOrthoProblemSource({ ...x.scope, command: review({ ...other, ref: { ...other.ref, id: 2147483647 } }) })).toMatchObject({ ok: false, code: "problem_source_changed" });
    await f.pool.query("UPDATE users SET is_active=false WHERE id=$1", [x.userId]);
    expect(await appendOrthoProblemSource({ ...x.scope, command: review(other) })).toMatchObject({ ok: false, status: 401 });
  });
  it("serializes with the existing diagnosis writer before selecting the current source", async () => {
    const x = await setup(), read = await getOrthoProblemSources(x.scope); if (!read.ok) throw Error(read.code);
    const candidate = read.candidates.find(c => c.ref.kind === "clinical_diagnosis")!, blocker = await f.pool.connect();
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM patient_diagnoses WHERE id=$1 FOR UPDATE", [candidate.ref.id]);
    let writing: ReturnType<typeof f.db.recordPatientDiagnosis> | undefined, reviewing: ReturnType<typeof appendOrthoProblemSource> | undefined;
    try {
      writing = f.db.recordPatientDiagnosis({ patientId: x.scope.patientId, orthoCaseId: x.scope.orthoCaseId, visitId: null, label: null, content: { skeletal: "Concurrent clinician correction" }, createdBy: "synthetic" });
      await expect.poll(async () => (await f.pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id, version FROM patient_diagnoses%'" )).rows[0].n).toBe(1);
      reviewing = appendOrthoProblemSource({ ...x.scope, command: review(candidate) });
      await expect.poll(async () => (await f.pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock(73127,%'" )).rows[0].n).toBe(1);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect(await writing).toMatchObject({ version: 2 });
    expect(await reviewing).toMatchObject({ ok: false, code: "problem_source_changed" });
    expect(await getOrthoProblemSources(x.scope)).toMatchObject({ ok: true, problems: [], reviews: [] });
  });
  it("rolls back problem and review when audit fails and rejects foreign problem links", async () => {
    const foreign = await setup(), x = await setup(), read = await getOrthoProblemSources(x.scope); if (!read.ok) throw Error(read.code);
    const candidate = read.candidates.find(c => c.ref.kind === "clinical_diagnosis")!;
    const foreignProblem = (await f.pool.query("INSERT INTO patient_problems(patient_id,case_id,label,noted_by) VALUES($1,$2,'Synthetic foreign problem','synthetic') RETURNING id", [foreign.scope.patientId, foreign.scope.clinicalCaseId])).rows[0].id;
    expect(await appendOrthoProblemSource({ ...x.scope, command: review(candidate, { action: "link", problemId: foreignProblem, label: null }) })).toMatchObject({ ok: false, code: "problem_not_active_in_case" });
    await f.pool.query("CREATE FUNCTION synthetic_problem_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.problem_source.review' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_problem_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_problem_audit_fail()");
    try { await expect(appendOrthoProblemSource({ ...x.scope, command: review(candidate) })).rejects.toThrow("synthetic audit failure"); }
    finally { await f.pool.query("DROP TRIGGER synthetic_problem_audit_fail ON audit_log; DROP FUNCTION synthetic_problem_audit_fail()"); }
    expect(await getOrthoProblemSources(x.scope)).toMatchObject({ ok: true, problems: [], reviews: [] });
    const saved = await appendOrthoProblemSource({ ...x.scope, command: review(candidate) }); if (!saved.ok) throw Error(saved.code);
    await expect(f.pool.query("UPDATE patient_problems SET case_id=$1 WHERE id=$2", [foreign.scope.clinicalCaseId, saved.problemId])).rejects.toThrow();
  });
});
