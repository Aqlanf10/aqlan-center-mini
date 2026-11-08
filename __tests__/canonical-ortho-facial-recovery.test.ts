import { facialScenario } from './fixtures/ortho-facial-core';
/** Privacy basis: payload IDs, dates and clinical content come from the reviewed synthetic core.
 * Local small IDs are collision/mismatch or sequence witnesses; versions, byte limits,
 * SQL/HTTP codes, PNG signature and cardinalities are protocol/test-boundary constants.
 * Alternative text and mismatch SHA values below are newly authored synthetic data. */
/** Actual durable admission/snapshot owner, synthetic transport and image service.
 * Does not prove real PostgreSQL races, native decoding or storage atomicity. */
import { afterEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ connect: vi.fn(), probe: vi.fn() }));
vi.mock('../lib/db', async original => ({ ...await original<typeof import('../lib/db')>(), getPool: () => ({ connect: db.connect }), usesSharedLocalDatabaseConnection: () => false }));
vi.mock('../lib/staff-runtime-probe.mjs', () => ({ inspectStaffRuntimeSchema: db.probe }));
import { facialReadFixture } from './fixtures/canonical-ortho-facial-read';
import { basis, scope, command, submission, revision, chain } from './fixtures/ortho-facial-core';
import { FacialFault, type FacialFaultCode } from '../lib/ortho-facial-core-contract';
import { FACIAL_READ_BYTES } from '../lib/ortho-facial-read-witness';
const fixture = () => facialReadFixture(db.connect, db.probe);
type Fixture = ReturnType<typeof fixture>;
const recover = (f: Fixture) => f.reads.recovery(f.session, scope);
const clean = (f: Fixture) => {
  expect(f.h.audits).toEqual([]); expect(f.images.render).not.toHaveBeenCalled();
  expect(f.sqls.join('\n')).not.toMatch(/FOR SHARE|FOR UPDATE|FOR NO KEY|LOCK TABLE|INSERT |DELETE |UPDATE |pg_current_xact_id/);
};
const retained = (state: 'pending' | 'committed' = 'pending', newer = false) => {
  const f = fixture(), c = command({ clientRequestId: 'recovery-reader-test-002', expectedHeadId: 674648274 }); f.h.revisions = chain(1);
  if (state === 'committed') f.h.revisions.push(revision(c, 2, 102));
  if (newer) f.h.revisions.push(revision(command({ clientRequestId: 'recovery-reader-newer-003', expectedHeadId: 102 }), 3, 103));
  f.h.submissions = [submission(c, { state, revision_id: state === 'committed' ? 102 : null })]; return f;
};
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); db.connect.mockReset(); db.probe.mockReset(); });
it.each(['absent', 'cancelled', 'foreign', 'denied-image'] as const)('ortho-only %s metadata completes one snapshot with no native work', async kind => {
  const f = fixture(); f.state.permission.grants['clinical.xrays.view'] = false;
  if (kind !== 'absent') f.h.submissions = [submission(command(), kind === 'cancelled' ? { state: 'cancelled' } : kind === 'foreign' ? { actor_user_id: 999, command: {} } : {})];
  const result = await recover(f);
  expect(result.recovery).toEqual(kind === 'absent' ? null : kind === 'cancelled' ? { state: 'cancelled', identity: { id: 750913085, commandId: command().clientRequestId, requestFingerprint: f.h.submissions[0].request_fingerprint } }
    : { state: 'blocked', canCancel: kind === 'denied-image', identity: kind === 'denied-image' ? { id: 750913085, commandId: command().clientRequestId, requestFingerprint: f.h.submissions[0].request_fingerprint } : null });
  expect(f.events).toEqual(['begin', 'commit', 'unlock', 'release']); expect(f.images.verify).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(/storage_key|private-key|expected|"command"|"actor"|requested/); clean(f);
});
it.each(['none', 'own-missing', 'all-absent', 'no-ortho'])('ordinary authority %s cannot become null metadata', async kind => {
  const f = fixture();
  if (kind === 'no-ortho') f.state.permission.grants['clinical.ortho.view'] = false;
  else { f.state.permission.patientScope = kind === 'none' ? 'none' : kind === 'all-absent' ? 'all' : 'own'; f.state.inside = false; if (kind === 'all-absent') f.state.patient = false; }
  await expect(recover(f)).rejects.toThrow(); expect(f.images.verify).not.toHaveBeenCalled(); clean(f);
});
it.each(['pending', 'committed'] as const)('stable %s returns actual preparation without settling', async state => {
  const f = retained(state), before = structuredClone(f.h.submissions);
  const result = await recover(f); expect(result.recovery).toMatchObject({ state, identity: { id: 750913085 }, expected: { previousVersion: 1, command: before[0].command } });
  expect(f.h.submissions).toEqual(before); expect(f.images.verify).toHaveBeenCalledOnce();
  expect(f.events).toEqual(['begin', 'commit', 'unlock', 'release', 'decode', 'begin', 'commit', 'unlock', 'release']);
  expect(f.sqls.filter(sql => sql.startsWith('BEGIN'))).toEqual(Array(2).fill('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  expect(JSON.stringify(result)).not.toMatch(/storage_key|private-key|"Buffer"|"actor"|requested/); clean(f);
});
it('exact committed replay remains valid after newer head', async () => {
  const f = retained('committed', true); expect((await recover(f)).recovery).toMatchObject({ state: 'committed', expected: { previousVersion: 1 } }); clean(f);
});
it.each(['pending-version', 'committed-version', 'missing-replay', 'wrong-replay'] as const)('unchanged accepted final integrity rejects %s', async mode => {
  const f = retained(mode === 'pending-version' || mode === 'missing-replay' ? 'pending' : 'committed');
  if (mode.endsWith('version')) f.h.submissions[0].previous_version = 7;
  if (mode === 'missing-replay') Object.assign(f.h.submissions[0], { state: 'committed', revision_id: 102 });
  if (mode === 'wrong-replay') f.h.submissions[0].revision_id = 999;
  await expect(recover(f)).rejects.toMatchObject({ status: 500, code: 'invalid_facial_submission' }); expect(f.images.verify).toHaveBeenCalledOnce(); clean(f);
});
it.each(['disappear', 'acknowledge', 'cancel', 'image-loss'] as const)('phase-B %s metadata refuses stale after either decoder outcome', async change => {
  for (const rejection of [false, true]) {
    const f = retained(); f.state.onDecode = () => {
      if (change === 'disappear') f.h.submissions = [];
      if (change === 'acknowledge') Object.assign(f.h.submissions[0], { state: 'cancelled', acknowledged_at: new Date(facialScenario.acknowledged), command: null });
      if (change === 'cancel') f.h.submissions[0].state = 'cancelled';
      if (change === 'image-loss') f.state.permission.grants['clinical.xrays.view'] = false;
      if (rejection) throw new FacialFault(409, 'facial_image_decode');
    };
    await expect(recover(f)).rejects.toMatchObject({ status: 409, code: 'facial_submission_context_changed' });
    expect(f.state.begins).toBe(2); expect(f.state.commits).toBe(1); clean(f);
  }
});
it.each([
  ['id', 202], ['patient_id', 12], ['recorded_patient_id', 12], ['clinical_case_id', 32], ['actor_user_id', 42],
  ['previous_version', 2], ['revision_id', 999],
] as const)('journal field %s drift cannot reuse a decoded result', async (key, value) => {
  const f = retained(key === 'revision_id' ? 'committed' : 'pending'); f.state.onDecode = () => { f.h.submissions[0][key] = value; };
  await expect(recover(f)).rejects.toMatchObject({ status: 409, code: 'facial_submission_context_changed' }); clean(f);
});
it.each(['key', 'command', 'document', 'state'] as const)('well-shaped paired journal %s drift is stale', async change => {
  const f = retained(); f.state.onDecode = () => {
    const c = command({ clientRequestId: 'recovery-reader-test-002', expectedHeadId: 674648274 });
    if (change === 'key') c.clientRequestId = 'recovery-replaced-key-002';
    if (change === 'command') c.reason = 'Synthetic recovery mutation v1';
    if (change === 'document') { c.documentId = 52; f.h.doc = { ...f.h.doc, id: 52 }; }
    f.h.submissions = [submission(c, change === 'state' ? { state: 'committed', revision_id: 102 } : {})];
  };
  await expect(recover(f)).rejects.toMatchObject({ status: 409, code: change === 'document' ? 'facial_image_changed' : 'facial_submission_context_changed' }); expect(f.state.commits).toBe(1); clean(f);
});
it.each([
  ['id', 52], ['patient_id', 12], ['ortho_case_id', 22], ['photo_stage', 'progress'], ['photo_stage', 'archived'], ['photo_view', 'other'], ['removed_at', new Date(facialScenario.removed)],
  ['sha256', "0019aa1466be75b00ca3d52e4ed7c36212cf9a55a28217bb1423850b09884a0c"], ['storage_key', 'synthetic-companion-v1/drift-source.png'], ['mime_type', 'image/jpeg'], ['size_bytes', '100'], ['size_bytes', 101], ['title', 'Synthetic drift image title v1'], ['taken_on', facialScenario.driftDay],
] as const)('source %s drift is refused after success and rejected decode', async (key, value) => {
  for (const rejected of [false, true]) {
    const f = retained(); f.state.onDecode = () => { f.h.doc = { ...f.h.doc, [key]: value }; if (rejected) throw new FacialFault(409, 'facial_image_decode'); };
    const hidden = ['id', 'patient_id', 'ortho_case_id', 'photo_view', 'removed_at'].includes(key) || key === 'photo_stage' && value === 'archived';
    await expect(recover(f)).rejects.toMatchObject({ status: 409, code: hidden ? 'facial_submission_context_changed' : 'facial_image_changed' }); expect(f.state.begins).toBe(2); expect(f.state.commits).toBe(1); clean(f);
  }
});
it.each([
  // Ordinary admission errors are deliberately sanitized at boundedFailure;
  // callback authority/owner FacialFault categories remain concrete.
  ['ortho', 500, 'facial_core_context_changed'],
  ['membership', 404, 'ortho_case_not_found'],
  ['patient', 404, 'ortho_case_not_found'],
  ['bridge', 409, 'bridge_missing'],
  ['status', 409, 'facial_submission_context_changed'],
  ['actor', 401, 'facial_authority_changed'],
  ['clinician', 500, 'facial_core_context_changed'],
] as const)('current %s change wins over stale decoder fault', async (change, status, code) => {
  const f = retained(); f.state.onDecode = () => {
    if (change === 'ortho') f.state.permission.grants['clinical.ortho.view'] = false;
    if (change === 'membership') f.state.inside = false;
    if (change === 'patient') f.state.patient = false;
    if (change === 'bridge') f.h.bridges = 0;
    if (change === 'status') f.h.status = 'active';
    if (change === 'actor') f.state.actor.role = 'admin';
    if (change === 'clinician') { f.state.actor.party_id = 22; f.state.provider.id = 22; }
    throw new FacialFault(409, 'facial_image_decode');
  };
  await expect(recover(f)).rejects.toMatchObject({ status, code });
  expect(f.state.begins).toBe(2); expect(f.state.commits).toBe(1); expect(f.state.releases).toBe(2);
  expect(f.images.verify).toHaveBeenCalledOnce(); clean(f);
});
const recoverable: FacialFaultCode[] = ['invalid_facial_analysis', 'invalid_image_date', 'facial_document_unavailable', 'facial_image_changed', 'facial_image_unsupported', 'facial_image_integrity', 'facial_image_decode', 'image_access_denied', 'facial_head_changed', 'request_key_conflict', 'facial_submission_context_changed'];
it.each(recoverable)('actual decoder fault %s maps only at allowed status after current proof', async code => {
  for (const status of [400, 403, 404, 409, 500, 413]) {
    const f = retained(); f.state.onDecode = () => { throw new FacialFault(status, code); };
    if ([400, 403, 404, 409].includes(status)) {
      expect((await recover(f)).recovery).toMatchObject({ state: 'blocked', canCancel: true, identity: { id: 750913085 } }); expect(f.state.commits).toBe(2);
    } else await expect(recover(f)).rejects.toMatchObject({ status, code });
    expect(f.state.begins).toBe(2); expect(f.images.verify).toHaveBeenCalledOnce(); clean(f);
  }
});
it.each([400, 403, 404, 409])('excluded code at %i and lookalikes never map to blocked', async status => {
  for (const lookalike of [false, true]) {
    const f = retained(); f.state.onDecode = () => { throw lookalike ? { status, code: 'facial_image_decode', secret: '/private/native' } : new FacialFault(status, 'invalid_facial_submission'); };
    await expect(recover(f)).rejects.toMatchObject(lookalike ? { status: 500, code: 'facial_core_context_changed' } : { status, code: 'invalid_facial_submission' });
    expect(f.state.begins).toBe(2); clean(f);
  }
});
it.each([new Error('/private/native'), '/private/native', null])('unexpected decoder rejection %j is bounded nonrecoverable', async error => {
  const f = retained(); f.state.onDecode = () => { throw error; };
  await expect(recover(f)).rejects.toMatchObject({ status: 500, code: 'facial_core_context_changed' }); expect(f.state.begins).toBe(2); clean(f);
});
it('committed allowed decoder failure remains noncancellable', async () => {
  const f = retained('committed'); f.state.onDecode = () => { throw new FacialFault(409, 'facial_image_decode'); };
  expect((await recover(f)).recovery).toEqual({ state: 'blocked', identity: null, canCancel: false }); clean(f);
});
it.each(['expiry', 'service', 'clock', 'method'] as const)('rejected decode immediately checks %s without publishing old fault', async change => {
  const f = retained(); f.state.onDecode = () => {
    if (change === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(f.claims.expiresAt + 1);
    if (change === 'service') f.services.images = { ...f.images };
    if (change === 'clock') f.services.clock = { today: () => facialScenario.today };
    if (change === 'method') f.images.verify = vi.fn(async () => ({ ...basis }));
    throw new FacialFault(409, 'facial_image_decode');
  };
  await expect(recover(f)).rejects.toMatchObject({ code: change === 'expiry' ? 'facial_authority_changed' : 'facial_core_context_changed' }); expect(f.state.begins).toBe(1); clean(f);
});
it('final fresh preparation sees changed head and maps it without append', async () => {
  const f = retained(); f.state.onDecode = () => { f.h.revisions = chain(2); };
  expect((await recover(f)).recovery).toMatchObject({ state: 'blocked', canCancel: true }); clean(f);
});
it.each(['hash', 'schema', 'results'] as const)('fresh actual saved replay corruption %s cannot publish payload', async change => {
  const f = retained('committed'); f.state.onDecode = () => {
    if (change === 'hash') f.h.revisions[1].request_fingerprint = "0019aa1466be75b00ca3d52e4ed7c36212cf9a55a28217bb1423850b09884a0c";
    if (change === 'schema') f.h.revisions[1].command = {};
    if (change === 'results') f.h.revisions[1].results = {};
  };
  await expect(recover(f)).rejects.toMatchObject({ status: 500 }); clean(f);
});
it.each([1, 2])('snapshot phase %i lifecycle failures publish nothing', async phase => {
  for (const point of ['commit', 'unlock-false', 'unlock-reject', 'release', 'virtual-id', 'expiry', 'query'] as const) {
    for (const rejected of phase === 1 ? [false] : [false, true]) {
      const f = retained(); let published = false;
      if (rejected) f.state.onDecode = () => { throw new FacialFault(409, 'facial_image_decode'); };
      f.state.hook = sql => {
        if (f.state.begins !== phase) return;
        if (point === 'commit' && sql === 'COMMIT') throw Error('private-driver');
        if (point === 'unlock-false' && sql.includes('pg_advisory_unlock_shared')) return { rows: [{ unlocked: false }] };
        if (point === 'unlock-reject' && sql.includes('pg_advisory_unlock_shared')) throw Error('private-driver');
        if (point === 'release' && sql === 'COMMIT') f.state.releaseFailure = true;
        if (point === 'virtual-id' && sql.includes('pg_locks')) return { rows: [{ virtualxid: 'wrong', isolation: 'repeatable read', read_only: 'on', in_recovery: false }] };
        if (point === 'expiry' && sql === 'COMMIT') vi.spyOn(Date, 'now').mockReturnValue(f.claims.expiresAt + 1);
        if (point === 'query' && sql.includes('FROM ortho_facial_submissions')) throw Error('private-driver');
      };
      await expect(recover(f).then(value => { published = true; return value; })).rejects.toThrow(); expect(published).toBe(false);
      expect(f.images.verify).toHaveBeenCalledTimes(phase === 1 ? 0 : 1); clean(f); vi.restoreAllMocks();
    }
  }
});
it.each([1, 2, 3])('journal read %i rejects oversized raw result before clone, including unchanged final core', async ordinal => {
  const f = retained(), raw = [{ ...f.h.submissions[0], oversized: 'é'.repeat(FACIAL_READ_BYTES.row) }]; let seen = 0;
  f.state.hook = sql => { if (sql.includes('FROM ortho_facial_submissions') && ++seen === ordinal) return { rows: raw }; };
  const clone = vi.spyOn(globalThis, 'structuredClone');
  await expect(recover(f)).rejects.toMatchObject({ status: 413, code: 'facial_history_too_large' });
  expect(clone.mock.calls.some(([value]) => value === raw || value === raw[0])).toBe(false); clean(f);
});
it('final raw revision guard precedes clone and cannot map to blocked', async () => {
  const f = retained(), raw = [{ ...f.h.revisions[0], oversized: 'x'.repeat(FACIAL_READ_BYTES.row) }];
  f.state.hook = sql => { if (sql.includes('FROM ortho_facial_revisions')) return { rows: raw }; };
  const clone = vi.spyOn(globalThis, 'structuredClone');
  await expect(recover(f)).rejects.toMatchObject({ status: 413, code: 'facial_history_too_large' });
  expect(clone.mock.calls.some(([value]) => value === raw || value === raw[0])).toBe(false); clean(f);
});
it('rejects caller keys/services or scope mutation rather than accepting alternate admission', async () => {
  const f = retained(); expect(() => f.reads.recovery(f.session, { ...scope, key: 'read:ortho.facial.image' } as typeof scope)).toThrow(expect.objectContaining({ status: 400, code: 'invalid_scope' }));
  const raw = { ...scope }; f.state.onDecode = () => { raw.patientId = 12; raw.orthoCaseId = 22; };
  expect((await f.reads.recovery(f.session, raw)).scope).toEqual({ ...scope, clinicalCaseId: 788771589 }); clean(f);
});
it('a fresh independent outstanding query may return null but proves no historical exact-key acknowledgement', async () => {
  const f = retained(); f.h.submissions[0] = { ...f.h.submissions[0], state: 'cancelled', acknowledged_at: new Date(facialScenario.acknowledged), command: null };
  expect((await recover(f)).recovery).toBeNull(); expect(f.images.verify).not.toHaveBeenCalled();
  expect(f.sqls.filter(sql => sql.includes('FROM ortho_facial_submissions')).every(sql => sql.includes('acknowledged_at IS NULL'))).toBe(true); clean(f);
});
it('valid plan and payload larger than 16 KiB use the owning 256 KiB budget', async () => {
  const { FACIAL_LANDMARKS } = await import('../lib/ortho-facial-analysis');
  const f = fixture(), c = command();
  for (const [key] of FACIAL_LANDMARKS) c.content.landmarks[key] = { state: 'unavailable', reason: '界'.repeat(500) };
  f.h.submissions = [submission(c)];
  expect(Buffer.byteLength(JSON.stringify(c))).toBeGreaterThan(FACIAL_READ_BYTES.witness);
  const result = await recover(f); expect(result.recovery).toMatchObject({ state: 'pending', expected: { command: c } });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(FACIAL_READ_BYTES.witness); expect(f.state.commits).toBe(2); clean(f);
});
it.each(['source', 'owner'] as const)('oversized raw %s fails before kernel copying', async kind => {
  const f = retained(), raw = [kind === 'source' ? { ...f.h.doc, title: 'x'.repeat(FACIAL_READ_BYTES.witness) }
    : { id: 639752548, patient_id: 734599007, status: 'assessment', plan_id: null, extra: 'x'.repeat(FACIAL_READ_BYTES.witness) }];
  f.state.hook = sql => { if (kind === 'source' ? sql.includes('FROM patient_documents') : sql.startsWith('SELECT id,patient_id,status,plan_id FROM ortho_cases')) return { rows: raw }; };
  const clone = vi.spyOn(globalThis, 'structuredClone');
  await expect(recover(f)).rejects.toMatchObject({ status: 413, code: 'facial_history_too_large' });
  expect(clone.mock.calls.some(([value]) => value === raw || value === raw[0])).toBe(false); expect(f.images.verify).not.toHaveBeenCalled(); clean(f);
});
it.each(['all', 'own'] as const)('changed patient constraint %s requires actual fresh membership', async target => {
  const f = retained(); f.state.onDecode = () => { f.state.permission.patientScope = target; };
  expect((await recover(f)).recovery).toMatchObject({ state: 'pending' }); clean(f);
});
it.each(['realm', 'subject', 'generation', 'user', 'username'] as const)('fresh actor anchor %s cannot adopt a new identity', async change => {
  const f = retained(); f.state.onDecode = () => {
    if (change === 'realm') f.state.control.realm_id = '55555555-5555-4555-8555-555555555555';
    if (change === 'subject') f.state.bindings[1].subject_id = '55555555-5555-4555-8555-555555555555';
    if (change === 'generation') f.state.identity.generation_id = '55555555-5555-4555-8555-555555555555';
    if (change === 'user') f.state.actor.id = 42;
    if (change === 'username') f.state.actor.username = 'Synthetic replacement reviewer v1';
  };
  await expect(recover(f)).rejects.toThrow(); clean(f);
});
it('ordinary failure during final blocked reconstruction cannot become false eligibility', async () => {
  const f = retained(); f.state.onDecode = () => { throw new FacialFault(409, 'facial_image_decode'); };
  let count = 0;
  // Three journal reads mean final unchanged recovery is now preparing. Its
  // subsequent owner reads must still prove the current patient and bridge.
  f.state.hook = sql => {
    if (sql.includes('FROM ortho_facial_submissions')) count++;
    if (count === 3 && sql.includes('FROM ortho_facial_revisions')) f.h.bridges = 0;
  };
  await expect(recover(f)).rejects.toMatchObject({ code: 'bridge_missing' }); clean(f);
});
it.each(['acquire', 'begin'] as const)('phase-A %s failure cannot initialize native decoding', async point => {
  const f = retained();
  if (point === 'acquire') db.connect.mockRejectedValue(Error('private-driver'));
  else f.state.hook = sql => { if (sql.startsWith('BEGIN')) throw Error('private-driver'); };
  await expect(recover(f)).rejects.toMatchObject({ status: 500, code: 'facial_core_context_changed' });
  expect(f.images.verify).not.toHaveBeenCalled(); clean(f);
});
it.each([1, 2])('owning phase %i result budget independently rejects after local bound succeeds', async phase => {
  const f = retained(), stringify = JSON.stringify; let matches = 0;
  // Synthetic serializer instrumentation, not a realistic oversized command.
  vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
    const target = value && typeof value === 'object' && (phase === 1 ? 'plan' in value && 'actor' in value && 'requested' in value : 'ok' in value && 'recovery' in value);
    if (target && ++matches === 2) return 'x'.repeat(FACIAL_READ_BYTES.recovery + 1);
    return Reflect.apply(stringify, JSON, [value, ...args]);
  }) as typeof JSON.stringify);
  await expect(recover(f)).rejects.toMatchObject({ status: 500, code: 'facial_core_context_changed' });
  expect(matches).toBe(2); expect(f.state.commits).toBe(phase - 1); expect(f.images.verify).toHaveBeenCalledTimes(phase - 1); clean(f);
});
it.each([1, 2])('owning phase %i deadline prevents publication', async phase => {
  const f = retained(), now = performance.now.bind(performance); let expired = false;
  vi.spyOn(performance, 'now').mockImplementation(() => now() + (expired ? 60000 : 0));
  f.state.hook = sql => { if (f.state.begins === phase && sql.includes('FROM ortho_facial_submissions')) expired = true; };
  await expect(recover(f)).rejects.toMatchObject({ status: 500, code: 'facial_core_context_changed' });
  expect(f.images.verify).toHaveBeenCalledTimes(phase - 1); clean(f);
});
it.each(['planId', 'recordingContext'] as const)('valid owner %s drift refuses stale with an unchanged owner control', async field => {
  for (const drift of [false, true]) {
    const f = retained(); let decoded = false;
    if (field === 'recordingContext') f.h.status = 'completed';
    f.state.onDecode = () => { decoded = true; if (field === 'recordingContext' && drift) f.h.status = 'active'; };
    f.state.hook = sql => {
      if (field === 'planId' && sql.startsWith('SELECT id,patient_id,status,plan_id FROM ortho_cases')) {
        return { rows: [{ id: 639752548, patient_id: 734599007, status: 'assessment', plan_id: decoded && drift ? 2 : 1 }] };
      }
    };
    if (drift) { await expect(recover(f)).rejects.toMatchObject({ status: 409, code: 'facial_submission_context_changed' }); expect(f.state.commits).toBe(1); }
    else { expect((await recover(f)).recovery).toMatchObject({ state: 'pending' }); expect(f.state.commits).toBe(2); }
    expect(f.images.verify).toHaveBeenCalledOnce(); clean(f);
  }
});
it('revocation before the phase-A final image assertion publishes only current metadata, never a native plan', async () => {
  for (const revoke of [false, true]) {
    const f = retained(); let ownerReads = 0, sourceReads = 0, revoked = false;
    const capabilities = await import('../lib/staff-capabilities'), predicate = capabilities.hasStaffCapability;
    // Synthetic predicate revocation, not mutation of the frozen admitted grants
    // and not a claim about real revocation through the lifecycle fence.
    const checked = vi.spyOn(capabilities, 'hasStaffCapability').mockImplementation((access, capability) =>
      revoked && capability === 'clinical.xrays.view' ? false : predicate(access, capability));
    f.state.hook = sql => {
      if (sql.includes('FROM patient_documents')) sourceReads++;
      if (sql.startsWith('SELECT id,patient_id,status,plan_id FROM ortho_cases')) ownerReads++;
      if (revoke && ownerReads === 2 && sql.startsWith('SELECT id,patient_id,ortho_case_id,specialty FROM clinical_cases')) revoked = true;
    };
    const result = await recover(f);
    expect(result.recovery).toMatchObject(revoke ? { state: 'blocked', canCancel: true } : { state: 'pending' });
    expect(sourceReads).toBeGreaterThan(0); expect(f.images.verify).toHaveBeenCalledTimes(revoke ? 0 : 1); expect(f.state.commits).toBe(revoke ? 1 : 2); clean(f); checked.mockRestore();
  }
});
it.each(['budget', 'deadline'] as const)('rejected-decode final owner %s failure cannot publish blocked metadata', async point => {
  for (const fail of [false, true]) {
    const f = retained(); f.state.onDecode = () => { throw new FacialFault(409, 'facial_image_decode'); };
    let matches = 0, expired = false; const stringify = JSON.stringify, now = performance.now.bind(performance);
    if (fail && point === 'budget') vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
      if (value && typeof value === 'object' && 'ok' in value && 'recovery' in value && ++matches === 2) return 'x'.repeat(FACIAL_READ_BYTES.recovery + 1);
      return Reflect.apply(stringify, JSON, [value, ...args]);
    }) as typeof JSON.stringify);
    if (fail && point === 'deadline') {
      vi.spyOn(performance, 'now').mockImplementation(() => now() + (expired ? 60000 : 0));
      f.state.hook = sql => { if (f.state.begins === 2 && sql.includes('FROM ortho_facial_submissions')) expired = true; };
    }
    if (fail) { await expect(recover(f)).rejects.toMatchObject({ status: 500, code: 'facial_core_context_changed' }); expect(f.state.commits).toBe(1); }
    else { expect((await recover(f)).recovery).toMatchObject({ state: 'blocked', canCancel: true }); expect(f.state.commits).toBe(2); }
    expect(f.images.verify).toHaveBeenCalledOnce(); clean(f); vi.restoreAllMocks();
  }
});
it('nullable source stage drift rejects while unchanged nonnull stage succeeds', async () => {
  for (const drift of [false, true]) {
    const f = retained(); f.h.doc = { ...f.h.doc, photo_stage: 'progress' };
    f.state.onDecode = () => { if (drift) f.h.doc = { ...f.h.doc, photo_stage: null }; };
    if (drift) { await expect(recover(f)).rejects.toMatchObject({ status: 409, code: 'facial_image_changed' }); expect(f.state.commits).toBe(1); }
    else { expect((await recover(f)).recovery).toMatchObject({ state: 'pending' }); expect(f.state.commits).toBe(2); }
    expect(f.images.verify).toHaveBeenCalledOnce(); clean(f);
  }
});
it.each(['acquire', 'begin'] as const)('phase-B %s failure after either decoder outcome cannot publish', async point => {
  for (const rejected of [false, true]) {
    const f = retained(); f.state.onDecode = () => {
      if (point === 'acquire') db.connect.mockRejectedValue(Error('private-driver'));
      if (rejected) throw new FacialFault(409, 'facial_image_decode');
    };
    if (point === 'begin') f.state.hook = sql => { if (sql.startsWith('BEGIN') && f.state.begins === 1) throw Error('private-driver'); };
    await expect(recover(f)).rejects.toMatchObject({ status: 500, code: 'facial_core_context_changed' });
    expect(f.state.commits).toBe(1); expect(f.images.verify).toHaveBeenCalledOnce(); clean(f);
  }
});
it.each([1, 2, 3])('journal read %i rejects malformed present rows and cardinality before copy', async ordinal => {
  for (const raw of [[null], [0], [[]], [submission(), submission()]]) {
    const f = retained(); let reads = 0;
    f.state.hook = sql => { if (sql.includes('FROM ortho_facial_submissions') && ++reads === ordinal) return { rows: raw }; };
    const clone = vi.spyOn(globalThis, 'structuredClone');
    await expect(recover(f)).rejects.toMatchObject({ status: 500, code: 'invalid_facial_submission' });
    expect(clone.mock.calls.some(([value]) => value === raw)).toBe(false);
    expect(f.images.verify).toHaveBeenCalledTimes(ordinal === 1 ? 0 : 1); expect(f.state.commits).toBe(ordinal === 1 ? 0 : 1); clean(f); clone.mockRestore();
  }
});
it('earlier patient membership denial wins before oversized owner data is reached', async () => {
  const f = retained(); f.state.inside = false; let ownerRead = false;
  f.state.hook = sql => { if (sql.startsWith('SELECT id,patient_id,status,plan_id FROM ortho_cases')) {
    ownerRead = true; return { rows: [{ id: 639752548, patient_id: 734599007, status: 'assessment', plan_id: null, extra: 'x'.repeat(FACIAL_READ_BYTES.witness) }] };
  } };
  await expect(recover(f)).rejects.toMatchObject({ status: 404, code: 'ortho_case_not_found' });
  expect(ownerRead).toBe(false); expect(f.images.verify).not.toHaveBeenCalled(); clean(f);
});
it('bounded native failures preserve only the fixed public message and category', async () => {
  const f = retained(); f.state.onDecode = () => { throw Error('/private/native SQL SELECT token=secret'); };
  await expect(recover(f)).rejects.toMatchObject({ status: 500, code: 'facial_core_context_changed', message: new FacialFault(500, 'facial_core_context_changed').message }); clean(f);
});
