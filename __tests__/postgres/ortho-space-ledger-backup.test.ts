import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
import {createSessionToken,sessionCredentialVersion,type SessionPayload} from '../../lib/auth';
import {openBackupTimestampFixture} from './_backup-timestamp-fixture';
import {assessmentCommandV2} from '../fixtures/ortho-assessment-schema2';
import {appendOrthoAssessment} from '../../lib/ortho-assessment-store';
import {appendOrthoTreatmentStrategy} from '../../lib/ortho-treatment-strategy-store';
import {getOrthoSpaceLedger} from '../../lib/ortho-space-store';
import {saveJournaledSpace,getSpaceSubmissionRecovery,transitionSpaceSubmission} from '../../lib/ortho-space-submission-store';
import {journeyContentHash} from '../../lib/ortho-case-journey-hash';
import type {SpacePersistenceCommand as SpaceCommand} from '../../lib/ortho-space-command';
import {fullBackupBlocks} from '../../lib/fullBackup';
import {getOrthoStudySourceChoices} from '../../lib/ortho-case-study-inventory';
import {saveConfirmedStudy} from '../helpers/ortho-study-submit';
import {getOrthoCaseStudy,saveOrthoCaseStudy} from '../../lib/ortho-case-study-store';
import {getStudySubmissionRecovery} from '../../lib/ortho-study-submission-store';
import {CASE_TEMPLATE_VERSION} from '../../lib/ortho-case-template';
import {STUDY_TEMPLATE_HASH} from '../../lib/ortho-case-study-template';
import type {StudySaveCommand} from '../../lib/ortho-case-study';
import {stagedRestore} from '../../lib/restore/staging';
const request=vi.hoisted(()=>({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='aqlan_flow_session'?{value:request.token}:undefined}),headers:async()=>new Headers()}));
let f:Awaited<ReturnType<typeof openBackupTimestampFixture>>, db:typeof import('../../lib/db'), directory:string;
async function setup(withImage=false){
 const key=randomUUID(),password='Synthetic credential';
 const patientId=(await f.source.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic space patient') RETURNING id",[key])).rows[0].id;
 const actorId=(await f.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic doctor',$2,'admin') RETURNING id",[key,password])).rows[0].id;
 const session:SessionPayload={userId:actorId,username:key,role:'admin',credentialVersion:sessionCredentialVersion(password),expiresAt:Date.now()+600000};request.token=createSessionToken(session);
 const orthoCaseId=(await f.source.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'active','synthetic') RETURNING id",[patientId])).rows[0].id;
 const clinicalCaseId=(await f.source.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id",[patientId,orthoCaseId])).rows[0].id;
 const problemId=(await f.source.query("INSERT INTO patient_problems(patient_id,case_id,specialty,label,noted_by) VALUES($1,$2,'orthodontics','Synthetic crowding','synthetic') RETURNING id",[patientId,clinicalCaseId])).rows[0].id;
 const scope={patientId,orthoCaseId,clinicalCaseId,actorId,session};
 const strategyCommand={schemaVersion:1,commandId:randomUUID(),expectedRevisionId:null,reason:'Synthetic explicit strategy',rows:[{problemId,objective:'Synthetic objective',strategy:'Synthetic conservative option',planItemIds:[],rationale:'Synthetic rationale'}]};
 const strategy=await appendOrthoTreatmentStrategy({...scope,command:strategyCommand});if(!strategy.ok)throw Error(strategy.code);
 const assessmentCommand=assessmentCommandV2();let documentId:number|null=null;
 if(withImage){const hash='a'.repeat(64);documentId=(await f.source.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'Synthetic basis','image/png',123,$3,'synthetic-unused-space-image','synthetic') RETURNING id",[patientId,orthoCaseId,hash])).rows[0].id;
 assessmentCommand.content.observations.observations.find(o=>o.id==='available_upper')!.provenance!.sources=[{kind:'document',id:documentId!,version:`sha256:${hash}`}];}
 const assessment=await appendOrthoAssessment({...scope,command:{...assessmentCommand,commandId:randomUUID()}});if(!assessment.ok)throw Error(assessment.code);
 const ledger=await getOrthoSpaceLedger(scope);if(!ledger.ok)throw Error(ledger.code);
 const command:SpaceCommand={schemaVersion:1,clientRequestId:randomUUID(),expectedHeadId:null,reason:'Synthetic reviewed plan',content:{kind:'plan',arch:'upper',strategyRevisionId:strategy.revision.revisionId,baseline:ledger.baselines[0].ref,gains:[],uses:[],contacts:[{teeth:[11,12],plannedUm:200,budgetGainUm:100,clinicianLimitUm:300,note:'Synthetic contact examination'}],rationale:'Synthetic choice',alternatives:'Synthetic other option'}};
 return {...scope,command,strategyCommand,assessmentId:assessment.revision.id,documentId};
}

type Scope=Awaited<ReturnType<typeof setup>>;
type Receipt=Extract<Awaited<ReturnType<typeof saveJournaledSpace>>,{ok:true}>;
let scope:Scope, correction:SpaceCommand, expectedLedger:Awaited<ReturnType<typeof getOrthoSpaceLedger>>;
let studyCommand:StudySaveCommand, documentedCommand:StudySaveCommand;
let draftStudy:Extract<Awaited<ReturnType<typeof saveOrthoCaseStudy>>,{ok:true}>, documentedStudy:typeof draftStudy;
const saved:{command:SpaceCommand;receipt:Receipt}[]=[];
const snapshot=async(pool:typeof f.source)=>({
 studies:(await pool.query('SELECT to_jsonb(t)::text value FROM ortho_case_study_revisions t ORDER BY id')).rows,
 studySubmissions:(await pool.query('SELECT to_jsonb(t)::text value FROM ortho_study_submissions t ORDER BY id')).rows,
 entries:(await pool.query('SELECT to_jsonb(t)::text value FROM ortho_space_entries t ORDER BY id')).rows,
 submissions:(await pool.query('SELECT to_jsonb(t)::text value FROM ortho_space_submissions t ORDER BY id')).rows,
 adjustments:(await pool.query('SELECT to_jsonb(t)::text value FROM ortho_adjustments t ORDER BY id')).rows,
 visits:(await pool.query('SELECT to_jsonb(t)::text value FROM visits t ORDER BY id')).rows,
});
async function record(command:SpaceCommand,acknowledge:boolean){
 const receipt=await saveJournaledSpace({...scope,command});if(!receipt.ok)throw Error(receipt.code);
 saved.push({command,receipt});
 if(acknowledge)expect(await transitionSpaceSubmission({...scope,commandId:command.clientRequestId,requestFingerprint:journeyContentHash(command),action:'acknowledge'})).toMatchObject({ok:true,acknowledged:true});
 return receipt;
}
beforeAll(async()=>{
 f=await openBackupTimestampFixture(process.env);directory=await mkdtemp(join(tmpdir(),'space-ledger-restore-'));
 vi.stubEnv('DATABASE_URL',f.source.options.connectionString!);vi.stubEnv('SKIP_SEED','true');vi.stubEnv('SESSION_SECRET','synthetic-space-restore-secret-at-least-32-characters');
 db=await import('../../lib/db');await db.resetPoolForTesting();await db.ensureSchema();scope=await setup();
 const plan=await record(scope.command,true);
 const visit=(await f.source.query("INSERT INTO visits(patient_id,patient_name,case_id) VALUES($1,'Synthetic performed visit',$2) RETURNING id",[scope.patientId,scope.clinicalCaseId])).rows[0].id;
 const adjustment=(await f.source.query("INSERT INTO ortho_adjustments(case_id,visit_id,done_on,recorded_by) VALUES($1,$2,'2026-10-01','Synthetic treating clinician') RETURNING id",[scope.orthoCaseId,visit])).rows[0].id;
 const performance:SpaceCommand={schemaVersion:2,expectedSession:{visitId:visit,occurredOn:'2026-10-01',recordedBy:'Synthetic treating clinician'},clientRequestId:randomUUID(),expectedHeadId:plan.entryId,reason:'Synthetic actual IPR',content:{kind:'ipr',arch:'upper',planEntryId:plan.entryId,teeth:[11,12],adjustmentId:adjustment,performedUm:null,measurementNote:'Original amount was unknown',supersedesEntryId:null,reviewReason:'Unknown original amount'}};
 const actual=await record(performance,true);
 expect(await getOrthoSpaceLedger(scope)).toMatchObject({ok:true,ipr:{totals:[{performedUm:null}]}});

 const choices=await getOrthoStudySourceChoices({...scope,kind:'space_ledger'});if(!choices.ok)throw Error(choices.code);
 const selection=choices.choices[0].selection!;
 studyCommand={schemaVersion:1,clientRequestId:randomUUID(),expectedHead:null,baseDocumentedRevision:null,kind:'draft',documentedFrom:null,reason:'Synthetic prefix before correction',content:{template:{key:'full-orthodontic-case',version:CASE_TEMPLATE_VERSION,contentHash:STUDY_TEMPLATE_HASH},identityDisclosure:'case_only',sources:[selection],groups:[],panels:[{instanceId:'space-panel',layoutKey:'model-measurements',included:true,state:'available',sourceKeys:[selection.key],images:[],comment:''}],mediaUses:[],comment:''}};
 const draft=await saveConfirmedStudy({...scope,command:studyCommand});if(!draft.ok)throw Error(draft.code);draftStudy=draft;
 if(performance.content.kind!=='ipr')throw Error('fixture');
 correction={...performance,clientRequestId:randomUUID(),expectedHeadId:actual.entryId,reason:'Explicit corrected measurement',content:{...performance.content,performedUm:50,supersedesEntryId:actual.entryId,reviewReason:'Reviewed corrected amount'}};
 await record(correction,false);expectedLedger=await getOrthoSpaceLedger(scope);
 expect(expectedLedger).toMatchObject({ok:true,actorId:scope.actorId,scope:{patientId:scope.patientId,orthoCaseId:scope.orthoCaseId,clinicalCaseId:scope.clinicalCaseId},ipr:{totals:[{arch:'upper',contact:'11-12',performedUm:50}]}});
 if(!expectedLedger.ok)throw Error(expectedLedger.code);expect(expectedLedger.history).toHaveLength(3);
 expect((await f.source.query("SELECT state,command IS NULL AS scrubbed,acknowledged_at IS NOT NULL AS acknowledged FROM ortho_space_submissions ORDER BY id")).rows).toEqual([{state:'committed',scrubbed:true,acknowledged:true},{state:'committed',scrubbed:true,acknowledged:true},{state:'committed',scrubbed:false,acknowledged:false}]);

 // Documentation after the newer correction must copy the original unknown-IPR prefix exactly.
 documentedCommand={...studyCommand,clientRequestId:randomUUID(),kind:'documented',expectedHead:{id:draftStudy.revision.id,contentHash:draftStudy.revision.contentHash},documentedFrom:{id:draftStudy.revision.id,contentHash:draftStudy.revision.contentHash}};
 const documented=await saveOrthoCaseStudy({...scope,command:documentedCommand});if(!documented.ok)throw Error(documented.code);documentedStudy=documented;
 expect(documented.revision.content).toEqual(draftStudy.revision.content);
 expect(documented.revision.contentHash).toBe(draftStudy.revision.contentHash);
 const prefix=documented.revision.content.sources[0].payload as import('../../lib/ortho-study-space-capture').StudySpaceCapture;
 expect(prefix.history).toHaveLength(2);
 expect(prefix.history[0].content.authored).toMatchObject({kind:'ipr',performedUm:null});
 await f.source.query('CREATE INDEX synthetic_study_reverse ON ortho_case_study_revisions(id DESC); CLUSTER ortho_case_study_revisions USING synthetic_study_reverse; DROP INDEX synthetic_study_reverse; CREATE INDEX synthetic_study_journal_reverse ON ortho_study_submissions(id DESC); CLUSTER ortho_study_submissions USING synthetic_study_journal_reverse; DROP INDEX synthetic_study_journal_reverse');
 expect((await f.source.query('SELECT id FROM ortho_case_study_revisions')).rows.map(r=>r.id)).toEqual([documented.revision.id,draftStudy.revision.id]);
 // Reverse physical order forces child-before-parent lineage restoration; no trigger disabling.
 await f.source.query('CREATE INDEX synthetic_space_reverse ON ortho_space_entries(id DESC); CLUSTER ortho_space_entries USING synthetic_space_reverse; DROP INDEX synthetic_space_reverse; CREATE INDEX synthetic_space_journal_reverse ON ortho_space_submissions(id DESC); CLUSTER ortho_space_submissions USING synthetic_space_journal_reverse; DROP INDEX synthetic_space_journal_reverse');
 expect((await f.source.query('SELECT id FROM ortho_space_entries')).rows.map(r=>r.id)).toEqual(saved.map(s=>s.receipt.entryId).reverse());
 const client=await f.source.connect();try{
  let sql='';for await(const line of db.backupSqlLines(client))sql+=line;await writeFile(join(directory,'backup.sql'),sql);
  const blocks:Uint8Array[]=[];for await(const block of fullBackupBlocks({source:client,readDocument:async()=>{throw Error('No image in this synthetic fixture');}}))blocks.push(block);await writeFile(join(directory,'backup.tar.gz'),gzipSync(Buffer.concat(blocks)));
 }finally{client.release();}
});
afterAll(async()=>{try{await db?.resetPoolForTesting();}finally{vi.unstubAllEnvs();await f?.close();if(directory)await rm(directory,{recursive:true,force:true});}});
it.each(['sql','archive'] as const)('restores exact study prefix before newer IPR correction through %s with reverse history and recoverable documentation',async kind=>{
 const target=kind==='sql'?f.sqlTarget:f.archiveTarget;
 if(kind==='sql'){
  vi.stubEnv('DATABASE_URL',target.options.connectionString!);await db.resetPoolForTesting();await db.ensureSchema();
  expect((await promisify(execFile)(process.execPath,['scripts/restore.mjs',join(directory,'backup.sql')],{env:{...process.env}})).stdout).toContain('تمت الاستعادة');
 }else{
  await db.resetPoolForTesting();const restored=await stagedRestore({archivePath:join(directory,'backup.tar.gz'),targetUrl:target.options.connectionString!,stagingDir:join(directory,'documents')});expect(restored.errors).toEqual([]);expect(restored.ok).toBe(true);
  vi.stubEnv('DATABASE_URL',target.options.connectionString!);await db.resetPoolForTesting();
 }
 expect(await snapshot(target)).toEqual(await snapshot(f.source));
 expect(await getOrthoSpaceLedger(scope)).toEqual(expectedLedger);

 for(const expected of [draftStudy,documentedStudy]){
  const read=await getOrthoCaseStudy({...scope,revisionId:expected.revision.id});expect(read.ok).toBe(true);if(!read.ok)throw Error(read.code);
  expect(read.revision!.content).toEqual(expected.revision.content);expect(read.revision!.contentHash).toBe(expected.revision.contentHash);
 }
 expect(await getStudySubmissionRecovery(scope)).toMatchObject({ok:true,recovery:{state:'committed',expected:{command:documentedCommand}}});
 expect(await saveOrthoCaseStudy({...scope,command:documentedCommand})).toEqual({...documentedStudy,replayed:true});
 expect(await snapshot(target)).toEqual(await snapshot(f.source));
 const other=(await target.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic merge peer') RETURNING id",[randomUUID()])).rows[0].id;
 for(const [sourceId,targetId] of [[scope.patientId,other],[other,scope.patientId]])expect(await db.mergeDuplicatePatient(sourceId,targetId,{actor:scope.session.username,actorRole:'admin'})).toMatchObject({ok:false,reason:'source_has_clinical_command_history'});
 expect(await getSpaceSubmissionRecovery(scope)).toMatchObject({ok:true,actorId:scope.actorId,recovery:{state:'committed',expected:{command:correction}}});
 for(const item of saved)expect(await saveJournaledSpace({...scope,command:item.command})).toEqual({...item.receipt,replayed:true});
 expect(await snapshot(target)).toEqual(await snapshot(f.source));
 await expect(target.query("UPDATE ortho_space_entries SET reason='changed'")).rejects.toMatchObject({code:'55000'});
 await expect(target.query('DELETE FROM ortho_space_submissions')).rejects.toMatchObject({code:'55000'});
 expect((await target.query('SELECT count(*)::int n FROM ortho_space_entries')).rows[0].n).toBe(3);
});
