import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, rawPool, stubPostgresEnv } from "./_setup";
assertRealPostgresUrl(); stubPostgresEnv();
const auth = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: auth.token }) }), headers: async () => new Headers() }));
const db = await import("../../lib/db");
const { bookAppointment } = await import("../../lib/book-appointment");
const { createSessionToken, sessionCredentialVersion } = await import("../../lib/auth");
const { GET: mine } = await import("../../app/api/appointments/mine/route");
const actor = { username: "synthetic-return-reception", role: "reception" as const, channel: "ui" as const };
const observer = rawPool(assertRealPostgresUrl(), 2);
let sequence = 0;
const q = async (sql: string, args: unknown[] = []) => (await db.getPool().query(sql, args)).rows;
beforeAll(async () => {
  await dropPublicSchema(assertRealPostgresUrl()); await db.ensureSchema();
  await db.saveSettings({ "clinic.chairs": "20", "clinic.day_start": "08:00", "clinic.day_end": "20:00" });
});
afterAll(async () => { await observer.end(); await db.resetPoolForTesting(); });
async function fixture(specialty = "endodontics") {
  const n = ++sequence;
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES ($1,'Synthetic return patient') RETURNING id", [`RETURN-${n}`]);
  const doctors = await q("INSERT INTO parties(name,kind) VALUES ($1,'doctor'),($2,'doctor') RETURNING id,name", [`Synthetic former doctor ${n}`,`Synthetic current doctor ${n}`]);
  const [clinical] = await q("INSERT INTO clinical_cases(patient_id,specialty,title,responsible_party_id,created_by) VALUES ($1,$2,'Synthetic current case',$3,'synthetic-admin') RETURNING id", [patient.id,specialty,doctors[1].id]);
  const [plan] = await q("INSERT INTO treatment_plans(patient_id,title,primary_doctor_id,status,total_minor) VALUES ($1,'Synthetic historical plan',$2,'active',1000) RETURNING id", [patient.id,doctors[0].id]);
  const [item] = await q("INSERT INTO plan_items(plan_id,service_name,case_id,doctor_id,unit_price_minor,category) VALUES ($1,'Synthetic existing work',$2,$3,1000,$4) RETURNING id", [plan.id,clinical.id,doctors[0].id,specialty === "orthodontics" ? "ortho" : "endo"]);
  const date = new Date(Date.UTC(2038,0,n*4)).toISOString().slice(0,10);
  const request = { patientId: patient.id as number, date, time: "16:00", durationMinutes: 15,
    appointmentType: "follow_up", returnBookingSource: { kind: "clinical_case" as const, id: clinical.id as number } };
  return { patientId: patient.id as number, clinicalId: clinical.id as number, planId: plan.id as number, itemId: item.id as number,
    oldDoctorId: doctors[0].id as number, doctorId: doctors[1].id as number, doctorName: doctors[1].name as string, request };
}
it("rejects a follow-up without a fresh exact responsibility fingerprint", async () => {
  const f = await fixture();
  expect(await bookAppointment(f.request, actor)).toMatchObject({ ok: false, status: 400 });
  expect(await q("SELECT id FROM appointments WHERE patient_id=$1", [f.patientId])).toEqual([]);
});
async function session(role: string, partyId: number | null = null) {
  const username = `synthetic-return-${role}-${++sequence}`;
  const hash = "synthetic-unused-password-hash";
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role,party_id) VALUES ($1,'Synthetic actor',$2,$3,$4) RETURNING id", [username,hash,role,partyId]);
  return { userId: user.id as number, username, role, partyId, credentialVersion: sessionCredentialVersion(hash), expiresAt: Date.now()+3600000 };
}
async function preview(f: Awaited<ReturnType<typeof fixture>>, source: { kind: "clinical_case" | "plan_item" | "visit" | "ortho_case"; id: number } = f.request.returnBookingSource) {
  const { readReturnBookingContext } = await import("../../lib/return-booking-context");
  const client = await db.getPool().connect();
  try { return await readReturnBookingContext(client,f.patientId,source); } finally { client.release(); }
}
async function request(f: Awaited<ReturnType<typeof fixture>>) {
  const source = await preview(f); expect(source.ok).toBe(true);
  if (!source.ok) throw new Error(source.message);
  return { ...f.request, returnBookingFingerprint: source.fingerprint };
}
it.each(["endodontics","orthodontics"])("%s follows current responsibility after admin reassignment without rewriting financial or booked history", async specialty => {
  const f = await fixture(specialty);
  await q("UPDATE clinical_cases SET responsible_party_id=$2 WHERE id=$1", [f.clinicalId,f.oldDoctorId]);
  if (specialty === "orthodontics") {
    const [ortho] = await q("INSERT INTO ortho_cases(patient_id,responsible_doctor_id,created_by) VALUES ($1,$2,'synthetic') RETURNING id", [f.patientId,f.oldDoctorId]);
    await q("UPDATE clinical_cases SET ortho_case_id=$2 WHERE id=$1", [f.clinicalId,ortho.id]);
  }
  const [invoice] = await q("INSERT INTO invoices(invoice_number,patient_id,total_minor) VALUES ($1,$2,1000) RETURNING id", [`RETURN-INV-${sequence}`,f.patientId]);
  const [line] = await q("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,doctor_id,plan_item_id) VALUES ($1,'Synthetic frozen charge',1,1000,1000,$2,$3) RETURNING id", [invoice.id,f.oldDoctorId,f.itemId]);
  const oldDate = new Date(Date.parse(`${f.request.date}T00:00Z`)+4*86400000).toISOString().slice(0,10);
  const [oldAppointment] = await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,doctor_id) VALUES ($1,$2,'10:00',$3) RETURNING id", [f.patientId,oldDate,f.oldDoctorId]);
  const frozen = await q("SELECT to_jsonb(i) AS row FROM invoice_items i WHERE id=$1", [line.id]);
  const { patientResponsibilitySettings } = await import("../../lib/patient-responsibility-settings");
  const admin = await session("admin"); const target = { patientId:f.patientId, kind:"clinical" as const, sourceId:f.clinicalId };
  const before = await patientResponsibilitySettings(target,admin);
  await patientResponsibilitySettings(target,admin,{ expectedSourceFingerprint:before.sourceFingerprint,doctorId:f.doctorId,reason:"Synthetic responsibility handover" });
  expect(await q("SELECT to_jsonb(i) AS row FROM invoice_items i WHERE id=$1", [line.id])).toEqual(frozen);
  expect(await q("SELECT doctor_id FROM plan_items WHERE id=$1",[f.itemId])).toEqual([{doctor_id:f.oldDoctorId}]);
  expect(await q("SELECT doctor_id FROM appointments WHERE id=$1",[oldAppointment.id])).toEqual([{doctor_id:f.oldDoctorId}]);
  expect((await q("SELECT details FROM audit_log WHERE action='case.responsibility_change' AND entity_id=$1",[String(f.patientId)]))).toHaveLength(1);
  expect(await db.doctorOwnsPatient(f.doctorId,f.patientId)).toBe(true);
  expect((await db.doctorOwnedPatientIds(f.doctorId,[f.patientId])).has(f.patientId)).toBe(true);
  const booked = await bookAppointment(await request(f),actor);
  expect(booked).toMatchObject({ok:true,appointment:{doctorId:f.doctorId,doctorName:f.doctorName}});
  if (!booked.ok) throw new Error("Expected current doctor booking");
  const current = await session("doctor",f.doctorId); auth.token=createSessionToken(current);
  const response=await mine(new Request(`http://localhost/api/appointments/mine?date=${f.request.date}`));
  expect(response.status).toBe(200);
  expect((await response.json()).appointments).toEqual(expect.arrayContaining([expect.objectContaining({appointmentId:booked.appointment.id})]));
  auth.token=createSessionToken(await session("doctor",f.oldDoctorId));
  const oldResponse=await mine(new Request(`http://localhost/api/appointments/mine?date=${f.request.date}`));
  expect((await oldResponse.json()).appointments).toEqual([]);
  expect(await db.getAppointment(oldAppointment.id)).toMatchObject({doctorId:f.oldDoctorId,scheduledDate:oldDate});
});
it("neither reception nor a different doctor can choose someone other than the exact current owner",async()=>{
  const f=await fixture();const input=await request(f);
  expect(await bookAppointment({...input,doctorId:f.oldDoctorId},actor)).toMatchObject({ok:false,status:400});
  expect(await bookAppointment({...input,doctorId:f.oldDoctorId},{...actor,role:"doctor",doctorPartyId:f.oldDoctorId})).toMatchObject({ok:false,status:400});
  expect(await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patientId])).toEqual([]);
  expect(await bookAppointment(input,{...actor,role:"doctor",doctorPartyId:f.oldDoctorId})).toMatchObject({ok:true,appointment:{doctorId:f.doctorId}});
});
it.each(["missing","inactive"])("blocks %s current responsibility instead of using frozen item attribution",async kind=>{
  const f=await fixture();
  if(kind==="missing")await q("UPDATE clinical_cases SET responsible_party_id=NULL WHERE id=$1",[f.clinicalId]);
  else await q("UPDATE parties SET is_active=false WHERE id=$1",[f.doctorId]);
  expect(await preview(f)).toMatchObject({ok:false});
  expect(await bookAppointment({...f.request,doctorId:f.oldDoctorId,returnBookingFingerprint:"stale"},actor)).toMatchObject({ok:false,status:400});
  expect(await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patientId])).toEqual([]);
});
async function blockedBy(pid:number,fragment:string){
  const until=Date.now()+10000;
  while(Date.now()<until){const{rows}=await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2",[pid,`%${fragment}%`]);if(rows.length)return rows[0].pid;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error(`No observed lock wait: ${fragment}`);
}
it("rechecks responsibility changed while booking waited for its day lock",async()=>{
  const f=await fixture();const input=await request(f);const gate=await observer.connect();let pending:ReturnType<typeof bookAppointment>|undefined;
  try{await gate.query("BEGIN");const{rows:[info]}=await gate.query<{pid:number}>("SELECT pg_backend_pid() AS pid");
    await gate.query("SELECT pg_advisory_xact_lock(hashtext('appointments-day:' || $1))",[input.date]);
    pending=bookAppointment(input,actor);await blockedBy(info.pid,"pg_advisory_xact_lock");
    await gate.query("UPDATE clinical_cases SET responsible_party_id=$2 WHERE id=$1",[f.clinicalId,f.oldDoctorId]);await gate.query("COMMIT");
    expect(await pending).toMatchObject({ok:false,status:400});expect(await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patientId])).toEqual([]);
  }finally{await gate.query("ROLLBACK");gate.release();await pending?.catch(()=>{});}
});
it("resolves plan-item return ownership from its exact current case, not item or plan financial attribution",async()=>{
 const f=await fixture();expect(await preview(f,{kind:"plan_item",id:f.itemId})).toMatchObject({ok:true,doctorId:f.doctorId});
});
it("refuses a mixed-case visit instead of picking its first provider",async()=>{
 const f=await fixture();
 const[otherCase]=await q("INSERT INTO clinical_cases(patient_id,specialty,title,responsible_party_id,created_by) VALUES ($1,'prosthodontics','Synthetic second case',$2,'synthetic') RETURNING id",[f.patientId,f.oldDoctorId]);
 const[otherItem]=await q("INSERT INTO plan_items(plan_id,service_name,case_id,doctor_id,unit_price_minor) VALUES ($1,'Synthetic second work',$2,$3,1000) RETURNING id",[f.planId,otherCase.id,f.oldDoctorId]);
 const[visit]=await q("INSERT INTO visits(patient_name,patient_id,case_id,doctor_id) VALUES ('Synthetic mixed visit',$1,$2,$3) RETURNING id",[f.patientId,f.clinicalId,f.oldDoctorId]);
 await q("INSERT INTO treatment_sessions(plan_item_id,sequence,visit_id) VALUES ($1,1,$2)",[otherItem.id,visit.id]);
 expect(await preview(f,{kind:"visit",id:visit.id})).toMatchObject({ok:false});
 expect(await bookAppointment({...f.request,returnBookingSource:{kind:"visit" as const,id:visit.id},returnBookingFingerprint:"stale",doctorId:f.oldDoctorId},actor)).toMatchObject({ok:false,status:400});
 expect(await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patientId])).toEqual([]);
});
it("rechecks nearby patient appointments after deriving current responsibility and accepts only explicit additional booking",async()=>{
 const f=await fixture();const input=await request(f);
 await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,doctor_id) VALUES ($1,$2,'18:00',$3)",[f.patientId,f.request.date,f.oldDoctorId]);
 const result=await bookAppointment(input,actor);expect(result).toMatchObject({ok:false,status:409,conflict:{kind:"nearby_patient_appointments"}});
 if(result.ok||result.status!==409)throw new Error("Expected nearby warning");
 expect(await bookAppointment({...input,nearbyAppointmentConfirmation:result.conflict.confirmationToken},actor)).toMatchObject({ok:true,appointment:{doctorId:f.doctorId}});
});
it.each(["next","planned"])("%s route persists current owner rather than historical visit/planned doctor",async entry=>{
 const f=await fixture();auth.token=createSessionToken(await session("admin"));let response:Response;
 const { GET: contextGet } = await import("../../app/api/patients/[id]/return-booking-context/route");
 const contextFor = async (source: {kind:"visit"|"planned_visit";id:number}) => {
  const response = await contextGet(new Request(`http://localhost/api/patients/${f.patientId}/return-booking-context?kind=${source.kind}&sourceId=${source.id}`), {params:Promise.resolve({id:String(f.patientId)})});
  expect(response.status).toBe(200); const context = await response.json();
  expect(context.ok).toBe(true); return context.fingerprint as string;
 };
 if(entry==="next"){
  const[visit]=await q("INSERT INTO visits(patient_name,patient_id,case_id,doctor_id) VALUES ('Synthetic old clinician visit',$1,$2,$3) RETURNING id",[f.patientId,f.clinicalId,f.oldDoctorId]);
  const fingerprint=await contextFor({kind:"visit",id:visit.id});
  const{POST}=await import("../../app/api/visits/[id]/next/route");
  response=await POST(new Request("http://localhost/api/visits/next",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({date:f.request.date,time:"16:00",durationMinutes:15,returnBookingFingerprint:fingerprint})}),{params:Promise.resolve({id:String(visit.id)})});
 }else{
  const[planned]=await q("INSERT INTO planned_visits(patient_id,plan_id,sequence,title,doctor_id,duration_minutes) VALUES ($1,$2,1,'Synthetic planned return',$3,15) RETURNING id",[f.patientId,f.planId,f.oldDoctorId]);
  await q("INSERT INTO treatment_sessions(plan_item_id,sequence,planned_visit_id) VALUES ($1,1,$2)",[f.itemId,planned.id]);
  const fingerprint=await contextFor({kind:"planned_visit",id:planned.id});
  const{POST}=await import("../../app/api/planned-visits/[id]/schedule/route");
  response=await POST(new Request("http://localhost/api/planned/schedule",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({date:f.request.date,time:"16:00",returnBookingFingerprint:fingerprint})}),{params:Promise.resolve({id:String(planned.id)})});
 }
 expect(response.status,JSON.stringify(await response.clone().json())).toBe(201);
 expect(await q("SELECT doctor_id FROM appointments WHERE patient_id=$1",[f.patientId])).toEqual([{doctor_id:f.doctorId}]);
});
it("settings rejects nonadmin and stale reassignment, preserving owner and audit count",async()=>{
 const f=await fixture();const{patientResponsibilitySettings}=await import("../../lib/patient-responsibility-settings");
 const target={patientId:f.patientId,kind:"clinical" as const,sourceId:f.clinicalId};const admin=await session("admin");const view=await patientResponsibilitySettings(target,admin);
 for(const role of ["doctor","reception"]){await expect(patientResponsibilitySettings(target,await session(role,f.oldDoctorId),{expectedSourceFingerprint:view.sourceFingerprint,doctorId:f.oldDoctorId,reason:"Synthetic unauthorized handover"})).rejects.toMatchObject({status:403});}
 await expect(patientResponsibilitySettings(target,admin,{expectedSourceFingerprint:"0".repeat(64),doctorId:f.oldDoctorId,reason:"Synthetic stale handover"})).rejects.toMatchObject({status:409});
 expect(await q("SELECT responsible_party_id FROM clinical_cases WHERE id=$1",[f.clinicalId])).toEqual([{responsible_party_id:f.doctorId}]);
 expect(await q("SELECT id FROM audit_log WHERE action='case.responsibility_change' AND entity_id=$1",[String(f.patientId)])).toEqual([]);
});
it("canonical ortho responsibility grants access while a stale bridge alone grants none",async()=>{
 const f=await fixture("orthodontics");const[stale]=await q("INSERT INTO parties(name,kind) VALUES ('Synthetic stale bridge doctor','doctor') RETURNING id");
 const[ortho]=await q("INSERT INTO ortho_cases(patient_id,responsible_doctor_id,created_by) VALUES ($1,$2,'synthetic') RETURNING id",[f.patientId,f.doctorId]);
 await q("UPDATE clinical_cases SET ortho_case_id=$2,responsible_party_id=$3 WHERE id=$1",[f.clinicalId,ortho.id,stale.id]);
 expect(await preview(f)).toMatchObject({ok:true,doctorId:f.doctorId});
 expect(await db.doctorOwnsPatient(f.doctorId,f.patientId)).toBe(true);
 expect(await db.doctorOwnsPatient(stale.id,f.patientId)).toBe(false);
 expect((await db.doctorOwnedPatientIds(stale.id,[f.patientId])).has(f.patientId)).toBe(false);
});
it("rejects cross-patient source and fingerprint reuse without creating an appointment",async()=>{
 const f=await fixture();const other=await fixture();const input=await request(f);
 expect(await bookAppointment({...input,patientId:other.patientId},actor)).toMatchObject({ok:false,status:400});
 expect(await q("SELECT id FROM appointments WHERE patient_id=ANY($1::int[])",[[f.patientId,other.patientId]])).toEqual([]);
});
it("planned rebooking preserves terminal history and assigns its replacement to current responsibility",async()=>{
 const f=await fixture();
 const[old]=await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,doctor_id,status,ended_at) VALUES ($1,'2030-01-01','10:00',$2,'no_show',NOW()) RETURNING id",[f.patientId,f.oldDoctorId]);
 const[planned]=await q("INSERT INTO planned_visits(patient_id,plan_id,sequence,title,doctor_id,duration_minutes,status,appointment_id) VALUES ($1,$2,1,'Synthetic missed return',$3,15,'scheduled',$4) RETURNING id",[f.patientId,f.planId,f.oldDoctorId,old.id]);
 await q("UPDATE appointments SET planned_visit_id=$2 WHERE id=$1",[old.id,planned.id]);
 await q("INSERT INTO treatment_sessions(plan_item_id,sequence,planned_visit_id) VALUES ($1,1,$2)",[f.itemId,planned.id]);
 const{readReturnBookingContext}=await import("../../lib/return-booking-context");const source={kind:"planned_visit" as const,id:planned.id};
 const client=await db.getPool().connect();let fingerprint:string;
 try{const context=await readReturnBookingContext(client,f.patientId,source,{origin:source});if(!context.ok)throw new Error(context.message);fingerprint=context.fingerprint;}finally{client.release();}
 const {rebookPlannedVisit}=await import("../../lib/planned-visit-rebooking");
 const generation=(await db.listPatientPlannedVisits(f.patientId))[0].rebookGeneration;
 const result=await rebookPlannedVisit({plannedVisitId:planned.id,expectedAppointmentId:old.id,expectedGeneration:generation,date:f.request.date,time:"16:00",reason:"Synthetic intentional return",requestId:`synthetic-return-rebook-${sequence}`,returnBookingFingerprint:fingerprint},await session("admin"));
 expect(result).toMatchObject({ok:true});if(!result.ok)throw new Error(result.message);
 expect(await db.getAppointment(result.appointmentId)).toMatchObject({doctorId:f.doctorId});
 expect(await db.getAppointment(old.id)).toMatchObject({doctorId:f.oldDoctorId,status:"no_show"});
});
it("uses a unique same-patient bridge only while canonical ortho owner is NULL, with protected ownership locks",async()=>{
 const f=await fixture("orthodontics");
 const[ortho]=await q("INSERT INTO ortho_cases(patient_id,responsible_doctor_id,created_by) VALUES ($1,NULL,'synthetic') RETURNING id",[f.patientId]);
 await q("UPDATE clinical_cases SET ortho_case_id=$2 WHERE id=$1",[f.clinicalId,ortho.id]);
 expect(await preview(f)).toMatchObject({ok:true,doctorId:f.doctorId});
 expect(await db.doctorOwnsPatient(f.doctorId,f.patientId)).toBe(true);
 expect((await db.doctorOwnedPatientIds(f.doctorId,[f.patientId])).has(f.patientId)).toBe(true);
 const{patientResponsibilitySettings}=await import("../../lib/patient-responsibility-settings");
 expect(await patientResponsibilitySettings({patientId:f.patientId,kind:"ortho",sourceId:ortho.id},await session("admin"))).toMatchObject({doctorId:f.doctorId});
 const reader=await db.getPool().connect();const editor=await db.getPool().connect();let editing:Promise<unknown>|undefined;
 try{
  await reader.query("BEGIN");const{rows:[info]}=await reader.query<{pid:number}>("SELECT pg_backend_pid() AS pid");
  expect(await db.doctorOwnsPatient(f.doctorId,f.patientId,reader)).toBe(true);
  editing=editor.query("UPDATE ortho_cases SET responsible_doctor_id=$2 WHERE id=$1",[ortho.id,f.oldDoctorId]);
  await blockedBy(info.pid,"UPDATE ortho_cases");await reader.query("COMMIT");await editing;
 }finally{await reader.query("ROLLBACK");await editing?.catch(()=>{});reader.release();editor.release();}
 expect(await preview(f)).toMatchObject({ok:true,doctorId:f.oldDoctorId});
 expect(await db.doctorOwnsPatient(f.doctorId,f.patientId)).toBe(false);
 expect((await db.doctorOwnedPatientIds(f.doctorId,[f.patientId])).has(f.patientId)).toBe(false);
 expect(await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patientId])).toEqual([]);
});
it("preserves stored clinician on ordinary moves and permits only an explicit current-owner transfer with capacity", async () => {
 const f = await fixture();
 const [old] = await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,doctor_id,duration_minutes) VALUES ($1,$2,'10:00',$3,15) RETURNING id", [f.patientId,f.request.date,f.oldDoctorId]);
 const { rescheduleAppointment } = await import("../../lib/book-appointment");
 const move = { appointmentId: old.id, date: f.request.date, time: "11:00", reason: "Synthetic ordinary move" };
 expect(await rescheduleAppointment(move,actor)).toMatchObject({ok:true,appointment:{doctorId:f.oldDoctorId}});
 expect(await rescheduleAppointment({...move,doctorId:f.doctorId},actor)).toMatchObject({ok:false,status:400});
 const source = await preview(f); if(!source.ok)throw new Error(source.message);
 const transfer = {...move,time:"16:00",transferToCurrentResponsibleDoctor:true,returnBookingSource:f.request.returnBookingSource,returnBookingFingerprint:source.fingerprint};
 const [block] = await q("INSERT INTO provider_blocks(provider_id,starts_at,ends_at,reason,created_by) VALUES ($1,$2::timestamp AT TIME ZONE 'Asia/Aden',$3::timestamp AT TIME ZONE 'Asia/Aden','Synthetic unavailable','synthetic') RETURNING id",[f.doctorId,`${f.request.date} 15:30`,`${f.request.date} 17:00`]);
 expect(await rescheduleAppointment(transfer,actor)).toMatchObject({ok:false,status:409});
 expect(await db.getAppointment(old.id)).toMatchObject({doctorId:f.oldDoctorId,scheduledTime:"11:00"});
 await q("DELETE FROM provider_blocks WHERE id=$1",[block.id]);
 expect(await rescheduleAppointment(transfer,actor)).toMatchObject({ok:true,appointment:{doctorId:f.doctorId,doctorName:f.doctorName}});
 await q("UPDATE clinical_cases SET responsible_party_id=$2 WHERE id=$1",[f.clinicalId,f.oldDoctorId]);
 expect(await rescheduleAppointment({...transfer,time:"17:00"},actor)).toMatchObject({ok:false,status:409,code:"return_booking_source_changed"});
 expect(await db.getAppointment(old.id)).toMatchObject({doctorId:f.doctorId,scheduledTime:"16:00"});
 expect(await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patientId])).toHaveLength(1);
});
it("enforces current clinician availability for a sourced return without a catalogue service", async () => {
 const f = await fixture(); const input = await request(f);
 await q("INSERT INTO provider_blocks(provider_id,starts_at,ends_at,reason,created_by) VALUES ($1,$2::timestamp AT TIME ZONE 'Asia/Aden',$3::timestamp AT TIME ZONE 'Asia/Aden','Synthetic unavailable','synthetic')",[f.doctorId,`${f.request.date} 15:30`,`${f.request.date} 17:00`]);
 expect(await bookAppointment({...input,appointmentType:null},actor)).toMatchObject({ok:false,status:409});
 expect(await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patientId])).toEqual([]);
});
it("rejects ABA responsibility fingerprints after an audited owner A to B to A cycle", async () => {
 const f=await fixture();const{patientResponsibilitySettings}=await import("../../lib/patient-responsibility-settings");
 const admin=await session("admin");const target={patientId:f.patientId,kind:"clinical" as const,sourceId:f.clinicalId};
 const originalSettings=await patientResponsibilitySettings(target,admin);const originalBooking=await request(f);
 const changed=await patientResponsibilitySettings(target,admin,{expectedSourceFingerprint:originalSettings.sourceFingerprint,doctorId:f.oldDoctorId,reason:"Synthetic A to B handover"});
 const restored=await patientResponsibilitySettings(target,admin,{expectedSourceFingerprint:changed.sourceFingerprint,doctorId:f.doctorId,reason:"Synthetic B to A handover"});
 expect(restored.doctorId).toBe(originalSettings.doctorId);
 expect(restored.sourceFingerprint).not.toBe(originalSettings.sourceFingerprint);
 const freshBooking=await request(f);expect(freshBooking.returnBookingFingerprint).not.toBe(originalBooking.returnBookingFingerprint);
 await expect(patientResponsibilitySettings(target,admin,{expectedSourceFingerprint:originalSettings.sourceFingerprint,doctorId:f.oldDoctorId,reason:"Synthetic stale ABA command"})).rejects.toMatchObject({status:409});
 expect(await bookAppointment(originalBooking,actor)).toMatchObject({ok:false,code:"return_booking_source_changed"});
 expect(await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patientId])).toEqual([]);
 expect(await q("SELECT id FROM audit_log WHERE action='case.responsibility_change' AND entity_id=$1",[String(f.patientId)])).toHaveLength(2);
 expect(await bookAppointment(freshBooking,actor)).toMatchObject({ok:true,appointment:{doctorId:f.doctorId}});
});
it("rejects a stale time-only move after a same-slot current-owner transfer wins",async()=>{
 const f=await fixture();const[old]=await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,doctor_id,duration_minutes) VALUES ($1,$2,'10:00',$3,15) RETURNING id",[f.patientId,f.request.date,f.oldDoctorId]);
 const{rescheduleAppointment}=await import("../../lib/book-appointment");const source=await preview(f);if(!source.ok)throw new Error(source.message);
 await q(`CREATE FUNCTION synthetic_return_transfer_gate() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.id=${old.id} AND NEW.doctor_id=${f.doctorId} THEN PERFORM pg_advisory_xact_lock(8970631); END IF; RETURN NEW; END $$;
  CREATE TRIGGER synthetic_return_transfer_gate BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION synthetic_return_transfer_gate()`);
 const gate=await observer.connect();let transfer:ReturnType<typeof rescheduleAppointment>|undefined;let stale:ReturnType<typeof rescheduleAppointment>|undefined;
 try{
  await gate.query("BEGIN");const{rows:[info]}=await gate.query<{pid:number}>("SELECT pg_backend_pid() AS pid");await gate.query("SELECT pg_advisory_xact_lock(8970631)");
  transfer=rescheduleAppointment({appointmentId:old.id,date:f.request.date,time:"10:00",reason:"Synthetic explicit clinician transfer",transferToCurrentResponsibleDoctor:true,returnBookingSource:f.request.returnBookingSource,returnBookingFingerprint:source.fingerprint},actor);
  const transferringPid=await blockedBy(info.pid,"UPDATE appointments");
  stale=rescheduleAppointment({appointmentId:old.id,date:f.request.date,time:"11:00",reason:"Synthetic stale time-only move"},actor);
  await blockedBy(transferringPid,"pg_advisory_xact_lock");
  await gate.query("COMMIT");expect(await transfer).toMatchObject({ok:true,appointment:{doctorId:f.doctorId,scheduledTime:"10:00"}});
  expect(await stale).toMatchObject({ok:false,status:409});
  expect(await db.getAppointment(old.id)).toMatchObject({doctorId:f.doctorId,scheduledTime:"10:00"});
 }finally{
  await gate.query("ROLLBACK");await transfer?.catch(()=>{});await stale?.catch(()=>{});gate.release();
  await q("DROP TRIGGER synthetic_return_transfer_gate ON appointments; DROP FUNCTION synthetic_return_transfer_gate()");
 }
});
it("keeps explicit non-provider service parallel semantics while a service-less return consumes its assigned clinician",async()=>{
 const f=await fixture();const input=await request(f);
 const created=await db.createAppointmentService({code:`SYN_NON_PROVIDER_${sequence}`,nameAr:"Synthetic attributed non-provider work",specialty:"general",defaultDurationMinutes:15,bufferBeforeMinutes:0,bufferAfterMinutes:0,requiresProvider:false,requiresChair:false,allowsConcurrentProviderWork:false,consumesEmergencyReserve:false,priority:50,isActive:true,sortOrder:1},{actor:"synthetic-admin",actorRole:"admin"});
 if(!created.ok)throw new Error(created.message);
 await q("INSERT INTO provider_blocks(provider_id,starts_at,ends_at,reason,created_by) VALUES ($1,$2::timestamp AT TIME ZONE 'Asia/Aden',$3::timestamp AT TIME ZONE 'Asia/Aden','Synthetic unavailable','synthetic')",[f.doctorId,`${f.request.date} 15:30`,`${f.request.date} 17:00`]);
 expect(await bookAppointment({...input,appointmentType:null,serviceId:null},actor)).toMatchObject({ok:false,status:409});
 expect(await bookAppointment({...input,appointmentType:null,serviceId:created.service.id},actor)).toMatchObject({ok:true,appointment:{doctorId:f.doctorId,serviceId:created.service.id}});
 expect(await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patientId])).toHaveLength(1);
});
