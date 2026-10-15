import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import { appendOrthoAssessment, getOrthoAssessment } from "../../lib/ortho-assessment-store";
import { appendOrthoTreatmentStrategy, getOrthoTreatmentStrategy } from "../../lib/ortho-treatment-strategy-store";
import type { StrategyCommand } from "../../lib/ortho-treatment-strategy";

// Only Next's request transport is supplied. Signed cookie, current account,
// credential/role/permission checks, access witnesses and all SQL remain real.
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }),
  headers: async () => new Headers(),
}));
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let sequence = 0;
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "ortho-union-synthetic-secret-at-least-32-characters");
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  await fixture.db.ensureSchema();
});
afterAll(async () => { try { await fixture?.close(); } finally { vi.unstubAllEnvs(); } });

async function scope() {
  const n = ++sequence;
  const patient = (await fixture.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic Ortho union') RETURNING id", [`SYN-UNION-${n}`])).rows[0].id;
  const password = "synthetic hash, not a real password";
  const user = (await fixture.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic recorder',$2,'admin') RETURNING id", [`synthetic-union-${n}`, password])).rows[0].id;
  const session: SessionPayload = { userId: user, username: `synthetic-union-${n}`, role: "admin", expiresAt: Date.now() + 120_000, credentialVersion: sessionCredentialVersion(password) };
  request.token = createSessionToken(session);
  const ortho = (await fixture.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic','completed') RETURNING id", [patient])).rows[0].id;
  const clinical = (await fixture.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic existing bridge',$2,'synthetic') RETURNING id", [patient, ortho])).rows[0].id;
  const problem = (await fixture.pool.query("INSERT INTO patient_problems(patient_id,case_id,label,specialty,noted_by) VALUES($1,$2,'Synthetic recorded problem','orthodontics','synthetic') RETURNING id", [patient, clinical])).rows[0].id;
  return { patientId: patient, orthoCaseId: ortho, clinicalCaseId: clinical, problemId: problem, session };
}
const assessment = () => ({ ...assessmentCommandV2(), commandId: randomUUID() });
const strategy = (problemId: number): StrategyCommand => ({ schemaVersion: 1, commandId: randomUUID(), expectedRevisionId: null,
  reason: "Synthetic review", rows: [{ problemId, objective: "Synthetic objective", strategy: "Doctor-authored strategy", rationale: null, planItemIds: [] }] });
const financial = async () => (await fixture.pool.query(`SELECT
  (SELECT COUNT(*)::int FROM invoices) invoices, (SELECT COUNT(*)::int FROM payments) payments,
  (SELECT COUNT(*)::int FROM expenses) expenses, (SELECT COUNT(*)::int FROM plan_items) items,
  (SELECT COUNT(*)::int FROM visits) visits`)).rows;

describe("existing explicitly linked Ortho episodes in the main/HR/finance union", () => {
  it("appends, reopens and replays schema2 assessment and strategy without financial side effects", async () => {
    const owner = await scope(), before = await financial();
    const a = assessment(), s = strategy(owner.problemId);
    const first = await appendOrthoAssessment({ ...owner, command: a });
    expect(first).toMatchObject({ ok: true, replayed: false, revision: { schemaVersion: 2, version: 1, recordedPatientId: owner.patientId, createdBy: "Synthetic recorder" } });
    const plan = await appendOrthoTreatmentStrategy({ ...owner, command: s });
    expect(plan).toMatchObject({ ok: true, replayed: false, revision: { version: 1, recordedPatientId: owner.patientId } });
    expect(await appendOrthoAssessment({ ...owner, command: a })).toMatchObject({ ok: true, replayed: true });
    expect(await appendOrthoTreatmentStrategy({ ...owner, command: s })).toMatchObject({ ok: true, replayed: true });
    expect(await getOrthoAssessment({ ...owner, acceptedSchemas: [2] })).toMatchObject({ ok: true, state: "ready", history: [{ version: 1 }] });
    expect(await getOrthoTreatmentStrategy(owner)).toMatchObject({ ok: true, state: "ready", history: [{ version: 1 }] });
    expect(await financial()).toEqual(before);
  });

  it("refuses stale heads, conflicting commands, foreign cases and a missing explicit bridge", async () => {
    const owner = await scope(), a = assessment();
    expect(await appendOrthoAssessment({ ...owner, command: a })).toMatchObject({ ok: true });
    expect(await appendOrthoAssessment({ ...owner, command: { ...a, reason: "Different same-command payload" } })).toMatchObject({ ok: false, code: "command_conflict" });
    expect(await appendOrthoAssessment({ ...owner, command: assessment() })).toMatchObject({ ok: false, code: "head_changed" });
    expect(await appendOrthoAssessment({ ...owner, patientId: owner.patientId + 10000, command: assessment() })).toMatchObject({ ok: false });
    const other = (await fixture.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic','completed') RETURNING id", [owner.patientId])).rows[0].id;
    expect(await appendOrthoAssessment({ ...owner, orthoCaseId: other, command: assessment() })).toMatchObject({ ok: false, code: "bridge_missing" });
    expect(await appendOrthoTreatmentStrategy({ ...owner, orthoCaseId: other, command: strategy(owner.problemId) })).toMatchObject({ ok: false, code: "bridge_missing" });
  });

  it("uses explicit versioned clinical fingerprints independent of unrelated nullable schema columns", async () => {
    const owner = await scope();
    const document = (await fixture.pool.query(`INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,ortho_case_id)
      VALUES($1,'imaging','Synthetic record','image/png',1,$2,'synthetic/no-physical-file.png','synthetic',$3) RETURNING id`,
      [owner.patientId, "a".repeat(64), owner.orthoCaseId])).rows[0].id;
    const ceph = await fixture.db.createCephAnalysis({ patientId: owner.patientId, documentId: document, createdBy: "synthetic", orthoCaseId: owner.orthoCaseId, xrayDate: null });
    if (!ceph.ok) throw new Error(ceph.message);
    const cephId = Number(ceph.id); // pg may return the existing BIGSERIAL creator's id as text.
    expect(Number.isSafeInteger(cephId)).toBe(true);
    const history = (await fixture.pool.query("INSERT INTO patient_medical_history(patient_id,recorded_by,notes) VALUES($1,'synthetic','Synthetic history') RETURNING id", [owner.patientId])).rows[0].id;
    const versions = async () => {
      const read = await getOrthoAssessment({ ...owner, acceptedSchemas: [2] });
      if (!read.ok || read.state !== "ready") throw new Error(JSON.stringify(read));
      const selected = read.sources.items.filter(source => source.kind === "ceph_study" && source.id === cephId || source.kind === "patient_history" && source.id === history);
      expect(selected).toHaveLength(2);
      return selected.map(source => ({ kind: source.kind, id: source.id, version: source.version }));
    };
    const before = await versions();
    await fixture.pool.query("ALTER TABLE ceph_analyses ADD COLUMN synthetic_nonclinical_display_tag TEXT");
    await fixture.pool.query("ALTER TABLE patient_medical_history ADD COLUMN synthetic_nonclinical_display_tag TEXT");
    expect(await versions()).toEqual(before);
    await fixture.pool.query("UPDATE ceph_analyses SET note='Different synthetic clinical note' WHERE id=$1", [cephId]);
    expect((await versions()).find(source => source.kind === "ceph_study")?.version).not.toBe(before.find(source => source.kind === "ceph_study")?.version);
  });

  it.each(["assessment", "strategy"])("rolls back %s and its command witness when audit insertion is rejected, then retries exactly", async kind => {
    const owner = await scope(), command = kind === "assessment" ? assessment() : strategy(owner.problemId);
    const append = () => kind === "assessment" ? appendOrthoAssessment({ ...owner, command }) : appendOrthoTreatmentStrategy({ ...owner, command });
    const table = kind === "assessment" ? "ortho_assessment_revisions" : "ortho_strategy_revisions";
    const auditAction = kind === "assessment" ? "ortho.assessment.append" : "ortho.strategy_revision";
    const count = async () => (await fixture.pool.query(`SELECT COUNT(*)::int count FROM ${table} WHERE ortho_case_id=$1`, [owner.orthoCaseId])).rows[0].count;
    await fixture.pool.query(`CREATE FUNCTION synthetic_reject_ortho_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='${auditAction}' THEN RAISE EXCEPTION 'synthetic Ortho audit rejection'; END IF; RETURN NEW; END $$`);
    await fixture.pool.query("CREATE TRIGGER synthetic_reject_ortho_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_reject_ortho_audit()");
    try { await expect(append()).rejects.toThrow("synthetic Ortho audit rejection"); }
    finally { await fixture.pool.query("DROP TRIGGER synthetic_reject_ortho_audit ON audit_log"); await fixture.pool.query("DROP FUNCTION synthetic_reject_ortho_audit()"); }
    expect(await count()).toBe(0);
    expect(await append()).toMatchObject({ ok: true, replayed: false });
    expect(await append()).toMatchObject({ ok: true, replayed: true });
    expect(await count()).toBe(1);
  });

  it.each(["assessment", "strategy"])("revalidates account activity after waiting for the patient in %s", async kind => {
    const owner = await scope(), blocker = await fixture.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [owner.patientId]);
    const append = kind === "assessment" ? appendOrthoAssessment({ ...owner, command: assessment() }) : appendOrthoTreatmentStrategy({ ...owner, command: strategy(owner.problemId) });
    try {
      await expect.poll(async () => (await fixture.pool.query(`SELECT COUNT(*)::int count FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM patients WHERE id =%'`)).rows[0].count).toBeGreaterThan(0);
      await fixture.pool.query("UPDATE users SET is_active=false WHERE id=$1", [owner.session.userId]);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect(await append).toMatchObject({ ok: false, code: "session_expired" });
    const table = kind === "assessment" ? "ortho_assessment_revisions" : "ortho_strategy_revisions";
    expect((await fixture.pool.query(`SELECT COUNT(*)::int count FROM ${table} WHERE ortho_case_id=$1`, [owner.orthoCaseId])).rows[0].count).toBe(0);
  });

  it("preserves immutable recorded patient provenance and command replay through the canonical patient merge", async () => {
    const owner = await scope(), a = assessment(), s = strategy(owner.problemId);
    const first = await appendOrthoAssessment({ ...owner, command: a });
    if (!first.ok) throw new Error(first.message);
    expect(await appendOrthoTreatmentStrategy({ ...owner, command: s })).toMatchObject({ ok: true });
    const target = (await fixture.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic canonical target') RETURNING id", [`SYN-MERGE-${++sequence}`])).rows[0].id;
    expect(await fixture.db.mergeDuplicatePatient(owner.patientId, target, { actor: "Synthetic recorder", actorRole: "admin", reason: "Synthetic duplicate reconciliation" })).toMatchObject({ ok: true });
    const moved = { ...owner, patientId: target };
    expect(await appendOrthoAssessment({ ...moved, command: a })).toMatchObject({ ok: true, replayed: true, revision: { patientId: target, recordedPatientId: owner.patientId } });
    expect(await appendOrthoTreatmentStrategy({ ...moved, command: s })).toMatchObject({ ok: true, replayed: true, revision: { patientId: target, recordedPatientId: owner.patientId } });
    expect(await appendOrthoAssessment({ ...owner, command: a })).toMatchObject({ ok: false });
    const correction = assessment(); correction.expectedRevisionId = first.revision.id;
    expect(await appendOrthoAssessment({ ...moved, command: correction })).toMatchObject({ ok: true, replayed: false, revision: { recordedPatientId: target, version: 2 } });
    expect((await fixture.pool.query("SELECT patient_id,recorded_patient_id,content_sha256 FROM ortho_assessment_revisions WHERE id=$1", [first.revision.id])).rows[0]).toEqual({ patient_id: target, recorded_patient_id: owner.patientId, content_sha256: first.revision.contentHash });
  });

  it("rejects a forged copied-observation witness and retains the exact documented source", async () => {
    const owner = await scope(), original = assessment();
    const first = await appendOrthoAssessment({ ...owner, command: original });
    if (!first.ok) throw new Error(first.message);
    const copied = assessment(); copied.expectedRevisionId = first.revision.id;
    const observation = copied.content.observations.observations[0];
    observation.provenance!.sources = [{ kind: "assessment_revision", id: first.revision.id, version: `sha256:${first.revision.contentHash}` }];
    observation.provenance!.copiedFrom = { kind: "observation_v2", revisionId: first.revision.id, contentHash: "0".repeat(64), observationId: observation.id };
    expect(await appendOrthoAssessment({ ...owner, command: copied })).toMatchObject({ ok: false });
    observation.provenance!.copiedFrom.contentHash = first.revision.contentHash;
    expect(await appendOrthoAssessment({ ...owner, command: copied })).toMatchObject({ ok: true, revision: { version: 2 } });
    expect((await fixture.pool.query("SELECT content_sha256 FROM ortho_assessment_revisions WHERE id=$1", [first.revision.id])).rows[0].content_sha256).toBe(first.revision.contentHash);
  });

  it.each(["assessment", "strategy"])("refuses a session that expires during the %s patient lock wait", async kind => {
    const owner = await scope(), blocker = await fixture.pool.connect();
    owner.session.expiresAt = Date.now() + 250; request.token = createSessionToken(owner.session);
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [owner.patientId]);
    const append = kind === "assessment" ? appendOrthoAssessment({ ...owner, command: assessment() }) : appendOrthoTreatmentStrategy({ ...owner, command: strategy(owner.problemId) });
    try { await expect.poll(() => Date.now()).toBeGreaterThan(owner.session.expiresAt); }
    finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect(await append).toMatchObject({ ok: false, code: "session_expired" });
  });

  it.each(["assessment", "strategy"])("rechecks the doctor's actual patient witness after a %s lock wait", async kind => {
    const owner = await scope();
    const party = (await fixture.pool.query("INSERT INTO parties(name,kind) VALUES('Synthetic scope doctor','doctor') RETURNING id")).rows[0].id;
    await fixture.pool.query("UPDATE users SET role='doctor',party_id=$2 WHERE id=$1", [owner.session.userId, party]);
    await fixture.pool.query("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [owner.patientId, party]);
    owner.session.role = "doctor"; owner.session.partyId = party; request.token = createSessionToken(owner.session);
    const blocker = await fixture.pool.connect(); await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [owner.patientId]);
    const append = kind === "assessment" ? appendOrthoAssessment({ ...owner, command: assessment() }) : appendOrthoTreatmentStrategy({ ...owner, command: strategy(owner.problemId) });
    try {
      await expect.poll(async () => (await fixture.pool.query(`SELECT COUNT(*)::int count FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM patients WHERE id =%'`)).rows[0].count).toBeGreaterThan(0);
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [owner.patientId]);
      await blocker.query("COMMIT");
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect(await append).toMatchObject({ ok: false, code: "patient_access_denied" });
  });
});
