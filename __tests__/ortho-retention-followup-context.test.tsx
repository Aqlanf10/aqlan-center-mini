import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {projectRetentionFollowupContext,readRetentionFollowupContext} from '../lib/ortho-retention-followup-context';
import {OrthoRetentionFollowupContext} from '../components/OrthoRetentionFollowupContext';
import {retentionHash,verifyRetentionRead} from '../lib/ortho-retention-client';
import {projectRetentionEventHistory,type RetentionEventRecord} from '../lib/ortho-retention-event-history';
import type {RetentionEvent} from '../lib/ortho-retention-events';
import {classifyFollowups,type FollowupCase} from '../lib/ortho-followup';
import {projectOrthoFollowupWorklist} from '../lib/ortho-followup-worklist-contract';
const occurrence=(date:string|null)=>({occurredOn:date,dateProvenance:date?'historical_source' as const:'unknown' as const,sourceNote:'PRIVATE_SOURCE_TEXT'});
const base={occurrence:occurrence('2026-01-01'),note:'PRIVATE_NOTE',documentIds:[]};
const delivery:RetentionEvent={...base,kind:'device_delivery',deviceType:'fixed',description:'PRIVATE_DEVICE',extent:'PRIVATE_EXTENT',labOrderId:null};
const intent=(deviceId:number,expectedDeviceRevisionId:number,dueOn:string|null='2026-03-01'):RetentionEvent=>({...base,kind:'followup_intent',device:{deviceId,expectedDeviceRevisionId},dueOn,intervalDays:dueOn?null:30,scope:'PRIVATE_SCOPE'});
const review=(deviceId:number,expectedDeviceRevisionId:number,date:string|null):RetentionEvent=>({...base,kind:'device_review',device:{deviceId,expectedDeviceRevisionId},occurrence:occurrence(date),observations:Object.fromEntries(['fit','breakage','loss','hygiene','adherence','relapse'].map(k=>[k,{state:'unknown',note:'PRIVATE_FINDING'}])) as Extract<RetentionEvent,{kind:'device_review'}>['observations']});
async function ledger(events:RetentionEvent[]){
 const records:RetentionEventRecord[]=events.map((content,i)=>({id:i+1,version:i+1,arch:'upper',supersedesEntryId:null,archCorrectionReason:null,content}));
 const history=await Promise.all([...records].reverse().map(async r=>{const content={arch:r.arch,supersedesEntryId:null,archCorrectionReason:null,payload:r.content};return {id:r.id,patientId:1,recordedPatientId:1,orthoCaseId:2,clinicalCaseId:3,schemaVersion:1,version:r.version,predecessorId:r.id===1?null:r.id-1,createdBy:'Synthetic',createdAt:'2026-11-01T00:00:00Z',reason:'Synthetic',recordingContext:'current',caseStatusAtCapture:'retention',contentHash:await retentionHash(content),content};}));
 const projection=projectRetentionEventHistory(records);if(!projection.ok)throw Error(projection.code);
 const data=await verifyRetentionRead({ok:true,scope:{patientId:1,orthoCaseId:2,clinicalCaseId:3},actorId:4,writable:true,headId:history[0]?.id??null,history,...projection.value,sourceMatches:[]},1,2);if(!data)throw Error('invalid_fixture');return data;
}
const row=(retentionContext:FollowupCase['retentionContext']):FollowupCase=>({caseId:2,patientId:1,patientName:'Synthetic',patientPhone:null,status:'retention',phase:'retention',startDate:'2020-01-01',lastAdjustmentDate:'2020-02-01',nextWeeks:4,upperWire:null,lowerWire:null,nextAppointment:null,lastWasNoShow:false,retentionContext,bookingContext:{verified:true,pastUnresolvedAppointment:null,reviewAppointments:[],otherAppointments:[]},attendanceContext:{basis:'current_status_scheduled_slot',outcome:'none',latestScheduledLocal:null,cutoff:{kind:'explicit_instant',instant:'2026-11-01T08:00:00.000Z',localDateTime:'2026-11-01T08:00:00.000000',timeZone:'UTC'}}});
it('keeps independent instructions for two devices in one arch and never fulfills them from later reviews',async()=>{
 const data=await ledger([delivery,delivery,intent(1,1),intent(2,2,'2026-04-01'),review(1,3,'2026-05-01'),review(2,4,null)]);
 const context=projectRetentionFollowupContext(data);
 expect(context).toMatchObject({state:'available',instructionState:'recorded',earliestRecordedDate:'2026-03-01',instructions:[{deviceId:1,resolvedDate:'2026-03-01'},{deviceId:2,resolvedDate:'2026-04-01'}],devices:[{deviceId:1,reviews:[{timing:{occurredOn:'2026-05-01'}}]},{deviceId:2,reviews:[{timing:{occurredOn:null,dateProvenance:'unknown'}}]}]});
 expect(JSON.stringify(context)).not.toContain('PRIVATE_');
 const classified=classifyFollowups({cases:[row(context)],today:'2026-11-01'})[0];
 expect(classified).toMatchObject({dueDate:null,dueBasis:'retention_schedule_unavailable',daysSinceLast:null,buckets:['no_appointment','retention']});
 const printed=projectOrthoFollowupWorklist([row(context)],{bucket:'retention',today:'2026-11-01',asOf:new Date('2026-11-01T08:00:00Z'),actorId:4,timeZone:'UTC'});
 expect(printed.rows[0].retentionContext).toEqual(context);
 expect(renderToStaticMarkup(<OrthoRetentionFollowupContext context={context}/>)).toContain('تعليمات ومراجعات التثبيت المسجلة');
 expect(renderToStaticMarkup(<OrthoRetentionFollowupContext context={context}/>)).not.toContain('<details open');
 const html=renderToStaticMarkup(<OrthoRetentionFollowupContext context={context} print/>);
 expect(html).toContain('<details open');expect(html).toContain('تاريخ غير معروف');expect(html).toContain('لا تُغلق تعليمة سابقة تلقائياً');expect(html).not.toContain('PRIVATE_');
});
it('preserves overlapping instructions and unknown anchors without selecting a plausible date',async()=>{
 const unknown={...intent(1,2,null),occurrence:occurrence(null)};
 const context=projectRetentionFollowupContext(await ledger([delivery,intent(1,1),unknown]));
 expect(context).toMatchObject({state:'available',instructionState:'ambiguous',earliestRecordedDate:null,instructions:[{ambiguityReasons:['overlapping_instructions']},{resolvedDate:null,ambiguityReasons:['interval_anchor_unknown','overlapping_instructions']}]});
 expect(renderToStaticMarkup(<OrthoRetentionFollowupContext context={context}/>)).toContain('تعليمات غير محسومة');
});
it('withholds truncated history and keeps empty distinct from unavailable',async()=>{
 const data=await ledger([delivery,intent(1,1)]);
 expect(projectRetentionFollowupContext({...data,history:data.history.slice(0,1)})).toEqual({state:'unavailable'});
 expect(projectRetentionFollowupContext(await ledger([]))).toMatchObject({state:'available',instructionState:'not_recorded'});
});
it('refuses nested source leakage in print DTO and copies accepted facts independently',async()=>{
 const context=projectRetentionFollowupContext(await ledger([delivery,intent(1,1)]));if(context.state!=='available')throw Error('fixture');
 expect(readRetentionFollowupContext(context)).toEqual(context);expect(readRetentionFollowupContext({...context,notes:'PRIVATE'})).toBeNull();
 const changed={...context,instructions:[{...context.instructions[0],timing:{...context.instructions[0].timing,sourceNote:'PRIVATE'}}]};
 expect(readRetentionFollowupContext(changed)).toBeNull();
 expect(()=>projectOrthoFollowupWorklist([row(changed)],{bucket:'retention',today:'2026-11-01',asOf:new Date('2026-11-01T08:00:00Z'),actorId:4,timeZone:'UTC'})).toThrow('invalid_retention_followup_context');
 const copy=readRetentionFollowupContext(context);if(copy?.state==='available')copy.instructions[0].dueOn=null;
 expect(context.instructions[0].dueOn).toBe('2026-03-01');
});
