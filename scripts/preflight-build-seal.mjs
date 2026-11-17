#!/usr/bin/env node
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyStandaloneAssets } from './verify-standalone-assets.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`PREFLIGHT_SEAL_REJECTED: ${message}`); };
const sealPath = root => path.join(root, '.next/preflight-build-seal.json');
async function inventory(projectRoot) {
  const preflight = path.join(projectRoot, '.preflight');
  const rootStat = await lstat(preflight);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('invalid preflight root');
  const entries = [], pending = [''];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(path.join(preflight, current), { withFileTypes:true })) {
      const name = current ? `${current}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || /\.tsx?$/i.test(entry.name)) fail('unsafe preflight entry');
      if (entry.isDirectory()) {
        if (!['runner','migrations'].includes(name)) fail('unexpected preflight directory');
        pending.push(name);
      }
      else if (entry.isFile()) entries.push(name);
      else fail('non-file preflight entry');
    }
  }
  entries.sort();
  for (const required of ['manifest.json','runner/run.mjs','THIRD_PARTY_NOTICES.txt']) {
    if (!entries.includes(required)) fail('incomplete preflight');
  }
  if (!entries.some(name => /^migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(name))) fail('missing migrations');
  const manifest = JSON.parse(await readFile(path.join(preflight,'manifest.json'),'utf8'));
  if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) fail('invalid migration inventory');
  const migrations = manifest.migrations.map(item => item?.filename);
  if (migrations.some(name => typeof name !== 'string' || !/^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    || new Set(migrations).size !== migrations.length) fail('invalid migration inventory');
  const allowed = ['manifest.json','runner/run.mjs','THIRD_PARTY_NOTICES.txt', ...migrations.map(name => `migrations/${name}`)].sort();
  if (JSON.stringify(entries) !== JSON.stringify(allowed)) fail('unexpected preflight files');
  const files = {};
  for (const name of entries) files[name] = sha(await readFile(path.join(preflight,name)));
  return { format:'aqlan-preflight-build-seal-v1', buildIdSha256:sha(await readFile(path.join(projectRoot,'.next/BUILD_ID'))), files };
}
export async function recordPreflightSeal(projectRoot) {
  const root = path.resolve(projectRoot), data = await inventory(root);
  const dir = await lstat(path.join(root,'.next'));
  if (!dir.isDirectory() || dir.isSymbolicLink()) fail('invalid build root');
  const file = await open(sealPath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(`${JSON.stringify(data)}\n`); } finally { await file.close(); }
}
export async function verifyPreflightSeal(projectRoot) {
  const root = path.resolve(projectRoot), stat = await lstat(sealPath(root));
  if (!stat.isFile() || stat.isSymbolicLink()) fail('invalid initial seal');
  const before = JSON.parse(await readFile(sealPath(root),'utf8'));
  if (JSON.stringify(before) !== JSON.stringify(await inventory(root))) fail('PREFLIGHT_CHANGED');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || !['--create','--verify'].includes(process.argv[2])) fail('invalid arguments');
    const root=process.cwd();
    // Recheck source provenance and separately copied public/static trees at
    // the final boundary, not only before the subsequent preflight rebuild.
    await verifyStandaloneAssets(root,path.join(root,'.next/standalone'));
    if (process.argv[2] === '--create') await recordPreflightSeal(root);
    else await verifyPreflightSeal(root);
    console.log('Preflight build seal verified.');
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
