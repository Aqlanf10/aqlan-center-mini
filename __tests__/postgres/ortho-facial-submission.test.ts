import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openPeriodontalFixture } from './_periodontal-fixture';
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { syntheticFace } from '../fixtures/ortho-facial-analysis';
import { appendFacialAnalysis } from '../../lib/ortho-facial-store';
import { putFile } from '../../lib/files';
import { journeyContentHash } from '../../lib/ortho-case-journey-hash';
import { reserveFacialSubmission, saveJournaledFacial, getFacialSubmissionRecovery, transitionFacialSubmission } from '../../lib/ortho-facial-submission-store';
import { ProtectedOrthoFacialHistoryError } from '../../lib/clinic-reset';
const request = vi.hoisted(() => ({ token: '' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => name === 'aqlan_flow_session' ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, directory: string;
const priorDir = process.env.DOCUMENTS_DIR;
beforeAll(async () => {
 vi.stubEnv('SESSION_SECRET', 'synthetic-facial-journal-secret-at-least-32');
 directory = await mkdtemp(join(tmpdir(), 'synthetic-facial-journal-')); process.env.DOCUMENTS_DIR = directory;
 f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema();
});
afterAll(async () => { try { await f?.close(); } finally { if (priorDir === undefined) delete process.env.DOCUMENTS_DIR; else process.env.DOCUMENTS_DIR = priorDir; if (directory) await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); } });
async function actor() {
 const username = `synthetic-journal-${randomUUID()}`, password = 'synthetic-only';
 const id = (await f.pool.query('INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES($1,$1,$2,\'doctor\',$3) RETURNING id', [username, password, JSON.stringify({ canViewAllPatients: true, canViewXrays: true })])).rows[0].id;
 return { userId: id, username, role: 'doctor', credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600000 } satisfies SessionPayload;
}
const select = (session: SessionPayload) => { request.token = createSessionToken(session); };
async function scope() {
 const session = await actor(); select(session);
 const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic journal patient') RETURNING id", [randomUUID()])).rows[0].id;
 const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic') RETURNING id", [patientId])).rows[0].id;
 const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic journal bridge',$2,'synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id;
 const bytes = await sharp({ create: { width: 1000, height: 1200, channels: 3, background: '#667788' } }).png().toBuffer(), stored = await putFile(bytes, 'png');
 const documentId = (await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,photo_view) VALUES($1,$2,'Synthetic image','image/png',$3,$4,$5,'synthetic','extraoral_frontal') RETURNING id", [patientId, orthoCaseId, stored.sizeBytes, stored.sha256, stored.key])).rows[0].id;
 const content = syntheticFace(); content.image.sha256 = stored.sha256; content.review.note = 'PRIVATE_JOURNAL_REVIEW';
 const command = { schemaVersion: 1 as const, clientRequestId: randomUUID(), documentId, expectedHeadId: null as number | null, reason: 'Synthetic review', content };
 return { owner: { session, actorId: session.userId, patientId, orthoCaseId, clinicalCaseId }, command, stored, bytes };
}
const count = async (caseId: number) => (await f.pool.query('SELECT count(*)::int n FROM ortho_facial_revisions WHERE ortho_case_id=$1', [caseId])).rows[0].n;
const row = async (caseId: number) => (await f.pool.query('SELECT * FROM ortho_facial_submissions WHERE ortho_case_id=$1 ORDER BY id DESC', [caseId])).rows[0];
const transition = (owner: Awaited<ReturnType<typeof scope>>['owner'], command: Awaited<ReturnType<typeof scope>>['command'], action: 'cancel' | 'acknowledge') => transitionFacialSubmission({ ...owner, action, commandId: command.clientRequestId, requestFingerprint: journeyContentHash(command) });

it('protects a zero-revision durable pending command from reset and patient merge', async () => {
 const { owner, command } = await scope(); expect(await reserveFacialSubmission({ ...owner, command })).toMatchObject({ ok: true }); expect(await count(owner.orthoCaseId)).toBe(0);
 let backed = false; await expect(f.db.resetClinicData({ actor: 'synthetic', actorRole: 'admin' }, async () => { backed = true; return { ok: false, failure: 'must not run' }; })).rejects.toBeInstanceOf(ProtectedOrthoFacialHistoryError); expect(backed).toBe(false);
 const target = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic target') RETURNING id", [randomUUID()])).rows[0].id;
 expect(await f.db.mergeDuplicatePatient(owner.patientId, target, { actor: 'synthetic', actorRole: 'admin' })).toMatchObject({ ok: false });
 expect((await row(owner.orthoCaseId)).patient_id).toBe(owner.patientId);
 await transition(owner, command, 'cancel'); await transition(owner, command, 'acknowledge');
});
it('recovers exact durable intent after a new session and acknowledges a lost committed result without duplicate facts', async () => {
 const { owner, command } = await scope(); expect(await reserveFacialSubmission({ ...owner, command })).toMatchObject({ ok: true });
 select({ ...owner.session, expiresAt: Date.now() + 7200000 });
 expect(await getFacialSubmissionRecovery(owner)).toMatchObject({ ok: true, actorId: owner.actorId, recovery: { state: 'pending', expected: { command, previousVersion: 0 } } });
 const saved = await saveJournaledFacial({ ...owner, command }); if (!saved.ok) throw Error(saved.code);
 expect(await getFacialSubmissionRecovery(owner)).toMatchObject({ ok: true, recovery: { state: 'committed', expected: { command } } });
 expect(await saveJournaledFacial({ ...owner, command })).toMatchObject({ ok: true, replayed: true, revision: { id: saved.revision.id } }); expect(await count(owner.orthoCaseId)).toBe(1);
 expect(await transition(owner, command, 'acknowledge')).toMatchObject({ ok: true, state: 'committed', acknowledged: true });
 expect(await getFacialSubmissionRecovery(owner)).toMatchObject({ ok: true, recovery: null });
 expect(await row(owner.orthoCaseId)).toMatchObject({ command: null, request_fingerprint: journeyContentHash(command), revision_id: saved.revision.id });
});
it('serializes exact repeated requests and fences a distinct key until acknowledgment', async () => {
 const { owner, command } = await scope(); const outcomes = await Promise.all([saveJournaledFacial({ ...owner, command }), saveJournaledFacial({ ...owner, command })]);
 expect(outcomes.every(result => result.ok)).toBe(true); expect(await count(owner.orthoCaseId)).toBe(1);
 expect(await saveJournaledFacial({ ...owner, command: { ...command, clientRequestId: randomUUID() } })).toMatchObject({ ok: false, code: 'facial_submission_unacknowledged' });
 expect(await transitionFacialSubmission({ ...owner, action: 'acknowledge', commandId: command.clientRequestId, requestFingerprint: 'f'.repeat(64) })).toMatchObject({ ok: false, code: 'request_key_conflict' });
});
it('keeps an acknowledged cancellation-before-arrival tombstone permanently', async () => {
 const { owner, command } = await scope(); expect(await transition(owner, command, 'cancel')).toMatchObject({ ok: true, state: 'cancelled', acknowledged: false });
 expect(await row(owner.orthoCaseId)).toMatchObject({ document_id: null, command: null, previous_version: null });
 await transition(owner, command, 'acknowledge'); expect(await saveJournaledFacial({ ...owner, command })).toMatchObject({ ok: false, code: 'facial_submission_cancelled' }); expect(await count(owner.orthoCaseId)).toBe(0);
});
it('atomically selects execution or cancellation and never reopens a cancelled command', async () => {
 const { owner, command } = await scope(); await reserveFacialSubmission({ ...owner, command });
 const [saved, cancelled] = await Promise.all([saveJournaledFacial({ ...owner, command }), transition(owner, command, 'cancel')]); const stored = await row(owner.orthoCaseId);
 if (stored.state === 'cancelled') { expect(saved).toMatchObject({ ok: false, code: 'facial_submission_cancelled' }); expect(cancelled).toMatchObject({ ok: true, state: 'cancelled' }); expect(await count(owner.orthoCaseId)).toBe(0); }
 else { expect(saved).toMatchObject({ ok: true }); expect(cancelled).toMatchObject({ ok: false, code: 'facial_submission_already_committed' }); expect(await count(owner.orthoCaseId)).toBe(1); }
});
it('does not expose another actor command or identity', async () => {
 const { owner, command } = await scope(); await reserveFacialSubmission({ ...owner, command }); const other = await actor(); select(other);
 const input = { ...owner, actorId: other.userId, session: other }, recovered = await getFacialSubmissionRecovery(input);
 expect(recovered).toMatchObject({ ok: true, recovery: { state: 'blocked', identity: null, canCancel: false } }); expect(JSON.stringify(recovered)).not.toContain('PRIVATE_JOURNAL_REVIEW'); expect(JSON.stringify(recovered)).not.toContain(command.clientRequestId);
 expect(await saveJournaledFacial({ ...input, command: { ...command, clientRequestId: randomUUID() } })).toMatchObject({ ok: false, code: 'facial_submission_unacknowledged' });
});
it('reauthorizes revoked image permission and exposes only cancellable metadata', async () => {
 const { owner, command } = await scope(); await reserveFacialSubmission({ ...owner, command });
 await f.pool.query('UPDATE users SET permissions=$1 WHERE id=$2', [JSON.stringify({ canViewAllPatients: true, canViewXrays: false }), owner.actorId]);
 const recovered = await getFacialSubmissionRecovery(owner); expect(recovered).toMatchObject({ ok: true, recovery: { state: 'blocked', canCancel: true } }); expect(JSON.stringify(recovered)).not.toContain('PRIVATE_JOURNAL_REVIEW'); expect(JSON.stringify(recovered)).not.toContain('landmarks');
 expect(await saveJournaledFacial({ ...owner, command })).toMatchObject({ ok: false, status: 403 }); expect(await transition(owner, command, 'cancel')).toMatchObject({ ok: true, state: 'cancelled' });
});
it('blocks unavailable or modified backing image bytes before exposing pending or committed payload', async () => {
 for (const committed of [false, true]) {
  const { owner, command, stored, bytes } = await scope(); if (committed) await saveJournaledFacial({ ...owner, command }); else await reserveFacialSubmission({ ...owner, command });
  await writeFile(join(directory, stored.key), Buffer.from('synthetic tamper'));
  try { const recovered = await getFacialSubmissionRecovery(owner); expect(recovered).toMatchObject({ ok: true, recovery: { state: 'blocked', canCancel: !committed } }); expect(JSON.stringify(recovered)).not.toContain('PRIVATE_JOURNAL_REVIEW'); expect(JSON.stringify(recovered)).not.toContain('landmarks'); }
  finally { await writeFile(join(directory, stored.key), bytes); }
 }
});
it('preserves durable pending intent when execution fails and rolls back revision and receipt together', async () => {
 const { owner, command } = await scope(); await f.pool.query("CREATE FUNCTION synthetic_facial_execution_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.facial_revision' THEN RAISE EXCEPTION 'synthetic facial audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_facial_execution_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_facial_execution_fail()");
 try { await expect(saveJournaledFacial({ ...owner, command })).rejects.toThrow('synthetic facial audit failure'); } finally { await f.pool.query('DROP TRIGGER synthetic_facial_execution_fail ON audit_log;DROP FUNCTION synthetic_facial_execution_fail()'); }
 expect(await count(owner.orthoCaseId)).toBe(0); expect(await row(owner.orthoCaseId)).toMatchObject({ state: 'pending', revision_id: null, command }); expect(await getFacialSubmissionRecovery(owner)).toMatchObject({ ok: true, recovery: { state: 'pending', expected: { command } } });
 expect(await saveJournaledFacial({ ...owner, command })).toMatchObject({ ok: true }); expect(await count(owner.orthoCaseId)).toBe(1);
});
it('preserves exact stale head rather than silently rebasing a durable command', async () => {
 const { owner, command } = await scope(); await reserveFacialSubmission({ ...owner, command });
 expect(await appendFacialAnalysis({ ...owner, command: { ...command, clientRequestId: randomUUID() } })).toMatchObject({ ok: true });
 expect(await saveJournaledFacial({ ...owner, command })).toMatchObject({ ok: false, code: 'facial_head_changed' });
 expect(await row(owner.orthoCaseId)).toMatchObject({ state: 'pending', command, previous_version: 0 }); expect(await count(owner.orthoCaseId)).toBe(1);
 expect(await getFacialSubmissionRecovery(owner)).toMatchObject({ ok: true, recovery: { state: 'blocked', canCancel: true } });
 await transition(owner, command, 'cancel'); await transition(owner, command, 'acknowledge'); expect(await saveJournaledFacial({ ...owner, command })).toMatchObject({ ok: false, code: 'facial_submission_cancelled' });
});
it('retains committed payload when acknowledgment audit fails', async () => {
 const { owner, command } = await scope(); await saveJournaledFacial({ ...owner, command });
 await f.pool.query("CREATE FUNCTION synthetic_facial_ack_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.facial_submission' THEN RAISE EXCEPTION 'synthetic facial acknowledgment failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_facial_ack_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_facial_ack_fail()");
 try { await expect(transition(owner, command, 'acknowledge')).rejects.toThrow('synthetic facial acknowledgment failure'); } finally { await f.pool.query('DROP TRIGGER synthetic_facial_ack_fail ON audit_log;DROP FUNCTION synthetic_facial_ack_fail()'); }
 expect(await row(owner.orthoCaseId)).toMatchObject({ state: 'committed', command, acknowledged_at: null });
 expect(await transition(owner, command, 'acknowledge')).toMatchObject({ ok: true, acknowledged: true });
});
it('hides archived source payload and permits safe cancellation without requiring image access', async () => {
 const { owner, command } = await scope(); await reserveFacialSubmission({ ...owner, command }); await f.pool.query("UPDATE patient_documents SET photo_stage='archived' WHERE id=$1", [command.documentId]);
 const recovered = await getFacialSubmissionRecovery(owner); expect(recovered).toMatchObject({ ok: true, recovery: { state: 'blocked', canCancel: true } }); expect(JSON.stringify(recovered)).not.toContain('PRIVATE_JOURNAL_REVIEW');
 expect(await saveJournaledFacial({ ...owner, command })).toMatchObject({ ok: false, status: 404 }); expect(await count(owner.orthoCaseId)).toBe(0); expect(await transition(owner, command, 'cancel')).toMatchObject({ ok: true });
});
it('rejects journal identity mutation, erasure, terminal reopening and a false commit witness', async () => {
 const { owner, command } = await scope(); await reserveFacialSubmission({ ...owner, command }); const stored = await row(owner.orthoCaseId);
 for (const sql of ["UPDATE ortho_facial_submissions SET command_id='different_identity_0001' WHERE id=$1", "UPDATE ortho_facial_submissions SET request_fingerprint=repeat('f',64) WHERE id=$1", "DELETE FROM ortho_facial_submissions WHERE id=$1"]) await expect(f.pool.query(sql, [stored.id])).rejects.toThrow();
 await expect(f.pool.query('TRUNCATE ortho_facial_submissions')).rejects.toThrow();
 await expect(f.pool.query("UPDATE ortho_facial_submissions SET state='committed',settled_at=clock_timestamp() WHERE id=$1", [stored.id])).rejects.toThrow();
 await transition(owner, command, 'cancel'); await expect(f.pool.query("UPDATE ortho_facial_submissions SET state='pending',settled_at=NULL WHERE id=$1", [stored.id])).rejects.toThrow();
 expect(await row(owner.orthoCaseId)).toMatchObject({ state: 'cancelled', command });
});
it('binds original actor, bridge and exact command fingerprint before reservation or execution', async () => {
 const { owner, command } = await scope();
 expect(await reserveFacialSubmission({ ...owner, actorId: owner.actorId + 100000, command })).toMatchObject({ ok: false, code: 'facial_submission_actor_changed' });
 expect(await reserveFacialSubmission({ ...owner, clinicalCaseId: owner.clinicalCaseId + 100000, command })).toMatchObject({ ok: false, code: 'facial_submission_context_changed' });
 expect(await row(owner.orthoCaseId)).toBeUndefined();
 await reserveFacialSubmission({ ...owner, command });
 expect(await saveJournaledFacial({ ...owner, command: { ...command, reason: 'Different clinical command' } })).toMatchObject({ ok: false, code: 'request_key_conflict' });
 expect(await row(owner.orthoCaseId)).toMatchObject({ state: 'pending', command }); expect(await count(owner.orthoCaseId)).toBe(0);
});
