import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { tanakaCommandV2 } from "../fixtures/ortho-assessment-tanaka";
import { appendOrthoAssessment } from "../../lib/ortho-assessment-store";
import { appendOrthoTreatmentStrategy } from "../../lib/ortho-treatment-strategy-store";
import { getOrthoSpaceLedger, appendOrthoSpaceEntry } from "../../lib/ortho-space-store";
import { readFile } from "node:fs/promises";
import { ORTHO_SPACE_SQL } from "../../lib/ortho-space-schema";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, n = 0;
beforeAll(async () => { vi.stubEnv("SESSION_SECRET", "synthetic-tanaka-review-secret-at-least32characters"); f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema(); });
afterAll(async () => { try { await f?.close(); } finally { vi.unstubAllEnvs(); } });
async function setup() {
  const seq = ++n, password = "Synthetic credential";
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic mixed analysis') RETURNING id", [`SYN-TANAKA-${seq}`])).rows[0].id;
  const userId = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic examiner',$2,'admin') RETURNING id", [`synthetic-tanaka-${seq}`, password])).rows[0].id;
  const session: SessionPayload = { userId, username: `synthetic-tanaka-${seq}`, role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 600000 };
  request.token = createSessionToken(session);
  const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by) VALUES($1,'assessment','assessment',NULL,NULL,NULL,NULL,NULL,'synthetic') RETURNING id", [patientId])).rows[0].id;
  const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic mixed analysis bridge',$2,'synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id;
  return { patientId, orthoCaseId, clinicalCaseId, session };
}
async function prepared() {
  const scope = await setup();
  const a = await appendOrthoAssessment({ ...scope, command: { ...tanakaCommandV2(), commandId: randomUUID() } }); if (!a.ok) throw Error(a.code);
  const problem = (await f.pool.query("INSERT INTO patient_problems(patient_id,case_id,label,status,noted_by) VALUES($1,$2,'Synthetic space problem','active','synthetic') RETURNING id", [scope.patientId, scope.clinicalCaseId])).rows[0].id;
  const s = await appendOrthoTreatmentStrategy({ ...scope, command: { schemaVersion: 1, commandId: randomUUID(), expectedRevisionId: null, reason: "Synthetic planning", rows: [{ problemId: problem, objective: "Synthetic goal", strategy: "Synthetic manual choice", rationale: "Synthetic", planItemIds: [] }] } }); if (!s.ok) throw Error(s.code);
  const r = await getOrthoSpaceLedger(scope); if (!r.ok) throw Error(r.code);
  const baseline = r.choices.baselines.find(b => b.arch === "upper")!.ref;
  const command = { schemaVersion: 1, clientRequestId: randomUUID(), expectedHeadId: null, reason: "Synthetic space plan", content: { kind: "plan", arch: "upper", strategyRevisionId: s.revision.revisionId, baseline,
    gains: [], uses: [], contacts: [{ teeth: [12, 11], plannedUm: 300, budgetGainUm: 300, clinicianLimitUm: 400, note: "Synthetic verified contact" }], rationale: "Synthetic estimate", alternatives: "Synthetic alternatives" } };
  const p = await appendOrthoSpaceEntry({ ...scope, command }); if (!p.ok) throw Error(p.code);
  await f.pool.query("UPDATE ortho_cases SET status='active',phase='aligning',appliance='fixed_metal',arches='both',slot='022',start_date='2026-11-04',planned_months=12 WHERE id=$1", [scope.orthoCaseId]);
  const adjustment = async () => {
    const visit = (await f.pool.query("INSERT INTO visits(patient_id,patient_name,status) VALUES($1,'Synthetic space visit','done') RETURNING id", [scope.patientId])).rows[0].id;
    return (await f.pool.query("INSERT INTO ortho_adjustments(case_id,visit_id,recorded_by) VALUES($1,$2,'Synthetic treating doctor') RETURNING id", [scope.orthoCaseId, visit])).rows[0].id as number;
  };
  return { scope, plan: p, command, adjustment };
}
const perform = (p: Awaited<ReturnType<typeof prepared>>, adjustmentId: number, expectedHeadId: number, performedUm: number | null, extra = {}) => ({ schemaVersion: 1, clientRequestId: randomUUID(), expectedHeadId, reason: "Synthetic actual session documentation", content: { kind: "ipr", arch: "upper", planEntryId: p.plan.revision.id, teeth: [11, 12], adjustmentId, performedUm, measurementNote: "Synthetic direct measurement", supersedesEntryId: null, reviewReason: null, ...extra } });
describe("linked documentary space ledger on PostgreSQL", () => {
  it("registers exact runtime SQL", async () => expect(await readFile('migrations/0107_ortho_space_ledger.sql','utf8')).toBe(ORTHO_SPACE_SQL));
  it("reuses the stored analysis and strategy, adds two visits once, corrects one fact, and leaves money and treatment unchanged", async () => {
    const p = await prepared(), one = await p.adjustment(), two = await p.adjustment();
    const before = (await f.pool.query("SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM visits) visits")).rows;
    const c1 = perform(p, one, p.plan.revision.id, 100);
    const r1 = await appendOrthoSpaceEntry({ ...p.scope, command: c1 }); if (!r1.ok) throw Error(r1.code);
    const r2 = await appendOrthoSpaceEntry({ ...p.scope, command: perform(p, two, r1.revision.id, 200) }); if (!r2.ok) throw Error(r2.code);
    expect(await appendOrthoSpaceEntry({ ...p.scope, command: c1 })).toMatchObject({ ok: true, replayed: true, revision: { id: r1.revision.id } });
    const read = await getOrthoSpaceLedger(p.scope); if (!read.ok) throw Error(read.code);
    expect(read.plans[0]).toMatchObject({ sourceCurrent: true, estimatedBaseline: true, budget: { baselineDiscrepancyMm: -2, iprUm: 300, estimatedBalanceMm: -1.7 }, contacts: [{ performedUm: 300 }] });
    const correction = await appendOrthoSpaceEntry({ ...p.scope, command: perform(p, one, r2.revision.id, 50, { supersedesEntryId: r1.revision.id }) }); if (!correction.ok) throw Error(correction.code);
    expect(await getOrthoSpaceLedger(p.scope)).toMatchObject({ ok: true, ipr: { totals: [{ performedUm: 250 }] } });
    expect((await f.pool.query("SELECT content->'authored'->>'performedUm' amount FROM ortho_space_entries WHERE id=$1", [r1.revision.id])).rows[0].amount).toBe('100');
    expect((await f.pool.query("SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM visits) visits")).rows).toEqual(before);
    await expect(f.pool.query("UPDATE ortho_space_entries SET reason='overwrite' WHERE id=$1", [r1.revision.id])).rejects.toThrow('append-only');
  });
  it("rolls back duplicate sessions and review-required amounts with their audit rows", async () => {
    const p = await prepared(), adjustment = await p.adjustment();
    const c = perform(p, adjustment, p.plan.revision.id, 500);
    expect(await appendOrthoSpaceEntry({ ...p.scope, command: c })).toMatchObject({ ok: false, code: "ipr_review_required" });
    expect((await f.pool.query("SELECT count(*)::int n FROM ortho_space_entries WHERE ortho_case_id=$1", [p.scope.orthoCaseId])).rows[0].n).toBe(1);
    const approved = await appendOrthoSpaceEntry({ ...p.scope, command: { ...c, content: { ...c.content, reviewReason: "Synthetic clinician documents exceedance, not a safety approval" } } }); if (!approved.ok) throw Error(approved.code);
    expect(await appendOrthoSpaceEntry({ ...p.scope, command: perform(p, adjustment, approved.revision.id, 10) })).toMatchObject({ ok: false, code: "ipr_duplicate_session_contact" });
  });
  it("serializes competing saves and refuses foreign sessions and inactive clinicians", async () => {
    const p = await prepared(), one = await p.adjustment(), two = await p.adjustment();
    const results = await Promise.all([one, two].map(id => appendOrthoSpaceEntry({ ...p.scope, command: perform(p, id, p.plan.revision.id, 100) })));
    expect(results.filter(r => r.ok)).toHaveLength(1); expect(results.find(r => !r.ok)).toMatchObject({ code: "head_changed" });
    const foreign = await prepared(), foreignSession = await foreign.adjustment(); request.token = createSessionToken(p.scope.session);
    const head = results.find(r => r.ok)!; if (!head.ok) throw Error('missing');
    expect(await appendOrthoSpaceEntry({ ...p.scope, command: perform(p, foreignSession, head.revision.id, 10) })).toMatchObject({ ok: false, code: "ipr_session_missing" });
    await f.pool.query("UPDATE users SET is_active=false WHERE id=$1", [p.scope.session.userId]);
    expect(await getOrthoSpaceLedger(p.scope)).toMatchObject({ ok: false, status: 401 });
  });
});

it("keeps a saved budget after a source correction and rejects cross-owner updates at the database boundary", async () => {
  const p = await prepared(), a = await p.adjustment();
  const first = await appendOrthoSpaceEntry({ ...p.scope, command: perform(p, a, p.plan.revision.id, 100) }); if (!first.ok) throw Error(first.code);
  const before = (await f.pool.query("SELECT to_jsonb(r)::text value FROM ortho_space_entries r WHERE ortho_case_id=$1 ORDER BY version", [p.scope.orthoCaseId])).rows;
  const assessmentId = p.command.content.baseline.id;
  const command = { ...tanakaCommandV2(), commandId: randomUUID(), expectedRevisionId: assessmentId };
  command.content.observations.observations.find(r => r.id === 'width_11')!.value = { state: 'measured', value: 9 };
  expect(await appendOrthoAssessment({ ...p.scope, command })).toMatchObject({ ok: true });
  expect(await getOrthoSpaceLedger(p.scope)).toMatchObject({ ok: true, plans: [{ sourceCurrent: false, budget: { baselineDiscrepancyMm: -2 } }] });
  expect((await f.pool.query("SELECT to_jsonb(r)::text value FROM ortho_space_entries r WHERE ortho_case_id=$1 ORDER BY version", [p.scope.orthoCaseId])).rows).toEqual(before);
  const other = await setup();
  await expect(f.pool.query("UPDATE ortho_adjustments SET case_id=$1 WHERE id=$2", [other.orthoCaseId, a])).rejects.toThrow('space ownership');
  const visit = (await f.pool.query("SELECT visit_id FROM ortho_adjustments WHERE id=$1", [a])).rows[0].visit_id;
  await expect(f.pool.query("UPDATE visits SET patient_id=$1 WHERE id=$2", [other.patientId, visit])).rejects.toThrow('space ownership');
  await expect(f.pool.query("UPDATE visits SET case_id=$1 WHERE id=$2", [other.clinicalCaseId, visit])).rejects.toThrow('space ownership');
});

it("moves the current owner during an explicit patient merge while preserving recording provenance and replay", async () => {
  const p = await prepared(), a = await p.adjustment();
  const command = perform(p, a, p.plan.revision.id, 100);
  const saved = await appendOrthoSpaceEntry({ ...p.scope, command }); if (!saved.ok) throw Error(saved.code);
  const target = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic merged owner') RETURNING id", [`SYN-SPACE-MERGED-${randomUUID()}`])).rows[0].id;
  const merged = await f.db.mergeDuplicatePatient(p.scope.patientId, target, { actor: p.scope.session.username, reason: 'Synthetic explicit duplicate resolution' });
  expect(merged.ok).toBe(true);
  const scope = { ...p.scope, patientId: target };
  expect(await getOrthoSpaceLedger(scope)).toMatchObject({ ok: true, patientId: target, ipr: { totals: [{ performedUm: 100 }] } });
  expect(await appendOrthoSpaceEntry({ ...scope, command })).toMatchObject({ ok: true, replayed: true, revision: { id: saved.revision.id, patientId: target, recordedPatientId: p.scope.patientId } });
});
