// Real PostgreSQL server-route fixture, outside Next's server-module resolver.
// Only the framework marker is stubbed; transactional authority and storage stay real.
vi.mock("server-only", () => ({}));

import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { openPeriodontalFixture } from './_periodontal-fixture';
const context = vi.hoisted(() => ({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='aqlan_flow_session'?{value:context.token}:undefined}),headers:async()=>new Headers()}));
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>, PATCH:typeof import('../../app/api/ortho/[id]/route').PATCH;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-close-authority-tests-only-20261106');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();({PATCH}=await import('../../app/api/ortho/[id]/route'));});
afterAll(async()=>{vi.useRealTimers();await f?.close();vi.unstubAllEnvs();});
async function setup(role:'admin'|'doctor'|'reception'='admin'){
 const username=`synthetic-close-${randomUUID()}`,password='synthetic-close-password';
 const actorId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES($1,'Synthetic close actor',$2,$3,$4) RETURNING id",[username,password,role,JSON.stringify({canViewAllPatients:true})])).rows[0].id;
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic close patient') RETURNING id",[randomUUID()])).rows[0].id;
 const id=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,start_date,created_by,retainer,retainer_on) VALUES($1,'retention','retention','2026-01-01','synthetic','hawley','2026-10-01') RETURNING id",[patientId])).rows[0].id;
 const session:SessionPayload={userId:actorId,username,role,partyId:null,expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion(password)};
 context.token=createSessionToken(session);
 const send=(status='completed')=>PATCH(new Request(`https://synthetic.invalid/api/ortho/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status,actor:'forged',note:'Synthetic closure'})}),{params:Promise.resolve({id:String(id)})});
 return {id,patientId,actorId,session,send};
}
const state=async(id:number)=>(await f.pool.query('SELECT * FROM ortho_cases WHERE id=$1',[id])).rows[0];
const audits=async(id:number)=>(await f.pool.query("SELECT actor,actor_role,details FROM audit_log WHERE action='ortho.close' AND entity_id=$1 ORDER BY id",[id])).rows;
async function waitForLock(blockerPid:number,queryPattern:string){
 const deadline=Date.now()+10000;while(Date.now()<deadline){const r=await f.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid))",[queryPattern,blockerPid]);if(r.rowCount)return r.rows[0].pid as number;await new Promise(r=>setTimeout(r,15));}throw Error(`expected blocking PID not observed: ${blockerPid}`);
}
it.each(['account','ownership','scope'] as const)('refuses stale %s after observed patient lock wait',async kind=>{
 const s=await setup(kind==='ownership'?'doctor':'admin'),before=await state(s.id),block=await f.pool.connect();
 const otherPatient=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic other patient') RETURNING id",[randomUUID()])).rows[0].id;
 const pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;
 await block.query('BEGIN');await block.query('SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE',[s.patientId]);
 const pending=s.send();
 try{
  await waitForLock(pid,'SELECT id FROM patients%FOR NO KEY UPDATE%');
  if(kind==='account')await block.query('UPDATE users SET is_active=false WHERE id=$1',[s.actorId]);
  if(kind==='ownership')await block.query("UPDATE users SET permissions='{}' WHERE id=$1",[s.actorId]);
  if(kind==='scope')await block.query('UPDATE ortho_cases SET patient_id=$2 WHERE id=$1',[s.id,otherPatient]);
  await block.query('COMMIT');const response=await pending;
  expect(response.status).toBe(kind==='account'?401:kind==='ownership'?403:409);
  expect(await state(s.id)).toEqual({...before,patient_id:kind==='scope'?otherPatient:s.patientId});expect(await audits(s.id)).toEqual([]);
 }finally{await block.query('ROLLBACK');block.release();await pending;}
});
it.each(['admin','doctor','reception'] as const)('closes for current %s with one atomic audit and unchanged retainer/finance',async role=>{
 const s=await setup(role),before=await state(s.id);
 const money=async()=>(await f.pool.query('SELECT (SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM payments)::int payments')).rows;
 const moneyBefore=await money();
 expect((await s.send()).status).toBe(200);
 expect(await state(s.id)).toMatchObject({status:'completed',closed_by:s.session.username,retainer:before.retainer,retainer_on:before.retainer_on});
 expect(await audits(s.id)).toEqual([{actor:s.session.username,actor_role:role,details:{patientId:s.patientId,fromStatus:'retention',toStatus:'completed'}}]);
 expect(await money()).toEqual(moneyBefore);
 expect((await s.send()).status).toBe(409);expect(await audits(s.id)).toHaveLength(1);
});
it('preserves completion guard and permits discontinuation without retainer',async()=>{
 const s=await setup();await f.pool.query("UPDATE ortho_cases SET retainer=NULL,retainer_on=NULL WHERE id=$1",[s.id]);const before=await state(s.id);
 expect((await s.send()).status).toBe(409);expect(await state(s.id)).toEqual(before);expect(await audits(s.id)).toEqual([]);
 expect((await s.send('discontinued')).status).toBe(200);expect((await state(s.id)).status).toBe('discontinued');
});
it('preserves trusted internal no-context closure compatibility',async()=>{
 const s=await setup();expect(await f.db.closeOrthoCase({id:s.id,status:'completed',actor:'trusted-internal',note:null})).toEqual({ok:true});
 expect((await state(s.id)).closed_by).toBe('trusted-internal');expect(await audits(s.id)).toEqual([]);
});
it('rolls closure back if its audit fails',async()=>{
 const s=await setup(),before=await state(s.id);
 await f.pool.query("CREATE FUNCTION synthetic_close_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.close' THEN RAISE EXCEPTION 'synthetic close audit failure'; END IF; RETURN NEW; END $$");
 await f.pool.query('CREATE TRIGGER synthetic_close_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_close_audit_fail()');
 try{expect((await s.send()).status).toBe(500);expect(await state(s.id)).toEqual(before);expect(await audits(s.id)).toEqual([]);}
 finally{await f.pool.query('DROP TRIGGER synthetic_close_audit_fail ON audit_log');await f.pool.query('DROP FUNCTION synthetic_close_audit_fail()');}
});
it('rolls closure and audit back when expiry passes during an observed audit wait',async()=>{
 const s=await setup(),before=await state(s.id),block=await f.pool.connect();
 await f.pool.query("CREATE FUNCTION synthetic_close_audit_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.close' THEN PERFORM pg_advisory_xact_lock(765432109); END IF; RETURN NEW; END $$");
 await f.pool.query('CREATE TRIGGER synthetic_close_audit_wait BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_close_audit_wait()');
 await block.query('BEGIN');await block.query('SELECT pg_advisory_xact_lock(765432109)');const pid=(await block.query('SELECT pg_backend_pid() id')).rows[0].id;
 const pending=s.send();
 try{await waitForLock(pid,'%INSERT INTO audit_log%');vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(s.session.expiresAt+1);await block.query('COMMIT');expect((await pending).status).toBe(401);expect(await state(s.id)).toEqual(before);expect(await audits(s.id)).toEqual([]);}
 finally{await block.query('ROLLBACK');block.release();vi.useRealTimers();await pending;await f.pool.query('DROP TRIGGER synthetic_close_audit_wait ON audit_log');await f.pool.query('DROP FUNCTION synthetic_close_audit_wait()');}
});
it('refuses ownership witnesses busy in opposite lock order',async()=>{
 const s=await setup('doctor'),party=(await f.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic closure owner') RETURNING id")).rows[0].id;
 await f.pool.query("UPDATE users SET permissions='{}',party_id=$2 WHERE id=$1",[s.actorId,party]);
 const appointment=(await f.pool.query("INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time,status) VALUES($1,$2,'2026-11-06','10:30','booked') RETURNING id",[s.patientId,party])).rows[0].id;
 const before=await state(s.id),block=await f.pool.connect();await block.query('BEGIN');await block.query('SELECT id FROM appointments WHERE id=$1 FOR UPDATE',[appointment]);
 try{expect((await s.send()).status).toBe(409);expect(await state(s.id)).toEqual(before);expect(await audits(s.id)).toEqual([]);}
 finally{await block.query('ROLLBACK');block.release();}
});
