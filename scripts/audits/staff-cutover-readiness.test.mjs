import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildInventory } from './staff-cutover-readiness.mjs';
const report=buildInventory();
test('checked-in exhaustive source inventory has no drift or API export mismatch',()=>{
 assert.deepEqual(report,JSON.parse(readFileSync(new URL('../../docs/security/staff-cutover/inventory.json',import.meta.url))));
 assert.deepEqual(report.matrixExportMismatches,[]);
 assert.equal(new Set(report.routes.map(r=>`${r.method} ${r.route}`)).size,report.routes.length);
});
test('public transport is never canonical staff readiness',()=>{
 for(const route of ['/api/auth/login','/api/auth/me','/api/auth/setup'])assert.ok(report.routes.filter(r=>r.route===route).every(r=>r.classification==='staff-legacy-held'));
 assert.equal(report.routes.find(r=>r.route==='/api/portal/me').classification,'public-separate-portal');
 assert.ok(report.routes.filter(r=>r.httpAccess==='shared-media').every(r=>r.classification==='unknown'));
 assert.ok(report.pages.filter(r=>r.route.startsWith('/print/')).every(r=>r.classification==='unknown'));
});
test('baseline has no canonical route readiness; finite domain actions are not route acceptance',()=>{
 assert.equal(report.readiness,'NOT_READY');
 assert.equal(report.summary.routeClassifications['canonical-ready'],0);
 assert.equal(report.summary.pageClassifications['canonical-ready'],0);
 assert.deepEqual(report.canonicalDirectReferences,[]);
 assert.deepEqual(report.runtimeActions,['staff.view','staff.permissions.edit','inventory.references.view','inventory.items.create','inventory.units.revise','inventory.locations.create',
  'inventory.approval-policy.manage','inventory.requests.view','inventory.requests.create','inventory.requests.approve',
  'inventory.orders.view','inventory.orders.manage','inventory.receipts.post','inventory.quarantine.resolve',
  'inventory.supplier-invoices.record','inventory.supplier-invoices.cancel',
  'inventory.custody.view','inventory.custody.dispatch','inventory.custody.acknowledge','inventory.custody.use',
  'inventory.custody.stocktake','inventory.custody.approve-waste','inventory.custody.settlement.propose',
  'inventory.custody.settlement.object','inventory.reconcile','inventory.costs.view','finance.suppliers.view',
  'patients.create','patients.edit','settings.view','visits.manage']);
});

test('unknown HTTP classes never become separate/public even on staff auth transport',async()=>{
 const {classifyHttpAccess}=await import('./staff-cutover-readiness.mjs');
 for(const access of ['future-trusted-class','PUBLIC','',null,{},42]) {
  assert.equal(classifyHttpAccess(access),'unknown');
  assert.equal(classifyHttpAccess(access,{auth:true}),'unknown');
 }
 for(const access of ['public','portal','webhook','internal'])assert.equal(classifyHttpAccess(access),'public-separate-portal');
 assert.equal(classifyHttpAccess('shared-media'),'unknown');
});

test('all supported entry/source formats are inventoried; future formats are explicit unknowns',async()=>{
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'staff-inventory-format-'));
 const write=(file,text)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);};
 try {
  fs.mkdirSync(path.join(root,'components'));
  write('lib/http-permissions.ts',`export const HTTP_PERMISSIONS = {${['js','jsx','ts','tsx'].map(ext=>`"/api/${ext}": {GET: "public"}`).join(',')},"/api/future": {GET:"new-auth-class"}};`);
  write('lib/staff-operation-runtime.ts','const actions = new Set(["staff.view"]);');
  write('proxy.ts','const PUBLIC_PATHS = new Set([]);');
  for(const ext of ['js','jsx','ts','tsx']) {
   write(`app/api/${ext}/route.${ext}`,'export function GET() {}');
   write(`app/${ext}/page.${ext}`,'export default function Page() { return null; }');
   write(`app/${ext}/layout.${ext}`,'export default function Layout() { return null; }');
  }
  write('app/api/future/route.js','export const GET = () => null;');
  write('app/unsupported/page.mdx','# future page');
  write('app/unsupported/route.cjs','exports.GET = () => null;');
  write('app/unsupported/layout.vue','<template />');
  const result=buildInventory(root);
  assert.equal(result.routes.length,5);
  assert.equal(result.pages.length,4);
  assert.equal(result.layouts.length,4);
  assert.equal(result.sourceEntries.length,13);
  for(const ext of ['js','jsx','ts','tsx'])assert.ok(result.routes.some(r=>r.file===`app/api/${ext}/route.${ext}`&&r.method==='GET'));
  assert.equal(result.routes.find(r=>r.route==='/api/future').classification,'unknown');
  assert.deepEqual(result.sourceIssues.map(i=>i.file).sort(),['app/unsupported/layout.vue','app/unsupported/page.mdx','app/unsupported/route.cjs']);
  assert.ok(result.sourceIssues.every(i=>i.classification==='unknown'));
  let prior=result.sourceDigest;
  for(const ext of ['js','jsx','cjs','mjs','ts','tsx','cts','mts']) {
   write(`components/example.${ext}`,'// source change');
   const next=buildInventory(root).sourceDigest;
   assert.notEqual(next,prior,`${ext} must contribute to digest`);prior=next;
  }
  assert.equal(buildInventory(root).readiness,'NOT_READY');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

// Two cold whole-repository scans measured 7.65s together locally. Bound each
// child to 8s/64KiB and only this integration case to 20s; no assertions skipped.
test('CLI drift success and explicit NOT_READY failure are intentional, not exceptions',async()=>{
 const {spawnSync}=await import('node:child_process');
 const script=new URL('./staff-cutover-readiness.mjs',import.meta.url);
 const {fileURLToPath}=await import('node:url');
 for(const [args,status] of [[[],0],[['--require-ready'],1]]) {
  const result=spawnSync(process.execPath,[fileURLToPath(script),...args],{encoding:'utf8',timeout:8_000,maxBuffer:64*1024,env:{PATH:process.env.PATH??'',LANG:'C.UTF-8',TZ:'UTC'}});
  assert.equal(result.status,status,result.stderr);
  assert.equal(result.stderr,'');
  assert.equal(JSON.parse(result.stdout).readiness,'NOT_READY');
 }
},20_000);
