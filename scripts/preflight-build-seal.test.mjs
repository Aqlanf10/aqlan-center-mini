import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { recordPreflightSeal, verifyPreflightSeal } from './preflight-build-seal.mjs';
async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'preflight-seal-synthetic-'));
  t.onTestFinished(() => rm(root,{recursive:true,force:true}));
  const put=async(name,content)=>{const f=path.join(root,name);await mkdir(path.dirname(f),{recursive:true});await writeFile(f,content);};
  await put('.next/BUILD_ID','synthetic-build');
  await put('.preflight/manifest.json',JSON.stringify({bundleSha256:'synthetic',migrations:[{filename:'0001_synthetic.sql'}]}));
  await put('.preflight/runner/run.mjs','// synthetic runner');
  await put('.preflight/THIRD_PARTY_NOTICES.txt','synthetic notices');
  await put('.preflight/migrations/0001_synthetic.sql','-- synthetic sql');
  return {root,put};
}
test('records and verifies an unchanged complete preflight tree',async t=>{const f=await fixture(t);await recordPreflightSeal(f.root);await verifyPreflightSeal(f.root);});
test('rejects a changed runner even when its manifest hash is also updated',async t=>{const f=await fixture(t);await recordPreflightSeal(f.root);const runner='// different synthetic runner';await f.put('.preflight/runner/run.mjs',runner);await f.put('.preflight/manifest.json',JSON.stringify({bundleSha256:createHash('sha256').update(runner).digest('hex'),migrations:[{filename:'0001_synthetic.sql'}]}));await assert.rejects(verifyPreflightSeal(f.root),/PREFLIGHT_CHANGED/);});
for(const [name, mutate] of [
  ['missing migration', f=>rm(path.join(f.root,'.preflight/migrations/0001_synthetic.sql'))],
  ['extra file', f=>f.put('.preflight/extra.txt','synthetic')],
  ['changed build id', f=>f.put('.next/BUILD_ID','different-build')],
  ['symlink', async f=>{await rm(path.join(f.root,'.preflight/runner/run.mjs'));await symlink('../manifest.json',path.join(f.root,'.preflight/runner/run.mjs'));}],
]) test(`rejects ${name} after recording`,async t=>{const f=await fixture(t);await recordPreflightSeal(f.root);await mutate(f);await assert.rejects(verifyPreflightSeal(f.root));});
test('rejects an absent initial record',async t=>{const f=await fixture(t);await assert.rejects(verifyPreflightSeal(f.root));});
test('runs the final verification after the last preflight rebuild in CI and Docker',async()=>{const pkg=JSON.parse(await readFile('package.json','utf8'));const ci=await readFile('.github/workflows/ci.yml','utf8');const docker=await readFile('Dockerfile','utf8');assert.ok(pkg.scripts.build.includes('node scripts/preflight-build-seal.mjs --create'));assert.ok(docker.indexOf('node scripts/preflight-build-seal.mjs --verify')>docker.lastIndexOf('node scripts/dependency-security/verify-lint-tooling-runtime.mjs'));const steps=ci.split('run: npm run build:preflight');assert.equal(steps.length,3);for(const tail of steps.slice(1))assert.ok(tail.indexOf('node scripts/preflight-build-seal.mjs --verify')>=0 && tail.indexOf('node scripts/preflight-build-seal.mjs --verify')>tail.indexOf('node scripts/dependency-security/verify-lint-tooling-runtime.mjs'));});
test('rejects an extra file present before the initial record',async t=>{const f=await fixture(t);await f.put('.preflight/private.txt','synthetic only');await assert.rejects(recordPreflightSeal(f.root),/unexpected preflight/);});
test('rejects an extra directory present before the initial record',async t=>{const f=await fixture(t);await mkdir(path.join(f.root,'.preflight/private'));await assert.rejects(recordPreflightSeal(f.root),/unexpected preflight/);});
test('CLI rechecks source, SQL, copied trees and the recorded runner after rebuild', async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'preflight-seal-cli-synthetic-'));
  t.onTestFinished(()=>rm(root,{recursive:true,force:true}));
  const put=async(name,content)=>{const f=path.join(root,name);await mkdir(path.dirname(f),{recursive:true});await writeFile(f,content);};
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const provenance='export const PREFLIGHT_SOURCE_FILES = ["lib/preflight-provenance.ts", "lib/example.ts"] as const;';
  const example='// synthetic provenance input\n',runner='// synthetic runner\n';
  const historical=await readFile('migrations/0079_ortho_followup_coverage.sql');
  const sql='-- synthetic SQL\n';
  for(const [name,bytes] of Object.entries({'lib/preflight-provenance.ts':provenance,'lib/example.ts':example,'migrations/0001_baseline.sql':sql,'migrations/0079_ortho_followup_coverage.sql':historical})) await put(name,bytes);
  for(const [name,bytes] of Object.entries({'migrations/0001_baseline.sql':sql,'migrations/0079_ortho_followup_coverage.sql':historical,'server.js':'// synthetic','package.json':'{}','.next/BUILD_ID':'synthetic-build'})) await put(`.next/standalone/${name}`,bytes);
  await put('.next/BUILD_ID','synthetic-build');await mkdir(path.join(root,'.next/standalone/.next/server'),{recursive:true});await mkdir(path.join(root,'.next/static'));await mkdir(path.join(root,'public'));
  await put('.preflight/runner/run.mjs',runner);await put('.preflight/THIRD_PARTY_NOTICES.txt','synthetic');
  await put('.preflight/migrations/0001_baseline.sql',sql);await put('.preflight/migrations/0079_ortho_followup_coverage.sql',historical);
  const manifest={bundleSha256:hash(runner),sourceFiles:{'lib/preflight-provenance.ts':hash(provenance),'lib/example.ts':hash(example)},migrations:[{filename:'0001_baseline.sql'},{filename:'0079_ortho_followup_coverage.sql'}]};
  await put('.preflight/manifest.json',JSON.stringify(manifest));
  const script=path.resolve('scripts/preflight-build-seal.mjs');
  const run=flag=>spawnSync(process.execPath,[script,flag],{cwd:root,encoding:'utf8'});
  assert.equal(run('--create').status,0);assert.equal(run('--verify').status,0);
  const tampered=runner+'// changed\n';await put('.preflight/runner/run.mjs',tampered);manifest.bundleSha256=hash(tampered);await put('.preflight/manifest.json',JSON.stringify(manifest));
  const refused=run('--verify');assert.equal(refused.status,1);assert.match(refused.stderr,/PREFLIGHT_CHANGED/);
});
