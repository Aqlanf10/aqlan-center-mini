import { saveConfirmedStudy as saveOrthoCaseStudy } from "../helpers/ortho-study-submit";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { getOrthoCaseStudy } from "../../lib/ortho-case-study-store";
import { getStudyLongitudinalEligibility } from "../../lib/ortho-study-longitudinal-store";
import { getOrthoStudyPanelReview } from "../../lib/ortho-case-study-review-store";
import { getOrthoStudySourceChoices } from "../../lib/ortho-case-study-inventory";
import { ORTHO_CASE_STUDY_SQL } from "../../lib/ortho-case-study-schema";
import { ProtectedOrthoStudyHistoryError, RESET_KEEP_TABLES, RESET_WIPE_TABLES } from "../../lib/clinic-reset";
import { syntheticStudyCommand as study } from "../fixtures/ortho-case-study";

const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, session: SessionPayload;
const password = "synthetic-study-credential-not-a-real-password";
const selectActor = (actor: SessionPayload) => { request.token = createSessionToken(actor); };
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-study-secret-at-least-32-characters");
  f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema();
  session = await actor("admin"); selectActor(session);
});
afterAll(async () => { try { await f?.close(); } finally { vi.unstubAllEnvs(); } });
async function actor(role: SessionPayload["role"], permissions?: Record<string, boolean>) {
  const username = `synthetic-study-${randomUUID()}`;
  const row = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES($1,'Synthetic recorder',$2,$3,$4) RETURNING id", [username, password, role, permissions ? JSON.stringify(permissions) : null])).rows[0];
  return { userId: row.id, username, role, credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600_000 } satisfies SessionPayload;
}
async function scope() {
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic study') RETURNING id", [randomUUID()])).rows[0].id;
  const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic','completed') RETURNING id", [patientId])).rows[0].id;
  const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id;
  return { patientId, orthoCaseId, clinicalCaseId, session };
}
const financial = async () => (await f.pool.query("SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM patient_opening_balances) opening,(SELECT count(*)::int FROM visits) visits")).rows;
const stored = async (caseId: number) => (await f.pool.query("SELECT to_jsonb(r)::text value FROM ortho_case_study_revisions r WHERE ortho_case_id=$1 ORDER BY version", [caseId])).rows;

it("registers the exact additive migration, keeps excluded modules absent and allows empty protected-history reset", async () => {
  expect(readFileSync("migrations/0111_ortho_case_study.sql", "utf8")).toBe(ORTHO_CASE_STUDY_SQL);
  expect((await f.pool.query("SELECT name,checksum,adopted FROM schema_migrations WHERE version='0111'")).rows).toEqual([{ name: "ortho_case_study", checksum: createHash("sha256").update(ORTHO_CASE_STUDY_SQL).digest("hex"), adopted: false }]);
  for (const table of ["ortho_decision_revisions", "ortho_study_image_transforms", "ortho_space_analysis_revisions"])
    expect((await f.pool.query("SELECT to_regclass($1)::text name", [table])).rows[0].name).toBeNull();
  expect(RESET_KEEP_TABLES).toContain("ortho_case_study_revisions"); expect(RESET_WIPE_TABLES).not.toContain("ortho_case_study_revisions");
  const owner = await scope(); let backed = false;
  const result = await f.db.resetClinicData({ actor: session.username, actorRole: session.role }, async client => {
    backed = true; expect((await client.query("SELECT id FROM patients WHERE id=$1", [owner.patientId])).rows).toHaveLength(1);
    return { ok: true, backupId: "synthetic-empty-study-reset" };
  });
  expect(backed).toBe(true); expect(result).toMatchObject({ ok: true, counts: { patients: 1 } });
  expect((await f.pool.query("SELECT * FROM ortho_case_study_revisions")).rows).toEqual([]);
});
it("saves, reads and documents the exact draft without changing missing facts or money", async () => {
  const owner = await scope(), command = study(), before = await financial();
  const draft = await saveOrthoCaseStudy({ ...owner, command }); if (!draft.ok) throw Error(draft.code);
  const ref = { id: draft.revision.id, contentHash: draft.revision.contentHash };
  const changed = { ...command, clientRequestId: randomUUID(), kind: "documented" as const, expectedHead: ref, documentedFrom: ref, content: { ...command.content, comment: "Unapproved new content" } };
  expect(await saveOrthoCaseStudy({ ...owner, command: changed })).toMatchObject({ ok: false, code: "study_documented_content_changed" });
  const documented = await saveOrthoCaseStudy({ ...owner, command: { ...changed, clientRequestId: randomUUID(), content: command.content } }); if (!documented.ok) throw Error(documented.code);
  expect(documented.revision.content).toEqual(draft.revision.content); expect(documented.revision.contentHash).toBe(draft.revision.contentHash);
  expect(await saveOrthoCaseStudy({ ...owner, command })).toMatchObject({ ok: true, replayed: true, revision: draft.revision });
  expect(await getOrthoCaseStudy({ ...owner, revisionId: draft.revision.id })).toMatchObject({ ok: true, revision: draft.revision, head: { id: documented.revision.id } });
  expect(await getOrthoStudyPanelReview({ ...owner, revisionId: documented.revision.id, panelId: "interview1" })).toMatchObject({ ok: true, panelState: "not_recorded", blocks: [], comments: ["Synthetic physician comment", "Missing findings remain explicit"] });
  expect(await financial()).toEqual(before);
  expect((await f.pool.query("SELECT id FROM audit_log WHERE action='ortho.journey_record' AND entity_id=ANY($1::text[])", [[String(draft.revision.id), String(documented.revision.id)]])).rows).toHaveLength(2);
});
it("serializes competing CAS saves and rejects changed request-key reuse", async () => {
  const owner = await scope(), a = study(), b = study();
  const results = await Promise.all([saveOrthoCaseStudy({ ...owner, command: a }), saveOrthoCaseStudy({ ...owner, command: b })]);
  expect(results.filter(r => r.ok)).toHaveLength(1); expect(results.find(r => !r.ok)).toMatchObject({ status: 409, code: "study_submission_unacknowledged" });
  const accepted = results[0].ok ? a : b;
  expect(await saveOrthoCaseStudy({ ...owner, command: { ...accepted, reason: "Changed request" } })).toMatchObject({ ok: false, code: "request_key_conflict" });
  expect(await stored(owner.orthoCaseId)).toHaveLength(1);
});
it("rolls back on audit failure and refuses stale current authentication and non-clinical writes", async () => {
  const owner = await scope();
  await f.pool.query("CREATE FUNCTION synthetic_study_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.journey_record' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_study_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_study_audit_fail()");
  try { await expect(saveOrthoCaseStudy({ ...owner, command: study() })).rejects.toThrow("synthetic audit failure"); }
  finally { await f.pool.query("DROP TRIGGER synthetic_study_audit_fail ON audit_log; DROP FUNCTION synthetic_study_audit_fail()"); }
  expect(await stored(owner.orthoCaseId)).toEqual([]);
  await f.pool.query("UPDATE users SET is_active=FALSE WHERE id=$1", [session.userId]);
  try { expect(await saveOrthoCaseStudy({ ...owner, command: study() })).toMatchObject({ ok: false, status: 401 }); }
  finally { await f.pool.query("UPDATE users SET is_active=TRUE WHERE id=$1", [session.userId]); }
  const reception = await actor("reception"); selectActor(reception);
  try {
    expect(await getOrthoCaseStudy({ ...owner, session: reception })).toMatchObject({ ok: true, canAppend: false });
    expect(await saveOrthoCaseStudy({ ...owner, session: reception, command: study() })).toMatchObject({ ok: false, status: 403 });
  } finally { selectActor(session); }
});
it("rechecks document permission on saved reads, replay and documentation", async () => {
  const owner = await scope(); const hash = "a".repeat(64);
  const doc = (await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'Synthetic image','image/png',42,$3,'synthetic-only','synthetic') RETURNING id", [owner.patientId, owner.orthoCaseId, hash])).rows[0].id;
  const command = study(); command.content.sources = [{ key: "image1", kind: "document", id: doc, version: null, contentHash: hash }];
  command.content.panels[0] = { ...command.content.panels[0], state: "available", sourceKeys: ["image1"] };
  const doctor = await actor("doctor", { canViewAllPatients: true, canViewXrays: true }); selectActor(doctor);
  try {
    const input = { ...owner, session: doctor }, saved = await saveOrthoCaseStudy({ ...input, command }); if (!saved.ok) throw Error(saved.code);
    await f.pool.query("UPDATE users SET permissions=$2 WHERE id=$1", [doctor.userId, JSON.stringify({ canViewAllPatients: true, canViewXrays: false })]);
    expect(await getOrthoCaseStudy(input)).toMatchObject({ ok: false, status: 403 });
    expect(await saveOrthoCaseStudy({ ...input, command })).toMatchObject({ ok: false, status: 403 });
    const ref = { id: saved.revision.id, contentHash: saved.revision.contentHash };
    expect(await saveOrthoCaseStudy({ ...input, command: { ...command, clientRequestId: randomUUID(), expectedHead: ref, documentedFrom: ref, kind: "documented" } })).toMatchObject({ ok: false, status: 403 });
    expect(await stored(owner.orthoCaseId)).toHaveLength(1);
  } finally { selectActor(session); }
  await f.pool.query("UPDATE patient_documents SET removed_at=clock_timestamp() WHERE id=$1", [doc]);
  expect(await getOrthoCaseStudy(owner)).toMatchObject({ ok: false, status: 403 });
});
it("keeps absent decision module unavailable and refuses cross-patient scope", async () => {
  const owner = await scope(), other = await scope();
  for (const kind of ["decision"] as const) {
    expect(await getOrthoStudySourceChoices({ ...owner, kind })).toMatchObject({ ok: false, code: "study_source_not_integrated" });
    const command = study(); command.content.sources = [{ key: "absent", kind, id: 1, version: 1, contentHash: "b".repeat(64) }];
    expect(await saveOrthoCaseStudy({ ...owner, command })).toMatchObject({ ok: false, code: "study_source_not_integrated" });
  }
  expect(await getOrthoCaseStudy({ ...owner, patientId: other.patientId })).toMatchObject({ ok: false, status: 404 });
});
it("preserves recorded identity and exact capture through canonical merge and documentation afterwards", async () => {
  const owner = await scope(), command = study(), saved = await saveOrthoCaseStudy({ ...owner, command }); if (!saved.ok) throw Error(saved.code);
  const target = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic merge target') RETURNING id", [randomUUID()])).rows[0].id;
  expect(await f.db.mergeDuplicatePatient(owner.patientId, target, { actor: session.username, actorRole: session.role })).toMatchObject({ ok: true });
  const moved = { ...owner, patientId: target };
  expect(await getOrthoCaseStudy(moved)).toMatchObject({ ok: true, revision: { ...saved.revision, patientId: target, recordedPatientId: owner.patientId } });
  expect(await saveOrthoCaseStudy({ ...moved, command })).toMatchObject({ ok: true, replayed: true, revision: { content: saved.revision.content } });
  const ref = { id: saved.revision.id, contentHash: saved.revision.contentHash };
  const documented = await saveOrthoCaseStudy({ ...moved, command: { ...command, clientRequestId: randomUUID(), expectedHead: ref, documentedFrom: ref, kind: "documented" } });
  expect(documented).toMatchObject({ ok: true, revision: { patientId: target, recordedPatientId: target, content: saved.revision.content, contentHash: saved.revision.contentHash } });
});
it("blocks direct mutations, mismatched ownership, TRUNCATE and reset before backup", async () => {
  const owner = await scope(), other = await scope(), saved = await saveOrthoCaseStudy({ ...owner, command: study() }); if (!saved.ok) throw Error(saved.code);
  const before = await stored(owner.orthoCaseId);
  for (const sql of ["UPDATE ortho_case_study_revisions SET reason='changed' WHERE id=$1", "DELETE FROM ortho_case_study_revisions WHERE id=$1", "UPDATE ortho_case_study_revisions SET recorded_patient_id=999 WHERE id=$1"])
    await expect(f.pool.query(sql, [saved.revision.id])).rejects.toThrow("append-only");
  await expect(f.pool.query("UPDATE ortho_case_study_revisions SET patient_id=$2 WHERE id=$1", [saved.revision.id, other.patientId])).rejects.toThrow("ownership");
  await expect(f.pool.query("UPDATE ortho_cases SET patient_id=$2 WHERE id=$1", [owner.orthoCaseId, other.patientId])).rejects.toThrow("ownership");
  await expect(f.pool.query("UPDATE clinical_cases SET specialty='general' WHERE id=$1", [owner.clinicalCaseId])).rejects.toThrow();
  await expect(f.pool.query("TRUNCATE ortho_case_study_revisions, ortho_study_submissions")).rejects.toThrow("append-only");
  let backed = false;
  await expect(f.db.resetClinicData({ actor: session.username, actorRole: session.role }, async () => { backed = true; return { ok: false, failure: "must not reach backup" }; })).rejects.toBeInstanceOf(ProtectedOrthoStudyHistoryError);
  expect(backed).toBe(false); expect(await stored(owner.orthoCaseId)).toEqual(before);
});

  it.each([null, 'same'])("captures a real Ortho session with visit case %s without assigning the visit, then refuses a foreign case link", async visitCase => {
    const owner = await scope(), visitId = (await f.pool.query("INSERT INTO visits(patient_id,patient_name,status,case_id) VALUES($1,'Synthetic session visit','done',$2) RETURNING id", [owner.patientId, visitCase === null ? null : owner.clinicalCaseId])).rows[0].id;
    const adjustmentId = (await f.pool.query("INSERT INTO ortho_adjustments(case_id,visit_id,done,note,recorded_by) VALUES($1,$2,'Synthetic actual procedure','Synthetic session note','synthetic') RETURNING id", [owner.orthoCaseId, visitId])).rows[0].id;
    const before = await financial(), choices = await getOrthoStudySourceChoices({ ...owner, kind: 'adjustment' });
    expect(choices).toMatchObject({ ok: true, state: 'available' });
    if (!choices.ok || choices.state !== 'available') throw Error('session choices unavailable');
    const selected = choices.choices.find(c => c.id === adjustmentId)?.selection;
    expect(selected).toBeTruthy(); if (!selected) throw Error('session source missing');
    const command = study(); command.content.sources = [selected];
    command.content.panels = [{ instanceId: 'session', layoutKey: 'visit', included: true, state: 'available', sourceKeys: [selected.key], images: [], comment: '' }];
    const saved = await saveOrthoCaseStudy({ ...owner, command }); if (!saved.ok) throw Error(saved.code);
    const read = await getOrthoCaseStudy({ ...owner, revisionId: saved.revision.id });
    expect(read).toMatchObject({ ok: true, revision: { content: { sources: [{ payload: { id: adjustmentId, visitId, done: 'Synthetic actual procedure' } }] } } });
    const review=await getOrthoStudyPanelReview({...owner,revisionId:saved.revision.id,panelId:'session'});
    expect(review.ok).toBe(true);expect(JSON.stringify(review)).toContain('Synthetic actual procedure');
    expect((await f.pool.query('SELECT case_id FROM visits WHERE id=$1', [visitId])).rows[0].case_id).toBe(visitCase === null ? null : owner.clinicalCaseId);
    expect(await financial()).toEqual(before);
    const otherCase = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES($1,'orthodontics','Synthetic other case','synthetic') RETURNING id", [owner.patientId])).rows[0].id;
    const writer=await f.pool.connect();
    await writer.query('BEGIN');
    await writer.query('UPDATE visits SET case_id=$1 WHERE id=$2', [otherCase, visitId]);
    const pending=getOrthoCaseStudy({ ...owner, revisionId: saved.revision.id });
    try {
      await expect.poll(async()=> (await f.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM visits WHERE id=ANY%') AS waiting")).rows[0].waiting,{timeout:5000}).toBe(true);
      await writer.query('COMMIT');
      expect(await pending).toMatchObject({ ok: false, status: 403 });
    } finally { await writer.query('ROLLBACK'); writer.release(); await pending; }
  });

it("rechecks the exact adjustment visit and rejects a foreign-patient source after saving", async () => {
  const owner = await scope(), other = await scope();
  const visit = (await f.pool.query("INSERT INTO visits(patient_id,patient_name) VALUES($1,'Synthetic session') RETURNING id", [owner.patientId])).rows[0].id;
  const foreignVisit = (await f.pool.query("INSERT INTO visits(patient_id,patient_name) VALUES($1,'Synthetic foreign session') RETURNING id", [other.patientId])).rows[0].id;
  const adjustment = (await f.pool.query("INSERT INTO ortho_adjustments(case_id,visit_id,done,recorded_by) VALUES($1,$2,'Synthetic completed step','synthetic') RETURNING id", [owner.orthoCaseId, visit])).rows[0].id;
  const choices = await getOrthoStudySourceChoices({ ...owner, kind: "adjustment" });
  if (!choices.ok || choices.state !== "available") throw Error("Synthetic source unavailable");
  const selection = choices.choices.find(row => row.id === adjustment)?.selection; if (!selection) throw Error("Missing synthetic selection");
  const command = study(); command.content.sources = [selection];
  command.content.panels = [{ instanceId: "session", layoutKey: "visit", included: true, state: "available", sourceKeys: [selection.key], images: [], comment: "" }];
  const saved = await saveOrthoCaseStudy({ ...owner, command }); if (!saved.ok) throw Error(saved.code);
  await f.pool.query("UPDATE ortho_adjustments SET visit_id=$2 WHERE id=$1", [adjustment, foreignVisit]);
  expect(await getOrthoCaseStudy(owner)).toMatchObject({ ok: false, status: 403 });
  expect(await saveOrthoCaseStudy({ ...owner, command })).toMatchObject({ ok: false, status: 403 });
  expect(await getOrthoStudySourceChoices({ ...owner, kind: "adjustment" })).toMatchObject({ ok: false, status: 409, code: "study_visit_scope_changed" });
  expect(await stored(owner.orthoCaseId)).toHaveLength(1);
});
it("fences reset behind an in-flight study save without deadlock or history loss", async () => {
  const owner = await scope(), client = await f.pool.connect();
  await client.query("BEGIN"); await client.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [owner.patientId]);
  const pendingSave = saveOrthoCaseStudy({ ...owner, command: study() });
  let pendingReset: Promise<unknown> | undefined;
  let backupCalled = false;
  try {
    await expect.poll(async () => (await f.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM patients WHERE id=%FOR NO KEY UPDATE') waiting")).rows[0].waiting, { timeout: 5000 }).toBe(true);
    pendingReset = f.db.resetClinicData({ actor: session.username, actorRole: session.role }, async () => { backupCalled = true; return { ok: false, failure: "must not back up protected history" }; }).then(value => value, error => error);
    await expect.poll(async () => (await f.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='LOCK TABLE ortho_case_study_revisions, ortho_study_submissions IN EXCLUSIVE MODE') waiting")).rows[0].waiting, { timeout: 5000 }).toBe(true);
    await client.query("COMMIT");
    expect(await pendingSave).toMatchObject({ ok: true });
    expect(await pendingReset).toBeInstanceOf(ProtectedOrthoStudyHistoryError);
    expect(backupCalled).toBe(false); expect(await stored(owner.orthoCaseId)).toHaveLength(1);
  } finally { await client.query("ROLLBACK"); client.release(); await pendingSave; await pendingReset; }
});

it("reads longitudinal eligibility only from the selected saved ceph capture and current source authority", async () => {
  const owner=await scope(), command=study();
  for (let index=0;index<2;index++) {
    const documentId=(await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'Synthetic ceph','image/png',12,$3,'synthetic','synthetic') RETURNING id",[owner.patientId,owner.orthoCaseId,String(index+1).repeat(64)])).rows[0].id;
    const analysisId=(await f.pool.query("INSERT INTO ceph_analyses(patient_id,ortho_case_id,document_id,status,created_by,completed_by,completed_at,xray_date) VALUES($1,$2,$3,'completed','synthetic','synthetic',now(),$4) RETURNING id",[owner.patientId,owner.orthoCaseId,documentId,index===0?null:'2020-02-29'])).rows[0].id;
    await f.pool.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'SNA',$2)",[analysisId,84-index]);
  }
  const inventory=await getOrthoStudySourceChoices({...owner,kind:'ceph_study'});if(!inventory.ok||inventory.state!=='available')throw Error('Synthetic inventory unavailable');
  command.content.sources=inventory.choices.map(c=>c.selection!);command.content.panels[0]={...command.content.panels[0],layoutKey:'ceph-measurements',state:'available',sourceKeys:command.content.sources.map(s=>s.key)};
  command.content.groups=command.content.sources.map((source,index)=>({id:`stage${index}`,label:`Synthetic T${index+1}`,phase:`T${index+1}`,occurrence:{occurredOn:null,dateProvenance:'unknown',sourceNote:'Unknown, not created date'},sourceKeys:[source.key]}));
  const saved=await saveOrthoCaseStudy({...owner,command});if(!saved.ok)throw Error(saved.code);
  const before=await stored(owner.orthoCaseId), money=await financial();
  await f.pool.query("UPDATE ceph_analyses SET ref_set='later_mutable_reference' WHERE ortho_case_id=$1",[owner.orthoCaseId]);
  const result=await getStudyLongitudinalEligibility({...owner,revisionId:saved.revision.id});expect(result).toMatchObject({ok:true,pairs:[{state:'unavailable',delta:null}]});
  expect(JSON.stringify(result)).not.toContain('later_mutable_reference');expect(await stored(owner.orthoCaseId)).toEqual(before);expect(await financial()).toEqual(money);
  const firstSource=command.content.sources[0];const document=(await f.pool.query('SELECT document_id FROM ceph_analyses WHERE id=$1',[firstSource.id])).rows[0].document_id;
  await f.pool.query("UPDATE patient_documents SET removed_at=now(),removed_by='synthetic',removed_note='Synthetic permission change' WHERE id=$1",[document]);
  expect(await getStudyLongitudinalEligibility({...owner,revisionId:saved.revision.id})).toMatchObject({ok:false,status:403});
});
