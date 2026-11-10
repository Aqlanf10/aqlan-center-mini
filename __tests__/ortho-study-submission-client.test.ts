import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeStudyOwner } from '../lib/ortho-case-study-owner';
import { makeStudyRecoveryLedger } from '../lib/ortho-case-study-recovery';
import { journeyContentHash } from '../lib/ortho-case-journey-hash';
import { CASE_TEMPLATE_IDENTITY, CASE_TEMPLATE_VERSION } from '../lib/ortho-case-template';
import { readStudyEditorDraft } from '../lib/ortho-case-study-editor-draft';
import type { StudySaveExpectation } from '../lib/ortho-case-study-editor-response';
import type { StudySubmissionRecovery } from '../lib/ortho-study-submission-contract';
import { canCancelStudySubmission, canRetryStudySubmission, cancelAndAcknowledgeStudy, fetchStudySubmissionRecovery, submitAndAcknowledgeStudy, verifyStudySubmissionTransition } from '../lib/ortho-study-submission-client';
const scope = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
function expected(): StudySaveExpectation {
  return { scope, actorId: 7, previousVersion: 0, command: { schemaVersion: 1, clientRequestId: 'synthetic_study_command_001', expectedHead: null,
    baseDocumentedRevision: null, documentedFrom: null, kind: 'draft', reason: 'Synthetic draft', content: {
      template: { key: 'full-orthodontic-case', version: CASE_TEMPLATE_VERSION, contentHash: journeyContentHash(CASE_TEMPLATE_IDENTITY) },
      identityDisclosure: 'case_only', sources: [], groups: [], mediaUses: [], comment: 'Synthetic retained text', panels: [
        { instanceId: 'cover1', layoutKey: 'cover', state: 'not_recorded', included: true, sourceKeys: [], images: [], comment: '' }] } } };
}
const identity = (value = expected()) => ({ id: 11, commandId: value.command.clientRequestId, requestFingerprint: journeyContentHash(value.command) });
const recovery = (state: 'pending' | 'committed' = 'pending', value = expected()): StudySubmissionRecovery => ({ ok: true, actorId: 7, scope, recovery: { state, identity: identity(value), expected: value } });
const receipt = (state: 'committed' | 'cancelled', acknowledged: boolean, value = expected()) => ({ ok: true, actorId: 7, scope, identity: identity(value), state, acknowledged });
const json = (value: unknown, status = 200, cache = 'no-store') => new Response(JSON.stringify(value), { status, headers: { 'Cache-Control': cache, 'Content-Type': 'application/json' } });
function saved(value = expected(), replayed = false) {
  return { ok: true, replayed, ...scope, revision: { ...scope, actorId: 7, id: 91, version: 1, kind: 'draft', contentHash: 'a'.repeat(64), predecessorId: null,
    documentedFromId: null, baseDocumentedId: null, createdAt: '2026-10-01T00:00:00.000Z', reason: value.command.reason,
    capturedAt: '2026-10-01T00:00:00.000Z', caseStatusAtCapture: 'active',
    authored: value.command.content, authoredHash: journeyContentHash(value.command.content) } };
}
function setup() {
  const ledger = makeStudyRecoveryLedger();
  const deny = vi.fn(), owner = makeStudyOwner({ ...scope, actorId: 7, recovery: ledger, authorized: () => true, writable: () => true, deny }); owner.activate();
  return { owner, scope, current: () => owner.active(), deny, ledger };
}
function unresolved(context = setup(), value = expected()) {
  context.owner.restore(value); return context;
}
afterEach(() => vi.unstubAllGlobals());
describe('durable study recovery browser boundary', () => {
  it.each(['pending', 'committed'] as const)('adopts exact %s request on a true reload with an empty browser ledger', async state => {
    const context = setup(), value = expected(), fetcher = vi.fn().mockResolvedValue(json(recovery(state, value))); vi.stubGlobal('fetch', fetcher);
    const result = await fetchStudySubmissionRecovery(context);
    expect(result.conflict).toBe(false); expect(context.owner.uncertain).toBe(true); expect(context.owner.editable()).toBe(false);
    expect(readStudyEditorDraft(context.owner.document).content).toEqual(value.command.content);
    expect(context.owner.retryExpectation).toEqual(value);
    const retry = context.owner.beginRetry()!; expect(JSON.parse(retry.body)).toEqual({ patientId: scope.patientId, clinicalCaseId: scope.clinicalCaseId, actorId: value.actorId, command: value.command }); retry.finish();
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
  });
  it('does not overwrite conflicting local dirty text and blocks retry', async () => {
    const context = setup(); context.owner.change('Synthetic conflicting local draft');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(recovery())));
    const result = await fetchStudySubmissionRecovery(context);
    expect(result.conflict).toBe(true); expect(canRetryStudySubmission(result)).toBe(false); expect(context.owner.document).toBe(''); expect(context.owner.draftQuarantined).toBe(true);
    expect(context.ledger.forDraftOwner(scope, 7).read()?.owned?.document).toBe('Synthetic conflicting local draft');
    expect(context.owner.retryExpectation).toBeNull();
  });
  it('does not treat no receipt as proof a delayed POST cannot commit', async () => {
    const context = unresolved(); const before = context.owner.document;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: true, actorId: 7, scope, recovery: null })));
    const result = await fetchStudySubmissionRecovery(context);
    expect(result.receipt).toBeNull(); expect(context.owner.uncertain).toBe(true); expect(context.owner.document).toBe(''); expect(context.owner.draftQuarantined).toBe(true);
    expect(context.ledger.forOwner(scope, 7).read()?.owned?.document).toBe(before);
    expect(canRetryStudySubmission(result)).toBe(true); expect(canCancelStudySubmission(context.owner, result)).toBe(true);
  });
  it('permits only an exact hidden retry after null metadata and clears quarantine only after saved acknowledgment', async () => {
    const context = unresolved(), value = expected();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ ok: true, actorId: 7, scope, recovery: null }))
      .mockResolvedValueOnce(json(saved(value, true))).mockResolvedValueOnce(json(receipt('committed', true))));
    await fetchStudySubmissionRecovery(context); expect(context.owner.document).toBe(''); expect(context.owner.draftQuarantined).toBe(true);
    expect(context.owner.editable()).toBe(false); expect(context.owner.canRetry()).toBe(true);
    const operation = context.owner.beginRetry()!; expect(JSON.parse(operation.body).command).toEqual(value.command);
    expect(await submitAndAcknowledgeStudy(context.owner, operation, value)).toBe(true); expect(context.owner.draftQuarantined).toBe(false); expect(context.owner.uncertain).toBe(false);
  });
  it.each([401, 403])('revokes current owner on recovery HTTP %s', async status => {
    const context = setup(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
    await expect(fetchStudySubmissionRecovery(context)).rejects.toThrow(); expect(context.deny).toHaveBeenCalledOnce(); expect(context.owner.active()).toBe(false);
  });
  it('ignores a retired owner response even if it denies access', async () => {
    const context = setup(); vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => { context.owner.retire(); return new Response(null, { status: 403 }); }));
    await expect(fetchStudySubmissionRecovery(context)).rejects.toThrow('stale'); expect(context.deny).not.toHaveBeenCalled();
  });
  it('rejects a missing no-store directive and incorrectly scoped recovery', async () => {
    const context = setup(); vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(recovery(), 200, 'private')).mockResolvedValueOnce(json({ ...recovery(), scope: { ...scope, patientId: 99 } })));
    await expect(fetchStudySubmissionRecovery(context)).rejects.toThrow(); await expect(fetchStudySubmissionRecovery(context)).rejects.toThrow(); expect(context.owner.document).toBe('');
  });
  it('rejects recovered command bytes changed without a matching fingerprint', async () => {
    const context = setup(), raw = recovery(); if (raw.recovery?.state === 'pending') raw.recovery.expected.command.reason = 'Changed';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(raw)));
    await expect(fetchStudySubmissionRecovery(context)).rejects.toThrow('fingerprint'); expect(context.owner.retryExpectation).toBeNull();
  });
  it('quarantines retained command bytes on direct cancelled metadata, then keeps them hidden after acknowledgment and null', async () => {
    const context = unresolved(), before = context.owner.document;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ ok: true, actorId: 7, scope, recovery: { state: 'cancelled', identity: identity() } }))
      .mockResolvedValueOnce(json(receipt('cancelled', true))).mockResolvedValueOnce(json({ ok: true, actorId: 7, scope, recovery: null })));
    const read = await fetchStudySubmissionRecovery(context); expect(context.owner.draftQuarantined).toBe(true); expect(context.owner.document).toBe('');
    expect(await cancelAndAcknowledgeStudy(context, read, () => { throw Error('Already cancelled'); })).toBe(true);
    await fetchStudySubmissionRecovery(context); expect(context.owner.document).toBe(''); expect(context.owner.draftQuarantined).toBe(true);
    expect(context.ledger.forDraftOwner(scope, 7).read()?.owned?.document).toBe(before);
  });
  it('keeps foreign and source-restricted receipts metadata-only and blocks retry', async () => {
    const context = setup(), blocked = { state: 'blocked', identity: null, canCancel: false };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ ok: true, actorId: 7, scope, recovery: blocked }))
      .mockResolvedValueOnce(json({ ok: true, actorId: 7, scope, recovery: { ...blocked, identity: identity(), canCancel: true } })));
    const foreign = await fetchStudySubmissionRecovery(context); expect(canRetryStudySubmission(foreign)).toBe(false); expect(canCancelStudySubmission(context.owner, foreign)).toBe(false);
    const restricted = await fetchStudySubmissionRecovery(context); expect(canRetryStudySubmission(restricted)).toBe(false); expect(canCancelStudySubmission(context.owner, restricted)).toBe(true);
    expect(context.owner.document).toBe('');
  });
});
describe('save acknowledgment', () => {
  it('clears intent only after exact committed acknowledgment', async () => {
    const { owner } = unresolved(), value = expected(), operation = owner.beginRetry()!;
    const fetcher = vi.fn().mockResolvedValueOnce(json(saved(value, true))).mockImplementationOnce(async (_url, options) => {
      expect(owner.uncertain).toBe(true); expect(owner.document).not.toBe(''); expect(JSON.parse(options.body)).toEqual({ patientId: 19, clinicalCaseId: 51, actorId: 7, commandId: identity().commandId, requestFingerprint: identity().requestFingerprint, action: 'acknowledge' });
      return json(receipt('committed', true));
    }); vi.stubGlobal('fetch', fetcher);
    expect(await submitAndAcknowledgeStudy(owner, operation, value, identity())).toBe(true); expect(owner.uncertain).toBe(false); expect(owner.document).toBe(''); expect(owner.readVersion).toBe(1);
  });
  it.each(['network', 'malformed', 'wrong_identity', 'wrong_receipt', 'wrong_scope', 'cacheable', 'status'] as const)('keeps exact submitted bytes uncertain after %s acknowledgment failure', async failure => {
    const { owner } = unresolved(), value = expected(), before = owner.document, operation = owner.beginRetry()!, body = operation.body;
    const bad = receipt('committed', true);
    const ack = failure === 'malformed' ? {} : failure === 'wrong_identity' ? { ...bad, identity: { ...bad.identity, commandId: 'another_command_001' } }
      : failure === 'wrong_receipt' ? { ...bad, identity: { ...bad.identity, id: 999 } } : failure === 'wrong_scope' ? { ...bad, scope: { ...scope, clinicalCaseId: 99 } } : bad;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(saved(value, true))).mockImplementationOnce(async () => {
      if (failure === 'network') throw Error('lost ack'); return json(ack, failure === 'status' ? 409 : 200, failure === 'cacheable' ? 'private' : 'no-store');
    }));
    expect(await submitAndAcknowledgeStudy(owner, operation, value, identity())).toBe(false);
    expect(owner.uncertain).toBe(true); expect(owner.document).toBe(before); const retry = owner.beginRetry()!; expect(retry.body).toBe(body); retry.finish();
  });
  it.each([401, 403])('revokes owner on acknowledgment HTTP %s and retains uncertainty', async status => {
    const context = unresolved(), operation = context.owner.beginRetry()!;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(saved(expected(), true))).mockResolvedValueOnce(new Response(null, { status })));
    expect(await submitAndAcknowledgeStudy(context.owner, operation, expected())).toBe(false); expect(context.deny).toHaveBeenCalledOnce(); expect(context.owner.uncertain).toBe(true);
  });
});
describe('explicit command cancellation', () => {
  it('requires confirmation and sends no request when declined', async () => {
    const context = unresolved(), confirm = vi.fn().mockReturnValue(false), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await cancelAndAcknowledgeStudy(context, { receipt: recovery().recovery, conflict: false }, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled(); expect(context.owner.uncertain).toBe(true);
  });
  it('cancels the exact pending identity then keeps retained text quarantined without relying on a blocked GET', async () => {
    const context = unresolved(), before = context.owner.document, fetcher = vi.fn().mockResolvedValueOnce(json(receipt('cancelled', false))).mockResolvedValueOnce(json(receipt('cancelled', true)));
    vi.stubGlobal('fetch', fetcher);
    expect(await cancelAndAcknowledgeStudy(context, { receipt: recovery().recovery, conflict: false }, () => true)).toBe(true);
    expect(fetcher.mock.calls.map(call => JSON.parse(call[1].body).action)).toEqual(['cancel', 'acknowledge']);
    expect(context.owner.uncertain).toBe(false); expect(context.owner.document).toBe(''); expect(context.owner.dirty).toBe(true); expect(context.owner.editable()).toBe(false);
    expect(context.owner.draftQuarantined).toBe(true); expect(context.ledger.forDraftOwner(scope,7).read()?.owned?.document).toBe(before);
    fetcher.mockResolvedValueOnce(json({ok:true,actorId:7,scope,recovery:null})); await fetchStudySubmissionRecovery(context);
    expect(context.owner.document).toBe(''); expect(context.owner.draftQuarantined).toBe(true);
  });
  it('creates a cancellation tombstone using the local exact hash when no server receipt exists', async () => {
    const context = unresolved(), fetcher = vi.fn().mockResolvedValueOnce(json(receipt('cancelled', false))).mockResolvedValueOnce(json(receipt('cancelled', true))); vi.stubGlobal('fetch', fetcher);
    expect(await cancelAndAcknowledgeStudy(context, { receipt: null, conflict: false }, () => true)).toBe(true);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ patientId: 19, clinicalCaseId: 51, actorId: 7, commandId: identity().commandId, requestFingerprint: identity().requestFingerprint, action: 'cancel' });
    expect(fetcher.mock.calls[0][1].body).not.toContain(expected().command.content.comment);
  });
  it('acknowledges a recovered cancelled receipt directly without recreating a command', async () => {
    const context = setup(), confirm = vi.fn(), fetcher = vi.fn().mockResolvedValue(json(receipt('cancelled', true))); vi.stubGlobal('fetch', fetcher);
    expect(await cancelAndAcknowledgeStudy(context, { receipt: { state: 'cancelled', identity: identity() }, conflict: false }, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce(); expect(JSON.parse(fetcher.mock.calls[0][1].body).action).toBe('acknowledge');
  });
  it('can cancel a source-restricted own receipt without receiving a PHI command', async () => {
    const context = setup(), fetcher = vi.fn().mockResolvedValueOnce(json(receipt('cancelled', false))).mockResolvedValueOnce(json(receipt('cancelled', true))); vi.stubGlobal('fetch', fetcher);
    expect(await cancelAndAcknowledgeStudy(context, { receipt: { state: 'blocked', identity: identity(), canCancel: true }, conflict: false }, () => true)).toBe(true);
    expect(context.owner.document).toBe('');
  });
  it('does not pretend a committed 409 was cancelled or send an acknowledgment', async () => {
    const context = unresolved(), before = context.owner.document, fetcher = vi.fn().mockResolvedValue(json({ ok: false, code: 'study_submission_already_committed' }, 409)); vi.stubGlobal('fetch', fetcher);
    await expect(cancelAndAcknowledgeStudy(context, { receipt: recovery().recovery, conflict: false }, () => true)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce(); expect(context.owner.uncertain).toBe(true); expect(context.owner.document).toBe(before);
  });
  it('retains identity after cancellation acknowledgment is lost', async () => {
    const context = unresolved(), before = context.owner.document; vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(receipt('cancelled', false))).mockRejectedValueOnce(Error('lost ack')));
    await expect(cancelAndAcknowledgeStudy(context, { receipt: recovery().recovery, conflict: false }, () => true)).rejects.toThrow();
    expect(context.owner.uncertain).toBe(true); expect(context.owner.document).toBe(before);
  });
  it('rejects changed receipt IDs between cancellation and acknowledgment', async () => {
    const context = unresolved(), ack = receipt('cancelled', true); ack.identity.id++;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(receipt('cancelled', false))).mockResolvedValueOnce(json(ack)));
    await expect(cancelAndAcknowledgeStudy(context, { receipt: null, conflict: false }, () => true)).rejects.toThrow('identity_changed'); expect(context.owner.uncertain).toBe(true);
  });
  it('does not resolve a late canceled response after owner read generation changes', async () => {
    const context = unresolved(), generation = context.owner.readVersion;
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(async () => { context.owner.refresh(); return json(receipt('cancelled', false)); }));
    await expect(cancelAndAcknowledgeStudy({ ...context, current: () => context.owner.readVersion === generation }, { receipt: null, conflict: false }, () => true)).rejects.toThrow('stale');
    expect(context.owner.uncertain).toBe(true);
  });
  it('never exposes a cancellation control for a conflicting local command', () => {
    const context = unresolved(), other = expected(); other.command.clientRequestId = 'another_command_001';
    expect(canCancelStudySubmission(context.owner, { receipt: recovery('pending', other).recovery, conflict: true })).toBe(false);
  });
  it('rebinds cancellation to current exact local identity even if an old control claims no conflict', async () => {
    const context = unresolved(), other = expected(); other.command.clientRequestId = 'another_command_001';
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(cancelAndAcknowledgeStudy(context, { receipt: recovery('pending', other).recovery, conflict: false }, () => true)).rejects.toThrow('identity_changed');
    expect(fetcher).not.toHaveBeenCalled(); expect(context.owner.uncertain).toBe(true);
  });
  it('strict transition validation rejects leaked fields and nonliteral flags', () => {
    const raw = receipt('cancelled', true);
    for (const changed of [{ ...raw, command: expected().command }, { ...raw, acknowledged: 'true' }, { ...raw, actorId: 8 }, { ...raw, state: 'committed' }]) {
      expect(() => verifyStudySubmissionTransition(changed, scope, 7, identity(), 'cancelled', true)).toThrow();
    }
  });
  it('uses no PHI browser storage and gates the editor only after verified recovery', () => {
    const helper = readFileSync(new URL('../lib/ortho-study-submission-client.ts', import.meta.url), 'utf8');
    const component = readFileSync(new URL('../components/OrthoCaseStudy.tsx', import.meta.url), 'utf8');
    expect(helper).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(component.match(/localStorage\.setItem\([^;]+/g)).toEqual(['localStorage.setItem(STUDY_DISPLAY_LOCALE_KEY, next)']);
    expect(component.indexOf('await fetchStudySubmissionRecovery')).toBeLessThan(component.indexOf('await verifyStudyEditorRead'));
    expect(component.indexOf('await fetchStudySubmissionRecovery')).toBeLessThan(component.indexOf('state: "ready", value, recovery'));
    expect(component).toContain('window.confirm'); expect(component).toContain('No saved clinical revision will be deleted');
  });
});
