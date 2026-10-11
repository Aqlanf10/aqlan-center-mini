import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, hashPassword, sessionCredentialVersion, SESSION_COOKIE, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { ORTHO_ASSESSMENT_SQL } from "../../lib/ortho-assessment-schema";
import { ORTHO_CASE_JOURNEY_SQL } from "../../lib/ortho-case-journey-schema";
import { CASE_TEMPLATE_VERSION } from "../../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../../lib/ortho-case-study-template";
import type { StudySaveCommand } from "../../lib/ortho-case-study";
import type { RetentionEventCommand } from "../../lib/ortho-retention-events";

// Cookie transport only is synthetic. Current sessions, writers, transactions,
// audit and constraints run on PostgreSQL18 in a newly owned UUID database.
// Candidate SQL is installed only inside this fixture: no migration registration,
// shared bootstrap modification or claim of final composed-schema acceptance.
const transport = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === SESSION_COOKIE ? { value: transport.token } : undefined }),
  headers: async () => ({ get: () => null }),
}));
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let study: typeof import("../../lib/ortho-case-study-store");
let retention: typeof import("../../lib/ortho-retention-event-store");
let session: SessionPayload;
let actor: { id: number; username: string; passwordHash: string };
let scope: { patientId: number; orthoCaseId: number; clinicalCaseId: number };
const key = () => `synthetic_${randomUUID().replaceAll("-", "")}`;
async function counts() {
  return (await fixture.pool.query(`SELECT
    (SELECT count(*)::int FROM invoices) AS invoices,
    (SELECT count(*)::int FROM payments) AS payments,
    (SELECT count(*)::int FROM treatment_plans) AS plans,
    (SELECT count(*)::int FROM plan_installments) AS installments`)).rows[0];
}
function draft(): StudySaveCommand {
  return { schemaVersion: 1, clientRequestId: key(), expectedHead: null, baseDocumentedRevision: null,
    kind: "draft", documentedFrom: null, reason: "Synthetic independent study",
    content: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH },
      identityDisclosure: "case_only", sources: [], groups: [], panels: [], mediaUses: [], comment: "Synthetic preserved narrative" } };
}
function delivery(): RetentionEventCommand {
  return { schemaVersion: 1, clientRequestId: key(), expectedHeadId: null, reason: "Synthetic recorded delivery",
    arch: "upper", supersedesEntryId: null, archCorrectionReason: null,
    content: { kind: "device_delivery", occurrence: { occurredOn: null, dateProvenance: "unknown", sourceNote: "" },
      documentIds: [], note: "", deviceType: "fixed", description: "Synthetic retainer", extent: "13–23", labOrderId: null } };
}
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-independent-ortho-test-session-only");
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  await fixture.db.ensureSchema();
  await fixture.pool.query(ORTHO_ASSESSMENT_SQL);
  await fixture.pool.query(ORTHO_CASE_JOURNEY_SQL);
  const username = key(), passwordHash = await hashPassword(key());
  const { rows: [user] } = await fixture.pool.query<{ id: number }>(
    "INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES($1,'Synthetic Ortho administrator',$2,'admin',true) RETURNING id", [username, passwordHash]);
  actor = { id: user.id, username, passwordHash };
  study = await import("../../lib/ortho-case-study-store");
  retention = await import("../../lib/ortho-retention-event-store");
}, 180_000);
beforeEach(async () => {
  await fixture.pool.query("UPDATE users SET role='admin',is_active=true WHERE id=$1", [actor.id]);
  transport.token = createSessionToken({ userId: actor.id, username: actor.username, role: "admin",
    expiresAt: Date.now() + 600_000, credentialVersion: sessionCredentialVersion(actor.passwordHash) });
  const admitted = await (await import("../../lib/session")).requireSession();
  if (!admitted) throw new Error("Synthetic signed session not admitted"); session = admitted;
  const { rows: [patient] } = await fixture.pool.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic independent Ortho patient') RETURNING id", [key()]);
  const { rows: [ortho] } = await fixture.pool.query<{ id: number }>(`INSERT INTO ortho_cases
    (patient_id,appliance,arches,slot,phase,start_date,planned_months,status,created_by)
    VALUES($1,'fixed_metal','upper','022','retention','2026-01-01',18,'retention','Synthetic fixture') RETURNING id`, [patient.id]);
  const { rows: [bridge] } = await fixture.pool.query<{ id: number }>(`INSERT INTO clinical_cases
    (patient_id,ortho_case_id,specialty,title,created_by)
    VALUES($1,$2,'orthodontics','Synthetic case','Synthetic fixture') RETURNING id`, [patient.id, ortho.id]);
  scope = { patientId: patient.id, orthoCaseId: ortho.id, clinicalCaseId: bridge.id };
});
afterAll(async () => {
  transport.token = "";
  try { await fixture?.close(); } finally { vi.unstubAllEnvs(); }
});

describe("independent study and retention real writers on the approved HR base", () => {
  it("commits and reopens a study, replays its exact command once and creates no financial records", async () => {
    const before = await counts(), command = draft(), input = { ...scope, session, command };
    const first = await study.saveOrthoCaseStudy(input); expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.code);
    expect(first.replayed).toBe(false);
    const replay = await study.saveOrthoCaseStudy(input); expect(replay).toMatchObject({ ok: true, replayed: true, revision: { id: first.revision.id } });
    const read = await study.getOrthoCaseStudy({ ...scope, session });
    expect(read).toMatchObject({ ok: true, revision: { content: { authored: command.content } }, history: [{ id: first.revision.id }] });
    expect(await counts()).toEqual(before);
  });
  it("serializes concurrent delivery retries into one physical device and one audit record", async () => {
    const before = await counts(), command = delivery();
    const results = await Promise.all([1, 2].map(() => retention.appendOrthoRetentionEvent({ ...scope, session, command })));
    expect(results.every(r => r.ok)).toBe(true);
    expect(results.filter(r => r.ok && r.replayed)).toHaveLength(1);
    const read = await retention.getOrthoRetentionEvents({ ...scope, session });
    expect(read.ok).toBe(true); if (!read.ok) throw new Error(read.code);
    expect(read.history).toHaveLength(1); expect(read.devices).toHaveLength(1);
    expect(read.devices[0]).toMatchObject({ currentState: "ambiguous", intervalStart: null });
    expect(await counts()).toEqual(before);
    const { rows: [audit] } = await fixture.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE action='ortho.journey_record' AND entity='ortho_retention_entries' AND entity_id=$1", [String(read.revision!.id)]);
    expect(audit.count).toBe(1);
  });
  it("rejects an altered same-key command and leaves the original study intact", async () => {
    const command = draft(); expect((await study.saveOrthoCaseStudy({ ...scope, session, command })).ok).toBe(true);
    const before = await study.getOrthoCaseStudy({ ...scope, session });
    const refused = await study.saveOrthoCaseStudy({ ...scope, session, command: { ...command, reason: "Changed synthetic request" } });
    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect(await study.getOrthoCaseStudy({ ...scope, session })).toEqual(before);
  });
  it("rolls back the device and its command when the real audit insert fails, then retries once", async () => {
    const before = await counts(), command = delivery();
    await fixture.pool.query(`CREATE FUNCTION synthetic_refuse_ortho_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
      CREATE TRIGGER synthetic_refuse_ortho_audit BEFORE INSERT ON audit_log
      FOR EACH ROW WHEN (NEW.action='ortho.journey_record') EXECUTE FUNCTION synthetic_refuse_ortho_audit()`);
    try {
      await expect(retention.appendOrthoRetentionEvent({ ...scope, session, command })).rejects.toThrow("synthetic audit failure");
      expect(await retention.getOrthoRetentionEvents({ ...scope, session })).toMatchObject({ ok: true, revision: null, history: [], devices: [] });
      expect(await counts()).toEqual(before);
    } finally {
      await fixture.pool.query("DROP TRIGGER synthetic_refuse_ortho_audit ON audit_log; DROP FUNCTION synthetic_refuse_ortho_audit()");
    }
    expect(await retention.appendOrthoRetentionEvent({ ...scope, session, command })).toMatchObject({ ok: true, replayed: false });
    expect(await retention.appendOrthoRetentionEvent({ ...scope, session, command })).toMatchObject({ ok: true, replayed: true });
    expect((await fixture.pool.query("SELECT count(*)::int AS count FROM ortho_retention_entries WHERE ortho_case_id=$1", [scope.orthoCaseId])).rows[0].count).toBe(1);
  });
  it("refuses actor impersonation and revoked current authority despite an earlier admitted session", async () => {
    const command = draft();
    expect(await study.saveOrthoCaseStudy({ ...scope, session: { ...session, userId: actor.id + 1000 }, command })).toMatchObject({ ok: false, status: 401 });
    await fixture.pool.query("UPDATE users SET is_active=false WHERE id=$1", [actor.id]);
    expect(await study.saveOrthoCaseStudy({ ...scope, session, command })).toMatchObject({ ok: false, status: 401 });
    const { rows: [count] } = await fixture.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM ortho_case_study_revisions WHERE ortho_case_id=$1", [scope.orthoCaseId]);
    expect(count.count).toBe(0);
  });
  it("rejects a foreign patient/case binding before any study or financial mutation", async () => {
    const before = await counts();
    const { rows: [other] } = await fixture.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic foreign case owner') RETURNING id", [key()]);
    expect(await study.saveOrthoCaseStudy({ ...scope, patientId: other.id, session, command: draft() })).toMatchObject({ ok: false, status: 404 });
    expect(await counts()).toEqual(before);
    const read = await study.getOrthoCaseStudy({ ...scope, session }); expect(read).toMatchObject({ ok: true, revision: null, history: [] });
  });
});
