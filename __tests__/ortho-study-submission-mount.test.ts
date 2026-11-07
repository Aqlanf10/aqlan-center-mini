import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeStudyMountOwner } from '../lib/ortho-case-study-mount-owner';
import { makeStudyRecoveryLedger } from '../lib/ortho-case-study-recovery';
const scope = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
const metadata = () => ({ ok: true, actorId: 7, scope, recovery: { state: 'blocked', identity: { id: 11, commandId: 'synthetic_mount_command_01', requestFingerprint: 'a'.repeat(64) }, canCancel: true } });
function setup(recovery = makeStudyRecoveryLedger(), writable = true) {
  const owner = makeStudyMountOwner({ patientId: scope.patientId, orthoCaseId: scope.orthoCaseId, actorId: 7, ownerKey: 'synthetic-mount', recovery,
    authorized: () => true, writable: () => writable, deny() {} }); owner.activate(); return { owner, recovery };
}
describe('metadata-only initial study mounting', () => {
  it('binds the independently authorized exact actor and bridge without needing a saved-source editor read', async () => {
    const { owner } = setup(); expect(await owner.beginRead()!.acceptRecovery(metadata())).toBe(true);
    expect(owner.clinicalCaseId).toBe(51); expect(owner.study?.matches(scope)).toBe(true); expect(owner.study?.canResolveSubmission()).toBe(true);
    const component = readFileSync(new URL('../components/OrthoCaseStudyMount.tsx', import.meta.url), 'utf8');
    expect(component).toContain('/case-study/recovery?patientId='); expect(component).not.toContain('/case-study/editor?'); expect(component).toContain('read.acceptRecovery(JSON.parse(text))');
  });
  it('quarantines retained local bytes before exposing a new binding', async () => {
    const first = setup(); await first.owner.beginRead()!.acceptRecovery({ ...metadata(), recovery: null });
    first.owner.study!.change('Private retained local draft'); first.owner.retire();
    const next = setup(first.recovery); let visible = false; next.owner.subscribe(() => { if (next.owner.study?.document) visible = true; });
    expect(await next.owner.beginRead()!.acceptRecovery(metadata())).toBe(true);
    expect(visible).toBe(false); expect(next.owner.study!.document).toBe(''); expect(next.owner.study!.draftQuarantined).toBe(true);
    expect(first.recovery.forDraftOwner(scope, 7).read()?.owned?.document).toBe('Private retained local draft');
  });
  it('does not grant metadata write capability to a read-only owner', async () => {
    const { owner } = setup(undefined, false); await owner.beginRead()!.acceptRecovery({ ...metadata(), recovery: { state: 'cancelled', identity: metadata().recovery.identity } });
    expect(owner.study!.canResolveSubmission()).toBe(false);
  });
  it.each([
    () => ({ ...metadata(), actorId: 8 }),
    () => ({ ...metadata(), scope: { ...scope, patientId: 20 } }),
    () => ({ ...metadata(), scope: { ...scope, orthoCaseId: 42 } }),
    () => ({ ...metadata(), scope: { ...scope, clinicalCaseId: '51' } }),
    () => ({ ...metadata(), recovery: { ...metadata().recovery, canCancel: 'true' } }),
    () => ({ ...metadata(), recovery: { ...metadata().recovery, command: { private: 'leak' } } }),
  ])('rejects a malformed or differently scoped metadata response before creating an owner', async makeRaw => {
    const { owner } = setup(); await expect(owner.beginRead()!.acceptRecovery(makeRaw())).rejects.toThrow(); expect(owner.study).toBeNull(); expect(owner.clinicalCaseId).toBeNull();
  });
  it('rejects stale metadata across generation changes and permanent retirement', async () => {
    const { owner } = setup(), first = owner.beginRead()!; owner.invalidateRead(); expect(await first.acceptRecovery(metadata())).toBe(false);
    const second = owner.beginRead()!; owner.retire(); expect(await second.acceptRecovery(metadata())).toBe(false); expect(owner.study).toBeNull();
  });
  it('quarantines bridge changes rather than retargeting an existing recovery owner', async () => {
    const { owner } = setup(); await owner.beginRead()!.acceptRecovery(metadata()); const study = owner.study!;
    owner.invalidateRead(); await expect(owner.beginRead()!.acceptRecovery({ ...metadata(), scope: { ...scope, clinicalCaseId: 52 } })).rejects.toThrow('study_mount_bridge_changed');
    expect(owner.bridgeChanged).toBe(true); expect(owner.study).toBeNull(); expect(study.active()).toBe(false);
  });
});
