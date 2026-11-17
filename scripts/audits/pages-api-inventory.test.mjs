import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverPagesApi, inspectPagesHandler } from './pages-api-inventory.mjs';

const prefix = `import { definePagesApi } from '@/lib/pages-api';
import { documentGet, documentDelete } from '@/lib/documents-core';
export const config = { api: { bodyParser: false } };
async function execute(req,res,method,handler) { return handler(null,res); }
`;
const valid = `${prefix}export default definePagesApi({ GET: async (req,res) => execute(req,res,'GET',documentGet), DELETE: async (req,res) => execute(req,res,'DELETE',documentDelete) });`;
test('extracts only static dispatcher methods and rejects ambiguous dispatch and raw body access', () => {
  assert.deepEqual(Object.keys(inspectPagesHandler('x.ts',valid)),['GET','DELETE']);
  for (const invalid of [
    valid.replace('definePagesApi({ GET:', 'definePagesApi({ ...other, GET:'),
    valid.replace("execute(req,res,'GET',documentGet)","execute(req,res,'DELETE',documentGet)"),
    valid.replace("GET: async (req,res) => execute(req,res,'GET',documentGet)","GET: async (req,res) => req.on('data',()=>{})"),
    valid.replace('bodyParser: false','bodyParser: true'),
    valid.replace('export const config','export let config'),
    valid.replace("export default definePagesApi", "const other = req.body; export default definePagesApi"),
    valid.replace('export default definePagesApi', 'const other = req; export default definePagesApi'),
    valid.replace('export default definePagesApi', 'const other = Readable.toWeb(req); export default definePagesApi'),
    valid.replace('export default definePagesApi', 'export default other; export default definePagesApi'),
    valid.replace('return handler(null,res)', 'return null'),
  ]) assert.throws(()=>inspectPagesHandler('x.ts',invalid));
});
test('discovers actual dynamic route and scans the exact per-method core source', () => {
  const root=mkdtempSync(path.join(tmpdir(),'pages-api-inventory-'));
  try {
    mkdirSync(path.join(root,'pages/api/documents'),{recursive:true}); mkdirSync(path.join(root,'lib'));
    writeFileSync(path.join(root,'pages/api/documents/[id].ts'),valid);
    writeFileSync(path.join(root,'lib/documents-core.ts'),`export async function documentGet() { return 'GET-ONLY'; }\nexport async function documentDelete() { return 'DELETE-ONLY'; }`);
    const result=discoverPagesApi(root); assert.deepEqual(result.issues,[]); assert.equal(result.entries[0].route,'/api/documents/[id]');
    assert.match(result.entries[0].methods.GET,/GET-ONLY/); assert.doesNotMatch(result.entries[0].methods.GET,/DELETE-ONLY/);
    assert.match(result.entries[0].methods.DELETE,/DELETE-ONLY/); assert.doesNotMatch(result.entries[0].methods.DELETE,/GET-ONLY/);
    writeFileSync(path.join(root,'pages/api/documents/unsafe.ts'),`${prefix}export default req => req.body;`);
    assert.equal(discoverPagesApi(root).issues.length,1);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
