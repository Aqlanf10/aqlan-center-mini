import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { getOrthoRetentionTransition, startOrthoRetention } from "../../lib/ortho-retention-transition-store";
import { readRetentionTransitionRead, type RetentionTransitionCommand } from "../../lib/ortho-retention-transition";
import { verifyRetentionTransitionSaved } from "../../lib/ortho-retention-transition-client";
import { ORTHO_RETENTION_TRANSITION_SQL } from "../../lib/ortho-retention-transition-schema";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>>, session: SessionPayload;
beforeAll(async () => {
  fixture = await openPeriodontalFixture(process.env, { pristine: true }); await fixture.db.ensureSchema();
  const password = "synthetic-retention-transition-credential";
  const user = (await fixture.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('transition-admin','Synthetic clinician',$1,'admin') RETURNING id", [password])).rows[0];
  session = { userId: user.id, username: "transition-admin", role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600_000 };
  request.token = createSessionToken(session);
});
afterAll(async () => { await fixture?.close(); });
async function scope(status = "active") {
  const patientId = (await fixture.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic transition') RETURNING id", [randomUUID()])).rows[0].id;
  const orthoCaseId = (await fixture.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status,phase) VALUES($1,'synthetic',$2,'finishing') RETURNING id", [patientId, status])).rows[0].id;
  const clinicalCaseId = (await fixture.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id;
  return { patientId, orthoCaseId, clinicalCaseId, session };
}
const command = (): RetentionTransitionCommand => ({ schemaVersion: 1, clientRequestId: randomUUID(), expectedPhase: "finishing", confirmed: true,
  reason: "Synthetic explicit decision", retentionPlan: "Clinician's synthetic follow-up plan", occurrence: { occurredOn: null, dateProvenance: "unknown", sourceNote: "No original date available" } });
const unrelated = async () => (await fixture.pool.query(`SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,
 (SELECT count(*)::int FROM patient_opening_balances) opening,(SELECT count(*)::int FROM visits) visits,(SELECT count(*)::int FROM appointments) appointments,
 (SELECT count(*)::int FROM ortho_retention_entries) devices`)).rows;
const state = async (id: number) => (await fixture.pool.query("SELECT status,phase,retainer,retainer_on,closed_at,closed_by,closed_note FROM ortho_cases WHERE id=$1", [id])).rows[0];
describe("explicit transition on PostgreSQL 18", () => {
  it("registers identical runtime/CLI bytes without inferring any decisions", async () => {
    expect(readFileSync("migrations/0101_ortho_retention_transition.sql", "utf8")).toBe(ORTHO_RETENTION_TRANSITION_SQL);
    expect((await fixture.pool.query("SELECT checksum,adopted FROM schema_migrations WHERE version='0101'")).rows).toEqual([{ checksum: createHash("sha256").update(ORTHO_RETENTION_TRANSITION_SQL).digest("hex"), adopted: false }]);
    expect((await fixture.pool.query("SELECT count(*)::int n FROM ortho_retention_transitions")).rows[0].n).toBe(0);
  });
  it("moves to retention exactly once, preserves unknown dates and keeps follow-up open", async () => {
    const owner = await scope(), cmd = command(), before = await unrelated();
    const initial = await getOrthoRetentionTransition(owner); expect(initial).toMatchObject({ ok: true, canTransition: true, transition: null });
    expect(readRetentionTransitionRead(JSON.parse(JSON.stringify(initial)), owner)).toEqual(initial);
    const saved = await startOrthoRetention({ ...owner, command: cmd }); expect(saved.ok).toBe(true); if (!saved.ok) throw Error(saved.code);
    await expect(verifyRetentionTransitionSaved(JSON.parse(JSON.stringify(saved)), { ...owner, actorId: session.userId!, command: cmd }, 201)).resolves.toEqual(saved.transition);
    expect(await state(owner.orthoCaseId)).toEqual({ status: "retention", phase: "retention", retainer: null, retainer_on: null, closed_at: null, closed_by: null, closed_note: null });
    expect((await fixture.pool.query("SELECT status,completed_at FROM clinical_cases WHERE id=$1", [owner.clinicalCaseId])).rows[0]).toEqual({ status: "active", completed_at: null });
    expect(await startOrthoRetention({ ...owner, command: cmd })).toMatchObject({ ok: true, replayed: true, transition: saved.transition });
    expect(await startOrthoRetention({ ...owner, command: { ...cmd, reason: "Changed" } })).toMatchObject({ ok: false, status: 409, code: "request_key_conflict" });
    expect(await unrelated()).toEqual(before);
    expect((await fixture.pool.query("SELECT count(*)::int n FROM audit_log WHERE action='ortho.retention_transition' AND entity_id=$1", [saved.transition.id])).rows[0].n).toBe(1);
    await expect(fixture.pool.query("UPDATE ortho_retention_transitions SET reason='overwritten' WHERE id=$1", [saved.transition.id])).rejects.toThrow("append-only");
    await fixture.pool.query("UPDATE ortho_cases SET status='completed',closed_at=now() WHERE id=$1", [owner.orthoCaseId]);
    expect(await startOrthoRetention({ ...owner, command: cmd })).toMatchObject({ ok: true, replayed: true });
    expect((await state(owner.orthoCaseId)).status).toBe("completed");
  });
  it("serializes competing decisions, allowing exactly one transition and audit", async () => {
    const owner = await scope();
    const results = await Promise.all([startOrthoRetention({ ...owner, command: command() }), startOrthoRetention({ ...owner, command: command() })]);
    expect(results.filter(r => r.ok)).toHaveLength(1); expect(results.find(r => !r.ok)).toMatchObject({ status: 409, code: "retention_transition_exists" });
    expect((await fixture.pool.query("SELECT count(*)::int n FROM ortho_retention_transitions WHERE ortho_case_id=$1", [owner.orthoCaseId])).rows[0].n).toBe(1);
  });
  it("refuses stale phase, closed case/bridge, future date and foreign scope without writes", async () => {
    const owner = await scope(), foreign = await scope();
    expect(await startOrthoRetention({ ...owner, command: { ...command(), expectedPhase: "working" } })).toMatchObject({ ok: false, status: 409 });
    expect(await startOrthoRetention({ ...owner, patientId: foreign.patientId, command: command() })).toMatchObject({ ok: false, status: 404 });
    expect(await startOrthoRetention({ ...owner, command: { ...command(), occurrence: { occurredOn: "2999-01-01", dateProvenance: "retrospective_record", sourceNote: "Synthetic" } } })).toMatchObject({ ok: false, status: 400 });
    await fixture.pool.query("UPDATE clinical_cases SET status='closed',completed_at=now() WHERE id=$1", [owner.clinicalCaseId]);
    expect(await startOrthoRetention({ ...owner, command: command() })).toMatchObject({ ok: false, status: 409 });
    const closed = await scope("completed"); expect(await startOrthoRetention({ ...closed, command: command() })).toMatchObject({ ok: false, status: 409 });
    expect((await state(owner.orthoCaseId)).status).toBe("active");
  });
  it("permits the current clinician without financial permissions and refuses reception writes", async () => {
    const password = "synthetic-transition-doctor-credential";
    const user = (await fixture.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES('transition-doctor','Synthetic doctor',$1,'doctor',$2) RETURNING id", [password, JSON.stringify({ canViewAllPatients: true, canViewPlans: false, canEditPlans: false })])).rows[0];
    const doctor: SessionPayload = { userId: user.id, username: "transition-doctor", role: "doctor", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600_000 };
    const owner = await scope();
    request.token = createSessionToken(doctor);
    try {
      expect(await startOrthoRetention({ ...owner, session: doctor, command: { ...command(), occurrence: { occurredOn: "2024-02-29", dateProvenance: "historical_source", sourceNote: "Synthetic historic record" } } })).toMatchObject({ ok: true, transition: { actorId: doctor.userId, command: { occurrence: { occurredOn: "2024-02-29" } } } });
      await fixture.pool.query("UPDATE users SET role='reception' WHERE id=$1", [user.id]);
      const reception: SessionPayload = { ...doctor, role: "reception" };
      request.token = createSessionToken(reception);
      expect(await startOrthoRetention({ ...owner, session: reception, command: command() })).toMatchObject({ ok: false, status: 403 });
    } finally { request.token = createSessionToken(session); }
  });
  it("rolls back both case state and record when audit fails", async () => {
    const owner = await scope();
    await fixture.pool.query("CREATE FUNCTION synthetic_transition_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.retention_transition' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_transition_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_transition_audit_fail()");
    try { await expect(startOrthoRetention({ ...owner, command: command() })).rejects.toThrow("synthetic audit failure"); }
    finally { await fixture.pool.query("DROP TRIGGER synthetic_transition_audit_fail ON audit_log; DROP FUNCTION synthetic_transition_audit_fail()"); }
    expect(await getOrthoRetentionTransition(owner)).toMatchObject({ ok: true, canTransition: true, transition: null });
    expect((await state(owner.orthoCaseId)).status).toBe("active");
  });
  it("rechecks credential revocation and prevents cross-patient parent drift", async () => {
    const owner = await scope(), foreign = await scope();
    await fixture.pool.query("UPDATE users SET is_active=FALSE WHERE id=$1", [session.userId]);
    try { expect(await startOrthoRetention({ ...owner, command: command() })).toMatchObject({ ok: false, status: 401 }); }
    finally { await fixture.pool.query("UPDATE users SET is_active=TRUE WHERE id=$1", [session.userId]); }
    expect(await startOrthoRetention({ ...owner, command: command() })).toMatchObject({ ok: true });
    await expect(fixture.pool.query("UPDATE ortho_cases SET patient_id=$1 WHERE id=$2", [foreign.patientId, owner.orthoCaseId])).rejects.toThrow();
    await expect(fixture.pool.query("UPDATE clinical_cases SET patient_id=$1 WHERE id=$2", [foreign.patientId, owner.clinicalCaseId])).rejects.toThrow();
  });
});
