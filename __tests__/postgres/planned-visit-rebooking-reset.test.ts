import { afterAll, beforeEach, expect, it } from 'vitest';
import { assertRealPostgresUrl, stubPostgresEnv, dropPublicSchema, rawPool } from './_setup';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { PLANNED_REBOOK_GENERATION_SQL } from '../../lib/planned-visit-rebooking-contract';
assertRealPostgresUrl();stubPostgresEnv();process.env.SESSION_SECRET='synthetic-rebooking-reset-test-secret';
const db=await import('../../lib/db');
const {rebookPlannedVisit}=await import('../../lib/planned-visit-rebooking');
const observer=rawPool(assertRealPostgresUrl(),3);
const q=async(sql:string,args:unknown[]=[]) => (await db.getPool().query(sql,args)).rows;
let actor:SessionPayload;let serial=0;
const reset=()=>db.resetClinicData({actor:'synthetic-reset-owner',actorRole:'admin'},async()=>({ok:true as const,backupId:'synthetic-test-snapshot'}));
const generation=async()=>(await q(`SELECT ${PLANNED_REBOOK_GENERATION_SQL} AS value`))[0].value as string;
beforeEach(async()=>{
  await db.resetPoolForTesting();
  await dropPublicSchema(assertRealPostgresUrl());await db.ensureSchema();
  const [user]=await q("INSERT INTO users(username,display_name,password_hash,role) VALUES ('synthetic-reset-reception','Synthetic','synthetic-reset-hash','reception') RETURNING id");
  actor={userId:user.id,username:'synthetic-reset-reception',role:'reception',partyId:null,expiresAt:Date.now()+3_600_000,credentialVersion:sessionCredentialVersion('synthetic-reset-hash')};
  expect(await reset()).toMatchObject({ok:true});
});
afterAll(async()=>{await db.resetPoolForTesting();await observer.end();});
async function fixture(){
  const n=++serial;const [patient]=await q("INSERT INTO patients(patient_number,full_name) VALUES ($1,'Synthetic reset patient') RETURNING id",[`SYN-GEN-${n}`]);
  const [plan]=await q("INSERT INTO treatment_plans(patient_id,title,total_minor) VALUES ($1,'Synthetic retained plan',100) RETURNING id",[patient.id]);
  const [item]=await q("INSERT INTO plan_items(plan_id,service_name,unit_price_minor) VALUES ($1,'Synthetic retained item',100) RETURNING id",[plan.id]);
  const [appointment]=await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status,ended_at) VALUES ($1,CURRENT_DATE-1,'10:00','no_show',NOW()) RETURNING id",[patient.id]);
  const [planned]=await q("INSERT INTO planned_visits(patient_id,plan_id,title,status,appointment_id,sequence) VALUES ($1,$2,'Synthetic generation session','scheduled',$3,1) RETURNING id",[patient.id,plan.id,appointment.id]);
  await q('UPDATE appointments SET planned_visit_id=$2 WHERE id=$1',[appointment.id,planned.id]);
  await q('INSERT INTO treatment_sessions(plan_item_id,planned_visit_id,sequence) VALUES ($1,$2,1)',[item.id,planned.id]);
  const [view]=await db.listPatientPlannedVisits(patient.id);
  const [day]=await q("SELECT ((NOW() AT TIME ZONE $1)::date+100)::text AS value",[db.CLINIC_TIME_ZONE]);
  return {patient:patient.id,planned:planned.id,old:appointment.id,input:{plannedVisitId:planned.id,expectedAppointmentId:appointment.id,expectedGeneration:view.rebookGeneration,date:day.value as string,time:'10:00',reason:'Synthetic reschedule reason',requestId:`synthetic-generation-attempt-${n}`}};
}
async function snapshot(){
  const result:Record<string,string>={};
  for(const table of ['patients','appointments','planned_visits','treatment_plans','plan_items','treatment_sessions','visits','invoices','invoice_items','payments','audit_log']){
    result[table]=(await q(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) AS value FROM ${table} t`))[0].value;
  }return result;
}
async function waitForLock(advisory:boolean,minimum=1){
  const end=Date.now()+10_000;while(Date.now()<end){
    if((await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (wait_event='advisory')=$1 AND pid<>pg_backend_pid()",[advisory])).rows.length>=minimum)return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }throw new Error('Synthetic generation writer did not reach barrier');
}
it('rejects pre-empty-reset generation against newly created valid IDs without mutating clinical or financial rows',async()=>{
  const staleGeneration=await generation();
  expect(await reset()).toMatchObject({ok:true});
  const fresh=await fixture();
  expect(fresh.input.expectedGeneration).not.toBe(staleGeneration);
  const before=await snapshot();
  expect(await rebookPlannedVisit({...fresh.input,expectedGeneration:staleGeneration},actor)).toMatchObject({ok:false,status:409});
  expect(await snapshot()).toEqual(before);
  expect(await rebookPlannedVisit(fresh.input,actor)).toMatchObject({ok:true,replayed:false});
});
it('populated reset refuses before backup, preserves generation and replays only the saved original appointment',async()=>{
  const old=await fixture();const saved=await rebookPlannedVisit(old.input,actor);expect(saved).toMatchObject({ok:true,appointmentId:2});
  const unsaved={...old.input,requestId:old.input.requestId+'-never-committed'};
  const version=await generation(),beforeReset=await snapshot();let backupCalled=false;
  await expect(db.resetClinicData({actor:'synthetic-reset-owner',actorRole:'admin'},async()=>{
    backupCalled=true;return {ok:true,backupId:'must-not-run'};
  })).rejects.toMatchObject({name:'ProtectedPatientNumberHistoryError'});
  expect(backupCalled).toBe(false);expect(await generation()).toBe(version);expect(await snapshot()).toEqual(beforeReset);
  const unrelated=await fixture();expect(unrelated.patient).not.toBe(old.patient);expect(unrelated.old).not.toBe(2);
  const before=await snapshot();
  expect(await rebookPlannedVisit(old.input,actor)).toEqual({...saved,replayed:true});
  expect(await rebookPlannedVisit(unsaved,actor)).toMatchObject({ok:false,status:409});
  expect(await snapshot()).toEqual(before);
});
it('patient-free reset fences a queued stale intent until reset commit and day-lock release',async()=>{
  const staleGeneration=await generation();
  const [day]=await q("SELECT ((NOW() AT TIME ZONE $1)::date+100)::text AS value",[db.CLINIC_TIME_ZONE]);
  // A cached request may name IDs that do not currently exist. Do not manufacture
  // or delete patient identities to make a populated reset succeed.
  const stale={plannedVisitId:1,expectedAppointmentId:1,expectedGeneration:staleGeneration,date:day.value as string,
    time:'10:00',reason:'Synthetic stale cached intent',requestId:'synthetic-queued-stale-reset'};
  const gate=await observer.connect();let pending:ReturnType<typeof rebookPlannedVisit>|undefined;let resetting:ReturnType<typeof reset>|undefined;
  let releaseReset!:()=>void;let reachedReset!:()=>void;
  const backupGate=new Promise<void>(resolve=>{releaseReset=resolve;});const backupReached=new Promise<void>(resolve=>{reachedReset=resolve;});
  try{
    await gate.query("SELECT pg_advisory_lock(hashtext('appointments-day:' || $1))",[stale.date]);
    resetting=db.resetClinicData({actor:'synthetic-reset-owner',actorRole:'admin'},async()=>{reachedReset();await backupGate;return {ok:true,backupId:'synthetic-reset-barrier'};});
    await Promise.race([backupReached,resetting.then(()=>{throw new Error('Reset ended before backup barrier');})]);
    pending=rebookPlannedVisit(stale,actor);await waitForLock(true);
    releaseReset();expect(await resetting).toMatchObject({ok:true});await waitForLock(true);
    const fresh=await fixture();expect([fresh.planned,fresh.old]).toEqual([stale.plannedVisitId,stale.expectedAppointmentId]);
    expect(fresh.input.expectedGeneration).not.toBe(staleGeneration);const before=await snapshot();
    await gate.query("SELECT pg_advisory_unlock(hashtext('appointments-day:' || $1))",[stale.date]);
    expect(await pending).toMatchObject({ok:false,status:409});expect(await snapshot()).toEqual(before);
  }finally{releaseReset();await gate.query("SELECT pg_advisory_unlock(hashtext('appointments-day:' || $1))",[stale.date]);gate.release();await pending;await resetting;}
});
it('patient-free reset audit failure rolls back the wipe and generation fence, retaining valid future rebooking',async()=>{
  await q("INSERT INTO cashier_shifts(opened_by,status) VALUES('synthetic audit-failure witness','closed')");
  const before=await snapshot();const shifts=(await q('SELECT to_jsonb(t) AS row FROM cashier_shifts t ORDER BY id'));
  const version=await generation();
  await q("CREATE FUNCTION synthetic_reset_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='system.reset' THEN RAISE EXCEPTION 'synthetic reset audit failure'; END IF; RETURN NEW; END $$");
  await q('CREATE TRIGGER synthetic_reset_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_reset_audit_failure()');
  try{
    await expect(reset()).rejects.toThrow('synthetic reset audit failure');expect(await generation()).toBe(version);expect(await snapshot()).toEqual(before);
    expect(await q('SELECT to_jsonb(t) AS row FROM cashier_shifts t ORDER BY id')).toEqual(shifts);
  }finally{await q('DROP TRIGGER synthetic_reset_audit_failure ON audit_log; DROP FUNCTION synthetic_reset_audit_failure()');}
  const f=await fixture();expect(f.input.expectedGeneration).toBe(version);
  expect(await rebookPlannedVisit(f.input,actor)).toMatchObject({ok:true,replayed:false});
});
it('reset waits for locked rebooking commit then refuses without rotating generation or losing the receipt',async()=>{
  const f=await fixture();const gate=await observer.connect();let pending:ReturnType<typeof rebookPlannedVisit>|undefined;let resetting:Promise<{error:unknown}>|undefined;
  await q(`CREATE FUNCTION synthetic_generation_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.patient_id=${f.patient} THEN PERFORM pg_advisory_xact_lock(831199); END IF; RETURN NEW; END $$`);
  await q('CREATE TRIGGER synthetic_generation_barrier BEFORE INSERT ON appointments FOR EACH ROW EXECUTE FUNCTION synthetic_generation_barrier()');
  try{
    await gate.query('SELECT pg_advisory_lock(831199)');pending=rebookPlannedVisit(f.input,actor);await waitForLock(true);
    let resetFinished=false;resetting=reset().then(()=>{throw new Error('Populated reset unexpectedly succeeded');},error=>({error})).finally(()=>{resetFinished=true;});
    await waitForLock(true,2);expect(resetFinished).toBe(false);
    await gate.query('SELECT pg_advisory_unlock(831199)');const saved=await pending;expect(saved).toMatchObject({ok:true});
    expect((await resetting).error).toMatchObject({name:'ProtectedPatientNumberHistoryError'});
    expect(await generation()).toBe(f.input.expectedGeneration);
    const before=await snapshot();expect(await rebookPlannedVisit(f.input,actor)).toEqual({...saved,replayed:true});expect(await snapshot()).toEqual(before);
  }finally{await gate.query('SELECT pg_advisory_unlock(831199)');gate.release();await pending;await resetting;await q('DROP TRIGGER synthetic_generation_barrier ON appointments; DROP FUNCTION synthetic_generation_barrier()');}
});
it('uses database microsecond epoch plus reset ID, stable across timezones',async()=>{
  const fake=async(stamp:string,zone:string)=>(await q(`WITH audit_log(id,created_at,action) AS (VALUES (9,$1::timestamptz,'system.reset')) SELECT ${PLANNED_REBOOK_GENERATION_SQL} AS value`,[stamp+zone]))[0].value;
  const a=await fake('2026-01-01 00:00:00.000001','+00');const b=await fake('2026-01-01 00:00:00.000002','+00');
  expect(a).not.toBe(b);expect(await fake('2026-01-01 03:00:00.000001','+03')).toBe(a);
});
