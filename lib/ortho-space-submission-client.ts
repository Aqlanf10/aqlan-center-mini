import { canonicalJourneyJSON } from './ortho-case-journey-json';
import { verifySpaceReceipt } from './ortho-space-client';
import type {JourneyScope} from './ortho-case-journey-records';
import { spaceSubmissionHash, readSpaceSubmissionIdentity, verifySpaceSubmissionRecovery, type SpaceSubmissionIdentity, type SpaceSubmissionRecovery } from './ortho-space-client-contract';
import type { SpacePersistenceCommand } from './ortho-space-command';

export interface SpaceSaveExpectation { scope: JourneyScope; actorId: number; command: SpacePersistenceCommand }
export interface SpaceSubmissionContext { scope: JourneyScope; actorId: number; current(): boolean; deny(status?: number): void }
type Identity = Pick<SpaceSubmissionIdentity, 'commandId' | 'requestFingerprint'> & { id?: number };
const endpoint = (scope: JourneyScope) => `/api/ortho/${scope.orthoCaseId}/space-ledger/recovery`;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v,k));
type Guard = Pick<SpaceSubmissionContext,'current'|'deny'>;
function current(context: Guard) { if (!context.current()) throw Error('space_submission_stale'); }
async function responseJSON(response: Response, context: Guard, statuses: number[]) {
 current(context);
 if ([401,403].includes(response.status)) { context.deny(response.status); throw Error('space_submission_denied'); }
 if (response.redirected || !statuses.includes(response.status) || !response.headers.get('cache-control')?.split(',').some(v=>v.trim().toLowerCase()==='no-store')) throw Error('space_submission_unconfirmed');
 const text=await response.text(); current(context);
 if(new TextEncoder().encode(text).length>4*1024*1024)throw Error('space_response_limit');
 return JSON.parse(text) as unknown;
}
/** The authenticated metadata endpoint supplies actor and clinical bridge before
 * image access is requested. Never infer either identity from browser state. */
export async function bootstrapSpaceRecovery(owner:Pick<JourneyScope,'patientId'|'orthoCaseId'>,guard:Guard,signal?:AbortSignal):Promise<SpaceSubmissionRecovery>{
 current(guard);
 const response=await fetch(`/api/ortho/${owner.orthoCaseId}/space-ledger/recovery?patientId=${owner.patientId}`,{credentials:'same-origin',cache:'no-store',signal});
 const raw=await responseJSON(response,guard,[200]);
 const id=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>0&&v<=2147483647;
 if(!record(raw)||!keys(raw,['ok','actorId','scope','recovery'])||raw.ok!==true||!id(raw.actorId)||!record(raw.scope)||!keys(raw.scope,['patientId','orthoCaseId','clinicalCaseId'])||!id(owner.patientId)||!id(owner.orthoCaseId)||raw.scope.patientId!==owner.patientId||raw.scope.orthoCaseId!==owner.orthoCaseId||!id(raw.scope.clinicalCaseId))throw Error('invalid_space_recovery_binding');
 const scope={...owner,clinicalCaseId:raw.scope.clinicalCaseId};
 const verified=await verifySpaceSubmissionRecovery(raw,scope,raw.actorId);current(guard);return verified;
}
export async function fetchSpaceRecovery(context: SpaceSubmissionContext, signal?: AbortSignal): Promise<SpaceSubmissionRecovery['recovery']> {
 current(context);
 const response=await fetch(`${endpoint(context.scope)}?patientId=${context.scope.patientId}`,{credentials:'same-origin',cache:'no-store',signal});
 const receipt=await verifySpaceSubmissionRecovery(await responseJSON(response,context,[200]),context.scope,context.actorId);
 current(context);return receipt.recovery;
}
export function verifySpaceTransition(raw:unknown,context:Pick<SpaceSubmissionContext,'scope'|'actorId'>,expected:Identity,state:'committed'|'cancelled',acknowledged:boolean|'either') {
 if(!record(raw)||!keys(raw,['ok','scope','actorId','identity','state','acknowledged'])||raw.ok!==true||raw.actorId!==context.actorId||raw.state!==state||typeof raw.acknowledged!=='boolean'||acknowledged!=='either'&&raw.acknowledged!==acknowledged||canonicalJourneyJSON(raw.scope)!==canonicalJourneyJSON(context.scope))throw Error('invalid_space_transition');
 const identity=readSpaceSubmissionIdentity(raw.identity);
 if(identity.commandId!==expected.commandId||identity.requestFingerprint!==expected.requestFingerprint||expected.id!==undefined&&identity.id!==expected.id)throw Error('space_submission_identity_changed');
 return identity;
}
async function transition(context:SpaceSubmissionContext,identity:Identity,action:'cancel'|'acknowledge',signal?:AbortSignal){
 current(context);const response=await fetch(endpoint(context.scope),{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},signal,
 body:JSON.stringify({patientId:context.scope.patientId,clinicalCaseId:context.scope.clinicalCaseId,actorId:context.actorId,commandId:identity.commandId,requestFingerprint:identity.requestFingerprint,action})});
 return responseJSON(response,context,[200]);
}
export async function spaceCommandIdentity(command:SpacePersistenceCommand):Promise<Identity>{return {commandId:command.clientRequestId,requestFingerprint:await spaceSubmissionHash(command)};}
/** Save response and acknowledgment must both verify before the view clears its
 * frozen request. No browser storage contains the clinical command. */
export async function submitSpaceAndAcknowledge(context:SpaceSubmissionContext,expected:SpaceSaveExpectation,knownIdentity?:SpaceSubmissionIdentity,signal?:AbortSignal){
 current(context);
 if(expected.actorId!==context.actorId||canonicalJourneyJSON(expected.scope)!==canonicalJourneyJSON(context.scope))throw Error('space_submission_scope_changed');
 const identity={...await spaceCommandIdentity(expected.command),...(knownIdentity?{id:knownIdentity.id}:{})};current(context);
 if(knownIdentity&&(knownIdentity.commandId!==identity.commandId||knownIdentity.requestFingerprint!==identity.requestFingerprint))throw Error('space_submission_identity_changed');
 const response=await fetch(`/api/ortho/${context.scope.orthoCaseId}/space-ledger`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},signal,
 body:JSON.stringify({patientId:context.scope.patientId,clinicalCaseId:context.scope.clinicalCaseId,actorId:context.actorId,command:expected.command})});
 const raw=await responseJSON(response,context,[200,201]);
 const revision=await verifySpaceReceipt(raw,{scope:context.scope,actorId:context.actorId},expected.command,response.status);current(context);
 const acknowledgment=await transition(context,identity,'acknowledge',signal);current(context);
 verifySpaceTransition(acknowledgment,context,identity,'committed',true);return revision;
}
/** Safe cancellation creates a server tombstone for an uncertain in-flight
 * command; it never removes a committed revision. */
export async function cancelSpaceAndAcknowledge(context:SpaceSubmissionContext,identity:Identity,alreadyCancelled=false,signal?:AbortSignal){
 current(context);let bound=identity;
 if(!alreadyCancelled){bound=verifySpaceTransition(await transition(context,identity,'cancel',signal),context,identity,'cancelled','either');current(context);}
 const raw=await transition(context,bound,'acknowledge',signal);current(context);
 return verifySpaceTransition(raw,context,bound,'cancelled',true);
}
