import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadMigrationFiles } from '../lib/migration-files';
import { loadRestoreMigrationChecksums } from '../lib/restore/migration-provenance.mjs';
import { prepareBackupSql } from '../lib/restore/sql.mjs';

const historical = '5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99';
const ordinary = 'a'.repeat(64);
const files = [{ version: '0080', checksum: ordinary }, { version: '0079', checksum: historical }];
const entry = (version: string, checksum: string, name = 'synthetic', appliedAt = '2026-01-01T00:00:00Z') =>
  `INSERT INTO schema_migrations ("version", "name", "checksum", "applied_at", "adopted") VALUES ('${version}', '${name}', '${checksum}', '${appliedAt}', FALSE);`;
const run = (body: string) => prepareBackupSql(`BEGIN;\n${body}\nCOMMIT;`, { inspectHistorical0079: true, migrationFiles: files });

describe('source migration provenance before restoration', () => {
  it('matches the CLI checksum catalogue to the application migration catalogue', async () => {
    const app = await loadMigrationFiles();
    const cli = await loadRestoreMigrationChecksums();
    expect(cli).toEqual(app.map(({ version, name, filename, checksum }) => ({ version, name, filename, checksum })));
  });
  it('accepts a known subset, keeps application literals intact and removes only the matching registry record', () => {
    const data = `INSERT INTO sample ("note") VALUES ('synthetic schema_migrations 0090');`;
    const parsed = run(`${entry('0080', ordinary)}\n${data}`);
    expect(parsed.dataSql).toContain(data);
    expect(parsed.dataSql).not.toContain('INSERT INTO schema_migrations');
    expect(parsed.historical0079).toBeNull();
    expect(run("UPDATE example SET note='schema_migrations'; -- schema_migrations\n").dataSql).toContain("'schema_migrations'");
  });
  it('preserves exact historical 0079 and its timestamp without making it a fresh migration', () => {
    const parsed = run(`${entry('0079', historical, 'ortho_followup_coverage', '2026-01-01T00:00:00.123456+00:00')}\nINSERT INTO visits ("ortho_followup_coverage_proof") VALUES (NULL);`);
    expect(parsed.historical0079).toEqual({ appliedAt: '2026-01-01T00:00:00.123456+00:00' });
    expect(parsed.historical0079Footprint).toBe(true);
  });
  it.each([
    ['unknown historical version', entry('0090', ordinary)],
    ['checksum mismatch', entry('0080', 'b'.repeat(64))],
    ['duplicate', `${entry('0080', ordinary)}\n${entry('0080', ordinary)}`],
    ['changed 0079', entry('0079', 'b'.repeat(64), 'ortho_followup_coverage')],
    ['duplicate 0079', `${entry('0079', historical, 'ortho_followup_coverage')}\n${entry('0079', historical, 'ortho_followup_coverage')}`],
    ['registry without literal checksum', "INSERT INTO schema_migrations VALUES ('0080', 'synthetic', NULL, '2026-01-01T00:00:00Z', FALSE);"],
    ['qualified bypass', `INSERT INTO public.schema_migrations VALUES ('0080', 'synthetic', '${ordinary}', '2026-01-01T00:00:00Z', FALSE);`],
    ['only bypass', `INSERT INTO ONLY schema_migrations VALUES ('0080', 'synthetic', '${ordinary}', '2026-01-01T00:00:00Z', FALSE);`],
    ['quoted bypass', `INSERT INTO "schema_migrations" VALUES ('0080', 'synthetic', '${ordinary}', '2026-01-01T00:00:00Z', FALSE);`],
    ['comment bypass', `INSERT /* synthetic */ INTO schema_migrations VALUES ('0080', 'synthetic', '${ordinary}', '2026-01-01T00:00:00Z', FALSE);`],
    ['CTE bypass', `WITH x AS (SELECT 1) INSERT INTO schema_migrations VALUES ('0080', 'synthetic', '${ordinary}', '2026-01-01T00:00:00Z', FALSE);`],
    ['update bypass', "UPDATE /* synthetic */ public.\"schema_migrations\" SET checksum='synthetic';"],
    ['delete bypass', 'DELETE FROM public.schema_migrations;'],
  ])('rejects %s', (_label, body) => { expect(() => run(body)).toThrow(); });
  it('does not accept an empty or inconsistent expected catalogue', () => {
    for (const catalog of [[], [{ version: '0080', checksum: ordinary }, { version: '0080', checksum: ordinary }], [{ version: '0080', checksum: 'bad' }]])
      expect(() => prepareBackupSql('BEGIN;\nCOMMIT;', { inspectHistorical0079: true, migrationFiles: catalog })).toThrow();
  });
  it('refuses unknown 0090 in the raw CLI before attempting the target connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synthetic-raw-provenance-'));
    try {
      const file = join(dir, 'synthetic.sql');
      writeFileSync(file, `BEGIN;\n${entry('0090', ordinary)}\nCOMMIT;`);
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV:'test', DATABASE_ENVIRONMENT:'test',
        DATABASE_URL:`postgresql://synthetic:synthetic@127.0.0.1:1/aqlan_backup_precision_${'a'.repeat(32)}?sslmode=disable` };
      delete env.TEST_DATABASE_URL;
      const result = spawnSync(process.execPath, ['scripts/restore.mjs', file], { encoding:'utf8', env });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unknown archived migration version: 0090');
      expect(result.stderr).not.toContain('ECONNREFUSED');
    } finally { rmSync(dir, { recursive:true, force:true }); }
  });
});
