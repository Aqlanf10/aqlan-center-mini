import {it,expect} from 'vitest';
import {projectOrthoFollowupWorklist} from '../lib/ortho-followup-worklist-contract';
import {classifyFollowups,groupByBucket,type FollowupCase} from '../lib/ortho-followup';
const asOf=new Date('2026-11-06T09:00:00.000Z'),today='2026-11-06',zone='Asia/Aden';
const row:FollowupCase={caseId:1,patientId:2,patientName:'Synthetic <script>',patientPhone:'PRIVATE PHONE',status:'active',phase:'alignment',startDate:'2026-10-01',lastAdjustmentDate:null,nextWeeks:4,upperWire:'PRIVATE WIRE',lowerWire:null,nextAppointment:null,bookingContext:{verified:true,pastUnresolvedAppointment:null,reviewAppointments:[],otherAppointments:[]},attendanceContext:{basis:'current_status_scheduled_slot',cutoff:{kind:'explicit_instant',instant:asOf.toISOString(),timeZone:zone,localDateTime:'2026-11-06T12:00:00.000000'},latestScheduledLocal:null,outcome:'none'},lastWasNoShow:false};
const project=(rows:FollowupCase[]=[row],bucket='no_appointment')=>projectOrthoFollowupWorklist(rows,{bucket,today,asOf,actorId:3,timeZone:zone});
it('selects one bucket and allowlists minimal fields without copying private data',()=>{const r=project();expect(r.rows).toHaveLength(1);expect(r.rows[0].dueDate).toBe('2026-10-29');expect(r.rows[0].lastAdjustmentDate).toBeNull();expect(JSON.stringify(r)).not.toMatch(/PRIVATE|upperWire|patientPhone/);expect(project([row],'today').rows).toEqual([]);});
it('keeps retention schedule unavailable for either phase or status',()=>{for(const r of [{...row,phase:'retention'},{...row,status:'retention' as const}])expect(project([r],'retention').rows[0]).toMatchObject({dueDate:null,dueBasis:'retention_schedule_unavailable'});});
it('preserves booking-review counts and conflicting current attendance',()=>{const appointment={id:6,date:today,time:'12:00',status:'booked'};const r=project([{...row,bookingContext:{...row.bookingContext!,reviewAppointments:[appointment],otherAppointments:[appointment]},lastWasNoShow:true,attendanceContext:{...row.attendanceContext!,outcome:'conflict',latestScheduledLocal:'2026-11-06T10:00:00.000000'}}],'no_show').rows[0];expect(r).toMatchObject({reviewAppointmentCount:1,otherAppointmentCount:1,attendance:{outcome:'conflict'}});});
it('rejects invalid bucket and wrong cutoff rather than historical substitution',()=>{expect(()=>project([row],'all')).toThrow();expect(()=>project([{...row,attendanceContext:{...row.attendanceContext!,cutoff:{...row.attendanceContext!.cutoff,instant:'2020-01-01T00:00:00.000Z'}}}])).toThrow();});
it('refuses duplicates unknown booking evidence and oversize without truncation',()=>{expect(()=>project([row,row])).toThrow();expect(()=>project([{...row,bookingContext:undefined}])).toThrow();expect(()=>project(Array.from({length:501},(_,i)=>({...row,caseId:i+1})))).toThrow();});

it('preserves canonical cohort and age ordering in a mixed selected bucket',()=>{
 const cases:FollowupCase[]=[{...row,caseId:9,phase:'retention'},{...row,caseId:4,startDate:'2026-10-20'},{...row,caseId:7,startDate:'2026-09-01'},{...row,caseId:2,phase:'retention'}];
 const expected=groupByBucket(classifyFollowups({cases,today})).get('no_appointment')!.map(r=>r.caseId);
 expect(expected).toEqual([7,4,2,9]);expect(project(cases).rows.map(r=>r.caseId)).toEqual(expected);
});
it('preserves canonical retention booking ordering rather than input order',()=>{
 const cases:FollowupCase[]=[{...row,caseId:2,phase:'retention',nextAppointment:{id:11,date:today,time:'15:00',status:'booked'}},{...row,caseId:9,phase:'retention',nextAppointment:{id:12,date:today,time:'09:00',status:'booked'}}];
 const expected=groupByBucket(classifyFollowups({cases,today})).get('today')!.map(r=>r.caseId);
 expect(expected).toEqual([9,2]);expect(project(cases,'today').rows.map(r=>r.caseId)).toEqual(expected);
});
it('refuses the byte cap with valid multibyte names below the row cap',()=>{
 const cases=Array.from({length:500},(_,i)=>({...row,caseId:i+1,patientName:'界'.repeat(1000)}));
 expect(()=>project(cases)).toThrowError(expect.objectContaining({code:'worklist_limit'}));
});
