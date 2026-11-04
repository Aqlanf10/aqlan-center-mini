import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { appendOrthoRetentionEvent, getOrthoRetentionEvents } from "../../lib/ortho-retention-event-store";
import { getOrthoCaseStudy, saveOrthoCaseStudy } from "../../lib/ortho-case-study-store";
import { getOrthoStudyPanelReview } from "../../lib/ortho-case-study-review-store";
import { getOrthoStudySourceChoices } from "../../lib/ortho-case-study-inventory";
import { captureAssessmentExternalSources } from "../../lib/ortho-assessment-versioned-sources";
import { CASE_TEMPLATE_VERSION } from "../../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../../lib/ortho-case-study-template";
import { verifyRetentionRead, verifyRetentionSaved } from "../../lib/ortho-retention-client";
import { ORTHO_CASE_JOURNEY_SQL } from "../../lib/ortho-case-journey-schema";
import type { StudySaveCommand } from "../../lib/ortho-case-study";
import type { RetentionEventCommand } from "../../lib/ortho-retention-events";

const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let session: SessionPayload;
beforeAll(async () => {
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  await fixture.db.ensureSchema();
  const password = "synthetic-journey-credential-not-a-real-password";
  const user = (await fixture.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-journey','Synthetic recorder',$1,'admin') RETURNING id", [password])).rows[0];
  session = { userId: user.id, username: "synthetic-journey", role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600_000 };
  request.token = createSessionToken(session);
});
afterAll(async () => { await fixture?.close(); });
async function scope(status = "retention") {
  const patientId = (await fixture.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic journey') RETURNING id", [randomUUID()])).rows[0].id;
  const orthoCaseId = (await fixture.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic',$2) RETURNING id", [patientId, status])).rows[0].id;
  const clinicalCaseId = (await fixture.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id;
  return { patientId, orthoCaseId, clinicalCaseId, session };
}
const device = (): RetentionEventCommand => ({ schemaVersion: 1, clientRequestId: randomUUID(), expectedHeadId: null, reason: "Synthetic delivery documentation", arch: "upper", supersedesEntryId: null, archCorrectionReason: null,
  content: { kind: "device_delivery", occurrence: { occurredOn: null, dateProvenance: "unknown", sourceNote: "Legacy date unknown" }, note: "", documentIds: [], deviceType: "fixed", description: "Synthetic fixed device", extent: "Upper arch", labOrderId: null } });
const study = (): StudySaveCommand => ({ schemaVersion: 1, clientRequestId: randomUUID(), expectedHead: null, baseDocumentedRevision: null, kind: "draft", documentedFrom: null, reason: "Synthetic saved presentation",
  content: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH }, identityDisclosure: "case_only", sources: [], groups: [], mediaUses: [], comment: "Synthetic physician comment",
    panels: [{ instanceId: "interview1", layoutKey: "interview", included: true, state: "not_recorded", sourceKeys: [], images: [], comment: "Missing findings remain explicit" }] } });
const money = async () => (await fixture.pool.query("SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM patient_opening_balances) opening,(SELECT count(*)::int FROM visits) visits")).rows;

describe("integrated case records on actual PostgreSQL", () => {
  it("registers the exact additive migration and creates no clinical records", async () => {
    expect(readFileSync("migrations/0100_ortho_case_journey.sql", "utf8")).toBe(ORTHO_CASE_JOURNEY_SQL);
    const rows = (await fixture.pool.query("SELECT name,checksum,adopted FROM schema_migrations WHERE version='0100'")).rows;
    expect(rows).toEqual([{ name: "ortho_case_journey", checksum: createHash("sha256").update(ORTHO_CASE_JOURNEY_SQL).digest("hex"), adopted: false }]);
    expect((await fixture.pool.query("SELECT count(*)::int n FROM ortho_retention_entries")).rows[0].n).toBe(0);
  });
  it("records two independent devices, replays once, preserves unknown dates and money", async () => {
    const owner = await scope(), before = await money(), command = device();
    const first = await appendOrthoRetentionEvent({ ...owner, command }); expect(first.ok).toBe(true); if (!first.ok) throw Error(first.code);
    // Exercise the actual browser decoder against serialized PostgreSQL output,
    // including the expanded JourneyOwner passed through the persistence layer.
    await expect(verifyRetentionSaved(JSON.parse(JSON.stringify(first)), { scope: owner, actorId: session.userId!, previousVersion: 0, command }, 201)).resolves.toMatchObject({ ok: true });
    expect(await appendOrthoRetentionEvent({ ...owner, command })).toMatchObject({ ok: true, replayed: true, revision: { id: first.revision.id } });
    const lower = device(); lower.arch = "lower"; lower.expectedHeadId = first.revision.id;
    expect(await appendOrthoRetentionEvent({ ...owner, command: lower })).toMatchObject({ ok: true });
    const read = await getOrthoRetentionEvents(owner); expect(read.ok).toBe(true); if (!read.ok) throw Error(read.code);
    await expect(verifyRetentionRead(JSON.parse(JSON.stringify(read)), owner)).resolves.toMatchObject({ ok: true });
    expect(read.devices.map(d => d.arch).sort()).toEqual(["lower", "upper"]);
    expect(read.devices.every(d => d.intervalStart === null)).toBe(true);
    expect(read.history).toHaveLength(2); expect(await money()).toEqual(before);
    await expect(fixture.pool.query("UPDATE ortho_retention_entries SET reason='overwritten' WHERE id=$1", [first.revision.id])).rejects.toThrow("append-only");
  });
  it("serializes concurrent stale-head saves and rejects changed reuse of a request key", async () => {
    const owner = await scope(), a = device(), b = device();
    const results = await Promise.all([appendOrthoRetentionEvent({ ...owner, command: a }), appendOrthoRetentionEvent({ ...owner, command: b })]);
    expect(results.filter(r => r.ok)).toHaveLength(1); expect(results.find(r => !r.ok)).toMatchObject({ status: 409, code: "head_changed" });
    const accepted = results[0].ok ? a : b;
    expect(await appendOrthoRetentionEvent({ ...owner, command: { ...accepted, reason: "Changed payload" } })).toMatchObject({ ok: false, status: 409, code: "request_key_conflict" });
  });
  it("rolls back the record when audit fails, and rechecks revoked authority", async () => {
    const owner = await scope();
    await fixture.pool.query("CREATE FUNCTION synthetic_journey_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.journey_record' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_journey_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_journey_audit_fail()");
    try { await expect(appendOrthoRetentionEvent({ ...owner, command: device() })).rejects.toThrow("synthetic audit failure"); }
    finally { await fixture.pool.query("DROP TRIGGER synthetic_journey_audit_fail ON audit_log; DROP FUNCTION synthetic_journey_audit_fail()"); }
    expect(await getOrthoRetentionEvents(owner)).toMatchObject({ ok: true, history: [] });
    await fixture.pool.query("UPDATE users SET is_active=FALSE WHERE id=$1", [session.userId]);
    try { expect(await appendOrthoRetentionEvent({ ...owner, command: device() })).toMatchObject({ ok: false, status: 401 }); }
    finally { await fixture.pool.query("UPDATE users SET is_active=TRUE WHERE id=$1", [session.userId]); }
  });
  it("saves and documents an exact study revision without inventing missing records", async () => {
    const owner = await scope("completed"), before = await money(), command = study();
    const draft = await saveOrthoCaseStudy({ ...owner, command }); expect(draft.ok).toBe(true); if (!draft.ok) throw Error(draft.code);
    expect(await saveOrthoCaseStudy({ ...owner, command })).toMatchObject({ ok: true, replayed: true });
    const ref = { id: draft.revision.id, contentHash: draft.revision.contentHash };
    const recorded = await saveOrthoCaseStudy({ ...owner, command: { ...command, clientRequestId: randomUUID(), kind: "documented", expectedHead: ref, documentedFrom: ref } });
    expect(recorded.ok).toBe(true); if (!recorded.ok) throw Error(recorded.code);
    expect(await getOrthoCaseStudy({ ...owner, revisionId: draft.revision.id })).toMatchObject({ ok: true, revision: { id: draft.revision.id, kind: "draft" } });
    const panel = await getOrthoStudyPanelReview({ ...owner, revisionId: recorded.revision.id, panelId: "interview1" });
    expect(panel).toMatchObject({ ok: true, panelState: "not_recorded", blocks: [], comments: ["Synthetic physician comment", "Missing findings remain explicit"] });
    expect(await money()).toEqual(before);
  });
  it("refuses a foreign patient/case scope without leaking a stored study", async () => {
    const first = await scope(), second = await scope();
    expect(await saveOrthoCaseStudy({ ...first, patientId: second.patientId, command: study() })).toMatchObject({ ok: false, status: 404 });
    expect(await getOrthoRetentionEvents({ ...first, patientId: second.patientId })).toMatchObject({ ok: false, status: 404 });
  });

  it.each([null, 'same'])("captures a real Ortho session with visit case %s without assigning the visit, then refuses a foreign case link", async visitCase => {
    const owner = await scope(), visitId = (await fixture.pool.query("INSERT INTO visits(patient_id,patient_name,status,case_id) VALUES($1,'Synthetic session visit','done',$2) RETURNING id", [owner.patientId, visitCase === null ? null : owner.clinicalCaseId])).rows[0].id;
    const adjustmentId = (await fixture.pool.query("INSERT INTO ortho_adjustments(case_id,visit_id,done,note,recorded_by) VALUES($1,$2,'Synthetic actual procedure','Synthetic session note','synthetic') RETURNING id", [owner.orthoCaseId, visitId])).rows[0].id;
    const before = await money(), choices = await getOrthoStudySourceChoices({ ...owner, kind: 'adjustment' });
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
    expect((await fixture.pool.query('SELECT case_id FROM visits WHERE id=$1', [visitId])).rows[0].case_id).toBe(visitCase === null ? null : owner.clinicalCaseId);
    expect(await money()).toEqual(before);
    const clinicalClient = await fixture.pool.connect();
    try {
      await clinicalClient.query('BEGIN');
      const clinicalSources = await captureAssessmentExternalSources(clinicalClient, owner, [{ kind: 'clinical_visit', id: visitId }], true);
      expect(clinicalSources.has(`clinical_visit:${visitId}`)).toBe(visitCase !== null);
    } finally { await clinicalClient.query('ROLLBACK'); clinicalClient.release(); }
    const otherCase = (await fixture.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES($1,'orthodontics','Synthetic other case','synthetic') RETURNING id", [owner.patientId])).rows[0].id;
    const writer=await fixture.pool.connect();
    await writer.query('BEGIN');
    await writer.query('UPDATE visits SET case_id=$1 WHERE id=$2', [otherCase, visitId]);
    const pending=getOrthoCaseStudy({ ...owner, revisionId: saved.revision.id });
    try {
      await expect.poll(async()=> (await fixture.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM visits WHERE id=ANY%') AS waiting")).rows[0].waiting,{timeout:5000}).toBe(true);
      await writer.query('COMMIT');
      expect(await pending).toMatchObject({ ok: false, status: 403 });
    } finally { await writer.query('ROLLBACK'); writer.release(); await pending; }
  });
});
