import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { appendOrthoProblemSource, getOrthoProblemSources } from "../../lib/ortho-problem-source-store";
import { appendFacialAnalysis } from "../../lib/ortho-facial-store";
import { getOrthoStudySourceChoices } from "../../lib/ortho-case-study-inventory";
import { getOrthoCaseStudy, saveOrthoCaseStudy } from "../../lib/ortho-case-study-store";
import { getOrthoStudyPanelReview } from "../../lib/ortho-case-study-review-store";
import { studyTextPresentation } from "../../lib/ortho-study-text-export";
import { syntheticStudyCommand } from "../fixtures/ortho-case-study";
import { syntheticFace } from "../fixtures/ortho-facial-analysis";
import type { StudyProblemReview } from "../../lib/ortho-study-problem-review";
const media = vi.hoisted(() => ({ token: "", bytes: Buffer.alloc(0) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: media.token } : undefined }), headers: async () => new Headers() }));
// Only storage transport is replaced. Sharp decodes real synthetic bytes; all
// review, ownership, study submission, source-union and SQL paths are real.
vi.mock("@/lib/files", () => ({ readFileByKeyBounded: async () => media.bytes }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-study-problem-review-at-least32");
  f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema();
  media.bytes = await sharp({ create: { width: 1000, height: 1200, channels: 3, background: "#667788" } }).png().toBuffer();
});
afterAll(async () => { try { await f?.close(); } finally { vi.unstubAllEnvs(); } });
async function fixture(facial = false) {
  const username = `study-problem-${randomUUID()}`, password = "synthetic-password";
  const userId = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic reviewer',$2,'admin') RETURNING id", [username, password])).rows[0].id;
  const session: SessionPayload = { userId, username, role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600000 };
  media.token = createSessionToken(session);
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic study source') RETURNING id", [randomUUID()])).rows[0].id;
  const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'active',$2) RETURNING id", [patientId, username])).rows[0].id;
  const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,$3) RETURNING id", [patientId, orthoCaseId, username])).rows[0].id;
  const owner = { patientId, orthoCaseId, clinicalCaseId, session, actorId: userId };
  let documentId: number | null = null;
  if (facial) {
    const sha256 = createHash("sha256").update(media.bytes).digest("hex");
    documentId = (await f.pool.query(`INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,photo_view)
      VALUES($1,$2,'Synthetic frontal photo','image/png',$3,$4,'synthetic-only',$5,'extraoral_frontal') RETURNING id`,
    [patientId, orthoCaseId, media.bytes.length, sha256, username])).rows[0].id;
    const content = syntheticFace(); content.image.sha256 = sha256;
    content.quality = { frontalRest: true, headPosition: true, visibleLandmarks: true, perspectiveReviewed: true, note: "Synthetic reviewed photo" };
    content.review = { state: "reviewed", note: "Historical facial note reviewed by clinician" };
    const saved = await appendFacialAnalysis({ ...owner, command: { schemaVersion: 1, clientRequestId: randomUUID(), documentId,
      expectedHeadId: null, reason: "Synthetic facial review", content } });
    if (!saved.ok) throw Error(saved.code);
  } else {
    await f.pool.query("INSERT INTO patient_diagnoses(patient_id,ortho_case_id,version,content,created_by) VALUES($1,$2,1,$3::jsonb,$4)",
      [patientId, orthoCaseId, JSON.stringify({ skeletal: "Original clinician observation" }), username]);
  }
  const read = await getOrthoProblemSources(owner); if (!read.ok) throw Error(read.code);
  const candidate = read.candidates.find(source => source.ref.kind === (facial ? "facial_review" : "clinical_diagnosis"));
  if (!candidate) throw Error("Synthetic source not available");
  const problem = await appendOrthoProblemSource({ ...owner, command: { schemaVersion: 1, commandId: randomUUID(), source: candidate.ref,
    expectedReviewId: null, action: "create", problemId: null, label: "Original reviewed problem", reason: "Explicit clinical source review", clinicianReviewed: true } });
  if (!problem.ok) throw Error(problem.code);
  const inventory = await getOrthoStudySourceChoices({ ...owner, kind: "problem_review" });
  if (!inventory.ok || inventory.state !== "available") throw Error(JSON.stringify(inventory));
  const selection = inventory.choices.find(value => value.id === problem.reviewId)?.selection;
  if (!selection) throw Error("Synthetic reviewed source not offered");
  const command = syntheticStudyCommand(); command.clientRequestId = randomUUID(); command.content.sources = [selection];
  command.content.panels = [{ instanceId: "reviewed-problem", layoutKey: "problem-plan-strategy", included: true,
    state: "available", sourceKeys: [selection.key], images: [], comment: "" }];
  const saved = await saveOrthoCaseStudy({ ...owner, command }); if (!saved.ok) throw Error(saved.code);
  return { ...owner, documentId, problem, command, saved, candidate };
}
async function unchanged(revisionId: number, before: unknown) {
  expect((await f.pool.query("SELECT content,content_sha256 FROM ortho_case_study_revisions WHERE id=$1", [revisionId])).rows[0]).toEqual(before);
}
async function stored(revisionId: number) {
  return (await f.pool.query("SELECT content,content_sha256 FROM ortho_case_study_revisions WHERE id=$1", [revisionId])).rows[0];
}
it("selects, saves, reloads and projects the reviewed snapshot; newer problem/diagnosis facts never rewrite it", async () => {
  const owner = await fixture(), revision = owner.saved.revision, before = await stored(revision.id);
  const payload = revision.content.sources[0].payload as StudyProblemReview;
  expect(payload).toMatchObject({ problemId: owner.problem.problemId, problemLabelAtReview: "Original reviewed problem", source: { summary: "Original clinician observation" } });
  expect(await getOrthoCaseStudy(owner)).toMatchObject({ ok: true, revision: { contentHash: revision.contentHash } });
  const panel = await getOrthoStudyPanelReview({ ...owner, revisionId: revision.id, panelId: "reviewed-problem" });
  expect(panel.ok).toBe(true); expect(JSON.stringify(panel)).toContain("Original reviewed problem");
  expect(JSON.stringify(studyTextPresentation(revision, owner))).toContain("Original clinician observation");
  await f.pool.query("UPDATE patient_problems SET label='New live problem label' WHERE id=$1", [owner.problem.problemId]);
  await f.pool.query("INSERT INTO patient_diagnoses(patient_id,ortho_case_id,version,content,created_by) VALUES($1,$2,2,$3::jsonb,$4)",
    [owner.patientId, owner.orthoCaseId, JSON.stringify({ skeletal: "New clinician observation" }), owner.session.username]);
  const later = await getOrthoStudyPanelReview({ ...owner, revisionId: revision.id, panelId: "reviewed-problem" });
  expect(later).toEqual(panel); expect(JSON.stringify(later)).not.toContain("New live problem label");
  const replay = await saveOrthoCaseStudy({ ...owner, command: owner.command });
  expect(replay).toMatchObject({ ok: true, replayed: true, revision: { id: revision.id, contentHash: revision.contentHash } });
  await unchanged(revision.id, before);
});
it("includes facial review provenance and refuses a removed backing image without changing the study", async () => {
  const owner = await fixture(true), revision = owner.saved.revision, before = await stored(revision.id);
  expect(revision.content.sources[0]).toMatchObject({ access: { images: true }, payload: { source: { facialDocument: { id: owner.documentId } } } });
  expect(await getOrthoStudyPanelReview({ ...owner, revisionId: revision.id, panelId: "reviewed-problem" })).toMatchObject({ ok: true });
  await f.pool.query("UPDATE patient_documents SET removed_at=now() WHERE id=$1", [owner.documentId]);
  expect(await getOrthoCaseStudy(owner)).toMatchObject({ ok: false, status: 403 });
  expect(await getOrthoStudyPanelReview({ ...owner, revisionId: revision.id, panelId: "reviewed-problem" })).toMatchObject({ ok: false, status: 403 });
  expect(await saveOrthoCaseStudy({ ...owner, command: owner.command })).toMatchObject({ ok: false, status: 403 });
  await unchanged(revision.id, before);
});
it("revokes source inventory, saved review and exact save replay when image permission is withdrawn", async () => {
  const owner = await fixture(true), revision = owner.saved.revision, before = await stored(revision.id);
  await f.pool.query("UPDATE users SET role='doctor',permissions=$1 WHERE id=$2", [JSON.stringify({ canViewAllPatients: true, canViewXrays: false }), owner.actorId]);
  const session = { ...owner.session, role: "doctor" as const }; media.token = createSessionToken(session);
  const restricted = { ...owner, session };
  expect(await getOrthoStudySourceChoices({ ...restricted, kind: "problem_review" })).toMatchObject({ ok: false, status: 403 });
  expect(await getOrthoCaseStudy(restricted)).toMatchObject({ ok: false, status: 403 });
  expect(await saveOrthoCaseStudy({ ...restricted, command: owner.command })).toMatchObject({ ok: false, status: 403 });
  await unchanged(revision.id, before);
});
it("does not offer another case's review and rejects a changed offered hash before creating a revision", async () => {
  const owner = await fixture(), other = await fixture();
  const offered = await getOrthoStudySourceChoices({ ...other, kind: "problem_review" });
  expect(offered.ok).toBe(true); if (offered.ok) expect(offered.choices.some(choice => choice.id === owner.problem.reviewId)).toBe(false);
  const command = structuredClone(other.command); command.clientRequestId = randomUUID();
  command.expectedHead = { id: other.saved.revision.id, contentHash: other.saved.revision.contentHash }; command.content.sources[0].contentHash = "f".repeat(64);
  // The outstanding successful command is deliberately acknowledged before the next intent.
  const { transitionStudySubmission } = await import("../../lib/ortho-study-submission-store");
  const { journeyContentHash } = await import("../../lib/ortho-case-journey-hash");
  expect(await transitionStudySubmission({ ...other, commandId: other.command.clientRequestId, requestFingerprint: journeyContentHash(other.command), action: "acknowledge" })).toMatchObject({ ok: true });
  expect(await saveOrthoCaseStudy({ ...other, command })).toMatchObject({ ok: false, status: 409, code: "study_source_version_changed" });
  expect((await f.pool.query("SELECT count(*)::int n FROM ortho_case_study_revisions WHERE ortho_case_id=$1", [other.orthoCaseId])).rows[0].n).toBe(1);
});
