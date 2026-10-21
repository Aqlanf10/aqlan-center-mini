import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

// This suite's global setup recreates aqlan_sec_http. Validate its admin target
// BEFORE Vitest starts; do not accept DATABASE_URL or any remote fallback.
const value = process.env.TEST_DATABASE_URL;
if (!value) throw new Error('Set TEST_DATABASE_URL to a disposable local PostgreSQL database.');
const target = new URL(value);
if (!['postgres:', 'postgresql:'].includes(target.protocol)
  || target.hostname !== '127.0.0.1' || target.pathname !== '/aqlan_finance_test'
  || !target.port || target.search || target.hash
  || Object.keys(process.env).some(key => key.startsWith('RAILWAY_') && process.env[key])) {
  throw new Error('Refusing target: requires explicit loopback PostgreSQL /aqlan_finance_test and no Railway environment.');
}
const client = new Client({ connectionString: value, ssl: false });
try {
  await client.connect();
  const { rows: [row] } = await client.query('SELECT current_database() AS name');
  if (row.name !== 'aqlan_finance_test') throw new Error('Unexpected PostgreSQL database.');
  const { rows: tables } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  if (tables.length) throw new Error('Refusing nonempty admin database; use a fresh disposable target.');
  // The operator must create a fresh disposable server, not point at an
  // existing application database. Refuse an occupied HTTP harness database.
  const { rows } = await client.query("SELECT datname FROM pg_database WHERE datname='aqlan_sec_http'");
  if (rows.length) throw new Error('Refusing to replace existing aqlan_sec_http; inspect its owner first.');
  console.log(`Verified synthetic target: 127.0.0.1:${target.port}/aqlan_finance_test; aqlan_sec_http absent.`);
} finally {
  await client.end();
}
const env = { ...process.env, DATABASE_URL: value, SECURITY_HTTP_PORT: '3249' };
delete env.USE_LOCAL_DB;
const result = spawnSync(process.execPath, [
  'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.security.mts',
  '__tests__/security-http/invoice-debt-lifecycle-http.test.ts',
], { env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
