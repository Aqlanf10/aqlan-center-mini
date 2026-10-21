import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { assertPostgresMajorOrThrow, postgresMajorFromVersionNum } from '../lib/env-contract.ts';
import {
  GATE_DATABASE_URL_ENV_NAMES,
  validateLocalVerificationTarget,
  validateOperationalVerificationEnvironment,
} from '../lib/verification-target-policy.mjs';

export function validateFinanceLifecycleTarget(environment) {
  // Inspect the ORIGINAL environment before overwriting aliases for the child.
  validateOperationalVerificationEnvironment(environment);
  if (environment.NODE_ENV !== 'test' || environment.DATABASE_ENVIRONMENT !== 'test') {
    throw new Error('Explicit NODE_ENV=test and DATABASE_ENVIRONMENT=test are required.');
  }
  if (environment.USE_LOCAL_DB
    || Object.keys(environment).some(key => (key.startsWith('PG') || key.startsWith('RAILWAY_')) && environment[key])) {
    throw new Error('Conflicting database runtime settings are forbidden.');
  }
  const target = validateLocalVerificationTarget(environment.TEST_DATABASE_URL, environment, {
    varName: 'TEST_DATABASE_URL', databaseName: 'aqlan_finance_test',
  });
  if (target.hostname !== '127.0.0.1' || !target.port || target.search || target.hash) {
    throw new Error('Explicit IPv4 loopback port required; query options and fragments forbidden.');
  }
  for (const name of GATE_DATABASE_URL_ENV_NAMES) {
    if (name === 'TEST_DATABASE_URL' || !environment[name]) continue;
    const alias = validateLocalVerificationTarget(environment[name], environment, { varName: name });
    if (alias.toString() !== target.toString()) throw new Error(`Conflicting database alias: ${name}.`);
  }
  return target;
}

export async function runFinanceLifecycle(environment = process.env) {
  // Global setup creates/drops aqlan_sec_http. No connection or setup until the
  // original environment has an explicit test classification and matching URLs.
  const target = validateFinanceLifecycleTarget(environment);
  const client = new Client({ connectionString: target.toString(), ssl: false });
  try {
    await client.connect();
    const { rows: [row] } = await client.query("SELECT current_database() AS name, current_setting('server_version_num') AS server_version_num, current_setting('server_version') AS server_version");
    assertPostgresMajorOrThrow(postgresMajorFromVersionNum(row?.server_version_num ?? 0));
    if (row.name !== 'aqlan_finance_test') throw new Error('Unexpected PostgreSQL database.');
    const { rows: tables } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    if (tables.length) throw new Error('Refusing nonempty admin database; use a fresh disposable target.');
    const { rows } = await client.query("SELECT datname FROM pg_database WHERE datname='aqlan_sec_http'");
    if (rows.length) throw new Error('Refusing to replace existing aqlan_sec_http; inspect its owner first.');
    console.log(`Verified explicit test target: 127.0.0.1:${target.port}/aqlan_finance_test; PostgreSQL ${row.server_version}; server_version_num=${row.server_version_num}; aqlan_sec_http absent.`);
  } finally {
    await client.end();
  }
  const env = { ...environment, DATABASE_URL: target.toString(), SECURITY_HTTP_PORT: '3249' };
  const result = spawnSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.security.mts',
    '__tests__/security-http/invoice-debt-lifecycle-http.test.ts',
  ], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runFinanceLifecycle();
}
