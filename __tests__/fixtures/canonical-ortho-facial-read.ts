import { facialScenario } from './ortho-facial-core';
/** Privacy basis: payload IDs, dates and clinical content come from the reviewed synthetic core.
 * Local small IDs are collision/mismatch or sequence witnesses; versions, byte limits,
 * SQL/HTTP codes, PNG signature and cardinalities are protocol/test-boundary constants.
 * Alternative text and mismatch SHA values below are newly authored synthetic data. */
/** Actual snapshot runtime + actual durable admission, synthetic SQL transport.
 * Does not establish PostgreSQL or native-decoder integration. */
import { createHmac } from 'node:crypto';
import { vi, type Mock } from 'vitest';
import { sessionCredentialVersion } from '../../lib/auth';
import { STAFF_AUTHORIZATION_POLICY_VERSION } from '../../lib/staff-capability-catalogue';
import { readVerifiedDurableSession } from '../../lib/staff-durable-session';
import { Harness, basis } from './ortho-facial-core';
import { createCanonicalFacialReads } from '../../lib/canonical-ortho-facial-read';
export function facialReadFixture(connect: Mock, probe: Mock) {
  vi.stubEnv('USE_LOCAL_DB', 'false');
  const secret = 'synthetic-read-secret-at-least-32-characters'; vi.stubEnv('SESSION_SECRET', secret);
  const realm = '11111111-1111-4111-8111-111111111111', generation = '22222222-2222-4222-8222-222222222222';
  const ownerSubject = '33333333-3333-4333-8333-333333333333', actorSubject = '44444444-4444-4444-8444-444444444444';
  const permission = { schemaVersion: 2, confirmation: 'owner', revision: 1, patientScope: 'own', appointmentScope: 'none',
    grants: { 'clinical.ortho.view': true, 'clinical.ortho.edit': true, 'clinical.xrays.view': true } };
  const claims = { userId: 695444321, username: "Synthetic reviewer B 04f3086d", expiresAt: Date.now() + 60000,
    durableIdentity: { schemaVersion: 2, policyVersion: STAFF_AUTHORIZATION_POLICY_VERSION, realmId: realm, subjectId: actorSubject, generationId: generation, registryRevision: '3', controlEpoch: '2', accountEpoch: '1', permissionRevision: 1, credentialVersion: sessionCredentialVersion('synthetic-hash'), provider: { partyId: 20, clinicalEpoch: '1' } } };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const session = readVerifiedDurableSession(`${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`);
  if (!session) throw Error('fixture token');
  const h = new Harness();
  const state = {
    permission, control: { state: 'active', realm_id: realm, owner_user_id: 1, binding_epoch: '2' },
    identity: { status: 'ready', realm_id: realm, generation_id: generation, registry_revision: '3', ready_owner_subject_id: ownerSubject, ready_control_epoch: '2' },
    owner: { id: 1, username: 'Synthetic authority owner v1', role: 'admin', is_active: true, authorization_mode: 'canonical', authorization_epoch: '1', password_hash: 'synthetic-owner-hash', permissions: { ...permission, grants: {} }, party_id: null },
    actor: { id: 695444321, username: "Synthetic reviewer B 04f3086d", role: 'doctor', is_active: true, authorization_mode: 'canonical', authorization_epoch: '1', password_hash: 'synthetic-hash', permissions: permission, party_id: 20 },
    provider: { id: 20, kind: 'doctor', is_active: true, clinical_authority_epoch: '1' },
    bindings: [{ user_id: 1, subject_id: ownerSubject }, { user_id: 695444321, subject_id: actorSubject }],
    patient: true, inside: true, begins: 0, commits: 0, releases: 0, open: false, unlocked: true, virtualId: '7/100',
    hook: undefined as undefined | ((sql: string, values?: unknown[]) => unknown | Promise<unknown>),
    onDecode: undefined as undefined | (() => void | Promise<void>),
    releaseFailure: false,
  };
  const sqls: string[] = [], events: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    sqls.push(sql); const override = await state.hook?.(sql, values); if (override !== undefined) return override;
    if (sql.startsWith('BEGIN')) { state.open = true; state.begins++; events.push('begin'); return { rows: [] }; }
    if (sql === 'COMMIT') { state.open = false; state.commits++; events.push('commit'); return { rows: [] }; }
    if (sql.includes('pg_advisory_unlock_shared')) { events.push('unlock'); return { rows: [{ unlocked: state.unlocked }] }; }
    if (sql.includes('AS advisory_locks')) return { rows: [{ advisory_locks: 0 }] };
    if (sql.includes('pg_locks')) return { rows: [{ virtualxid: state.virtualId, isolation: 'repeatable read', read_only: 'on', in_recovery: false }] };
    if (sql.includes('FROM public.staff_authority_control')) return { rows: [state.control] };
    if (sql.includes('FROM public.staff_identity_state')) return { rows: [state.identity] };
    if (sql.includes('WITH RECURSIVE chain')) return { rows: [{ valid: true }] };
    if (sql.includes('FROM public.users WHERE id=ANY')) return { rows: [state.owner, state.actor] };
    if (sql.includes('FROM public.staff_identity_current WHERE user_id=ANY')) return { rows: state.bindings };
    if (sql.includes('FROM public.parties WHERE id=$1')) return { rows: [state.provider] };
    if (sql.startsWith('SELECT EXISTS (SELECT 1 FROM patients')) return { rows: [{ inside: state.inside }] };
    if (sql === 'SELECT id FROM patients WHERE id=$1') return { rows: state.patient ? [{ id: 734599007 }] : [] };
    if (/^(SET LOCAL|ROLLBACK)/.test(sql) || sql.includes('pg_advisory_lock_shared')) return { rows: [] };
    return h.client.query(sql, values);
  });
  const release = vi.fn(() => { events.push('release'); state.releases++; if (state.releaseFailure) throw Error('private-driver-path'); });
  connect.mockResolvedValue({ query, release }); probe.mockResolvedValue({ version: 2, schema: 'public', fingerprint: 'synthetic' });
  const decode = async () => { events.push('decode'); if (state.open || state.releases !== 1) throw Error('decode inside snapshot'); await state.onDecode?.(); return { ...basis }; };
  const images = { verify: vi.fn(decode), render: vi.fn(async () => ({ basis: await decode(), png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]) })) };
  const clock = { today: (): string => facialScenario.today }, services = { images, clock };
  return { h, state, session, claims, sqls, events, query, release, images, services, reads: createCanonicalFacialReads(services) };
}
