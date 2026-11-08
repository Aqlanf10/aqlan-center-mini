import {checkStudySaveCommand,type StudySaveCommand} from './ortho-case-study';
import {journeyId,journeyHash,type JourneyScope} from './ortho-case-journey-records';
import {studyBrowserHash,type StudySaveExpectation} from './ortho-case-study-editor-response';
export interface StudySubmissionIdentity {id:number;commandId:string;requestFingerprint:string}
export type StudySubmissionRecovery = {ok:true;actorId:number;scope:JourneyScope;recovery:null
 | {state:'blocked';identity:StudySubmissionIdentity|null;canCancel:boolean}
 | {state:'pending'|'committed';identity:StudySubmissionIdentity;expected:StudySaveExpectation}
 | {state:'cancelled';identity:StudySubmissionIdentity}};
export interface StudySubmissionAcknowledgment {ok:true;scope:JourneyScope;actorId:number;identity:StudySubmissionIdentity;state:'committed'|'cancelled';acknowledged:true}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,k:string[])=>Object.keys(v).length===k.length&&k.every(key=>Object.hasOwn(v,key));
function identity(raw:unknown):StudySubmissionIdentity {
 if(!record(raw)||!keys(raw,['id','commandId','requestFingerprint'])||!journeyId(raw.id)||typeof raw.commandId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(raw.commandId)||!journeyHash(raw.requestFingerprint))throw Error('invalid_study_submission_identity');
 return {id:raw.id,commandId:raw.commandId,requestFingerprint:raw.requestFingerprint};
}
function scopeMatches(raw:unknown,scope:JourneyScope){return record(raw)&&keys(raw,['patientId','orthoCaseId','clinicalCaseId'])&&(['patientId','orthoCaseId','clinicalCaseId'] as const).every(k=>journeyId(scope[k])&&raw[k]===scope[k]);}
export async function verifyStudySubmissionRecovery(raw:unknown,scope:JourneyScope,actorId:number):Promise<StudySubmissionRecovery>{
 if(!record(raw)||!keys(raw,['ok','actorId','scope','recovery'])||raw.ok!==true||raw.actorId!==actorId||!journeyId(actorId)||!scopeMatches(raw.scope,scope))throw Error('invalid_study_submission_recovery');
 const r=raw.recovery;if(r===null)return {ok:true,actorId,scope,recovery:null};
 if(!record(r))throw Error('invalid_study_submission_recovery');
 if(r.state==='blocked'){
  if(!keys(r,['state','identity','canCancel'])||typeof r.canCancel!=='boolean'||r.canCancel!==(r.identity!==null))throw Error('invalid_study_submission_recovery');
  return {ok:true,actorId,scope,recovery:{state:'blocked',identity:r.identity===null?null:identity(r.identity),canCancel:r.canCancel}};
 }
 const id=identity(r.identity);
 if(r.state==='cancelled'&&keys(r,['state','identity']))return {ok:true,actorId,scope,recovery:{state:'cancelled',identity:id}};
 if(!['pending','committed'].includes(String(r.state))||!keys(r,['state','identity','expected'])||!record(r.expected)||!keys(r.expected,['scope','actorId','previousVersion','command'])||!scopeMatches(r.expected.scope,scope)||r.expected.actorId!==actorId||!Number.isSafeInteger(r.expected.previousVersion)||(r.expected.previousVersion as number)<0)throw Error('invalid_study_submission_recovery');
 const c=checkStudySaveCommand(r.expected.command);if(!c.ok||c.value.clientRequestId!==id.commandId||await studyBrowserHash(c.value)!==id.requestFingerprint||(c.value.expectedHead===null)!==(r.expected.previousVersion===0))throw Error('study_submission_fingerprint_changed');
 return {ok:true,actorId,scope,recovery:{state:r.state as 'pending'|'committed',identity:id,expected:{scope,actorId,previousVersion:r.expected.previousVersion as number,command:c.value}}};
}
export async function verifyStudySubmissionAcknowledgment(raw:unknown,scope:JourneyScope,actorId:number,command:StudySaveCommand):Promise<boolean>{
 if(!record(raw)||!keys(raw,['ok','scope','actorId','identity','state','acknowledged'])||raw.ok!==true||raw.acknowledged!==true||raw.actorId!==actorId||!scopeMatches(raw.scope,scope)||raw.state!=='committed')return false;
 const id=identity(raw.identity);return id.commandId===command.clientRequestId&&id.requestFingerprint===await studyBrowserHash(command);
}
export const readStudySubmissionIdentity=identity;

/** Unlike older journey writers, first-arrival study intents bind the exact
 * actor and clinical bridge that the author reviewed before pressing Save. */
export function parseStudySubmissionBody(raw:unknown):{patientId:number;clinicalCaseId:number;actorId:number;command:unknown}|null{
 if(!record(raw)||!keys(raw,['patientId','clinicalCaseId','actorId','command'])||!journeyId(raw.patientId)||!journeyId(raw.clinicalCaseId)||!journeyId(raw.actorId))return null;
 return {patientId:raw.patientId,clinicalCaseId:raw.clinicalCaseId,actorId:raw.actorId,command:raw.command};
}
