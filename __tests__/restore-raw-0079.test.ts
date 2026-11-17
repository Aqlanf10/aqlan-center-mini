import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { insertStatement } from '../lib/backup';

describe('raw SQL 0079 refusal before opening a target connection', () => {
  const checksum = '5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99';
  const record = insertStatement('schema_migrations', ['version', 'name', 'checksum', 'applied_at', 'adopted'],
    { version: '0079', name: 'ortho_followup_coverage', checksum, applied_at: '2025-01-01T00:00:00Z', adopted: false });
  it.each([
    [record, 'Historical 0079 backup requires full archive restore'],
    ['INSERT INTO visits ("id", "ortho_followup_coverage_proof") VALUES (1, NULL);', 'Historical 0079 data without'],
    ['INSERT INTO ortho_followup_coverage_rejections ("command_id") VALUES (\'x\');', 'Historical 0079 data without'],
    ['insert into "visits" ("id", "ortho_followup_coverage_proof") values (1, NULL);', 'Unsupported historical 0079-sensitive INSERT header'],
  ])('refuses historical source before connecting to an unreachable target', (body, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'synthetic-raw-0079-'));
    try {
      const file = join(dir, 'synthetic.sql'); writeFileSync(file, `BEGIN;\n${body}\nCOMMIT;`);
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', DATABASE_ENVIRONMENT: 'test',
        DATABASE_URL: `postgresql://synthetic:synthetic@127.0.0.1:1/aqlan_backup_precision_${'a'.repeat(32)}?sslmode=disable` };
      delete env.TEST_DATABASE_URL;
      const child = spawnSync(process.execPath, ['scripts/restore.mjs', file], { encoding: 'utf8', env });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain(expected);
      expect(child.stderr).not.toContain('ECONNREFUSED');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
