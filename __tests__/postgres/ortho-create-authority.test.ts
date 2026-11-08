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
const footprint=async()=> (await f.pool.query(`SELECT
 (SELECT count(*) FROM ortho_cases)::int cases,(SELECT count(*) FROM clinical_cases)::int bridges,
 (SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM payments)::int payments,
 (SELECT count(*) FROM visits)::int visits,(SELECT count(*) FROM ortho_adjustments)::int adjustments,
 (SELECT count(*) FROM audit_log WHERE action='ortho.case_create')::int audits`)).rows;
async function waitForLock(pid:number,pattern:string){const deadline=Date.now()+10000;while(Date.now()<deadline){const r=await f.pool.query("SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, wait_event FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid))",[pattern,pid]);if(r.rowCount){process.stdout.write(`Observed PostgreSQL lock ${JSON.stringify(r.rows)}\n`);return r.rows[0].pid as number;}await new Promise(r=>setTimeout(r,15));}throw Error('Expected exact lock blocker was not observed');}
it.each(['account','access','plan_grant','ownership'] as const)('refuses stale %s after an observed patient lock',async kind=>{
 const s=await setup(kind==='account'?'admin':'doctor');
 let extra:Record<string,unknown>={};
 if(kind==='ownership') { await f.pool.query('UPDATE users SET permissions=$2 WHERE id=$1',[s.actorId,JSON.stringify({})]); await f.pool.query('UPDATE patients SET primary_doctor_id=$2 WHERE id=$1',[s.patientId,s.partyId]); }
 if(kind==='plan_grant'){
  await f.pool.query("INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time,status) VALUES($1,$2,'2026-11-06','10:30','booked')",[s.patientId,s.partyId]);
  const plan=(await f.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'Synthetic plan',0,'synthetic') RETURNING id",[s.patientId])).rows[0].id;
  extra={planId:plan};
 }
 const block=await f.pool.connect(),before=await footprint(),pid=(await block.query('SELECT pg_backend_pid() id')).rows[0].id;
 await block.query('BEGIN');await block.query('SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE',[s.patientId]);const pending=s.send(extra);
 try{await waitForLock(pid,'SELECT id FROM patients%FOR NO KEY UPDATE%');
  if(kind==='account')await block.query('UPDATE users SET is_active=false WHERE id=$1',[s.actorId]);
  else if(kind==='ownership')await block.query('UPDATE patients SET primary_doctor_id=NULL WHERE id=$1',[s.patientId]);
  else await block.query('UPDATE users SET permissions=$2 WHERE id=$1',[s.actorId,JSON.stringify(kind==='access'?{}:{canViewAllPatients:true,canViewPlans:true,canEditPlans:false})]);
  await block.query('COMMIT');expect((await pending).status).toBe(kind==='account'?401:403);expect(await footprint()).toEqual(before);
 }finally{await block.query('ROLLBACK');block.release();await pending;}
});
it.each(['admin','doctor','reception'] as const)('records a current %s create and one audit without invoice/visit/adjustment',async role=>{
 const s=await setup(role),before=(await footprint())[0];
 const response=await s.send({actor:'forged',actorRole:'reception'});expect(response.status).toBe(201);const {id}=await response.json();
 expect((await f.pool.query('SELECT created_by FROM ortho_cases WHERE id=$1',[id])).rows).toEqual([{created_by:s.session.username}]);
 expect((await f.pool.query("SELECT actor,actor_role FROM audit_log WHERE action='ortho.case_create' AND entity_id=$1",[id])).rows).toEqual([{actor:s.session.username,actor_role:role}]);
 const after=(await footprint())[0];expect(after).toEqual({...before,cases:before.cases+1,bridges:before.bridges,audits:before.audits+1});
 expect((await s.send()).status).toBe(409);expect((await footprint())[0]).toEqual(after);
});
it('refuses changed admitted doctor identity rather than assigning either identity',async()=>{
 const s=await setup('doctor'),other=(await f.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic new identity') RETURNING id")).rows[0].id,before=await footprint(),block=await f.pool.connect();
 const pid=(await block.query('SELECT pg_backend_pid() id')).rows[0].id;await block.query('BEGIN');await block.query('SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE',[s.patientId]);const pending=s.send({responsibleDoctorId:null});
 try{await waitForLock(pid,'SELECT id FROM patients%FOR NO KEY UPDATE%');await block.query('UPDATE users SET party_id=$2 WHERE id=$1',[s.actorId,other]);await block.query('COMMIT');expect((await pending).status).toBe(409);expect(await footprint()).toEqual(before);}
 finally{await block.query('ROLLBACK');block.release();await pending;}
});
it('does not equate global clinical visibility with plan ownership',async()=>{
 const s=await setup('doctor'),plan=(await f.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'Synthetic plan',0,'synthetic') RETURNING id",[s.patientId])).rows[0].id,before=await footprint();
 expect((await s.send({planId:plan})).status).toBe(403);expect(await footprint()).toEqual(before);
});
it.each(['plan'] as const)('refuses a busy selected %s witness without new records',async kind=>{
 const s=await setup(),block=await f.pool.connect();let planId:number|null=null;
 if(kind==='plan')planId=(await f.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'Synthetic plan',0,'synthetic') RETURNING id",[s.patientId])).rows[0].id;
 const before=await footprint();await block.query('BEGIN');await block.query(kind==='plan'?'SELECT id FROM treatment_plans WHERE id=$1 FOR NO KEY UPDATE':'SELECT id FROM parties WHERE id=$1 FOR NO KEY UPDATE',[planId??s.partyId]);
 try{expect((await s.send({planId})).status).toBe(409);expect(await footprint()).toEqual(before);}
 finally{await block.query('ROLLBACK');block.release();}
});
it('retains exact same-patient plan validation and allows an authorized plan link',async()=>{
 const s=await setup('doctor');await f.pool.query("INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time,status) VALUES($1,$2,'2026-11-06','10:30','booked')",[s.patientId,s.partyId]);
 const plan=(await f.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'Synthetic plan',0,'synthetic') RETURNING id",[s.patientId])).rows[0];const original=(await f.pool.query('SELECT * FROM treatment_plans WHERE id=$1',[plan.id])).rows;
 expect((await s.send({planId:plan.id})).status).toBe(201);expect((await f.pool.query('SELECT * FROM treatment_plans WHERE id=$1',[plan.id])).rows).toEqual(original);
});
it('rolls create and bridge back on existing audit failure',async()=>{
 const s=await setup(); await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,site,created_by,origin) VALUES($1,'orthodontics','Synthetic shell','both','synthetic','invoice')",[s.patientId]); const shells=(await f.pool.query('SELECT * FROM clinical_cases WHERE patient_id=$1',[s.patientId])).rows, before=await footprint();await f.pool.query("CREATE FUNCTION synthetic_create_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.case_create' THEN RAISE EXCEPTION 'synthetic create audit failure'; END IF; RETURN NEW; END $$");await f.pool.query('CREATE TRIGGER synthetic_create_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_create_fail()');
 try{expect((await s.send()).status).toBe(500);expect(await footprint()).toEqual(before);expect((await f.pool.query('SELECT * FROM clinical_cases WHERE patient_id=$1',[s.patientId])).rows).toEqual(shells);expect((await f.pool.query("SELECT * FROM audit_log WHERE action='ortho.plan_link' AND entity_id=$1",[s.patientId])).rows).toEqual([]);}
 finally{await f.pool.query('DROP TRIGGER synthetic_create_fail ON audit_log');await f.pool.query('DROP FUNCTION synthetic_create_fail()');}
});
it('rolls back after expiry during an observed audit wait',async()=>{
 const s=await setup(),before=await footprint(),block=await f.pool.connect();await f.pool.query("CREATE FUNCTION synthetic_create_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.case_create' THEN PERFORM pg_advisory_xact_lock(765432110); END IF; RETURN NEW; END $$");await f.pool.query('CREATE TRIGGER synthetic_create_wait BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_create_wait()');
 const pid=(await block.query('SELECT pg_backend_pid() id')).rows[0].id;await block.query('BEGIN');await block.query('SELECT pg_advisory_xact_lock(765432110)');const pending=s.send();
 try{await waitForLock(pid,'%INSERT INTO audit_log%');vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(s.session.expiresAt+1);await block.query('COMMIT');expect((await pending).status).toBe(401);expect(await footprint()).toEqual(before);}
 finally{await block.query('ROLLBACK');block.release();vi.useRealTimers();await pending;await f.pool.query('DROP TRIGGER synthetic_create_wait ON audit_log');await f.pool.query('DROP FUNCTION synthetic_create_wait()');}
});

it.each(['cancelled','foreign'] as const)('rejects a selected plan becoming %s under contention',async kind=>{
 const s=await setup(),other=await setup();context.token=createSessionToken(s.session);
 const planId=(await f.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'Synthetic plan',0,'synthetic') RETURNING id",[s.patientId])).rows[0].id;
 const before=await footprint(),block=await f.pool.connect();await block.query('BEGIN');
 await block.query(kind==='cancelled'?"UPDATE treatment_plans SET status='cancelled' WHERE id=$1":"UPDATE treatment_plans SET patient_id=$2 WHERE id=$1",kind==='cancelled'?[planId]:[planId,other.patientId]);
 try{expect((await s.send({planId})).status).toBe(409);await block.query('COMMIT');expect(await footprint()).toEqual(before);expect((await s.send({planId})).status).toBe(409);}
 finally{await block.query('ROLLBACK');block.release();}
});
it('holds the selected plan until successful creation commits',async()=>{
 const s=await setup(),planId=(await f.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'Synthetic plan',0,'synthetic') RETURNING id",[s.patientId])).rows[0].id;
 await f.pool.query("CREATE FUNCTION synthetic_plan_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.case_create' THEN PERFORM pg_advisory_xact_lock(765432111); END IF; RETURN NEW; END $$");await f.pool.query('CREATE TRIGGER synthetic_plan_wait BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_plan_wait()');
 const block=await f.pool.connect(),editor=await f.pool.connect();const pid=(await block.query('SELECT pg_backend_pid() id')).rows[0].id;
 await block.query('BEGIN');await block.query('SELECT pg_advisory_xact_lock(765432111)');const pending=s.send({planId});let edit:ReturnType<typeof editor.query>|undefined;
 try{const writer=await waitForLock(pid,'%INSERT INTO audit_log%');edit=editor.query("UPDATE treatment_plans SET status='cancelled' WHERE id=$1",[planId]);await waitForLock(writer,"UPDATE treatment_plans SET status='cancelled'%");await block.query('COMMIT');expect((await pending).status).toBe(201);await edit;}
 finally{await block.query('ROLLBACK');block.release();await pending;await edit;editor.release();await f.pool.query('DROP TRIGGER synthetic_plan_wait ON audit_log');await f.pool.query('DROP FUNCTION synthetic_plan_wait()');}
});
it('concurrent requests serialize on the patient and create exactly one audited case',async()=>{
 const s=await setup(),block=await f.pool.connect(),before=(await footprint())[0],pid=(await block.query('SELECT pg_backend_pid() id')).rows[0].id;
 await block.query('BEGIN');await block.query('SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE',[s.patientId]);const first=s.send(),second=s.send();
 try{await waitForLock(pid,'SELECT id FROM patients%FOR NO KEY UPDATE%');await block.query('COMMIT');expect((await Promise.all([first,second])).map(r=>r.status).sort()).toEqual([201,409]);expect((await footprint())[0]).toEqual({...before,cases:before.cases+1,audits:before.audits+1});}
 finally{await block.query('ROLLBACK');block.release();await Promise.all([first,second]);}
});
