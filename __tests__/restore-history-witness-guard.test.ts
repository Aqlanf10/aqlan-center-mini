import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateHistoryWitnessEnvironment } from './postgres/_history-witness-guard';

const valid: NodeJS.ProcessEnv = {
  NODE_ENV: 'test', GITHUB_ACTIONS: 'true', CI: 'true', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_WORKSPACE: '/tmp/synthetic-workspace', SYNTHETIC_RESTORE_HISTORY_WITNESS: '1',
  RUNNER_TEMP: '/tmp/synthetic-runner', SYNTHETIC_WITNESS_ROOT: '/tmp/synthetic-runner',
  DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55473/aqlan_p1_test?sslmode=disable',
  TEST_DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55473/aqlan_p1_test?sslmode=disable',
};

describe('restore history synthetic target guard', () => {
  it('accepts the declared isolated CI service', () => {
    expect(() => validateHistoryWitnessEnvironment(valid)).not.toThrow();
  });
  it.each([
    { GITHUB_ACTIONS: 'false' }, { CI: 'false' }, { GITHUB_RUN_ID: 'local' }, { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_WORKSPACE: 'relative' }, { SYNTHETIC_RESTORE_HISTORY_WITNESS: '0' },
    { RUNNER_TEMP: 'relative' }, { SYNTHETIC_WITNESS_ROOT: '/tmp/other' },
    { DATABASE_URL: 'postgresql://ci:ci@example.com/aqlan_p1_test' },
    { TEST_DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55472/aqlan_p1_test?sslmode=disable' },
    { TEST_DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55473/aqlan_p1_test?host=example.com' },
    { POSTGRES_URL: 'postgresql://ci:ci@example.com/aqlan_p1_test' },
    { POSTGRES_URL: 'postgresql://ci:ci@127.0.0.1:55472/aqlan_p1_test?sslmode=disable' },
    { SOURCE_DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55473/other?sslmode=disable' },
    { POSTGRES_PRISMA_URL: '' }, { POSTGRES_URL_NON_POOLING: 'postgresql://ci:ci@example.com/aqlan_p1_test' },
    { RAILWAY_PROJECT_ID: 'synthetic-marker' }, { USE_LOCAL_DB: 'true' },
  ])('refuses unsafe configuration before connecting: %#', (change) => {
    expect(() => validateHistoryWitnessEnvironment({ ...valid, ...change })).toThrow();
  });
  it('accepts additional aliases only when they exactly name the dedicated service', () => {
    expect(() => validateHistoryWitnessEnvironment({ ...valid, POSTGRES_URL: valid.DATABASE_URL, SOURCE_DATABASE_URL: valid.DATABASE_URL })).not.toThrow();
  });
  it('keeps the guard ahead of the original connection setup and selects only the intended test', () => {
    const setup = readFileSync('__tests__/postgres/_history-witness-setup.ts', 'utf8');
    const config = readFileSync('vitest.config.restore-history-witness.mts', 'utf8');
    expect(setup.indexOf('validateHistoryWitnessEnvironment(process.env)')).toBeGreaterThan(0);
    expect(setup.indexOf('validateHistoryWitnessEnvironment(process.env)')).toBeLessThan(setup.indexOf('return originalSetup()'));
    expect(config).toContain("'__tests__/postgres/hr-composed-legacy-restore.test.ts'");
    expect(config).toContain("'__tests__/postgres/inventory-authority-maintenance.test.ts'");
    expect(config).toContain("globalSetup: ['__tests__/postgres/_history-witness-setup.ts']");
  });
  it('sets runner temp in the witness step rather than an unsupported job-level context', () => {
    const workflow = readFileSync('.github/workflows/restore-history-retained.yml', 'utf8');
    expect(workflow).not.toMatch(/^      SYNTHETIC_WITNESS_ROOT:/m);
    expect(workflow).toMatch(/id: witness\n\s+env:\n\s+SYNTHETIC_WITNESS_ROOT: \$\{\{ runner\.temp \}\}/);
  });
});
