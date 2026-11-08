/** Privacy basis: payload IDs, dates and clinical content come from the reviewed synthetic core.
 * Local small IDs are collision/mismatch or sequence witnesses; versions, byte limits,
 * SQL/HTTP codes, PNG signature and cardinalities are protocol/test-boundary constants.
 * Alternative text and mismatch SHA values below are newly authored synthetic data. */
import { afterEach, expect, it, vi } from 'vitest';
const controlled = vi.hoisted(() => ({ proof: vi.fn() }));
vi.mock('../lib/staff-authority-proof-internal', () => ({ loadLockedStaffAuthority: controlled.proof }));
import { canonicalFixture } from './fixtures/canonical-ortho-facial';
import { scope } from './fixtures/ortho-facial-core';
import { createCanonicalFacialWriteAuthority } from '../lib/canonical-ortho-facial-authority';
import { withStaffOperation, type StaffOperationHandle } from '../lib/staff-operation-runtime';
import type { FacialWriteAuthority, FacialActor } from '../lib/ortho-facial-core-contract';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); controlled.proof.mockReset(); });

it('uses actual private runtime and central own witnesses after patient wait, without shell-create grants', async () => {
  const f = canonicalFixture(controlled.proof);
  await withStaffOperation(f.pool, f.session, 'clinical.ortho.edit', async (c, handle) => {
    const a = createCanonicalFacialWriteAuthority(c, handle, scope), actor = await a.authorizeWrite(c, scope);
    expect(actor).toEqual({ userId: 695444321, name: "Synthetic reviewer B 04f3086d", role: 'doctor' });
    expect(Object.isFrozen(actor)).toBe(true);
    const count = controlled.proof.mock.calls.length;
    await a.assertWrite(c, scope, actor); await a.assertImages(c, scope, actor);
    expect(controlled.proof.mock.calls.length).toBeGreaterThan(count + 4);
  });
  const patient = f.sqls.indexOf('SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE');
  expect(f.sqls.slice(patient + 1).some(s => s.includes('FOR SHARE NOWAIT'))).toBe(true);
  expect(controlled.proof.mock.calls.every(c => c[0] === f.client && c[2] === 'clinical.ortho.edit')).toBe(true);
});
it.each(['none', 'all', 'own'])('requires existing patient for %s scope', async kind => {
  const f = canonicalFixture(controlled.proof); f.state.scope = kind; f.state.patient = false;
  await expect(withStaffOperation(f.pool, f.session, 'clinical.ortho.edit', (c, h) => createCanonicalFacialWriteAuthority(c, h, scope).authorizeWrite(c, scope))).rejects.toMatchObject({ code: 'ortho_case_not_found' });
});
it('all scope permits a real user without a clinician, but still checks independent images', async () => {
  const f = canonicalFixture(controlled.proof); f.state.scope = 'all'; f.state.clinician = null; f.state.image = false;
  await withStaffOperation(f.pool, f.session, 'clinical.ortho.edit', async (c, h) => {
    const a = createCanonicalFacialWriteAuthority(c, h, scope), actor = await a.authorizeWrite(c, scope);
    await expect(a.assertImages(c, scope, actor)).rejects.toMatchObject({ code: 'image_access_denied' });
    await a.assertWrite(c, scope, actor);
  });
});
it.each(['precheck', 'after-wait', 'later'])('rejects lost own membership at %s', async point => {
  const f = canonicalFixture(controlled.proof);
  if (point === 'precheck') f.state.inside = false;
  if (point === 'after-wait') f.hook(sql => { if (sql.includes('FOR NO KEY UPDATE')) f.state.witness = false; });
  await expect(withStaffOperation(f.pool, f.session, 'clinical.ortho.edit', async (c, h) => {
    const a = createCanonicalFacialWriteAuthority(c, h, scope), actor = await a.authorizeWrite(c, scope);
    if (point === 'later') { f.state.witness = false; await a.assertWrite(c, scope, actor); }
  })).rejects.toMatchObject({ code: 'ortho_case_not_found' });
});
it.each(['realmId', 'subjectId', 'generationId', 'userId', 'username', 'role'] as const)('rejects full identity drift: %s', async field => {
  const f = canonicalFixture(controlled.proof);
  await expect(withStaffOperation(f.pool, f.session, 'clinical.ortho.edit', async (c, h) => {
    const a = createCanonicalFacialWriteAuthority(c, h, scope), actor = await a.authorizeWrite(c, scope);
    if (field === 'userId') f.state.identity.userId++; else f.state.identity[field] += '-changed';
    await a.assertWrite(c, scope, actor);
  })).rejects.toMatchObject({ code: 'facial_authority_changed' });
});
it.each(['client', 'scope', 'actor', 'before-admission', 'handle', 'action', 'xid', 'expired', 'revoked'])('rejects %s mismatch with real runtime', async kind => {
  const f = canonicalFixture(controlled.proof);
  await expect(withStaffOperation(f.pool, f.session, kind === 'action' ? 'clinical.xrays.view' : 'clinical.ortho.edit', async (c, h) => {
    const a = createCanonicalFacialWriteAuthority(c, kind === 'handle' ? {} as StaffOperationHandle : h, scope);
    if (kind === 'before-admission') return a.assertWrite(c, scope, f.h.actor);
    const actor = await a.authorizeWrite(c, scope);
    if (kind === 'xid') f.state.xid++;
    if (kind === 'expired') f.state.expired = true;
    if (kind === 'revoked') f.state.granted = false;
    return a.assertWrite(kind === 'client' ? { ...c } : c, kind === 'scope' ? { ...scope, patientId: 12 } : scope, kind === 'actor' ? { ...actor, name: 'Synthetic mismatched reviewer v1' } : actor);
  })).rejects.toThrow();
});
it('rejects stale closures after lifetime ends', async () => {
  const f = canonicalFixture(controlled.proof); let a!: FacialWriteAuthority; let actor!: FacialActor;
  await withStaffOperation(f.pool, f.session, 'clinical.ortho.edit', async (c, h) => { a = createCanonicalFacialWriteAuthority(c, h, scope); actor = await a.authorizeWrite(c, scope); });
  await expect(a.assertWrite(f.client, scope, actor)).rejects.toThrow('HANDLE_INVALID');
});
