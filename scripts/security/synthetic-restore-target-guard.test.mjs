import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeLegacyRestoreTarget as guard } from './synthetic-restore-target-guard.mjs';

const base = 'postgresql://fixture:fixture@127.0.0.1:5432/backup_dst_synthetic007';
const allow = { DATABASE_ENVIRONMENT:'test' };
test('allows literal-loopback synthetic fixture and canonicalizes checked URI', () => {
  assert.equal(guard(base, allow).database, 'backup_dst_synthetic007');
  assert.equal(new URL(guard(base + '?sslmode=disable', allow).connectionString).searchParams.get('sslmode'), 'disable');
  assert.equal(new URL(guard(base, allow).connectionString).hostname, '127.0.0.1');
});
test('accepts existing owned aqlan_backup_precision fixture during NODE_ENV=test', () => {
  const url = base.replace('backup_dst_synthetic007', 'aqlan_backup_precision_' + 'a'.repeat(32));
  assert.equal(guard(url, { NODE_ENV:'test' }).database, 'aqlan_backup_precision_' + 'a'.repeat(32));
});
test('does not accept precision fixture outside test runtime', () => {
  const url = base.replace('backup_dst_synthetic007', 'aqlan_backup_precision_' + 'a'.repeat(32));
  assert.throws(() => guard(url, { NODE_ENV:'development' }), /Legacy restore refused/);
});

for (const [name, url, env] of [
  ['production declaration', base, {DATABASE_ENVIRONMENT:'production'}],
  ['Railway runtime', base, {RAILWAY_PROJECT_ID:'fixture'}],
  ['remote authority', 'postgresql://fixture:fixture@db.internal:5432/backup_dst_synthetic007', allow],
  ['localhost DNS name', 'postgresql://fixture:fixture@localhost:5432/backup_dst_synthetic007', allow],
  ['non-isolated local database', base.replace('backup_dst_synthetic007','live_clinic'), allow],
  ['malformed target', 'not-a-url', allow],
  ['staging declaration', base, {DATABASE_ENVIRONMENT:'staging'}],
  ['host override query', base + '?host=evil.example', allow],
  ['database override query', base + '?database=production', allow],
  ['encoded host override query', base + '?%68ost=evil.example', allow],
  ['duplicate sslmode', base + '?sslmode=disable&sslmode=require', allow],
  ['TLS certificate file option', base + '?sslrootcert=/tmp/DO-NOT-READ.pem', allow],
  ['TLS key file option', base + '?sslkey=/tmp/DO-NOT-READ.key', allow],
  ['ambient PGHOST', base, {...allow, PGHOST:'evil.example'}],
  ['ambient PGDATABASE', base, {...allow, PGDATABASE:'production'}],
  ['ambient PGSSLROOTCERT', base, {...allow, PGSSLROOTCERT:'/tmp/DO-NOT-READ.pem'}],
  ['ambient PGSSL_ROOT_CERT', base, {...allow, PGSSL_ROOT_CERT:'/tmp/DO-NOT-READ.pem'}],
  ['encoded database name', base.replace('backup_dst_synthetic007','backup_dst_synthetic%30%30%37'), allow],
  ['URI fragment', base + '#fragment', allow],
  ['missing user', base.replace('fixture:fixture@',''), allow],
  ['unapproved options', base + '?options=-c%20search_path%3Dpublic', allow],
]) test('reject '+name, () => assert.throws(() => guard(url, env), /Legacy restore refused/));
