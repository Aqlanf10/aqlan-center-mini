import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { identityCandidate } from './_hr-identity-candidate';
import { applyRuntimeMigrationFiles, loadMigrationFiles, migrate } from '../../lib/migrations';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { stagedRestore } from '../../lib/restore/staging';
import { readPersonIdentitySchema } from '../../lib/hr-person-identity-schema-state';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';

vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock('../../lib/migration-files', async original => {
  const real = await original<typeof import('../../lib/migration-files')>();
  return { ...real, loadMigrationFiles: async (dir?: string) => [...await real.loadMigrationFiles(dir), identityCandidate()] };
});
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>, db: typeof import('../../lib/db');
let work: typeof import('../../lib/hr-contracts-attendance'), directory: string, requester: SessionPayload;
let subjectId: number, leaveId: number, correctionId: number;
const keys = ['DATABASE_URL', 'SKIP_SEED', 'DB_POOL_MAX'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  directory = await mkdtemp(join(tmpdir(), 'hr-legacy-identity-restore-'));
  // Use the actual main chain, deliberately excluding the candidate file.
  await migrate(fixture.source, { apply: true, files: (await loadMigrationFiles()).filter(file => file.version !== identityCandidate().version) });
  process.env.DATABASE_URL = fixture.source.options.connectionString!; process.env.SKIP_SEED = 'false'; process.env.DB_POOL_MAX = '4';
  db = await import('../../lib/db'); work = await import('../../lib/hr-contracts-attendance');
  await db.resetPoolForTesting(); await db.ensureSchema();
  expect(await readPersonIdentitySchema(fixture.source)).toBeNull();
  const { rows: [user] } = await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('legacy-requester','Synthetic legacy requester','synthetic-hash','admin') RETURNING id");
  requester = { userId: user.id, username: 'legacy-requester', role: 'admin', credentialVersion: sessionCredentialVersion('synthetic-hash'), expiresAt: Date.now() + 3600_000 };
  subjectId = (await fixture.source.query("INSERT INTO hr_staff(full_name,user_id,created_by,hire_date) VALUES('Synthetic legacy employee',$1,'synthetic','2020-01-01') RETURNING id", [requester.userId])).rows[0].id;
  await work.adjustLeaveBalance({ staffId: subjectId, leaveTypeCode: 'annual', year: 2026, allocatedDays: 10 }, requester);
  leaveId = (await work.createLeaveRequest({ staffId: subjectId, leaveTypeCode: 'annual', startDate: '2026-09-10', endDate: '2026-09-10', daysCount: 1, reason: 'Synthetic old pending leave' }, requester)).id;
  const attendance = await work.recordAttendance({ staffId: subjectId, attendanceDate: '2026-09-11', checkIn: '2026-09-11T08:00:00Z', checkOut: '2026-09-11T16:00:00Z' }, requester);
  correctionId = (await work.requestAttendanceCorrection({ attendanceRecordId: attendance.id, fieldCorrected: 'check_in', newCheckIn: '2026-09-11T09:00:00Z', reason: 'Synthetic old pending correction' }, requester)).id;
  const client = await fixture.source.connect();
  try {
    let sql = ''; for await (const line of db.backupSqlLines(client)) sql += line;
    await writeFile(join(directory, 'legacy.sql'), sql);
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error('No fixture documents'); } })) blocks.push(block);
    await writeFile(join(directory, 'legacy.tar.gz'), gzipSync(Buffer.concat(blocks)));
  } finally { client.release(); }
});
afterAll(async () => {
  try { await db?.resetPoolForTesting(); await fixture?.close(); }
  finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function assertLegacyRestore(target: Pool) {
  expect(await readPersonIdentitySchema(target)).toMatch(/^[a-f0-9]{64}$/);
  const original = (await fixture.source.query('SELECT to_jsonb(s) AS value FROM hr_staff s ORDER BY id')).rows;
  expect((await target.query("SELECT to_jsonb(s)-'identity_revision' AS value FROM hr_staff s ORDER BY id")).rows).toEqual(original);
  for (const table of ['hr_leave_requests', 'hr_attendance_corrections']) {
    expect((await target.query(`SELECT to_jsonb(r)-'requester_user_id'-'identity_evidence' AS value FROM ${table} r ORDER BY id`)).rows)
      .toEqual((await fixture.source.query(`SELECT to_jsonb(r) AS value FROM ${table} r ORDER BY id`)).rows);
    expect((await target.query(`SELECT requester_user_id,identity_evidence,status FROM ${table}`)).rows)
      .toEqual([{ requester_user_id: null, identity_evidence: null, status: 'pending' }]);
  }
  expect((await target.query('SELECT user_id,identity_revision,work_status,contract_kind FROM hr_staff WHERE id=$1', [subjectId])).rows[0])
    .toEqual({ user_id: requester.userId, identity_revision: 0, work_status: 'active', contract_kind: 'commission' });
  for (const table of ['hr_identity_import_runs', 'hr_identity_events', 'hr_staff_account_links', 'hr_staff_party_links']) {
    expect((await target.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
  }
  process.env.DATABASE_URL = target.options.connectionString!; process.env.SKIP_SEED = 'true';
  await db.resetPoolForTesting();
  await expect(work.decideLeaveRequest(leaveId, 'approved', 'Legacy self attempt after restore', requester)).rejects.toMatchObject({ status: 403 });
  await expect(work.decideAttendanceCorrection(correctionId, 'approved', 'Legacy self attempt after restore', requester)).rejects.toMatchObject({ status: 403 });
  expect((await target.query('SHOW session_replication_role')).rows[0].session_replication_role).toBe('origin');
}

it('restores pre-identity main SQL with old pending requests and no invented requester evidence', async () => {
  process.env.DATABASE_URL = fixture.sqlTarget.options.connectionString!; process.env.SKIP_SEED = 'true';
  await db.resetPoolForTesting(); await db.ensureSchema();
  await applyRuntimeMigrationFiles(fixture.sqlTarget, [identityCandidate()]);
  const result = await promisify(execFile)(process.execPath, ['scripts/restore.mjs', join(directory, 'legacy.sql')], { env: { ...process.env } });
  expect(result.stdout).toContain('تمت الاستعادة');
  await assertLegacyRestore(fixture.sqlTarget);
});

it('restores pre-identity full archive through real migrator and keeps legacy access and approval restrictions', async () => {
  const result = await stagedRestore({ archivePath: join(directory, 'legacy.tar.gz'), targetUrl: fixture.archiveTarget.options.connectionString!, stagingDir: join(directory, 'documents') });
  expect(result.errors).toEqual([]); expect(result.ok).toBe(true);
  await assertLegacyRestore(fixture.archiveTarget);
});
