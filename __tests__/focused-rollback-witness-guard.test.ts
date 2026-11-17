import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateFocusedRollbackWitnessEnvironment } from './postgres/_focused-rollback-witness-guard';

const valid: NodeJS.ProcessEnv = {
  NODE_ENV: 'test', GITHUB_ACTIONS: 'true', CI: 'true', GITHUB_RUN_ID: '12345',
  GITHUB_WORKSPACE: '/tmp/synthetic-workspace', SYNTHETIC_LATE_ROLLBACK_WITNESS: '1',
  DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55473/aqlan_p1_test?sslmode=disable',
  TEST_DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55473/aqlan_p1_test?sslmode=disable',
};

describe('focused rollback synthetic target guard', () => {
  it('accepts the declared isolated CI service', () => {
    expect(() => validateFocusedRollbackWitnessEnvironment(valid)).not.toThrow();
  });
  it.each([
    { GITHUB_ACTIONS: 'false' }, { CI: 'false' }, { GITHUB_RUN_ID: 'local' },
    { GITHUB_WORKSPACE: 'relative' }, { SYNTHETIC_LATE_ROLLBACK_WITNESS: '0' },
    { DATABASE_URL: 'postgresql://ci:ci@example.com/aqlan_p1_test' },
    { TEST_DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55472/aqlan_p1_test?sslmode=disable' },
    { TEST_DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55473/aqlan_p1_test?host=example.com' },
    { POSTGRES_URL: 'postgresql://ci:ci@example.com/aqlan_p1_test' },
    { POSTGRES_URL: 'postgresql://ci:ci@127.0.0.1:55472/aqlan_p1_test?sslmode=disable' },
    { SOURCE_DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55473/other?sslmode=disable' },
    { POSTGRES_PRISMA_URL: '' }, { POSTGRES_URL_NON_POOLING: 'postgresql://ci:ci@example.com/aqlan_p1_test' },
    { RAILWAY_PROJECT_ID: 'synthetic-marker' }, { USE_LOCAL_DB: 'true' },
  ])('refuses unsafe configuration before connecting: %#', (change) => {
    expect(() => validateFocusedRollbackWitnessEnvironment({ ...valid, ...change })).toThrow();
  });
  it('accepts additional aliases only when they exactly name the dedicated service', () => {
    expect(() => validateFocusedRollbackWitnessEnvironment({ ...valid, POSTGRES_URL: valid.DATABASE_URL, SOURCE_DATABASE_URL: valid.DATABASE_URL })).not.toThrow();
  });
  it('keeps the guard ahead of the original connection setup and selects only the intended test', () => {
    const setup = readFileSync('__tests__/postgres/_focused-rollback-witness-setup.ts', 'utf8');
    const config = readFileSync('vitest.config.focused-rollback-witness.mts', 'utf8');
    expect(setup.indexOf('validateFocusedRollbackWitnessEnvironment(process.env)')).toBeGreaterThan(0);
    expect(setup.indexOf('validateFocusedRollbackWitnessEnvironment(process.env)')).toBeLessThan(setup.indexOf('return originalSetup()'));
    expect(config).toContain("include: ['__tests__/postgres/hr-composed-legacy-restore.test.ts']");
    expect(config).toContain("globalSetup: ['__tests__/postgres/_focused-rollback-witness-setup.ts']");
  });
  it('wires a separate hosted CI service and focused config without bypass flags', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const job = workflow.match(/^ {2}focused_rollback_witness:\n(?:(?!^ {2}\S)[\s\S])*/m)?.[0];
    expect(job).toBeDefined();
    expect(job).toContain('runs-on: ubuntu-latest');
    expect(job).toContain('image: postgres:18-alpine');
    expect(job).toContain('55473:5432');
    expect(job).toContain(`DATABASE_URL: ${valid.DATABASE_URL}`);
    expect(job).toContain(`TEST_DATABASE_URL: ${valid.TEST_DATABASE_URL}`);
    expect(job).toContain("SYNTHETIC_LATE_ROLLBACK_WITNESS: '1'");
    expect(job).toContain('npx vitest run --config vitest.config.focused-rollback-witness.mts');
    expect(job).not.toMatch(/continue-on-error|--passWithNoTests|--skip/i);
  });
});
