import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { performance } from 'node:perf_hooks';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { identityCandidate } from './_hr-identity-candidate';
import { applyRuntimeMigrationFiles, migrate, MIGRATION_ADVISORY_LOCK_KEY } from '../../lib/migrations';
import { checksumOf, loadMigrationFiles, type MigrationFile } from '../../lib/migration-files';
import { readPersonIdentitySchema } from '../../lib/hr-person-identity-schema-state';
import { identityDatabaseState } from '../helpers/hr-identity-state';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';

vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>, db: typeof import('../../lib/db');
let mainFiles: MigrationFile[];
const keys = ['DATABASE_URL', 'SKIP_SEED', 'DB_POOL_MAX'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
beforeEach(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  mainFiles = await loadMigrationFiles();
  await migrate(fixture.source, { apply: true, files: mainFiles });
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  process.env.SKIP_SEED = 'false'; process.env.DB_POOL_MAX = '4';
  db = await import('../../lib/db'); await db.resetPoolForTesting(); await db.ensureSchema();
});
afterEach(async () => {
  try { await db?.resetPoolForTesting(); await fixture?.close(); }
  finally { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
});
async function account(username: string): Promise<SessionPayload> {
  const { rows: [row] } = await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic account','synthetic-hash','admin') RETURNING id", [username]);
  return { userId: row.id, username, role: 'admin', credentialVersion: sessionCredentialVersion('synthetic-hash'), expiresAt: Date.now() + 3600_000 };
}
async function staff(userId: number | null) {
  return (await fixture.source.query("INSERT INTO hr_staff(full_name,user_id,created_by,hire_date) VALUES('Synthetic legacy staff',$1,'synthetic','2020-01-01') RETURNING id", [userId])).rows[0].id as number;
}
async function applyCandidate(mode: 'runtime' | 'migrator', candidate = identityCandidate(), pool = fixture.source) {
  return mode === 'runtime' ? applyRuntimeMigrationFiles(pool, [candidate])
    : migrate(pool, { apply: true, files: [...mainFiles, candidate] });
}

it('upgrades main without rewriting legacy users, employment, access or pending request evidence; startup repeats safely', async () => {
  const requester = await account('legacy-requester'), linkedReviewer = await account('legacy-linked-reviewer'), independent = await account('independent-reviewer');
  const subjectId = await staff(requester.userId); await staff(linkedReviewer.userId);
  const work = await import('../../lib/hr-contracts-attendance');
  await work.adjustLeaveBalance({ staffId: subjectId, leaveTypeCode: 'annual', year: 2026, allocatedDays: 10 }, independent);
  const leave = await work.createLeaveRequest({ staffId: subjectId, leaveTypeCode: 'annual', startDate: '2026-09-10', endDate: '2026-09-10', daysCount: 1, reason: 'Synthetic legacy request' }, requester);
  const attendance = await work.recordAttendance({ staffId: subjectId, attendanceDate: '2026-09-11', checkIn: '2026-09-11T08:00:00Z', checkOut: '2026-09-11T16:00:00Z' }, independent);
  const correction = await work.requestAttendanceCorrection({ attendanceRecordId: attendance.id, fieldCorrected: 'check_in', newCheckIn: '2026-09-11T09:00:00Z', reason: 'Synthetic legacy correction' }, requester);
  const users = (await fixture.source.query('SELECT to_jsonb(u) AS value FROM users u ORDER BY id')).rows;
  const profile = (await fixture.source.query('SELECT to_jsonb(s) AS value FROM hr_staff s ORDER BY id')).rows;
  await applyCandidate('runtime');
  expect(await readPersonIdentitySchema(fixture.source)).toMatch(/^[a-f0-9]{64}$/);
  expect((await fixture.source.query('SELECT to_jsonb(u) AS value FROM users u ORDER BY id')).rows).toEqual(users);
  expect((await fixture.source.query("SELECT to_jsonb(s)-'identity_revision' AS value FROM hr_staff s ORDER BY id")).rows).toEqual(profile);
  for (const table of ['hr_leave_requests', 'hr_attendance_corrections']) {
    expect((await fixture.source.query(`SELECT requester_user_id,identity_evidence,status FROM ${table}`)).rows).toEqual([{ requester_user_id: null, identity_evidence: null, status: 'pending' }]);
  }
  const before = await identityDatabaseState(fixture.source);
  await db.resetPoolForTesting(); await db.ensureSchema();
  await db.resetPoolForTesting(); await db.ensureSchema();
  const afterStartup = await identityDatabaseState(fixture.source);
  // Existing ON CONFLICT seed attempts consume unrelated settings/reference
  // sequences. Startup must preserve all rows and every identity sequence.
  const identityState = (state: Record<string, unknown>) => Object.fromEntries(Object.entries(state)
    .filter(([key]) => key.startsWith('table:') || /^sequence:hr_(staff|identity)_/.test(key)));
  expect(identityState(afterStartup)).toEqual(identityState(before));
  await expect(work.decideLeaveRequest(leave.id, 'approved', 'Legacy self attempt', requester)).rejects.toMatchObject({ status: 403 });
  await expect(work.decideLeaveRequest(leave.id, 'approved', 'Ambiguous legacy actor', linkedReviewer)).rejects.toMatchObject({ status: 409 });
  await expect(work.decideAttendanceCorrection(correction.id, 'approved', 'Ambiguous legacy actor', linkedReviewer)).rejects.toMatchObject({ status: 409 });
  expect(await identityDatabaseState(fixture.source)).toEqual(afterStartup);
  expect((await work.decideLeaveRequest(leave.id, 'approved', 'Independent legacy review', independent)).status).toBe('approved');
  expect((await work.decideAttendanceCorrection(correction.id, 'approved', 'Independent legacy review', independent)).status).toBe('approved');
  const unknown = (await fixture.source.query("INSERT INTO hr_staff(full_name,created_by) VALUES('Synthetic unknown terms','synthetic') RETURNING work_status,contract_kind,salary_amount_minor")).rows[0];
  expect(unknown).toEqual({ work_status: 'unconfirmed', contract_kind: 'unspecified', salary_amount_minor: null });
});

it.each(['runtime', 'migrator'] as const)('%s rolls back all DDL and its registry row on a late SQL error', async mode => {
  const before = await identityDatabaseState(fixture.source), candidate = identityCandidate();
  const sql = `${candidate.sql}\nSELECT 1/0;`;
  await expect(applyCandidate(mode, { ...candidate, sql, checksum: checksumOf(sql) })).rejects.toMatchObject({ code: '22012' });
  expect(await readPersonIdentitySchema(fixture.source)).toBeNull();
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
});

it.each(['runtime', 'migrator'] as const)('%s rejects source/checksum disagreement before schema or registry writes', async mode => {
  const before = await identityDatabaseState(fixture.source);
  await expect(applyCandidate(mode, { ...identityCandidate(), checksum: '0'.repeat(64) })).rejects.toThrow(/SOURCE_MISMATCH/);
  expect(await readPersonIdentitySchema(fixture.source)).toBeNull();
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
});

it.each(['runtime', 'migrator'] as const)('%s refuses unregistered partial schema and rolls back its attempted defaults/columns', async mode => {
  await fixture.source.query('CREATE TABLE hr_identity_import_runs(synthetic_collision BOOLEAN)');
  const before = await identityDatabaseState(fixture.source);
  await expect(applyCandidate(mode)).rejects.toMatchObject({ code: '42P07' });
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
  expect((await fixture.source.query("SELECT column_name,column_default FROM information_schema.columns WHERE table_name='hr_staff' AND column_name IN ('identity_revision','work_status')")).rows).toEqual([{ column_name: 'work_status', column_default: "'active'::text" }]);
  await expect(readPersonIdentitySchema(fixture.source)).rejects.toMatchObject({ status: 503 });
});

it.each(['runtime', 'migrator'] as const)('%s rejects a changed registered checksum without changing identity history', async mode => {
  await applyCandidate('runtime');
  await fixture.source.query('UPDATE schema_migrations SET checksum=$2 WHERE version=$1', [identityCandidate().version, '0'.repeat(64)]);
  const before = await identityDatabaseState(fixture.source);
  await expect(applyCandidate(mode)).rejects.toThrow(/REGISTRY_MISMATCH|بصمة الهجرة/);
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
});

it.each(['runtime', 'migrator'] as const)('%s rejects a falsely adopted candidate instead of silently skipping it', async mode => {
  await applyCandidate('runtime');
  await fixture.source.query('UPDATE schema_migrations SET adopted=true WHERE version=$1', [identityCandidate().version]);
  const before = await identityDatabaseState(fixture.source);
  await expect(applyCandidate(mode)).rejects.toThrow(/REGISTRY_MISMATCH/);
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
});

it('runtime and migrator serialize on the same lock, register once and repeat without writes', async () => {
  const concurrent = new Pool({ connectionString: fixture.source.options.connectionString, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  const blocker = await fixture.source.connect();
  let operations: Promise<unknown>[] = [];
  try {
    await blocker.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    operations = [applyCandidate('runtime', identityCandidate(), concurrent), applyCandidate('migrator', identityCandidate(), concurrent)];
    const deadline = performance.now() + 5000;
    let waiting = 0;
    while (waiting < 2 && performance.now() < deadline) {
      waiting = (await blocker.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")).rows[0].n;
      if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(2);
    await blocker.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    await Promise.all(operations);
    expect((await blocker.query('SELECT count(*)::int AS n FROM schema_migrations WHERE version=$1', [identityCandidate().version])).rows[0].n).toBe(1);
  } finally {
    await blocker.query('SELECT pg_advisory_unlock_all()'); blocker.release();
    await Promise.allSettled(operations); await concurrent.end();
  }
  const before = await identityDatabaseState(fixture.source);
  expect(await applyCandidate('runtime')).toEqual([]);
  expect(await applyCandidate('migrator')).toMatchObject({ alreadyUpToDate: true });
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
});

it.each(['runtime', 'migrator'] as const)('%s respects a bounded DDL lock wait and leaves no partial upgrade', async mode => {
  const blocked = new Pool({ connectionString: fixture.source.options.connectionString, max: 1, lock_timeout: 150, statement_timeout: 2000 });
  const blocker = await fixture.source.connect();
  let elapsed = 0;
  try {
    await blocker.query('BEGIN'); await blocker.query('LOCK TABLE hr_staff IN ACCESS SHARE MODE');
    const started = performance.now();
    await expect(applyCandidate(mode, identityCandidate(), blocked)).rejects.toMatchObject({ code: '55P03' });
    elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await blocked.end(); }
  expect(await readPersonIdentitySchema(fixture.source)).toBeNull();
  expect((await fixture.source.query('SELECT count(*)::int AS n FROM schema_migrations WHERE version=$1', [identityCandidate().version])).rows[0].n).toBe(0);
  console.info(`${mode}: blocked hr_staff DDL cancelled in ${Math.round(elapsed)}ms (lock_timeout=150ms)`);
});

it('statement_timeout cancels late SQL and rolls back schema while releasing the advisory lock', async () => {
  const bounded = new Pool({ connectionString: fixture.source.options.connectionString, max: 1, lock_timeout: 1000, statement_timeout: 150 });
  const candidate = identityCandidate(), sql = `${candidate.sql}\nSELECT pg_sleep(3);`;
  try { await expect(applyCandidate('runtime', { ...candidate, sql, checksum: checksumOf(sql) }, bounded)).rejects.toMatchObject({ code: '57014' }); }
  finally { await bounded.end(); }
  expect(await readPersonIdentitySchema(fixture.source)).toBeNull();
  const client = await fixture.source.connect();
  try {
    expect((await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [MIGRATION_ADVISORY_LOCK_KEY])).rows[0].acquired).toBe(true);
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
  } finally { client.release(); }
});

it('lock_timeout also bounds the initial advisory wait, before any DDL runs', async () => {
  const bounded = new Pool({ connectionString: fixture.source.options.connectionString, max: 1, lock_timeout: 150, statement_timeout: 2000 });
  const blocker = await fixture.source.connect();
  try {
    await blocker.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    await expect(applyCandidate('runtime', identityCandidate(), bounded)).rejects.toMatchObject({ code: '55P03' });
  } finally {
    await blocker.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    blocker.release(); await bounded.end();
  }
  expect(await readPersonIdentitySchema(fixture.source)).toBeNull();
});
