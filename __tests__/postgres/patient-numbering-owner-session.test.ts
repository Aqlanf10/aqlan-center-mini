import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const request = vi.hoisted(() => ({ cookie: undefined as string | undefined, bearer: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => request.cookie ? { value: request.cookie } : undefined }),
  headers: async () => new Headers(request.bearer ? { authorization: `Bearer ${request.bearer}` } : {}),
}));
import { createSessionToken, sessionCredentialVersion } from '../../lib/auth';
import { executeNumberingCommand } from '../../lib/patient-numbering-command';
import { executePatientNumberingSave, type PatientNumberingPreviewClaims } from '../../lib/patient-numbering-controller';
import { bindPatientNumberingSettingsRequest, type BoundSettingsDependencies } from '../../lib/patient-numbering-settings-bound';
import { createPatientNumberingSettings } from '../../lib/patient-numbering-settings';
import { createNumberingOwnerSessionProvider } from '../../lib/patient-numbering-owner-session';
import { PatientNumberingPostgresBackend } from '../../lib/patient-numbering-postgres';
import { readBoundRequestSession, type BoundRequestSession } from '../../lib/session';
import { ownerContextFromTrustedBinding, staffAuthorizationFingerprint, type TrustedOwnerContext } from '../../lib/staff-capabilities';
import { NumberingPgFixture } from './fixtures/patient-numbering-adapter';
import { validatePostgresTestTarget } from './_safe-target';

const target = validatePostgresTestTarget(process.env);
const actor = 991, role = 'admin', username = 'synthetic-numbering-owner';
const doc = { schemaVersion: 1, revision: 1, patientScope: 'none', appointmentScope: 'none', grants: {} };
const intent = { prefix: 'A', next: '37', expectedRevision: '1:P:A:1:0:0:1', requestId: 'synthetic-request-0001', reason: 'synthetic change' };
const previewToken = 'synthetic-preview-fixture';
let ownerContext: TrustedOwnerContext | null;
let fixture: NumberingPgFixture, admin: Pool, pool: Pool, schema: string, hash: string;
let signed: string;
function token(overrides: Partial<Parameters<typeof createSessionToken>[0]> = {}) {
  return createSessionToken({ userId: actor, role, username, expiresAt: Date.now() + 60_000,
    credentialVersion: sessionCredentialVersion(hash), ...overrides });
}
function active(proof: BoundRequestSession | null, observed?: (client: PoolClient) => void) {
  return new PatientNumberingPostgresBackend({ pool, schema, ownerSession: createNumberingOwnerSessionProvider(proof, async c => {
    observed?.(c); return ownerContext;
  }) });
}
async function claims(backend: PatientNumberingPostgresBackend): Promise<PatientNumberingPreviewClaims> {
  return backend.transaction(async tx => {
    const result = await tx.ownerSession?.();
    if (!result) throw new Error('Synthetic owner session missing');
    return { version: 1, purpose: 'patient-numbering.change', actorId: actor,
      sessionBinding: result.sessionBinding, authorityFingerprint: staffAuthorizationFingerprint(result.access)!,
      command: intent, expiresAt: Date.now() + 60_000 };
  });
}
async function counts() {
  return (await pool.query(`SELECT (SELECT count(*)::int FROM ${schema}.audit) audits, (SELECT count(*)::int FROM ${schema}.receipts) receipts`)).rows[0];
}
const body = { ...intent, previewToken };
const save = (backend: PatientNumberingPostgresBackend, c: PatientNumberingPreviewClaims) => executePatientNumberingSave(body, {
  backend, verifyPreview: async proof => proof === previewToken ? c : null,
});

beforeEach(async () => {
  // Ephemeral per-test credential material only. No fixed password or app pool.
  vi.stubEnv('SESSION_SECRET', randomBytes(32).toString('hex'));
  hash = randomBytes(32).toString('hex');
  ownerContext = ownerContextFromTrustedBinding({ ownerUserId: actor, bindingVersion: 'synthetic-one' });
  request.bearer = undefined; request.cookie = signed = token();
  schema = `numbering_fixture_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: target.testUrl.toString(), ssl: false });
  fixture = new NumberingPgFixture(admin, schema, async () => null);
  await fixture.initialize();
  // Only this randomly owned fixture schema is visible to unqualified auth SQL.
  pool = new Pool({ connectionString: target.testUrl.toString(), ssl: false, options: `-c search_path=${schema},pg_catalog` });
  await pool.query(`CREATE TABLE users(id integer PRIMARY KEY, username text NOT NULL, display_name text NOT NULL,
    password_hash text NOT NULL, role text NOT NULL, is_active boolean NOT NULL, party_id integer, permissions text);
    CREATE TABLE parties(id integer PRIMARY KEY, kind text NOT NULL, is_active boolean NOT NULL)`);
  await pool.query('INSERT INTO users VALUES($1,$2,$2,$3,$4,true,null,$5)', [actor, username, hash, role, JSON.stringify(doc)]);
});
afterEach(async () => {
  await pool?.end();
  try { await fixture?.dispose(); } finally { await admin?.end(); }
  request.cookie = undefined; request.bearer = undefined; vi.unstubAllEnvs();
});

describe('unmounted owner session on existing numbering backend PostgreSQL transaction', () => {
  it('uses the authenticated request, canonical owner, and exact same pooled client for reads and write', async () => {
    const admitted = await readBoundRequestSession();
    const preview = await claims(active(admitted));
    const clients = new Set<PoolClient>(), queries: string[] = [];
    const backend = active(admitted, c => {
      if (!clients.has(c)) {
        clients.add(c); const query = c.query.bind(c);
        vi.spyOn(c, 'query').mockImplementation(((...args: unknown[]) => {
          if (typeof args[0] === 'string') queries.push(args[0]);
          return Reflect.apply(query, c, args);
        }) as typeof c.query);
      }
    });
    try {
      expect(await save(backend, preview)).toMatchObject({ ok: true, replay: false, value: { preview: 'A-00037' } });
      expect(clients.size).toBe(1);
      expect(queries.some(q => q.includes('LOWER(username)') && q.includes('FOR SHARE'))).toBe(true);
      expect(queries.some(q => q.includes('SELECT permissions, party_id') && q.includes('FOR SHARE'))).toBe(true);
      expect(queries.some(q => q.startsWith('ALTER SEQUENCE'))).toBe(true);
      expect(queries).toContain('COMMIT');
      expect(await counts()).toEqual({ audits: 1, receipts: 1 });
    } finally { for (const c of clients) vi.mocked(c.query).mockRestore(); }
  });
  it('denies missing binding, absent/forged proof, or no backend-native provider without writes', async () => {
    const proof = await readBoundRequestSession(), preview = await claims(active(proof));
    for (const backend of [active(null), active({ ...proof } as BoundRequestSession),
      new PatientNumberingPostgresBackend({ pool, schema, ownerSession: createNumberingOwnerSessionProvider(proof) })]) {
      expect(await save(backend, preview)).toEqual({ ok: false, reason: 'owner-required' });
    }
    expect(await save(new PatientNumberingPostgresBackend({ pool, schema }), preview)).toEqual({ ok: false, reason: 'owner-numbering-not-activated' });
    expect(await executeNumberingCommand(intent, new PatientNumberingPostgresBackend({ pool, schema }))).toEqual({ ok: false, reason: 'owner-required' });
    expect(await counts()).toEqual({ audits: 0, receipts: 0 });
  });
  it.each(['credential','inactive','role','legacy-permissions','binding','party','deleted'] as const)(
    'refuses changed %s after signed request admission', async changed => {
      const proof = await readBoundRequestSession(), backend = active(proof), preview = await claims(backend);
      if (changed === 'credential') await pool.query('UPDATE users SET password_hash=$1', [randomBytes(32).toString('hex')]);
      if (changed === 'inactive') await pool.query('UPDATE users SET is_active=false');
      if (changed === 'role') await pool.query("UPDATE users SET role='doctor'");
      if (changed === 'legacy-permissions') await pool.query("UPDATE users SET permissions='{}'");
      if (changed === 'binding') ownerContext = ownerContextFromTrustedBinding({ ownerUserId: actor + 1, bindingVersion: 'synthetic-two' });
      if (changed === 'party') await pool.query('UPDATE users SET party_id=35');
      if (changed === 'deleted') await pool.query('DELETE FROM users');
      expect(await save(backend, preview)).toEqual({ ok: false, reason: 'owner-required' });
      expect(await counts()).toEqual({ audits: 0, receipts: 0 });
    });
  it('revalidates credentials after waiting for the existing allocator lock', async () => {
    const backend = active(await readBoundRequestSession()), preview = await claims(backend);
    const blocker = await pool.connect();
    let operation: ReturnType<typeof save> | undefined;
    let waited = false;
    const q = `SELECT id FROM ${schema}.config WHERE id=1 FOR UPDATE`;
    try {
      await blocker.query('BEGIN'); await blocker.query(q);
      operation = save(backend, preview);
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const { rows } = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
             AND wait_event_type='Lock' AND query=$1 AND pid<>pg_backend_pid()) AS waiting`, [q],
        );
        if (rows[0].waiting) { waited = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waited).toBe(true);
      await pool.query('UPDATE users SET password_hash=$1', [randomBytes(32).toString('hex')]);
      await blocker.query('COMMIT');
      expect(await operation).toEqual({ ok: false, reason: 'owner-required' });
      expect(await counts()).toEqual({ audits: 0, receipts: 0 });
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await operation; }
  });
  it('accepts an active clinician link then rejects changed canonical permissions/version before replay', async () => {
    await pool.query("INSERT INTO parties VALUES(35,'doctor',true); UPDATE users SET party_id=35");
    const backend = active(await readBoundRequestSession()), preview = await claims(backend);
    expect(await save(backend, preview)).toMatchObject({ ok: true, replay: false });
    await pool.query('UPDATE users SET permissions=$1', [JSON.stringify({ ...doc, revision: 2 })]);
    expect(await save(backend, preview)).toEqual({ ok: false, reason: 'preview-authority-changed' });
    expect(await counts()).toEqual({ audits: 1, receipts: 1 });
  });
  it('binds exact existing signed credential and rejects a different login before replay', async () => {
    const backend = active(await readBoundRequestSession()), preview = await claims(backend);
    expect(await save(backend, preview)).toMatchObject({ ok: true, replay: false });
    request.cookie = undefined; request.bearer = signed;
    expect(await save(active(await readBoundRequestSession()), preview)).toMatchObject({ ok: true, replay: true });
    request.bearer = token({ expiresAt: Date.now() + 90_000 });
    expect(await save(active(await readBoundRequestSession()), preview)).toEqual({ ok: false, reason: 'preview-authority-changed' });
    expect(await counts()).toEqual({ audits: 1, receipts: 1 });
  });
  it('refuses malformed and expired signed credential proof without changing ordinary auth', async () => {
    for (const candidate of [`${signed}.extra`, `${signed.slice(0, -1)}!`, token({ expiresAt: Date.now() - 10 }), token({ userId: Number.MAX_SAFE_INTEGER + 1 })]) {
      request.cookie = candidate; expect(await readBoundRequestSession()).toBeNull();
    }
  });
  it('fails closed on provider exception with no application fallback', async () => {
    const proof = await readBoundRequestSession(), preview = await claims(active(proof));
    const backend = new PatientNumberingPostgresBackend({ pool, schema, ownerSession: createNumberingOwnerSessionProvider(proof,
      async () => { throw new Error('synthetic binding store unavailable'); }) });
    expect(await save(backend, preview)).toEqual({ ok: false, reason: 'numbering-transaction-failed' });
    expect(await counts()).toEqual({ audits: 0, receipts: 0 });
  });
});

const lineage = '666aabbc-3333-4cdd-9ebb-177888999abc';
const requestDraft = { prefix: 'A', next: '37', reason: 'Synthetic bound settings' };
async function provisionBound(options: { ledger?: boolean } = {}) {
  const proof = await readBoundRequestSession();
  if (!proof) throw Error('Synthetic request proof missing');
  const generationSchema = `numbering_generation_fixture_${schema.slice(-32)}`;
  if (options.ledger !== false) {
    await pool.query(`CREATE TABLE ${schema}.preview_dispositions(
      lineage text NOT NULL, enrollment text NOT NULL, actor bigint NOT NULL, request text PRIMARY KEY,
      expires_at_ms bigint NOT NULL CHECK(expires_at_ms>0), state text NOT NULL CHECK(state IN ('issued','committed','retired')))`);
  }
  await pool.query(`CREATE SCHEMA ${generationSchema}; CREATE TABLE ${generationSchema}.generation_state(
    id int PRIMARY KEY, version int NOT NULL, lineage uuid NOT NULL, phase text NOT NULL, generation bigint NOT NULL)`);
  await pool.query(`INSERT INTO ${generationSchema}.generation_state VALUES(1,1,$1,'MANAGED',3)`, [lineage]);
  const observed: Array<{ xid: string; pid: number }> = [];
  const data: { lineage: string; enrollment: string; actorId: number } = { lineage, enrollment: 'synthetic_immutable_binding_A', actorId: actor };
  const previews = new Map<string, PatientNumberingPreviewClaims>();
  const deps: BoundSettingsDependencies = {
    pool, schema, request: proof, managedGeneration: { schema: generationSchema, lineage, generation: '3' },
    readLockedAuthority: async client => {
      const { rows: [row] } = await client.query('SELECT pg_current_xact_id_if_assigned()::text AS xid, pg_backend_pid() AS pid');
      if (typeof row?.xid !== 'string') throw Error('Wrong bound client or transaction');
      const same = await client.query(`SELECT id FROM ${generationSchema}.generation_state WHERE id=1 FOR SHARE NOWAIT`);
      if (same.rowCount !== 1) throw Error('Same-client generation lock absent');
      await expect(admin.query(`SELECT id FROM ${generationSchema}.generation_state WHERE id=1 FOR UPDATE NOWAIT`)).rejects.toMatchObject({ code: '55P03' });
      await expect(admin.query(`SELECT id FROM ${schema}.config WHERE id=1 FOR UPDATE NOWAIT`)).rejects.toMatchObject({ code: '55P03' });
      observed.push({ xid: row.xid, pid: row.pid });
      return ownerContext ? { owner: ownerContext, enrollment: { ...data } } : null;
    },
    issuePreview: async claims => {
      const id = `synthetic_bound_claim_${previews.size+1}`;
      previews.set(id, claims); return id;
    },
    verifyPreview: async value => previews.get(value) ?? null,
  };
  return { deps, data, observed, generationSchema, drop: () => pool.query(`DROP SCHEMA ${generationSchema} CASCADE`) };
}
describe('durable-only bound settings composition', () => {
  it('refuses an obsolete or incomplete authority composition without contacting a pool or using legacy save', async () => {
    const attempts = vi.spyOn(pool, 'connect');
    try {
      const obsolete = { pool, schema, request: await readBoundRequestSession(),
        readTrustedBinding: async () => ownerContext, issuePreview: vi.fn(), verifyPreview: vi.fn() };
      const incomplete = bindPatientNumberingSettingsRequest(obsolete as unknown as BoundSettingsDependencies);
      for (const result of await Promise.all([
        incomplete.read(null), incomplete.preview(requestDraft),
        incomplete.save({ ...body, preview: 'A-00037' }), incomplete.readDisposition(body.requestId),
        incomplete.retireExpired(body.requestId),
      ])) expect(result).toEqual({ ok: false, reason: 'owner-numbering-not-activated' });
      expect(attempts).not.toHaveBeenCalled();
      expect(obsolete.issuePreview).not.toHaveBeenCalled();
      expect(obsolete.verifyPreview).not.toHaveBeenCalled();
    } finally { attempts.mockRestore(); }
    const strict = createPatientNumberingSettings({ backend: active(await readBoundRequestSession()),
      requireDisposition: true, issuePreview: vi.fn(), verifyPreview: vi.fn() });
    expect(await strict.read(null)).toEqual({ ok: false, reason: 'owner-numbering-not-activated' });
    expect(await strict.preview(requestDraft)).toEqual({ ok: false, reason: 'owner-numbering-not-activated' });
    expect(await strict.save({ ...body, preview: 'A-00037' })).toEqual({ ok: false, reason: 'owner-numbering-not-activated' });
    expect(await counts()).toEqual({ audits: 0, receipts: 0 });
  });
  it('requires a real locked ledger even for initial read or preview', async () => {
    const { deps, drop } = await provisionBound({ ledger: false });
    try {
      const prepared = bindPatientNumberingSettingsRequest(deps);
      expect(await prepared.read(null)).toEqual({ ok: false, reason: 'numbering-transaction-failed' });
      expect(await prepared.preview(requestDraft)).toEqual({ ok: false, reason: 'numbering-transaction-failed' });
      expect(await prepared.save({ ...body, preview: 'A-00037' })).toEqual({ ok: false, reason: 'numbering-transaction-failed' });
      expect(await counts()).toEqual({ audits: 0, receipts: 0 });
    } finally { await drop(); }
  });
  it('uses a real signed request and couples managed admission, owner and ledger on the actual PostgreSQL client', async () => {
    const { deps, observed, drop } = await provisionBound();
    try {
      const configured = bindPatientNumberingSettingsRequest(deps), issued = await configured.preview(requestDraft);
      if (!issued.ok) throw Error('Failed durable synthetic preview: ' + issued.reason);
      const { ticket } = issued;
      expect(await configured.save(ticket)).toMatchObject({ ok: true, replay: false });
      expect(await configured.read(ticket.requestId)).toMatchObject({ ok: true, receipt: { requestId: ticket.requestId } });
      expect(await configured.retireExpired(ticket.requestId)).toEqual({ ok: true, state: 'committed' });
      expect(await counts()).toEqual({ audits: 1, receipts: 1 });
      expect(new Set(observed.map(o => o.xid)).size).toBe(4);
      for (const step of observed) {
        expect(new Set(observed.filter(o => o.xid === step.xid).map(o => o.pid)).size).toBe(1);
      }
    } finally { await drop(); }
  });
  it('rejects untrusted owner proof, mismatched owner/lineage, stale managed proof and re-enrolled exact receipt', async () => {
    const { deps, data, drop } = await provisionBound();
    try {
      const configured = bindPatientNumberingSettingsRequest(deps);
      const forged = bindPatientNumberingSettingsRequest({ ...deps, request: { ...deps.request } as BoundRequestSession });
      const stale = bindPatientNumberingSettingsRequest({ ...deps, managedGeneration: { ...deps.managedGeneration, generation: '2' } });
      const wrongLineage = bindPatientNumberingSettingsRequest({ ...deps, managedGeneration: {
        ...deps.managedGeneration, lineage: '666aabbc-3333-4cdd-9ebb-177888999abd',
      } });
      expect(await forged.preview(requestDraft)).toEqual({ ok: false, reason: 'owner-required' });
      expect(await stale.read(null)).toEqual({ ok: false, reason: 'numbering-transaction-failed' });
      expect(await wrongLineage.read(null)).toEqual({ ok: false, reason: 'numbering-transaction-failed' });
      await pool.query(`UPDATE ${deps.managedGeneration.schema}.generation_state SET phase='FENCED'`);
      expect(await configured.read(null)).toEqual({ ok: false, reason: 'numbering-transaction-failed' });
      await pool.query(`UPDATE ${deps.managedGeneration.schema}.generation_state SET phase='MANAGED'`);
      data.actorId = actor + 1;
      expect(await configured.preview(requestDraft)).toEqual({ ok: false, reason: 'owner-required' });
      data.actorId = actor; data.lineage = 'synthetic_foreign_enrollment_lineage';
      expect(await configured.preview(requestDraft)).toEqual({ ok: false, reason: 'owner-required' });
      data.lineage = lineage;
      const issued = await configured.preview(requestDraft);
      if (!issued.ok) throw Error('Failed durable synthetic preview: ' + issued.reason);
      expect(await configured.save(issued.ticket)).toMatchObject({ ok: true, replay: false });
      data.enrollment = 'synthetic_immutable_binding_B';
      expect(await configured.read(issued.ticket.requestId)).toEqual({ ok: false, reason: 'receipt-unresolved' });
      expect(await configured.save(issued.ticket)).toEqual({ ok: false, reason: 'receipt-unresolved' });
      expect(await counts()).toEqual({ audits: 1, receipts: 1 });
    } finally { await drop(); }
  });
});
