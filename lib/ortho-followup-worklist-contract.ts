import {BUCKET_ORDER,classifyFollowups,groupByBucket,type FollowupBucket,type FollowupCase,type FollowupAttendanceContext,type NextAppointmentInfo} from './ortho-followup';
import {clinicDateString} from './schedule';
import {readRetentionFollowupContext} from './ortho-retention-followup-context';
export class OrthoFollowupWorklistError extends Error {constructor(readonly status:400|409,readonly code:string){super(code);}}
export type WorklistAppointment=Pick<NextAppointmentInfo,'id'|'date'|'time'|'status'>;
export interface OrthoFollowupWorklistRow {
 retentionContext?:FollowupCase['retentionContext'];
 patientId:number;caseId:number;patientName:string;status:'active'|'retention';phase:string;
 lastAdjustmentDate:string|null;dueDate:string|null;dueBasis:'adjustment_interval'|'retention_schedule_unavailable';
 nextAppointment:WorklistAppointment|null;pastUnresolvedAppointment:WorklistAppointment|null;
 reviewAppointmentCount:number;otherAppointmentCount:number;
 attendance:{outcome:FollowupAttendanceContext['outcome'];latestScheduledLocal:string|null;cutoffLocalDateTime:string};
}
export interface OrthoFollowupWorklist {bucket:FollowupBucket;today:string;asOf:string;timeZone:string;actorId:number;rows:OrthoFollowupWorklistRow[]}
const id=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const day=(v:unknown):v is string=>typeof v==='string'&&/^(?!0000)\d{4}-\d\d-\d\d$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const local=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/.test(v)&&day(v.slice(0,10));
function invalid(code='invalid_worklist'):never{throw new OrthoFollowupWorklistError(409,code);}
export function isFollowupWorklistBucket(v:unknown):v is FollowupBucket{return typeof v==='string'&&BUCKET_ORDER.includes(v as FollowupBucket);}
function appointment(value:NextAppointmentInfo|null):WorklistAppointment|null{
 if(value===null)return null;
 if(!value||!id(value.id)||!day(value.date)||!/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(value.time)||!['booked','arrived'].includes(value.status))invalid();
 return {id:value.id,date:value.date,time:value.time,status:value.status};
}
/** Uses canonical classification, then projects only the selected current cases.
 * Due dates may use the board's start-date/default interval fallback; they are
 * not universally a saved clinician instruction or evidence of a booking. */
export function projectOrthoFollowupWorklist(board:FollowupCase[],input:{bucket:unknown;today:string;asOf:Date;actorId:number;timeZone:string}):OrthoFollowupWorklist{
 if(!isFollowupWorklistBucket(input.bucket))throw new OrthoFollowupWorklistError(400,'invalid_worklist_bucket');
 if(!id(input.actorId)||!day(input.today)||!(input.asOf instanceof Date)||!Number.isFinite(input.asOf.getTime())||clinicDateString(input.asOf,input.timeZone)!==input.today)invalid();
 const seen=new Set<number>();
 // Validate classification inputs before running the unchanged classifier.
 for(const r of board){if(!id(r.caseId)||seen.has(r.caseId)||!id(r.patientId)||typeof r.patientName!=='string'||!r.patientName.trim()||r.patientName.length>1000||!['active','retention'].includes(r.status)||typeof r.phase!=='string'||r.phase.length>100||!day(r.startDate)||r.lastAdjustmentDate!==null&&!day(r.lastAdjustmentDate)||!Number.isInteger(r.nextWeeks)||r.nextWeeks<1||r.nextWeeks>52||typeof r.lastWasNoShow!=='boolean')invalid();seen.add(r.caseId);}
 const selected=groupByBucket(classifyFollowups({cases:board,today:input.today})).get(input.bucket)??[];
 if(selected.length>500)invalid('worklist_limit');
 const rows=selected.map(r=>{
  const b=r.bookingContext,a=r.attendanceContext;
  const retentionContext=r.retentionContext===undefined?undefined:readRetentionFollowupContext(r.retentionContext);
  if(retentionContext===null)invalid('invalid_retention_followup_context');
  if(!b||b.verified!==true||!Array.isArray(b.reviewAppointments)||!Array.isArray(b.otherAppointments)||!a||a.basis!=='current_status_scheduled_slot'||a.cutoff.kind!=='explicit_instant'||a.cutoff.instant!==input.asOf.toISOString()||a.cutoff.timeZone!==input.timeZone||!local(a.cutoff.localDateTime)||a.latestScheduledLocal!==null&&!local(a.latestScheduledLocal)||!['none','attendance','no_show','conflict'].includes(a.outcome))invalid();
  return {patientId:r.patientId,caseId:r.caseId,patientName:r.patientName,status:r.status,phase:r.phase,lastAdjustmentDate:r.lastAdjustmentDate,dueDate:r.dueDate,dueBasis:r.dueBasis,...(retentionContext?{retentionContext}:{}),nextAppointment:appointment(r.nextAppointment),pastUnresolvedAppointment:appointment(b.pastUnresolvedAppointment),reviewAppointmentCount:b.reviewAppointments.length,otherAppointmentCount:b.otherAppointments.length,attendance:{outcome:a.outcome,latestScheduledLocal:a.latestScheduledLocal,cutoffLocalDateTime:a.cutoff.localDateTime}};
 });
 const result={bucket:input.bucket,today:input.today,asOf:input.asOf.toISOString(),timeZone:input.timeZone,actorId:input.actorId,rows};
 if(new TextEncoder().encode(JSON.stringify(result)).length>1048576)invalid('worklist_limit');
 return result;
}
