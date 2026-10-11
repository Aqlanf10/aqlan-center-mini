import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, hashPassword, sessionCredentialVersion, SESSION_COOKIE, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { CASE_TEMPLATE_VERSION } from "../../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../../lib/ortho-case-study-template";
import type { OpenAssessmentCommand, ActivateAssessmentCommand } from "../../lib/ortho-assessment-lifecycle";

// Only cookie transport is substituted. All authority, row locks, clinical and
// finance tables, audit and rollback use a fresh owned PostgreSQL 18 database.
const transport = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === SESSION_COOKIE ? { value: transport.token } : undefined }), headers: async () => ({ get: () => null }) }));
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let lifecycle: typeof import("../../lib/ortho-assessment-lifecycle-store");
let study: typeof import("../../lib/ortho-case-study-store");
let session: SessionPayload, patientId: number, actorId: number, username: string, passwordHash: string;
const key = () => `synthetic_${randomUUID().replaceAll("-", "")}`;
const open = (): OpenAssessmentCommand => ({ schemaVersion: 1, kind: "open_assessment", commandId: key(), patientId, bridge: { mode: "new" }, intakeKind: "new", reason: "Synthetic connected intake" });
const financialCounts = async () => (await fixture.pool.query(`SELECT
 (SELECT count(*)::int FROM invoices) invoices, (SELECT count(*)::int FROM payments) payments,
 (SELECT count(*)::int FROM treatment_plans) plans, (SELECT count(*)::int FROM plan_installments) installments`)).rows[0];
async function opened(command = open()) {
  const result = await lifecycle.recordOrthoLifecycle({ patientId, session, command });
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.code);
  return result.event;
}
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-connected-union-only-2026");
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  await fixture.db.ensureSchema(); // composed bootstrap, no test-only ortho SQL
  username = key(); passwordHash = await hashPassword(key());
  actorId = (await fixture.pool.query("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES($1,'Synthetic union actor',$2,'admin',true) RETURNING id", [username, passwordHash])).rows[0].id;
  lifecycle = await import("../../lib/ortho-assessment-lifecycle-store");
  study = await import("../../lib/ortho-case-study-store");
}, 180_000);
beforeEach(async () => {
  await fixture.pool.query("UPDATE users SET is_active=true WHERE id=$1", [actorId]);
  transport.token = createSessionToken({ userId: actorId, username, role: "admin", expiresAt: Date.now() + 600_000, credentialVersion: sessionCredentialVersion(passwordHash) });
  const current = await (await import("../../lib/session")).requireSession();
  if (!current) throw new Error("Synthetic session unavailable"); session = current;
  patientId = (await fixture.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic union patient') RETURNING id", [key()])).rows[0].id;
});
afterAll(async () => { transport.token = ""; try { await fixture?.close(); } finally { vi.unstubAllEnvs(); } });

describe("connected ortho union", () => {
  it("opens, saves and reloads a study before treatment; exact concurrent retries create one case and no finance", async () => {
    const before = await financialCounts(), command = open();
    const results = await Promise.all([1, 2].map(() => lifecycle.recordOrthoLifecycle({ patientId, session, command })));
    expect(results.map(result => result.ok && result.replayed).sort()).toEqual([false, true]);
    const event = await opened(command), scope = { patientId, orthoCaseId: event.orthoCaseId, session };
    const row = (await fixture.pool.query("SELECT status,start_date,appliance,phase,planned_months,plan_id FROM ortho_cases WHERE id=$1", [event.orthoCaseId])).rows[0];
    expect(row).toEqual({ status: "assessment", start_date: null, appliance: null, phase: null, planned_months: null, plan_id: null });
    const save = { schemaVersion: 1, clientRequestId: key(), expectedHead: null, baseDocumentedRevision: null, kind: "draft", documentedFrom: null, reason: "Synthetic study, no export dependency",
      content: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH }, identityDisclosure: "case_only", sources: [], groups: [], panels: [], mediaUses: [], comment: "Preserved synthetic complaint" } };
    expect(await study.saveOrthoCaseStudy({ ...scope, command: save })).toMatchObject({ ok: true, replayed: false });
    expect(await study.saveOrthoCaseStudy({ ...scope, command: save })).toMatchObject({ ok: true, replayed: true });
    const read = await study.getOrthoCaseStudy(scope);
    expect(read.ok).toBe(true); if (!read.ok) throw new Error(read.code);
    expect(read.history).toHaveLength(1); expect(read.revision?.content.authored.comment).toBe(save.content.comment);
    expect((await fixture.pool.query("SELECT count(*)::int n FROM ortho_cases WHERE patient_id=$1", [patientId])).rows[0].n).toBe(1);
    expect((await fixture.pool.query("SELECT count(*)::int n FROM clinical_cases WHERE patient_id=$1", [patientId])).rows[0].n).toBe(1);
    expect(await financialCounts()).toEqual(before);
  });
  it("records an explicitly unknown treatment start and duration without substituting episode or entry dates", async () => {
    const before = await financialCounts(), event = await opened({ ...open(), intakeKind: "transferred" });
    const command: ActivateAssessmentCommand = { schemaVersion: 1, kind: "activate_assessment", commandId: key(), patientId, orthoCaseId: event.orthoCaseId, clinicalCaseId: event.clinicalCaseId, expectedLifecycleVersion: 1, reason: "Synthetic transferred treatment evidence",
      treatment: { appliance: "fixed_metal", arches: "both", slot: null, bracketSystem: null, phase: "working", start: { state: "unknown", reason: "No historical start record supplied" }, plannedMonths: null }, financialPlan: null };
    expect(await lifecycle.recordOrthoLifecycle({ patientId, session, command })).toMatchObject({ ok: true, replayed: false });
    expect(await lifecycle.recordOrthoLifecycle({ patientId, session, command })).toMatchObject({ ok: true, replayed: true });
    const cases = await fixture.db.listPatientOrthoCases(patientId, "2026-10-11");
    expect(cases).toHaveLength(1); expect(cases[0]).toMatchObject({ status: "active", startDate: null, plannedMonths: null, phase: "working", slot: null, progress: { monthsElapsed: null, monthsRemaining: null, percent: null } });
    const read = await lifecycle.readOrthoLifecycle({ patientId, session });
    expect(read).toMatchObject({ ok: true, history: [{ kind: "assessment_opened" }, { kind: "assessment_activated" }] });
    expect(await financialCounts()).toEqual(before);
  });
  it("rechecks a revoked actor inside the transaction after the request waits for the patient lock", async () => {
    const holder = await fixture.pool.connect();
    let pending: ReturnType<typeof lifecycle.recordOrthoLifecycle> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      await holder.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [patientId]);
      pending = lifecycle.recordOrthoLifecycle({ patientId, session, command: open() });
      await vi.waitFor(async () => {
        const blocked = await fixture.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM patients%'", [pid]);
        expect(blocked.rows.length).toBeGreaterThan(0);
      }, { timeout: 10_000, interval: 20 });
      await fixture.pool.query("UPDATE users SET is_active=false WHERE id=$1", [actorId]);
      await holder.query("COMMIT");
      expect(await pending).toMatchObject({ ok: false, status: 401 });
      expect((await fixture.pool.query("SELECT count(*)::int n FROM ortho_cases WHERE patient_id=$1", [patientId])).rows[0].n).toBe(0);
    } finally { await holder.query("ROLLBACK"); holder.release(); await pending?.catch(() => undefined); }
  });
  it("rejects a stale actor and a cross-patient command before creating any identity", async () => {
    const command = open();
    expect(await lifecycle.recordOrthoLifecycle({ patientId, session: { ...session, userId: actorId + 1000 }, command })).toMatchObject({ ok: false, status: 401 });
    expect(await lifecycle.recordOrthoLifecycle({ patientId, session, command: { ...command, patientId: patientId + 1000 } })).toMatchObject({ ok: false, status: 409, code: "scope_changed" });
    expect((await fixture.pool.query("SELECT count(*)::int n FROM ortho_cases WHERE patient_id=$1", [patientId])).rows[0].n).toBe(0);
  });
  it("rolls back case, bridge and lifecycle event on audit failure, then retries the same command once", async () => {
    const command = open(), before = await financialCounts();
    await fixture.pool.query(`CREATE FUNCTION synthetic_union_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic union audit failure'; END $$;
      CREATE TRIGGER synthetic_union_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_union_audit_failure()`);
    try {
      await expect(lifecycle.recordOrthoLifecycle({ patientId, session, command })).rejects.toThrow("synthetic union audit failure");
      for (const table of ["ortho_cases", "clinical_cases", "ortho_case_lifecycle_events"]) expect((await fixture.pool.query(`SELECT count(*)::int n FROM ${table} WHERE patient_id=$1`, [patientId])).rows[0].n).toBe(0);
      expect(await financialCounts()).toEqual(before);
    } finally { await fixture.pool.query("DROP TRIGGER synthetic_union_audit_failure ON audit_log; DROP FUNCTION synthetic_union_audit_failure()"); }
    await opened(command); expect(await lifecycle.recordOrthoLifecycle({ patientId, session, command })).toMatchObject({ ok: true, replayed: true });
  });
});
