import {describe,it,expect} from 'vitest';
import {spaceHash,verifySpaceRead,verifySpaceReceipt,readSpaceRevision} from '../lib/ortho-space-client';
import {verifySpaceSubmissionRecovery} from '../lib/ortho-space-client-contract';
import {projectIpr,type SpacePlan} from '../lib/ortho-space-ledger';
import type {SpacePersistenceCommand} from '../lib/ortho-space-command';
const scope={patientId:1,orthoCaseId:2,clinicalCaseId:3},actorId=4;
const plan:SpacePlan={kind:'plan',arch:'upper',strategyRevisionId:1,baseline:{kind:'assessment_analysis',id:9,member:'synthetic',version:`sha256:${'a'.repeat(64)}`},gains:[],uses:[],contacts:[{teeth:[11,12],plannedUm:null,budgetGainUm:null,clinicianLimitUm:null,note:'Synthetic contact'}],rationale:'Synthetic plan',alternatives:'Synthetic alternatives'};
async function fixture(){
 const command:SpacePersistenceCommand={schemaVersion:1,clientRequestId:'synthetic_space_command',expectedHeadId:null,reason:'Synthetic reason',content:structuredClone(plan)};
 const content={authored:command.content,baseline:{discrepancyMm:-1.234567,estimated:true},adjustment:null};
 const revision={...scope,id:10,recordedPatientId:1,schemaVersion:1,version:1,predecessorId:null,createdBy:'Synthetic clinician',createdAt:'2026-11-06T01:00:00Z',reason:command.reason,recordingContext:'current',caseStatusAtCapture:'active',contentHash:await spaceHash(content),content};
 const projection=projectIpr([{id:10,version:1,content:command.content}]);if(!projection.ok)throw Error(projection.code);
 const read={ok:true,scope,actorId,writable:true,headId:10,history:[revision],ipr:projection.value,baselines:[{ref:plan.baseline,arch:'upper',discrepancyMm:-1.234567,estimated:true}],strategy:null,adjustments:[]};
 const receipt={ok:true,scope,actorId,replayed:false,revision,entryId:10,commandId:command.clientRequestId,requestFingerprint:await spaceHash(command)};
 return {command,read,receipt};
}
describe('space read and receipt proofs',()=>{
 it('retains full signed baseline precision and unknown amounts',async()=>{const f=await fixture(),r=await verifySpaceRead(f.read,1,2,{scope,actorId});expect(r?.history[0].content.baseline).toEqual({discrepancyMm:-1.234567,estimated:true});expect(r?.history[0].content.authored).toEqual(plan);});
 it('retains assessment-stage space plans',async()=>{const f=await fixture();f.read.history[0].caseStatusAtCapture='assessment';f.receipt.revision.caseStatusAtCapture='assessment';expect(await verifySpaceRead(f.read,1,2,{scope,actorId})).not.toBeNull();await expect(verifySpaceReceipt(f.receipt,{scope,actorId},f.command,201)).resolves.toEqual(f.receipt.revision);});
 it('returns detached clinical data',async()=>{const f=await fixture(),r=await verifySpaceRead(f.read,1,2);f.read.history[0].content.baseline.discrepancyMm=0;expect(r?.history[0].content.baseline?.discrepancyMm).toBe(-1.234567);});
 it('accepts the canonical analysis member used by the browser fixture and refuses punctuation',async()=>{
  const f=await fixture();
  f.read.baselines[0].ref={...f.read.baselines[0].ref,member:'space_upper'};
  expect(await verifySpaceRead(f.read,1,2,{scope,actorId})).not.toBeNull();
  f.read.baselines[0].ref.member='arch-space:upper';
  expect(await verifySpaceRead(f.read,1,2,{scope,actorId})).toBeNull();
 });
 it.each(['root_extra','actor','scope','recorded_patient','history_extra','hash','content','head','predecessor','version','duplicate','sparse','projection','projection_extra','baseline','baseline_extra','strategy','adjustment','adjustment_date','adjustment_extra','oversize'] as const)('refuses malformed %s without empty substitution',async kind=>{
  const f=await fixture(),r:any=structuredClone(f.read);
  if(kind==='root_extra')r.extra=true;if(kind==='actor')r.actorId=8;if(kind==='scope')r.scope.patientId=2;if(kind==='recorded_patient')r.history[0].recordedPatientId=2;
  if(kind==='history_extra')r.history[0].extra=1;if(kind==='hash')r.history[0].contentHash='b'.repeat(64);if(kind==='content')r.history[0].content.baseline.discrepancyMm=0;
  if(kind==='head')r.headId=11;if(kind==='predecessor')r.history[0].predecessorId=10;if(kind==='version')r.history[0].version=2;if(kind==='duplicate')r.history.push(r.history[0]);if(kind==='sparse')r.history=new Array(1);
  if(kind==='projection')r.ipr.current=[{}];if(kind==='projection_extra')r.ipr.extra=true;if(kind==='baseline')r.baselines[0].ref.kind='clinical_diagnosis';if(kind==='baseline_extra')r.baselines[0].extra=true;if(kind==='strategy')r.strategy={id:1};
  if(kind==='adjustment')r.adjustments=[{id:1,visitId:0,occurredOn:'2026-11-06',recordedBy:'Synthetic'}];if(kind==='adjustment_date')r.adjustments=[{id:1,visitId:2,occurredOn:'2026-02-30',recordedBy:'Synthetic'}];if(kind==='adjustment_extra')r.adjustments=[{id:1,visitId:2,occurredOn:'2026-11-06',recordedBy:'Synthetic',booked:true}];if(kind==='oversize')r.history=new Array(1001).fill(r.history[0]);
  expect(await verifySpaceRead(r,1,2,{scope,actorId})).toBeNull();
 });
 it('accepts an exact new receipt and exact replay only with matching status',async()=>{const f=await fixture();await expect(verifySpaceReceipt(f.receipt,{scope,actorId},f.command,201)).resolves.toEqual(f.receipt.revision);await expect(verifySpaceReceipt({...f.receipt,replayed:true},{scope,actorId},f.command,200)).resolves.toEqual(f.receipt.revision);await expect(verifySpaceReceipt(f.receipt,{scope,actorId},f.command,200)).rejects.toThrow();});
 it.each(['actor','scope','entry','reason','authored','fingerprint','extra','predecessor','version'] as const)('does not settle changed receipt %s',async kind=>{const f=await fixture(),r:any=structuredClone(f.receipt);if(kind==='actor')r.actorId=8;if(kind==='scope')r.scope.patientId=8;if(kind==='entry')r.entryId=11;if(kind==='reason')r.revision.reason='Changed';if(kind==='authored'){r.revision.content.authored.rationale='Changed';r.revision.contentHash=await spaceHash(r.revision.content);}if(kind==='fingerprint')r.requestFingerprint='b'.repeat(64);if(kind==='extra')r.extra=1;if(kind==='predecessor')r.revision.predecessorId=1;if(kind==='version')r.revision.version=99;await expect(verifySpaceReceipt(r,{scope,actorId},f.command,201)).rejects.toThrow();});
 it('requires exact witnessed performed-session metadata in receipts and recovery',async()=>{
  const f=await fixture(),command:SpacePersistenceCommand={schemaVersion:2,clientRequestId:'synthetic_performed_command',expectedHeadId:10,reason:'Synthetic actual IPR',content:{kind:'ipr',arch:'upper',planEntryId:10,teeth:[11,12],adjustmentId:5,performedUm:0,measurementNote:'Explicit zero',supersedesEntryId:null,reviewReason:'Reviewed unknown plan'},expectedSession:{visitId:6,occurredOn:'2026-11-06',recordedBy:'Synthetic'}};
  const content={authored:command.content,baseline:null,adjustment:command.expectedSession},revision={...f.receipt.revision,id:11,version:2,predecessorId:10,reason:command.reason,content,contentHash:await spaceHash(content)};
  const receipt={...f.receipt,entryId:11,revision,commandId:command.clientRequestId,requestFingerprint:await spaceHash(command)};
  await expect(verifySpaceReceipt(receipt,{scope,actorId},command,201)).resolves.toEqual(revision);
  const assessmentReceipt={...receipt,revision:{...revision,caseStatusAtCapture:'assessment'}};
  await expect(verifySpaceReceipt(assessmentReceipt,{scope,actorId},command,201)).rejects.toThrow();
  expect(await readSpaceRevision(assessmentReceipt.revision,scope)).toBeNull();
  await expect(verifySpaceReceipt({...assessmentReceipt,replayed:true},{scope,actorId},command,200)).rejects.toThrow();
  const ipr=projectIpr([{id:10,version:1,content:plan},{id:11,version:2,content:command.content}]);if(!ipr.ok)throw Error(ipr.code);
  const ledger={...f.read,headId:11,history:[assessmentReceipt.revision,...f.read.history],ipr:ipr.value,adjustments:[{id:5,...command.expectedSession}]};
  expect(await verifySpaceRead(ledger,1,2,{scope,actorId})).toBeNull();
  for(const status of ['active','retention','completed','discontinued']){
   const legitimate={...revision,caseStatusAtCapture:status,recordingContext:['completed','discontinued'].includes(status)?'retrospective':'current'};
   expect(await readSpaceRevision(legitimate,scope)).toEqual(legitimate);
  }

  const changed={...receipt,revision:{...revision,content:{...content,adjustment:{...command.expectedSession,visitId:7}}}};changed.revision.contentHash=await spaceHash(changed.revision.content);
  await expect(verifySpaceReceipt(changed,{scope,actorId},command,201)).rejects.toThrow();
  const recovery={ok:true,scope,actorId,recovery:{state:'pending',identity:{id:7,commandId:command.clientRequestId,requestFingerprint:await spaceHash(command)},expected:{scope,actorId,command}}};
  await expect(verifySpaceSubmissionRecovery(recovery,scope,actorId)).resolves.toEqual(recovery);
  recovery.recovery.expected.command={...command,expectedSession:{...command.expectedSession,recordedBy:'Changed'}};
  await expect(verifySpaceSubmissionRecovery(recovery,scope,actorId)).rejects.toThrow();
 });
});
