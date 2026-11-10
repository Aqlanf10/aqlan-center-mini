import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { mkdir } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { CASE_STATUS_LABEL } from '../../lib/ortho';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createSessionToken, readSessionToken } from '../../lib/auth';
import { authedGet, authedMutation, baseUrl, harness, type Session } from './_server';
let h:Awaited<ReturnType<typeof harness>>, db:Client, doctorId:number, browser:Browser;
beforeAll(async()=>{
 h=await harness();expect(new URL(h.seeded.dbUrl).pathname).toBe('/aqlan_sec_http');
 db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();
 doctorId=(await db.query("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
 expect(Number.isSafeInteger(doctorId)&&doctorId>0).toBe(true);
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
 await mkdir('.settings-ui-artifacts',{recursive:true});
});
afterAll(async()=>{await browser?.close();await db?.end();});
async function fixture(open=false){
 const patientId=(await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'Synthetic reopen HTTP patient',$2) RETURNING id",[randomUUID(),doctorId])).rows[0].id as number;
 const caseId=(await db.query(`INSERT INTO ortho_cases(patient_id,status,phase,retainer,retainer_on,upper_wire,created_by,closed_at,closed_by,closed_note)
  VALUES($1,$2,'retention','hawley','2026-10-01','Synthetic wire','secadmin',
    CASE WHEN $3 THEN NULL ELSE '2026-10-02 12:34:56.123456+00'::timestamptz END,
    CASE WHEN $3 THEN NULL ELSE 'Historical synthetic clinician' END,
    CASE WHEN $3 THEN NULL ELSE 'Historical synthetic closure' END) RETURNING id`,[patientId,open?'retention':'completed',open])).rows[0].id as number;
 // The generic bridge remains independently stored; its visible projection uses
 // orthodontic status, but reopening must not rewrite generic case semantics.
 const clinicalCaseId=(await db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic reopen HTTP case',$2,'secadmin') RETURNING id",[patientId,caseId])).rows[0].id as number;
 return {patientId,caseId,clinicalCaseId,path:`/api/ortho/${caseId}/reopen`};
}
type CaseFixture=Awaited<ReturnType<typeof fixture>>;
const command=(f:CaseFixture,version=0)=>({patientId:f.patientId,clinicalCaseId:f.clinicalCaseId,command:{schemaVersion:1,clientRequestId:randomUUID(),expectedLifecycleVersion:version,expectedStatus:'completed',targetStatus:'retention',reason:'Synthetic explicit clinician follow-up'}});
const send=(f:CaseFixture,body:unknown,session:Pick<Session,'cookie'>=h.sessions.admin)=>authedMutation(f.path,session,'POST',JSON.stringify(body));
const read=(f:CaseFixture,session:Pick<Session,'cookie'>=h.sessions.admin)=>authedGet(`${f.path}?patientId=${f.patientId}`,session);
const caseRow=async(f:CaseFixture)=>(await db.query('SELECT * FROM ortho_cases WHERE id=$1',[f.caseId])).rows[0];
const events=async(f:CaseFixture)=>(await db.query('SELECT * FROM ortho_case_reopen_events WHERE ortho_case_id=$1 ORDER BY id',[f.caseId])).rows;
const nonLifecycle=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).filter(([key])=>!['status','closed_at','closed_by','closed_note','lifecycle_version'].includes(key)));
const counts=async(f:CaseFixture)=>(await db.query(`SELECT
 (SELECT count(*)::int FROM ortho_cases WHERE patient_id=$1) cases,
 (SELECT count(*)::int FROM clinical_cases WHERE patient_id=$1) bridges,
 (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,
 (SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,
 (SELECT count(*)::int FROM patient_opening_balances WHERE patient_id=$1) opening,
 (SELECT count(*)::int FROM visits WHERE patient_id=$1) visits,
 (SELECT count(*)::int FROM appointments WHERE patient_id=$1) appointments,
 (SELECT count(*)::int FROM treatment_plans WHERE patient_id=$1) plans`,[f.patientId])).rows;
it('actual close/reopen/concurrent retry/reclose/old retry preserves one case and exact closure history without financial effects',async()=>{
 const f=await fixture(true);
 await db.query("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,note,created_by) VALUES($1,'YER',12345,'2026-10-01','Synthetic prior balance','secadmin')",[f.patientId]);
 const openingBefore=(await db.query('SELECT * FROM patient_opening_balances WHERE patient_id=$1',[f.patientId])).rows;
 const before=await caseRow(f),beforeCounts=await counts(f),bridge=(await db.query('SELECT * FROM clinical_cases WHERE id=$1',[f.clinicalCaseId])).rows;
 const close=await authedMutation(`/api/ortho/${f.caseId}`,h.sessions.admin,'PATCH',JSON.stringify({status:'completed',note:'First HTTP closure'}));
 expect(close.status,await close.clone().text()).toBe(200);
 const closed=await caseRow(f);expect(closed.lifecycle_version).toBe(1);
 const metadata=await read(f,h.sessions.doctorA);expect(metadata.status).toBe(200);expect(metadata.headers.get('cache-control')).toBe('private, no-store');
 expect(await metadata.json()).toMatchObject({current:{status:'completed',version:1}});
 const intent=command(f,1),responses=await Promise.all([send(f,intent,h.sessions.doctorA),send(f,intent,h.sessions.doctorA)]);
 expect(responses.map(r=>r.status).sort()).toEqual([200,201]);const payloads=await Promise.all(responses.map(r=>r.json()));
 expect(payloads[0].receipt.id).toBe(payloads[1].receipt.id);expect(payloads[0].current).toMatchObject({status:'retention',phase:'retention',version:2,closedAt:null});
 expect(payloads[0].receipt.before).toMatchObject({status:'completed',closedBy:'secadmin',closedNote:'First HTTP closure'});
 const projection=await authedGet(`/api/patients/${f.patientId}/cases`,h.sessions.doctorA);expect(projection.status).toBe(200);
 expect((await projection.json()).cases.find((item:{id:number})=>item.id===f.clinicalCaseId)).toMatchObject({status:'active',orthoCaseId:f.caseId});
 expect((await db.query('SELECT * FROM clinical_cases WHERE id=$1',[f.clinicalCaseId])).rows).toEqual(bridge);
 expect(nonLifecycle(await caseRow(f))).toEqual(nonLifecycle(before));expect(await counts(f)).toEqual(beforeCounts);expect(await events(f)).toHaveLength(1);
 // Existing receptionist closure authority is preserved; new reopening is clinical-only.
 expect((await authedMutation(`/api/ortho/${f.caseId}`,h.sessions.reception,'PATCH',JSON.stringify({status:'completed',note:'Second HTTP closure'}))).status).toBe(200);
 const closedAgain=await caseRow(f);expect(closedAgain.lifecycle_version).toBe(3);
 const oldRetry=await send(f,intent,h.sessions.doctorA);expect(oldRetry.status).toBe(200);
 expect(await oldRetry.json()).toMatchObject({replayed:true,receipt:{afterVersion:2},current:{status:'completed',version:3,closedNote:'Second HTTP closure'}});
 expect(await caseRow(f)).toEqual(closedAgain);expect(await events(f)).toHaveLength(1);expect(await counts(f)).toEqual(beforeCounts);
 expect((await db.query('SELECT * FROM patient_opening_balances WHERE patient_id=$1',[f.patientId])).rows).toEqual(openingBefore);
 const recovered=await authedGet(`${f.path}?patientId=${f.patientId}&requestId=${intent.command.clientRequestId}`,h.sessions.doctorA);
 expect(await recovered.json()).toMatchObject({receipt:{commandId:intent.command.clientRequestId},current:{status:'completed',version:3}});
 const conflict=await send(f,{...intent,command:{...intent.command,reason:'Changed request intent'}},h.sessions.doctorA);
 expect(conflict.status).toBe(409);expect(await conflict.json()).toMatchObject({code:'request_key_conflict'});
});
it.each(['reception','cashier','accountant'] as const)('denies %s reopening and private closure-history access',async role=>{
 const f=await fixture(),before=await caseRow(f);
 expect((await read(f,h.sessions[role])).status).toBe(403);expect((await send(f,command(f),h.sessions[role])).status).toBe(403);
 expect(await caseRow(f)).toEqual(before);expect(await events(f)).toEqual([]);
});
it('checks current patient access and exact case/bridge scope on the built routes',async()=>{
 const f=await fixture(),intent=command(f),before=await caseRow(f);
 expect((await read(f,h.sessions.doctorB)).status).toBe(403);expect((await send(f,intent,h.sessions.doctorB)).status).toBe(403);
 expect((await send(f,{...intent,patientId:h.seeded.patientBId})).status).toBe(404);
 expect((await send(f,{...intent,clinicalCaseId:f.clinicalCaseId+100000})).status).toBe(409);
 expect((await read(f,h.sessions.doctorA)).status).toBe(200);
 await db.query('UPDATE patients SET primary_doctor_id=NULL WHERE id=$1',[f.patientId]);
 expect((await read(f,h.sessions.doctorA)).status).toBe(403);expect((await send(f,intent,h.sessions.doctorA)).status).toBe(403);
 expect(await caseRow(f)).toEqual(before);expect(await events(f)).toEqual([]);
});
it('rejects stale account authority using the already-issued real cookie',async()=>{
 const f=await fixture(),intent=command(f),original=(await db.query("SELECT is_active FROM users WHERE username='secdoctora'")).rows[0].is_active;
 try{
  expect((await read(f,h.sessions.doctorA)).status).toBe(200);
  await db.query("UPDATE users SET is_active=false WHERE username='secdoctora'");
  expect((await read(f,h.sessions.doctorA)).status).toBe(401);expect((await send(f,intent,h.sessions.doctorA)).status).toBe(401);
  expect(await events(f)).toEqual([]);
 }finally{await db.query("UPDATE users SET is_active=$1 WHERE username='secdoctora'",[original]);}
});
it('rejects cross-origin requests, forged financial fields and incomplete intents before any state change',async()=>{
 const f=await fixture(),intent=command(f),before=await caseRow(f);
 const csrf=await fetch(`${baseUrl}${f.path}`,{method:'POST',headers:{Cookie:h.sessions.admin.cookie,Origin:'https://invalid.example','Content-Type':'application/json'},body:JSON.stringify(intent)});
 expect(csrf.status).toBe(403);
 for(const body of [{...intent,invoice:{}},{...intent,command:{...intent.command,targetStatus:'planned'}},{...intent,command:{...intent.command,reason:' '}},{...intent,command:{...intent.command,phase:'aligning'}},{}])expect((await send(f,body)).status).toBe(400);
 expect((await authedGet(`${f.path}?patientId=${f.patientId}&patientId=${f.patientId}`,h.sessions.admin)).status).toBe(400);
 expect(await caseRow(f)).toEqual(before);expect(await events(f)).toEqual([]);
});
it('rejects a signed session that expires during an observed case lock wait without committing history',async()=>{
 const f=await fixture(),intent=command(f),before=await caseRow(f),blocker=new Client({connectionString:h.seeded.dbUrl,ssl:false});await blocker.connect();
 const [name,token]=h.sessions.admin.cookie.split('='),payload=readSessionToken(token);if(!payload)throw Error('Synthetic harness session unavailable');
 const expiresAt=Date.now()+5000,session={cookie:`${name}=${createSessionToken({...payload,expiresAt})}`};
 await blocker.query('BEGIN');await blocker.query('SELECT id FROM ortho_cases WHERE id=$1 FOR UPDATE',[f.caseId]);
 const pid=(await blocker.query('SELECT pg_backend_pid() id')).rows[0].id;
 const pending=send(f,intent,session);
 try{
  await expect.poll(async()=>Boolean((await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))) blocked",[pid])).rows[0].blocked),{timeout:4000}).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiresAt-Date.now()+30)));
 }finally{await blocker.query('ROLLBACK');await blocker.end();await pending.catch(()=>undefined);}
 const refused=await pending;expect(refused.status).toBe(401);expect(await refused.json()).toMatchObject({code:'session_expired'});
 expect(await caseRow(f)).toEqual(before);expect(await events(f)).toEqual([]);
});

it.each([390,1280])('reopens the same case through explicit browser review and recovers a lost committed response at %ipx',async width=>{
 const f=await fixture(),before=await caseRow(f),beforeCounts=await counts(f);
 if(width===1280) await db.query("UPDATE clinical_cases SET status='completed',completed_at='2026-10-02T00:00:00Z' WHERE id=$1",[f.clinicalCaseId]);
 const bridgeBefore=(await db.query('SELECT * FROM clinical_cases WHERE id=$1',[f.clinicalCaseId])).rows;
 const context=await browser.newContext({viewport:{width,height:1000},locale:'ar-YE'});
 const [name,...cookie]=h.sessions.admin.cookie.split('=');await context.addCookies([{name,value:cookie.join('='),url:baseUrl}]);
 const page=await context.newPage(),errors:string[]=[],posts:string[]=[];page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
 let dropped=false;
 await page.route(`**${f.path}`,async route=>{
  if(route.request().method()!=='POST'){await route.continue();return;}
  posts.push(route.request().postData()!);
  if(!dropped){dropped=true;const response=await route.fetch();expect(response.status()).toBe(201);await route.abort('failed');}
  else await route.continue();
 });
 try{
  await page.goto(`${baseUrl}/patients/${f.patientId}?tab=treatment&sub=ortho&orthoCaseId=${f.caseId}`);
  const summary=page.getByText('حالة التقويم: الإغلاق وإعادة الفتح',{exact:true});await summary.click();
  const current=page.getByRole('region',{name:'حالة التقويم الحالية',exact:true});await current.waitFor();
  expect(await current.innerText()).toContain(CASE_STATUS_LABEL.completed);
  const target=page.getByLabel('الحالة المقصودة لإعادة فتح التقويم',{exact:true});expect(await target.inputValue()).toBe('');
  await target.selectOption('retention');await page.getByLabel('سبب إعادة فتح حالة التقويم',{exact:true}).fill('Synthetic browser follow-up after explicit closure review');
  const confirm=page.getByRole('button',{name:'تأكيد إعادة فتح حالة التقويم',exact:true});expect(await confirm.isDisabled()).toBe(true);
  await page.getByRole('checkbox',{name:'راجعت حالة التقويم وبيانات الإغلاق الحالية واخترت الحالة المقصودة',exact:true}).check();
  await confirm.evaluate((node:HTMLButtonElement)=>{node.click();node.click();});
  await page.getByRole('region',{name:'طلب إعادة الفتح غير المحسوم',exact:true}).waitFor();
  await expect.poll(()=>posts.length).toBe(1);
  await expect.poll(async()=>await page.getByRole('button',{name:'التحقق من نتيجة الطلب وقراءة الحالة الحالية',exact:true}).isEnabled()).toBe(true);
  expect(await events(f)).toHaveLength(1);
  await page.getByRole('button',{name:'التحقق من نتيجة الطلب وقراءة الحالة الحالية',exact:true}).click();
  await expect.poll(async()=>(await caseRow(f)).status).toBe('retention');
  await expect.poll(async()=>page.getByRole('region',{name:'طلب إعادة الفتح غير المحسوم',exact:true}).count()).toBe(0);
  await expect.poll(async()=>current.innerText()).toContain(CASE_STATUS_LABEL.retention);
  expect(posts).toHaveLength(1);expect(nonLifecycle(await caseRow(f))).toEqual(nonLifecycle(before));expect(await counts(f)).toEqual(beforeCounts);
  expect((await events(f))[0]).toMatchObject({previous_closed_by:'Historical synthetic clinician',previous_closed_note:'Historical synthetic closure'});
  // Current closure after a successful earlier receipt remains authoritative.
  expect((await authedMutation(`/api/ortho/${f.caseId}`,h.sessions.admin,'PATCH',JSON.stringify({status:'completed',note:'Synthetic browser subsequent closure'}))).status).toBe(200);
  await page.getByRole('button',{name:'تحديث حالة التقويم',exact:true}).click();
  await expect.poll(async()=>current.innerText()).toContain('Synthetic browser subsequent closure');
  expect(await current.innerText()).toContain(CASE_STATUS_LABEL.completed);expect(await target.inputValue()).toBe('');
  expect(posts).toHaveLength(1);expect(await events(f)).toHaveLength(1);
  const panel=page.locator('details').filter({has:page.getByText('حالة التقويم: الإغلاق وإعادة الفتح',{exact:true})});
  await panel.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await panel.screenshot({path:`.settings-ui-artifacts/ortho-reopen-${width}.png`});
  await page.reload();await page.getByText('حالة التقويم: الإغلاق وإعادة الفتح',{exact:true}).click();
  await expect.poll(async()=>current.innerText()).toContain('Synthetic browser subsequent closure');expect(posts).toHaveLength(1);
  expect((await db.query('SELECT * FROM clinical_cases WHERE id=$1',[f.clinicalCaseId])).rows).toEqual(bridgeBefore);
  expect(await counts(f)).toEqual(beforeCounts);expect(errors).toEqual([]);
 }finally{await context.close();}
});
