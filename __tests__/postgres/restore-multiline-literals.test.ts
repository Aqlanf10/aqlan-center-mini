import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import type { Pool } from 'pg';
import { backupSqlLines } from '../../lib/db';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { stagedRestore } from '../../lib/restore/staging';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';

vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let directory: string;
let registry: { version: string; name: string; checksum: string }[];
const payloads = [
  [
    "ملاحظة اصطناعية: apostrophe ' and backslash \\; $$ /* --",
    "INSERT INTO schema_migrations (version) VALUES ('9999');",
    'BEGIN;',
    "UPDATE hr_staff SET full_name = 'UNINTENDED' WHERE id = 700;",
    'COMMIT;',
    'النص الأخير محفوظ حرفيًا',
  ].join('\n'),
  "CRLF start\r\nINSERT INTO schema_migrations (version) VALUES ('9998');\r\nCRLF end",
  "Quoted text ''); DROP TABLE hr_staff; --\nINSERT INTO schema_migrations (version) VALUES ('9997');\nend",
];

async function staffBytes(pool: Pool) {
  return (await pool.query("SELECT id, full_name, encode(convert_to(note, 'UTF8'), 'hex') AS note_bytes FROM hr_staff ORDER BY id")).rows;
}

beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  directory = await mkdtemp(join(tmpdir(), 'restore-multiline-'));
  const files = await loadMigrationFiles();
  registry = files.map(({ version, name, checksum }) => ({ version, name, checksum }));
  await migrate(fixture.source, { apply: true, files });
  for (const [index, note] of payloads.entries()) {
    await fixture.source.query(
      'INSERT INTO hr_staff(id,full_name,created_by,note) VALUES($1,$2,$3,$4)',
      [700 + index, `Synthetic control ${index}`, 'synthetic-fixture', note],
    );
  }
  // A historical registry is not the target's schema authority.
  await fixture.source.query("UPDATE schema_migrations SET applied_at='2000-01-01T00:00:00Z'");
  const client = await fixture.source.connect();
  try {
    let sql = '';
    for await (const block of backupSqlLines(client)) sql += block;
    expect(sql).toContain("\nINSERT INTO schema_migrations (version) VALUES (''9999'');\n");
    await writeFile(join(directory, 'backup.sql'), sql);
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error('No fixture documents'); } })) blocks.push(block);
    await writeFile(join(directory, 'backup.tar.gz'), gzipSync(Buffer.concat(blocks)));
  } finally { client.release(); }
});

afterAll(async () => {
  try { await fixture?.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
});

async function assertPreserved(target: Pool) {
  // Exact database UTF-8 bytes, names and row set: embedded SQL never executes.
  expect(await staffBytes(target)).toEqual(await staffBytes(fixture.source));
  expect((await target.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version')).rows).toEqual(registry);
  expect((await target.query("SELECT count(*)::int AS n FROM schema_migrations WHERE applied_at='2000-01-01T00:00:00Z'")).rows[0].n).toBe(0);
}

it('SQL CLI preserves multiline application bytes and never executes migration-like literal contents', async () => {
  await migrate(fixture.sqlTarget, { apply: true });
  const result = await promisify(execFile)(process.execPath, ['scripts/restore.mjs', join(directory, 'backup.sql')], {
    env: { ...process.env, DATABASE_URL: fixture.sqlTarget.options.connectionString!, SKIP_SEED: 'true' },
  });
  expect(result.stdout).toContain('تمت الاستعادة');
  await assertPreserved(fixture.sqlTarget);
});

it('full archive preserves the same literal bytes and only skips actual source registry records', async () => {
  const result = await stagedRestore({
    archivePath: join(directory, 'backup.tar.gz'),
    targetUrl: fixture.archiveTarget.options.connectionString!,
    stagingDir: join(directory, 'documents'),
  });
  expect(result.errors).toEqual([]);
  expect(result.validationErrors).toEqual([]);
  expect(result.ok).toBe(true);
  await assertPreserved(fixture.archiveTarget);
  expect(result.skippedMigrationRecordLines).toBe(registry.length);
  expect(result.sqlRowsStatementLines).toBe(payloads.length);
});

it('skips whole multiline historical registry rows and pins standard string escaping in both restore paths', async () => {
  const isolated = await openBackupTimestampFixture({ ...process.env });
  try {
    await migrate(isolated.source, { apply: true });
    const note = "Backslash then quote \\'); UPDATE hr_staff SET full_name='UNINTENDED'; --\nINSERT INTO schema_migrations at the end";
    await isolated.source.query('INSERT INTO hr_staff(id,full_name,created_by,note) VALUES(700,$1,$2,$3)', ['Synthetic control', 'synthetic-fixture', note]);
    await isolated.source.query('UPDATE schema_migrations SET name=$1 WHERE version=$2', [
      "historical\nUPDATE hr_staff SET full_name='UNINTENDED';\nINSERT INTO schema_migrations (version) VALUES ('9999');\nend", '0058',
    ]);
    const client = await isolated.source.connect();
    try {
      let sql = '';
      for await (const block of backupSqlLines(client)) sql += block;
      await writeFile(join(directory, 'multiline-registry.sql'), sql);
      const blocks: Uint8Array[] = [];
      for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error('No fixture documents'); } })) blocks.push(block);
      await writeFile(join(directory, 'multiline-registry.tar.gz'), gzipSync(Buffer.concat(blocks)));
    } finally { client.release(); }
    for (const target of [isolated.sqlTarget, isolated.archiveTarget]) {
      const { rows: [identity] } = await target.query('SELECT current_database() AS name');
      await target.query(`ALTER DATABASE "${identity.name.replaceAll('"', '""')}" SET standard_conforming_strings = off`);
    }
    await migrate(isolated.sqlTarget, { apply: true });
    await promisify(execFile)(process.execPath, ['scripts/restore.mjs', join(directory, 'multiline-registry.sql')], {
      env: { ...process.env, DATABASE_URL: isolated.sqlTarget.options.connectionString!, SKIP_SEED: 'true' },
    });
    const restored = await stagedRestore({ archivePath: join(directory, 'multiline-registry.tar.gz'), targetUrl: isolated.archiveTarget.options.connectionString!, stagingDir: join(directory, 'multiline-registry-documents') });
    expect(restored.errors).toEqual([]); expect(restored.ok).toBe(true);
    for (const target of [isolated.sqlTarget, isolated.archiveTarget]) {
      expect(await staffBytes(target)).toEqual(await staffBytes(isolated.source));
      expect((await target.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version')).rows).toEqual(registry);
    }
  } finally { await isolated.close(); }
});
