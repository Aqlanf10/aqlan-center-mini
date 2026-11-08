import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {sessionCredentialVersion,type SessionPayload} from '../../lib/auth';
import {openPeriodontalFixture} from './_periodontal-fixture';
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>;
let read:typeof import('../../lib/ortho-followup-authority').readAuthorizedOrthoFollowupBoard;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-followup-authority-only-20261106');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();read=(await import('../../lib/ortho-followup-authority')).readAuthorizedOrthoFollowupBoard;});
afterAll(async()=>{await f?.close();vi.unstubAllEnvs();});
async function setup(){
 const username=`synthetic-${randomUUID()}`,password='synthetic-only',partyId=(await f.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic doctor') RETURNING id")).rows[0].id;
 const userId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,party_id,permissions) VALUES($1,'Synthetic',$2,'doctor',$3,'{}') RETURNING id",[username,password,partyId])).rows[0].id;
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'Synthetic visible',$2) RETURNING id",[randomUUID(),partyId])).rows[0].id;
 await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,start_date,created_by) VALUES($1,'active','working','2026-01-01','synthetic')",[patientId]);
 const session:SessionPayload={username,userId,role:'doctor',partyId,expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion(password)};
 return {session,patientId,partyId};
}
const run=(session:SessionPayload)=>read(session,'2026-11-06',new Date('2026-11-06T04:00:00Z'));
async function waitForLock(pid:number,query:string){const until=Date.now()+10000;while(Date.now()<until){if((await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid))",[query,pid])).rowCount)return;await new Promise(r=>setTimeout(r,15));}throw Error('exact blocker not observed');}
it.each(['revoked','credential','party','role','expiry','identity'] as const)('rejects current %s changes',async kind=>{
 const s=await setup();if(kind==='revoked')await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[s.session.userId]);if(kind==='credential')await f.pool.query("UPDATE users SET password_hash='changed' WHERE id=$1",[s.session.userId]);if(kind==='party')await f.pool.query('UPDATE users SET party_id=NULL WHERE id=$1',[s.session.userId]);if(kind==='role')await f.pool.query("UPDATE users SET role='cashier' WHERE id=$1",[s.session.userId]);if(kind==='expiry')s.session.expiresAt=Date.now()-1;if(kind==='identity')s.session.userId+=99999;
 await expect(run(s.session)).rejects.toMatchObject({status:kind==='party'?403:401});
});
it('uses current party and current explicit global grant',async()=>{
 const s=await setup();s.session.partyId=999999;expect((await run(s.session)).map(r=>r.patientId)).toEqual([s.patientId]);await f.pool.query("UPDATE users SET party_id=NULL,permissions='{"+'"canViewAllPatients":true'+"}' WHERE id=$1",[s.session.userId]);expect((await run(s.session)).map(r=>r.patientId)).toContain(s.patientId);await f.pool.query("UPDATE users SET permissions='{}' WHERE id=$1",[s.session.userId]);await expect(run(s.session)).rejects.toMatchObject({status:403});
});
it.each(['admin','reception','assistant','cashier','accountant'] as const)('preserves role %s',async role=>{const s=await setup();await f.pool.query('UPDATE users SET role=$2 WHERE id=$1',[s.session.userId,role]);s.session.role=role;if(role==='admin'||role==='reception')expect((await run(s.session)).map(r=>r.patientId)).toContain(s.patientId);else await expect(run(s.session)).rejects.toHaveProperty('status');});
it.each(['revoked','credential','party','grant'] as const)('account %s winning observed user wait refuses snapshot',async kind=>{
 const s=await setup(),block=await f.pool.connect(),pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;
 await block.query('BEGIN');await block.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[s.session.userId]);const pending=run(s.session).then(value=>({value}),error=>({error}));
 try{await waitForLock(pid,'SELECT * FROM users%');if(kind==='revoked')await block.query('UPDATE users SET is_active=false WHERE id=$1',[s.session.userId]);if(kind==='credential')await block.query("UPDATE users SET password_hash='changed' WHERE id=$1",[s.session.userId]);if(kind==='party')await block.query('UPDATE users SET party_id=NULL WHERE id=$1',[s.session.userId]);if(kind==='grant')await block.query("UPDATE users SET permissions='{"+'"canViewAllPatients":false'+"}' WHERE id=$1",[s.session.userId]);await block.query('COMMIT');expect(await pending).toMatchObject({error:{status:409}});}
 finally{await block.query('ROLLBACK');block.release();await pending;}
});
it.each(['ownership_snapshot','expiry'] as const)('board lock proves %s',async kind=>{
 const s=await setup(),block=await f.pool.connect(),pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;await block.query('BEGIN');await block.query('LOCK TABLE ortho_adjustments IN ACCESS EXCLUSIVE MODE');const pending=run(s.session).then(value=>({value}),error=>({error}));
 try{await waitForLock(pid,'WITH attendance_cutoff%');if(kind==='ownership_snapshot')await f.pool.query("UPDATE patients SET primary_doctor_id=NULL,full_name='Synthetic after snapshot' WHERE id=$1",[s.patientId]);else{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(s.session.expiresAt+1);}await block.query('COMMIT');const outcome=await pending;if(kind==='expiry')expect(outcome).toMatchObject({error:{status:401}});else{expect(outcome).toMatchObject({value:[{patientId:s.patientId,patientName:'Synthetic visible'}]});expect(await run(s.session)).toEqual([]);}}
 finally{await block.query('ROLLBACK');block.release();vi.useRealTimers();await pending;}
});
it('account SHARE keeps later revocation behind already authorized snapshot',async()=>{
 const s=await setup(),block=await f.pool.connect(),writer=await f.pool.connect(),pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;
 await block.query('BEGIN');await block.query('LOCK TABLE ortho_adjustments IN ACCESS EXCLUSIVE MODE');const pending=run(s.session);let revoke:Promise<unknown>|undefined;
 try{await waitForLock(pid,'WITH attendance_cutoff%');const readerPid=(await f.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'WITH attendance_cutoff%' AND wait_event_type='Lock'")).rows[0].pid;revoke=writer.query('UPDATE users SET is_active=false WHERE id=$1',[s.session.userId]);await waitForLock(readerPid,'UPDATE users SET is_active=false%');await block.query('COMMIT');expect((await pending).map(r=>r.patientId)).toEqual([s.patientId]);await revoke;await expect(run(s.session)).rejects.toMatchObject({status:401});}
 finally{await block.query('ROLLBACK');block.release();await pending.catch(()=>{});await revoke;writer.release();}
});
it('grant removed before snapshot restricts the board to currently owned patients',async()=>{
 const s=await setup();await f.pool.query("UPDATE users SET permissions='{"+'"canViewAllPatients":true'+"}' WHERE id=$1",[s.session.userId]);await f.pool.query('UPDATE patients SET primary_doctor_id=NULL WHERE id=$1',[s.patientId]);expect((await run(s.session)).map(r=>r.patientId)).toContain(s.patientId);await f.pool.query("UPDATE users SET permissions='{}' WHERE id=$1",[s.session.userId]);expect(await run(s.session)).toEqual([]);
});
