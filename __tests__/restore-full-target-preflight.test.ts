import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

it('actual restore-full and target policy refuse unsafe URI options before archive/network I/O', () => {
  const result = spawnSync(process.execPath, [
    '--test',
    'scripts/security/restore-full-target-guard.nodecheck.mjs',
    'scripts/security/restore-full-cli.nodecheck.mjs',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  expect(result.error?.message).toBeUndefined();
  expect(result.status, (result.stdout ?? '') + (result.stderr ?? '')).toBe(0);
  expect(result.stdout).toContain('# fail 0');
});
