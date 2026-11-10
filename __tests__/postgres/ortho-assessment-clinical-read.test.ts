import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { appendOrthoAssessment, getOrthoAssessment } from '../../lib/ortho-assessment-store';
import { blankClinicalObservationV2 } from '../../lib/ortho-assessment-clinical-fields';
import { canAccessPatient, canViewPatientMoney } from '../../lib/patient-access';
import { assessmentCommandV2 } from '../fixtures/ortho-assessment-schema2';
import { openPeriodontalFixture } from './_periodontal-fixture';
import { getOrthoCaseStudy } from '../../lib/ortho-case-study-store';
import { withIllustratedStudy } from '../../lib/ortho-study-illustrated-store';
import { saveConfirmedStudy } from '../helpers/ortho-study-submit';
import { syntheticStudyCommand } from '../fixtures/ortho-case-study';
import { getOrthoProblemSources } from '../../lib/ortho-problem-source-store';
import { problemSourceIdentity } from '../../lib/ortho-problem-sources';
const request = vi.hoisted(() => ({ token: '' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => name === 'aqlan_flow_session' ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async () => { vi.stubEnv('SESSION_SECRET', 'synthetic-assessment-private-secret-at-least32'); f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema(); });
afterAll(async () => { try { await f?.close(); } finally { vi.unstubAllEnvs(); } });
async function fixture() {
  const username = `synthetic-private-${randomUUID()}`, password = 'Synthetic private assessment credential';
  const userId = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic private clinician',$2,'admin') RETURNING id", [username, password])).rows[0].id;
  const session: SessionPayload = { userId, username, role: 'admin', credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 120000 };
  request.token = createSessionToken(session);
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic privacy patient') RETURNING id", [randomUUID()])).rows[0].id;
  const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'completed','synthetic') RETURNING id", [patientId])).rows[0].id;
  const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic privacy bridge',$2,'synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id;
  const scope = { patientId, orthoCaseId, clinicalCaseId, session }, command = assessmentCommandV2(); command.commandId = randomUUID();
  const canary = `SYNTHETIC-CLINICAL-PRIVATE-${randomUUID()}`;
  const observation = blankClinicalObservationV2('medicalHistory'); observation.value = { state: 'recorded', text: canary };
  observation.occurredOn = { state: 'known', date: '2026-10-01' };
  observation.provenance = { performer: { state: 'documented', attribution: 'Synthetic examiner' }, method: { version: 1, kind: 'direct_examination', description: 'Synthetic privacy fixture' }, sources: [], copiedFrom: null };
  command.content.observations.observations.push(observation);
  const first = await appendOrthoAssessment({ ...scope, command }); expect(first.ok).toBe(true); if (!first.ok) throw Error(first.code);
  const next = { ...command, commandId: randomUUID(), expectedRevisionId: first.revision.id, reason: 'Synthetic second revision' };
  const second = await appendOrthoAssessment({ ...scope, command: next }); expect(second.ok).toBe(true);
  expect(JSON.stringify(await getOrthoAssessment({ ...scope, acceptedSchemas: [2] }))).toContain(canary);
  return { scope, canary, firstId: first.revision.id, command: next };
}
const counts = async () => (await f.pool.query(`SELECT (SELECT count(*)::int FROM ortho_assessment_revisions) revisions,
 (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,
 (SELECT count(*)::int FROM patient_opening_balances) opening,(SELECT count(*)::int FROM appointments) appointments`)).rows;
it.each([false, true])('denies signed reception current and historical clinical reads even with broad flags=%s', async broad => {
  const s = await fixture(), before = await counts();
  await f.pool.query("UPDATE users SET role='reception',permissions=$2 WHERE id=$1", [s.scope.session.userId, broad ? JSON.stringify({ canViewAllPatients: true, canViewPlans: true, canEditPlans: true, canViewXrays: true, canExportOrthoStudies: true, canViewAllAppointments: true, canViewPatientPayments: true }) : null]);
  s.scope.session.role = 'reception'; request.token = createSessionToken(s.scope.session);
  for (const revisionId of [undefined, s.firstId]) {
    const result = await getOrthoAssessment({ ...s.scope, acceptedSchemas: [2], revisionId });
    expect(result).toMatchObject({ ok: false, status: 403, code: 'clinical_read_denied' });
    expect(JSON.stringify(result)).not.toContain(s.canary); expect(result).not.toHaveProperty('sources'); expect(result).not.toHaveProperty('revision');
  }
  expect(await appendOrthoAssessment({ ...s.scope, command: s.command })).toMatchObject({ ok: false, status: 403, code: 'clinical_edit_denied' });
  expect(await canAccessPatient(s.scope.session, s.scope.patientId)).toBe(true);
  expect(await canViewPatientMoney(s.scope.session, s.scope.patientId)).toBe(true);
  expect(await counts()).toEqual(before);
});
it('retains own-patient doctor read and denies it after real ownership revocation', async () => {
  const s = await fixture();
  const partyId = (await f.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic privacy owner') RETURNING id")).rows[0].id;
  await f.pool.query("UPDATE users SET role='doctor',party_id=$2,permissions=$3 WHERE id=$1", [s.scope.session.userId, partyId, JSON.stringify({ canViewAllPatients: false, canViewXrays: false })]);
  await f.pool.query('UPDATE patients SET primary_doctor_id=$2 WHERE id=$1', [s.scope.patientId, partyId]);
  s.scope.session.role = 'doctor'; request.token = createSessionToken(s.scope.session);
  expect(JSON.stringify(await getOrthoAssessment({ ...s.scope, acceptedSchemas: [2] }))).toContain(s.canary);
  const other = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic other owner') RETURNING id", [randomUUID()])).rows[0].id;
  await f.pool.query('UPDATE patients SET primary_doctor_id=$2 WHERE id=$1', [other, partyId]);
  expect(await getOrthoAssessment({ ...s.scope, patientId: other, acceptedSchemas: [2] })).toMatchObject({ ok: false, status: 404, code: 'ortho_case_not_found' });
  await f.pool.query('UPDATE patients SET primary_doctor_id=NULL WHERE id=$1', [s.scope.patientId]);
  const denied = await getOrthoAssessment({ ...s.scope, acceptedSchemas: [2] });
  expect(denied).toMatchObject({ ok: false, status: 403, code: 'patient_access_denied' }); expect(JSON.stringify(denied)).not.toContain(s.canary);
});
it('rejects an old clinical cookie after current role changes to reception', async () => {
  const s = await fixture(); await f.pool.query("UPDATE users SET role='reception' WHERE id=$1", [s.scope.session.userId]);
  const result = await getOrthoAssessment({ ...s.scope, acceptedSchemas: [2] });
  expect(result).toMatchObject({ ok: false, status: 401, code: 'session_expired' }); expect(JSON.stringify(result)).not.toContain(s.canary);
});

it('denies copied assessment content through selected/head study reads and export without blocking assessment-free studies', async () => {
  const s = await fixture(), clean = await saveConfirmedStudy({ ...s.scope, command: syntheticStudyCommand() });
  expect(clean.ok).toBe(true); if (!clean.ok) throw Error(clean.code);
  const role = async (next: 'admin' | 'reception') => {
    await f.pool.query('UPDATE users SET role=$2,permissions=$3 WHERE id=$1', [s.scope.session.userId, next, JSON.stringify({ canViewAllPatients: true, canViewXrays: true, canViewPlans: true, canExportOrthoStudies: true })]);
    s.scope.session.role = next; request.token = createSessionToken(s.scope.session);
  };
  await role('reception');
  expect(await getOrthoCaseStudy({ ...s.scope, revisionId: clean.revision.id, exportAccess: true })).toMatchObject({ ok: true });
  await role('admin');
  const assessment = await getOrthoAssessment({ ...s.scope, acceptedSchemas: [2] });
  if (!assessment.ok || assessment.state !== 'ready' || !assessment.revision) throw Error('Synthetic assessment absent');
  const command = syntheticStudyCommand();
  command.expectedHead = { id: clean.revision.id, contentHash: clean.revision.contentHash };
  command.content.sources = [{ key: 'private_assessment', kind: 'assessment', id: assessment.revision.id, version: assessment.revision.version, contentHash: assessment.revision.contentHash }];
  command.content.panels[0].state = 'available'; command.content.panels[0].sourceKeys = ['private_assessment'];
  const copied = await saveConfirmedStudy({ ...s.scope, command }); expect(copied.ok).toBe(true); if (!copied.ok) throw Error(copied.code);
  expect(JSON.stringify(copied)).toContain(s.canary);
  await role('reception');
  for (const revisionId of [clean.revision.id, copied.revision.id]) for (const exportAccess of [undefined, true] as const) {
    const result = await getOrthoCaseStudy({ ...s.scope, revisionId, exportAccess });
    expect(result).toMatchObject({ ok: false, status: 403, code: 'study_assessment_clinical_restricted' });
    expect(JSON.stringify(result)).not.toContain(s.canary); expect(result).not.toHaveProperty('revision');
  }
  const consume = vi.fn(async () => 'must not release copied assessment');
  const illustrated = await withIllustratedStudy({ ...s.scope, revisionId: copied.revision.id }, consume);
  expect(illustrated).toMatchObject({ ok: false, status: 403, code: 'study_assessment_clinical_restricted' }); expect(consume).not.toHaveBeenCalled();
  await role('admin');
  expect(JSON.stringify(await getOrthoCaseStudy({ ...s.scope, revisionId: copied.revision.id, exportAccess: true }))).toContain(s.canary);
});

it('denies assessment-derived problem candidates before releasing their clinical summaries', async () => {
  const s = await fixture(), before = await getOrthoProblemSources(s.scope);
  expect(before.ok).toBe(true); expect(JSON.stringify(before)).toContain(s.canary);
  await f.pool.query("UPDATE users SET role='reception' WHERE id=$1", [s.scope.session.userId]);
  s.scope.session.role = 'reception'; request.token = createSessionToken(s.scope.session);
  const result = await getOrthoProblemSources(s.scope);
  expect(result).toMatchObject({ ok: false, status: 403, code: 'problem_assessment_clinical_restricted' });
  expect(JSON.stringify(result)).not.toContain(s.canary); expect(result).not.toHaveProperty('candidates');
});
it('denies an immutable historical assessment review even when its case has no current assessment rows', async () => {
  const s = await fixture(), sources = await getOrthoProblemSources(s.scope);
  if (!sources.ok) throw Error(sources.code);
  const candidate = structuredClone(sources.candidates.find(row => row.ref.kind === 'assessment_observation' && row.summary === s.canary)!);
  expect(candidate).toBeDefined();
  const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'completed','synthetic') RETURNING id", [s.scope.patientId])).rows[0].id;
  const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic historical-only bridge',$2,'synthetic') RETURNING id", [s.scope.patientId, orthoCaseId])).rows[0].id;
  const problemId = (await f.pool.query("INSERT INTO patient_problems(patient_id,case_id,specialty,label,noted_by) VALUES($1,$2,'orthodontics','Synthetic historical review','synthetic') RETURNING id", [s.scope.patientId, clinicalCaseId])).rows[0].id;
  // A schema-admitted historical snapshot with an unavailable original source.
  // No immutable source is removed or edited, and no trigger is bypassed.
  candidate.ref.id = 2147483647; candidate.identity = problemSourceIdentity(candidate.ref);
  await f.pool.query(`INSERT INTO ortho_problem_source_reviews(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,problem_id,
    actor_user_id,created_by,source_identity,source_version,source_snapshot,problem_label,reason,command_id,request_fingerprint)
    VALUES($1,$1,$2,$3,$4,$5,'Synthetic historical reader',$6,$7,$8::jsonb,'Synthetic historical review','Synthetic unavailable source',$9,$10)`,
    [s.scope.patientId, orthoCaseId, clinicalCaseId, problemId, s.scope.session.userId, candidate.identity, candidate.ref.version, JSON.stringify(candidate), randomUUID(), 'a'.repeat(64)]);
  expect((await f.pool.query('SELECT count(*)::int n FROM ortho_assessment_revisions WHERE ortho_case_id=$1', [orthoCaseId])).rows[0].n).toBe(0);
  const scope = { ...s.scope, orthoCaseId, clinicalCaseId }, before = await getOrthoProblemSources(scope);
  expect(before.ok).toBe(true); expect(JSON.stringify(before)).toContain(s.canary);
  if (before.ok) { expect(before.candidates).toEqual([]); expect(before.reviews[0].currentSourceState).toBe('unavailable'); }
  await f.pool.query("UPDATE users SET role='reception' WHERE id=$1", [s.scope.session.userId]);
  scope.session.role = 'reception'; request.token = createSessionToken(scope.session);
  const result = await getOrthoProblemSources(scope);
  expect(result).toMatchObject({ ok: false, status: 403, code: 'problem_assessment_clinical_restricted' });
  expect(JSON.stringify(result)).not.toContain(s.canary); expect(result).not.toHaveProperty('reviews');
});
