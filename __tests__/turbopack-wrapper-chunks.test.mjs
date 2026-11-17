import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { checkWrapperChunks } from '../scripts/dependency-security/verify-turbopack-wrapper-chunks.mjs';
const hash = t => createHash('sha256').update(t).digest('hex');
const entry = '.next/server/app/api/ping/route.js';
const chunk = '.next/server/chunks/ping.js';
const runtime = '.next/server/chunks/[turbopack]_runtime.js';
const header = 'var R=require("../../../chunks/[turbopack]_runtime.js")("server/app/api/ping/route.js")\n';
async function fixture(body = 'R.c("server/chunks/ping.js")\n', include = true) {
  const root = await mkdtemp(join(tmpdir(), 'wrapper-chunk-review-'));
  const inventory = {};
  async function put(p, s) { await mkdir(dirname(join(root, p)), {recursive:true}); await writeFile(join(root,p),s); inventory[p]=hash(s); }
  await put(entry, header + body); await put(runtime, 'synthetic runtime'); if (include) await put(chunk, 'synthetic');
  return {root, inventory};
}
describe('review-only turbopack wrapper references', () => {
  it('accepts a byte-bound shipped chunk', async () => { const f=await fixture(); try { expect(await checkWrapperChunks(f.root,f.inventory)).toEqual({entries:1,references:1}); } finally {await rm(f.root,{recursive:true,force:true});} });
  for (const [name,body,include] of [
    ['missing', 'R.c("server/chunks/ping.js")\n', false],
    ['dynamic', 'R.c(variable)\n', true],
    ['traversal', 'R.c("server/chunks/../app/unsafe.js")\n', true],
    ['injection', 'R.c("server/chunks/ping.js");evil()\n', true],
    ['mixed object', 'R.c("server/chunks/ping.js")\nX.c("server/chunks/missing.js")\n', true],
  ]) it(`fails closed on ${name}`, async () => { const f=await fixture(body,include); try { await expect(checkWrapperChunks(f.root,f.inventory)).rejects.toThrow(); } finally {await rm(f.root,{recursive:true,force:true});} });
  it('fails closed if a target changes after inventory', async () => { const f=await fixture(); try { await writeFile(join(f.root,chunk),'changed'); await expect(checkWrapperChunks(f.root,f.inventory)).rejects.toThrow(/changed chunk/); } finally {await rm(f.root,{recursive:true,force:true});} });
  it('fails closed if the entry runtime is missing', async () => { const f=await fixture(); try { await rm(join(f.root,runtime)); delete f.inventory[runtime]; await expect(checkWrapperChunks(f.root,f.inventory)).rejects.toThrow(/missing inventoried runtime/); } finally {await rm(f.root,{recursive:true,force:true});} });
  it('fails closed if the entry runtime changes after inventory', async () => { const f=await fixture(); try { await writeFile(join(f.root,runtime),'changed'); await expect(checkWrapperChunks(f.root,f.inventory)).rejects.toThrow(/changed runtime/); } finally {await rm(f.root,{recursive:true,force:true});} });
});
