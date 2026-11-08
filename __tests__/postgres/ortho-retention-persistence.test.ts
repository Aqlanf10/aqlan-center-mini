import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
import {createSessionToken,sessionCredentialVersion,type SessionPayload} from '../../lib/auth';
import {openPeriodontalFixture} from './_periodontal-fixture';
import {reserveRetentionSubmission,saveJournaledRetention,getRetentionSubmissionRecovery,transitionRetentionSubmission} from '../../lib/ortho-retention-submission-store';
import {getOrthoRetentionEvents} from '../../lib/ortho-retention-event-store';
import {journeyContentHash} from '../../lib/ortho-case-journey-hash';
import type {RetentionPersistenceCommand} from '../../lib/ortho-retention-command';
const request=vi.hoisted(()=>({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='aqlan_flow_session'?{value:request.token}:undefined}),headers:async()=>new Headers()}));
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async()=>{vi.stubEnv('SESSION_SECRET','synthetic-retention-secret-at-least-32-characters');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();});
afterAll(async()=>{try{await f?.close();}finally{vi.unstubAllEnvs();}});
async function setup(withDocument=false){
 const key=randomUUID(),password='Synthetic credential';
 const patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic retention patient') RETURNING id",[key])).rows[0].id;
 const actorId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic doctor',$2,'admin') RETURNING id",[key,password])).rows[0].id;
 const session:SessionPayload={userId:actorId,username:key,role:'admin',credentialVersion:sessionCredentialVersion(password),expiresAt:Date.now()+600000};request.token=createSessionToken(session);
 const orthoCaseId=(await f.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'active','synthetic') RETURNING id",[patientId])).rows[0].id;
 const clinicalCaseId=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id",[patientId,orthoCaseId])).rows[0].id;
 const command:RetentionPersistenceCommand={schemaVersion:2,clientRequestId:randomUUID(),expectedHeadId:null,reason:'Synthetic documented delivery',arch:'upper',supersedesEntryId:null,archCorrectionReason:null,expectedDocuments:[],content:{kind:'device_delivery',occurrence:{occurredOn:null,dateProvenance:'unknown',sourceNote:''},note:'Synthetic documentary only',documentIds:[],deviceType:'removable',description:'Synthetic device',extent:'Synthetic upper',labOrderId:null}};
 let documentId:number|null=null;
 if(withDocument){documentId=(await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'Synthetic witness','image/png',123,$3,$4,'synthetic') RETURNING id",[patientId,orthoCaseId,'a'.repeat(64),randomUUID()])).rows[0].id;
 command.content.documentIds=[documentId!];command.expectedDocuments=[{id:documentId!,patientId,orthoCaseId,sha256:'a'.repeat(64),metadataHash:journeyContentHash({title:'Synthetic witness',mimeType:'image/png',sizeBytes:123,width:null,height:null})}];}
 return {patientId,orthoCaseId,clinicalCaseId,actorId,session,command,documentId};
}
type Setup=Awaited<ReturnType<typeof setup>>;
const transition=(s:Setup,action:'cancel'|'acknowledge')=>transitionRetentionSubmission({...s,action,commandId:s.command.clientRequestId,requestFingerprint:journeyContentHash(s.command)});
it('separately reserves; reloads; concurrent retries settle exactly once; acknowledges and replays',async()=>{
 const s=await setup(true);expect(await reserveRetentionSubmission(s)).toMatchObject({ok:true});
 expect((await f.pool.query('SELECT id FROM ortho_retention_entries WHERE ortho_case_id=$1',[s.orthoCaseId])).rows).toEqual([]);
 expect(await getRetentionSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'pending',expected:{command:s.command}}});
 const [a,b]=await Promise.all([saveJournaledRetention(s),saveJournaledRetention(s)]);expect(a.ok&&b.ok).toBe(true);if(!a.ok||!b.ok)throw Error(JSON.stringify([a,b]));expect(a.entryId).toBe(b.entryId);
 expect(await getRetentionSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'committed'}});
 expect(await transition(s,'acknowledge')).toMatchObject({ok:true,acknowledged:true});
 expect(await saveJournaledRetention(s)).toMatchObject({ok:true,replayed:true,entryId:a.entryId});
 expect(await getOrthoRetentionEvents(s)).toMatchObject({ok:true,sourceMatches:[{identityMatch:true}]});
 expect((await f.pool.query("SELECT count(*)::int n FROM audit_log WHERE action='ortho.journey_record' AND entity='ortho_retention_entries' AND entity_id=$1",[a.entryId])).rows[0].n).toBe(1);
});
it('cancel-before-arrival remains a tombstone after acknowledgement',async()=>{
 const s=await setup();expect(await transition(s,'cancel')).toMatchObject({ok:true,state:'cancelled'});expect(await transition(s,'acknowledge')).toMatchObject({ok:true,acknowledged:true});expect(await saveJournaledRetention(s)).toMatchObject({ok:false,code:'retention_submission_cancelled'});
});
it('binds actor, scope and exact command',async()=>{
 const s=await setup();await reserveRetentionSubmission(s);
 expect(await saveJournaledRetention({...s,actorId:s.actorId+999})).toMatchObject({ok:false,code:'retention_submission_actor_changed'});
 expect(await saveJournaledRetention({...s,clinicalCaseId:s.clinicalCaseId+999})).toMatchObject({ok:false,code:'retention_submission_context_changed'});
 expect(await saveJournaledRetention({...s,command:{...s.command,reason:'Changed intent'}})).toMatchObject({ok:false,code:'request_key_conflict'});
});
it.each(['sha256','title'])('pins source %s at execution but preserves historical capture with explicit mismatch',async(field)=>{
 const s=await setup(true);expect(await reserveRetentionSubmission(s)).toMatchObject({ok:true});
 await f.pool.query(`UPDATE patient_documents SET ${field}=$2 WHERE id=$1`,[s.documentId,field==='sha256'?'b'.repeat(64):'Changed title']);
 expect(await saveJournaledRetention(s)).toMatchObject({ok:false,code:'retention_document_changed'});
 expect(await getRetentionSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'blocked',canCancel:true}});
 const other=await setup(true);expect(await saveJournaledRetention(other)).toMatchObject({ok:true});
 await f.pool.query(`UPDATE patient_documents SET ${field}=$2 WHERE id=$1`,[other.documentId,field==='sha256'?'b'.repeat(64):'Changed title']);
 expect(await getOrthoRetentionEvents(other)).toMatchObject({ok:true,sourceMatches:[{identityMatch:false}]});
 expect(await getRetentionSubmissionRecovery(other)).toMatchObject({ok:true,recovery:{state:'committed'}});
});
it('revoked image access and removed source withhold all history/recovery payloads',async()=>{
 const s=await setup(true);await saveJournaledRetention(s);await f.pool.query('UPDATE patient_documents SET removed_at=NOW() WHERE id=$1',[s.documentId]);
 expect(await getOrthoRetentionEvents(s)).toMatchObject({ok:false,status:403});expect(await getRetentionSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'blocked',identity:null}});
 const other=await setup(true);await reserveRetentionSubmission(other);await f.pool.query("UPDATE users SET role='doctor',permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewXrays:false}),other.actorId]);other.session={...other.session,role:'doctor'};request.token=createSessionToken(other.session);
 expect(await saveJournaledRetention(other)).toMatchObject({ok:false,status:403});expect(await getRetentionSubmissionRecovery(other)).toMatchObject({ok:true,recovery:{state:'blocked'}});
});
it('read recovery does not require editing plans or writing role, rejects assessment writes, captures closed cases retrospectively',async()=>{
 const s=await setup();await reserveRetentionSubmission(s);
 await f.pool.query("UPDATE users SET role='reception',permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canEditPlans:false}),s.actorId]);s.session={...s.session,role:'reception'};request.token=createSessionToken(s.session);
 expect(await getRetentionSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'pending'}});expect(await saveJournaledRetention(s)).toMatchObject({ok:false,status:403});
 const other=await setup();await f.pool.query("UPDATE ortho_cases SET status='assessment',phase='assessment',appliance=NULL,arches=NULL,slot=NULL,start_date=NULL,planned_months=NULL,bracket_system=NULL,upper_wire=NULL,lower_wire=NULL,retainer=NULL,retainer_on=NULL WHERE id=$1",[other.orthoCaseId]);expect(await reserveRetentionSubmission(other)).toMatchObject({ok:false,code:'retention_case_not_treatment'});
 const closed=await setup();await f.pool.query("UPDATE ortho_cases SET status='completed' WHERE id=$1",[closed.orthoCaseId]);expect(await saveJournaledRetention(closed)).toMatchObject({ok:true,revision:{recordingContext:'retrospective',caseStatusAtCapture:'completed'}});
});
it('validates full correction/device lineage, not just the newest source-free head',async()=>{
 const s=await setup(true),saved=await saveJournaledRetention(s);expect(saved.ok).toBe(true);if(!saved.ok)throw Error(saved.code);await transition(s,'acknowledge');
 const repair:Setup={...s,command:{...s.command,clientRequestId:randomUUID(),expectedHeadId:saved.entryId,reason:'Synthetic repair',expectedDocuments:[],content:{kind:'device_repair',occurrence:{occurredOn:null,dateProvenance:'unknown',sourceNote:''},note:'',documentIds:[],description:'Synthetic repair',device:{deviceId:saved.entryId,expectedDeviceRevisionId:saved.entryId}}}};
 const repaired=await saveJournaledRetention(repair);expect(repaired.ok).toBe(true);if(!repaired.ok)throw Error(repaired.code);await transition(repair,'acknowledge');
 const stale={...repair,command:{...repair.command,clientRequestId:randomUUID(),expectedHeadId:repaired.entryId}};
 expect(await reserveRetentionSubmission(stale)).toMatchObject({ok:false,code:'device_reference_changed'});
 const correction:Setup={...repair,command:{...repair.command,clientRequestId:randomUUID(),expectedHeadId:repaired.entryId,supersedesEntryId:repaired.entryId,content:{...repair.command.content,kind:'device_repair',description:'Synthetic corrected repair',device:{deviceId:saved.entryId,expectedDeviceRevisionId:repaired.entryId}}}};
 const corrected=await saveJournaledRetention(correction);expect(corrected.ok).toBe(true);if(!corrected.ok)throw Error(corrected.code);
 expect(await getOrthoRetentionEvents(s)).toMatchObject({ok:true,devices:[{deviceId:saved.entryId,lastEventId:corrected.entryId}]});
 await f.pool.query('UPDATE patient_documents SET removed_at=NOW() WHERE id=$1',[s.documentId]);
 expect(await getOrthoRetentionEvents(s)).toMatchObject({ok:false,status:403});
 expect(await getRetentionSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'blocked',identity:null}});
});
it('cross-actor recovery never exposes another actor command and revoked patient access denies reads',async()=>{
 const s=await setup();expect(await reserveRetentionSubmission(s)).toMatchObject({ok:true});const second=await setup();
 const other={...s,actorId:second.actorId,session:second.session};request.token=createSessionToken(other.session);
 const recovery=await getRetentionSubmissionRecovery(other);expect(recovery).toMatchObject({ok:true,recovery:{state:'blocked',identity:null,canCancel:false}});expect(JSON.stringify(recovery)).not.toContain('Synthetic documentary only');
 expect(await saveJournaledRetention({...other,command:{...s.command,clientRequestId:randomUUID()}})).toMatchObject({ok:false,code:'retention_submission_unacknowledged'});
 await f.pool.query("UPDATE users SET role='doctor',permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:false}),second.actorId]);other.session={...other.session,role:'doctor'};request.token=createSessionToken(other.session);
 expect(await getRetentionSubmissionRecovery(other)).toMatchObject({ok:false,status:403});
});
it('two read recoveries can share patient locks without upgrading to write locks',async()=>{
 const s=await setup();await reserveRetentionSubmission(s);
 const results=await Promise.all([getRetentionSubmissionRecovery(s),getRetentionSubmissionRecovery(s)]);
 expect(results.every(r=>r.ok&&r.recovery?.state==='pending')).toBe(true);
});
it('keeps exact v2 nested study capture and denies detached ceph-backed source on read/review/export',async()=>{
 const {saveConfirmedStudy}=await import('../helpers/ortho-study-submit');
 const {syntheticStudyCommand}=await import('../fixtures/ortho-case-study');
 const {getOrthoCaseStudy}=await import('../../lib/ortho-case-study-store');
 const {getOrthoStudyPanelReview}=await import('../../lib/ortho-case-study-review-store');
 const {GET:exportStudy}=await import('../../app/api/ortho/[id]/case-study/text-pptx/route');
 const s=await setup(true),retained=await saveJournaledRetention(s);if(!retained.ok)throw Error(retained.code);
 const command=syntheticStudyCommand(),source={key:'retention1',kind:'retention_event' as const,id:retained.entryId,version:retained.revision.version,contentHash:retained.revision.contentHash};
 command.content.sources=[source];command.content.panels[0]={...command.content.panels[0],layoutKey:'retention',state:'available',sourceKeys:['retention1']};
 const study=await saveConfirmedStudy({...s,command});expect(study.ok).toBe(true);if(!study.ok)throw Error(study.code);
 expect((study.revision.content.sources[0].payload as {content:unknown}).content).toEqual(retained.revision.content);
 expect(await getOrthoCaseStudy(s)).toMatchObject({ok:true});
 await f.pool.query("INSERT INTO ceph_analyses(patient_id,ortho_case_id,document_id,status,created_by) VALUES($1,$2,$3,'draft','synthetic')",[s.patientId,s.orthoCaseId,s.documentId]);
 await f.pool.query('UPDATE patient_documents SET ortho_case_id=NULL WHERE id=$1',[s.documentId]);
 expect(await getOrthoRetentionEvents(s)).toMatchObject({ok:false,status:403});
 expect(await getOrthoCaseStudy(s)).toMatchObject({ok:false,status:403,code:'study_retention_source_restricted'});
 expect(await getOrthoStudyPanelReview({...s,revisionId:study.revision.id,panelId:'interview1'})).toMatchObject({ok:false,status:403});
 const response=await exportStudy(new Request(`http://localhost/api/ortho/${s.orthoCaseId}/case-study/text-pptx?patientId=${s.patientId}&revisionId=${study.revision.id}`),{params:Promise.resolve({id:String(s.orthoCaseId)})});expect(response.status).toBe(403);
});
it('bounds source metadata before fetching exact labels and returns exact picker witnesses',async()=>{
 const {getRetentionDocumentChoices}=await import('../../lib/ortho-retention-event-store');
 const s=await setup(true);expect(await getRetentionDocumentChoices(s)).toMatchObject({ok:true,items:[{witness:s.command.expectedDocuments[0]}],nextCursor:null});
 await f.pool.query("UPDATE patient_documents SET title=repeat('x',65537) WHERE id=$1",[s.documentId]);
 expect(await getRetentionDocumentChoices(s)).toMatchObject({ok:false,code:'retention_source_metadata_budget'});
 expect(await reserveRetentionSubmission(s)).toMatchObject({ok:false,code:'retention_source_metadata_budget'});
 expect((await f.pool.query('SELECT id FROM ortho_retention_submissions WHERE ortho_case_id=$1',[s.orthoCaseId])).rows).toEqual([]);
});
it('cancels an existing pending command without clinical, lifecycle, schedule or financial effects',async()=>{
 const s=await setup();
 const snapshot=async()=>({owner:(await f.pool.query('SELECT status,phase,retainer,retainer_on FROM ortho_cases WHERE id=$1',[s.orthoCaseId])).rows,
 counts:(await f.pool.query('SELECT (SELECT count(*) FROM visits) visits,(SELECT count(*) FROM appointments) appointments,(SELECT count(*) FROM invoices) invoices,(SELECT count(*) FROM payments) payments')).rows});
 const before=await snapshot();expect(await reserveRetentionSubmission(s)).toMatchObject({ok:true});expect(await transition(s,'cancel')).toMatchObject({ok:true,state:'cancelled'});
 expect(await getRetentionSubmissionRecovery(s)).toMatchObject({ok:true,recovery:{state:'cancelled'}});expect(await transition(s,'acknowledge')).toMatchObject({ok:true,acknowledged:true});
 expect(await saveJournaledRetention(s)).toMatchObject({ok:false,code:'retention_submission_cancelled'});expect(await snapshot()).toEqual(before);
 const saved={...s,command:{...s.command,clientRequestId:randomUUID()}};expect(await saveJournaledRetention(saved)).toMatchObject({ok:true});expect(await snapshot()).toEqual(before);
});
