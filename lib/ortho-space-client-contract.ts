import {readSpacePersistenceCommand,type SpacePersistenceCommand} from './ortho-space-command';
import {canonicalJourneyJSON} from './ortho-case-journey-json';
export interface SpaceSubmissionExpectation {scope:JourneyScope;actorId:number;command:SpacePersistenceCommand}
export async function spaceSubmissionHash(value:unknown){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJourneyJSON(value))))].map(v=>v.toString(16).padStart(2,'0')).join('');}
import {journeyId,journeyHash,type JourneyScope} from './ortho-case-journey-records';
export interface SpaceSubmissionIdentity {id:number;commandId:string;requestFingerprint:string}
export type SpaceSubmissionRecovery = {ok:true;actorId:number;scope:JourneyScope;recovery:null
 | {state:'blocked';identity:SpaceSubmissionIdentity|null;canCancel:boolean}
 | {state:'pending'|'committed';identity:SpaceSubmissionIdentity;expected:SpaceSubmissionExpectation}
 | {state:'cancelled';identity:SpaceSubmissionIdentity}};
export interface SpaceSubmissionAcknowledgment {ok:true;scope:JourneyScope;actorId:number;identity:SpaceSubmissionIdentity;state:'committed'|'cancelled';acknowledged:true}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,k:string[])=>Object.keys(v).length===k.length&&k.every(key=>Object.hasOwn(v,key));
function identity(raw:unknown):SpaceSubmissionIdentity {
 if(!record(raw)||!keys(raw,['id','commandId','requestFingerprint'])||!journeyId(raw.id)||typeof raw.commandId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(raw.commandId)||!journeyHash(raw.requestFingerprint))throw Error('invalid_space_submission_identity');
 return {id:raw.id,commandId:raw.commandId,requestFingerprint:raw.requestFingerprint};
}
function scopeMatches(raw:unknown,scope:JourneyScope){return record(raw)&&keys(raw,['patientId','orthoCaseId','clinicalCaseId'])&&(['patientId','orthoCaseId','clinicalCaseId'] as const).every(k=>journeyId(scope[k])&&raw[k]===scope[k]);}
export async function verifySpaceSubmissionRecovery(raw:unknown,scope:JourneyScope,actorId:number):Promise<SpaceSubmissionRecovery>{
 if(!record(raw)||!keys(raw,['ok','actorId','scope','recovery'])||raw.ok!==true||raw.actorId!==actorId||!journeyId(actorId)||!scopeMatches(raw.scope,scope))throw Error('invalid_space_submission_recovery');
 const r=raw.recovery;if(r===null)return {ok:true,actorId,scope,recovery:null};
 if(!record(r))throw Error('invalid_space_submission_recovery');
 if(r.state==='blocked'){
  if(!keys(r,['state','identity','canCancel'])||typeof r.canCancel!=='boolean'||r.canCancel!==(r.identity!==null))throw Error('invalid_space_submission_recovery');
  return {ok:true,actorId,scope,recovery:{state:'blocked',identity:r.identity===null?null:identity(r.identity),canCancel:r.canCancel}};
 }
 const id=identity(r.identity);
 if(r.state==='cancelled'&&keys(r,['state','identity']))return {ok:true,actorId,scope,recovery:{state:'cancelled',identity:id}};
 if(!['pending','committed'].includes(String(r.state))||!keys(r,['state','identity','expected'])||!record(r.expected)||!keys(r.expected,['scope','actorId','command'])||!scopeMatches(r.expected.scope,scope)||r.expected.actorId!==actorId)throw Error('invalid_space_submission_recovery');
 const c=readSpacePersistenceCommand(r.expected.command);if(!c.ok||!c.value||canonicalJourneyJSON(c.value)!==canonicalJourneyJSON(r.expected.command)||c.value.clientRequestId!==id.commandId||await spaceSubmissionHash(c.value)!==id.requestFingerprint)throw Error('space_submission_fingerprint_changed');
 return {ok:true,actorId,scope,recovery:{state:r.state as 'pending'|'committed',identity:id,expected:{scope,actorId,command:c.value}}};
}
export const readSpaceSubmissionIdentity=identity;

/** Unlike older journey writers, first-arrival space intents bind the exact
 * actor and clinical bridge that the author reviewed before pressing Save. */
export function parseSpaceSubmissionBody(raw:unknown):{patientId:number;clinicalCaseId:number;actorId:number;command:unknown}|null{
 if(!record(raw)||!keys(raw,['patientId','clinicalCaseId','actorId','command'])||!journeyId(raw.patientId)||!journeyId(raw.clinicalCaseId)||!journeyId(raw.actorId))return null;
 const command=readSpacePersistenceCommand(raw.command);if(!command.ok)return null;
 return {patientId:raw.patientId,clinicalCaseId:raw.clinicalCaseId,actorId:raw.actorId,command:command.value};
}
