import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {sessionCredentialVersion,type SessionPayload} from '../../lib/auth';
import {openPeriodontalFixture} from './_periodontal-fixture';
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-adjustment-boundary-only-20261106');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();});
afterAll(async()=>{await f?.close();vi.unstubAllEnvs();});
async function setup(){
 const username=`synthetic-adjustment-${randomUUID()}`,password='synthetic-only-password';
 const actorId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES($1,'Synthetic actor',$2,'doctor',$3) RETURNING id",[username,password,JSON.stringify({canViewAllPatients:true})])).rows[0].id;
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic adjustment patient') RETURNING id",[randomUUID()])).rows[0].id;
 const caseId=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,start_date,created_by) VALUES($1,'active','working','2026-01-01','synthetic') RETURNING id",[patientId])).rows[0].id;
 const session:SessionPayload={userId:actorId,username,role:'doctor',partyId:null,expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion(password)};
 return {actorId,patientId,caseId,session};
}
it('journalled adjustment visit deletion should return explicit refusal, not FK failure',async()=>{
 const s=await setup(); await f.pool.query("UPDATE users SET role='admin' WHERE id=$1",[s.actorId]);s.session.role='admin'; const visit=await f.db.addVisit({patientName:'Synthetic adjustment patient',patientPhone:null,note:null,patientId:s.patientId,doctorId:null});
 const saved=await f.db.recordAdjustment({caseId:s.caseId,visitId:visit.id,doneOn:'2026-11-06',phase:null,upperWire:null,lowerWire:null,elastics:'none',elasticNote:null,done:'Synthetic adjustment',nextWeeks:4,note:null,recordedBy:s.session.username,actorRole:s.session.role,request:{patientId:s.patientId,session:s.session,key:randomUUID()}});expect(saved.ok).toBe(true);
 const result=await f.db.deleteVisit(visit.id,{session:s.session,patientId:s.patientId}).then(value=>({value}),error=>({errorCode:(error as {code:string}).code}));
 const retainedVisit=(await f.pool.query('SELECT id FROM visits WHERE id=$1',[visit.id])).rowCount,links=(await f.pool.query('SELECT visit_id FROM ortho_adjustments WHERE case_id=$1',[s.caseId])).rows;
 console.log(JSON.stringify({scenario:'journalled_visit_delete',result,retainedVisit,links}));expect(retainedVisit).toBe(1);expect(links).toEqual([{visit_id:visit.id}]);expect(result,'deletion must explicitly report a protected clinical reference').toMatchObject({value:{ok:false,reason:'protected_reference'}});
});
it('legacy adjustment detachment and visit deletion must roll back when audit fails',async()=>{
 const s=await setup(); await f.pool.query("UPDATE users SET role='admin' WHERE id=$1",[s.actorId]);s.session.role='admin'; const visit=await f.db.addVisit({patientName:'Synthetic adjustment patient',patientPhone:null,note:null,patientId:s.patientId,doctorId:null});
 const adjustmentId=(await f.pool.query("INSERT INTO ortho_adjustments(case_id,visit_id,done_on,next_weeks,recorded_by) VALUES($1,$2,'2026-11-06',4,'synthetic') RETURNING id",[s.caseId,visit.id])).rows[0].id;
 await f.db.recordToothCondition({patientId:s.patientId,toothCode:16,condition:'caries',stage:'existing',recordedBy:'synthetic',visitId:visit.id});
 await f.pool.query("CREATE FUNCTION synthetic_deny_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='visit.delete' THEN RAISE EXCEPTION 'synthetic audit rejection'; END IF; RETURN NEW; END $$");await f.pool.query('CREATE TRIGGER synthetic_deny_delete_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_deny_delete_audit()');
 try{const result=await f.db.deleteVisit(visit.id,{session:s.session,patientId:s.patientId}).then(value=>({value}),()=>({error:true}));const after=(await f.pool.query('SELECT visit_id FROM ortho_adjustments WHERE id=$1',[adjustmentId])).rows[0];const retainedVisit=(await f.pool.query('SELECT id FROM visits WHERE id=$1',[visit.id])).rowCount;console.log(JSON.stringify({scenario:'audit_failure',result,after,retainedVisit}));expect(retainedVisit,'audit failure must not silently detach clinical history').toBe(1);expect(after.visit_id).toBe(visit.id);expect((await f.pool.query('SELECT visit_id FROM tooth_conditions WHERE patient_id=$1',[s.patientId])).rows).toEqual([{visit_id:visit.id}]);}
 finally{await f.pool.query('DROP TRIGGER synthetic_deny_delete_audit ON audit_log');await f.pool.query('DROP FUNCTION synthetic_deny_delete_audit()');}
});
it('live admin may delete a legacy unsigned visit with atomic audit',async()=>{
 const s=await setup();await f.pool.query("UPDATE users SET role='admin' WHERE id=$1",[s.actorId]);s.session.role='admin';
 const visit=await f.db.addVisit({patientName:'Synthetic',patientPhone:null,note:null,patientId:s.patientId,doctorId:null});
 expect(await f.db.deleteVisit(visit.id,{session:s.session,patientId:s.patientId})).toEqual({ok:true});
 expect((await f.pool.query("SELECT actor FROM audit_log WHERE action='visit.delete' AND entity_id=$1",[visit.id])).rows).toEqual([{actor:s.session.username}]);
});
it.each(['revoked','wrong_role','scope','walk_in'] as const)('delete authority %s',async kind=>{
 const s=await setup();await f.pool.query("UPDATE users SET role='admin' WHERE id=$1",[s.actorId]);s.session.role='admin';
 const visit=await f.db.addVisit({patientName:'Synthetic',patientPhone:null,note:null,patientId:kind==='walk_in'?null:s.patientId,doctorId:null});
 if(kind==='revoked')await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[s.actorId]);
 if(kind==='wrong_role'){await f.pool.query("UPDATE users SET role='doctor' WHERE id=$1",[s.actorId]);s.session.role='doctor';}
 const result=await f.db.deleteVisit(visit.id,{session:s.session,patientId:kind==='walk_in'||kind==='scope'?null:s.patientId});
 expect(result).toEqual(kind==='walk_in'?{ok:true}:{ok:false,reason:kind==='revoked'?'session_expired':kind==='wrong_role'?'forbidden':'scope_changed'});
});
async function waitForLock(pid:number,query:string){const until=Date.now()+10000;while(Date.now()<until){if((await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid))",[query,pid])).rowCount)return;await new Promise(r=>setTimeout(r,15));}throw Error('exact lock blocker not observed');}
it.each(['revocation','expiry','scope'] as const)('delete rechecks %s after observed lock wait',async kind=>{
 const s=await setup();await f.pool.query("UPDATE users SET role='admin' WHERE id=$1",[s.actorId]);s.session.role='admin';const visit=await f.db.addVisit({patientName:'Synthetic',patientPhone:null,note:null,patientId:null,doctorId:null});
 const block=await f.pool.connect(),pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;await block.query('BEGIN');await block.query(kind==='revocation'?'SELECT id FROM users WHERE id=$1 FOR UPDATE':'SELECT id FROM visits WHERE id=$1 FOR UPDATE',[kind==='revocation'?s.actorId:visit.id]);
 const pending=f.db.deleteVisit(visit.id,{session:s.session,patientId:null});
 try{await waitForLock(pid,kind==='revocation'?'SELECT * FROM users%':'SELECT id, patient_id, patient_name%');if(kind==='revocation')await block.query('UPDATE users SET is_active=false WHERE id=$1',[s.actorId]);if(kind==='scope')await block.query('UPDATE visits SET patient_id=$2 WHERE id=$1',[visit.id,s.patientId]);if(kind==='expiry'){vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(s.session.expiresAt+1);}await block.query('COMMIT');expect(await pending).toEqual({ok:false,reason:kind==='scope'?'scope_changed':'session_expired'});expect((await f.pool.query('SELECT id FROM visits WHERE id=$1',[visit.id])).rowCount).toBe(1);expect((await f.pool.query("SELECT id FROM audit_log WHERE action='visit.delete' AND entity_id=$1",[visit.id])).rowCount).toBe(0);}
 finally{await block.query('ROLLBACK');block.release();vi.useRealTimers();await pending;}
});
