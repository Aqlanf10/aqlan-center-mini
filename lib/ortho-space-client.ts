/** Browser-side transport proofs. These do not replace server source authority. */
import {canonicalJourneyJSON} from './ortho-case-journey-json';
import {journeyId,journeyHash,type JourneyScope} from './ortho-case-journey-records';
import {readSpaceSavedContent,type SpaceSavedContent} from './ortho-space-saved';
import {projectIpr} from './ortho-space-ledger';
import {readSpacePersistenceCommand,type SpacePersistenceCommand} from './ortho-space-command';
import {readProblemSourceRef,type ProblemSourceRef} from './ortho-problem-sources';
import {decodeStrategyRevision,type StrategyRevision} from './ortho-treatment-strategy';
import {permitsOrthoDocumentation,orthoDocumentationContext} from './ortho-documentation-context';
import type {JourneyRevision} from './ortho-case-journey-history';
export type SpaceRevision=JourneyRevision<SpaceSavedContent>;
export interface SpaceLedgerRead {ok:true;scope:JourneyScope;actorId:number;writable:boolean;headId:number|null;history:SpaceRevision[];ipr:Extract<ReturnType<typeof projectIpr>,{ok:true}>['value'];baselines:{ref:ProblemSourceRef;arch:'upper'|'lower';discrepancyMm:number;estimated:boolean}[];strategy:StrategyRevision|null;adjustments:{id:number;visitId:number;occurredOn:string;recordedBy:string}[]}
export const spaceRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const spaceKeys=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k))&&Object.getOwnPropertySymbols(v).length===0;
export function spaceScopeMatches(raw:unknown,scope:JourneyScope){return spaceRecord(raw)&&spaceKeys(raw,['patientId','orthoCaseId','clinicalCaseId'])&&(['patientId','orthoCaseId','clinicalCaseId'] as const).every(k=>journeyId(scope[k])&&raw[k]===scope[k]);}
export async function spaceHash(value:unknown){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJourneyJSON(value))))].map(v=>v.toString(16).padStart(2,'0')).join('');}
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max;
const day=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const dense=(v:unknown,max:number):v is unknown[]=>Array.isArray(v)&&v.length<=max&&Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i)).every(Boolean);
export async function readSpaceRevision(raw:unknown,scope:JourneyScope):Promise<SpaceRevision|null>{
 if(!spaceRecord(raw)||!spaceKeys(raw,['patientId','orthoCaseId','clinicalCaseId','id','recordedPatientId','schemaVersion','version','predecessorId','createdBy','createdAt','reason','recordingContext','caseStatusAtCapture','contentHash','content'])||!journeyId(raw.id)||raw.patientId!==scope.patientId||raw.orthoCaseId!==scope.orthoCaseId||raw.clinicalCaseId!==scope.clinicalCaseId||raw.recordedPatientId!==scope.patientId||raw.schemaVersion!==1||!journeyId(raw.version)||raw.predecessorId!==null&&!journeyId(raw.predecessorId)||!text(raw.createdBy,200)||!text(raw.reason,500)||typeof raw.createdAt!=='string'||!Number.isFinite(Date.parse(raw.createdAt))||!journeyHash(raw.contentHash)||!permitsOrthoDocumentation(raw.caseStatusAtCapture)||raw.recordingContext!==orthoDocumentationContext(raw.caseStatusAtCapture))return null;
 const content=readSpaceSavedContent(raw.content);if(!content.ok||await spaceHash(content.value)!==raw.contentHash||await spaceHash(raw.content)!==raw.contentHash)return null;
 // Performed IPR cannot be captured during assessment; plans may be.
 // Match the persisted entry-kind/status constraint without rewriting history.
 if(content.value.authored.kind==='ipr'&&raw.caseStatusAtCapture==='assessment')return null;
 if(content.value.adjustment&&!day(content.value.adjustment.occurredOn))return null;
 return {...raw,content:content.value} as SpaceRevision;
}
/** Full contiguous lineage and independently reconstructed IPR projection. */
export async function verifySpaceRead(raw:unknown,patientId:number,orthoCaseId:number,binding?:{scope:JourneyScope;actorId:number}):Promise<SpaceLedgerRead|null>{
 try{
 if(!spaceRecord(raw)||!spaceKeys(raw,['ok','scope','actorId','writable','headId','history','ipr','baselines','strategy','adjustments'])||raw.ok!==true||!journeyId(patientId)||!journeyId(orthoCaseId)||!spaceRecord(raw.scope)||!journeyId(raw.scope.clinicalCaseId)||!journeyId(raw.actorId)||typeof raw.writable!=='boolean'||!dense(raw.history,1000)||!dense(raw.baselines,128)||!dense(raw.adjustments,128))return null;
 const scope={patientId,orthoCaseId,clinicalCaseId:raw.scope.clinicalCaseId};if(!spaceScopeMatches(raw.scope,scope)||binding&&(!spaceScopeMatches(binding.scope,scope)||raw.actorId!==binding.actorId))return null;
 const history:SpaceRevision[]=[];for(const item of raw.history){const revision=await readSpaceRevision(item,scope);if(!revision)return null;history.push(revision);}
 if(new Set(history.map(h=>h.id)).size!==history.length||raw.headId!==(history[0]?.id??null)||history.some((h,i)=>h.version!==history.length-i||h.predecessorId!==(history[i+1]?.id??null)))return null;
 const projection=projectIpr(history.map(h=>({id:h.id,version:h.version,content:h.content.authored})));if(!projection.ok||canonicalJourneyJSON(projection.value)!==canonicalJourneyJSON(raw.ipr))return null;
 const baselines:SpaceLedgerRead['baselines']=[];for(const b of raw.baselines){if(!spaceRecord(b)||!spaceKeys(b,['ref','arch','discrepancyMm','estimated'])||!['upper','lower'].includes(String(b.arch))||typeof b.discrepancyMm!=='number'||!Number.isFinite(b.discrepancyMm)||typeof b.estimated!=='boolean')return null;const ref=readProblemSourceRef(b.ref);if(!ref||ref.kind!=='assessment_analysis')return null;baselines.push({ref:{...ref},arch:b.arch as 'upper'|'lower',discrepancyMm:b.discrepancyMm,estimated:b.estimated});}
 if(new Set(baselines.map(b=>canonicalJourneyJSON(b.ref))).size!==baselines.length||new Set(baselines.map(b=>b.ref.id)).size>1)return null;
 let strategy:StrategyRevision|null=null;if(raw.strategy!==null){const s=decodeStrategyRevision(raw.strategy,scope);if(!s.ok||canonicalJourneyJSON(s.value)!==canonicalJourneyJSON(raw.strategy)||s.value.recordedPatientId!==patientId)return null;strategy=s.value;}
 const adjustments:SpaceLedgerRead['adjustments']=[];for(const a of raw.adjustments){if(!spaceRecord(a)||!spaceKeys(a,['id','visitId','occurredOn','recordedBy'])||!journeyId(a.id)||!journeyId(a.visitId)||!day(a.occurredOn)||!text(a.recordedBy,200))return null;adjustments.push({id:a.id,visitId:a.visitId,occurredOn:a.occurredOn,recordedBy:a.recordedBy});}
 if(new Set(adjustments.map(a=>a.id)).size!==adjustments.length)return null;
 for(const h of history){const c=h.content.authored;if(c.kind==='ipr'&&!adjustments.some(a=>a.id===c.adjustmentId&&a.visitId===h.content.adjustment?.visitId))return null;}
 return {ok:true,scope,actorId:raw.actorId,writable:raw.writable,headId:history[0]?.id??null,history,ipr:projection.value,baselines,strategy,adjustments};
 }catch{return null;}
}
export async function verifySpaceReceipt(raw:unknown,binding:{scope:JourneyScope;actorId:number},command:SpacePersistenceCommand,status:number):Promise<SpaceRevision>{
 const checked=readSpacePersistenceCommand(command);
 if(!checked.ok||canonicalJourneyJSON(checked.value)!==canonicalJourneyJSON(command)||!spaceRecord(raw)||!spaceKeys(raw,['ok','actorId','scope','replayed','revision','entryId','commandId','requestFingerprint'])||raw.ok!==true||!journeyId(binding.actorId)||raw.actorId!==binding.actorId||!spaceScopeMatches(raw.scope,binding.scope)||typeof raw.replayed!=='boolean'||status!==(raw.replayed?200:201)||raw.commandId!==command.clientRequestId||raw.requestFingerprint!==await spaceHash(command))throw Error('invalid_space_receipt');
 const revision=await readSpaceRevision(raw.revision,binding.scope);
 if(!revision||raw.entryId!==revision.id||revision.id===revision.predecessorId||(command.expectedHeadId===null?revision.version!==1:revision.version<2)||revision.predecessorId!==command.expectedHeadId||revision.reason!==command.reason||canonicalJourneyJSON(revision.content.authored)!==canonicalJourneyJSON(command.content)||command.schemaVersion===2&&canonicalJourneyJSON(revision.content.adjustment)!==canonicalJourneyJSON(command.expectedSession))throw Error('invalid_space_receipt');
 return revision;
}
