vi.mock('server-only',()=>({}));
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { openPeriodontalFixture } from './_periodontal-fixture';
import { reopenOrthoCase, readOrthoReopen } from '../../lib/ortho-reopen-store';
import { ProtectedOrthoReopenHistoryError } from '../../lib/clinic-reset';
import type { OrthoReopenCommand } from '../../lib/ortho-reopen-contract';
const request=vi.hoisted(()=>({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='aqlan_flow_session'?{value:request.token}:undefined}),headers:async()=>new Headers()}));
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-reopen-secret-at-least-32-characters');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();});
afterAll(async()=>{await f?.close();vi.unstubAllEnvs();});
function login(session:SessionPayload){request.token=createSessionToken(session);}
async function seed(diagnostic=false,role:SessionPayload['role']='admin'){
 const username=`synthetic-reopen-${randomUUID()}`,password='synthetic-password';
 const userId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES($1,'Synthetic reopen actor',$2,$3,$4) RETURNING id",[username,password,role,JSON.stringify({canViewAllPatients:true})])).rows[0].id;
 const session:SessionPayload={userId,username,role,expiresAt:Date.now()+600000,credentialVersion:sessionCredentialVersion(password)};login(session);
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic reopen patient') RETURNING id",[randomUUID()])).rows[0].id;
 const orthoCaseId=(await f.pool.query(diagnostic?
  "INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by,closed_at,closed_by,closed_note) VALUES($1,'discontinued','assessment',NULL,NULL,NULL,NULL,NULL,'synthetic',NULL,NULL,NULL) RETURNING id":
  "INSERT INTO ortho_cases(patient_id,status,phase,retainer,retainer_on,created_by,closed_at,closed_by,closed_note,upper_wire) VALUES($1,'completed','retention','hawley','2026-10-01','synthetic','2026-10-02 12:34:56.123456+00','Original clinician','Original exact closure note','Synthetic wire') RETURNING id",[patientId])).rows[0].id;
 const clinicalCaseId=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by,status,completed_at) VALUES($1,'orthodontics','Synthetic reopen case',$2,'synthetic','completed','2026-10-02T00:00:00Z') RETURNING id",[patientId,orthoCaseId])).rows[0].id;
 const scope={session,patientId,orthoCaseId,clinicalCaseId};
 const command:OrthoReopenCommand={schemaVersion:1,clientRequestId:randomUUID(),expectedLifecycleVersion:0,expectedStatus:diagnostic?'discontinued':'completed',targetStatus:diagnostic?'assessment':'retention',reason:'Synthetic explicit clinician review'};
 return {scope,command};
}
const row=async(id:number)=>(await f.pool.query('SELECT * FROM ortho_cases WHERE id=$1',[id])).rows[0];
const count=async(id:number)=>(await f.pool.query('SELECT count(*)::int n FROM ortho_case_reopen_events WHERE ortho_case_id=$1',[id])).rows[0].n;
const stable=(r:Record<string,unknown>)=>Object.fromEntries(Object.entries(r).filter(([key])=>!['status','closed_at','closed_by','closed_note','lifecycle_version'].includes(key)));
it.each(['active','retention'] as const)('explicitly reopens to %s, preserving exact closure and all non-lifecycle data',async targetStatus=>{
 const s=await seed(),before=await row(s.scope.orthoCaseId),bridge=(await f.pool.query('SELECT * FROM clinical_cases WHERE id=$1',[s.scope.clinicalCaseId])).rows;
 const money=async()=>(await f.pool.query('SELECT (SELECT count(*) FROM invoices) invoices,(SELECT count(*) FROM payments) payments,(SELECT count(*) FROM patient_opening_balances) opening,(SELECT count(*) FROM visits) visits,(SELECT count(*) FROM treatment_plans) plans,(SELECT count(*) FROM appointments) appointments')).rows;
 const beforeMoney=await money();s.command.targetStatus=targetStatus;
 const result=await reopenOrthoCase({...s.scope,command:s.command});expect(result).toMatchObject({ok:true,replayed:false,current:{status:targetStatus,phase:'retention',version:1,closedAt:null},receipt:{before:{closedBy:'Original clinician',closedNote:'Original exact closure note'}}});
 expect(stable(await row(s.scope.orthoCaseId))).toEqual(stable(before));expect(await money()).toEqual(beforeMoney);
 expect((await f.db.listPatientCases(s.scope.patientId)).find(item=>item.orthoCaseId===s.scope.orthoCaseId)).toMatchObject({id:s.scope.clinicalCaseId,status:'active'});
 expect((await f.pool.query('SELECT * FROM clinical_cases WHERE id=$1',[s.scope.clinicalCaseId])).rows).toEqual(bridge);
 expect((await f.pool.query("SELECT previous_closed_at='2026-10-02 12:34:56.123456+00'::timestamptz exact FROM ortho_case_reopen_events WHERE ortho_case_id=$1",[s.scope.orthoCaseId])).rows[0].exact).toBe(true);
 expect(await reopenOrthoCase({...s.scope,command:s.command})).toMatchObject({ok:true,replayed:true,current:{version:1}});expect(await count(s.scope.orthoCaseId)).toBe(1);
 expect(await readOrthoReopen({...s.scope,requestId:s.command.clientRequestId})).toMatchObject({ok:true,receipt:{commandId:s.command.clientRequestId},history:[{afterVersion:1}]});
});
it('reopens discontinued assessment without inventing treatment or unknown closure dates',async()=>{
 const s=await seed(true);expect(await reopenOrthoCase({...s.scope,command:{...s.command,targetStatus:'active'}})).toMatchObject({ok:false,code:'reopen_target_incompatible'});
 expect(await reopenOrthoCase({...s.scope,command:s.command})).toMatchObject({ok:true,current:{status:'assessment'},receipt:{before:{closedAt:null,closedBy:null,closedNote:null}}});
 expect(await row(s.scope.orthoCaseId)).toMatchObject({appliance:null,arches:null,slot:null,start_date:null,planned_months:null});
});
it.each(['doctor','reception','cashier'] as const)('enforces current clinical-only %s authority on read and write',async role=>{
 const s=await seed(false,role),result=await reopenOrthoCase({...s.scope,command:s.command}),read=await readOrthoReopen(s.scope);
 expect(result.ok).toBe(role==='doctor');expect(read.ok).toBe(role==='doctor');if(!result.ok&&role!=='doctor')expect([401,403]).toContain(result.status);
});
it('denies revoked patient scope and changed account role using the current database actor',async()=>{
 const s=await seed(false,'doctor');await f.pool.query("UPDATE users SET permissions='{}' WHERE id=$1",[s.scope.session.userId]);
 expect(await reopenOrthoCase({...s.scope,command:s.command})).toMatchObject({ok:false,status:403});
 await f.pool.query("UPDATE users SET role='reception' WHERE id=$1",[s.scope.session.userId]);
 expect(await reopenOrthoCase({...s.scope,command:s.command})).toMatchObject({ok:false,status:401});expect(await count(s.scope.orthoCaseId)).toBe(0);
});
it('serializes exact concurrent retries and refuses a competing stale intent',async()=>{
 const s=await seed(),results=await Promise.all(Array.from({length:3},()=>reopenOrthoCase({...s.scope,command:s.command})));
 expect(results.every(r=>r.ok)).toBe(true);expect(results.filter(r=>r.ok&&!r.replayed)).toHaveLength(1);expect(await count(s.scope.orthoCaseId)).toBe(1);
 expect(await reopenOrthoCase({...s.scope,command:{...s.command,reason:'Changed intent'}})).toMatchObject({ok:false,code:'request_key_conflict'});
 expect(await reopenOrthoCase({...s.scope,command:{...s.command,clientRequestId:randomUUID()}})).toMatchObject({ok:false,code:'reopen_state_changed'});
});
it('old durable replay after reclosure never reopens again and later cycles preserve both closures',async()=>{
 const s=await seed();expect((await reopenOrthoCase({...s.scope,command:s.command})).ok).toBe(true);
 expect(await f.db.closeOrthoCase({id:s.scope.orthoCaseId,status:'completed',actor:'ignored',note:'Second closure'},s.scope)).toEqual({ok:true});
 const closed=await row(s.scope.orthoCaseId);expect(closed.lifecycle_version).toBe(2);
 expect(await reopenOrthoCase({...s.scope,command:s.command})).toMatchObject({ok:true,replayed:true,current:{status:'completed',version:2},receipt:{afterVersion:1}});
 expect(await row(s.scope.orthoCaseId)).toEqual(closed);
 const next={...s.command,clientRequestId:randomUUID(),expectedLifecycleVersion:2,reason:'Second explicit reopening'};
 expect(await reopenOrthoCase({...s.scope,command:next})).toMatchObject({ok:true,current:{version:3}});
 const history=await readOrthoReopen(s.scope);expect(history).toMatchObject({ok:true,history:[{before:{closedNote:'Second closure'}},{before:{closedNote:'Original exact closure note'}}]});
});
it('refuses another open case and foreign or absent bridge without side effects',async()=>{
 const s=await seed(),other=await seed();login(s.scope.session);
 expect(await reopenOrthoCase({...s.scope,clinicalCaseId:other.scope.clinicalCaseId,command:s.command})).toMatchObject({ok:false,code:'case_scope_changed'});
 await f.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'active','synthetic')",[s.scope.patientId]);
 expect(await reopenOrthoCase({...s.scope,command:s.command})).toMatchObject({ok:false,code:'another_ortho_case_open'});
 await f.pool.query('DELETE FROM clinical_cases WHERE id=$1',[other.scope.clinicalCaseId]);login(other.scope.session);
 expect(await reopenOrthoCase({...other.scope,command:other.command})).toMatchObject({ok:false,code:'bridge_missing'});expect(await count(s.scope.orthoCaseId)).toBe(0);
});
it('prevents raw reopening without preserved evidence and protects event ownership/immutability',async()=>{
 const s=await seed();await expect(f.pool.query("UPDATE ortho_cases SET status='active',closed_at=NULL,closed_by=NULL,closed_note=NULL WHERE id=$1",[s.scope.orthoCaseId])).rejects.toThrow(/exact preserved closure/);
 expect((await reopenOrthoCase({...s.scope,command:s.command})).ok).toBe(true);
 await expect(f.pool.query("UPDATE ortho_case_reopen_events SET reason='forged' WHERE ortho_case_id=$1",[s.scope.orthoCaseId])).rejects.toThrow(/immutable/);
 await expect(f.pool.query('DELETE FROM ortho_case_reopen_events WHERE ortho_case_id=$1',[s.scope.orthoCaseId])).rejects.toThrow(/immutable/);
 const other=await seed();await expect(f.pool.query('UPDATE ortho_cases SET patient_id=$2 WHERE id=$1',[s.scope.orthoCaseId,other.scope.patientId])).rejects.toThrow(/ownership/);
});
it('protects merge and reset before backup/deletion',async()=>{
 const s=await seed(),other=await seed();login(s.scope.session);expect((await reopenOrthoCase({...s.scope,command:s.command})).ok).toBe(true);
 expect(await f.db.mergeDuplicatePatient(s.scope.patientId,other.scope.patientId,{actor:s.scope.session.username,actorRole:'admin'})).toMatchObject({ok:false,reason:'source_has_clinical_command_history'});
 const backup=vi.fn();await expect(f.db.resetClinicData({actor:s.scope.session.username,actorRole:'admin'},backup)).rejects.toBeInstanceOf(ProtectedOrthoReopenHistoryError);expect(backup).not.toHaveBeenCalled();
});
it('rolls back history, case and audit when the signed session expires during a late audit wait',async()=>{
 const s=await seed(),before=await row(s.scope.orthoCaseId),blocker=await f.pool.connect();
 await blocker.query('BEGIN');await blocker.query('LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE');
 const expiresAt=Date.now()+2000;login({...s.scope.session,expiresAt});const pending=reopenOrthoCase({...s.scope,command:s.command});
 try{
  await vi.waitFor(async()=>{expect((await f.pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO audit_log%'")).rows[0].n).toBe(1);},{timeout:1500,interval:20});
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiresAt-Date.now()+30)));
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending.catch(()=>undefined);}
 expect(await pending).toMatchObject({ok:false,status:401});expect(await row(s.scope.orthoCaseId)).toEqual(before);expect(await count(s.scope.orthoCaseId)).toBe(0);
 expect((await f.pool.query("SELECT count(*)::int n FROM audit_log WHERE action='ortho.reopen' AND entity_id=$1",[String(s.scope.orthoCaseId)])).rows[0].n).toBe(0);
});

it('preserves a newer independent phase without treating closure CAS as a clinical-snapshot version',async()=>{
 const s=await seed();await f.pool.query("UPDATE ortho_cases SET phase='finishing' WHERE id=$1",[s.scope.orthoCaseId]);
 expect((await row(s.scope.orthoCaseId)).lifecycle_version).toBe(0);
 expect(await reopenOrthoCase({...s.scope,command:s.command})).toMatchObject({ok:true,current:{phase:'finishing',version:1},receipt:{before:{phase:'finishing'}}});
});

it('routes enforce clinical admission, strict intent and same-case durable recovery',async()=>{
 const s=await seed(),{GET,POST}=await import('../../app/api/ortho/[id]/reopen/route');
 const context={params:Promise.resolve({id:String(s.scope.orthoCaseId)})};
 const send=(body:unknown)=>POST(new Request(`https://synthetic.invalid/api/ortho/${s.scope.orthoCaseId}/reopen`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),context);
 const body={patientId:s.scope.patientId,clinicalCaseId:s.scope.clinicalCaseId,command:s.command};
 expect((await send({...body,invoice:{}})).status).toBe(400);expect(await count(s.scope.orthoCaseId)).toBe(0);
 expect((await send(body)).status).toBe(201);expect((await send(body)).status).toBe(200);
 const recovered=await GET(new Request(`https://synthetic.invalid/api/ortho/${s.scope.orthoCaseId}/reopen?patientId=${s.scope.patientId}&requestId=${s.command.clientRequestId}`),context);
 expect(recovered.status).toBe(200);expect(await recovered.json()).toMatchObject({receipt:{commandId:s.command.clientRequestId},current:{version:1}});
 const reception=await seed(false,'reception');login(reception.scope.session);
 expect((await send(body)).status).toBe(403);
 expect((await GET(new Request(`https://synthetic.invalid/api/ortho/${s.scope.orthoCaseId}/reopen?patientId=${s.scope.patientId}`),context)).status).toBe(403);
});
it('binds recovered commands to their actor and rejects same-patient key reuse for another case',async()=>{
 const s=await seed();expect((await reopenOrthoCase({...s.scope,command:s.command})).ok).toBe(true);
 const otherCaseId=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,retainer,created_by) VALUES($1,'completed','retention','hawley','synthetic') RETURNING id",[s.scope.patientId])).rows[0].id;
 const otherBridge=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic second closed case',$2,'synthetic') RETURNING id",[s.scope.patientId,otherCaseId])).rows[0].id;
 expect(await reopenOrthoCase({...s.scope,orthoCaseId:otherCaseId,clinicalCaseId:otherBridge,command:s.command})).toMatchObject({ok:false,code:'request_key_conflict'});
 const otherActor=await seed();login(otherActor.scope.session);
 expect(await readOrthoReopen({...s.scope,session:otherActor.scope.session,requestId:s.command.clientRequestId})).toMatchObject({ok:true,receipt:null});
 expect(await count(otherCaseId)).toBe(0);
});
