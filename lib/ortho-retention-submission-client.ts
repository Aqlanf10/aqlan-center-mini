import { canonicalJourneyJSON } from './ortho-case-journey-json';
import { verifyRetentionReceipt } from './ortho-retention-client';
import type {JourneyScope} from './ortho-case-journey-records';
import { retentionSubmissionHash, readRetentionSubmissionIdentity, verifyRetentionSubmissionRecovery, type RetentionSubmissionIdentity, type RetentionSubmissionRecovery } from './ortho-retention-client-contract';
import type { RetentionPersistenceCommand } from './ortho-retention-command';

export interface RetentionSaveExpectation { scope: JourneyScope; actorId: number; command: RetentionPersistenceCommand }
export interface RetentionSubmissionContext { scope: JourneyScope; actorId: number; current(): boolean; deny(status?: number): void }
type Identity = Pick<RetentionSubmissionIdentity, 'commandId' | 'requestFingerprint'> & { id?: number };
const endpoint = (scope: JourneyScope) => `/api/ortho/${scope.orthoCaseId}/retention-ledger/recovery`;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v,k));
type Guard = Pick<RetentionSubmissionContext,'current'|'deny'>;
function current(context: Guard) { if (!context.current()) throw Error('retention_submission_stale'); }
async function responseJSON(response: Response, context: Guard, statuses: number[]) {
 current(context);
 if ([401,403].includes(response.status)) { context.deny(response.status); throw Error('retention_submission_denied'); }
 if (response.redirected || !statuses.includes(response.status) || !response.headers.get('cache-control')?.split(',').some(v=>v.trim().toLowerCase()==='no-store')) throw Error('retention_submission_unconfirmed');
 const text=await response.text(); current(context);
 if(new TextEncoder().encode(text).length>4*1024*1024)throw Error('retention_response_limit');
 return JSON.parse(text) as unknown;
}
/** The authenticated metadata endpoint supplies actor and clinical bridge before
 * image access is requested. Never infer either identity from browser state. */
export async function bootstrapRetentionRecovery(owner:Pick<JourneyScope,'patientId'|'orthoCaseId'>,guard:Guard,signal?:AbortSignal):Promise<RetentionSubmissionRecovery>{
 current(guard);
 const response=await fetch(`/api/ortho/${owner.orthoCaseId}/retention-ledger/recovery?patientId=${owner.patientId}`,{credentials:'same-origin',cache:'no-store',signal});
 const raw=await responseJSON(response,guard,[200]);
 const id=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>0&&v<=2147483647;
 if(!record(raw)||!keys(raw,['ok','actorId','scope','recovery'])||raw.ok!==true||!id(raw.actorId)||!record(raw.scope)||!keys(raw.scope,['patientId','orthoCaseId','clinicalCaseId'])||!id(owner.patientId)||!id(owner.orthoCaseId)||raw.scope.patientId!==owner.patientId||raw.scope.orthoCaseId!==owner.orthoCaseId||!id(raw.scope.clinicalCaseId))throw Error('invalid_retention_recovery_binding');
 const scope={...owner,clinicalCaseId:raw.scope.clinicalCaseId};
 const verified=await verifyRetentionSubmissionRecovery(raw,scope,raw.actorId);current(guard);return verified;
}
export async function fetchRetentionRecovery(context: RetentionSubmissionContext, signal?: AbortSignal): Promise<RetentionSubmissionRecovery['recovery']> {
 current(context);
 const response=await fetch(`${endpoint(context.scope)}?patientId=${context.scope.patientId}`,{credentials:'same-origin',cache:'no-store',signal});
 const receipt=await verifyRetentionSubmissionRecovery(await responseJSON(response,context,[200]),context.scope,context.actorId);
 current(context);return receipt.recovery;
}
export function verifyRetentionTransition(raw:unknown,context:Pick<RetentionSubmissionContext,'scope'|'actorId'>,expected:Identity,state:'committed'|'cancelled',acknowledged:boolean|'either') {
 if(!record(raw)||!keys(raw,['ok','scope','actorId','identity','state','acknowledged'])||raw.ok!==true||raw.actorId!==context.actorId||raw.state!==state||typeof raw.acknowledged!=='boolean'||acknowledged!=='either'&&raw.acknowledged!==acknowledged||canonicalJourneyJSON(raw.scope)!==canonicalJourneyJSON(context.scope))throw Error('invalid_retention_transition');
 const identity=readRetentionSubmissionIdentity(raw.identity);
 if(identity.commandId!==expected.commandId||identity.requestFingerprint!==expected.requestFingerprint||expected.id!==undefined&&identity.id!==expected.id)throw Error('retention_submission_identity_changed');
 return identity;
}
async function transition(context:RetentionSubmissionContext,identity:Identity,action:'cancel'|'acknowledge',signal?:AbortSignal){
 current(context);const response=await fetch(endpoint(context.scope),{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},signal,
 body:JSON.stringify({patientId:context.scope.patientId,clinicalCaseId:context.scope.clinicalCaseId,actorId:context.actorId,commandId:identity.commandId,requestFingerprint:identity.requestFingerprint,action})});
 return responseJSON(response,context,[200]);
}
export async function retentionCommandIdentity(command:RetentionPersistenceCommand):Promise<Identity>{return {commandId:command.clientRequestId,requestFingerprint:await retentionSubmissionHash(command)};}
/** Save response and acknowledgment must both verify before the view clears its
 * frozen request. No browser storage contains the clinical command. */
export async function submitRetentionAndAcknowledge(context:RetentionSubmissionContext,expected:RetentionSaveExpectation,knownIdentity?:RetentionSubmissionIdentity,signal?:AbortSignal){
 current(context);
 if(expected.actorId!==context.actorId||canonicalJourneyJSON(expected.scope)!==canonicalJourneyJSON(context.scope))throw Error('retention_submission_scope_changed');
 const identity={...await retentionCommandIdentity(expected.command),...(knownIdentity?{id:knownIdentity.id}:{})};current(context);
 if(knownIdentity&&(knownIdentity.commandId!==identity.commandId||knownIdentity.requestFingerprint!==identity.requestFingerprint))throw Error('retention_submission_identity_changed');
 const response=await fetch(`/api/ortho/${context.scope.orthoCaseId}/retention-ledger`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},signal,
 body:JSON.stringify({patientId:context.scope.patientId,clinicalCaseId:context.scope.clinicalCaseId,actorId:context.actorId,command:expected.command})});
 const raw=await responseJSON(response,context,[200,201]);
 const revision=await verifyRetentionReceipt(raw,{scope:context.scope,actorId:context.actorId},expected.command,response.status);current(context);
 const acknowledgment=await transition(context,identity,'acknowledge',signal);current(context);
 verifyRetentionTransition(acknowledgment,context,identity,'committed',true);return revision;
}
/** Safe cancellation creates a server tombstone for an uncertain in-flight
 * command; it never removes a committed revision. */
export async function cancelRetentionAndAcknowledge(context:RetentionSubmissionContext,identity:Identity,alreadyCancelled=false,signal?:AbortSignal){
 current(context);let bound=identity;
 if(!alreadyCancelled){bound=verifyRetentionTransition(await transition(context,identity,'cancel',signal),context,identity,'cancelled','either');current(context);}
 const raw=await transition(context,bound,'acknowledge',signal);current(context);
 return verifyRetentionTransition(raw,context,bound,'cancelled',true);
}
