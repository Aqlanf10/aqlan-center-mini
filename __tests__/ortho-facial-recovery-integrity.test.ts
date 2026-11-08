import { facialScenario } from './fixtures/ortho-facial-core';
// Provenance: core-derived values use the approved synthetic fixture. SQL/schema/error strings,
// negative identity sentinels, integer revisions, PNG signature and byte/count limits are test constants.
/** Isolated recovery regression. Actual prepare/inspect and recovery, protocol IO double only. */
import { describe, expect, it } from 'vitest';
import { FacialFault } from '../lib/ortho-facial-core-contract';
import { readFacialSubmissionRecoveryWith } from '../lib/ortho-facial-submission-core';
import { Harness, chain, command, revision, scope, submission } from './fixtures/ortho-facial-core';

for (const mode of ['snapshot-read', 'legacy-read'] as const) describe(`recovery integrity (${mode})`, () => {
  const recover = (h: Harness) => readFacialSubmissionRecoveryWith(h.client, scope, h.read(mode));
  function retained(state: 'pending' | 'committed', newerHead = false) {
    const h = new Harness();
    h.revisions = chain(1);
    const c = command({ clientRequestId: 'recovery-integrity-0002', expectedHeadId: 674648274 });
    if (state === 'committed') h.revisions.push(revision(c, 2, 102));
    if (newerHead) h.revisions.push(revision(command({ clientRequestId: 'recovery-newer-head-003', expectedHeadId: 102 }), 3, 103));
    h.submissions = [submission(c, { state, revision_id: state === 'committed' ? 102 : null })];
    return h;
  }
  const noWrites = (h: Harness) => {
    expect(h.logs.filter(sql => /^(INSERT|UPDATE|DELETE)/.test(sql))).toEqual([]);
    expect(h.audits).toEqual([]);
  };
  it.each(['pending', 'committed'] as const)('rejects well-shaped wrong positive previous_version for %s', async state => {
    const h = retained(state); h.submissions[0].previous_version = 7;
    // expectedHeadId remains nonnull and 7 is a safe positive integer: decode alone accepts it.
    await expect(recover(h)).rejects.toMatchObject({ status: 500, code: 'invalid_facial_submission' });
    expect(h.verify).toHaveBeenCalledOnce(); noWrites(h);
  });
  it('rejects committed revision_id different from the actual exact replay', async () => {
    const h = retained('committed'); h.submissions[0].revision_id = 999;
    await expect(recover(h)).rejects.toMatchObject({ status: 500, code: 'invalid_facial_submission' });
    expect(h.verify).toHaveBeenCalledOnce(); noWrites(h);
  });
  it('rejects committed receipt with missing replay despite a preparable current predecessor', async () => {
    const h = retained('pending'); h.submissions[0].state = 'committed'; h.submissions[0].revision_id = 102;
    // Current head 101 matches the retained command, so preparation succeeds with replayId=null.
    await expect(recover(h)).rejects.toMatchObject({ status: 500, code: 'invalid_facial_submission' });
    expect(h.verify).toHaveBeenCalledOnce(); noWrites(h);
  });
  it.each(['pending', 'committed'] as const)('preserves valid %s retained payload', async state => {
    const h = retained(state);
    const result = await recover(h);
    expect(result.recovery).toMatchObject({ state, identity: { id: 750913085 }, expected: { previousVersion: 1, command: h.submissions[0].command } });
    expect(h.verify).toHaveBeenCalledOnce(); noWrites(h);
  });
  it('preserves exact replay predecessor version after a newer head', async () => {
    const h = retained('committed', true);
    expect((await recover(h)).recovery).toMatchObject({ state: 'committed', expected: { previousVersion: 1 } });
    expect(h.verify).toHaveBeenCalledOnce(); noWrites(h);
  });
  it('keeps cancelled receipts metadata-only even without image access', async () => {
    const h = retained('pending'); h.submissions[0].state = 'cancelled'; h.imageAllowed = false;
    expect((await recover(h)).recovery).toEqual({ state: 'cancelled', identity: { id: 750913085, commandId: h.submissions[0].command_id, requestFingerprint: h.submissions[0].request_fingerprint } });
    expect(h.verify).not.toHaveBeenCalled(); noWrites(h);
  });
  it.each(['committed', 'cancelled'] as const)('excludes acknowledged %s receipt with pruned command', async state => {
    const h = retained(state === 'committed' ? state : 'pending');
    Object.assign(h.submissions[0], { state, acknowledged_at: new Date(facialScenario.acknowledged), command: null });
    h.imageAllowed = false;
    expect((await recover(h)).recovery).toBeNull();
    expect(h.verify).not.toHaveBeenCalled(); noWrites(h);
  });
  it.each(['actor_user_id', 'recorded_patient_id'] as const)('withholds foreign %s receipt payload and cancellation', async key => {
    const h = retained('committed'); h.submissions[0][key] = 999;
    expect((await recover(h)).recovery).toEqual({ state: 'blocked', identity: null, canCancel: false });
    expect(h.verify).not.toHaveBeenCalled(); noWrites(h);
  });
  it.each(['pending', 'committed'] as const)('preserves image denial mapping for %s', async state => {
    const h = retained(state); h.imageAllowed = false;
    expect((await recover(h)).recovery).toMatchObject({ state: 'blocked', canCancel: state === 'pending', identity: state === 'pending' ? { id: 750913085 } : null });
    expect(h.verify).not.toHaveBeenCalled(); noWrites(h);
  });
  it('does not map an unexpected verifier integrity fault to cancellable metadata', async () => {
    const h = retained('pending'); h.verifyError = new FacialFault(500, 'invalid_facial_submission');
    await expect(recover(h)).rejects.toMatchObject({ status: 500, code: 'invalid_facial_submission' });
    noWrites(h);
  });
});
