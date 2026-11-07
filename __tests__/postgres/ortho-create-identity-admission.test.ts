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
it.each(['patientId','planId'])('rejects malformed %s without case, bridge or audit mutation, then allows correction', async field => {
 const s=await setup();
 await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,site,created_by,origin) VALUES($1,'orthodontics','Synthetic shell','both','synthetic','invoice')",[s.patientId]);
 const planId=(await f.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'Synthetic plan',0,'synthetic') RETURNING id",[s.patientId])).rows[0].id;
 const before=await footprint(),shells=(await f.pool.query('SELECT * FROM clinical_cases WHERE patient_id=$1',[s.patientId])).rows;
 for (const value of [[s.patientId], true, false, [], {}, {toString:null,valueOf:null}, 'not-a-plan',
  0,-1,1.1,2147483648,Number.MAX_SAFE_INTEGER+1,`${s.patientId}.00000000000000001`,
  '1e2','0x65',`+${s.patientId}`,`0${s.patientId}`,` ${s.patientId} `,'9007199254740993']) {
  expect((await s.send({[field]:value})).status).toBe(400);
  expect(await footprint()).toEqual(before);
  expect((await f.pool.query('SELECT * FROM clinical_cases WHERE patient_id=$1',[s.patientId])).rows).toEqual(shells);
 }
 const response=await s.send({patientId:String(s.patientId),planId:String(planId)});
 expect(response.status).toBe(201);
 const {id}=await response.json();
 expect((await f.pool.query('SELECT patient_id,plan_id FROM ortho_cases WHERE id=$1',[id])).rows).toEqual([{patient_id:s.patientId,plan_id:planId}]);
 expect((await s.send()).status).toBe(409);
 expect((await f.pool.query("SELECT count(*)::int n FROM audit_log WHERE action='ortho.case_create' AND entity_id=$1",[id])).rows).toEqual([{n:1}]);
});
it.each([undefined,null,'','  '])('preserves intentional unlinked plan %j', async planId => {
 const s=await setup(),r=await s.send({planId});expect(r.status).toBe(201);
 const {id}=await r.json();
 expect((await f.pool.query('SELECT plan_id FROM ortho_cases WHERE id=$1',[id])).rows).toEqual([{plan_id:null}]);
});
