// Synthetic data regenerated locally for privacy audit; no file, database, or image reads.
import { blankFacialContent, computeFacialResults, type FacialCommand } from '../../lib/ortho-facial-analysis';

import { journeyContentHash } from '../../lib/ortho-case-journey-hash';
import { ProblemFault, type ProblemActor, type ProblemAuditEvent, type ProblemQuery, type ProblemReadPorts,
  type ProblemWritePorts, type ProblemSourceEvidencePort, type ProblemSourceProof, type ProblemOperationName } from '../../lib/ortho-problem-core-contract';
import type { ProblemSourceCandidate, ProblemSourceCommand } from '../../lib/ortho-problem-sources';
export type Row = Record<string, unknown>;
export const scope = {patientId:734599007,orthoCaseId:639752548};
export const expected = {...scope,clinicalCaseId:788771589,actorId:695444321};
export const version = `sha256:${"9b302f23a15c4bef03b64c8187d37d2e5c905683072d32036937dd3e50e3c730"}`;
// Independently authored role slots; no original dates, equality classes, ranks or intervals.
export const problemScenario = {
  facialEvidence: '2016-09-21T08:05:00.000Z',
  diagnosisSource: '2016-09-21T09:10:00.000Z',
  reviewCreated: '2016-09-21T10:20:00.000Z',
  journalCreated: '2016-09-21T11:30:00.000Z',
  settled: '2016-09-21T12:40:00.000Z',
  acknowledged: '2016-09-21T13:50:00.000Z',
  prematureSettlement: '2016-09-21T11:29:59.999Z', // One ms before creation: corruption.
} as const;

export function candidate():ProblemSourceCandidate {
  return {identity:'clinical_diagnosis:skeletal',ref:{kind:'clinical_diagnosis',id:679108321,member:'skeletal',version},category:"Synthetic privacy fixture 1 04f3086d",title:"Synthetic privacy fixture 2 04f3086d",summary:"Synthetic privacy fixture 3 04f3086d",
    proposedLabel:"Synthetic privacy fixture 3 04f3086d",site:null,target:{kind:'case'},snapshot:{field:'skeletal',text:"Synthetic privacy fixture 3 04f3086d",revisionVersion:1},sourceActor:"Synthetic reviewer A 04f3086d",sourceDate:problemScenario.diagnosisSource,available:true,requiresImages:false};
}
export function command():ProblemSourceCommand { return {schemaVersion:1,commandId:"synthetic-63c08c3a-66c9-4f58-9942-62561ba253c0",source:candidate().ref,expectedReviewId:null,action:'create',problemId:null,label:"Synthetic privacy fixture 3 04f3086d",reason:"Synthetic privacy fixture 6 04f3086d",clinicianReviewed:true}; }
export function problem(id=751402319):Row {return {id,patient_id:734599007,case_id:788771589,specialty:'orthodontics',label:"Synthetic privacy fixture 3 04f3086d",site:null,status:'active',noted_by:"Synthetic reviewer B 04f3086d"};}
export function review(c=command(),id=612935468):Row {
  const source = candidate(); source.ref = {...c.source}; source.identity = `${c.source.kind}:${c.source.kind==='ceph_diagnosis'?`${c.source.id}:`:''}${c.source.member}`;
  return {id,patient_id:734599007,recorded_patient_id:734599007,ortho_case_id:639752548,clinical_case_id:788771589,problem_id:c.problemId??751402319,actor_user_id:695444321,created_by:"Synthetic reviewer B 04f3086d",created_at:problemScenario.reviewCreated,
    source_identity:source.identity,source_version:c.source.version,source_snapshot:source,problem_label:c.label?.trim()??"Synthetic privacy fixture 3 04f3086d",reason:c.reason,supersedes_review_id:c.expectedReviewId,
    command_id:c.commandId,request_fingerprint:journeyContentHash(c),snapshot_bytes:JSON.stringify(source).length};
}
export function submission(c=command(),state:'pending'|'committed'|'cancelled'='pending'):Row {
  return {id:743062302,patient_id:734599007,recorded_patient_id:734599007,ortho_case_id:639752548,clinical_case_id:788771589,actor_user_id:695444321,command_id:c.commandId,request_fingerprint:journeyContentHash(c),command:structuredClone(c),
    state,review_id:state==='committed'?612935468:null,created_at:problemScenario.journalCreated,settled_at:state==='pending'?null:problemScenario.settled,acknowledged_at:null};
}
export function facialCandidate(): {candidate:ProblemSourceCandidate;proof:ProblemSourceProof} {
  const content=blankFacialContent({sha256:"9b302f23a15c4bef03b64c8187d37d2e5c905683072d32036937dd3e50e3c730",width:640,height:640,exifOrientation:1});
  content.quality={frontalRest:true,headPosition:true,visibleLandmarks:true,perspectiveReviewed:true,note:''};
  content.landmarks={axisTop:{state:'located',x:0.47,y:0.03},axisBottom:{state:'located',x:0.47,y:0.97},tr:{state:'located',x:0.47,y:0.15},gl:{state:'located',x:0.47,y:0.35},sn:{state:'located',x:0.47,y:0.61},me:{state:'located',x:0.47,y:0.85}};
  content.review={state:'reviewed',note:"Synthetic privacy fixture 8 04f3086d"};
  const command:FacialCommand={schemaVersion:1,clientRequestId:"synthetic-fccb3be9-9ff3-471b-8e82-779ad9f31e70",documentId:687478788,expectedHeadId:null,reason:"Synthetic privacy fixture 10 04f3086d",content};
  const results=computeFacialResults(content);
  const revision={...scope,clinicalCaseId:788771589,id:613865909,documentId:687478788,version:1,recordedPatientId:734599007,actorId:695444321,createdBy:"Synthetic reviewer B 04f3086d",createdAt:problemScenario.facialEvidence,requestFingerprint:journeyContentHash(command),contentHash:journeyContentHash({content,results}),command,results};
  const sourceVersion=`sha256:${journeyContentHash(revision)}`;
  const c=candidate();c.ref={kind:'facial_review',id:613865909,member:"document_687478788_review",version:sourceVersion};c.identity="facial_review:document_687478788_review";c.requiresImages=true;
  c.sourceActor="Synthetic reviewer B 04f3086d";c.proposedLabel=null;c.summary=content.review.note;c.sourceDate=revision.createdAt;c.snapshot={revision,limitation:'Manual 2D photographic description, not calibrated anatomy or automatic diagnosis'};
  return {candidate:c,proof:{kind:'facial_review',revisionId:613865909,documentId:687478788,sourceVersion,basisHash:journeyContentHash(content.image),head:'latest',review:'reviewed',nonemptyNote:true,geometryValid:true,documentCurrent:true}};
}
export class ProblemHarness {
  actor:ProblemActor = {userId:695444321,name:"Synthetic reviewer B 04f3086d",role:'doctor'};
  owner:Row = {id:639752548,patient_id:734599007,status:'active',plan_id:null};
  bridges:Row[] = [{id:788771589,patient_id:734599007,ortho_case_id:639752548,specialty:'orthodontics'}];
  reviews:Row[]=[]; submissions:Row[]=[]; problems:Row[]=[]; candidates:ProblemSourceCandidate[]=[candidate()];
  audits:ProblemAuditEvent[]=[]; sql:string[]=[]; actions:string[]=[]; captures=0; creates=0; epoch=1;
  clinicalAllowed=true; clinicals=0; clinicalError?:Error; onClinical?:()=>void;
  readAllowed=true; writeAllowed=true; createAllowed=true; imagesAllowed=true; cancelledAllowed=true;
  onQuery?: (sql:string,values:unknown[],rows:Row[])=>void;
  onCapture?: ()=>void; onAssert?: (operation:ProblemOperationName)=>void; onAudit?: ()=>void;
  onProof?: (proof:ProblemSourceProof)=>void;
  captureError?: Error; auditError?:Error; metadata?:Row; budget?:Row;
  readonly client:ProblemQuery = {query:async <R extends object>(sql:string,values:unknown[]=[]) => {
    this.sql.push(sql); const rows=this.query(sql,values); this.onQuery?.(sql,values,rows); return {rows:rows as R[]};
  }};
  proof(c:ProblemSourceCandidate):ProblemSourceProof {
    const result:ProblemSourceProof = {kind:'clinical_diagnosis',diagnosisId:c.ref.id,patientId:734599007,orthoCaseId:639752548,contentHash:"9b302f23a15c4bef03b64c8187d37d2e5c905683072d32036937dd3e50e3c730",sourceVersion:c.ref.version,locked:true};
    this.onProof?.(result); return result;
  }
  sources(epoch=this.epoch):ProblemSourceEvidencePort {
    const witness = {};
    return {capture:async(client,context,owner) => {
      if(client!==this.client || context.scope.patientId!==734599007 || owner.clinicalCaseId!==788771589 || this.epoch!==epoch) throw Error('wrong_source_context');
      this.captures++; this.onCapture?.(); if(this.captureError) throw this.captureError;
      return {entries:this.candidates.map(c=>({candidate:c,proof:this.proof(c)})),witness};
    },assertCurrent:async(client,context,owner,w) => {
      if(client!==this.client || context.actor.userId!==this.actor.userId || owner.patientId!==734599007 || w!==witness || this.epoch!==epoch) throw Error('stale_source_witness');
    }};
  }
  write():ProblemWritePorts {
    const epoch=this.epoch;
    const live=async(client:ProblemQuery,s:{patientId:number;orthoCaseId:number},operation:ProblemOperationName) => {
      this.actions.push(operation); this.onAssert?.(operation);
      if(client!==this.client || s.patientId!==734599007 || s.orthoCaseId!==639752548 || epoch!==this.epoch) throw Error('stale_authority');
      if(!this.writeAllowed) throw new ProblemFault(403,'write_revoked'); return this.actor;
    };
    return {mode:'write',bindings:[],sources:this.sources(epoch),authority:{
      beginWrite:live,assertWrite:(c,s,_a,o)=>live(c,s,o),
      assertClinicalRead:async(c,s,_a,o)=>{const a=await live(c,s,o);this.clinicals++;this.onClinical?.();if(this.clinicalError)throw this.clinicalError;if(!this.clinicalAllowed)throw new ProblemFault(403,'clinical_revoked');return a;},
      assertImages:async(c,s,_a,o)=>{const a=await live(c,s,o);if(!this.imagesAllowed)throw new ProblemFault(403,'image_revoked');return a;},
      assertProblemCreate:async(c,s,_a,o)=>{const a=await live(c,s,o);this.creates++;if(!this.createAllowed)throw new ProblemFault(403,'create_revoked');return a;},
    },audit:{append:async(client,event)=>{if(client!==this.client)throw Error('wrong_audit_client');if(this.auditError)throw this.auditError;this.audits.push(event);this.onAudit?.();}}};
  }
  read():ProblemReadPorts {
    const epoch=this.epoch;
    const live=async(client:ProblemQuery,s:{patientId:number;orthoCaseId:number},operation:ProblemOperationName)=>{
      this.actions.push(operation);this.onAssert?.(operation);
      if(client!==this.client || s.patientId!==734599007 || s.orthoCaseId!==639752548 || epoch!==this.epoch)throw Error('stale_authority');
      if(!this.readAllowed)throw new ProblemFault(403,'read_revoked');return this.actor;
    };
    return {mode:'legacy-read',bindings:[],sources:this.sources(epoch),authority:{beginRead:live,assertRead:(c,s,_a,o)=>live(c,s,o),
      assertClinicalRead:async(c,s,_a,o)=>{const a=await live(c,s,o);this.clinicals++;this.onClinical?.();if(this.clinicalError)throw this.clinicalError;if(!this.clinicalAllowed)throw new ProblemFault(403,'clinical_revoked');return a;},
      assertImages:async(c,s,_a,o)=>{const a=await live(c,s,o);if(!this.imagesAllowed)throw new ProblemFault(403,'image_revoked');return a;},
      readWriteEligibility:async(c,s,_a,target)=>{await live(c,s,target==='cancel'?'recover':'list');return this.writeAllowed&&(target!=='cancel'||this.cancelledAllowed);},
    }};
  }
  async transaction<T>(f:()=>Promise<T>):Promise<T> {
    const old=structuredClone({reviews:this.reviews,submissions:this.submissions,problems:this.problems,audits:this.audits});
    try{return await f();}catch(e){Object.assign(this,old);throw e;}
  }
  query(sql:string,v:unknown[]):Row[] {
    if(sql.startsWith('LOCK TABLE'))return [];
    if(sql.includes('FROM ortho_cases'))return [this.owner];
    if(sql.includes('FROM clinical_cases'))return this.bridges;
    if(sql.startsWith('SELECT count(*)::text'))return [this.metadata??{n:String(this.reviews.length),bytes:String(this.reviews.reduce((sum,r)=>sum+Number(r.snapshot_bytes),0)),images:this.reviews.some(r=>(r.source_snapshot as ProblemSourceCandidate).requiresImages)}];
    if(sql.startsWith('SELECT count(*)::int'))return [this.budget??{count:this.reviews.length,bytes:String(this.reviews.reduce((sum,r)=>sum+Number(r.snapshot_bytes),0)+String(v[1]).length),candidate_bytes:String(v[1]).length}];
    if(sql.includes('FROM ortho_problem_source_reviews')) {
      if(sql.includes('actor_user_id=$2')){const rows=this.reviews.filter(r=>r.patient_id===v[0]&&r.actor_user_id===v[1]&&r.command_id===v[2]);return sql.startsWith('SELECT patient_id,actor_user_id')?rows.map(({patient_id,actor_user_id,command_id,request_fingerprint})=>({patient_id,actor_user_id,command_id,request_fingerprint})):rows;}
      return [...this.reviews].filter(r=>r.ortho_case_id===v[0]).sort((a,b)=>Number(b.id)-Number(a.id));
    }
    if(sql.includes('FROM patient_problems'))return this.problems.filter(r=>r.patient_id===v[0]&&r.case_id===v[1]&&r.specialty==='orthodontics').map(({id,label,site,status})=>({id,label,site,status}));
    if(sql.includes('FROM ortho_problem_source_submissions')) {
      if(sql.includes(' OR '))return this.submissions.filter(r=>r.ortho_case_id===v[0]&&r.acknowledged_at===null||r.patient_id===v[1]&&r.actor_user_id===v[2]&&r.command_id===v[3]).slice(0,1);
      if(sql.includes('actor_user_id=$2'))return this.submissions.filter(r=>r.patient_id===v[0]&&r.actor_user_id===v[1]&&r.command_id===v[2]);
      return this.submissions.filter(r=>r.ortho_case_id===v[0]&&r.acknowledged_at===null);
    }
    if(sql.startsWith('INSERT INTO patient_problems')) {
      const row={id:751402319+this.problems.length,patient_id:v[0],label:v[1],site:v[2],specialty:'orthodontics',case_id:v[3],noted_by:v[4],status:'active'};this.problems.push(row);return [row];
    }
    if(sql.startsWith('INSERT INTO ortho_problem_source_reviews')) {
      const source=JSON.parse(String(v[8]));const row={id:612935468+this.reviews.length,patient_id:v[0],recorded_patient_id:v[0],ortho_case_id:v[1],clinical_case_id:v[2],problem_id:v[3],actor_user_id:v[4],created_by:v[5],created_at:problemScenario.reviewCreated,source_identity:v[6],source_version:v[7],source_snapshot:source,problem_label:v[9],reason:v[10],supersedes_review_id:v[11],command_id:v[12],request_fingerprint:v[13],snapshot_bytes:JSON.stringify(source).length};this.reviews.push(row);return [row];
    }
    if(sql.startsWith('INSERT INTO ortho_problem_source_submissions')) {
      const cancelled=sql.includes("NULL,'cancelled'");const row={id:743062302+this.submissions.length,patient_id:v[0],recorded_patient_id:v[0],ortho_case_id:v[1],clinical_case_id:v[2],actor_user_id:v[3],command_id:v[4],request_fingerprint:v[5],command:cancelled?null:JSON.parse(String(v[6])),state:cancelled?'cancelled':v[7],review_id:cancelled?null:v[8],created_at:problemScenario.journalCreated,settled_at:cancelled||v[7]==='committed'?problemScenario.settled:null,acknowledged_at:null};this.submissions.push(row);return [row];
    }
    if(sql.startsWith('UPDATE ortho_problem_source_submissions')) {
      const row=this.submissions.find(r=>r.id===v[0]);if(!row)return [];
      if(sql.includes("state='committed'")){row.state='committed';row.review_id=v[1];row.settled_at=problemScenario.settled;}
      else if(sql.includes("state='cancelled'")){row.state='cancelled';row.settled_at=problemScenario.settled;}
      else {row.acknowledged_at=problemScenario.acknowledged;row.command=null;}return [row];
    }
    throw Error(`Unexpected SQL: ${sql}`);
  }
}
