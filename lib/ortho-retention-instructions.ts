import type {RetentionLedgerRead} from './ortho-retention-client';
import type {JourneyScope} from './ortho-case-journey-records';
import {readSavedRetentionLedgerContext} from './ortho-retention-saved-context';
import {projectRetentionRecall,type RetentionRecallProjection} from './ortho-retention-recall';
export type SavedRetentionInstructions = {
 ok:true;scope:JourneyScope;actorId:number;headId:number|null;headVersion:number|null;headHash:string|null;
 projection:RetentionRecallProjection;sourceMatches:RetentionLedgerRead['sourceMatches'];
}|{ok:false;code:'retention_instruction_history_invalid'};
/** Presentation adapter for an ALREADY verified authorized ledger read. These
 * consistency checks are not another cryptographic or server authority proof.
 * Uses complete immutable history, never a draft or current-events subset.
 * Document identity evidence is retained separately: recall timing does not
 * assess sourceMatches and cannot turn a mismatched source into verified proof. */
export function projectSavedRetentionInstructions(data:RetentionLedgerRead):SavedRetentionInstructions{
 const invalid:SavedRetentionInstructions={ok:false,code:'retention_instruction_history_invalid'};
 try{
  const context=readSavedRetentionLedgerContext(data);if(!context)return invalid;
  const projection=projectRetentionRecall(context.records);
  if(projection.state==='invalid')return invalid;
  return {ok:true,...context.binding,projection};
 }catch{return invalid;}
}
