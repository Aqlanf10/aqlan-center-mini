import { facialScenario } from './fixtures/ortho-facial-core';
import { createHash } from 'node:crypto';
const syntheticMismatchSha = createHash('sha256').update('synthetic companion refresh v1: independent facial mismatch').digest('hex');
// Provenance: core-derived values use the approved synthetic fixture. SQL/schema/error strings,
// negative identity sentinels, integer revisions, PNG signature and byte/count limits are test constants.
/** Inert discovery tests; synthetic transport is not a transaction owner. */
import { afterEach, expect, it, vi } from 'vitest';
import { FacialFault, type FacialSnapshotReadPorts } from '../lib/ortho-facial-core-contract';
import { discoverFacialRecoveryWith } from '../lib/ortho-facial-submission-core';
import { FACIAL_READ_BYTES, boundFacialRead, facialReadBytes, guardFacialReadRows, guardFacialRecoveryRows } from '../lib/ortho-facial-read-witness';
import { Harness, command, scope, submission } from './fixtures/ortho-facial-core';
const ports = (h: Harness) => h.read() as FacialSnapshotReadPorts;
const discover = (h: Harness) => discoverFacialRecoveryWith(h.client, scope, ports(h));
const clean = (h: Harness) => {
  expect(h.verify).not.toHaveBeenCalled(); expect(h.audits).toEqual([]);
  expect(h.logs.join('\n')).not.toMatch(/LOCK TABLE|FOR SHARE|FOR UPDATE|INSERT |UPDATE |DELETE |BEGIN|COMMIT/);
};
afterEach(() => vi.restoreAllMocks());
it.each(['write', 'legacy-read'] as const)('rejects %s before SQL', async mode => {
  const h = new Harness();
  const invalid = (mode === 'write' ? h.write() : h.legacy()) as unknown as FacialSnapshotReadPorts;
  await expect(discoverFacialRecoveryWith(h.client, scope, invalid)).rejects.toMatchObject({ code: 'facial_core_context_changed' });
  expect(h.logs).toEqual([]);
});
it('empty outstanding is current metadata, with no image/source/native preparation', async () => {
  const h = new Harness(); h.imageAllowed = false;
  expect(await discover(h)).toEqual({ kind: 'metadata', response: { ok: true, actorId: 695444321, scope: { ...scope, clinicalCaseId: 788771589 }, recovery: null } });
  expect(h.logs.join('\n')).not.toMatch(/patient_documents|ortho_facial_revisions/); clean(h);
});
it.each([null, undefined, false, 0, '', [], [1]])('present malformed raw row %j is not absence', async row => {
  const h = new Harness(), query = h.client.query;
  h.client.query = async <R extends object>(sql: string, values?: unknown[]) => sql.includes('FROM ortho_facial_submissions') ? { rows: [row] } as never : query<R>(sql, values);
  await expect(discover(h)).rejects.toMatchObject({ status: 500, code: 'invalid_facial_submission' }); clean(h);
});
it('cardinality rejects before element access or copy', () => {
  const rows = [submission(), submission()];
  Object.defineProperty(rows, '0', { get: () => { throw Error('must not iterate'); } });
  expect(() => guardFacialRecoveryRows(rows)).toThrow(expect.objectContaining({ status: 500, code: 'invalid_facial_submission' }));
  expect(() => guardFacialReadRows('SELECT * FROM ortho_facial_submissions WHERE ortho_case_id=$1 AND acknowledged_at IS NULL ', rows)).toThrow(expect.objectContaining({ status: 500, code: 'invalid_facial_submission' }));
});
it.each([
  ['id', 0], ['patient_id', -1], ['recorded_patient_id', null], ['ortho_case_id', 22], ['clinical_case_id', 0], ['actor_user_id', 0],
  ['command_id', 'bad'], ['request_fingerprint', 'bad'], ['state', 'other'], ['revision_id', 1], ['previous_version', -1],
  ['previous_version', '0'], ['acknowledged_at', new Date(facialScenario.acknowledged)], ['document_id', null], ['command', null],
] as const)('rejects corrupt envelope %s outside metadata mapping', async (key, value) => {
  const h = new Harness(); h.imageAllowed = false;
  h.onQuery = (sql, _values, rows) => { if (sql.includes('FROM ortho_facial_submissions')) rows.push(submission(command(), { [key]: value })); };
  await expect(discover(h)).rejects.toMatchObject({ status: 500, code: 'invalid_facial_submission' }); clean(h);
});
it.each([false, true])('cancelled receipt tombstone=%s is metadata only', async tombstone => {
  const h = new Harness(); h.imageAllowed = false;
  h.submissions = [submission(command(), { state: 'cancelled', ...(tombstone ? { command: null, document_id: null, previous_version: null } : {}) })];
  const result = await discover(h); expect(result).toMatchObject({ kind: 'metadata', response: { recovery: { state: 'cancelled', identity: { id: 750913085 } } } });
  expect(JSON.stringify(result)).not.toMatch(/expected|storage_key|"command"/); clean(h);
});
it.each(['actor_user_id', 'patient_id', 'recorded_patient_id', 'clinical_case_id'] as const)('foreign %s hides even a malformed private command', async key => {
  const h = new Harness(); h.submissions = [submission(command(), { [key]: 999, command: { private: 'not a command' } })];
  expect(await discover(h)).toMatchObject({ kind: 'metadata', response: { recovery: { state: 'blocked', identity: null, canCancel: false } } });
  expect(h.logs.join('\n')).not.toMatch(/patient_documents/); clean(h);
});
it.each(['schema', 'document', 'key', 'fingerprint', 'extra', 'version'] as const)('strict same-original corruption %s wins without images', async change => {
  const h = new Harness(), c = command(); h.imageAllowed = false;
  const row = submission(c); h.submissions = [row];
  if (change === 'schema') row.command = {};
  if (change === 'document') row.document_id = 52;
  if (change === 'key') row.command_id = 'different-command-0001';
  if (change === 'fingerprint') row.request_fingerprint = syntheticMismatchSha;
  if (change === 'extra') row.command = { ...c, extra: true };
  if (change === 'version') row.previous_version = 1;
  await expect(discover(h)).rejects.toMatchObject({ status: 500, code: 'invalid_facial_submission' }); clean(h);
});
it.each(['pending', 'committed'] as const)('image denial for %s has current conditional edit eligibility', async state => {
  for (const edit of [false, true]) {
    const h = new Harness(); h.imageAllowed = false; h.writeAllowed = edit;
    h.submissions = [submission(command(), { state, revision_id: state === 'committed' ? 674648274 : null })];
    expect(await discover(h)).toMatchObject({ kind: 'metadata', response: { recovery: { state: 'blocked', canCancel: state === 'pending' && edit,
      identity: state === 'pending' && edit ? { id: 750913085 } : null } } }); clean(h);
  }
});
it.each(['assessment', 'active', 'retention', 'completed', 'discontinued'])('returns detached bounded plain plan for owner %s', async status => {
  const h = new Harness(); h.status = status; const c = command(); h.submissions = [submission(c)];
  const plan = await discover(h); expect(plan.kind).toBe('needs-image');
  if (plan.kind !== 'needs-image') throw Error('expected eligible plan');
  expect(Object.keys(plan).sort()).toEqual(['kind', 'owner', 'row', 'source']);
  expect(plan.owner.recordingContext).toBe(['completed', 'discontinued'].includes(status) ? 'retrospective' : 'current');
  expect(plan.row.command).toEqual(c); expect(Object.isFrozen(plan.row.command.content.quality)).toBe(true);
  (h.submissions[0].command as typeof c).content.quality.note = 'driver mutated'; h.doc = { ...h.doc, title: 'driver mutated' };
  expect(plan.row.command.content.quality.note).toBe(''); expect(plan.source.title).toBe("Synthetic privacy fixture 13 04f3086d"); clean(h);
});
it.each(['missing-bridge', 'ambiguous-bridge', 'bad-state', 'wrong-owner'] as const)('owner failure %s is not blocked', async change => {
  const h = new Harness(); h.imageAllowed = false; h.submissions = [submission()];
  if (change === 'missing-bridge') h.bridges = 0;
  if (change === 'ambiguous-bridge') h.bridges = 2;
  if (change === 'bad-state') h.status = 'unknown';
  if (change === 'wrong-owner') h.patientId = 12;
  await expect(discover(h)).rejects.toThrow(); clean(h);
});
it.each(['archived', 'removed', 'nonfrontal', 'reassigned'] as const)('ineligible source %s gives bounded blocked metadata', async change => {
  const h = new Harness(); h.submissions = [submission()];
  if (change === 'archived') h.doc = { ...h.doc, photo_stage: 'archived' };
  if (change === 'removed') h.doc = { ...h.doc, removed_at: new Date(facialScenario.removed) };
  if (change === 'nonfrontal') h.doc = { ...h.doc, photo_view: 'other' };
  if (change === 'reassigned') h.doc = { ...h.doc, patient_id: 12 };
  const result = await discover(h); expect(result).toMatchObject({ kind: 'metadata', response: { recovery: { state: 'blocked', canCancel: true } } });
  expect(JSON.stringify(result)).not.toMatch(/storage_key|private-key|expected|"command"/); clean(h);
});
it('raw journal UTF-8 limit precedes kernel clone and strict command parsing', async () => {
  const h = new Harness(), row = { ...submission(), extra: 'é'.repeat(FACIAL_READ_BYTES.row) }, raw = [row];
  const query = h.client.query;
  h.client.query = async <R extends object>(sql: string, values?: unknown[]) => sql.includes('FROM ortho_facial_submissions') ? { rows: raw } as never : query<R>(sql, values);
  const clone = vi.spyOn(globalThis, 'structuredClone');
  await expect(discover(h)).rejects.toMatchObject({ status: 413, code: 'facial_history_too_large' });
  expect(clone.mock.calls.some(([value]) => value === raw || value === row)).toBe(false); clean(h);
});
it.each([FACIAL_READ_BYTES.witness, FACIAL_READ_BYTES.row, FACIAL_READ_BYTES.recovery])('synthetic bound utility accepts exact %i bytes, rejects plus one UTF-8 byte', limit => {
  // Utility coverage, not a claim that metadata/strict command grammar reaches this size.
  const value = { pad: 'é'.repeat((limit - 10) / 2) };
  expect(facialReadBytes(value)).toBe(limit); expect(() => boundFacialRead(value, limit)).not.toThrow();
  expect(() => boundFacialRead({ pad: value.pad + 'a' }, limit)).toThrow(expect.objectContaining({ status: 413, code: 'facial_history_too_large' }));
});
it('ordinary authority failure while rebuilding blocked metadata propagates', async () => {
  const h = new Harness(); h.submissions = [submission()]; h.imageAllowed = false;
  const p = ports(h), original = p.authority.assertImages;
  p.authority.assertImages = async (...args) => { try { return await original(...args); } finally { h.expired = true; } };
  await expect(discoverFacialRecoveryWith(h.client, scope, p)).rejects.toThrow('expired_authority'); clean(h);
});
it('unexpected image-authority error never becomes blocked', async () => {
  const h = new Harness(); h.submissions = [submission()]; const p = ports(h);
  p.authority.assertImages = async () => { throw new FacialFault(500, 'facial_image_decode'); };
  await expect(discoverFacialRecoveryWith(h.client, scope, p)).rejects.toMatchObject({ status: 500, code: 'facial_image_decode' }); clean(h);
});
it('raw valid outstanding row at exact 128 KiB is accepted; plus one byte fails before clone', async () => {
  for (const extra of [0, 1]) {
    const h = new Harness(), row = { ...submission(), padding: '' };
    row.padding = 'x'.repeat(FACIAL_READ_BYTES.row - facialReadBytes(row) + extra);
    const raw = [row], query = h.client.query;
    h.client.query = async <R extends object>(sql: string, values?: unknown[]) => sql.includes('FROM ortho_facial_submissions') ? { rows: raw } as never : query<R>(sql, values);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    if (extra) {
      await expect(discover(h)).rejects.toMatchObject({ status: 413 });
      expect(clone.mock.calls.some(([value]) => value === raw)).toBe(false);
    } else {
      const result = await discover(h); expect(result.kind).toBe('needs-image');
      expect(JSON.stringify(result)).not.toContain('padding'); expect(clone.mock.calls.some(([value]) => value === raw)).toBe(true);
    }
    clean(h); clone.mockRestore();
  }
});
it('query infrastructure failure is never outstanding absence', async () => {
  const h = new Harness(), query = h.client.query;
  h.client.query = async <R extends object>(sql: string, values?: unknown[]) => {
    if (sql.includes('FROM ortho_facial_submissions')) throw Error('missing table');
    return query<R>(sql, values);
  };
  await expect(discover(h)).rejects.toThrow('missing table'); clean(h);
});
it.each(['infrastructure', 'configuration'] as const)('blocked reconstruction edit eligibility %s failure propagates with a stable control', async failure => {
  for (const fail of [false, true]) {
    const h = new Harness(); h.submissions = [submission()]; h.imageAllowed = false;
    const p = ports(h), eligibility = vi.fn(async () => {
      if (fail && failure === 'infrastructure') throw Error('private eligibility transport');
      if (fail && failure === 'configuration') p.images.verify = async () => { throw Error('replacement must not run'); };
      return true;
    });
    p.authority.readWriteEligibility = eligibility;
    if (!fail) expect(await discoverFacialRecoveryWith(h.client, scope, p)).toMatchObject({ kind: 'metadata', response: { recovery: { state: 'blocked', canCancel: true } } });
    else if (failure === 'infrastructure') await expect(discoverFacialRecoveryWith(h.client, scope, p)).rejects.toThrow('private eligibility transport');
    else await expect(discoverFacialRecoveryWith(h.client, scope, p)).rejects.toMatchObject({ status: 500, code: 'facial_core_context_changed' });
    expect(eligibility).toHaveBeenCalledOnce(); clean(h);
  }
});
it.each([
  ['invalid-plan', 409, 'scope_mismatch'], ['absent-case', 404, 'ortho_case_not_found'], ['multiple-case', 404, 'ortho_case_not_found'],
  ['wrong-specialty', 409, 'scope_mismatch'], ['wrong-bridge-patient', 409, 'scope_mismatch'], ['wrong-bridge-case', 409, 'scope_mismatch'],
] as const)('owner corruption %s preserves exact current category', async (change, status, code) => {
  const h = new Harness(); h.submissions = [submission()]; h.imageAllowed = false;
  h.onQuery = (sql, _values, rows) => {
    if (sql.includes('FROM ortho_cases')) {
      if (change === 'invalid-plan') rows[0].plan_id = -1;
      if (change === 'absent-case') rows.length = 0;
      if (change === 'multiple-case') rows.push({ ...rows[0] });
    }
    if (sql.includes('FROM clinical_cases')) {
      if (change === 'wrong-specialty') rows[0].specialty = 'other';
      if (change === 'wrong-bridge-patient') rows[0].patient_id = 12;
      if (change === 'wrong-bridge-case') rows[0].ortho_case_id = 22;
    }
  };
  await expect(discover(h)).rejects.toMatchObject({ status, code }); clean(h);
});
it('direct helper last image assertion with live authority revocation cannot return a plan', async () => {
  for (const revoke of [false, true]) {
    const h = new Harness(); h.submissions = [submission()]; let owners = 0;
    h.onQuery = sql => {
      if (sql.includes('FROM ortho_cases')) owners++;
      if (revoke && owners === 2 && sql.includes('FROM clinical_cases')) h.imageAllowed = false;
    };
    const result = await discover(h);
    expect(result.kind).toBe(revoke ? 'metadata' : 'needs-image');
    if (revoke) expect(result).toMatchObject({ response: { recovery: { state: 'blocked', canCancel: true } } }); clean(h);
  }
});
