import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

/**
 * Mandatory existing npm test gate executes the real legacy CLI probe without
 * changing any shared CI configuration. No database/server/backup file is used.
 */
it('legacy restore guard rejects URI overrides before archive read or PostgreSQL Client', () => {
  const run = spawnSync(process.execPath, [
    '--test',
    'scripts/security/synthetic-restore-target-guard.test.mjs',
    'scripts/security/legacy-restore-cli.test.mjs',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV:'test' },
    encoding: 'utf8',
    timeout: 25_000,
  });
  expect(run.error?.message).toBeUndefined();
  expect(run.status, (run.stdout || '') + (run.stderr || '')).toBe(0);
  expect(run.stdout).toContain('# fail 0');
});
