import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { stagedRestore } from '../../lib/restore/staging';

vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

// Native PG18 only. The fixture owns three newly created, identity-checked DBs.
// SQL seeding tests upgrade/restore integrity; HTTP tests cover actual issuance.
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let directory: string;
let originalRx: unknown;
let originalPrescription: unknown;
const historyTables = ['prescriptions', 'prescription_issuance_commands',
  'appointment_purpose_provenance', 'appointment_booking_commands'] as const;
const rows = async (pool: Pool, table: typeof historyTables[number]) =>
  (await pool.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;

beforeAll(async () => {
  fixture = await openBackupTimestampFixture(process.env);
  directory = await mkdtemp(join(tmpdir(), 'appointments-rx-composed-'));
  const files = await loadMigrationFiles();
  await migrate(fixture.source, { apply: true, files: files.filter(file => file.version <= '0093') });
  await fixture.source.query(`
    INSERT INTO users(id,username,display_name,password_hash,role,is_active)
      VALUES(3,'synthetic-composed','Synthetic','synthetic-not-a-password','reception',true);
    INSERT INTO patients(id,patient_number,full_name)
      VALUES(7,'SYN-COMPOSED-7','Synthetic composed patient');
    INSERT INTO visits(id,patient_id,patient_name,status)
      VALUES(9,7,'Synthetic composed patient','finished');
    INSERT INTO prescriptions(id,patient_id,visit_id,items,created_by)
      VALUES(11,7,9,'[{"name":"Synthetic archive fixture"}]','synthetic-composed');`);
  await fixture.source.query(`INSERT INTO prescription_issuance_commands
    (command_key,actor_user_id,actor_username,patient_id,visit_id,payload_sha256,prescription_id)
    VALUES($1,3,'synthetic-composed',7,9,$2,11)`, [randomUUID(), 'a'.repeat(64)]);
  originalRx = await rows(fixture.source, 'prescription_issuance_commands');
  originalPrescription = await rows(fixture.source, 'prescriptions');
  await migrate(fixture.source, { apply: true, files });
  await fixture.source.query(`INSERT INTO appointments(id,patient_id,scheduled_date,scheduled_time,clinical_category)
    VALUES(13,7,'2030-01-15','10:00','filling'),(14,7,'2030-01-16','11:00','other')`);
  await fixture.source.query(`INSERT INTO appointment_purpose_provenance
    (appointment_id,patient_id,purpose,recorded_by,command_id,command_hash,actor_user_id)
    VALUES(13,7,'consultation','synthetic-composed',$1,$2,3)`, [randomUUID(), 'b'.repeat(64)]);
  await fixture.source.query(`INSERT INTO appointment_booking_commands
    (command_id,appointment_id,patient_id,actor_user_id,recorded_by,command_hash)
    VALUES($1,14,7,3,'synthetic-composed',$2)`, [randomUUID(), 'c'.repeat(64)]);
  const { backupSqlLines } = await import('../../lib/db');
  const client = await fixture.source.connect();
  try {
    let sql = '';
    for await (const line of backupSqlLines(client)) sql += line;
    await writeFile(join(directory, 'composed.sql'), sql);
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source: client,
      readDocument: async () => { throw new Error('No synthetic documents expected'); } })) blocks.push(block);
    await writeFile(join(directory, 'composed.tar.gz'), gzipSync(Buffer.concat(blocks)));
  } finally { client.release(); }
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function verify(pool: Pool) {
  for (const table of historyTables) expect(await rows(pool, table)).toEqual(await rows(fixture.source, table));
  const files = await loadMigrationFiles();
  expect((await pool.query('SELECT version,name,checksum,adopted FROM schema_migrations ORDER BY version')).rows)
    .toEqual(files.map(({ version, name, checksum }) => ({ version, name, checksum, adopted: false })));
  expect(files.some(file => file.version === '0094')).toBe(false);
  for (const table of historyTables.slice(1)) {
    await expect(pool.query(`DELETE FROM ${table}`)).rejects.toThrow(/immutable/i);
    await expect(pool.query(`TRUNCATE ${table}`)).rejects.toThrow(/immutable|HISTORY_RETAINED/i);
  }
  await expect(pool.query('DELETE FROM prescriptions WHERE id=11')).rejects.toThrow();
  await expect(pool.query('DELETE FROM appointments WHERE id IN (13,14)')).rejects.toThrow();
  // Refused writes must leave all three families byte-for-byte unchanged.
  for (const table of historyTables) expect(await rows(pool, table)).toEqual(await rows(fixture.source, table));
}

it('adds appointment migrations after populated Rx0093 without rewriting its receipt', async () => {
  expect(await rows(fixture.source, 'prescription_issuance_commands')).toEqual(originalRx);
  expect(await rows(fixture.source, 'prescriptions')).toEqual(originalPrescription);
  await verify(fixture.source);
});

it('official SQL restore retains combined receipt history and all immutable guards', async () => {
  await migrate(fixture.sqlTarget, { apply: true, files: await loadMigrationFiles() });
  const result = await promisify(execFile)(process.execPath, ['scripts/restore.mjs', join(directory, 'composed.sql')],
    { env: { ...process.env, DATABASE_URL: fixture.sqlTarget.options.connectionString!, SKIP_SEED: 'true' } });
  expect(result.stdout).toContain('تمت الاستعادة');
  await verify(fixture.sqlTarget);
}, 120_000);

it('official archive restore retains combined receipt history and all immutable guards', async () => {
  const result = await stagedRestore({ archivePath: join(directory, 'composed.tar.gz'),
    targetUrl: fixture.archiveTarget.options.connectionString!, stagingDir: join(directory, 'documents') });
  expect(result).toMatchObject({ ok: true, errors: [], validationErrors: [], readyForCutover: true });
  await verify(fixture.archiveTarget);
}, 120_000);
