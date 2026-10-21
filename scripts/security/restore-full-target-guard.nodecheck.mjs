import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatedRestoreFullTarget as validate } from './restore-full-target-guard.mjs';

const local = 'postgresql://fixture:fixture@127.0.0.1:5432/aqlan_backup_precision_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const staging = 'postgresql://fixture:fixture@staging.example.invalid:5432/aqlan_recovery?sslmode=verify-full';
const pem = '-----BEGIN CERTIFICATE-----\nsynthetic-test-only\n-----END CERTIFICATE-----';
test('local synthetic target becomes canonical URI (no ambiguous params)', () => {
  const checked = validate(local + '?sslmode=disable', {NODE_ENV:'test', DATABASE_ENVIRONMENT:'test'});
  assert.equal(checked.database, 'aqlan_backup_precision_' + 'a'.repeat(32));
  assert.equal(new URL(checked.connectionString).searchParams.get('sslmode'), 'disable');
});
test('explicit staging target with verified TLS PEM is permitted without any file read', () => {
  const checked = validate(staging,{NODE_ENV:'development', DATABASE_ENVIRONMENT:'staging', PGSSL_ROOT_CERT_PEM:pem});
  assert.equal(checked.local, false);
  // The input was required to say verify-full, but the *output* must omit it:
  // node-postgres query parsing could replace the supplied verified TLS object.
  assert.equal(new URL(checked.connectionString).searchParams.has('sslmode'), false);
});
for(const [label,url,env] of [
  ['host query override',local+'?host=remote.example.invalid', {NODE_ENV:'test'}],
  ['encoded host override',local+'?%68ost=remote.example.invalid', {NODE_ENV:'test'}],
  ['database query override',local+'?database=live', {NODE_ENV:'test'}],
  ['tls file from URI',local+'?sslrootcert=/tmp/SECRET.pem', {NODE_ENV:'test'}],
  ['sslmode override',local+'?sslmode=disable&sslmode=verify-full', {NODE_ENV:'test'}],
  ['file-based ambient tls',local, {NODE_ENV:'test', PGSSL_ROOT_CERT:'/tmp/SECRET.pem'}],
  ['ambient database redirection',local,{NODE_ENV:'test',PGDATABASE:'production'}],
  ['production declaration',local,{DATABASE_ENVIRONMENT:'production'}],
  ['railway runtime',local,{RAILWAY_PROJECT_ID:'synthetic'}],
  ['remote staging missing CA',staging,{DATABASE_ENVIRONMENT:'staging'}],
  ['remote staging without verify-full',staging.replace('verify-full','require'),{DATABASE_ENVIRONMENT:'staging',PGSSL_ROOT_CERT_PEM:pem}],
  ['remote undeclared',staging,{PGSSL_ROOT_CERT_PEM:pem}],
  ['encoded database',local.replace('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','%61aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),{NODE_ENV:'test'}],
]) test('reject '+label,()=>assert.throws(()=>validate(url,env),/RESTORE_FULL_UNSAFE_TARGET/));
