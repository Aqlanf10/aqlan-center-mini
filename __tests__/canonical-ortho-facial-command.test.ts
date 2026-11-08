import { facialScenario } from './fixtures/ortho-facial-core';
/** Privacy basis: payload IDs, dates and clinical content come from the reviewed synthetic core.
 * Local small IDs are collision/mismatch or sequence witnesses; versions, byte limits,
 * SQL/HTTP codes, PNG signature and cardinalities are protocol/test-boundary constants.
 * Alternative text and mismatch SHA values below are newly authored synthetic data. */
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const controlled = vi.hoisted(() => ({ proof: vi.fn(), audit: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined) }));
vi.mock('../lib/staff-authority-proof-internal', () => ({ loadLockedStaffAuthority: controlled.proof }));
vi.mock('../lib/db', async original => ({ ...await original<typeof import('../lib/db')>(), insertAuditRow: controlled.audit }));
import { canonicalFixture } from './fixtures/canonical-ortho-facial';
import { command, expected, submission, revision } from './fixtures/ortho-facial-core';
import { createCanonicalFacialCommands } from '../lib/canonical-ortho-facial-command';
import { journeyContentHash } from '../lib/ortho-case-journey-hash';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); controlled.proof.mockReset(); controlled.audit.mockReset(); });
function fixture() {
  const f = canonicalFixture(controlled.proof);
  return { ...f, commands: createCanonicalFacialCommands({ pool: f.pool, images: { verify: f.h.verify }, clock: { today: () => f.h.today } }) };
}
const input = () => ({ ...expected, command: command() });
const transition = (action: 'cancel' | 'acknowledge') => ({ ...expected, commandId: command().clientRequestId, requestFingerprint: journeyContentHash(command()), action });

it('commits reserve before execute using fresh real lifetimes even on the same client', async () => {
  const f = fixture(); const result = await f.commands.save(f.session, input());
  expect(result.revision.id).toBe(674648274);
  expect(f.state.xid).toBe(2); expect(f.state.commits).toBe(2);
  const commit = f.sqls.indexOf('COMMIT'), second = f.sqls.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED', 1);
  expect(commit).toBeLessThan(second);
  expect(controlled.audit.mock.calls.map(c => (c as unknown[])[1])).toEqual([
    expect.objectContaining({ action: 'ortho.facial_submission', details: expect.objectContaining({ event: 'reserved' }) }),
    expect.objectContaining({ action: 'ortho.facial_revision' }),
    expect.objectContaining({ action: 'ortho.facial_submission', details: expect.objectContaining({ event: 'committed' }) }),
  ]);
  expect(controlled.audit.mock.calls.every(c => c[0] === f.client)).toBe(true);
  const fences = f.sqls.indexOf('LOCK TABLE ortho_facial_submissions IN ROW EXCLUSIVE MODE');
  expect(fences).toBeLessThan(f.sqls.indexOf('SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE'));
  const source = f.sqls.findIndex(s => s.includes('FROM patient_documents') && s.includes('FOR SHARE NOWAIT'));
  const owner = f.sqls.findIndex(s => s.startsWith('SELECT id,patient_id,status,plan_id') && s.includes('FOR UPDATE NOWAIT'));
  expect(source).toBeLessThan(owner);
});
it('detaches the entire strict request before the reserve await', async () => {
  const f = fixture(), original = input();
  f.hook(sql => { if (sql === 'COMMIT' && f.state.commits === 0) { original.actorId = 99; original.clinicalCaseId = 99; original.command.clientRequestId = 'replacement-key-0001'; original.command.content.image.sha256 = "0019aa1466be75b00ca3d52e4ed7c36212cf9a55a28217bb1423850b09884a0c"; } });
  await f.commands.save(f.session, original);
  expect(f.h.revisions[0].command_id).toBe(command().clientRequestId);
  expect(f.h.revisions[0].actor_user_id).toBe(695444321);
});
it.each([1, 2])('propagates uncertain commit %i without retry or replacement key', async commit => {
  const f = fixture(); f.state.commitErrorAt = commit;
  await expect(f.commands.save(f.session, input())).rejects.toBe(f.state.commitError);
  expect(f.state.xid).toBe(commit); expect(f.sqls.filter(s => s === 'COMMIT')).toHaveLength(commit);
  expect(f.sqls).toContain('ROLLBACK');
});
it('uncertain acknowledgment propagates and permits only caller-driven identical replay', async () => {
  const f = fixture(); f.h.submissions = [submission(command(), { state: 'cancelled' })]; f.state.image = false; f.state.commitErrorAt = 1;
  await expect(f.commands.transition(f.session, transition('acknowledge'))).rejects.toBe(f.state.commitError);
  expect(f.state.xid).toBe(1); expect(f.h.verify).not.toHaveBeenCalled();
});
it.each(['55P03', '40P01', '40001'])('maps only PostgreSQL conflict %s, after rollback, without retry', async code => {
  const f = fixture(); f.hook(sql => { if (sql.startsWith('LOCK TABLE')) throw Object.assign(Error('contention'), { code }); });
  await expect(f.commands.reserve(f.session, input())).rejects.toMatchObject({ status: 409, code: 'facial_conflict' });
  expect(f.state.xid).toBe(1); expect(f.sqls).toContain('ROLLBACK');
});
it.each(['audit', 'mutation', 'transport'])('propagates %s failure and rolls back owning mutation', async kind => {
  const f = fixture(), error = Error(kind);
  if (kind === 'audit') controlled.audit.mockRejectedValueOnce(error);
  else f.hook(sql => { if (sql.startsWith(kind === 'mutation' ? 'INSERT INTO' : 'LOCK TABLE')) throw error; });
  await expect(f.commands.save(f.session, input())).rejects.toBe(error);
  expect(f.h.submissions).toHaveLength(0); expect(f.state.xid).toBe(1); expect(f.sqls).toContain('ROLLBACK');
});
it('new reserve needs images; identity reserve does not and neither duplicates audit nor reveals payload', async () => {
  const f = fixture(); f.state.image = false;
  await expect(f.commands.reserve(f.session, input())).rejects.toMatchObject({ code: 'image_access_denied' });
  f.h.submissions = [submission()];
  expect(await f.commands.reserve(f.session, input())).toEqual({ ok: true, identity: { id: 750913085, commandId: command().clientRequestId, requestFingerprint: journeyContentHash(command()) } });
  expect(controlled.audit).not.toHaveBeenCalled(); expect(f.h.verify).not.toHaveBeenCalled();
});
it('exact execution replay still requires images, but adds no duplicate audit', async () => {
  const f = fixture(); await f.commands.save(f.session, input()); const count = controlled.audit.mock.calls.length;
  await f.commands.execute(f.session, input()); expect(controlled.audit).toHaveBeenCalledTimes(count);
  f.state.image = false;
  await expect(f.commands.execute(f.session, input())).rejects.toMatchObject({ code: 'image_access_denied' });
});
it.each(['decode', 'audit'])('image revocation during %s prevents protected success', async point => {
  const f = fixture();
  if (point === 'decode') f.h.onVerify = () => { f.state.image = false; };
  else controlled.audit.mockImplementationOnce(async () => { f.state.image = false; });
  await expect(f.commands.reserve(f.session, input())).rejects.toThrow();
  expect(f.sqls).toContain('ROLLBACK'); expect(f.h.submissions).toHaveLength(0);
});
it.each(['actorId', 'clinicalCaseId'])('treats %s as expectation, never authority selector', async field => {
  const f = fixture();
  await expect(f.commands.reserve(f.session, { ...input(), [field]: 999 })).rejects.toMatchObject({ code: field === 'actorId' ? 'facial_submission_actor_changed' : 'facial_submission_context_changed' });
  expect(controlled.audit).not.toHaveBeenCalled();
});
it('preserves exact key/hash and original patient constraints', async () => {
  const f = fixture(); f.h.submissions = [submission()];
  await expect(f.commands.reserve(f.session, { ...expected, command: command({ reason: 'Synthetic alternate command v1' }) })).rejects.toMatchObject({ code: 'request_key_conflict' });
  f.h.submissions[0].recorded_patient_id = 12;
  await expect(f.commands.reserve(f.session, input())).rejects.toMatchObject({ code: 'facial_submission_context_changed' });
});
it('cancel/ack hidden image uses provenance only, terminal replay adds no audit', async () => {
  const f = fixture(); f.h.submissions = [submission()]; f.state.image = false; f.h.doc = { ...f.h.doc, removed_at: new Date(facialScenario.removed), photo_view: 'other' };
  await f.commands.transition(f.session, transition('cancel'));
  await f.commands.transition(f.session, transition('acknowledge'));
  const count = controlled.audit.mock.calls.length;
  await f.commands.transition(f.session, transition('acknowledge'));
  expect(controlled.audit).toHaveBeenCalledTimes(count); expect(f.h.verify).not.toHaveBeenCalled();
});
it.each(['pending', 'cancelled', 'committed'])('does not relax wrong case provenance for unacknowledged %s', async state => {
  const f = fixture(); f.h.submissions = [submission(command(), { state, revision_id: state === 'committed' ? 674648274 : null })]; f.h.doc = { ...f.h.doc, ortho_case_id: 22 };
  await expect(f.commands.transition(f.session, transition(state === 'pending' ? 'cancel' : 'acknowledge'))).rejects.toThrow();
});
it('only cancelled AND acknowledged can retain reassigned same-patient document', async () => {
  const f = fixture(); f.state.image = false; f.h.submissions = [submission(command(), { state: 'cancelled', acknowledged_at: new Date(facialScenario.acknowledged), command: null })]; f.h.doc = { ...f.h.doc, ortho_case_id: 22 };
  await f.commands.transition(f.session, transition('acknowledge'));
  f.h.doc = { ...f.h.doc, patient_id: 12 };
  await expect(f.commands.transition(f.session, transition('acknowledge'))).rejects.toThrow();
});
it('null-document cancellation does not query images and excludes pre-journal revisions', async () => {
  const f = fixture(); f.state.image = false;
  await f.commands.transition(f.session, transition('cancel'));
  expect(f.sqls.some(s => s.includes('FROM patient_documents'))).toBe(false); expect(f.h.verify).not.toHaveBeenCalled();
  const g = fixture(); g.state.image = false; g.h.revisions = [revision()];
  await expect(g.commands.transition(g.session, transition('cancel'))).rejects.toThrow();
});
it('rejects malformed requests before opening a transaction', async () => {
  const f = fixture();
  expect(() => f.commands.reserve(f.session, { ...input(), command: { ...command(), extra: true } })).toThrow();
  expect(() => f.commands.transition(f.session, { ...transition('cancel'), commandId: 'short' })).toThrow();
  expect(f.pool.connect).not.toHaveBeenCalled();
});
it('remains inactive, with required image/clock ports and no read or alternate append API', () => {
  const f = fixture(); expect(Object.keys(f.commands).sort()).toEqual(['execute', 'reserve', 'save', 'transition']);
  const names = ['canonical-ortho-facial-authority', 'canonical-ortho-facial-command', 'ortho-facial-audit-adapter'];
  for (const name of names) {
    const text = readFileSync(join(process.cwd(), 'lib', `${name}.ts`), 'utf8');
    expect(text).not.toMatch(/\b(?:getPool|recordAudit|legacySession|SessionPayload|ensureSchema|saveJournaledFacial|sharp)\b/);
    expect(text).not.toMatch(/clinical\.(?:plans|care)|patients\.edit|finance\./);
    expect(text).not.toMatch(/\.query\(['"](?:BEGIN|COMMIT|ROLLBACK)/);
  }
  function walk(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : /\.[cm]?[jt]sx?$/.test(e.name) ? [join(dir, e.name)] : []); }
  for (const file of [...walk('app'), ...walk('lib')].filter(f => !names.some(n => f.endsWith(`${n}.ts`)))) {
    expect(readFileSync(file, 'utf8')).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*(?:canonical-ortho-facial-command|canonical-ortho-facial-authority|ortho-facial-audit-adapter)["']/);
  }
});

it.each([
  ['image', 'admission'], ['clock', 'admission'],
  ['image', 'decode'], ['clock', 'decode'],
  ['image', 'reserve-commit'], ['clock', 'reserve-commit'],
] as const)('dependency mutation: refuses original %s method replacement during %s', async (dependency, point) => {
  const f = canonicalFixture(controlled.proof);
  const images = { verify: f.h.verify }, clock = { today: () => f.h.today };
  const replacementImage = vi.fn(async () => ({ ...command().content.image }));
  const replacementClock = vi.fn(() => f.h.today);
  const commands = createCanonicalFacialCommands({ pool: f.pool, images, clock });
  let mutated = false;
  const mutate = () => {
    mutated = true;
    if (dependency === 'image') images.verify = replacementImage;
    else clock.today = replacementClock;
  };
  if (point === 'decode') f.h.onVerify = mutate;
  else f.hook(sql => {
    if (!mutated && (point === 'admission' ? sql === 'SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE' : sql === 'COMMIT')) mutate();
  });
  await expect(commands.save(f.session, input())).rejects.toMatchObject({ code: 'facial_core_context_changed' });
  expect(mutated).toBe(true);
  expect(replacementImage).not.toHaveBeenCalled(); expect(replacementClock).not.toHaveBeenCalled();
  expect(f.state.xid).toBe(1);
  if (point !== 'reserve-commit') { expect(f.sqls).toContain('ROLLBACK'); expect(f.h.submissions).toHaveLength(0); }
  else { expect(f.state.commits).toBe(1); expect(f.h.submissions).toHaveLength(1); }
});
it('dependency mutation: unchanged original methods preserve this and both committed lifetimes', async () => {
  const f = canonicalFixture(controlled.proof);
  const images = { sentinel: 'image-owner', async verify(source: Parameters<typeof f.h.verify>[0]) {
    expect(this).toBe(images); expect(this.sentinel).toBe('image-owner'); return f.h.verify(source);
  } };
  const clock = { date: f.h.today, today() { expect(this).toBe(clock); return this.date; } };
  const commands = createCanonicalFacialCommands({ pool: f.pool, images, clock });
  await commands.save(f.session, input());
  expect(f.state.commits).toBe(2); expect(f.state.xid).toBe(2);
  expect(f.h.verify).toHaveBeenCalledTimes(2);
});
