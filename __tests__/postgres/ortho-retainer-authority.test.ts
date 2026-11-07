import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {sessionCredentialVersion,type SessionPayload} from '../../lib/auth';
import {openPeriodontalFixture} from './_periodontal-fixture';
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-retainer-authority-reproduction-20261106');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();});
afterAll(async()=>{vi.useRealTimers();await f?.close();vi.unstubAllEnvs();});
async function setup(role:'admin'|'doctor'='admin'){
 const username=`synthetic-retainer-${randomUUID()}`,password='synthetic-retainer-password';
 const actorId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES($1,'Synthetic retainer actor',$2,$3,$4) RETURNING id",[username,password,role,JSON.stringify({canViewAllPatients:true})])).rows[0].id;
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic retainer patient') RETURNING id",[randomUUID()])).rows[0].id;
 const id=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,start_date,retainer,retainer_on,created_by) VALUES($1,'active','working','2026-01-01','hawley','2026-02-03','synthetic') RETURNING id",[patientId])).rows[0].id;
 const session:SessionPayload={userId:actorId,username,role,partyId:null,expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion(password)};
 return {id,patientId,actorId,session};
}
const state=async(id:number)=>(await f.pool.query('SELECT patient_id,phase,status,retainer,retainer_on::text FROM ortho_cases WHERE id=$1',[id])).rows[0];
const audits=async(id:number)=>(await f.pool.query("SELECT action,details,actor FROM audit_log WHERE action='ortho.retainer_metadata' AND entity='ortho_cases' AND entity_id=$1 ORDER BY id",[id])).rows;
// Exact synthetic authority regression; baseline evidence retained separately.
it.each(['deactivated','role','password','expired','access_lost'] as const)('must not mutate after admitted authority becomes %s',async kind=>{
 const s=await setup(kind==='access_lost'?'doctor':'admin');
 if(kind==='deactivated')await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[s.actorId]);
 if(kind==='role')await f.pool.query("UPDATE users SET role='cashier' WHERE id=$1",[s.actorId]);
 if(kind==='password')await f.pool.query("UPDATE users SET password_hash='changed' WHERE id=$1",[s.actorId]);
 if(kind==='expired')s.session.expiresAt=Date.now()-1;
 if(kind==='access_lost')await f.pool.query("UPDATE users SET permissions='{}' WHERE id=$1",[s.actorId]);
 const input={...s,retainer:'essix' as const,deliveredOn:'2026-04-05'};
 await expect(f.db.setRetainer(input,s)).rejects.toMatchObject({status:kind==='access_lost'?403:401});
 const after=await state(s.id);expect(after.retainer).toBe('hawley');expect(after.retainer_on).toBe('2026-02-03');expect(await audits(s.id)).toEqual([]);
});
it('must bind mutation to the admitted patient rather than just movable case ID',async()=>{
 const s=await setup(),otherPatient=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic moved owner') RETURNING id",[randomUUID()])).rows[0].id;
 await f.pool.query('UPDATE ortho_cases SET patient_id=$2 WHERE id=$1',[s.id,otherPatient]);
 await expect(f.db.setRetainer({id:s.id,retainer:'essix',deliveredOn:null},s)).rejects.toMatchObject({status:409});expect((await state(s.id)).retainer).toBe('hawley');expect(await audits(s.id)).toEqual([]);
});
it('must audit a successful retainer metadata change',async()=>{
 const s=await setup();expect(await f.db.setRetainer({...s,retainer:'essix',deliveredOn:null},s)).toBe(true);expect(await audits(s.id)).toEqual([{action:'ortho.retainer_metadata',actor:s.session.username,details:{patientId:s.patientId,fromRetainer:'hawley',toRetainer:'essix',fromDate:'2026-02-03',toDate:null}}]);
});
it('keeps existing date-preservation and phase/status semantics as a positive control',async()=>{
 const s=await setup();expect(await f.db.setRetainer({...s,retainer:'hawley',deliveredOn:null,preserveExistingDeliveryDate:true},s)).toBe(true);expect(await state(s.id)).toMatchObject({retainer:'hawley',retainer_on:'2026-02-03',phase:'working',status:'active'});expect(await audits(s.id)).toHaveLength(0);
 expect(await f.db.setRetainer({...s,retainer:'essix',deliveredOn:null,preserveExistingDeliveryDate:true},s)).toBe(true);expect(await state(s.id)).toMatchObject({retainer:'essix',retainer_on:null,phase:'working',status:'active'});
 expect(await f.db.setRetainer({...s,retainer:'essix',deliveredOn:'2026-04-05'},s)).toBe(true);expect((await state(s.id)).retainer_on).toBe('2026-04-05');
 expect(await f.db.setRetainer({...s,retainer:'none',deliveredOn:'2026-04-05'},s)).toBe(true);expect(await state(s.id)).toMatchObject({retainer:'none',retainer_on:null,phase:'working',status:'active'});
});
const update=(s:Awaited<ReturnType<typeof setup>>)=>f.db.setRetainer({id:s.id,retainer:'essix',deliveredOn:null},s);
async function waitForLock(blockerPid:number,prefix:string){const until=Date.now()+10000;while(Date.now()<until){const r=await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid))",[prefix,blockerPid]);if(r.rowCount)return;await new Promise(r=>setTimeout(r,15));}throw Error('expected blocker not observed');}
it.each(['scope','closure','expiry'] as const)('rechecks %s after observed case-lock wait',async kind=>{
 const s=await setup(),otherPatient=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic other patient') RETURNING id",[randomUUID()])).rows[0].id,block=await f.pool.connect(),pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;
 await block.query('BEGIN');await block.query('SELECT id FROM ortho_cases WHERE id=$1 FOR UPDATE',[s.id]);const pending=update(s).then(value=>({value}),error=>({error}));
 try{await waitForLock(pid,'SELECT patient_id,status,retainer%');if(kind==='scope')await block.query('UPDATE ortho_cases SET patient_id=$2 WHERE id=$1',[s.id,otherPatient]);if(kind==='closure')await block.query("UPDATE ortho_cases SET status='discontinued' WHERE id=$1",[s.id]);if(kind==='expiry'){vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(s.session.expiresAt+1);}await block.query('COMMIT');if(kind==='closure')expect(await pending).toEqual({value:false});else expect(await pending).toMatchObject({error:{status:kind==='expiry'?401:409}});expect((await state(s.id)).retainer).toBe('hawley');expect(await audits(s.id)).toEqual([]);}
 finally{await block.query('ROLLBACK');block.release();vi.useRealTimers();await pending;}
});
it('rejects revocation winning an observed user-lock race',async()=>{
 const s=await setup(),block=await f.pool.connect(),pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;await block.query('BEGIN');await block.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[s.actorId]);const pending=update(s).then(value=>({value}),error=>({error}));
 try{await waitForLock(pid,'SELECT * FROM users%');await block.query('UPDATE users SET is_active=false WHERE id=$1',[s.actorId]);await block.query('COMMIT');expect(await pending).toMatchObject({error:{status:401}});expect((await state(s.id)).retainer).toBe('hawley');expect(await audits(s.id)).toEqual([]);}
 finally{await block.query('ROLLBACK');block.release();await pending;}
});
it('rolls metadata back if audit fails',async()=>{
 const s=await setup();await f.pool.query("CREATE FUNCTION synthetic_reject_retainer_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.retainer_metadata' THEN RAISE EXCEPTION 'synthetic audit rejection'; END IF; RETURN NEW; END $$");await f.pool.query('CREATE TRIGGER synthetic_reject_retainer_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_reject_retainer_audit()');
 try{await expect(update(s)).rejects.toThrow('synthetic audit rejection');expect(await state(s.id)).toMatchObject({retainer:'hawley',retainer_on:'2026-02-03'});expect(await audits(s.id)).toEqual([]);}finally{await f.pool.query('DROP TRIGGER synthetic_reject_retainer_audit ON audit_log');await f.pool.query('DROP FUNCTION synthetic_reject_retainer_audit()');}
});
it('rejects runtime missing context',async()=>{const s=await setup();await expect(f.db.setRetainer({id:s.id,retainer:'essix',deliveredOn:null},undefined!)).rejects.toMatchObject({status:400});expect((await state(s.id)).retainer).toBe('hawley');});
it('records explicit date removal accurately and no-ops do not duplicate audit',async()=>{const s=await setup();const input={id:s.id,retainer:'hawley' as const,deliveredOn:null};expect(await f.db.setRetainer(input,s)).toBe(true);expect(await f.db.setRetainer(input,s)).toBe(true);expect(await audits(s.id)).toEqual([{action:'ortho.retainer_metadata',actor:s.session.username,details:{patientId:s.patientId,fromRetainer:'hawley',toRetainer:'hawley',fromDate:'2026-02-03',toDate:null}}]);expect(await state(s.id)).toMatchObject({phase:'working',status:'active'});});
it('fails a busy ownership witness closed using NOWAIT',async()=>{
 const s=await setup('doctor'),partyId=(await f.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic retainer doctor') RETURNING id")).rows[0].id;await f.pool.query("UPDATE users SET party_id=$2,permissions='{}' WHERE id=$1",[s.actorId,partyId]);
 const appointment=(await f.pool.query("INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time,status) VALUES($1,$2,'2026-11-06','10:30','booked') RETURNING id",[s.patientId,partyId])).rows[0].id;
 const block=await f.pool.connect();await block.query('BEGIN');await block.query('SELECT id FROM appointments WHERE id=$1 FOR UPDATE',[appointment]);
 try{await expect(update(s)).rejects.toMatchObject({status:409,code:'retainer_authority_busy'});expect((await state(s.id)).retainer).toBe('hawley');expect(await audits(s.id)).toEqual([]);}finally{await block.query('ROLLBACK');block.release();}
});
