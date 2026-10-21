import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the REAL scripts/restore.mjs with an inert, no-network pg import probe.
// A nonexistent backup archive distinguishes pre-read guard exit 2 from read exit 1.
const here = path.dirname(fileURLToPath(import.meta.url));
const restore = path.resolve(here, '../restore.mjs');
const preload = path.resolve(here, 'pg-probe-preload.mjs');
const missing = path.resolve(here, 'DO-NOT-CREATE-PATIENT-ARCHIVE.sql');
const good = 'postgresql://fixture:fixture@127.0.0.1:5432/backup_dst_synthetic007';
function invoke(url, extra = {}) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    DATABASE_ENVIRONMENT: 'test', NODE_ENV: 'test', DATABASE_URL: url, ...extra,
  };
  return spawnSync(process.execPath, ['--import', preload, restore, missing],
    { env, encoding:'utf8', timeout: 10000 });
}
for (const [name,url,extra] of [
  ['query host override', good + '?host=remote.example', {}],
  ['query database override', good + '?database=live_clinic', {}],
  ['percent-encoded host override', good + '?%68ost=remote.example', {}],
  ['TLS root certificate file option', good + '?sslrootcert=/tmp/DO-NOT-READ.pem', {}],
  ['TLS key file option', good + '?sslkey=/tmp/DO-NOT-READ.key', {}],
  ['duplicate sslmode', good + '?sslmode=disable&sslmode=require', {}],
  ['ambient PGHOST', good, { PGHOST:'remote.example' }],
  ['ambient PGSSLROOTCERT', good, { PGSSLROOTCERT:'/tmp/DO-NOT-READ.pem' }],
  ['production declaration', good, { DATABASE_ENVIRONMENT:'production' }],
]) {
  test('restore.mjs refuses '+name+' before backup read or client construction', () => {
    const outcome = invoke(url, extra);
    assert.equal(outcome.error, undefined, outcome.error?.message);
    assert.equal(outcome.status, 2, JSON.stringify({status:outcome.status, stderr:outcome.stderr}));
    assert.match(outcome.stderr, /Legacy restore refused:/);
    assert.doesNotMatch(outcome.stderr, /PG_CLIENT_CONSTRUCTOR_CALLED|ENOENT|DO-NOT-CREATE-PATIENT-ARCHIVE/);
  });
}
test('safe synthetic URI reaches missing-file branch (positive ordering control)', () => {
  const outcome = invoke(good);
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /DO-NOT-CREATE-PATIENT-ARCHIVE/);
  assert.doesNotMatch(outcome.stderr, /PG_CLIENT_CONSTRUCTOR_CALLED/);
});
