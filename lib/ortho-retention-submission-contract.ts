import type {JourneyScope} from './ortho-case-journey-records';
import type {RetentionPersistenceCommand as RetentionCommand} from './ortho-retention-command';
export interface RetentionSubmissionIdentity {id:number;commandId:string;requestFingerprint:string}
export interface RetentionSubmissionExpectation {scope:JourneyScope;actorId:number;command:RetentionCommand}
export type RetentionSubmissionRecovery={ok:true;actorId:number;scope:JourneyScope;recovery:null
 |{state:'blocked';identity:RetentionSubmissionIdentity|null;canCancel:boolean}
 |{state:'pending'|'committed';identity:RetentionSubmissionIdentity;expected:RetentionSubmissionExpectation}
 |{state:'cancelled';identity:RetentionSubmissionIdentity}};
export interface RetentionSubmissionAcknowledgment {ok:true;scope:JourneyScope;actorId:number;identity:RetentionSubmissionIdentity;state:'committed'|'cancelled';acknowledged:true}
