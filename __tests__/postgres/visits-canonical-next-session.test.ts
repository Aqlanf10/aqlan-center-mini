/** Slice 28, synthetic PostgreSQL: scoped next-session writer, old engine, atomic effects. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-next-session-postgres-20261030");
const db = await import("../../lib/db");
const { commandCanonicalNextSession: command } = await import("../../lib/canonical-next-session");
const { readReturnBookingContext } = await import("../../lib/return-booking-context");
const CREATE = { "appointments.create": true };
const ACCOUNTS = {
  owner: { username: "SYN-NEXT-OWNER", role: "admin" },
  desk: { username: "SYN-NEXT-DESK", role: "admin", patientScope: "all", appointmentScope: "all", grants: CREATE },
  override: { username: "SYN-NEXT-OVERRIDE", role: "reception", patientScope: "all", appointmentScope: "all", grants: { ...CREATE, "appointments.override-capacity": true } },
  own: { username: "SYN-NEXT-OWN", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "own", grants: CREATE },
  broad: { username: "SYN-NEXT-BROAD", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "all", grants: { ...CREATE, "finance.payments.view": true } },
  other: { username: "SYN-NEXT-OTHER", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "own", grants: CREATE },
  reader: { username: "SYN-NEXT-READER", role: "admin", patientScope: "all", appointmentScope: "all", grants: {} },
  noPatients: { username: "SYN-NEXT-NOPATIENTS", role: "reception", appointmentScope: "all", grants: CREATE },
  noAppointments: { username: "SYN-NEXT-NOAPPOINTMENTS", role: "reception", patientScope: "all", grants: CREATE },
  pending: { username: "SYN-NEXT-PENDING", role: "reception", patientScope: "all", appointmentScope: "all", grants: CREATE, confirmation: "pending" },
  revoked: { username: "SYN-NEXT-REVOKED", role: "reception", patientScope: "all", appointmentScope: "all", grants: CREATE },
  expired: { username: "SYN-NEXT-EXPIRED", role: "reception", patientScope: "all", appointmentScope: "all", grants: CREATE },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const DATE = "2027-10-12";
async function fixture(doctorId = fx.parties.own!) {
  const n = ++serial;
  const [p] = await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id,phone) VALUES ($1,'SYN next patient',$2,$3) RETURNING id", [`SYN-NEXT-${n}`, doctorId, `967771${String(n).padStart(6,"0")}`]);
  const [c] = await q("INSERT INTO clinical_cases(patient_id,specialty,title,responsible_party_id,created_by) VALUES ($1,'general','SYN next case',$2,'synthetic') RETURNING id", [p.id,doctorId]);
  const [v] = await q("INSERT INTO visits(patient_id,patient_name,doctor_id,case_id,status) VALUES ($1,'SYN next patient',$2,$3,'done') RETURNING id", [p.id,doctorId,c.id]);
  const preview = await readReturnBookingContext(fx.pool,p.id,{kind:"visit",id:v.id}); if (!preview.ok) throw new Error(preview.message);
  return { id:v.id as number, patientId:p.id as number, caseId:c.id as number, body:{date:DATE,time:"10:00",durationMinutes:30,returnBookingFingerprint:preview.fingerprint} };
}
const book = async (key: Key, f: Awaited<ReturnType<typeof fixture>>, body = f.body) => command(await fx.session(key), f.id, body);
const count = async (patientId: number) => Number((await q("SELECT count(*) FROM appointments WHERE patient_id=$1",[patientId]))[0].count);
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db,ACCOUNTS,"owner");
  for (const [key,value] of [["clinic.chairs","1"],["clinic.day_start","08:00"],["clinic.day_end","20:00"]]) await q("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[key,value]);
},180_000);
afterAll(async () => { await fx?.close(); });
it("books the current responsible doctor, ignoring a forged doctor, with an atomic canonical actor audit",async () => {
  const f=await fixture(); const result=await book("desk",f,{...f.body,doctorId:fx.parties.other} as typeof f.body);
  expect(result).toMatchObject({ok:true,value:{patientId:f.patientId,doctorId:fx.parties.own}}); if(!result.ok)return;
  expect(await q("SELECT doctor_id FROM appointments WHERE id=$1",[result.value.appointmentId])).toEqual([{doctor_id:fx.parties.own}]);
  expect(await q("SELECT actor FROM audit_log WHERE action='appointment.create' AND entity_id=$1::text",[result.value.appointmentId])).toEqual([{actor:"SYN-NEXT-DESK"}]);
});
it("same-time retries and races preserve one booking even for owner/override",async () => {
  const f=await fixture(); const body={...f.body,date:"2027-10-13"};
  const results=await Promise.all([book("owner",f,body),book("override",f,body)]);
  expect(results.filter(r=>r.ok)).toHaveLength(1); expect(await count(f.patientId)).toBe(1);
  expect((await book("owner",f,body)).ok).toBe(false);
  expect(Number((await q("SELECT count(*) FROM audit_log l JOIN appointments a ON l.entity_id=a.id::text WHERE l.action='appointment.create' AND a.patient_id=$1",[f.patientId]))[0].count)).toBe(1);
});
it("different-time retries require a fresh nearby confirmation; confirmation is not a replay receipt",async () => {
  const f=await fixture(); const body={...f.body,date:"2027-10-14"}; expect((await book("desk",f,body)).ok).toBe(true);
  const warning=await book("desk",f,{...body,time:"11:00"}); expect(warning).toMatchObject({ok:false,conflict:{kind:"nearby_patient_appointments"}});
  expect(await count(f.patientId)).toBe(1);
  if(warning.ok)return; const token=(warning.conflict as {confirmationToken:string}).confirmationToken;
  expect((await book("desk",f,{...body,time:"11:00",nearbyAppointmentConfirmation:token} as typeof body)).ok).toBe(true);
  expect(await count(f.patientId)).toBe(2);
});
it("own patient/appointment scopes allow legitimate visits; another patient equals missing",async () => {
  const mine=await fixture(), theirs=await fixture(fx.parties.other!);
  expect((await book("own",mine,{...mine.body,date:"2027-10-15"})).ok).toBe(true);
  const outside=await book("own",theirs).catch(e=>e), missing=await command(await fx.session("own"),999999,theirs.body).catch(e=>e);
  expect(outside).toMatchObject({status:404,code:"visit_not_found"}); expect([outside.code,outside.message]).toEqual([missing.code,missing.message]); expect(await count(theirs.patientId)).toBe(0);
});
it("own appointment scope refuses another responsible doctor; all appointment scope can book that legitimate patient's case",async () => {
  const f=await fixture(fx.parties.other!); await q("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1",[f.patientId,fx.parties.own!]);
  await expect(book("own",f)).rejects.toMatchObject({status:403,code:"next_session_doctor_not_allowed"}); expect(await count(f.patientId)).toBe(0);
  await q("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1",[f.patientId,fx.parties.broad!]);
  expect((await book("broad",f,{...f.body,date:"2027-10-16"})).ok).toBe(true);
});
it("own patients + all appointments cannot book an outside visit for self or acquire its patient/payment scope",async () => {
  const f=await fixture(fx.parties.other!);
  expect(await db.patientInDoctorScopeWith(fx.pool,fx.parties.broad!,f.patientId)).toBe(false);
  await expect(book("broad",f,{...f.body,doctorId:fx.parties.broad!} as typeof f.body)).rejects.toMatchObject({status:404});
  expect(await count(f.patientId)).toBe(0); expect(await db.patientInDoctorScopeWith(fx.pool,fx.parties.broad!,f.patientId)).toBe(false);
});
it("walk-in phone resolution cannot link an outside patient first and manufacture own access",async () => {
  const f=await fixture(fx.parties.other!); const [p]=await q("SELECT phone FROM patients WHERE id=$1",[f.patientId]);
  await q("UPDATE visits SET patient_id=NULL,doctor_id=$2,patient_phone=$3 WHERE id=$1",[f.id,fx.parties.broad!,p.phone]);
  await expect(book("broad",f)).rejects.toMatchObject({status:404});
  expect((await q("SELECT patient_id FROM visits WHERE id=$1",[f.id]))[0].patient_id).toBeNull();
  expect(await db.patientInDoctorScopeWith(fx.pool,fx.parties.broad!,f.patientId)).toBe(false); expect(await count(f.patientId)).toBe(0);
});
it("a legitimate phone-linked walk-in keeps the same existing patient and responsibility; no create grant is needed",async () => {
  const f=await fixture(); const [p]=await q("SELECT phone FROM patients WHERE id=$1",[f.patientId]);
  await q("UPDATE visits SET patient_id=NULL,patient_phone=$2 WHERE id=$1",[f.id,p.phone]);
  expect((await book("own",f,{...f.body,date:"2027-10-17"})).ok).toBe(true);
  expect((await q("SELECT patient_id FROM visits WHERE id=$1",[f.id]))[0].patient_id).toBe(f.patientId);
});
it("actual new-file branch needs patients.create; even owner cannot invent clinical return provenance",async () => {
  const f=await fixture(); await q("UPDATE visits SET patient_id=NULL,case_id=NULL,patient_phone=NULL WHERE id=$1",[f.id]);
  const before=Number((await q("SELECT count(*) FROM patients"))[0].count);
  await expect(book("desk",f)).rejects.toMatchObject({status:403,code:"patient_create_required"});
  await expect(book("owner",f)).rejects.toMatchObject({status:409,code:"return_source_missing"});
  expect(Number((await q("SELECT count(*) FROM patients"))[0].count)).toBe(before); expect((await q("SELECT patient_id FROM visits WHERE id=$1",[f.id]))[0].patient_id).toBeNull();
});
it.each(["reader","noPatients","noAppointments","pending"] as const)("%s cannot borrow a role label or missing scope",async key => {
  const f=await fixture(); await expect(book(key,f)).rejects.toThrow(/^STAFF_OPERATION_/); expect(await count(f.patientId)).toBe(0);
});
it("stale permission revision and revoked session are rejected",async () => {
  const f=await fixture(), session=await fx.session("revoked"); await fx.setGrants("revoked",{});
  await expect(command(session,f.id,f.body)).rejects.toThrow(/^STAFF_OPERATION_/);
  await expect(book("revoked",f)).rejects.toThrow(/^STAFF_OPERATION_/); expect(await count(f.patientId)).toBe(0);
});
it("changed/closed responsibility, wrong origin and missing fingerprint refuse without effects",async () => {
  const f=await fixture(), other=await fixture();
  await expect(book("desk",f,{...f.body,returnBookingFingerprint:"b".repeat(64)})).rejects.toMatchObject({code:"return_booking_source_changed"});
  await expect(book("desk",f,{...f.body,returnBookingSource:{kind:"clinical_case",id:other.caseId}} as typeof f.body)).rejects.toMatchObject({status:409});
  await expect(book("desk",f,{...f.body,returnBookingFingerprint:undefined} as unknown as typeof f.body)).rejects.toMatchObject({code:"return_booking_context_required"});
  await q("UPDATE clinical_cases SET status='closed',completed_at=NOW() WHERE id=$1",[f.caseId]);
  await expect(book("desk",f)).rejects.toMatchObject({code:"return_source_closed"}); expect(await count(f.patientId)).toBe(0);
});
it.each([{date:"2027-02-30"},{time:"24:60"},{durationMinutes:0},{durationMinutes:481},{durationMinutes:3.5}])("invalid input %j never writes",async change => {
  const f=await fixture(); await expect(book("desk",f,{...f.body,...change})).rejects.toMatchObject({status:400}); expect(await count(f.patientId)).toBe(0);
});
it("capacity uses the existing engine; only the grant plus reason overrides, audited",async () => {
  const f=await fixture(fx.parties.other!);
  const refused=await book("desk",f,{...f.body,overrideReason:"SYN urgent"} as typeof f.body); expect(refused.ok).toBe(false);
  expect((await book("override",f,{...f.body,overrideReason:"SYN urgent"} as typeof f.body)).ok).toBe(true);
  expect((await q("SELECT actor FROM audit_log WHERE action='appointment.capacity_override'")).map(r=>r.actor)).toContain("SYN-NEXT-OVERRIDE");
});
it("an audit failure rolls back booking AND walk-in link/phone changes",async () => {
  const f=await fixture(); const [p]=await q("SELECT phone FROM patients WHERE id=$1",[f.patientId]);
  await q("UPDATE visits SET patient_id=NULL,patient_phone=$2 WHERE id=$1",[f.id,p.phone]);
  await q("ALTER TABLE audit_log ADD CONSTRAINT syn_next_audit CHECK(action <> 'appointment.create') NOT VALID");
  try { await expect(book("desk",f,{...f.body,date:"2027-10-19"})).rejects.toThrow(); expect(await count(f.patientId)).toBe(0); expect((await q("SELECT patient_id FROM visits WHERE id=$1",[f.id]))[0].patient_id).toBeNull(); }
  finally { await q("ALTER TABLE audit_log DROP CONSTRAINT syn_next_audit"); }
});
async function waitFor(lock: Client,type="advisory") { for(let i=0;i<160;i++){ if((await lock.query("SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND l.locktype=$1 AND a.datname=current_database()",[type])).rowCount)return; await new Promise(r=>setTimeout(r,25)); } throw new Error(`no ${type} waiter`); }
it("expiry after an actual day-lock wait refuses, with no booking or link",async () => {
  const f=await fixture(), lock=new Client({connectionString:process.env.DATABASE_URL}); await lock.connect();
  try {
    await lock.query("BEGIN"); await lock.query("SELECT pg_advisory_xact_lock(hashtext('appointments-day:' || $1))",[f.body.date]);
    const session=await fx.session("expired",1500), pending=command(session,f.id,f.body); pending.catch(()=>{}); await waitFor(lock);
    await new Promise(r=>setTimeout(r,1600)); await lock.query("COMMIT"); await expect(pending).rejects.toThrow(/^STAFF_OPERATION_/); expect(await count(f.patientId)).toBe(0);
  } finally { await lock.query("ROLLBACK").catch(()=>{}); await lock.end(); }
});
it("scope changed while waiting for the day is read again, so preflight cannot authorize a stale relationship",async () => {
  const f=await fixture(), lock=new Client({connectionString:process.env.DATABASE_URL}); await lock.connect();
  try {
    await lock.query("BEGIN"); await lock.query("SELECT pg_advisory_xact_lock(hashtext('appointments-day:' || $1))",[f.body.date]);
    const pending=book("own",f); pending.catch(()=>{}); await waitFor(lock);
    await lock.query("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1",[f.patientId,fx.parties.other!]);
    await lock.query("UPDATE visits SET doctor_id=$2 WHERE id=$1",[f.id,fx.parties.other!]);
    await lock.query("UPDATE clinical_cases SET responsible_party_id=$2 WHERE id=$1",[f.caseId,fx.parties.other!]);
    await lock.query("COMMIT"); await expect(pending).rejects.toMatchObject({status:404}); expect(await count(f.patientId)).toBe(0);
  } finally { await lock.query("ROLLBACK").catch(()=>{}); await lock.end(); }
});
it("admitted booking serializes grant revocation; subsequent requests deny",async () => {
  await fx.setGrants("revoked",CREATE,{patientScope:"all",appointmentScope:"all"}); const f=await fixture(), session=await fx.session("revoked"), body={...f.body,date:"2027-10-20"};
  const lock=new Client({connectionString:process.env.DATABASE_URL}); await lock.connect();
  try {
    await lock.query("BEGIN"); await lock.query("SELECT pg_advisory_xact_lock(hashtext('appointments-day:' || $1))",[body.date]);
    const pending=command(session,f.id,body); pending.catch(()=>{}); await waitFor(lock);
    let done=false; const revoke=fx.setGrants("revoked",{}).then(()=>{done=true;}); await waitFor(lock,"transactionid"); expect(done).toBe(false);
    await lock.query("COMMIT"); expect((await pending).ok).toBe(true); await revoke;
    await expect(command(session,f.id,body)).rejects.toThrow(/^STAFF_OPERATION_/);
  } finally { await lock.query("ROLLBACK").catch(()=>{}); await lock.end(); }
});
it("reads settings/service/provider blocks on a single admitted connection, without DDL or a nested pool checkout",async () => {
  const f=await fixture(), session=await fx.session("desk"), body={...f.body,date:"2027-10-22"};
  // The fixture pool has max=1; any hidden checkout inside the command deadlocks.
  expect((await command(session,f.id,body,fx.pool)).ok).toBe(true);
});
it("provider unavailability cannot be bypassed by an admin role label",async () => {
  const f=await fixture(),body={...f.body,date:"2027-10-23"};
  await q("INSERT INTO provider_blocks(provider_id,starts_at,ends_at,reason,created_by) VALUES ($1,$2::timestamp AT TIME ZONE 'Asia/Aden',$3::timestamp AT TIME ZONE 'Asia/Aden','SYN unavailable','synthetic')",[fx.parties.own!,`${body.date} 09:00`,`${body.date} 11:00`]);
  expect((await book("desk",f,body)).ok).toBe(false); expect(await count(f.patientId)).toBe(0);
});
it("the override audit is atomic with the appointment and its creation audit",async () => {
  const f=await fixture(),body={...f.body,overrideReason:"SYN urgent"};
  await q("ALTER TABLE audit_log ADD CONSTRAINT syn_next_override CHECK(action <> 'appointment.capacity_override') NOT VALID");
  try { await expect(book("override",f,body)).rejects.toThrow(); expect(await count(f.patientId)).toBe(0); }
  finally { await q("ALTER TABLE audit_log DROP CONSTRAINT syn_next_override"); }
});
it("authority is rechecked after the visit-row wait, not only the day lock",async () => {
  const f=await fixture(),lock=new Client({connectionString:process.env.DATABASE_URL});await lock.connect();
  try {
    await lock.query("BEGIN");await lock.query("SELECT id FROM visits WHERE id=$1 FOR UPDATE",[f.id]);
    const session=await fx.session("expired",1500),pending=command(session,f.id,f.body);pending.catch(()=>{});await waitFor(lock,"transactionid");
    await new Promise(r=>setTimeout(r,1600));await lock.query("COMMIT");await expect(pending).rejects.toThrow(/^STAFF_OPERATION_/);expect(await count(f.patientId)).toBe(0);
  }finally{await lock.query("ROLLBACK").catch(()=>{});await lock.end();}
});
it("capacity settings are read after the wait on the same connection",async () => {
  const f=await fixture(), occupied=await fixture(fx.parties.other!), body={...f.body,date:"2027-10-25"},lock=new Client({connectionString:process.env.DATABASE_URL});await lock.connect();
  await q("UPDATE settings SET value='2' WHERE key='clinic.chairs'"); expect((await book("desk",occupied,{...occupied.body,date:body.date})).ok).toBe(true);
  try {
    await lock.query("BEGIN");await lock.query("SELECT pg_advisory_xact_lock(hashtext('appointments-day:' || $1))",[body.date]);
    const pending=book("desk",f,body);pending.catch(()=>{});await waitFor(lock);
    await lock.query("UPDATE settings SET value='1' WHERE key='clinic.chairs'");await lock.query("COMMIT");
    expect((await pending).ok).toBe(false);expect(await count(f.patientId)).toBe(0);
  }finally{await lock.query("ROLLBACK").catch(()=>{});await lock.end();await q("UPDATE settings SET value='1' WHERE key='clinic.chairs'");}
});
it("concurrent different-day returns filling a blank phone cannot deadlock by upgrading shared patient locks",async () => {
  const f=await fixture();await q("UPDATE patients SET phone=NULL WHERE id=$1",[f.patientId]);
  const [v]=await q("INSERT INTO visits(patient_id,patient_name,doctor_id,case_id,status) VALUES($1,'SYN next patient',$2,$3,'done') RETURNING id",[f.patientId,fx.parties.own!,f.caseId]);
  const context=await readReturnBookingContext(fx.pool,f.patientId,{kind:"visit",id:v.id});if(!context.ok)throw new Error(context.message);
  const first={...f.body,date:"2027-10-27",phone:"967771888777"},second={...first,date:"2027-11-07",returnBookingFingerprint:context.fingerprint};
  const session=await fx.session("desk"),lock=new Client({connectionString:process.env.DATABASE_URL});await lock.connect();
  try {
    await lock.query("BEGIN");await lock.query("SELECT id FROM patients WHERE id=$1 FOR SHARE",[f.patientId]);
    let settled=0;
    const capture=async(p:ReturnType<typeof command>)=>{try{return await p;}catch(e){return e as {code?:string};}finally{settled++;}};
    const attempts=[capture(command(session,f.id,first)),capture(command(session,v.id,second))];
    let reached=false;
    for(let i=0;i<160;i++){
      const waiting=Number((await lock.query("SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND l.locktype='transactionid' AND a.datname=current_database()")).rows[0].count);
      if(waiting>=2||settled===2){reached=true;break;}await new Promise(r=>setTimeout(r,10));
    }
    await lock.query("COMMIT");const results=await Promise.all(attempts);expect(reached).toBe(true);
    for(const result of results)expect("ok" in result ? result.ok : result.code).not.toBe("40P01");
    for(const result of results)expect([true,"55P03"]).toContain("ok" in result ? result.ok : result.code);
    // A conflict is safe to retry only after the failed results have been observed.
    if(await count(f.patientId)===0)expect((await command(session,f.id,first)).ok).toBe(true);
    expect((await q("SELECT phone FROM patients WHERE id=$1",[f.patientId]))[0].phone).toBe("967771888777");
  }finally{await lock.query("ROLLBACK").catch(()=>{});await lock.end();}
});
