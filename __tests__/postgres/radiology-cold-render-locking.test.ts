/** Causal characterization, not a product fix: real initializer and read helper,
 * real SQL/results/locks in a verified disposable native PostgreSQL fixture. */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { DbClient } from '../../lib/db';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { issueRadiologyRequest, readRadiologyRequest } from '../../lib/radiology-request-service';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: typeof import('../../lib/db');
let observer: Client;
let session: SessionPayload, requestKey: string, patientId: number, originalReceipt: string;
const priorUrl = process.env.DATABASE_URL, priorSeed = process.env.SKIP_SEED, priorPoolMax = process.env.DB_POOL_MAX;
beforeAll(async () => {
  fixture = await openBackupTimestampFixture(process.env);
  await migrate(fixture.source, { apply: true, files: await loadMigrationFiles() });
  process.env.DATABASE_URL = fixture.source.options.connectionString!; process.env.SKIP_SEED = 'true'; process.env.DB_POOL_MAX = '3';
  db = await import('../../lib/db'); await db.resetPoolForTesting(); await db.ensureSchema();
  // Separate observer: never consumes an app-pool connection needed by the race.
  observer = new Client({ connectionString: fixture.source.options.connectionString, ssl: false, application_name: 'synthetic-radiology-lock-observer', statement_timeout: 5000 });
  await observer.connect();
  const { rows: [identity] } = await observer.query('SELECT current_database() AS name');
  expect(identity.name).toBe(new URL(fixture.source.options.connectionString!).pathname.slice(1));
  const { rows: [doctor] } = await observer.query("INSERT INTO parties(name,kind) VALUES('Synthetic cold-render doctor','doctor') RETURNING id");
  const username = `cold-radiology-${randomUUID()}`;
  const { rows: [user] } = await observer.query("INSERT INTO users(username,display_name,password_hash,role,is_active,party_id,permissions) VALUES($1,'Synthetic cold-render user','synthetic-cold-hash','doctor',true,$2,'{\"canViewAllPatients\":true}') RETURNING id", [username, doctor.id]);
  const { rows: [patient] } = await observer.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic cold-render patient') RETURNING id", [`COLD-RAD-${randomUUID()}`]);
  patientId = patient.id; requestKey = randomUUID(); const centerId = randomUUID();
  await observer.query("INSERT INTO settings(key,value) VALUES('clinical.radiology_centers',$1),('clinic.name','Synthetic cold-render clinic') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify([{ id: centerId, name: 'Synthetic center', address: 'Synthetic address', active: true }])]);
  session = { userId: user.id, username, role: 'doctor', credentialVersion: sessionCredentialVersion('synthetic-cold-hash'), expiresAt: Date.now() + 600_000 };
  await issueRadiologyRequest(session, requestKey, { patientId, visitId: null, centerId, examination: 'Synthetic examination', region: 'Synthetic region', notes: '' });
  originalReceipt = (await observer.query('SELECT to_jsonb(r)::text AS row FROM radiology_requests r WHERE command_key=$1', [requestKey])).rows[0].row;
});
afterAll(async () => {
  try { await observer?.end(); await db?.resetPoolForTesting(); }
  finally {
    if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
    if (priorSeed === undefined) delete process.env.SKIP_SEED; else process.env.SKIP_SEED = priorSeed;
    if (priorPoolMax === undefined) delete process.env.DB_POOL_MAX; else process.env.DB_POOL_MAX = priorPoolMax;
    await fixture?.close();
  }
});
function outcome<T>(promise: Promise<T>) {
  // Attach rejection handling immediately; no unhandled rejection while gated.
  return promise.then(value => ({ ok: true as const, value }), (error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'OTHER';
    return { ok: false as const, code };
  });
}
it('exposes initializer/read lock inversion after real users SHARE with exact backend witnesses', async () => {
  const pool = db.getPool();
  let unlock!: () => void, reached = false, readerReleased = false;
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  let restoreConnect: (() => void) | undefined, restoreQuery: (() => void) | undefined;
  let releaseReader: (() => void) | undefined, releaseInitializer: (() => void) | undefined;
  let reading: ReturnType<typeof outcome<Awaited<ReturnType<typeof readRadiologyRequest>>>> | undefined;
  let initializing: ReturnType<typeof outcome<void>> | undefined;
  try {
    const reader = await pool.connect(); releaseReader = () => { if (!readerReleased) reader.release(); };
    const initializer = await pool.connect(); releaseInitializer = () => initializer.release();
    const readPid = (await reader.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const initPid = (await initializer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    expect(readPid).not.toBe(initPid);
    const wrapped: DbClient = {
      query: async <T>(sql: string, values?: unknown[]) => {
        const result = await reader.query<T>(sql, values);
        if (!reached && sql === 'SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND is_active LIMIT 1 FOR SHARE') {
          reached = true; await gate;
        }
        return result;
      },
      release: destroy => { readerReleased = true; reader.release(destroy); },
    };
    const connectSpy = vi.spyOn(pool, 'connect').mockResolvedValueOnce(wrapped);
    restoreConnect = () => connectSpy.mockRestore();
    reading = outcome(readRadiologyRequest(session, requestKey, patientId));
    await expect.poll(() => reached, { timeout: 5000, interval: 20 }).toBe(true);
    restoreConnect();
    // Instrument only the real first initializer query to identify its backend.
    // Same SQL/parameters and real returned results; no fabricated query result.
    const querySpy = vi.spyOn(pool, 'query').mockImplementationOnce((sql, values) => {
      expect(sql.trimStart().startsWith('CREATE TABLE IF NOT EXISTS staff_login_limits')).toBe(true);
      return initializer.query(sql, values);
    });
    restoreQuery = () => querySpy.mockRestore();
    db.schemaReadyReset(); initializing = outcome(db.ensureSchema()); restoreQuery();
    await expect.poll(async () => {
      const { rows: [witness] } = await observer.query<{ users_wait: boolean; parties_held: boolean; patients_held: boolean }>(`
        SELECT
          $1::int = ANY(pg_blocking_pids($2::int)) AND EXISTS (
            SELECT 1 FROM pg_locks WHERE pid=$2 AND relation='public.users'::regclass
              AND mode='AccessExclusiveLock' AND NOT granted) AS users_wait,
          EXISTS (SELECT 1 FROM pg_locks WHERE pid=$2 AND relation='public.parties'::regclass
            AND mode='AccessExclusiveLock' AND granted) AS parties_held,
          EXISTS (SELECT 1 FROM pg_locks WHERE pid=$2 AND relation='public.patients'::regclass
            AND mode='AccessExclusiveLock' AND granted) AS patients_held`, [readPid, initPid]);
      // Only booleans enter assertion output: never query text, credentials or rows.
      return witness;
    }, { timeout: 5000, interval: 20 }).toEqual({ users_wait: true, parties_held: true, patients_held: true });
    unlock();
    const results = await Promise.all([reading, initializing]);
    // PostgreSQL chooses a victim; either actual participant may receive 40P01.
    expect(results.filter(result => !result.ok).map(result => result.code)).toContain('40P01');
    expect(results.every(result => result.ok || result.code === '40P01')).toBe(true);
  } finally {
    unlock(); restoreConnect?.(); restoreQuery?.();
    await Promise.allSettled([reading, initializing].filter(promise => promise !== undefined));
    releaseReader?.(); releaseInitializer?.();
  }
  expect((await observer.query('SELECT to_jsonb(r)::text AS row FROM radiology_requests r WHERE command_key=$1', [requestKey])).rows[0].row).toBe(originalReceipt);
}, 120_000);
it('ordered initialization before the actual read succeeds without changing the receipt', async () => {
  db.schemaReadyReset(); await db.ensureSchema();
  const record = await readRadiologyRequest(session, requestKey, patientId);
  expect(record).toMatchObject({ id: requestKey, patientId, snapshot: { patientName: 'Synthetic cold-render patient' } });
  expect((await observer.query('SELECT to_jsonb(r)::text AS row FROM radiology_requests r WHERE command_key=$1', [requestKey])).rows[0].row).toBe(originalReceipt);
});
