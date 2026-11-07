import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { journeyContentHash } from "../../lib/ortho-case-journey-hash";
import { getOrthoStudySourceChoices } from "../../lib/ortho-case-study-inventory";
import { getOrthoCaseStudy, saveOrthoCaseStudy } from "../../lib/ortho-case-study-store";
import { reserveStudySubmission, getStudySubmissionRecovery, transitionStudySubmission } from "../../lib/ortho-study-submission-store";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { syntheticStudyCommand } from "../fixtures/ortho-case-study";
import { syntheticStudyCephWitness } from "../fixtures/ortho-study-ceph-witness";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, session: SessionPayload;
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-study-witness-secret-at-least-32-characters");
  f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema();
  const username = `synthetic-witness-${randomUUID()}`, password = "synthetic-only-no-real-secret";
  const { rows: [actor] } = await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic witness',$2,'admin') RETURNING id", [username, password]);
  session = { userId: actor.id, username, role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600_000 };
  request.token = createSessionToken(session);
});
afterAll(async () => { try { await f?.close(); } finally { vi.unstubAllEnvs(); } });
async function fixture(corruption?: "hash" | "schema" | "identity" | "id") {
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic witness') RETURNING id", [randomUUID()])).rows[0].id;
  const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,$2,'completed') RETURNING id", [patientId, session.username])).rows[0].id;
  const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic witness',$2,$3) RETURNING id", [patientId, orthoCaseId, session.username])).rows[0].id;
  const witness = syntheticStudyCephWitness();
  const documentId = (await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,width,height,storage_key,uploaded_by) VALUES($1,$2,'Synthetic image','image/png',12,$3,800,600,'synthetic-only',$4) RETURNING id", [patientId, orthoCaseId, witness.image.sha256, session.username])).rows[0].id;
  const analysisId = Number((await f.pool.query(`INSERT INTO ceph_analyses(patient_id,ortho_case_id,document_id,status,created_by,created_at,completed_by,completed_at,ref_set,cal_x1,cal_y1,cal_x2,cal_y2,cal_mm,mm_per_pixel)
    VALUES($1,$2,$3,'completed',$4,'2026-11-04T10:00:00.000Z',$4,$5,$6,0,0,100,0,10,0.1) RETURNING id`, [patientId, orthoCaseId, documentId, session.username, witness.sealedAt, witness.referenceSet.key])).rows[0].id);
  witness.analysisId = analysisId; witness.recordedPatientId = patientId; witness.snapshot.patientId = patientId;
  witness.snapshot.documentId = documentId; witness.image.documentId = documentId; witness.actor = { userId: session.userId!, username: session.username };
  await f.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by,confirmed_at) VALUES($1,'S',10,20,'manual','synthetic-reviewer',$2)", [analysisId, witness.landmarkReviews[0].confirmedAt]);
  // SQL returns review timestamps with six decimals. Preserve those exact bytes.
  witness.landmarkReviews[0].confirmedAt = "2026-11-05T11:00:00.000000Z";
  await f.pool.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'SNA',82)", [analysisId]);
  await f.pool.query("INSERT INTO ceph_diagnoses(analysis_id,skeletal,final_dx,created_by) VALUES($1,'Synthetic skeletal','Synthetic diagnosis',$2)", [analysisId, session.username]);
  if (corruption === "schema") Object.assign(witness, { schemaVersion: 2 });
  if (corruption === "identity") Object.assign(witness, { sourceIdentityMeaning: "confirmed_as_viewed" });
  if (corruption === "id") witness.analysisId++;
  await f.pool.query("INSERT INTO ceph_completion_provenance(analysis_id,schema_version,witness,witness_sha256,actor_user_id,sealed_by,sealed_at) VALUES($1,1,$2::jsonb,$3,$4,$5,$6)",
    [analysisId, JSON.stringify(witness), corruption === "hash" ? "0".repeat(64) : journeyContentHash(witness), session.userId, session.username, witness.sealedAt]);
  return { patientId, orthoCaseId, clinicalCaseId, session, actorId: session.userId!, analysisId, documentId, witness };
}
async function selected(owner: Awaited<ReturnType<typeof fixture>>) {
  const inventory = await getOrthoStudySourceChoices({ ...owner, kind: "ceph_study" });
  if (!inventory.ok || inventory.state !== "available") throw Error(JSON.stringify(inventory));
  const selection = inventory.choices.find(row => row.id === owner.analysisId)?.selection;
  if (!selection) throw Error("Synthetic selection unavailable");
  const command = syntheticStudyCommand(); command.content.sources = [selection];
  command.content.panels[0] = { ...command.content.panels[0], state: "available", layoutKey: "ceph-measurements", sourceKeys: [selection.key] };
  return command;
}
it("captures nested frozen evidence using the offered hash and never current reference/engine definitions", async () => {
  const owner = await fixture(), command = await selected(owner);
  const saved = await saveOrthoCaseStudy({ ...owner, command }); if (!saved.ok) throw Error(saved.code);
  expect(saved.revision.content.sources[0].payload).toMatchObject({ captureVersion: 2, completion: { witness: owner.witness, witnessSha256: journeyContentHash(owner.witness) } });
  for (const key of ["measurements", "diagnosis", "image"]) expect(Object.keys(saved.revision.content.sources[0].payload as object)).not.toContain(key);
  expect(command.content.sources[0].version).toBeNull();
  expect(saved.revision.content.schemaVersion).toBe(1);
  expect(await getOrthoCaseStudy(owner)).toMatchObject({ ok: true });
});
it.each(["hash", "schema", "identity", "id"] as const)("never downgrades existing invalid witness %s to a selectable legacy payload", async corruption => {
  const owner = await fixture(corruption);
  expect(await getOrthoStudySourceChoices({ ...owner, kind: "ceph_study" })).toMatchObject({ ok: true, choices: [{ id: owner.analysisId, state: "unavailable", selection: null, unavailableReason: "ceph_review_projection_unavailable" }] });
  const command = syntheticStudyCommand(); command.content.sources = [{ key: "ceph", kind: "ceph_study", id: owner.analysisId, version: null, contentHash: "1".repeat(64) }];
  expect(await saveOrthoCaseStudy({ ...owner, command })).toMatchObject({ ok: false, status: 409, code: "study_ceph_source_changed" });
});
it.each([
  "UPDATE ceph_measurements SET value=83 WHERE analysis_id=$1",
  "UPDATE ceph_landmarks SET x=11 WHERE analysis_id=$1",
  "UPDATE ceph_landmarks SET confirmed_by='changed-reviewer' WHERE analysis_id=$1",
  "UPDATE ceph_diagnoses SET final_dx='Changed diagnosis' WHERE analysis_id=$1",
  "UPDATE patient_documents SET width=801 WHERE id=(SELECT document_id FROM ceph_analyses WHERE id=$1)",
  "UPDATE patient_documents SET sha256=repeat('c',64) WHERE id=(SELECT document_id FROM ceph_analyses WHERE id=$1)",
  "UPDATE patient_documents SET removed_at=now() WHERE id=(SELECT document_id FROM ceph_analyses WHERE id=$1)",
])("revalidates raw current evidence and rejects saved access after %s", async sql => {
  const owner = await fixture(), command = await selected(owner);
  expect(await saveOrthoCaseStudy({ ...owner, command })).toMatchObject({ ok: true });
  await f.pool.query(sql, [owner.analysisId]);
  expect(await getOrthoCaseStudy(owner)).toMatchObject({ ok: false, status: 403 });
  expect(await saveOrthoCaseStudy({ ...owner, command })).toMatchObject({ ok: false, status: 403 });
});
it("keeps an integrity-conflicted pending command exact and metadata-cancellable", async () => {
  const owner = await fixture(), command = await selected(owner), fingerprint = journeyContentHash(command);
  expect(await reserveStudySubmission({ ...owner, command })).toMatchObject({ ok: true });
  await f.pool.query("UPDATE ceph_measurements SET value=999 WHERE analysis_id=$1", [owner.analysisId]);
  expect(await saveOrthoCaseStudy({ ...owner, command })).toMatchObject({ ok: false, status: 409, code: "study_ceph_source_changed" });
  expect(await getStudySubmissionRecovery(owner)).toMatchObject({ ok: true, recovery: { state: "blocked", canCancel: true } });
  const row = (await f.pool.query("SELECT command,request_fingerprint,state FROM ortho_study_submissions WHERE ortho_case_id=$1", [owner.orthoCaseId])).rows[0];
  expect(row).toMatchObject({ command, request_fingerprint: fingerprint, state: "pending" });
  expect(await transitionStudySubmission({ ...owner, commandId: command.clientRequestId, requestFingerprint: fingerprint, action: "cancel" })).toMatchObject({ ok: true, state: "cancelled" });
});
