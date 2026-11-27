import { describe, expect, it } from 'vitest';
import { executePatientNumberingSave, type PatientNumberingPreviewClaims } from '../lib/patient-numbering-controller';
import type { AppliedNumbering, NumberingBackend, NumberingTransaction } from '../lib/patient-numbering-command';
import { ownerContextFromTrustedBinding, resolveStaffCapabilities, staffAuthorizationFingerprint, type ResolvedStaffAccess } from '../lib/staff-capabilities';

const doc = { schemaVersion: 2, confirmation: "owner", revision: 1, patientScope: 'none', appointmentScope: 'none', grants: {} };
const owner = (id = 99, bindingVersion = 'synthetic-v1', revision = 1) => resolveStaffCapabilities({
  subject: { userId: id, role: 'admin', isActive: true, clinicianPartyId: null }, permissionDocument: { ...doc, revision },
}, ownerContextFromTrustedBinding({ ownerUserId: id, bindingVersion }));
const command = { prefix: 'A', next: '37', expectedRevision: 'r1', requestId: 'synthetic-request-0001', reason: 'synthetic reason' };
const payload = { ...command, previewToken: 'synthetic-opaque-preview' };
const newState = () => ({ revision: 'r1', pending: 1n, audits: 0, receipts: new Map<string, { intent: string; result: AppliedNumbering }>() });
/** Serial transaction MODEL. Real owner resolver/command, but not PG/auth/token proof. */
function fixture() {
  let access: ResolvedStaffAccess | null = owner(), session = 'synthetic-login-one', now = 1000;
  let state = newState(), transactionCount = 0, applyCount = 0, active = false;
  let auditFails = false, loseAck = false;
  let activeTx: NumberingTransaction | null = null;
  let afterSnapshot: (() => void) | undefined, afterApply: (() => void) | undefined;
  let queue = Promise.resolve();
  const seen: string[] = [];
  const claims: PatientNumberingPreviewClaims = {
    version: 1, purpose: 'patient-numbering.change', actorId: 99,
    authorityFingerprint: staffAuthorizationFingerprint(access)!, sessionBinding: session,
    command: { ...command }, expiresAt: 2000,
  };
  let verified: PatientNumberingPreviewClaims | null = claims;
  const backend: NumberingBackend = { transaction(work) {
    transactionCount++;
    const run = queue.then(async () => {
      active = true; const staged = structuredClone(state);
      const tx: NumberingTransaction = {
        owner: async () => { seen.push('owner'); return access; },
        replay: async (id, key) => { seen.push('replay'); return staged.receipts.get(`${id}:${key}`) ?? null; },
        snapshot: async prefix => {
          seen.push('snapshot'); afterSnapshot?.();
          return { prefix, revision: staged.revision, pendingNext: staged.pending, allocatedThrough: 0n, historicalThrough: 0n, historyComplete: true };
        },
        apply: async input => {
          seen.push('apply'); applyCount++;
          expect(input.actorId).toBe(99);
          expect(input.authorityFingerprint).toBe(claims.authorityFingerprint);
          expect(input.reason).toBe('synthetic reason');
          expect(input.requestId).toBe(command.requestId);
          expect(input.expectedRevision).toBe(command.expectedRevision);
          const result = { prefix: input.prefix, next: input.next, preview: input.preview, revision: 'r2' };
          staged.pending = BigInt(input.next); staged.revision = 'r2'; staged.audits++;
          staged.receipts.set(`${input.actorId}:${input.requestId}`, { intent: input.intent, result });
          afterApply?.(); if (auditFails) throw new Error('synthetic audit failure');
          return result;
        },
      };
      activeTx = tx;
      try {
        const result = await work(tx); state = staged;
        if (loseAck) { loseAck = false; throw new Error('synthetic committed response lost'); }
        return result;
      } finally { active = false; activeTx = null; }
    });
    queue = run.then(() => undefined, () => undefined); return run;
  } };
  const dependencies = {
    backend,
    currentSessionBinding: async (_tx: NumberingTransaction) => { expect(active).toBe(true); expect(_tx).toBe(activeTx); seen.push('session'); return session; },
    verifyPreview: async (token: string, _tx: NumberingTransaction) => {
      expect(active).toBe(true); expect(_tx).toBe(activeTx); expect(token).toBe(payload.previewToken); seen.push('verify'); return verified;
    },
    now: () => now,
  };
  return { dependencies, claims, seen, state: () => state, transactions: () => transactionCount, applies: () => applyCount,
    access: (a: ResolvedStaffAccess | null) => { access = a; }, session: (s: string) => { session = s; },
    time: (t: number) => { now = t; }, verify: (v: PatientNumberingPreviewClaims | null) => { verified = v; },
    revision: (s: string) => { state.revision = s; }, auditFailure: () => { auditFails = true; },
    loseAcknowledgment: () => { loseAck = true; },
    afterSnapshot: (f: () => void) => { afterSnapshot = f; }, afterApply: (f: () => void) => { afterApply = f; },
  };
}

describe('unmounted patient numbering save controller', () => {
  it('defaults closed without every authority/backend dependency', async () => {
    const f = fixture();
    for (const deps of [null, {}, { backend: f.dependencies.backend }, { ...f.dependencies, verifyPreview: undefined }, { ...f.dependencies, currentSessionBinding: undefined }]) {
      expect(await executePatientNumberingSave(payload, deps as never)).toEqual({ ok: false, reason: 'owner-numbering-not-activated' });
    }
    expect(f.transactions()).toBe(0);
  });
  it('uses the existing command and one transaction, accepting a canonical synthetic owner', async () => {
    const f = fixture();
    expect(await executePatientNumberingSave({ ...payload, prefix: ' a ', next: '37 ', reason: ' synthetic reason ' }, f.dependencies)).toEqual({ ok: true, value: { prefix: 'A', next: '37', preview: 'A-00037', revision: 'r2' }, replay: false });
    expect(f.transactions()).toBe(1); expect(f.state().audits).toBe(1);
    expect(f.seen.indexOf('verify')).toBeLessThan(f.seen.indexOf('replay'));
    expect(f.seen.indexOf('replay')).toBeLessThan(f.seen.indexOf('snapshot'));
    expect(f.seen.indexOf('snapshot')).toBeLessThan(f.seen.indexOf('apply'));
  });
  it.each([null, [], 'body', { ...payload, extra: true }, { ...payload, actorId: 99 }, { ...payload, role: 'admin' },
    { ...payload, prefix: 'AAAAAAA' }, { ...payload, next: 37 }, { ...payload, next: '1e4' }, { ...payload, next: '9999999999999999999' },
    { ...payload, expectedRevision: '' }, { ...payload, requestId: 'short' }, { ...payload, reason: '' }, { ...payload, reason: 'x'.repeat(501) },
    { ...payload, previewToken: '' }, { ...payload, previewToken: 'x'.repeat(8193) }, { ...payload, previewToken: {} }])('rejects malformed or authority-bearing input before a transaction: %j', async raw => {
    const f = fixture(); expect(await executePatientNumberingSave(raw, f.dependencies)).toEqual({ ok: false, reason: 'invalid-input' }); expect(f.transactions()).toBe(0);
  });
  it('does not accept copied owner flags or a generic admin', async () => {
    const admin = resolveStaffCapabilities({ subject: { userId: 99, role: 'admin', isActive: true, clinicianPartyId: null }, permissionDocument: doc });
    for (const access of [null, admin, { status: 'allowed', reason: null, userId: 99, clinicianPartyId: null, isOwner: true } as ResolvedStaffAccess]) {
      const f = fixture(); f.access(access);
      expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'owner-required' });
      expect(f.seen).not.toContain('verify'); expect(f.applies()).toBe(0);
    }
  });
  it('refuses an unverified token', async () => {
    const f = fixture(); f.verify(null);
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'invalid-preview' }); expect(f.applies()).toBe(0);
  });
  it.each(['actor', 'fingerprint', 'session'])('refuses changed %s even when token exists', async change => {
    const f = fixture(); if (change === 'actor') f.access(owner(100));
    if (change === 'fingerprint') f.access(owner(99, 'synthetic-v2'));
    if (change === 'session') f.session('synthetic-login-two');
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'preview-authority-changed' });
    expect(f.seen).not.toContain('replay'); expect(f.applies()).toBe(0);
  });
  it.each(['prefix', 'next', 'expectedRevision', 'requestId', 'reason'])('binds exact normalized %s to preview', async field => {
    const f = fixture(); const changed = { ...payload, [field]: field === 'next' ? '38' : field === 'prefix' ? 'B' : `different-${field}-0001` };
    expect(await executePatientNumberingSave(changed, f.dependencies)).toEqual({ ok: false, reason: 'preview-command-mismatch' }); expect(f.applies()).toBe(0);
  });
  it.each([{ version: 2 }, { purpose: 'different' }, { actorId: Number.MAX_SAFE_INTEGER + 1 }, { expiresAt: NaN }, { expiresAt: 0 }, { sessionBinding: '' }, { command: { ...command, prefix: 'a' } }])('rejects malformed authenticated claims: %j', async change => {
    const f = fixture(); f.verify({ ...f.claims, ...change } as PatientNumberingPreviewClaims);
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'invalid-preview' }); expect(f.applies()).toBe(0);
  });
  it('fails closed on missing authenticated session', async () => {
    const f = fixture(); f.session('');
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'session-required' }); expect(f.seen).not.toContain('verify');
  });
  it('fails closed when verifier throws and never falls back', async () => {
    const f = fixture(); f.dependencies.verifyPreview = async () => { throw new Error('synthetic provider unavailable'); };
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'numbering-transaction-failed' }); expect(f.applies()).toBe(0);
  });
  it('fails closed on unavailable clock before writing', async () => {
    const f = fixture(); f.time(NaN);
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'numbering-clock-unavailable' }); expect(f.applies()).toBe(0);
  });
  it('keeps existing receipt intent conflict with a separately verified changed intent', async () => {
    const f = fixture(); await executePatientNumberingSave(payload, f.dependencies);
    f.verify({ ...f.claims, command: { ...command, next: '38' } });
    expect(await executePatientNumberingSave({ ...payload, next: '38' }, f.dependencies)).toEqual({ ok: false, reason: 'idempotency-conflict' }); expect(f.state().audits).toBe(1);
  });
  it('preserves authoritative stale-revision rejection', async () => {
    const f = fixture(); f.revision('r2');
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'stale-preview' }); expect(f.applies()).toBe(0);
  });
  it('rechecks actor before apply after snapshot', async () => {
    const f = fixture(); f.afterSnapshot(() => f.access(owner(100)));
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'preview-authority-changed' }); expect(f.applies()).toBe(0);
  });
  it('rolls staged writes back if actor changes during apply', async () => {
    const f = fixture(); f.afterApply(() => f.session('synthetic-login-two'));
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'preview-authority-changed' }); expect(f.state().audits).toBe(0); expect(f.state().revision).toBe('r1');
  });
  it('denies expired preview with no receipt before snapshot or apply', async () => {
    const f = fixture(); f.time(2000);
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'preview-expired' }); expect(f.seen).not.toContain('snapshot'); expect(f.applies()).toBe(0);
  });
  it('allows exact authenticated expired receipt replay but no second write', async () => {
    const f = fixture(); await executePatientNumberingSave(payload, f.dependencies); f.time(2000);
    const result = await executePatientNumberingSave(payload, f.dependencies);
    expect(result.ok && result.replay).toBe(true); expect(f.applies()).toBe(1); expect(f.state().audits).toBe(1);
    f.session('synthetic-login-two');
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'preview-authority-changed' });
  });
  it('expires between snapshot and apply without writing', async () => {
    const f = fixture(); f.afterSnapshot(() => f.time(2000));
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'preview-expired' }); expect(f.applies()).toBe(0);
  });
  it('repeated exact saves produce one audit even after revision advanced', async () => {
    const f = fixture(); const results = await Promise.all(Array.from({ length: 10 }, () => executePatientNumberingSave(payload, f.dependencies)));
    expect(results.every(r => r.ok)).toBe(true); expect(results.filter(r => r.ok && !r.replay)).toHaveLength(1); expect(f.state().audits).toBe(1);
  });
  it('does not use failed commit acknowledgment as permission to repeat', async () => {
    const f = fixture(); f.loseAcknowledgment();
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'numbering-transaction-failed' });
    expect((await executePatientNumberingSave(payload, f.dependencies))).toMatchObject({ ok: true, replay: true }); expect(f.state().audits).toBe(1);
  });
  it('preserves rollback/no success on audit failure', async () => {
    const f = fixture(); f.auditFailure();
    expect(await executePatientNumberingSave(payload, f.dependencies)).toEqual({ ok: false, reason: 'numbering-transaction-failed' }); expect(f.state()).toEqual(newState());
  });
});
