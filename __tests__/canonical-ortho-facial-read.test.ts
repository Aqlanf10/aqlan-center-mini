import { facialScenario } from './fixtures/ortho-facial-core';
/** Privacy basis: payload IDs, dates and clinical content come from the reviewed synthetic core.
 * Local small IDs are collision/mismatch or sequence witnesses; versions, byte limits,
 * SQL/HTTP codes, PNG signature and cardinalities are protocol/test-boundary constants.
 * Alternative text and mismatch SHA values below are newly authored synthetic data. */
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const db = vi.hoisted(() => ({ connect: vi.fn(), probe: vi.fn() }));
vi.mock('../lib/db', async original => ({ ...await original<typeof import('../lib/db')>(), getPool: () => ({ connect: db.connect }), usesSharedLocalDatabaseConnection: () => false }));
vi.mock('../lib/staff-runtime-probe.mjs', () => ({ inspectStaffRuntimeSchema: db.probe }));
import { facialReadFixture } from './fixtures/canonical-ortho-facial-read';
import { basis, scope, chain } from './fixtures/ortho-facial-core';
import { CANONICAL_RECORD_READS } from '../lib/canonical-record-reads';
import { FACIAL_READ_BYTES, boundFacialRead, guardFacialReadRows } from '../lib/ortho-facial-read-witness';
const selected = { ...scope, documentId: 679108321 };
const imageInput = { ...selected, sha256: basis.sha256 };
const fixture = () => facialReadFixture(db.connect, db.probe);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); db.connect.mockReset(); db.probe.mockReset(); });
it('registers exactly four fixed patient reads with conditional recovery images', () => {
  const entries = Object.entries(CANONICAL_RECORD_READS).filter(([key]) => key.startsWith('read:ortho.facial.'));
  expect(entries.map(([key]) => key).sort()).toEqual(['read:ortho.facial.analysis', 'read:ortho.facial.history', 'read:ortho.facial.image', 'read:ortho.facial.recovery']);
  for (const [key, rule] of entries) expect(rule).toEqual({ record: 'patient', need: key.endsWith('.recovery') ? ['clinical.ortho.view'] : ['clinical.ortho.view', 'clinical.xrays.view'], anyOf: [] });
});
it('runs actual RR owner twice, decodes between released leases, publishes plain JSON only', async () => {
  const f = fixture(), result = await f.reads.analysis(f.session, selected);
  expect(result.selectedDocumentId).toBe(679108321); expect(result.canWrite).toBe(true);
  expect(f.events).toEqual(['begin', 'commit', 'unlock', 'release', 'decode', 'begin', 'commit', 'unlock', 'release']);
  expect(f.sqls.filter(s => s.startsWith('BEGIN'))).toEqual(Array(2).fill('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  expect(f.sqls.join('\n')).not.toMatch(/FOR SHARE|FOR UPDATE|FOR NO KEY|LOCK TABLE|INSERT |DELETE |UPDATE |pg_current_xact_id/);
  expect(JSON.stringify(result)).not.toMatch(/storage_key|private-key|"Buffer"|base64/);
});
it('null selection is one snapshot with image admission but no native work', async () => {
  const f = fixture(); expect((await f.reads.analysis(f.session, { ...scope, documentId: null })).image).toBeNull();
  expect(f.state.begins).toBe(1); expect(f.images.verify).not.toHaveBeenCalled();
});
it.each(['analysis', 'history', 'image'] as const)('actual registry admission denies %s without either grant', async method => {
  for (const cap of ['clinical.ortho.view', 'clinical.xrays.view'] as const) {
    const f = fixture(); f.state.permission.grants[cap] = false;
    const operation = method === 'analysis' ? f.reads.analysis(f.session, selected) : method === 'image' ? f.reads.image(f.session, imageInput)
      : f.reads.history(f.session, { ...selected, beforeRevisionId: 674648274, beforeContentHash: "0019aa1466be75b00ca3d52e4ed7c36212cf9a55a28217bb1423850b09884a0c" });
    await expect(operation).rejects.toThrow(); expect(f.images.verify).not.toHaveBeenCalled(); expect(f.images.render).not.toHaveBeenCalled();
  }
});
it.each(['none', 'own-missing', 'all-absent'])('refuses %s patient, without role-based widening', async kind => {
  const f = fixture(); f.state.permission.patientScope = kind === 'none' ? 'none' : kind === 'all-absent' ? 'all' : 'own';
  f.state.inside = false; if (kind === 'all-absent') f.state.patient = false;
  await expect(f.reads.analysis(f.session, selected)).rejects.toThrow(); expect(f.images.verify).not.toHaveBeenCalled();
});
it.each(['assessment', 'active', 'retention', 'completed', 'discontinued'])('allows owner state %s without treatment reopening', async status => {
  const f = fixture(); f.h.status = status; expect((await f.reads.analysis(f.session, selected)).ok).toBe(true);
});
it.each([0, 2])('requires exactly one reverse bridge, found %i', async count => {
  const f = fixture(); f.h.bridges = count; await expect(f.reads.analysis(f.session, selected)).rejects.toThrow(); expect(f.images.verify).not.toHaveBeenCalled();
});
it.each([
  ['id', 52], ['patient_id', 12], ['ortho_case_id', 22], ['photo_stage', 'progress'], ['photo_stage', 'archived'], ['photo_view', 'other'], ['removed_at', new Date(facialScenario.removed)],
  ['sha256', "0019aa1466be75b00ca3d52e4ed7c36212cf9a55a28217bb1423850b09884a0c"], ['storage_key', 'synthetic-companion-v1/drift-source.png'], ['mime_type', 'image/jpeg'], ['size_bytes', '100'], ['title', 'Synthetic drift image title v1'], ['taken_on', facialScenario.driftDay],
] as const)('rejects interphase source field %s drift', async (key, value) => {
  const f = fixture(); f.state.onDecode = () => { f.h.doc = { ...f.h.doc, [key]: value }; };
  await expect(f.reads.image(f.session, imageInput)).rejects.toThrow(); expect(f.state.commits).toBe(1);
});
it.each(['grant', 'own', 'patient', 'bridge', 'status', 'actor', 'clinician'])('fresh final proof refuses changed %s', async change => {
  const f = fixture(); f.state.onDecode = () => {
    if (change === 'grant') f.state.permission.grants['clinical.xrays.view'] = false;
    if (change === 'own') f.state.inside = false;
    if (change === 'patient') f.h.patientId = 12;
    if (change === 'bridge') f.h.bridgeId = 32;
    if (change === 'status') f.h.status = 'active';
    if (change === 'actor') f.state.actor.role = 'admin';
    if (change === 'clinician') { f.state.actor.party_id = 22; f.state.provider.id = 22; }
  };
  await expect(f.reads.image(f.session, imageInput)).rejects.toThrow();
});
it.each(['image', 'clock', 'receiver'])('pins original service methods/receiver through decode: %s', async changed => {
  const f = fixture(); f.state.onDecode = () => {
    if (changed === 'image') f.images.verify = vi.fn(async () => basis);
    if (changed === 'clock') f.services.clock.today = () => facialScenario.driftDay;
    if (changed === 'receiver') f.services.images = { ...f.images };
  };
  await expect(f.reads.image(f.session, imageInput)).rejects.toMatchObject({ code: 'facial_core_context_changed' });
});
it('detaches request before first await and retains selected source outside document window', async () => {
  const f = fixture(), input = { ...selected }; f.h.documents = Array.from({ length: 101 }, (_, n) => ({ id: 1000 + n, title: 'SYN', sha256: basis.sha256, takenOn: null }));
  f.state.onDecode = () => { input.documentId = 999; input.patientId = 12; };
  const result = await f.reads.analysis(f.session, input);
  expect(result.selectedDocumentId).toBe(679108321); expect(result.documents).toHaveLength(100); expect(result.documentsTruncated).toBe(true); expect(result.documents.some(d => d.id === 679108321)).toBe(true);
});
it('initial sentinel is size-bounded but not deeply decoded', async () => {
  const f = fixture(); f.h.revisions = chain(31); f.h.revisions[0].command = 'malformed sentinel';
  const result = await f.reads.analysis(f.session, selected); expect(result.history).toHaveLength(30); expect(result.historyTruncated).toBe(true);
});
it('older page permits a newer head, but fully validates its sentinel', async () => {
  const f = fixture(); f.h.revisions = chain(33); const anchor = f.h.revisions[32];
  f.state.onDecode = () => { f.h.revisions = chain(34); };
  const input = { ...selected, beforeRevisionId: Number(anchor.id), beforeContentHash: String(anchor.content_sha256) };
  expect((await f.reads.history(f.session, input)).history).toHaveLength(30);
  const g = fixture(); g.h.revisions = chain(33); g.h.revisions[1].command = 'bad sentinel';
  await expect(g.reads.history(g.session, input)).rejects.toMatchObject({ code: 'facial_history_invalid' });
});
it.each(['commit', 'unlock', 'release', 'identity', 'expiry'])('PNG never escapes failed final %s', async point => {
  const f = fixture(); let delivered = false;
  f.state.hook = sql => {
    if (f.state.begins !== 2) return;
    if (point === 'commit' && sql === 'COMMIT') throw Error('private path');
    if (point === 'unlock' && sql.includes('pg_advisory_unlock_shared')) return { rows: [{ unlocked: false }] };
    if (point === 'release' && sql === 'COMMIT') f.state.releaseFailure = true;
    if (point === 'identity' && sql.includes('pg_locks')) return { rows: [{ virtualxid: 'wrong', isolation: 'repeatable read', read_only: 'on', in_recovery: false }] };
    if (point === 'expiry' && sql === 'COMMIT') vi.spyOn(Date, 'now').mockReturnValue(f.claims.expiresAt + 1);
  };
  await expect(f.reads.image(f.session, imageInput).then(value => { delivered = true; return value; })).rejects.toThrow(); expect(delivered).toBe(false);
});
it('successful private PNG is returned only after final release', async () => {
  const f = fixture(); const result = await f.reads.image(f.session, imageInput);
  expect(Buffer.isBuffer(result.png)).toBe(true); expect(f.state.releases).toBe(2); expect(f.events.at(-1)).toBe('release');
});
it.each([FACIAL_READ_BYTES.witness, FACIAL_READ_BYTES.row, FACIAL_READ_BYTES.page])('exact byte bound %i and one byte over are explicit', maximum => {
  expect(() => boundFacialRead('x'.repeat(maximum - 2), maximum)).not.toThrow();
  expect(() => boundFacialRead('x'.repeat(maximum - 1), maximum)).toThrow();
});
it('raw oversized sentinel fails before clone/decode, not hidden truncation', async () => {
  const f = fixture(); f.h.revisions = chain(31); f.h.revisions[0].extra = 'x'.repeat(FACIAL_READ_BYTES.row);
  await expect(f.reads.analysis(f.session, selected)).rejects.toMatchObject({ status: 413, code: 'facial_history_too_large' });
  expect(() => guardFacialReadRows('SELECT * FROM patient_documents LIMIT 101', Array(102).fill({}))).toThrow();
});
it('no app/default importer or recovery placeholder; only fixed factory methods', () => {
  const f = fixture(); expect(Object.keys(f.reads).sort()).toEqual(['analysis', 'history', 'image', 'recovery']);
  function walk(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : /\.[cm]?[jt]sx?$/.test(e.name) ? [join(dir, e.name)] : []); }
  for (const file of [...walk('app'), ...walk('lib')].filter(p => !p.endsWith('canonical-ortho-facial-read.ts'))) {
    expect(readFileSync(file, 'utf8')).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*canonical-ortho-facial-read["']/);
  }
  const code = readFileSync('lib/canonical-ortho-facial-read.ts', 'utf8');
  expect(code).not.toMatch(/readFacialPNGWith|staff-operation-runtime|sharp|ensureSchema|doctorOwnsPatient/);
  const submissionImports = [...code.matchAll(/import\s+([^;]+?)\s+from\s+['"]\.\/ortho-facial-submission-core['"]/g)];
  expect(submissionImports).toHaveLength(1);
  expect(submissionImports[0][1].replace(/[{}]/g, '').split(',').map(name => name.trim()).sort()).toEqual(['discoverFacialRecoveryWith', 'readFacialSubmissionRecoveryWith']);
  expect(code).not.toMatch(/(?:import|require)\s*\([^)]*ortho-facial-submission-core/);
  expect(code).not.toMatch(/reserveFacialSubmissionWith|executeReservedFacialWith|transitionFacialSubmissionWith|appendPreparedFacialRevisionWith|FacialWritePorts|runCanonicalWrite|BEGIN ISOLATION|COMMIT|ROLLBACK/);
});
it('actual runtime closes its guarded query/scope before publication', async () => {
  const f = fixture();
  const { runCanonicalReadSnapshot } = await import('../lib/canonical-read-snapshot');
  let leaked: import('../lib/canonical-read-snapshot').CanonicalSnapshotQuery | undefined;
  let admitted: import('../lib/canonical-read-snapshot').CanonicalSnapshotScope | undefined;
  await runCanonicalReadSnapshot(f.session, 'read:ortho.facial.analysis', async (q, scope) => {
    leaked = q; admitted = scope; return { ok: true };
  }, { errorPrefix: 'FACIAL_READ', maxBytes: 16 });
  expect(admitted!.granted('clinical.xrays.view')).toBe(false);
  expect(() => leaked!.query('SELECT id FROM patients WHERE id=$1', [734599007])).toThrow(/READ_CLOSED/);
});
it.each([0, 1, 30, 31])('initial revision count %i preserves empty/terminal/truncated behavior', async count => {
  const f = fixture(); f.h.revisions = chain(count);
  const result = await f.reads.analysis(f.session, selected);
  expect(result.history).toHaveLength(Math.min(30, count)); expect(result.historyTruncated).toBe(count > 30);
});
it.each([100, 101])('document count %i exposes at most 100 with exact truncation', async count => {
  const f = fixture(); f.h.documents = Array.from({ length: count }, (_, n) => ({ id: n === 0 ? 679108321 : 1000 + n, title: 'SYN', sha256: basis.sha256, takenOn: null }));
  const result = await f.reads.analysis(f.session, selected); expect(result.documents).toHaveLength(100); expect(result.documentsTruncated).toBe(count > 100);
});
it('write eligibility may be false without denying a valid clinical read', async () => {
  const f = fixture(); f.state.permission.grants['clinical.ortho.edit'] = false;
  expect((await f.reads.analysis(f.session, selected)).canWrite).toBe(false);
});
it('final snapshot re-reads the cursor hash, not a preloaded history page', async () => {
  const f = fixture(); f.h.revisions = chain(2); const anchor = f.h.revisions[1];
  f.state.onDecode = () => { f.h.revisions = []; };
  await expect(f.reads.history(f.session, { ...selected, beforeRevisionId: Number(anchor.id), beforeContentHash: String(anchor.content_sha256) })).rejects.toMatchObject({ code: 'facial_history_anchor_unavailable' });
});
it('decode failure leaks neither bytes nor service path and is replayed only after final proof', async () => {
  const f = fixture(); f.state.onDecode = () => { throw Error('private-key /private/file'); };
  await expect(f.reads.image(f.session, imageInput)).rejects.toMatchObject({ code: 'facial_core_context_changed' });
  expect(f.state.begins).toBe(2); expect(f.state.commits).toBe(1);
});
it('invalid source size is rejected before service invocation', async () => {
  for (const size of [' 100', '1e2', '0100', '0', -1, 25 * 1024 * 1024 + 1, Number.NaN]) {
    const f = fixture(); f.h.doc = { ...f.h.doc, size_bytes: size };
    await expect(f.reads.analysis(f.session, selected)).rejects.toMatchObject({ code: 'facial_image_integrity' }); expect(f.images.verify).not.toHaveBeenCalled();
  }
});
it('unrelated source drift fails before invoking the final exact-source verifier', async () => {
  const f = fixture(); f.state.onDecode = () => { f.h.doc = { ...f.h.doc, title: 'Synthetic alternative image title v1' }; };
  await expect(f.reads.analysis(f.session, selected)).rejects.toMatchObject({ code: 'facial_image_changed' });
  expect(f.images.verify).toHaveBeenCalledTimes(1); expect(f.state.commits).toBe(1);
});
it('configuration replaced during final commit cannot publish even plain JSON', async () => {
  const f = fixture(); f.state.hook = sql => {
    if (f.state.begins === 2 && sql === 'COMMIT') f.services.clock.today = () => facialScenario.driftDay;
  };
  await expect(f.reads.analysis(f.session, selected)).rejects.toMatchObject({ code: 'facial_core_context_changed' });
});
// Independent-review regressions, added after unchanged 66-test green baseline.
it.each(['expiry', 'config', 'grant', 'source', 'owner'])('rejected decoder cannot mask interphase %s', async change => {
  const f = fixture();
  const { FacialFault } = await import('../lib/ortho-facial-core-contract');
  f.state.onDecode = () => {
    if (change === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(f.claims.expiresAt + 1);
    if (change === 'config') f.services.clock.today = () => facialScenario.driftDay;
    if (change === 'grant') f.state.permission.grants['clinical.xrays.view'] = false;
    if (change === 'source') f.h.doc = { ...f.h.doc, title: 'Synthetic failed-decode image title v1' };
    if (change === 'owner') f.h.bridgeId = 32;
    throw new FacialFault(409, 'facial_image_decode');
  };
  const expected = change === 'expiry' ? 'facial_authority_changed' : change === 'source' ? 'facial_image_changed' : change === 'owner' ? 'facial_submission_context_changed' : 'facial_core_context_changed';
  await expect(f.reads.image(f.session, imageInput)).rejects.toMatchObject({ code: expected });
});
it.each(['analysis', 'history', 'image'] as const)('unchanged-source failed %s decoder still re-proves source in a fresh snapshot', async method => {
  const f = fixture(); const { FacialFault } = await import('../lib/ortho-facial-core-contract');
  f.state.onDecode = () => { throw new FacialFault(409, 'facial_image_decode'); };
  const run = method === 'analysis' ? f.reads.analysis(f.session, selected) : method === 'image' ? f.reads.image(f.session, imageInput)
    : f.reads.history(f.session, { ...selected, beforeRevisionId: 674648274, beforeContentHash: "0019aa1466be75b00ca3d52e4ed7c36212cf9a55a28217bb1423850b09884a0c" });
  await expect(run).rejects.toMatchObject({ code: 'facial_image_decode' });
  expect(f.state.begins).toBe(2); expect(f.state.commits).toBe(1);
  expect(f.sqls.filter(s => s.startsWith('SELECT photo_stage'))).toHaveLength(2);
});
it.each(['ortho_cases', 'clinical_cases'])('bounds raw %s owner row before the core clone', async table => {
  const f = fixture(); const raw = [{ id: 639752548, patient_id: 734599007, status: 'assessment', plan_id: null, oversize: 'x'.repeat(FACIAL_READ_BYTES.witness) }];
  const clone = structuredClone; let copied = false;
  vi.spyOn(globalThis, 'structuredClone').mockImplementation(value => { if (value === raw) copied = true; return clone(value); });
  f.state.hook = sql => sql.startsWith('SELECT id,patient_id') && sql.includes(`FROM ${table}`) ? { rows: raw } : undefined;
  await expect(f.reads.analysis(f.session, selected)).rejects.toMatchObject({ status: 413 });
  expect(f.images.verify).not.toHaveBeenCalled(); expect(copied).toBe(false);
});
it.each(['ortho_cases', 'clinical_cases'])('rejects excessive raw %s owner count before cloning', table => {
  const sql = `SELECT id,patient_id FROM ${table}`;
  expect(() => guardFacialReadRows(sql, Array(1000).fill({}))).toThrow();
});
it('raw oversized revision never reaches core structuredClone', async () => {
  const f = fixture(), raw = [{ ...chain(1)[0], extra: 'x'.repeat(FACIAL_READ_BYTES.row) }];
  const clone = structuredClone; let copied = false;
  vi.spyOn(globalThis, 'structuredClone').mockImplementation(value => { if (value === raw) copied = true; return clone(value); });
  f.state.hook = sql => sql.startsWith('SELECT * FROM ortho_facial_revisions') ? { rows: raw } : undefined;
  await expect(f.reads.analysis(f.session, selected)).rejects.toMatchObject({ status: 413 }); expect(copied).toBe(false);
});
it('final unlock transport rejection and missing schema never publish bytes or empty history', async () => {
  const f = fixture(); f.state.hook = sql => {
    if (f.state.begins === 2 && sql.includes('pg_advisory_unlock_shared')) throw Error('transport path');
  };
  await expect(f.reads.image(f.session, imageInput)).rejects.toThrow();
  const g = fixture(); g.state.hook = sql => { if (sql.includes('FROM ortho_facial_revisions')) throw Object.assign(Error('missing private table'), { code: '42P01' }); };
  await expect(g.reads.analysis(g.session, selected)).rejects.toThrow();
});
it('final PNG-ready result budget failure cannot publish the privately held PNG', async () => {
  const f = fixture(), stringify = JSON.stringify;
  vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
    if (value && typeof value === 'object' && 'basis' in value && 'sha256' in value && 'documentId' in value) return 'x'.repeat(FACIAL_READ_BYTES.witness + 1);
    return Reflect.apply(stringify, JSON, [value, ...args]);
  }) as typeof JSON.stringify);
  await expect(f.reads.image(f.session, imageInput)).rejects.toThrow(); expect(f.state.commits).toBe(1);
});
