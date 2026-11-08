import type {JourneyScope} from './ortho-case-journey-records';
import type {SpacePersistenceCommand as SpaceCommand} from './ortho-space-command';
export interface SpaceSubmissionIdentity {id:number;commandId:string;requestFingerprint:string}
export interface SpaceSubmissionExpectation {scope:JourneyScope;actorId:number;command:SpaceCommand}
export type SpaceSubmissionRecovery={ok:true;actorId:number;scope:JourneyScope;recovery:null
 |{state:'blocked';identity:SpaceSubmissionIdentity|null;canCancel:boolean}
 |{state:'pending'|'committed';identity:SpaceSubmissionIdentity;expected:SpaceSubmissionExpectation}
 |{state:'cancelled';identity:SpaceSubmissionIdentity}};
export interface SpaceSubmissionAcknowledgment {ok:true;scope:JourneyScope;actorId:number;identity:SpaceSubmissionIdentity;state:'committed'|'cancelled';acknowledged:true}
