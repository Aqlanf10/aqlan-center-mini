import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { chromium,type Browser } from 'playwright';
import { createSessionToken,readSessionToken,sessionCredentialVersion,SESSION_COOKIE,type SessionPayload } from '../../lib/auth';
import { reviewHrPersonIdentity,applyHrPersonIdentityPlan } from '../../lib/hr-person-identity';
import type { PersonIdentityDecision } from '../../lib/hr-person-identity-plan';
import type { IdentityPreview } from '../../lib/hr-identity-preview-shared';
import { identityDatabaseState } from '../helpers/hr-identity-state';
import { harness,type Harness } from './_server';
import { openHrJourneyServer } from './_hr-isolated-server';

let h:Harness,isolated:Awaited<ReturnType<typeof openHrJourneyServer>>,browser:Browser;
let a:SessionPayload,b:SessionPayload,reviewer:SessionPayload,cookieA:string,cookieB:string,staffId:number,partyId:number,privateTask:number;
const savedSecret=process.env.SESSION_SECRET;
const evidence=process.env.HR_PERSON_EVIDENCE_DIR??'/tmp/hr-person-identity-evidence';
async function api(path:string,method='GET',body?:unknown,cookie=h.sessions.admin.cookie){
  return fetch(`${isolated.baseUrl}${path}`,{method,headers:{cookie,origin:isolated.baseUrl,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
}
function decision(patch:Partial<PersonIdentityDecision>={}):PersonIdentityDecision{return {key:'person',staffId,expectedRevision:0,fullName:null,
  userIds:[a.userId,b.userId],partyId,confirmedSamePerson:true,reason:'Synthetic HTTP identity review',sourceRef:'synthetic-http-1',closeAccountLinkIds:[],closePartyLinkId:null,...patch};}
beforeAll(async()=>{
  h=await harness();isolated=await openHrJourneyServer(h);
  await api('/api/auth/me'); // Finish legacy startup before the proposal is installed in this owned DB only.
  process.env.SESSION_SECRET='security-http-test-secret-0123456789abcdef';
  reviewer=readSessionToken(h.sessions.admin.token)!;expect(reviewer).not.toBeNull();
  await isolated.db.query(readFileSync(new URL('../../docs/proposals/hr-person-identity.sql',import.meta.url),'utf8'));
  partyId=(await isolated.db.query("INSERT INTO parties(name,kind) VALUES('جهة موظف اصطناعية','employee') RETURNING id")).rows[0].id;
  const users=(await isolated.db.query(`INSERT INTO users(username,display_name,password_hash,role)
    VALUES('identity-http-one','شخص اصطناعي موثق','synthetic-identity-http-hash','admin'),
      ('identity-http-two','شخص اصطناعي موثق','synthetic-identity-http-hash','admin'),
      ('identity-http-similar','شخص اصطناعي موثق','synthetic-identity-http-hash','reception') RETURNING id,username,role`)).rows;
  [a,b]=users.slice(0,2).map(row=>({userId:row.id,username:row.username,role:row.role,credentialVersion:sessionCredentialVersion('synthetic-identity-http-hash'),expiresAt:Date.now()+3600_000}));
  cookieA=`${SESSION_COOKIE}=${createSessionToken(a)}`;cookieB=`${SESSION_COOKIE}=${createSessionToken(b)}`;
  staffId=(await isolated.db.query(`INSERT INTO hr_staff(full_name,user_id,created_by,work_status,contract_kind,hire_date,
    salary_amount_minor,salary_currency,salary_period,salary_effective_on)
    VALUES('موظف هوية اصطناعي',$1,'synthetic','active','salary','2026-01-01',125000,'YER','monthly','2026-01-01') RETURNING id`,[a.userId])).rows[0].id;
  const plan=await reviewHrPersonIdentity(isolated.db,reviewer,[decision()]);expect(plan.steps[0].conflicts).toEqual([]);
  await applyHrPersonIdentityPlan(isolated.db,reviewer,{requestId:'synthetic-http-initial',plan});
  privateTask=(await isolated.db.query(`INSERT INTO hr_tasks(title,owner_user_id,is_private,created_by,owner_display_name)
    VALUES('مهمة خاصة اصطناعية',$1,TRUE,$2,'Synthetic owner') RETURNING id`,[a.userId,a.username])).rows[0].id;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});mkdirSync(evidence,{recursive:true});
});
afterAll(async()=>{try{await browser?.close();await isolated?.close();}finally{process.env.SESSION_SECRET=savedSecret;}});
it('existing preview exposes explicit links safely and remains read-only after schema installation',async()=>{
  const before=await identityDatabaseState(isolated.db),response=await api('/api/hr/identity-preview');expect(response.status).toBe(200);
  const preview=await response.json() as IdentityPreview;
  expect(preview.candidates.find(c=>c.key===`staff:${staffId}`)?.userIds).toEqual([a.userId,b.userId]);
  expect(preview.sources.accountLinks?.filter(l=>l.staffId===staffId)).toHaveLength(2);
  for(const key of ['synthetic-identity-http-hash','password_hash','commission_config','permissions','salary_amount_minor','125000'])expect(JSON.stringify(preview)).not.toContain(key);
  for(const reverse of [false,true]){
    const decisions=[{staffId,userIds:[],partyIds:[],confirmedSamePerson:true},{staffId:null,userIds:[b.userId],partyIds:[],confirmedSamePerson:true}];
    const reviewed=await api('/api/hr/identity-preview','POST',{sourceDigest:preview.sourceDigest,decisions:reverse?[...decisions].reverse():decisions});
    expect(reviewed.status).toBe(200);const p=await reviewed.json() as IdentityPreview;
    expect(p.candidates.filter(c=>c.explicit).every(c=>c.reasons.includes('duplicate_selection'))).toBe(true);
  }
  expect(await identityDatabaseState(isolated.db)).toEqual(before);
});
it('linking identities creates no apply route and grants no private task or roster access',async()=>{
  expect((await api(`/api/tasks/${privateTask}`,'GET',undefined,cookieA)).status).toBe(200);
  expect((await api(`/api/tasks/${privateTask}`,'GET',undefined,cookieB)).status).toBe(404);
  expect((await api('/api/hr/identity-preview','GET',undefined,h.sessions.reception.cookie)).status).toBe(403);
  expect((await api('/api/hr/identity-preview','GET',undefined,h.sessions.doctorA.cookie)).status).toBe(403);
  expect((await api('/api/hr/identity-apply','POST',{decisions:[decision()]})).status).toBe(404);
});
it('an actual HTTP leave request rejects both accounts of its beneficiary and allows an independent reviewer',async()=>{
  const balance=await api('/api/hr/leaves/balances','POST',{staffId,leaveTypeId:'annual',year:2026,allocatedDays:8,reason:'Synthetic balance'});expect(balance.ok).toBe(true);
  const created=await api('/api/hr/leaves','POST',{staffId,leaveTypeCode:'annual',startDate:'2026-11-10',endDate:'2026-11-10',daysCount:1,reason:'طلب إجازة اصطناعي'},cookieA);
  expect(created.status).toBe(201);const request=await created.json();const before=await identityDatabaseState(isolated.db);
  for(const cookie of [cookieA,cookieB])expect((await api(`/api/hr/leaves/${request.id}`,'PATCH',{status:'approved',decisionNotes:'Self approval attempt'},cookie)).status).toBe(403);
  expect(await identityDatabaseState(isolated.db)).toEqual(before);
  expect((await api(`/api/hr/leaves/${request.id}`,'PATCH',{status:'approved',decisionNotes:'Independent approval'})).status).toBe(200);
  const after=await identityDatabaseState(isolated.db);expect((await api(`/api/hr/leaves/${request.id}`,'PATCH',{status:'approved',decisionNotes:'Replay'})).status).toBe(200);
  expect(await identityDatabaseState(isolated.db)).toEqual(after);
});
it('actual HTTP correction remains protected after closing the second account link',async()=>{
  const attendance=(await isolated.db.query(`INSERT INTO hr_attendance_records(staff_id,attendance_date,check_in_raw,check_in_actual,check_out_raw,check_out_actual,status,created_by)
    VALUES($1,'2026-11-11','2026-11-11T08:00:00Z','2026-11-11T08:00:00Z','2026-11-11T16:00:00Z','2026-11-11T16:00:00Z','present','synthetic') RETURNING id`,[staffId])).rows[0].id;
  const created=await api('/api/hr/attendance/corrections','POST',{attendanceRecordId:attendance,fieldCorrected:'check_in',newCheckIn:'2026-11-11T09:00:00Z',reason:'تصحيح اصطناعي'},cookieA);
  expect(created.status).toBe(201);const request=await created.json();
  const link=(await isolated.db.query('SELECT id::text FROM hr_staff_account_links WHERE user_id=$1 AND closed_at IS NULL',[b.userId])).rows[0];
  const previous=await (await api('/api/hr/identity-preview')).json() as IdentityPreview;
  const plan=await reviewHrPersonIdentity(isolated.db,reviewer,[decision({expectedRevision:1,userIds:[a.userId],closeAccountLinkIds:[link.id]})]);
  await applyHrPersonIdentityPlan(isolated.db,reviewer,{requestId:'synthetic-http-close',plan});
  const before=await identityDatabaseState(isolated.db);
  expect((await api('/api/hr/identity-preview','POST',{sourceDigest:previous.sourceDigest,decisions:[]})).status).toBe(409);
  expect((await api('/api/hr/attendance/corrections','POST',{action:'decide',id:request.id,decision:'approved',reason:'Closed-link bypass'},cookieB)).status).toBe(403);
  expect(await identityDatabaseState(isolated.db)).toEqual(before);
  expect((await api('/api/hr/attendance/corrections','POST',{action:'decide',id:request.id,decision:'approved',reason:'Independent reviewer'})).status).toBe(200);
});
for(const width of [390,1280])it(`converted identity preview renders safely at ${width}`,async()=>{
  const context=await browser.newContext({viewport:{width,height:900}}),pair=h.sessions.admin.cookie.split(';')[0],at=pair.indexOf('=');
  await context.addCookies([{name:pair.slice(0,at),value:pair.slice(at+1),url:isolated.baseUrl}]);
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    const before=await identityDatabaseState(isolated.db);
    const loaded=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/hr/identity-preview'&&response.request().method()==='GET');
    await page.goto(`${isolated.baseUrl}/hr?tab=identity`,{waitUntil:'domcontentloaded'});
    expect((await loaded).status()).toBe(200);
    await expect.poll(()=>page.locator(`[data-identity-key="staff:${staffId}"]`).count(),{timeout:10_000}).toBe(1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
    await page.screenshot({path:join(evidence,`hr-person-${width}.png`),fullPage:true});
    expect(await identityDatabaseState(isolated.db)).toEqual(before);
    writeFileSync(join(evidence,`hr-person-${width}.json`),JSON.stringify({width,errors,zeroDatabaseChange:true}));
  }finally{await context.close();}
});
