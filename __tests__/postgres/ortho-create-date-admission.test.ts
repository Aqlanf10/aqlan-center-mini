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

it('rejects invalid dates without case, bridge, audit or existing-shell mutation; permits corrected retry', async () => {
 const s=await setup();
 await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,site,created_by,origin) VALUES($1,'orthodontics','Synthetic shell','both','synthetic','invoice')",[s.patientId]);
 const before=await footprint(),shells=(await f.pool.query('SELECT * FROM clinical_cases WHERE patient_id=$1',[s.patientId])).rows;
 for (const startDate of ['2026/03/01','2026-02-30','2025-02-29','1900-02-29','0000-01-01',
  '2026-13-01','2026-00-01','2026-01-00','2026-04-31','2026-1-01','10000-01-01',
  '2026-03-01T00:00:00Z',' 2026-03-01 ',20260301,true,false,[],['2026-03-01'],{},{toString:null,valueOf:null}]) {
  expect((await s.send({startDate})).status).toBe(400);
  expect(await footprint()).toEqual(before);
  expect((await f.pool.query('SELECT * FROM clinical_cases WHERE patient_id=$1',[s.patientId])).rows).toEqual(shells);
 }
 const response=await s.send({startDate:'2028-02-29'});
 expect(response.status).toBe(201);
 const {id}=await response.json();
 expect((await f.pool.query('SELECT start_date::text FROM ortho_cases WHERE id=$1',[id])).rows).toEqual([{start_date:'2028-02-29'}]);
 expect((await s.send({startDate:'2028-02-29'})).status).toBe(409);
 expect((await f.pool.query("SELECT count(*)::int n FROM audit_log WHERE action='ortho.case_create' AND entity_id=$1",[id])).rows).toEqual([{n:1}]);
});
it.each(['0001-01-01','0099-12-31','1900-02-28','2000-02-29','2028-02-29','9999-12-31'])('persists exact valid date %s', async startDate => {
 const s=await setup(),r=await s.send({startDate});expect(r.status).toBe(201);
 const {id}=await r.json();
 expect((await f.pool.query('SELECT start_date::text FROM ortho_cases WHERE id=$1',[id])).rows).toEqual([{start_date:startDate}]);
});
it.each([undefined,null,'','  ','\t\n'])('preserves absent/blank date fallback %j', async startDate => {
 const s=await setup();
 vi.useFakeTimers({toFake:['Date']});
 try {
  vi.setSystemTime(new Date('2026-11-07T22:30:00Z'));
  context.token=createSessionToken({...s.session,expiresAt:Date.now()+3600000});
  const r=await s.send({startDate});expect(r.status).toBe(201);
  const {id}=await r.json();
  expect((await f.pool.query('SELECT start_date::text FROM ortho_cases WHERE id=$1',[id])).rows).toEqual([{start_date:'2026-11-08'}]);
 } finally { vi.useRealTimers(); }
});
