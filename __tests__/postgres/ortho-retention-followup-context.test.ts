import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createSessionToken,sessionCredentialVersion,type SessionPayload} from '../../lib/auth';
import {openPeriodontalFixture} from './_periodontal-fixture';
import {saveJournaledRetention,transitionRetentionSubmission} from '../../lib/ortho-retention-submission-store';
import {readAuthorizedOrthoFollowupBoard} from '../../lib/ortho-followup-authority';
import {journeyContentHash} from '../../lib/ortho-case-journey-hash';
import {classifyFollowups} from '../../lib/ortho-followup';
import {projectOrthoFollowupWorklist} from '../../lib/ortho-followup-worklist-contract';
import type {RetentionEvent,RetentionDeviceRef} from '../../lib/ortho-retention-events';
import type {RetentionPersistenceCommand} from '../../lib/ortho-retention-command';
const request=vi.hoisted(()=>({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='aqlan_flow_session'?{value:request.token}:undefined}),headers:async()=>new Headers()}));
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-retention-followup-context-only');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();});
afterAll(async()=>{try{await f?.close();}finally{vi.unstubAllEnvs();}});
const occurrence=(occurredOn:string|null)=>({occurredOn,dateProvenance:occurredOn?'historical_source' as const:'unknown' as const,sourceNote:'PRIVATE_HISTORICAL_SOURCE'});
const base={occurrence:occurrence('2026-01-01'),note:'PRIVATE_NOTE',documentIds:[]};
const intent=(device:RetentionDeviceRef,dueOn:string|null='2026-03-01'):RetentionEvent=>({...base,kind:'followup_intent',device,dueOn,intervalDays:dueOn?null:30,scope:'PRIVATE_SCOPE'});
const review=(device:RetentionDeviceRef,date:string|null):RetentionEvent=>({...base,kind:'device_review',device,occurrence:occurrence(date),observations:Object.fromEntries(['fit','breakage','loss','hygiene','adherence','relapse'].map(k=>[k,{state:'unknown',note:'PRIVATE_FINDING'}])) as Extract<RetentionEvent,{kind:'device_review'}>['observations']});
async function setup(withDocument=false){
 const username=randomUUID(),password='synthetic-only';
 const actorId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic',$2,'admin') RETURNING id",[username,password])).rows[0].id;
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic retention followup') RETURNING id",[randomUUID()])).rows[0].id;
 const orthoCaseId=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,start_date,created_by) VALUES($1,'retention','retention','2020-01-01','synthetic') RETURNING id",[patientId])).rows[0].id;
 const clinicalCaseId=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic',$2,'synthetic') RETURNING id",[patientId,orthoCaseId])).rows[0].id;
 let session:SessionPayload={userId:actorId,username,role:'admin',expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion(password)};
 let headId:number|null=null;const deviceHeads=new Map<number,number>();
 const witnesses:RetentionPersistenceCommand['expectedDocuments']=[];
 if(withDocument){const id=(await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'PRIVATE_DOCUMENT','image/png',123,$3,$4,'synthetic') RETURNING id",[patientId,orthoCaseId,'a'.repeat(64),randomUUID()])).rows[0].id;
  witnesses.push({id,patientId,orthoCaseId,sha256:'a'.repeat(64),metadataHash:journeyContentHash({title:'PRIVATE_DOCUMENT',mimeType:'image/png',sizeBytes:123,width:null,height:null})});}
 const ref=(deviceId:number):RetentionDeviceRef=>({deviceId,expectedDeviceRevisionId:deviceHeads.get(deviceId)!});
 async function save(content:RetentionEvent){
  request.token=createSessionToken(session);
  const command:RetentionPersistenceCommand={schemaVersion:2,clientRequestId:randomUUID(),expectedHeadId:headId,reason:'Synthetic',arch:'upper',supersedesEntryId:null,archCorrectionReason:null,content,expectedDocuments:witnesses.filter(w=>content.documentIds.includes(w.id))};
  const input={session,patientId,orthoCaseId,clinicalCaseId,actorId,command};
  const result=await saveJournaledRetention(input);if(!result.ok)throw Error(result.code);
  headId=result.entryId;
  if(content.kind==='device_delivery')deviceHeads.set(result.entryId,result.entryId);
  else if('device' in content&&content.device)deviceHeads.set(content.device.deviceId,result.entryId);
  expect(await transitionRetentionSubmission({...input,commandId:command.clientRequestId,requestFingerprint:journeyContentHash(command),action:'acknowledge'})).toMatchObject({ok:true});
  return result.entryId;
 }
 const deliver=(withSource=false)=>save({...base,documentIds:withSource?witnesses.map(w=>w.id):[],kind:'device_delivery',deviceType:'fixed',description:'PRIVATE_DEVICE',extent:'PRIVATE_EXTENT',labOrderId:null});
 const read=async()=>{const board=await readAuthorizedOrthoFollowupBoard(session,'2026-11-01',new Date('2026-11-01T08:00:00Z'));return {board,row:board.find(r=>r.caseId===orthoCaseId)};};
 async function doctor(canViewImages:boolean){const partyId=(await f.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic') RETURNING id")).rows[0].id;
  await f.pool.query('UPDATE patients SET primary_doctor_id=$2 WHERE id=$1',[patientId,partyId]);
  await f.pool.query("UPDATE users SET role='doctor',party_id=$2,permissions=$3 WHERE id=$1",[actorId,partyId,JSON.stringify({canViewAllPatients:false,canViewXrays:canViewImages})]);
  session={...session,role:'doctor',partyId};return partyId;
 }
 return {patientId,orthoCaseId,clinicalCaseId,actorId,witnesses,ref,save,deliver,read,doctor};
}
it('reads two independent device dates and later/unknown reviews without fulfilling intent, lapsed alerts or writes',async()=>{
 const s=await setup(),a=await s.deliver(),b=await s.deliver();await s.save(intent(s.ref(a)));await s.save(intent(s.ref(b),'2026-04-01'));
 await s.save(review(s.ref(a),'2026-05-01'));await s.save(review(s.ref(b),null));
 const state=async()=>({counts:(await f.pool.query('SELECT (SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM payments)::int payments,(SELECT count(*) FROM appointments)::int appointments,(SELECT count(*) FROM ortho_retention_entries)::int entries,(SELECT count(*) FROM audit_log)::int audits')).rows[0],case:(await f.pool.query('SELECT status,phase,closed_at FROM ortho_cases WHERE id=$1',[s.orthoCaseId])).rows[0]});
 const before=await state(),{row}=await s.read();expect(row).toBeDefined();
 expect(row!.retentionContext).toMatchObject({state:'available',instructionState:'recorded',earliestRecordedDate:'2026-03-01',instructions:[{deviceId:a,resolvedDate:'2026-03-01'},{deviceId:b,resolvedDate:'2026-04-01'}],devices:[{deviceId:a,reviews:[{timing:{occurredOn:'2026-05-01'}}]},{deviceId:b,reviews:[{timing:{occurredOn:null}}]}]});
 expect(JSON.stringify(row)).not.toContain('PRIVATE_');
 expect(classifyFollowups({cases:[row!],today:'2026-11-01'})[0]).toMatchObject({dueDate:null,daysSinceLast:null,dueBasis:'retention_schedule_unavailable',buckets:['no_appointment','retention']});
 const printed=projectOrthoFollowupWorklist([row!],{bucket:'retention',today:'2026-11-01',asOf:new Date('2026-11-01T08:00:00Z'),timeZone:'Asia/Aden',actorId:s.actorId});
 expect(printed.rows[0].retentionContext).toEqual(row!.retentionContext);expect(await state()).toEqual(before);
});
it('does not resolve overlapping intentions or an interval with an unknown anchor',async()=>{
 const s=await setup(),a=await s.deliver();await s.save(intent(s.ref(a)));await s.save({...intent(s.ref(a),null),occurrence:occurrence(null)});
 expect((await s.read()).row?.retentionContext).toMatchObject({state:'available',instructionState:'ambiguous',earliestRecordedDate:null,instructions:[{resolvedDate:null,ambiguityReasons:['overlapping_instructions']},{resolvedDate:null,ambiguityReasons:['interval_anchor_unknown','overlapping_instructions']}]});
});
it('checks sources in the full historical ledger, including older delivery behind a source-free review',async()=>{
 const s=await setup(true),a=await s.deliver(true);await s.save(intent(s.ref(a)));await s.save(review(s.ref(a),'2026-05-01'));
 expect((await s.read()).row?.retentionContext).toMatchObject({state:'available',sourceEvidence:'matched'});
 await f.pool.query("UPDATE patient_documents SET title='Changed synthetic source' WHERE id=$1",[s.witnesses[0].id]);
 expect((await s.read()).row?.retentionContext).toMatchObject({state:'available',sourceEvidence:'mismatch'});
 await f.pool.query('UPDATE patient_documents SET removed_at=NOW() WHERE id=$1',[s.witnesses[0].id]);
 expect((await s.read()).row?.retentionContext).toEqual({state:'unavailable'});
});
it('preserves image permission, ownership filtering and closed-case exclusion',async()=>{
 const foreign=await setup(),s=await setup(true),a=await s.deliver(true);await s.save(intent(s.ref(a)));await s.doctor(false);
 const read=await s.read();expect(read.board.map(r=>r.caseId)).not.toContain(foreign.orthoCaseId);expect(read.row?.retentionContext).toEqual({state:'unavailable'});
 await f.pool.query('UPDATE users SET permissions=$2 WHERE id=$1',[s.actorId,JSON.stringify({canViewAllPatients:false,canViewXrays:true})]);
 expect((await s.read()).row?.retentionContext).toMatchObject({state:'available'});
 await f.pool.query("UPDATE ortho_cases SET status='completed',closed_at=NOW() WHERE id=$1",[s.orthoCaseId]);
 expect((await s.read()).row).toBeUndefined();
});
