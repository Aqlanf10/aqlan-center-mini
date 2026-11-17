import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const scanner=fileURLToPath(new URL('./scan-raw-body-parsers.mjs',import.meta.url));
const transport=`import { definePagesApi } from '@/lib/pages-api';
import { documentGet, documentDelete } from '@/lib/documents-core';
export const config = { api: { bodyParser: false } };
async function execute(req,res,method,handler) { return handler(null,res); }
export default definePagesApi({ GET: async (req,res) => execute(req,res,'GET',documentGet), DELETE: async (req,res) => execute(req,res,'DELETE',documentDelete) });`;
function fixture(run) {
  const root=mkdtempSync(path.join(tmpdir(),'raw-body-pages-synthetic-'));
  try {
    for(const directory of ['app/api/synthetic','pages/api/documents','lib']) mkdirSync(path.join(root,directory),{recursive:true});
    writeFileSync(path.join(root,'app/api/synthetic/route.ts'),'export async function GET() { return null; }');
    writeFileSync(path.join(root,'pages/api/documents/[id].ts'),transport);
    const core=body=>writeFileSync(path.join(root,'lib/documents-core.ts'),`export async function documentGet(request) { return null; }\nexport async function documentDelete(request, req) { ${body} }`);
    const check=()=>execFileSync(process.execPath,[scanner],{cwd:root,encoding:'utf8',stdio:'pipe'});
    run(core,check,root);
  } finally { rmSync(root,{recursive:true,force:true}); }
}
test('rejects raw readers inside the statically bound Pages core handler',()=>fixture((core,check)=>{
  for(const method of ['json','formData','text','arrayBuffer','blob']) for (const variable of ['request','req']) {
    core(`return ${variable}.${method}();`);
    assert.throws(check,error=>error.status===1 && error.stderr.includes('pages/api/documents/[id].ts'));
  }
}));
test('retains bounded Pages handler and rejects raw App Router body access',()=>fixture((core,check,root)=>{
  core('return readJsonBody(request, LIMIT);'); assert.match(check(),/مسار API/);
  writeFileSync(path.join(root,'app/api/synthetic/route.ts'),'export async function POST(request) { return request.json(); }');
  assert.throws(check,error=>error.status===1 && error.stderr.includes('app/api/synthetic/route.ts'));
}));
test('rejects raw body access in a helper within the bound core module',()=>fixture((core,check,root)=>{
  core('return helper(request);');
  appendFileSync(path.join(root,'lib/documents-core.ts'),'\nasync function helper(req) { return req.text(); }\n');
  assert.throws(check,error=>error.status===1 && error.stderr.includes('pages/api/documents/[id].ts'));
}));
