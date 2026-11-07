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
it.each(['appliance', 'arches', 'slot'])('rejects invalid %s with no case, shell mutation or audit', async field => {
 const s=await setup();
 await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,site,created_by,origin) VALUES($1,'orthodontics','Synthetic shell','both','synthetic','invoice')",[s.patientId]);
 const before=await footprint();
 const shells=(await f.pool.query('SELECT * FROM clinical_cases WHERE patient_id=$1',[s.patientId])).rows;
 for (const value of ['unknown', ' aligners', 'ALIGNERS', 'Both', 'UPPER', '022 ', '020', '', ' ', null, [], {}, 22, true, ['022']]) {
  expect((await s.send({[field]:value})).status).toBe(400);
  expect(await footprint()).toEqual(before);
  expect((await f.pool.query('SELECT * FROM clinical_cases WHERE patient_id=$1',[s.patientId])).rows).toEqual(shells);
 }
});
it('rejects the observed three-field corruption and permits corrected retry', async () => {
 const s=await setup(),before=await footprint();
 expect((await s.send({appliance:'aligner',arches:'UPPER',slot:'020'})).status).toBe(400);
 expect(await footprint()).toEqual(before);
 const response=await s.send({appliance:'aligners',arches:'upper',slot:'018'});
 expect(response.status).toBe(201);
 const {id}=await response.json();
 expect((await f.pool.query('SELECT appliance,arches,slot FROM ortho_cases WHERE id=$1',[id])).rows).toEqual([{appliance:'aligners',arches:'upper',slot:'018'}]);
 expect((await s.send()).status).toBe(409);
 expect((await f.pool.query("SELECT count(*)::int n FROM audit_log WHERE action='ortho.case_create' AND entity_id=$1",[id])).rows).toEqual([{n:1}]);
});
it.each([
 ['fixed_metal','upper','018'], ['fixed_ceramic','lower','022'],
 ['aligners','both','018'], ['removable','upper','022'], ['functional','lower','018'],
])('persists supported values %s %s %s unchanged', async (appliance,arches,slot) => {
 const s=await setup();
 const response=await s.send({appliance,arches,slot});
 expect(response.status).toBe(201);
 const {id}=await response.json();
 expect((await f.pool.query('SELECT appliance,arches,slot FROM ortho_cases WHERE id=$1',[id])).rows).toEqual([{appliance,arches,slot}]);
});
it('CONTROL: numeric patient identity and exact whole-month strings remain supported', async () => {
 const s=await setup();
 const r=await s.send({patientId:String(s.patientId),plannedMonths:'19.0'}); expect(r.status).toBe(201);
 const {id}=await r.json();
 expect((await f.pool.query('SELECT planned_months FROM ortho_cases WHERE id=$1',[id])).rows).toEqual([{planned_months:19}]);
});
it('CONTROL: omitted values retain intentional clinical defaults', async () => {
 const s=await setup();
 const r=await s.send({appliance:undefined,arches:undefined,slot:undefined,startDate:undefined,plannedMonths:undefined}); expect(r.status).toBe(201);
 const {id}=await r.json();
 expect((await f.pool.query('SELECT appliance,arches,slot,planned_months,plan_id FROM ortho_cases WHERE id=$1',[id])).rows).toEqual([{appliance:'fixed_metal',arches:'both',slot:'022',planned_months:18,plan_id:null}]);
});
