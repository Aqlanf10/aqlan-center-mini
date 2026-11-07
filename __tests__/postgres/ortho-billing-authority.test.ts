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
it.each(['deactivated','access_lost'] as const)('billing decision must revalidate admitted %s authority',async kind=>{
 const s=await setup(),adjustmentId=(await f.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,next_weeks,recorded_by,billing_class) VALUES($1,'2026-11-06',4,'synthetic','OUTSIDE_CONTRACT') RETURNING id",[s.caseId])).rows[0].id;
 if(kind==='deactivated')await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[s.actorId]);else await f.pool.query("UPDATE users SET permissions='{}' WHERE id=$1",[s.actorId]);
 const input={adjustmentId,decision:'no_charge' as const,reason:'Synthetic research only',invoiceNumber:null,actor:s.session.username,actorRole:s.session.role,request:{patientId:s.patientId,session:s.session}};
 const result=await f.db.decideOrthoAdjustmentBilling(input,input.request),after=(await f.pool.query('SELECT billing_decision FROM ortho_adjustments WHERE id=$1',[adjustmentId])).rows[0];
 console.log(JSON.stringify({scenario:kind,result,after}));expect(result.ok,'stale authority must not change an adjustment decision').toBe(false);expect(after.billing_decision).toBeNull();
});
it('valid current doctor records decision and authoritative audit',async()=>{
 const s=await setup(), adjustmentId=(await f.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,next_weeks,recorded_by,billing_class) VALUES($1,'2026-11-06',4,'synthetic','OUTSIDE_CONTRACT') RETURNING id",[s.caseId])).rows[0].id;
 expect(await f.db.decideOrthoAdjustmentBilling({adjustmentId,decision:'no_charge',reason:'Synthetic valid reason',invoiceNumber:null,actor:'spoof',actorRole:'admin'},{patientId:s.patientId,session:s.session})).toEqual({ok:true,decision:'no_charge'});
 expect((await f.pool.query("SELECT actor FROM audit_log WHERE action='ortho.billing_decision' AND entity_id=$1",[adjustmentId])).rows).toEqual([{actor:s.session.username}]);
});
it.each(['role','scope','expired','missing'] as const)('billing rejects %s without mutation',async kind=>{
 const s=await setup(), adjustmentId=(await f.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,next_weeks,recorded_by,billing_class) VALUES($1,'2026-11-06',4,'synthetic','OUTSIDE_CONTRACT') RETURNING id",[s.caseId])).rows[0].id;
 if(kind==='role'){await f.pool.query("UPDATE users SET role='reception' WHERE id=$1",[s.actorId]);s.session.role='reception';}
 if(kind==='expired')s.session.expiresAt=Date.now()-1;
 const result=await f.db.decideOrthoAdjustmentBilling({adjustmentId,decision:'no_charge',reason:'Synthetic test reason',invoiceNumber:null,actor:s.session.username,actorRole:s.session.role},kind==='missing'?undefined as never:{patientId:kind==='scope'?s.patientId+999:s.patientId,session:s.session});
 expect(result).toMatchObject({ok:false,status:kind==='role'?403:kind==='scope'?409:kind==='expired'?401:400});
 expect((await f.pool.query('SELECT billing_decision FROM ortho_adjustments WHERE id=$1',[adjustmentId])).rows[0].billing_decision).toBeNull();
});
it('audit failure rolls billing decision back',async()=>{
 const s=await setup(), adjustmentId=(await f.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,next_weeks,recorded_by,billing_class) VALUES($1,'2026-11-06',4,'synthetic','OUTSIDE_CONTRACT') RETURNING id",[s.caseId])).rows[0].id;
 await f.pool.query("CREATE FUNCTION synthetic_deny_billing_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.billing_decision' THEN RAISE EXCEPTION 'synthetic audit rejection'; END IF; RETURN NEW; END $$");await f.pool.query('CREATE TRIGGER synthetic_deny_billing_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_deny_billing_audit()');
 try{await expect(f.db.decideOrthoAdjustmentBilling({adjustmentId,decision:'no_charge',reason:'Synthetic reason',invoiceNumber:null,actor:s.session.username,actorRole:s.session.role},{patientId:s.patientId,session:s.session})).rejects.toThrow('synthetic audit rejection');expect((await f.pool.query('SELECT billing_decision FROM ortho_adjustments WHERE id=$1',[adjustmentId])).rows[0].billing_decision).toBeNull();}
 finally{await f.pool.query('DROP TRIGGER synthetic_deny_billing_audit ON audit_log');await f.pool.query('DROP FUNCTION synthetic_deny_billing_audit()');}
});
async function waitForLock(pid:number,query:string){const until=Date.now()+10000;while(Date.now()<until){if((await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid))",[query,pid])).rowCount)return;await new Promise(r=>setTimeout(r,15));}throw Error('exact lock blocker not observed');}
it.each(['revocation','expiry','scope'] as const)('rechecks %s after observed lock wait',async kind=>{
 const s=await setup(),adjustmentId=(await f.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,next_weeks,recorded_by,billing_class) VALUES($1,'2026-11-06',4,'synthetic','OUTSIDE_CONTRACT') RETURNING id",[s.caseId])).rows[0].id;
 const other=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic other') RETURNING id",[randomUUID()])).rows[0].id;
 const block=await f.pool.connect(),pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;await block.query('BEGIN');await block.query(kind==='revocation'?'SELECT id FROM users WHERE id=$1 FOR UPDATE':'SELECT id FROM ortho_cases WHERE id=$1 FOR UPDATE',[kind==='revocation'?s.actorId:s.caseId]);
 const pending=f.db.decideOrthoAdjustmentBilling({adjustmentId,decision:'no_charge',reason:'Synthetic reason',invoiceNumber:null,actor:s.session.username,actorRole:s.session.role},{patientId:s.patientId,session:s.session});
 try{await waitForLock(pid,kind==='revocation'?'SELECT * FROM users%':'SELECT c.id,c.patient_id%');if(kind==='revocation')await block.query('UPDATE users SET is_active=false WHERE id=$1',[s.actorId]);if(kind==='scope')await block.query('UPDATE ortho_cases SET patient_id=$2 WHERE id=$1',[s.caseId,other]);if(kind==='expiry'){vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(s.session.expiresAt+1);}await block.query('COMMIT');expect(await pending).toMatchObject({ok:false,status:kind==='scope'?409:401});expect((await f.pool.query('SELECT billing_decision FROM ortho_adjustments WHERE id=$1',[adjustmentId])).rows[0].billing_decision).toBeNull();}
 finally{await block.query('ROLLBACK');block.release();vi.useRealTimers();await pending;}
});
it.each(['valid','cancelled','foreign'] as const)('reception invoice link %s preserves amounts',async kind=>{
 const s=await setup();await f.pool.query("UPDATE users SET role='reception' WHERE id=$1",[s.actorId]);s.session.role='reception';
 const adjustmentId=(await f.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,next_weeks,recorded_by,billing_class) VALUES($1,'2026-11-06',4,'synthetic','OUTSIDE_CONTRACT') RETURNING id",[s.caseId])).rows[0].id;
 const other=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic other') RETURNING id",[randomUUID()])).rows[0].id,invoiceNumber=randomUUID();
 await f.pool.query("INSERT INTO invoices(invoice_number,patient_id,base_currency,total_minor,discount_minor,created_by,status) VALUES($1,$2,'YER',10000,0,'synthetic',$3)",[invoiceNumber,kind==='foreign'?other:s.patientId,kind==='cancelled'?'cancelled':'issued']);
 const result=await f.db.decideOrthoAdjustmentBilling({adjustmentId,decision:'billed',reason:null,invoiceNumber,actor:'spoof',actorRole:'doctor'},{patientId:s.patientId,session:s.session});
 expect(result).toMatchObject(kind==='valid'?{ok:true,decision:'billed'}:{ok:false,status:409});expect((await f.pool.query('SELECT total_minor FROM invoices WHERE invoice_number=$1',[invoiceNumber])).rows[0].total_minor).toBe('10000');
});
it('current responsible doctor retains decision access without normal patient access',async()=>{
 const s=await setup(),partyId=(await f.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic responsible') RETURNING id")).rows[0].id;
 await f.pool.query("UPDATE users SET party_id=$2,permissions='{}' WHERE id=$1",[s.actorId,partyId]);s.session.partyId=partyId;await f.pool.query('UPDATE ortho_cases SET responsible_doctor_id=$2 WHERE id=$1',[s.caseId,partyId]);
 const adjustmentId=(await f.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,next_weeks,recorded_by,billing_class) VALUES($1,'2026-11-06',4,'synthetic','OUTSIDE_CONTRACT') RETURNING id",[s.caseId])).rows[0].id;
 expect(await f.db.decideOrthoAdjustmentBilling({adjustmentId,decision:'no_charge',reason:'Synthetic reason',invoiceNumber:null,actor:'spoof',actorRole:'admin'},{patientId:s.patientId,session:s.session})).toEqual({ok:true,decision:'no_charge'});
});
it('responsible-doctor removal winning case lock prevents decision',async()=>{
 const s=await setup(),partyId=(await f.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic responsible race') RETURNING id")).rows[0].id;
 await f.pool.query("UPDATE users SET party_id=$2,permissions='{}' WHERE id=$1",[s.actorId,partyId]);s.session.partyId=partyId;await f.pool.query('UPDATE ortho_cases SET responsible_doctor_id=$2 WHERE id=$1',[s.caseId,partyId]);
 const adjustmentId=(await f.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,next_weeks,recorded_by,billing_class) VALUES($1,'2026-11-06',4,'synthetic','OUTSIDE_CONTRACT') RETURNING id",[s.caseId])).rows[0].id;
 const block=await f.pool.connect(),pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;await block.query('BEGIN');await block.query('SELECT id FROM ortho_cases WHERE id=$1 FOR UPDATE',[s.caseId]);
 const pending=f.db.decideOrthoAdjustmentBilling({adjustmentId,decision:'no_charge',reason:'Synthetic reason',invoiceNumber:null,actor:s.session.username,actorRole:s.session.role},{patientId:s.patientId,session:s.session});
 try{await waitForLock(pid,'SELECT c.id,c.patient_id%');await block.query('UPDATE ortho_cases SET responsible_doctor_id=NULL WHERE id=$1',[s.caseId]);await block.query('COMMIT');expect(await pending).toMatchObject({ok:false,status:403});expect((await f.pool.query('SELECT billing_decision FROM ortho_adjustments WHERE id=$1',[adjustmentId])).rows[0].billing_decision).toBeNull();}
 finally{await block.query('ROLLBACK');block.release();await pending;}
});
it('cancellation winning patient lock is rechecked before invoice linking',async()=>{
 const s=await setup();await f.pool.query("UPDATE users SET role='reception' WHERE id=$1",[s.actorId]);s.session.role='reception';
 const adjustmentId=(await f.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,next_weeks,recorded_by,billing_class) VALUES($1,'2026-11-06',4,'synthetic','OUTSIDE_CONTRACT') RETURNING id",[s.caseId])).rows[0].id,invoiceNumber=randomUUID();
 await f.pool.query("INSERT INTO invoices(invoice_number,patient_id,base_currency,total_minor,discount_minor,created_by) VALUES($1,$2,'YER',10000,0,'synthetic')",[invoiceNumber,s.patientId]);
 const block=await f.pool.connect(),pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;await block.query('BEGIN');await block.query('SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE',[s.patientId]);
 const pending=f.db.decideOrthoAdjustmentBilling({adjustmentId,decision:'billed',reason:null,invoiceNumber,actor:s.session.username,actorRole:s.session.role},{patientId:s.patientId,session:s.session});
 try{await waitForLock(pid,'SELECT id FROM patients%');await block.query("UPDATE invoices SET status='cancelled' WHERE invoice_number=$1",[invoiceNumber]);await block.query('COMMIT');expect(await pending).toMatchObject({ok:false,status:409});expect((await f.pool.query('SELECT billing_decision FROM ortho_adjustments WHERE id=$1',[adjustmentId])).rows[0].billing_decision).toBeNull();}
 finally{await block.query('ROLLBACK');block.release();await pending;}
});
