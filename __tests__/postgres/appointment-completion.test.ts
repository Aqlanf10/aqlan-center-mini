import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {openInventoryPurchaseFixture} from './_inventory-purchase-fixture';
import {purchaseTestSession} from './_inventory-purchase-session';
import type {SessionPayload} from '../../lib/auth';
import {APPOINTMENT_CATEGORY_LABEL,type AppointmentCategory} from '../../lib/appointment-category';
vi.mock('next/headers',()=>({headers:async()=>new Headers(),cookies:async()=>({get:()=>undefined})}));
let fixture:Awaited<ReturnType<typeof openInventoryPurchaseFixture>>, session:SessionPayload;
let sequence=0,doctorId:number,staffId:number;
const q=(sql:string,args:unknown[]=[])=>fixture.pool.query(sql,args);
const actor=(s=session)=>({username:s.username,role:s.role,channel:'ui' as const,session:s});
async function request(category:AppointmentCategory='orthodontics') {
  const {rows:[patient]}=await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic booking') RETURNING id",[`COMP-${++sequence}`]);
  return {patientId:patient.id,date:'2030-01-15',time:'10:00',durationMinutes:30,
    clinicalCategory:category,commandId:randomUUID(),expectedActor:{userId:session.userId,username:session.username}};
}
beforeAll(async()=>{
  fixture=await openInventoryPurchaseFixture();session=await purchaseTestSession('completion-reception','reception');
  const doctor=await purchaseTestSession('completion-doctor','doctor');
  doctorId=(await q("INSERT INTO parties(name,kind) VALUES('Synthetic roster doctor','doctor') RETURNING id")).rows[0].id;
  await q('UPDATE users SET party_id=$2 WHERE id=$1',[doctor.userId,doctorId]);
  staffId=(await q("INSERT INTO hr_staff(full_name,department,user_id,created_by) VALUES('Synthetic roster staff','doctors',$1,'synthetic') RETURNING id",[doctor.userId])).rows[0].id;
  await q(`INSERT INTO hr_work_schedules(staff_id,name,schedule_type,effective_from,working_days,shift_start_time,shift_end_time,created_by)
    VALUES($1,'Synthetic morning','morning','2029-01-01','[0,1,2,3,4,5,6]','09:00','13:00','synthetic')`,[staffId]);
});
afterAll(async()=>{await fixture?.close();});

it('persists all seven explicit categories with a generic immutable receipt, without inventing treatment purpose',async()=>{
  const {bookDirectPurposeAppointment}=await import('../../lib/book-direct-purpose');
  for (const category of Object.keys(APPOINTMENT_CATEGORY_LABEL) as AppointmentCategory[]) {
    const input=await request(category);input.date=`2030-02-${String(sequence).padStart(2,'0')}`;
    const result=await bookDirectPurposeAppointment(input,actor());
    expect(result).toMatchObject({ok:true,replayed:false,appointment:{clinicalCategory:category,status:'booked'}});
    const {rows}=await q('SELECT command_id FROM appointment_booking_commands WHERE command_id=$1',[input.commandId]);
    expect(rows).toHaveLength(1);
    expect((await q('SELECT * FROM appointment_purpose_provenance WHERE command_id=$1',[input.commandId])).rows).toHaveLength(0);
  }
});
it('concurrent generic replay and lost-response recovery return one row, with actor/changed-intent rejection',async()=>{
  const {bookDirectPurposeAppointment,recoverDirectPurposeAppointment}=await import('../../lib/book-direct-purpose');
  const input=await request();input.date='2030-03-01';
  const results=await Promise.all([bookDirectPurposeAppointment(input,actor()),bookDirectPurposeAppointment(input,actor())]);
  expect(results.map(r=>r.ok && r.replayed).sort()).toEqual([false,true]);
  const recovery=await recoverDirectPurposeAppointment(input.commandId,session);
  expect(recovery).toMatchObject({kind:'found',status:'booked'});
  expect((await q('SELECT id FROM appointments WHERE patient_id=$1',[input.patientId])).rows).toHaveLength(1);
  expect(await bookDirectPurposeAppointment({...input,clinicalCategory:'filling'},actor())).toMatchObject({ok:false,status:409});
  const other=await purchaseTestSession('completion-other','reception');
  const neverSent={...await request(),date:'2030-03-02'};
  expect(await bookDirectPurposeAppointment(neverSent,actor(other))).toMatchObject({ok:false,status:409});
  expect((await q('SELECT id FROM appointments WHERE patient_id=$1',[neverSent.patientId])).rows).toHaveLength(0);
  expect(await recoverDirectPurposeAppointment(input.commandId,other)).toMatchObject({kind:'denied_actor'});
});
it('rejects unmapped doctors, outside duty and break-crossing windows even with override; approved leave blocks without a provider service',async()=>{
  const {bookDirectPurposeAppointment}=await import('../../lib/book-direct-purpose');
  const unmapped=(await q("INSERT INTO parties(name,kind) VALUES('Unmapped synthetic doctor','doctor') RETURNING id")).rows[0].id;
  for(const choice of [{doctorId:unmapped,time:'10:00'},{doctorId,time:'16:00'},{doctorId,time:'12:45'}]) {
    const input={...await request(),...choice,overrideReason:'Synthetic attempted override'};
    expect(await bookDirectPurposeAppointment(input,actor())).toMatchObject({ok:false,status:409,conflict:{canOverride:false}});
  }
  await q("INSERT INTO hr_leave_types(code,name_ar) VALUES('annual','Synthetic leave') ON CONFLICT DO NOTHING");
  await q(`INSERT INTO hr_leave_requests(staff_id,leave_type_code,start_date,end_date,days_count,reason,status,created_by)
    VALUES($1,'annual','2030-01-15','2030-01-15',1,'Synthetic approved leave','approved','synthetic')`,[staffId]);
  expect(await bookDirectPurposeAppointment({...await request(),doctorId},actor())).toMatchObject({ok:false,status:409,conflict:{canOverride:false}});
  expect(await bookDirectPurposeAppointment({...await request(),doctorId,date:'2030-01-16'},actor())).toMatchObject({ok:true,replayed:false});
});
it('holds a proven roster against a concurrent new leave insert, and fails fast while an HR write is uncommitted',async()=>{
  const {appointmentDoctorAdmission}=await import('../../lib/appointment-doctor-admission');
  const admission=await fixture.pool.connect(),writer=await fixture.pool.connect();
  let inserting:Promise<unknown>|undefined;
  try {
    await admission.query('BEGIN');
    expect(await appointmentDoctorAdmission(admission,{doctorId,date:'2030-04-01',time:'10:00',durationMinutes:30,before:0,after:0})).toBeNull();
    const pid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    inserting=writer.query(`INSERT INTO hr_leave_requests(staff_id,leave_type_code,start_date,end_date,days_count,reason,status,created_by)
      VALUES($1,'annual','2030-04-01','2030-04-01',1,'Synthetic racing leave','approved','synthetic')`,[staffId]);
    let blocked=false;
    for(let n=0;n<100;n++) {
      blocked=(await q("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked;
      if(blocked)break;await new Promise(r=>setTimeout(r,10));
    }
    expect(blocked).toBe(true);
    await admission.query('COMMIT');await inserting;
    await writer.query('BEGIN');await writer.query('UPDATE hr_work_schedules SET name=name WHERE staff_id=$1',[staffId]);
    await admission.query('BEGIN');
    await expect(appointmentDoctorAdmission(admission,{doctorId,date:'2030-04-02',time:'10:00',durationMinutes:30,before:0,after:0})).rejects.toMatchObject({code:'55P03'});
  } finally {await admission.query('ROLLBACK');await writer.query('ROLLBACK');await inserting?.catch(()=>{});admission.release();writer.release();}
});
it('staff confirmation is idempotent, resets on move, and cannot confirm the old displayed slot',async()=>{
  const {bookDirectPurposeAppointment}=await import('../../lib/book-direct-purpose');
  const {confirmAppointmentByStaff}=await import('../../lib/appointment-staff-confirmation');
  const input={...await request(),date:'2030-05-01'};
  const result=await bookDirectPurposeAppointment(input,actor());
  if(!result.ok || result.replayed)throw new Error('Fixture failed');
  const a=result.appointment;
  const snapshot={patientId:a.patientId,patientName:a.patientName,patientPhone:a.patientPhone,
    scheduledDate:a.scheduledDate,scheduledTime:a.scheduledTime,status:'booked' as const};
  expect(await confirmAppointmentByStaff(a.id,a.patientId,snapshot,session)).toBe(true);
  const first=await fixture.db.getAppointment(a.id);
  expect(await confirmAppointmentByStaff(a.id,a.patientId,snapshot,session)).toBe(true);
  expect((await fixture.db.getAppointment(a.id))?.staffConfirmedAt).toBe(first?.staffConfirmedAt);
  const {rescheduleAppointment}=await import('../../lib/book-appointment');
  expect(await rescheduleAppointment({appointmentId:a.id,date:a.scheduledDate,time:'11:00',reason:'Synthetic move'},actor())).toMatchObject({ok:true});
  expect((await fixture.db.getAppointment(a.id))?.staffConfirmedAt).toBeNull();
  expect(await confirmAppointmentByStaff(a.id,a.patientId,snapshot,session)).toBe(false);
});
it('read-only clinical links deny assistants and never guess a plan or case from a patient match',async()=>{
  const {withAppointmentClinicalLinks}=await import('../../lib/appointment-clinical-links');
  const {bookDirectPurposeAppointment}=await import('../../lib/book-direct-purpose');
  const result=await bookDirectPurposeAppointment({...await request(),date:'2030-06-01'},actor());
  if(!result.ok || result.replayed)throw new Error('Fixture failed');
  const items=[result.appointment];
  const assistant=await purchaseTestSession('completion-assistant','assistant');
  expect(await withAppointmentClinicalLinks(items,assistant)).toEqual(items);
  expect(await withAppointmentClinicalLinks(items,session)).toMatchObject([{clinicalLinks:{planId:null,visitIds:[],caseIds:[]}}]);
});

it('clinical link projection includes only reciprocal same-patient sources and excludes cross-patient visit/plan evidence',async()=>{
  const {bookDirectPurposeAppointment}=await import('../../lib/book-direct-purpose');
  const {withAppointmentClinicalLinks}=await import('../../lib/appointment-clinical-links');
  const input={...await request(),date:'2030-06-02'};
  const result=await bookDirectPurposeAppointment(input,actor());
  if(!result.ok || result.replayed)throw new Error('Fixture failed');
  const a=result.appointment,foreign=await request();
  const plan=(await q("INSERT INTO treatment_plans(patient_id,title,total_minor,status) VALUES($1,'Synthetic foreign plan',0,'active') RETURNING id",[foreign.patientId])).rows[0];
  const planned=(await q("INSERT INTO planned_visits(patient_id,plan_id,sequence,title,appointment_id) VALUES($1,$2,1,'Synthetic inconsistent source',$3) RETURNING id",[a.patientId,plan.id,a.id])).rows[0];
  await q('UPDATE appointments SET planned_visit_id=$2 WHERE id=$1',[a.id,planned.id]);
  const own=(await q("INSERT INTO visits(patient_name,patient_id,appointment_id) VALUES('Synthetic own',$1,$2) RETURNING id",[a.patientId,a.id])).rows[0];
  await q("INSERT INTO visits(patient_name,patient_id,appointment_id) VALUES('Synthetic foreign',$1,$2)",[foreign.patientId,a.id]);
  expect(await withAppointmentClinicalLinks([a],session)).toMatchObject([{clinicalLinks:{planId:null,visitIds:[own.id],caseIds:[]}}]);
  await q('UPDATE planned_visits SET appointment_id=NULL WHERE id=$1',[planned.id]);
  expect(await withAppointmentClinicalLinks([a],session)).toMatchObject([{clinicalLinks:{planId:null,visitIds:[own.id],caseIds:[]}}]);
});

it('explicit board classification works for existing bookings with a stale-choice guard and no treatment-status change',async()=>{
  const {confirmAppointmentByStaff}=await import('../../lib/appointment-staff-confirmation');
  const input=await request();
  const a=await fixture.db.createAppointment({patientId:input.patientId,date:'2030-07-01',time:'10:00',durationMinutes:30,note:null});
  if(!a)throw new Error('Fixture failed');
  const snapshot={patientId:a.patientId,patientName:a.patientName,patientPhone:a.patientPhone,
    scheduledDate:a.scheduledDate,scheduledTime:a.scheduledTime,status:'booked' as const};
  expect(await confirmAppointmentByStaff(a.id,a.patientId,snapshot,session,{value:'awaiting_prosthetics',expected:null})).toBe(true);
  expect(await confirmAppointmentByStaff(a.id,a.patientId,snapshot,session,{value:'filling',expected:null})).toBe(false);
  expect(await fixture.db.getAppointment(a.id)).toMatchObject({status:'booked',clinicalCategory:'awaiting_prosthetics',staffConfirmedAt:null});
});


it('center closures are hard admission boundaries even without a doctor and for an admin override',async()=>{
  const {bookDirectPurposeAppointment}=await import('../../lib/book-direct-purpose');
  const admin=await purchaseTestSession('completion-admin','admin');
  for(const time of ['08:00','13:15','19:00','12:45']) {
    const input={...await request(),date:'2030-08-01',time,overrideReason:'Synthetic override',
      expectedActor:{userId:admin.userId,username:admin.username}};
    expect(await bookDirectPurposeAppointment(input,actor(admin))).toMatchObject({ok:false,status:409,conflict:{canOverride:false}});
    expect((await q('SELECT id FROM appointments WHERE patient_id=$1',[input.patientId])).rows).toHaveLength(0);
  }
});

it('planned and next-session booking preserve the authoritative doctor and apply the same hours gate',async()=>{
  const {schedulePlannedVisit}=await import('../../lib/db');
  const {judgeBookingInDay}=await import('../../lib/book-appointment');
  const {loadCapacityContext}=await import('../../lib/capacity-context');
  const input=await request();
  const planned=(await q("INSERT INTO planned_visits(patient_id,title,doctor_id,duration_minutes,sequence) VALUES($1,'Synthetic planned session',$2,30,1) RETURNING id",[input.patientId,doctorId])).rows[0].id;
  const context=await loadCapacityContext();
  const schedule=(time:string)=>schedulePlannedVisit({plannedVisitId:planned,date:'2030-07-01',time,chairs:context.chairs,
    judge:async(sameDay,client,durationMinutes,providerId)=>{
      const judged=await judgeBookingInDay({sameDay,client,date:'2030-07-01',time,durationMinutes,providerId,
        patientId:input.patientId,service:null,context,canOverride:true,overrideReason:'Synthetic cannot override hours'});
      return judged.ok?{ok:true as const}:{ok:false as const,conflict:judged.conflict};
    }});
  expect(await schedule('16:00')).toMatchObject({ok:false,reason:'conflict'});
  const booked=await schedule('10:00');expect(booked).toMatchObject({ok:true});
  if(!booked.ok)throw new Error('Expected planned booking');
  expect((await q('SELECT doctor_id,patient_id FROM appointments WHERE id=$1',[booked.appointmentId])).rows[0]).toEqual({doctor_id:doctorId,patient_id:input.patientId});
  const visit=(await q("INSERT INTO visits(patient_name,patient_id,doctor_id) VALUES('Synthetic source visit',$1,$2) RETURNING id",[input.patientId,doctorId])).rows[0].id;
  const sessionModule=await import('../../lib/session');
  const auth=vi.spyOn(sessionModule,'requireSession').mockResolvedValue(session);
  try {
    const {POST}=await import('../../app/api/visits/[id]/next/route');
    const next=(time:string)=>POST(new Request('http://localhost/api/visits/'+visit+'/next',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({date:'2030-07-02',time,durationMinutes:30})}),{params:Promise.resolve({id:String(visit)})});
    expect((await next('16:00')).status).toBe(409);
    const response=await next('10:00');expect(response.status).toBe(201);
    const receipt=await response.json();
    expect((await q('SELECT doctor_id,patient_id FROM appointments WHERE id=$1',[receipt.appointmentId])).rows[0]).toEqual({doctor_id:doctorId,patient_id:input.patientId});
  } finally {auth.mockRestore();}
});

it('uses current center hours despite stale preflight and protects them against a concurrent edit',async()=>{
  const {judgeBookingInDay}=await import('../../lib/book-appointment');
  const {loadCapacityContext}=await import('../../lib/capacity-context');
  const context=await loadCapacityContext();
  const reader=await fixture.pool.connect(),writer=await fixture.pool.connect();
  let editing:Promise<unknown>|undefined;
  const input={sameDay:[],client:reader,date:'2030-08-01',time:'10:00',durationMinutes:30,service:null,context,
    patientId:null,canOverride:true,overrideReason:'Synthetic override'};
  try {
    await q("INSERT INTO settings(key,value) VALUES('clinic.day_start','11:00') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    await reader.query('BEGIN');
    expect(await judgeBookingInDay(input)).toMatchObject({ok:false,conflict:{canOverride:false}});
    const pid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    editing=writer.query("UPDATE settings SET value='09:00' WHERE key='clinic.day_start'");
    let blocked=false;
    for(let n=0;n<100;n++) {
      blocked=(await q("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked;
      if(blocked)break;await new Promise(r=>setTimeout(r,10));
    }
    expect(blocked).toBe(true);await reader.query('ROLLBACK');await editing;
    await writer.query('BEGIN');await writer.query("UPDATE settings SET value='11:00' WHERE key='clinic.day_start'");
    await reader.query('BEGIN');await expect(judgeBookingInDay(input)).rejects.toMatchObject({code:'55P03'});
  } finally {await reader.query('ROLLBACK');await writer.query('ROLLBACK');await editing?.catch(()=>{});reader.release();writer.release();}
});

it('does not suggest the next free center slot after the selected doctor ends duty',async()=>{
  const {listAppointmentsByDate}=await import('../../lib/db');
  const {judgeBookingInDay}=await import('../../lib/book-appointment');
  const {loadCapacityContext}=await import('../../lib/capacity-context');
  const date='2030-09-01';
  const context=await loadCapacityContext();
  for(let n=0;n<context.chairs;n++) {
    const input=await request();
    await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,duration_minutes) VALUES($1,$2,'12:30',30)",[input.patientId,date]);
  }
  const client=await fixture.pool.connect();
  try {
    await client.query('BEGIN');
    const result=await judgeBookingInDay({sameDay:await listAppointmentsByDate(date),client,date,time:'12:30',durationMinutes:30,
      providerId:doctorId,service:null,context,patientId:null,canOverride:false,overrideReason:''});
    expect(result).toMatchObject({ok:false,conflict:{suggestion:null}});
  } finally {await client.query('ROLLBACK');client.release();}
});
