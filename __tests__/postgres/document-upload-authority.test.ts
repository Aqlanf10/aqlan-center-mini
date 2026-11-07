import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {sessionCredentialVersion,sessionPermissionVersion,type SessionPayload} from '../../lib/auth';
import {openPeriodontalFixture} from './_periodontal-fixture';
const routeState=vi.hoisted(()=>({session:null as SessionPayload|null,writes:0,onWrite:null as (()=>Promise<void>)|null}));
vi.mock('@/lib/session',async importOriginal=>({...await importOriginal<typeof import('../../lib/session')>(),requireSession:async()=>routeState.session}));
vi.mock('@/lib/files',()=>({storageStatus:async()=>({ready:true}),putFile:async()=>{routeState.writes++;await routeState.onWrite?.();return {key:'synthetic-shared.png',sha256:'a'.repeat(64),sizeBytes:67};}}));
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-document-authority-only');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();});
afterAll(async()=>{vi.useRealTimers();await f?.close();vi.unstubAllEnvs();});
async function setup(role:'admin'|'reception'|'doctor'='admin'){
 const username=`synthetic-document-${randomUUID()}`,password='synthetic-document-password';
 const userId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES($1,'Synthetic document actor',$2,$3,'{}') RETURNING id",[username,password,role])).rows[0].id;
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic document patient') RETURNING id",[randomUUID()])).rows[0].id;
 const session:SessionPayload={userId,username,role,partyId:null,expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion(password)};
 const input={patientId,visitId:null,kind:'photo' as const,title:'Synthetic document',mimeType:'image/png',sizeBytes:67,sha256:'a'.repeat(64),storageKey:'synthetic-existing-shared.png',note:'Synthetic acquisition note',takenOn:'2024-02-29',photoStage:null};
 return {session,input,userId,patientId};
}
const write=(s:Awaited<ReturnType<typeof setup>>)=>f.db.recordAuthorizedDocument(s.input,s.session);
const count=async(patientId:number)=>Number((await f.pool.query('SELECT count(*) FROM patient_documents WHERE patient_id=$1',[patientId])).rows[0].count);
const audits=async(actor:string)=>(await f.pool.query("SELECT actor,actor_role,details FROM audit_log WHERE action='document.upload' AND actor=$1",[actor])).rows;
it.each(['deactivated','credential','role','expired'] as const)('refuses stale admission %s without metadata',async kind=>{
 const s=await setup();if(kind==='deactivated')await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[s.userId]);if(kind==='credential')await f.pool.query("UPDATE users SET password_hash='changed' WHERE id=$1",[s.userId]);if(kind==='role')await f.pool.query("UPDATE users SET role='reception' WHERE id=$1",[s.userId]);if(kind==='expired')s.session.expiresAt=Date.now()-1;
 await expect(write(s)).rejects.toMatchObject({status:401});expect(await count(s.patientId)).toBe(0);expect(await audits(s.session.username)).toEqual([]);
});
it.each(['admin','reception','doctor'] as const)('inserts one atomic upload audit for live %s',async role=>{
 const s=await setup(role);if(role==='doctor')await f.pool.query('UPDATE users SET permissions=$2 WHERE id=$1',[s.userId,JSON.stringify({canViewAllPatients:true,canUploadXrays:true})]);
 await write(s);expect(await count(s.patientId)).toBe(1);expect(await audits(s.session.username)).toEqual([{actor:s.session.username,actor_role:role,details:{المريض:s.patientId,النوع:'photo',الحجم:67}}]);
});
it('refuses doctor upload grant or ownership loss',async()=>{
 const s=await setup('doctor');for(const permissions of [{canViewAllPatients:true,canUploadXrays:false},{canUploadXrays:true,canViewAllPatients:false}]){await f.pool.query('UPDATE users SET permissions=$2 WHERE id=$1',[s.userId,JSON.stringify(permissions)]);await expect(write(s)).rejects.toMatchObject({status:403});}expect(await count(s.patientId)).toBe(0);
});
it('rolls document back if successful audit cannot be inserted',async()=>{
 const s=await setup();await f.pool.query("CREATE FUNCTION synthetic_document_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='document.upload' THEN RAISE EXCEPTION 'synthetic audit fail'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_document_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_document_audit_fail()");
 try{await expect(write(s)).rejects.toThrow('synthetic audit fail');expect(await count(s.patientId)).toBe(0);}finally{await f.pool.query('DROP TRIGGER synthetic_document_audit_fail ON audit_log; DROP FUNCTION synthetic_document_audit_fail()');}
});
async function waitForLock(blockerPid:number,query:string){const deadline=Date.now()+10000;while(Date.now()<deadline){const r=await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid))",[query,blockerPid]);if(r.rowCount)return;await new Promise(r=>setTimeout(r,15));}throw Error(`No observed blocker ${blockerPid}: ${query}`);}
it('rejects revocation winning the observed account lock',async()=>{
 const s=await setup(),block=await f.pool.connect(),pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;await block.query('BEGIN');await block.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[s.userId]);const pending=write(s).then(value=>({value}),error=>({error}));
 try{await waitForLock(pid,'SELECT * FROM users%');await block.query('UPDATE users SET is_active=false WHERE id=$1',[s.userId]);await block.query('COMMIT');expect(await pending).toMatchObject({error:{status:401}});expect(await count(s.patientId)).toBe(0);}finally{await block.query('ROLLBACK');block.release();await pending;}
});
it('rolls metadata and audit back if session expires during observed audit wait',async()=>{
 const s=await setup(),block=await f.pool.connect(),pid=(await block.query('SELECT pg_backend_pid() AS id')).rows[0].id;
 await f.pool.query("CREATE FUNCTION synthetic_document_audit_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='document.upload' THEN PERFORM pg_advisory_xact_lock(961136); END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_document_audit_gate BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_document_audit_gate()");
 await block.query('SELECT pg_advisory_lock(961136)');const pending=write(s).then(value=>({value}),error=>({error}));
 try{await waitForLock(pid,'INSERT INTO audit_log%');vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(s.session.expiresAt+1);await block.query('SELECT pg_advisory_unlock(961136)');expect(await pending).toMatchObject({error:{status:401}});expect(await count(s.patientId)).toBe(0);expect(await audits(s.session.username)).toEqual([]);}finally{await block.query('SELECT pg_advisory_unlock(961136)');await pending;block.release();vi.useRealTimers();await f.pool.query('DROP TRIGGER synthetic_document_audit_gate ON audit_log; DROP FUNCTION synthetic_document_audit_gate()');}
});
it('returns ownership conflict after NOWAIT rollback without releasing protected foreign locks',async()=>{
 const s=await setup('doctor'),partyId=(await f.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic document doctor') RETURNING id")).rows[0].id;
 await f.pool.query('UPDATE users SET party_id=$2,permissions=$3 WHERE id=$1',[s.userId,partyId,JSON.stringify({canUploadXrays:true,canViewAllPatients:false})]);
 const appointment=(await f.pool.query("INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time,status) VALUES($1,$2,'2026-11-06','10:30','booked') RETURNING id",[s.patientId,partyId])).rows[0].id;
 const block=await f.pool.connect();await block.query('BEGIN');await block.query('SELECT id FROM appointments WHERE id=$1 FOR UPDATE',[appointment]);
 try{await expect(write(s)).rejects.toMatchObject({status:409});expect(await count(s.patientId)).toBe(0);expect(await audits(s.session.username)).toEqual([]);await block.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT',[s.userId]);await block.query('SELECT id FROM patients WHERE id=$1 FOR UPDATE NOWAIT',[s.patientId]);}finally{await block.query('ROLLBACK');block.release();}
});
it('uses current actor rather than forged input attribution and denies missing session',async()=>{
 const s=await setup();expect(()=>f.db.recordAuthorizedDocument(s.input,undefined!)).toThrow();
 const doc=await f.db.recordAuthorizedDocument({...s.input,uploadedBy:'forged'} as typeof s.input,s.session);expect(doc.uploadedBy).toBe(s.session.username);
});
it.each(['revocation','grant','expiry'] as const)('actual upload refuses %s after mocked storage without metadata or audit',async kind=>{
 const s=await setup(kind==='grant'?'doctor':'admin');if(kind==='grant')await f.pool.query('UPDATE users SET permissions=$2 WHERE id=$1',[s.userId,JSON.stringify({canViewAllPatients:true,canUploadXrays:true})]);routeState.session=s.session;
 routeState.onWrite=async()=>{if(kind==='revocation')await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[s.userId]);if(kind==='grant')await f.pool.query('UPDATE users SET permissions=$2 WHERE id=$1',[s.userId,JSON.stringify({canViewAllPatients:true,canUploadXrays:false})]);if(kind==='expiry'){vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(s.session.expiresAt+1);}};
 const writes=routeState.writes;const form=new FormData();form.set('file',new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64')],'synthetic.png',{type:'image/png'}));form.set('kind','photo');
 try{const {POST}=await import('../../app/api/patients/[id]/documents/route');const res=await POST(new Request('http://localhost/documents',{method:'POST',body:form}),{params:Promise.resolve({id:String(s.patientId)})});expect(res.status).toBe(kind==='grant'?403:401);expect(routeState.writes).toBe(writes+1);expect(await count(s.patientId)).toBe(0);expect(await audits(s.session.username)).toEqual([]);}finally{routeState.onWrite=null;routeState.session=null;vi.useRealTimers();}
});
it.each(['assistant','cashier','accountant'] as const)('does not broaden upload roles to %s',async role=>{
 const s=await setup();await f.pool.query('UPDATE users SET role=$2 WHERE id=$1',[s.userId,role]);s.session.role=role;if(role!=='assistant')s.session.permissionVersion=sessionPermissionVersion(role,undefined);
 await expect(write(s)).rejects.toMatchObject({status:403});expect(await count(s.patientId)).toBe(0);expect(await audits(s.session.username)).toEqual([]);
});
