import {build,type Plugin} from 'esbuild';
import {chromium,type Browser} from 'playwright';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {canonicalJourneyJSON} from '../../lib/ortho-case-journey-json';
import {projectRetentionEventHistory} from '../../lib/ortho-retention-event-history';
// Real React/Chromium and Tailwind, synthetic intercepted transport only.
// Not Next routing, database authority, PostgreSQL or full application acceptance.
const origin='http://127.0.0.1:19979';let browser:Browser,script='',css='',temporary='';
const adapters:Plugin={name:'retention-synthetic-adapters',setup(b){
 b.onResolve({filter:/SessionProvider$/},()=>({path:'session',namespace:'synthetic'}));
 b.onResolve({filter:/SettingsProvider$/},()=>({path:'settings',namespace:'synthetic'}));
 b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'synthetic'}));
 b.onResolve({filter:/^next\/navigation$/},()=>({path:'navigation',namespace:'synthetic'}));
 b.onLoad({filter:/.*/,namespace:'synthetic'},a=>({loader:'tsx',resolveDir:process.cwd(),contents:a.path==='session'?`const session={userId:4,username:'synthetic-doctor',role:'doctor',permissions:{canEditPlans:true,canUploadXrays:true}};export const useSession=()=>session;`:a.path==='settings'?`export const useClinicName=()=> 'Synthetic clinic';export const useSetting=()=>'';`:a.path==='navigation'?`export const useRouter=()=>({push(){},replace(){},refresh(){}});export const useSearchParams=()=>new URLSearchParams();export const usePathname=()=>'/';`:`export default function Link({children,...props}){return <a {...props}>{children}</a>}`}));
}};
beforeAll(async()=>{temporary=mkdtempSync(join(tmpdir(),'retention-browser-'));const bundle=await build({absWorkingDir:process.cwd(),entryPoints:['__tests__/fixtures/retention-ledger-real-react.tsx'],bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',tsconfig:'tsconfig.json',define:{'process.env.NODE_ENV':'"development"'},plugins:[adapters]});script=bundle.outputFiles[0].text;execFileSync(process.execPath,['node_modules/tailwindcss/lib/cli.js','-i','app/globals.css','-o',join(temporary,'fixture.css')]);css=readFileSync(join(temporary,'fixture.css'),'utf8');browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true});},120000);
afterAll(async()=>{await browser?.close();if(temporary)rmSync(temporary,{recursive:true,force:true});});
const hash=(v:unknown)=>createHash('sha256').update(canonicalJourneyJSON(v)).digest('hex');
const scope={patientId:1,orthoCaseId:2,clinicalCaseId:3},actorId=4;
async function open(width:number,lose='none'){
 const context=await browser.newContext({viewport:{width,height:1000},locale:'ar',serviceWorkers:'block'}),page=await context.newPage();const requests:string[]=[],bodies:any[]=[],history:any[]=[],errors:string[]=[];let recovery:any=null,receipt:any=null,acks=0;
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());requests.push(request.method()+' '+url.pathname);
 const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'cache-control':'private, no-store'},body:JSON.stringify(body)});
 if(url.origin!==origin)return route.abort();
 if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main class="mx-auto max-w-5xl p-3"><div id="root"></div></main><script src="/fixture.js"></script></body></html>`});
 if(url.pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:script});
 if(url.pathname==='/favicon.ico')return route.fulfill({status:204,body:''});
 if(url.pathname==='/api/ortho/2/retention-ledger/recovery'){
  if(request.method()==='GET')return json({ok:true,scope,actorId,recovery});
  const b=request.postDataJSON();if(b.action==='cancel'){recovery={state:'cancelled',identity:recovery?.identity??{id:10,commandId:b.commandId,requestFingerprint:b.requestFingerprint}};return json({ok:true,scope,actorId,...recovery,acknowledged:false});}
  acks++;const answer={ok:true,scope,actorId,identity:recovery.identity,state:recovery.state,acknowledged:true};recovery=null;return json(answer);
 }
 if(url.pathname==='/api/ortho/2/retention-ledger'){
  if(request.method()==='GET'){const projection=projectRetentionEventHistory(history.map(h=>({id:h.id,version:h.version,arch:h.content.arch,supersedesEntryId:h.content.supersedesEntryId,archCorrectionReason:h.content.archCorrectionReason,content:h.content.payload})));return json({ok:true,scope,actorId,writable:true,headId:history[0]?.id??null,history,...(projection.ok?projection.value:{}),sourceMatches:[]});}
  const b=request.postDataJSON();bodies.push(b);const command=b.command;const same=receipt?.commandId===command.clientRequestId;
  if(!same){const identity={id:10,commandId:command.clientRequestId,requestFingerprint:hash(command)};
   recovery={state:lose==='pending'?'pending':'committed',identity,expected:{scope,actorId,command}};
   const content={arch:command.arch,supersedesEntryId:command.supersedesEntryId,archCorrectionReason:command.archCorrectionReason,payload:command.content,savedVersion:2,documentWitnesses:command.expectedDocuments};
   const revision={...scope,id:20+history.length,recordedPatientId:1,schemaVersion:1,version:history.length+1,predecessorId:history[0]?.id??null,createdBy:'Synthetic clinician',createdAt:'2026-11-06T00:00:00.000Z',reason:command.reason,recordingContext:'current',caseStatusAtCapture:'active',contentHash:hash(content),content};
   receipt={ok:true,scope,actorId,commandId:command.clientRequestId,requestFingerprint:identity.requestFingerprint,entryId:revision.id,revision,replayed:false};
   if(lose!=='pending')history.unshift(revision);
  }
  if(bodies.length===1&&lose!=='none')return route.abort('failed');
  return json({...receipt,replayed:same},same?200:201);
 }
 return route.abort();});
 await page.goto(origin,{waitUntil:'load'});await page.getByText('إضافة حدث للفك العلوي',{exact:true}).waitFor();return{page,context,requests,bodies,history,errors,acks:()=>acks};
}
async function fillPlan(f:Awaited<ReturnType<typeof open>>){const p=f.page;await p.getByText('إضافة حدث للفك العلوي',{exact:true}).click();await p.getByRole('button',{name:'فك الجهاز التقويمي للفك العلوي',exact:true}).click();await p.getByLabel('النطاق الموثق',{exact:true}).fill('Synthetic documented extent');await p.getByLabel('سبب التوثيق أو التصحيح',{exact:true}).fill('Synthetic documentary event');}
describe('Retention ledger real React synthetic browser',()=>{
 it.each([390,1280])('at %s px keeps unknown dates explicit and restores exact committed command after lost reply/reload',async width=>{
  const f=await open(width,'committed');try{await fillPlan(f);await f.page.getByRole('button',{name:'حفظ حدث التثبيت',exact:true}).click();await f.page.getByRole('button',{name:'التحقق من طلب التثبيت والإقرار بنتيجته',exact:true}).waitFor();expect(f.bodies[0].command.content.occurrence).toEqual({occurredOn:null,dateProvenance:'unknown',sourceNote:''});
  await f.page.reload();await f.page.getByRole('button',{name:'التحقق من طلب التثبيت والإقرار بنتيجته',exact:true}).click();await expect.poll(()=>f.acks()).toBe(1);expect(f.bodies).toHaveLength(2);expect(f.bodies[1]).toEqual(f.bodies[0]);expect(f.history).toHaveLength(1);
  await expect.poll(()=>f.page.getByText('إضافة حدث للفك العلوي',{exact:true}).isVisible()).toBe(true);expect(await f.page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}))).toEqual({local:0,session:0});expect(await f.page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);expect(f.errors).toEqual([]);
  const firstRecovery=f.requests.indexOf('GET /api/ortho/2/retention-ledger/recovery'),firstRead=f.requests.indexOf('GET /api/ortho/2/retention-ledger');expect(firstRecovery).toBeLessThan(firstRead);
  }finally{await f.context.close();}
 });
 it('cancels an unresolved reserved command and acknowledges without a revision',async()=>{const f=await open(390,'pending');try{await fillPlan(f);await f.page.getByRole('button',{name:'حفظ حدث التثبيت',exact:true}).click();await f.page.getByRole('button',{name:'إلغاء طلب التثبيت والإقرار',exact:true}).click();await expect.poll(()=>f.acks()).toBe(1);expect(f.history).toHaveLength(0);expect(f.bodies).toHaveLength(1);expect(f.errors).toEqual([]);}finally{await f.context.close();}});
});
