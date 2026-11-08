import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { openPeriodontalFixture } from './_periodontal-fixture';
const context=vi.hoisted(()=>({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(n:string)=>n==='aqlan_flow_session'?{value:context.token}:undefined}),headers:async()=>new Headers()}));
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>,GET:typeof import('../../app/api/ortho/route').GET;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-create-authority-tests-only-20261106');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();({GET}=await import('../../app/api/ortho/route'));});
afterAll(async()=>{vi.useRealTimers();await f?.close();vi.unstubAllEnvs();});
async function setup(role:'admin'|'doctor'|'reception'='admin'){
 const username=`synthetic-create-${randomUUID()}`,password='synthetic-create-password';
 const partyId=(await f.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic create doctor') RETURNING id")).rows[0].id;
 const actorId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions,party_id) VALUES($1,'Synthetic create actor',$2,$3,$4,$5) RETURNING id",[username,password,role,JSON.stringify({canViewAllPatients:true,canViewPlans:true,canEditPlans:true}),partyId])).rows[0].id;
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic create patient') RETURNING id",[randomUUID()])).rows[0].id;
 const session:SessionPayload={userId:actorId,username,role,partyId,expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion(password)};
 context.token=createSessionToken(session);
 const body={patientId,appliance:'fixed_metal',arches:'both',slot:'022',plannedMonths:18,startDate:'2026-11-07'};
 const send=(query='')=>GET(new Request(`https://synthetic.invalid/api/ortho${query}`));
 return{patientId,actorId,partyId,session,body,send};
}
it.each(['admin','reception'] as const)('rejects out-of-int4 filter with real %s session',async role=>{
 const s=await setup(role);
 for(const id of ['2147483648','9007199254740991']) expect((await s.send(`?patientId=${id}`)).status).toBe(400);
});
it('proves the trusted reader encounters PostgreSQL int4 range errors',async()=>{
 await expect(f.db.listPatientOrthoCases(2147483648,'2026-11-07')).rejects.toMatchObject({code:'22003'});
});
it.each([1,2147483647])('returns valid clinical content for int4 boundary %i',async patientId=>{
 const s=await setup();
 await f.pool.query("INSERT INTO patients(id,patient_number,full_name) VALUES($1,$2,'Synthetic boundary patient') ON CONFLICT(id) DO NOTHING",[patientId,randomUUID()]);
 const created=await f.db.createOrthoCase({...s.body,patientId,appliance:'fixed_metal',arches:'both',slot:'022',bracketSystem:null,planId:null,note:'Synthetic boundary note',createdBy:s.session.username});
 expect(created.ok).toBe(true);
 const response=await s.send(`?patientId=${patientId}`);expect(response.status).toBe(200);
 expect((await response.json()).cases).toEqual([expect.objectContaining({patientId,note:'Synthetic boundary note',photosVisible:true})]);
});
it('keeps scoped doctor denial and unfiltered visibility',async()=>{
 const s=await setup('doctor');
 await f.pool.query("UPDATE users SET permissions='{}'::jsonb WHERE id=$1",[s.actorId]);
 expect((await s.send(`?patientId=${s.patientId}`)).status).toBe(403);
 const response=await s.send();expect(response.status).toBe(200);expect((await response.json()).cases).toEqual([]);
});
it.each(['?patientId=', '?patientId=01', '?patientId=0', '?patientId=1&patientId=1'])('rejects malformed/repeated filter %s with actual session',async query=>{
 const s=await setup();expect((await s.send(query)).status).toBe(400);
});
