import {readFacialCommand,type FacialCommand} from './ortho-facial-analysis';
import {canonicalJourneyJSON} from './ortho-case-journey-json';
export interface FacialSubmissionExpectation {scope:JourneyScope;actorId:number;command:FacialCommand;previousVersion:number}
export async function facialSubmissionHash(value:unknown){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJourneyJSON(value))))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function checkFacialCommand(raw:unknown){try{return {ok:true as const,value:readFacialCommand(raw)};}catch{return {ok:false as const};}}
import {journeyId,journeyHash,type JourneyScope} from './ortho-case-journey-records';
export interface FacialSubmissionIdentity {id:number;commandId:string;requestFingerprint:string}
export type FacialSubmissionRecovery = {ok:true;actorId:number;scope:JourneyScope;recovery:null
 | {state:'blocked';identity:FacialSubmissionIdentity|null;canCancel:boolean}
 | {state:'pending'|'committed';identity:FacialSubmissionIdentity;expected:FacialSubmissionExpectation}
 | {state:'cancelled';identity:FacialSubmissionIdentity}};
export interface FacialSubmissionAcknowledgment {ok:true;scope:JourneyScope;actorId:number;identity:FacialSubmissionIdentity;state:'committed'|'cancelled';acknowledged:true}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,k:string[])=>Object.keys(v).length===k.length&&k.every(key=>Object.hasOwn(v,key));
function identity(raw:unknown):FacialSubmissionIdentity {
 if(!record(raw)||!keys(raw,['id','commandId','requestFingerprint'])||!journeyId(raw.id)||typeof raw.commandId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(raw.commandId)||!journeyHash(raw.requestFingerprint))throw Error('invalid_facial_submission_identity');
 return {id:raw.id,commandId:raw.commandId,requestFingerprint:raw.requestFingerprint};
}
function scopeMatches(raw:unknown,scope:JourneyScope){return record(raw)&&keys(raw,['patientId','orthoCaseId','clinicalCaseId'])&&(['patientId','orthoCaseId','clinicalCaseId'] as const).every(k=>journeyId(scope[k])&&raw[k]===scope[k]);}
export async function verifyFacialSubmissionRecovery(raw:unknown,scope:JourneyScope,actorId:number):Promise<FacialSubmissionRecovery>{
 if(!record(raw)||!keys(raw,['ok','actorId','scope','recovery'])||raw.ok!==true||raw.actorId!==actorId||!journeyId(actorId)||!scopeMatches(raw.scope,scope))throw Error('invalid_facial_submission_recovery');
 const r=raw.recovery;if(r===null)return {ok:true,actorId,scope,recovery:null};
 if(!record(r))throw Error('invalid_facial_submission_recovery');
 if(r.state==='blocked'){
  if(!keys(r,['state','identity','canCancel'])||typeof r.canCancel!=='boolean'||r.canCancel!==(r.identity!==null))throw Error('invalid_facial_submission_recovery');
  return {ok:true,actorId,scope,recovery:{state:'blocked',identity:r.identity===null?null:identity(r.identity),canCancel:r.canCancel}};
 }
 const id=identity(r.identity);
 if(r.state==='cancelled'&&keys(r,['state','identity']))return {ok:true,actorId,scope,recovery:{state:'cancelled',identity:id}};
 if(!['pending','committed'].includes(String(r.state))||!keys(r,['state','identity','expected'])||!record(r.expected)||!keys(r.expected,['scope','actorId','previousVersion','command'])||!scopeMatches(r.expected.scope,scope)||r.expected.actorId!==actorId||!Number.isSafeInteger(r.expected.previousVersion)||(r.expected.previousVersion as number)<0)throw Error('invalid_facial_submission_recovery');
 const c=checkFacialCommand(r.expected.command);if(!c.ok||c.value.clientRequestId!==id.commandId||await facialSubmissionHash(c.value)!==id.requestFingerprint||(c.value.expectedHeadId===null)!==(r.expected.previousVersion===0))throw Error('facial_submission_fingerprint_changed');
 return {ok:true,actorId,scope,recovery:{state:r.state as 'pending'|'committed',identity:id,expected:{scope,actorId,previousVersion:r.expected.previousVersion as number,command:c.value}}};
}
export async function verifyFacialSubmissionAcknowledgment(raw:unknown,scope:JourneyScope,actorId:number,command:FacialCommand):Promise<boolean>{
 if(!record(raw)||!keys(raw,['ok','scope','actorId','identity','state','acknowledged'])||raw.ok!==true||raw.acknowledged!==true||raw.actorId!==actorId||!scopeMatches(raw.scope,scope)||raw.state!=='committed')return false;
 const id=identity(raw.identity);return id.commandId===command.clientRequestId&&id.requestFingerprint===await facialSubmissionHash(command);
}
export const readFacialSubmissionIdentity=identity;

/** Unlike older journey writers, first-arrival facial intents bind the exact
 * actor and clinical bridge that the author reviewed before pressing Save. */
export function parseFacialSubmissionBody(raw:unknown):{patientId:number;clinicalCaseId:number;actorId:number;command:unknown}|null{
 if(!record(raw)||!keys(raw,['patientId','clinicalCaseId','actorId','command'])||!journeyId(raw.patientId)||!journeyId(raw.clinicalCaseId)||!journeyId(raw.actorId))return null;
 return {patientId:raw.patientId,clinicalCaseId:raw.clinicalCaseId,actorId:raw.actorId,command:raw.command};
}
