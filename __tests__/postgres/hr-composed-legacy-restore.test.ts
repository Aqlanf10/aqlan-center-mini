import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Pool } from 'pg';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { stagedRestore } from '../../lib/restore/staging';
import { parseTarBytes } from '../../lib/restore/archive';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { tarGzBytes } from '../helpers/backup-tar';
import { SYNTHETIC_DUPLICATE_PATIENT_ID, SYNTHETIC_DUPLICATE_PATIENT_SQL } from '../helpers/restore-late-constraint';
import { nextSequenceCandidate } from '../helpers/restore-sequence-observation';

vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let directory: string, archive: Buffer;

async function applicationRows(pool: Pool) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations' ORDER BY tablename")).rows;
  const result: Record<string, unknown[]> = {};
  for (const { tablename } of tables) result[tablename] = (await pool.query(`SELECT to_jsonb(t)::text AS value FROM "${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
  return result;
}
async function sequenceCandidates(pool: Pool) {
  const patientId = await pool.query<{ last_value: string; is_called: boolean }>('SELECT last_value::text, is_called FROM patients_id_seq');
  const patientNumber = await pool.query<{ last_value: string; is_called: boolean }>('SELECT last_value::text, is_called FROM patient_number_seq');
  return {
    patientId: nextSequenceCandidate(patientId.rows[0].last_value, patientId.rows[0].is_called),
    patientNumber: nextSequenceCandidate(patientNumber.rows[0].last_value, patientNumber.rows[0].is_called),
  };
}
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  directory = await mkdtemp(join(tmpdir(), 'hr-composed-legacy-restore-'));
  // Actual PR326 migration chain, with no HR schema or manually installed receipt table.
  await migrate(fixture.source, { apply: true, files: (await loadMigrationFiles()).filter(file => file.version <= '0043') });
  await fixture.source.query("INSERT INTO patients(id,patient_number,full_name) VALUES(75000,'LEGACY-SYNTHETIC','Synthetic legacy patient')");
  const client = await fixture.source.connect();
  try {
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error('No synthetic documents expected'); } })) blocks.push(block);
    archive = gzipSync(Buffer.concat(blocks));
  } finally { client.release(); }
  await writeFile(join(directory, 'legacy.tar.gz'), archive);
});
afterAll(async () => {
  try { await fixture?.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
});

it('restores the actual pre-HR archive on the current migration chain without inventing employee history', async () => {
  const result = await stagedRestore({ archivePath: join(directory, 'legacy.tar.gz'), targetUrl: fixture.sqlTarget.options.connectionString!, stagingDir: join(directory, 'legacy-documents') });
  expect(result.errors).toEqual([]); expect(result.validationErrors).toEqual([]); expect(result.ok).toBe(true);
  const source = await applicationRows(fixture.source), target = await applicationRows(fixture.sqlTarget);
  for (const [table, values] of Object.entries(source)) {
    if (table === 'patients') {
      // 0080 adds only the initial CAS version; every original field stays exact.
      const decode = (rows: unknown[]) => rows.map(row => JSON.parse((row as {value: string}).value));
      expect(decode(target[table]), table).toEqual(decode(values).map(row => ({...row, patient_number_version: 1})));
    } else expect(target[table], table).toEqual(values);
  }
  expect(target.retired_patient_numbers).toEqual([]);
  expect(target.patient_numbering_policy).toEqual([]);
  for (const [table, values] of Object.entries(target)) if (table.startsWith('hr_')) expect(values, table).toEqual([]);
  const next = await fixture.sqlTarget.query("INSERT INTO patients(patient_number,full_name) VALUES('AFTER-LEGACY','Synthetic next patient') RETURNING id");
  expect(Number(next.rows[0].id)).toBeGreaterThan(75000);
});

it('refuses a truncated archive before creating any target table', async () => {
  const path = join(directory, 'truncated.tar.gz');
  await writeFile(path, archive.subarray(0, Math.floor(archive.length / 2)));
  const result = await stagedRestore({ archivePath: path, targetUrl: fixture.archiveTarget.options.connectionString!, stagingDir: join(directory, 'truncated-documents') });
  expect(result.ok).toBe(false); expect(result.readyForCutover).toBe(false); expect(result.errors.length).toBeGreaterThan(0);
  expect((await fixture.archiveTarget.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([]);
});

it('rolls back every restored data row on a late SQL failure, keeping append-only triggers and migration records intact', async () => {
  const parsed = parseTarBytes(gunzipSync(archive));
  const sql = Buffer.from(parsed.entries.get('database.sql')!.data).toString('utf8');
  expect(sql).toContain('COMMIT;');
  const faultySql = Buffer.from(sql.replace(/COMMIT;\s*$/, `${SYNTHETIC_DUPLICATE_PATIENT_SQL}\nCOMMIT;\n`));
  const manifest = JSON.parse(Buffer.from(parsed.entries.get('manifest.json')!.data).toString('utf8'));
  manifest.databaseSha256 = createHash('sha256').update(faultySql).digest('hex');
  manifest.databaseBytes = faultySql.length;
  const faultyArchive = tarGzBytes(parsed.order.map(name => ({ name, data: name === 'database.sql' ? faultySql : name === 'manifest.json' ? Buffer.from(JSON.stringify(manifest)) : parsed.entries.get(name)!.data })));
  const path = join(directory, 'late-failure.tar.gz');
  await writeFile(path, faultyArchive);
  // Snapshot the current schema-owned seed before replay; it must survive exactly,
  // while none of the archived application rows may survive the late failure.
  await migrate(fixture.archiveTarget, { apply: true });
  // This fixture creates and identity-checks each database itself. Re-read its
  // identity immediately before touching a sequence and again after replay.
  const identitySql = 'SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()';
  const identityBefore = (await fixture.archiveTarget.query<{ name: string; oid: string; owner: string }>(identitySql)).rows[0];
  const expectedName = decodeURIComponent(new URL(fixture.archiveTarget.options.connectionString!).pathname.slice(1));
  expect(/^aqlan_backup_precision_[a-f0-9]{32}$/.test(identityBefore.name) && identityBefore.name === expectedName).toBe(true);
  const originalSequences = await sequenceCandidates(fixture.archiveTarget);
  // Never lower even the owned synthetic target while preparing this witness.
  expect(originalSequences.patientId <= 100001n).toBe(true);
  await fixture.archiveTarget.query("SELECT setval('patients_id_seq', 100000, true)");
  // The archived source row must be inserted before the injected duplicate;
  // otherwise this would not exercise rollback after replay has begun.
  expect((await fixture.archiveTarget.query('SELECT EXISTS(SELECT 1 FROM patients WHERE id=$1) AS present', [SYNTHETIC_DUPLICATE_PATIENT_ID])).rows[0].present).toBe(false);
  expect((await fixture.archiveTarget.query("SELECT EXISTS(SELECT 1 FROM patients WHERE patient_number='SYN-ROLLBACK-PROBE') AS present")).rows[0].present).toBe(false);
  const beforeReplay = await applicationRows(fixture.archiveTarget);
  const sequencesBefore = await sequenceCandidates(fixture.archiveTarget);
  const registryBefore = (await fixture.archiveTarget.query('SELECT version,name,checksum,adopted,applied_at FROM schema_migrations ORDER BY version')).rows;
  const result = await stagedRestore({ archivePath: path, targetUrl: fixture.archiveTarget.options.connectionString!, stagingDir: join(directory, 'failed-documents'), allowNonEmptyTarget: true });
  expect(result.validationErrors).toEqual([]); expect(result.ok).toBe(false); expect(result.readyForCutover).toBe(false);
  expect(result.errors.join(' ')).toContain('duplicate key value violates unique constraint "patients_pkey"');
  expect(await applicationRows(fixture.archiveTarget)).toEqual(beforeReplay);
  const sequencesAfter = await sequenceCandidates(fixture.archiveTarget);
  const identityAfter = (await fixture.archiveTarget.query<{ name: string; oid: string; owner: string }>(identitySql)).rows[0];
  expect(identityAfter.name === identityBefore.name && identityAfter.oid === identityBefore.oid && identityAfter.owner === identityBefore.owner).toBe(true);
  const files = await loadMigrationFiles();
  expect(files.find(file => file.version === '0079')?.checksum).toBe('5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99');
  const registryAfter = (await fixture.archiveTarget.query('SELECT version,name,checksum,adopted,applied_at FROM schema_migrations ORDER BY version')).rows;
  expect(registryAfter).toEqual(registryBefore);
  expect(registryAfter.map(row => row.version)).toEqual(files.filter(file => file.version !== '0079').map(file => file.version));
  expect((await fixture.archiveTarget.query("SELECT to_regclass('public.ortho_followup_coverage_revisions') AS name")).rows).toEqual([{name:null}]);
  expect((await fixture.archiveTarget.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'")).rows).toEqual([]);
  expect((await fixture.archiveTarget.query('SHOW session_replication_role')).rows[0].session_replication_role).toBe('origin');
  // Run these last, so a sequence regression cannot hide the row/registry checks.
  for (const key of ['patientId', 'patientNumber'] as const) {
    // setval is not transactional. Notice any advancement without printing values;
    // an increase is evidence, not a decision that it is acceptable policy.
    if (sequencesAfter[key] > sequencesBefore[key]) {
      try { process.stdout.write(`::notice title=Synthetic restore sequence::sequence=${key} state=advanced\n`); }
      catch { /* Reporting must not change the rollback witness. */ }
    }
    expect(sequencesAfter[key] >= sequencesBefore[key]).toBe(true);
  }
});
