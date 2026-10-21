import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here,'../restore-full.ts');
const missing = path.resolve(here,'NO-PATIENT-ARCHIVE-WILL-BE-READ.tar.gz');
const local = 'postgresql://synthetic:synthetic@127.0.0.1:5432/aqlan_backup_precision_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
function run(url) {
  return spawnSync(process.execPath,['--import','tsx',cli,missing],{
    cwd:path.resolve(here,'../..'),encoding:'utf8',timeout:20000,
    env:{
      PATH:process.env.PATH,HOME:process.env.HOME, NODE_ENV:'test',
      DATABASE_ENVIRONMENT:'test',DATABASE_URL:url,DOCUMENTS_DIR:path.resolve(here,'isolated-fixture-dir'),
    },
  });
}
for(const [name,uri] of [
  ['host redirect',local+'?host=remote.example.invalid'],
  ['encoded host redirect',local+'?%68ost=remote.example.invalid'],
  ['database redirect',local+'?database=production'],
  ['TLS root certificate file',local+'?sslrootcert=/tmp/UNREAD-SECRET.pem'],
]) test('actual restore-full CLI rejects '+name+' before archive read and pg connection',()=>{
  const got=run(uri);
  assert.equal(got.error,undefined,got.error?.message);
  assert.equal(got.status,2,(got.stdout||'')+(got.stderr||''));
  assert.match(got.stderr,/RESTORE_FULL_UNSAFE_TARGET/);
  assert.doesNotMatch(got.stderr,/NO-PATIENT-ARCHIVE-WILL-BE-READ|ENOENT/);
});
test('safe URI passes target gate then reports nonexistent archive (no database connection)',()=>{
  const got=run(local);
  assert.equal(got.error,undefined,got.error?.message);
  assert.equal(got.status,3,(got.stdout||'')+(got.stderr||''));
  assert.match(got.stderr,/NO-PATIENT-ARCHIVE-WILL-BE-READ|تعذ/);
});
