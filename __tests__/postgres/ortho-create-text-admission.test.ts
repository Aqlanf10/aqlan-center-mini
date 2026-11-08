import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { openPeriodontalFixture } from './_periodontal-fixture';
const context=vi.hoisted(()=>({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(n:string)=>n==='aqlan_flow_session'?{value:context.token}:undefined}),headers:async()=>new Headers()}));
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>,POST:typeof import('../../app/api/ortho/route').POST;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-create-authority-tests-only-20261106');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();({POST}=await import('../../app/api/ortho/route'));});
afterAll(async()=>{vi.useRealTimers();await f?.close();vi.unstubAllEnvs();});
async function setup(role:'admin'|'doctor'|'reception'='admin'){
 const username=`synthetic-create-${randomUUID()}`,password='synthetic-create-password';
 const partyId=(await f.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic create doctor') RETURNING id")).rows[0].id;
 const actorId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions,party_id) VALUES($1,'Synthetic create actor',$2,$3,$4,$5) RETURNING id",[username,password,role,JSON.stringify({canViewAllPatients:true,canViewPlans:true,canEditPlans:true}),partyId])).rows[0].id;
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic create patient') RETURNING id",[randomUUID()])).rows[0].id;
 const session:SessionPayload={userId:actorId,username,role,partyId,expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion(password)};
 context.token=createSessionToken(session);
 const body={patientId,appliance:'fixed_metal',arches:'both',slot:'022',plannedMonths:18,startDate:'2026-11-07'};
 const send=(extra:Record<string,unknown>={})=>POST(new Request('https://synthetic.invalid/api/ortho',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,...extra})}));
 return{patientId,actorId,partyId,session,body,send};
}
// Actual handler, signed synthetic session, and PostgreSQL persistence.
async function footprint() {
 return (await f.pool.query(`SELECT
  (SELECT count(*) FROM ortho_cases)::int cases,
  (SELECT count(*) FROM clinical_cases)::int shells,
  (SELECT count(*) FROM audit_log)::int audits`)).rows;
}

it('rejects malformed text without case, bridge, audit or existing-shell mutation; permits corrected retry', async () => {
 const s=await setup();
 await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,site,created_by,origin) VALUES($1,'orthodontics','Synthetic shell','both','synthetic','invoice')",[s.patientId]);
 const before=await footprint(),shells=(await f.pool.query('SELECT * FROM clinical_cases WHERE patient_id=$1',[s.patientId])).rows;
 for (const [field,limit] of [['bracketSystem',80],['note',300]] as const) {
  for (const value of [true,false,0,12,[],['text'],{},{value:'text'},'x'.repeat(limit+1),'x'.repeat(limit-1)+'🦷','\u0000','\ud800','\udc00']) {
   expect((await s.send({[field]:value})).status).toBe(400);
   expect(await footprint()).toEqual(before);
   expect((await f.pool.query('SELECT * FROM clinical_cases WHERE patient_id=$1',[s.patientId])).rows).toEqual(shells);
  }
 }
 const bracketSystem='عربي MBT é 🦷',note='First line\nملاحظة سريرية\t🦷';
 const response=await s.send({bracketSystem,note});expect(response.status).toBe(201);
 const {id}=await response.json();
 expect((await f.pool.query('SELECT bracket_system,note FROM ortho_cases WHERE id=$1',[id])).rows).toEqual([{bracket_system:bracketSystem,note}]);
 expect((await s.send({bracketSystem,note})).status).toBe(409);
 expect((await f.pool.query("SELECT count(*)::int n FROM audit_log WHERE action='ortho.case_create' AND entity_id=$1",[id])).rows).toEqual([{n:1}]);
});
it.each([
 ['x'.repeat(80),'n'.repeat(300)],['🦷'.repeat(40),'🦷'.repeat(150)],
 ['MBT عربي é','note\nline\tمتابعة A\u200dB \uFFFD'],
 ['  MBT  ','  محفوظ  '],[undefined,undefined],[null,null],['',''],[' \t\n',' \t\n'],
])('preserves supported text and existing trim/blank semantics', async (bracketSystem,note) => {
 const s=await setup(),r=await s.send({bracketSystem,note});expect(r.status).toBe(201);
 const {id}=await r.json();
 expect((await f.pool.query('SELECT bracket_system,note FROM ortho_cases WHERE id=$1',[id])).rows).toEqual([{bracket_system:bracketSystem?.trim()||null,note:note?.trim()||null}]);
});

it.each(['\u0000','\ud800','\udc00'])('rejects unrepresentable text %j without persistence', async note => {
 const s=await setup(),before=await footprint();
 const r=await s.send({note});
 if(r.status===201){
  const {id}=await r.clone().json();
  expect((await f.pool.query('SELECT note FROM ortho_cases WHERE id=$1',[id])).rows[0].note).toBe(note);
 }
 expect(r.status).toBe(400);
 expect(await footprint()).toEqual(before);
});
