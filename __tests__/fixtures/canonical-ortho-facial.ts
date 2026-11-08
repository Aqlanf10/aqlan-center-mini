/** Privacy basis: payload IDs, dates and clinical content come from the reviewed synthetic core.
 * Local small IDs are collision/mismatch or sequence witnesses; versions, byte limits,
 * SQL/HTTP codes, PNG signature and cardinalities are protocol/test-boundary constants.
 * Alternative text and mismatch SHA values below are newly authored synthetic data. */
/** Synthetic SQL transport only. Actual private runtime, durable session,
 * capability resolver and facial cores are exercised. Not PostgreSQL evidence. */
import { createHmac, randomUUID } from 'node:crypto';
import { vi, type Mock } from 'vitest';
import type { DbClient, DbPool } from '../../lib/db';
import { sessionCredentialVersion } from '../../lib/auth';
import { STAFF_AUTHORIZATION_POLICY_VERSION } from '../../lib/staff-capability-catalogue';
import { hasStaffCapability, resolveStaffCapabilities, staffAuthorizationFingerprint } from '../../lib/staff-capabilities';
import { readVerifiedDurableSession, revalidateVerifiedDurableSession, type VerifiedDurableSession } from '../../lib/staff-durable-session';
import type { StaffRuntimeAction } from '../../lib/staff-operation-runtime';
import { Harness } from './ortho-facial-core';

export function canonicalFixture(proof: Mock) {
  const secret = 'synthetic-facial-secret-at-least-32-characters';
  vi.stubEnv('SESSION_SECRET', secret);
  const claims = { userId: 695444321, username: "Synthetic reviewer B 04f3086d", expiresAt: Date.now() + 60000,
    durableIdentity: { schemaVersion: 2, policyVersion: STAFF_AUTHORIZATION_POLICY_VERSION, realmId: randomUUID(), subjectId: randomUUID(), generationId: randomUUID(), registryRevision: '2', controlEpoch: '1', accountEpoch: '1', permissionRevision: 1, credentialVersion: sessionCredentialVersion('synthetic-hash'), provider: { partyId: 20, clinicalEpoch: '1' } } };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const session = readVerifiedDurableSession(`${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`);
  if (!session) throw Error('fixture session');
  const h = new Harness();
  const state = { scope: 'own', clinician: 20 as number | null, image: true, granted: true, patient: true, inside: true, witness: true,
    expired: false, xid: 0, revision: 1, identity: { realmId: claims.durableIdentity.realmId, subjectId: claims.durableIdentity.subjectId, generationId: claims.durableIdentity.generationId, userId: 695444321, username: "Synthetic reviewer B 04f3086d", role: 'doctor' },
    commitErrorAt: 0, commits: 0, commitError: Error('uncertain_commit') };
  const sqls: string[] = [];
  let hook: (sql: string) => void | Promise<void> = () => {};
  let saved = structuredClone({ revisions: h.revisions, submissions: h.submissions });
  const client = { release: vi.fn(), query: vi.fn(async (sql: string, values: unknown[] = []) => {
    sqls.push(sql); await hook(sql);
    if (sql.startsWith('BEGIN')) { state.xid++; saved = structuredClone({ revisions: h.revisions, submissions: h.submissions }); return { rows: [] }; }
    if (sql === 'COMMIT') { state.commits++; if (state.commitErrorAt === state.commits) throw state.commitError; return { rows: [] }; }
    if (sql === 'ROLLBACK') { h.revisions = saved.revisions; h.submissions = saved.submissions; return { rows: [] }; }
    if (/^(SAVEPOINT|RELEASE SAVEPOINT)/.test(sql) || sql.startsWith('SELECT pg_advisory_xact_lock_shared')) return { rows: [] };
    if (sql.startsWith('SELECT pg_current_xact_id')) return { rows: [{ xid: String(state.xid), isolation: 'read committed' }] };
    if (sql.startsWith('SELECT EXISTS (SELECT 1 FROM patients')) return { rows: [{ inside: state.inside }] };
    if (sql === 'SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE') return { rows: state.patient ? [{ id: 734599007 }] : [] };
    if (sql.includes('FOR SHARE') && sql.includes('$2') && !sql.includes('FROM patient_documents') && !sql.startsWith('SELECT id,patient_id')) return { rows: state.witness ? [{ id: 734599007 }] : [] };
    return h.client.query(sql, values);
  }) } as unknown as DbClient;
  const pool = { connect: vi.fn(async () => client), query: vi.fn(async () => { throw Error('pool query forbidden'); }) } as DbPool;
  proof.mockImplementation(async (actual: DbClient, verified: VerifiedDurableSession, action: StaffRuntimeAction, schema: string) => {
    if (actual !== client || schema !== 'public') throw Error('fixture client/schema mismatch');
    if (state.expired || !revalidateVerifiedDurableSession(verified)) throw Error('STAFF_OPERATION_SESSION_EXPIRED');
    const access = resolveStaffCapabilities({ subject: { userId: 695444321, role: 'doctor', isActive: true, clinicianPartyId: state.clinician }, permissionDocument: { schemaVersion: 2, confirmation: 'owner', revision: state.revision, patientScope: state.scope, appointmentScope: 'none', grants: { 'clinical.ortho.view': true, 'clinical.ortho.edit': state.granted, 'clinical.xrays.view': state.image } } });
    if (!hasStaffCapability(access, action)) throw Error('STAFF_OPERATION_CAPABILITY_DENIED');
    return { access, fingerprint: staffAuthorizationFingerprint(access), identity: Object.freeze({ ...state.identity }) };
  });
  return { h, state, client, pool, session, sqls, hook: (next: typeof hook) => { hook = next; } };
}
