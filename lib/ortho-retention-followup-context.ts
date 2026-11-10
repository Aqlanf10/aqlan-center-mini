import type {RetentionLedgerRead} from './ortho-retention-client';
import type {RetentionEventArch} from './ortho-retention-events';
import type {OccurrenceEvidence} from './ortho-case-occurrence';
import {projectSavedRetentionInstructions} from './ortho-retention-instructions';
import {assertRetentionData} from './ortho-retention-data';
import {readOccurrenceEvidence} from './ortho-case-occurrence';
import {journeyId} from './ortho-case-journey-records';

type Timing=Pick<OccurrenceEvidence,'occurredOn'|'dateProvenance'>;
export type RetentionFollowupContext={state:'unavailable'}|{
 state:'available'; headId:number|null;
 instructionState:'not_recorded'|'recorded'|'ambiguous'; earliestRecordedDate:string|null;
 sourceEvidence:'none'|'matched'|'unverified'|'mismatch';
 instructions:{eventId:number;arch:RetentionEventArch;deviceId:number|null;timing:Timing;retrospective:boolean;
  dueOn:string|null;intervalDays:number|null;resolvedDate:string|null;ambiguityReasons:string[]}[];
 devices:{deviceId:number;arch:RetentionEventArch;
  reviews:{eventId:number;timing:Timing;retrospective:boolean}[]}[];
};
export const RETENTION_FOLLOWUP_CONTEXT_LIMITS=Object.freeze({cases:100,items:200,bytes:65536});
/** Strict output allowlist for print projection; unknown nested source fields
 * are refused rather than copied from an accidentally expanded board DTO. */
export function readRetentionFollowupContext(raw:unknown):RetentionFollowupContext|null{
 try{
  assertRetentionData(raw,10000);
  const object=(v:unknown,keys:string[]):Record<string,unknown>=>{
   if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw Error('invalid_context');
   return v as Record<string,unknown>;
  };
  const array=(v:unknown):unknown[]=>{if(!Array.isArray(v)||v.length>RETENTION_FOLLOWUP_CONTEXT_LIMITS.items)throw Error('invalid_context');return v;};
  const oneOf=(v:unknown,values:readonly string[])=>typeof v==='string'&&values.includes(v);
  const day=(v:unknown)=>{if(v!==null)readOccurrenceEvidence({occurredOn:v,dateProvenance:'contemporaneous_record',sourceNote:''});};
  const timing=(v:unknown)=>{const t=object(v,['occurredOn','dateProvenance']);readOccurrenceEvidence({...t,sourceNote:''});};
  const r=raw as Record<string,unknown>;
  if(r?.state==='unavailable'){object(r,['state']);return {state:'unavailable'};}
  object(r,['state','headId','instructionState','earliestRecordedDate','sourceEvidence','instructions','devices']);
  if(r.state!=='available'||r.headId!==null&&!journeyId(r.headId)||!oneOf(r.instructionState,['not_recorded','recorded','ambiguous'])||!oneOf(r.sourceEvidence,['none','matched','unverified','mismatch']))return null;
  day(r.earliestRecordedDate);
  const instructions=array(r.instructions),devices=array(r.devices);let count=instructions.length+devices.length;
  for(const value of instructions){
   const i=object(value,['eventId','arch','deviceId','timing','retrospective','dueOn','intervalDays','resolvedDate','ambiguityReasons']);
   if(!journeyId(i.eventId)||!oneOf(i.arch,['upper','lower','legacy_unknown'])||i.deviceId!==null&&!journeyId(i.deviceId)||typeof i.retrospective!=='boolean'||i.intervalDays!==null&&(!Number.isInteger(i.intervalDays)||Number(i.intervalDays)<1||Number(i.intervalDays)>3650))return null;
   timing(i.timing);day(i.dueOn);day(i.resolvedDate);
   if(array(i.ambiguityReasons).some(s=>!oneOf(s,['interval_anchor_unknown','interval_date_out_of_range','conflicting_timing','due_precedes_instruction','arch_unknown','overlapping_instructions','device_state_requires_reconciliation','device_arch_changed','device_replaced_requires_reconciliation'])))return null;
  }
  for(const value of devices){const d=object(value,['deviceId','arch','reviews']);if(!journeyId(d.deviceId)||!oneOf(d.arch,['upper','lower','legacy_unknown']))return null;
   const reviews=array(d.reviews);count+=reviews.length;
   for(const value of reviews){const v=object(value,['eventId','timing','retrospective']);if(!journeyId(v.eventId)||typeof v.retrospective!=='boolean')return null;timing(v.timing);}
  }
  const serialized=JSON.stringify(r);
  if(count>RETENTION_FOLLOWUP_CONTEXT_LIMITS.items||new TextEncoder().encode(serialized).length>RETENTION_FOLLOWUP_CONTEXT_LIMITS.bytes)return null;
  return JSON.parse(serialized) as RetentionFollowupContext;
 }catch{return null;}
}
/** Documentary summary of an already authorized, fully verified ledger. No
 * notes, image references, treatment findings or raw source JSON leave here.
 * Reviews never fulfill an instruction; unknown dates remain explicit. */
export function projectRetentionFollowupContext(data:RetentionLedgerRead):RetentionFollowupContext{
 const saved=projectSavedRetentionInstructions(data);
 if(!saved.ok)return {state:'unavailable'};
 const revisions=new Map(data.history.map(r=>[r.id,r]));
 const timing=(value:OccurrenceEvidence):Timing=>({occurredOn:value.occurredOn,dateProvenance:value.dateProvenance});
 const retrospective=(id:number)=>revisions.get(id)?.recordingContext==='retrospective';
 const instructions=saved.projection.intents.map(i=>({eventId:i.eventId,arch:i.arch,deviceId:i.deviceId,
  timing:timing(i.occurrence),retrospective:retrospective(i.eventId),dueOn:i.dueOn,intervalDays:i.intervalDays,
  resolvedDate:i.dueDate,ambiguityReasons:[...i.ambiguityReasons]}));
 const devices=data.devices.map(d=>({deviceId:d.deviceId,arch:d.arch,reviews:data.currentEvents.flatMap(r=>
  r.content.kind==='device_review'&&r.content.device.deviceId===d.deviceId
   ?[{eventId:r.id,timing:timing(r.content.occurrence),retrospective:retrospective(r.id)}]:[])}));
 if(instructions.length+devices.length+devices.reduce((n,d)=>n+d.reviews.length,0)>RETENTION_FOLLOWUP_CONTEXT_LIMITS.items)return {state:'unavailable'};
 const evidence=data.sourceMatches.map(s=>s.identityMatch);
 const result:RetentionFollowupContext={state:'available',headId:saved.headId,
  instructionState:saved.projection.state as 'not_recorded'|'recorded'|'ambiguous',earliestRecordedDate:saved.projection.dueDate,
  sourceEvidence:!evidence.length?'none':evidence.includes(false)?'mismatch':evidence.includes(null)?'unverified':'matched',instructions,devices};
 return new TextEncoder().encode(JSON.stringify(result)).length>RETENTION_FOLLOWUP_CONTEXT_LIMITS.bytes?{state:'unavailable'}:result;
}
