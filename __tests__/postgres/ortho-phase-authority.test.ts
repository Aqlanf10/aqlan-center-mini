import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {sessionCredentialVersion,sessionPermissionVersion,type SessionPayload} from '../../lib/auth';
import {openPeriodontalFixture} from './_periodontal-fixture';
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-phase-authority-tests-only-20261106');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();});
afterAll(async()=>{vi.useRealTimers();await f?.close();vi.unstubAllEnvs();});
async function setup(role:'admin'|'doctor'|'reception'='admin'){
 const username=`synthetic-phase-${randomUUID()}`,password='synthetic-phase-password';
 const actorId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES($1,'Synthetic phase actor',$2,$3,'{}') RETURNING id",[username,password,role])).rows[0].id;
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic phase patient') RETURNING id",[randomUUID()])).rows[0].id;
 const id=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,start_date,created_by) VALUES($1,'active','aligning','2026-01-01','synthetic') RETURNING id",[patientId])).rows[0].id;
 const session:SessionPayload={userId:actorId,username,role,partyId:null,expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion(password)};
 return {id,patientId,actorId,session};
}
const state=async(id:number)=>(await f.pool.query('SELECT phase,status FROM ortho_cases WHERE id=$1',[id])).rows[0];
const audits=async(id:number)=>(await f.pool.query("SELECT actor,actor_role,details FROM audit_log WHERE action='ortho.phase' AND entity_id=$1 ORDER BY id",[id])).rows;
it.each(['admin','reception'] as const)('audits valid %s changes once and no-ops without lifecycle changes',async role=>{
 const s=await setup(role);expect(await f.db.setOrthoPhase(s.id,'retention',s)).toBe(true);expect(await f.db.setOrthoPhase(s.id,'retention',s)).toBe(true);
 expect(await state(s.id)).toEqual({phase:'retention',status:'active'});expect(await audits(s.id)).toEqual([{actor:s.session.username,actor_role:role,details:{patientId:s.patientId,fromPhase:'aligning',toPhase:'retention'}}]);
});
it('rejects missing context at runtime without mutating',async()=>{const s=await setup();await expect(f.db.setOrthoPhase(s.id,'working',undefined!)).rejects.toMatchObject({status:400});expect((await state(s.id)).phase).toBe('aligning');expect(await audits(s.id)).toEqual([]);});
it.each(['deactivated','role','password','expired'] as const)('rejects stale admitted account: %s',async kind=>{
 const s=await setup();if(kind==='deactivated')await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[s.actorId]);if(kind==='role')await f.pool.query("UPDATE users SET role='reception' WHERE id=$1",[s.actorId]);if(kind==='password')await f.pool.query("UPDATE users SET password_hash='changed' WHERE id=$1",[s.actorId]);if(kind==='expired')s.session.expiresAt=Date.now()-1;
 await expect(f.db.setOrthoPhase(s.id,'working',s)).rejects.toMatchObject({status:401});expect((await state(s.id)).phase).toBe('aligning');expect(await audits(s.id)).toEqual([]);
});
it('revalidates doctor ownership and permissions from current rows',async()=>{
 const s=await setup('doctor');await f.pool.query('UPDATE users SET permissions=$2 WHERE id=$1',[s.actorId,JSON.stringify({canViewAllPatients:true})]);expect(await f.db.setOrthoPhase(s.id,'working',s)).toBe(true);
 await f.pool.query("UPDATE users SET permissions='{}' WHERE id=$1",[s.actorId]);await expect(f.db.setOrthoPhase(s.id,'finishing',s)).rejects.toMatchObject({status:403});expect((await state(s.id)).phase).toBe('working');expect(await audits(s.id)).toHaveLength(1);
});
async function waitForLock(blockerPid:number,queryPrefix:string){
 const deadline=Date.now()+10000;while(Date.now()<deadline){const r=await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid))",[queryPrefix,blockerPid]);if(r.rowCount)return;await new Promise(r=>setTimeout(r,15));}throw Error(`expected blocking PID not observed: ${blockerPid}`);
}
it.each(['scope','closure','expiry'] as const)('rechecks %s after an observed concurrent case lock',async kind=>{
 const s=await setup(),otherPatient=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic moved scope') RETURNING id",[randomUUID()])).rows[0].id,block=await f.pool.connect();const blockerPid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;await block.query('BEGIN');await block.query('SELECT id FROM ortho_cases WHERE id=$1 FOR UPDATE',[s.id]);
 // Capture rejection immediately to avoid unhandled promises during orchestration.
 const pending=f.db.setOrthoPhase(s.id,'working',s).then(value=>({value}),error=>({error}));
 try{await waitForLock(blockerPid,'SELECT patient_id,status,phase FROM ortho_cases%');if(kind==='scope')await block.query('UPDATE ortho_cases SET patient_id=$2 WHERE id=$1',[s.id,otherPatient]);if(kind==='closure')await block.query("UPDATE ortho_cases SET status='discontinued' WHERE id=$1",[s.id]);if(kind==='expiry'){vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(s.session.expiresAt+1);}await block.query('COMMIT');
 const result=await pending;if(kind==='closure')expect(result).toEqual({value:false});else expect(result).toMatchObject({error:{status:kind==='expiry'?401:409}});expect((await state(s.id)).phase).toBe('aligning');expect(await audits(s.id)).toEqual([]);
 }finally{await block.query('ROLLBACK');block.release();vi.useRealTimers();await pending;}
});
it('rolls phase back if audit insertion fails',async()=>{
 const s=await setup();await f.pool.query("CREATE FUNCTION synthetic_reject_phase_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.phase' THEN RAISE EXCEPTION 'synthetic audit rejection'; END IF; RETURN NEW; END $$");await f.pool.query('CREATE TRIGGER synthetic_reject_phase_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_reject_phase_audit()');
 try{await expect(f.db.setOrthoPhase(s.id,'working',s)).rejects.toThrow('synthetic audit rejection');expect((await state(s.id)).phase).toBe('aligning');expect(await audits(s.id)).toEqual([]);}finally{await f.pool.query('DROP TRIGGER synthetic_reject_phase_audit ON audit_log');await f.pool.query('DROP FUNCTION synthetic_reject_phase_audit()');}
});
it('fails ownership NOWAIT closed without deadlocking opposite row order',async()=>{
 const s=await setup('doctor'),partyId=(await f.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic phase doctor') RETURNING id")).rows[0].id;
 await f.pool.query('UPDATE users SET party_id=$2 WHERE id=$1',[s.actorId,partyId]);
 const appointment=(await f.pool.query("INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time,status) VALUES($1,$2,'2026-11-06','10:30','booked') RETURNING id",[s.patientId,partyId])).rows[0].id;
 const block=await f.pool.connect();await block.query('BEGIN');await block.query('SELECT id FROM appointments WHERE id=$1 FOR UPDATE',[appointment]);
 try{await expect(f.db.setOrthoPhase(s.id,'working',s)).rejects.toMatchObject({status:409,code:'phase_authority_busy'});expect((await state(s.id)).phase).toBe('aligning');expect(await audits(s.id)).toEqual([]);}finally{await block.query('ROLLBACK');block.release();}
});
it('rejects revocation winning an observed user-lock race',async()=>{
 const s=await setup(),block=await f.pool.connect(),blockerPid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;
 await block.query('BEGIN');await block.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[s.actorId]);
 const pending=f.db.setOrthoPhase(s.id,'working',s).then(value=>({value}),error=>({error}));
 try{await waitForLock(blockerPid,'SELECT * FROM users%');await block.query('UPDATE users SET is_active=false WHERE id=$1',[s.actorId]);await block.query('COMMIT');expect(await pending).toMatchObject({error:{status:401}});expect((await state(s.id)).phase).toBe('aligning');expect(await audits(s.id)).toEqual([]);}
 finally{await block.query('ROLLBACK');block.release();await pending;}
});
it.each(['cashier','accountant','assistant'] as const)('preserves explicit CLINIC admission by refusing %s',async role=>{
 const s=await setup();await f.pool.query('UPDATE users SET role=$2 WHERE id=$1',[s.actorId,role]);s.session.role=role;if(role!=='assistant')s.session.permissionVersion=sessionPermissionVersion(role,undefined);
 await expect(f.db.setOrthoPhase(s.id,'working',s)).rejects.toMatchObject({status:403});expect((await state(s.id)).phase).toBe('aligning');expect(await audits(s.id)).toEqual([]);
});
