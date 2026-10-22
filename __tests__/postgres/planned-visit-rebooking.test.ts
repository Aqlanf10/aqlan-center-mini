import { beforeAll, afterAll, expect, it } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv, dropPublicSchema, rawPool } from "./_setup";
import { addDays, clinicDateString } from "../../lib/schedule";
import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
assertRealPostgresUrl(); stubPostgresEnv();
process.env.SESSION_SECRET = "synthetic-rebooking-test-secret-not-for-production";
const db = await import("../../lib/db");
const { rebookPlannedVisit } = await import("../../lib/planned-visit-rebooking");
const observer = rawPool(assertRealPostgresUrl(), 3);
let serial = 0;
let reception: SessionPayload;
let tomorrow: string;
let shiftId: number;
const q = async (sql: string, args: unknown[] = []) => (await db.getPool().query(sql, args)).rows;
async function actor(role = "reception", partyId: number | null = null): Promise<SessionPayload> {
  const name = `synthetic-rebook-${++serial}`;
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role,party_id) VALUES ($1,'Synthetic actor','synthetic-unused-hash',$2,$3) RETURNING id", [name, role, partyId]);
  return { userId: user.id, username: name, role, partyId, expiresAt: Date.now() + 3_600_000,
    credentialVersion: sessionCredentialVersion("synthetic-unused-hash") };
}
beforeAll(async () => {
  await dropPublicSchema(assertRealPostgresUrl()); await db.ensureSchema();
  shiftId = (await q("INSERT INTO cashier_shifts(opened_by) VALUES ('synthetic') RETURNING id"))[0].id;
  reception = await actor(); tomorrow = addDays(clinicDateString(new Date(), db.CLINIC_TIME_ZONE), 10);
  await q("UPDATE settings SET value = '20' WHERE key = 'clinic.chairs'");
});
afterAll(async () => { await db.resetPoolForTesting(); await observer.end(); });
async function fixture(status: "no_show" | "cancelled" = "no_show") {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES ($1,'Synthetic rebooking patient') RETURNING id", [`SYN-REBOOK-${++serial}`]);
  const [invoice] = await q("INSERT INTO invoices(invoice_number,patient_id,total_minor) VALUES ($1,$2,1200) RETURNING id", [`SYN-INV-${serial}`,patient.id]);
  await q("INSERT INTO invoice_items(invoice_id,description,unit_price_minor,total_minor) VALUES ($1,'Synthetic retained item',1200,1200)",[invoice.id]);
  await q("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,amount_minor,currency,base_amount_minor) VALUES ($1,$2,$3,$4,100,'YER',100)",[`SYN-PAY-${serial}`,patient.id,invoice.id,shiftId]);
  const [plan] = await q("INSERT INTO treatment_plans(patient_id,title,total_minor,status) VALUES ($1,'Synthetic treatment plan',1200,'active') RETURNING id", [patient.id]);
  const [item] = await q("INSERT INTO plan_items(plan_id,service_name,unit_price_minor) VALUES ($1,'Synthetic clinical item',1200) RETURNING id", [plan.id]);
  const [appointment] = await q(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status,ended_at,cancel_reason)
    VALUES ($1, (NOW() AT TIME ZONE $2)::date - 1,'10:00',$3,NOW(),'Synthetic historical reason') RETURNING id`, [patient.id, db.CLINIC_TIME_ZONE, status]);
  const [planned] = await q(`INSERT INTO planned_visits(patient_id,plan_id,sequence,title,status,appointment_id)
    VALUES ($1,$2,1,'Synthetic planned session','scheduled',$3) RETURNING id`, [patient.id, plan.id, appointment.id]);
  await q("UPDATE appointments SET planned_visit_id = $2 WHERE id = $1", [appointment.id, planned.id]);
  await q("INSERT INTO treatment_sessions(plan_item_id,sequence,planned_visit_id) VALUES ($1,1,$2)", [item.id, planned.id]);
  await q("INSERT INTO appointment_status_log(appointment_id,from_status,to_status,reason,actor) VALUES ($1,'booked',$2,'Synthetic historical reason','synthetic')", [appointment.id, status]);
  const input = {plannedVisitId: planned.id as number, expectedAppointmentId: appointment.id as number,
    expectedGeneration: (await db.listPatientPlannedVisits(patient.id))[0].rebookGeneration,
    date: addDays(tomorrow, serial), time: "10:00", reason: "المريض طلب موعدًا بديلًا", requestId: `synthetic-rebook-request-${serial}`};
  return { patient: patient.id as number, plan: plan.id as number, item: item.id as number,
    planned: planned.id as number, old: appointment.id as number, input };
}
async function untouchedFingerprint() {
  const tables = ["invoices", "invoice_items", "payments", "journal_manual", "journal_manual_lines", "patient_opening_balances", "expenses", "payables", "treatment_plans", "plan_items", "treatment_sessions", "visits", "visit_procedures", "plan_installments"];
  const result: Record<string, string> = {};
  for (const table of tables) result[table] = (await q(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text),'')) AS value FROM ${table} t`))[0].value;
  return result;
}
async function assertNoReplacement(f: Awaited<ReturnType<typeof fixture>>) {
  expect((await q("SELECT appointment_id FROM planned_visits WHERE id = $1", [f.planned]))[0].appointment_id).toBe(f.old);
  expect((await q("SELECT id FROM appointments WHERE patient_id = $1", [f.patient])).map(row => row.id)).toEqual([f.old]);
}
it.each(["no_show", "cancelled"] as const)("rebooks %s explicitly, retaining history and all financial/clinical rows", async status => {
  const f = await fixture(status);
  const [before] = await q("SELECT to_jsonb(a) - 'planned_visit_id' AS row FROM appointments a WHERE id = $1", [f.old]);
  const history = await db.listAppointmentStatusLog(f.old);
  const fingerprint = await untouchedFingerprint();
  expect((await db.listPatientPlannedVisits(f.patient))[0]).toMatchObject({appointmentStatus: status, canRebook: true});
  const result = await rebookPlannedVisit(f.input, reception);
  expect(result).toMatchObject({ok: true, replayed: false}); if (!result.ok) throw new Error(result.message);
  expect((await q("SELECT to_jsonb(a) - 'planned_visit_id' AS row FROM appointments a WHERE id = $1", [f.old]))[0]).toEqual(before);
  expect(await db.listAppointmentStatusLog(f.old)).toEqual(history);
  expect(await untouchedFingerprint()).toEqual(fingerprint);
  expect(await q("SELECT id,planned_visit_id,status FROM appointments WHERE patient_id = $1 ORDER BY id", [f.patient])).toEqual([
    {id: f.old, planned_visit_id: null, status}, {id: result.appointmentId, planned_visit_id: f.planned, status: "booked"}]);
  expect((await q("SELECT details FROM audit_log WHERE action='planned_visit.rebook' AND entity_id=$1", [String(f.planned)]))[0].details).toMatchObject({
    requestId: f.input.requestId, actorUserId: reception.userId, oldAppointmentId: f.old, newAppointmentId: result.appointmentId,
    oldAppointment: {status, planned_visit_id: f.planned}, newAppointment: {status: "booked", planned_visit_id: f.planned}, intent: {reason: f.input.reason},
  });
  expect((await db.listPatientPlannedVisits(f.patient))[0]).toMatchObject({appointmentStatus: "booked", canRebook: false});
});
it("lost reply: identical request returns the saved replacement, changed payload conflicts", async () => {
  const f = await fixture(); const first = await rebookPlannedVisit(f.input, reception);
  expect(await rebookPlannedVisit(f.input, reception)).toEqual({...first, replayed: true});
  for (const edit of [{time: "11:00"}, {reason: "سبب مختلف"}, {date: addDays(f.input.date,1)}, {expectedAppointmentId: f.old + 1000}]) {
    expect(await rebookPlannedVisit({...f.input,...edit}, reception)).toMatchObject({ok: false,status: 409});
  }
  expect((await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patient]))).toHaveLength(2);
});
it("same ID retries stay idempotent under concurrent requests on the same day", async () => {
  const f = await fixture(); const results = await Promise.all([rebookPlannedVisit(f.input,reception), rebookPlannedVisit(f.input,reception)]);
  expect(results.every(row => row.ok)).toBe(true);
  expect(results.filter(row => row.ok && !row.replayed)).toHaveLength(1);
  expect((await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patient]))).toHaveLength(2);
});
it("different day competing attempts create only one replacement", async () => {
  const f = await fixture(); const results = await Promise.all([rebookPlannedVisit(f.input,reception), rebookPlannedVisit({...f.input,date:addDays(f.input.date,1),requestId:f.input.requestId+'-other'},reception)]);
  expect(results.filter(row=>row.ok)).toHaveLength(1); expect(results.filter(row=>!row.ok && row.status===409)).toHaveLength(1);
  expect((await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patient]))).toHaveLength(2);
});
it.each(["booked", "arrived", "done"])("rejects nonterminal appointment %s", async status => {
  const f = await fixture(); await q("UPDATE appointments SET status=$2 WHERE id=$1",[f.old,status]);
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409}); await assertNoReplacement(f);
});
it.each(["completed", "cancelled", "in_progress"])("rejects planned state %s", async status => {
  const f = await fixture(); await q("UPDATE planned_visits SET status=$2 WHERE id=$1",[f.planned,status]);
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409}); await assertNoReplacement(f);
});
it.each(["arrival", "started", "visit", "signed", "completed_session", "session_visit", "status_log"])("rejects %s evidence without writing", async evidence => {
  const f = await fixture();
  if (evidence === "arrival" || evidence === "started") await q(`UPDATE appointments SET ${evidence === "arrival" ? "arrived_at" : "started_at"}=NOW() WHERE id=$1`,[f.old]);
  if (["visit","signed","session_visit"].includes(evidence)) {
    const [v] = await q(`INSERT INTO visits(patient_name,patient_id,appointment_id,planned_visit_id,status,signed_at)
      VALUES ('Synthetic visit',$1,$2,$3,$4,CASE WHEN $4='done' THEN NOW() ELSE NULL END) RETURNING id`,[f.patient,f.old,f.planned,evidence === "signed" ? "done" : "waiting"]);
    if(evidence === "session_visit") await q("UPDATE treatment_sessions SET visit_id=$2 WHERE planned_visit_id=$1",[f.planned,v.id]);
  }
  if(evidence === "completed_session") await q("UPDATE treatment_sessions SET status='done',completed_at=NOW() WHERE planned_visit_id=$1",[f.planned]);
  if(evidence === "status_log") await q("INSERT INTO appointment_status_log(appointment_id,from_status,to_status,actor) VALUES ($1,'booked','arrived','synthetic')",[f.old]);
  expect((await db.listPatientPlannedVisits(f.patient))[0].canRebook).toBe(false);
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409}); await assertNoReplacement(f);
});
it("rejects inverse ambiguity and cross-patient old appointment",async()=>{
  const f=await fixture(); await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,planned_visit_id) VALUES ($1,$2,'15:00',$3)",[f.patient,f.input.date,f.planned]);
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409});
  const g=await fixture(); await q("UPDATE appointments SET patient_id=$2 WHERE id=$1",[g.old,f.patient]);
  expect(await rebookPlannedVisit(g.input,reception)).toMatchObject({ok:false,status:409});
});
it("rejects past clinic time, patient conflict and invalid duration",async()=>{
  const f=await fixture(); expect(await rebookPlannedVisit({...f.input,date:"2000-01-01"},reception)).toMatchObject({ok:false,status:400});
  await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time) VALUES ($1,$2,$3)",[f.patient,f.input.date,f.input.time]);
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409,conflict:{canOverride:false}});
  const g=await fixture(); await q("UPDATE planned_visits SET duration_minutes=0 WHERE id=$1",[g.planned]);
  expect(await rebookPlannedVisit(g.input,reception)).toMatchObject({ok:false,status:409}); await assertNoReplacement(g);
});
it.each(["cashier","accountant","assistant"])("rejects unauthorized role %s",async role=>{
  const f=await fixture(); expect(await rebookPlannedVisit(f.input,await actor(role))).toMatchObject({ok:false,status:403}); await assertNoReplacement(f);
});
it("rejects a different-patient doctor and expired/revoked accounts including replay",async()=>{
  const f=await fixture(); const doctor=await actor("doctor");
  expect(await rebookPlannedVisit(f.input,doctor)).toMatchObject({ok:false,status:403});
  expect(await rebookPlannedVisit(f.input,{...reception,expiresAt:0})).toMatchObject({ok:false,status:401});
  const user=await actor(); expect(await rebookPlannedVisit(f.input,user)).toMatchObject({ok:true});
  await q("UPDATE users SET is_active=false WHERE id=$1",[user.userId]);
  expect(await rebookPlannedVisit(f.input,user)).toMatchObject({ok:false,status:401});
});
async function referralFixture() {
  const f=await fixture(); const [doctor]=await q("INSERT INTO parties(kind,name) VALUES ('doctor','Synthetic receiver') RETURNING id");
  await q("UPDATE planned_visits SET doctor_id=$2 WHERE id=$1",[f.planned,doctor.id]);
  const [r]=await q(`INSERT INTO patient_referrals(patient_id,to_name,to_specialty,reason,created_by,kind,to_party_id,workflow_state)
    VALUES ($1,'Synthetic receiver','endodontics','Synthetic request','synthetic','internal',$2,'accepted') RETURNING id`,[f.patient,doctor.id]);
  await q("UPDATE appointments SET referral_id=$2,doctor_id=$3 WHERE id=$1",[f.old,r.id,doctor.id]);
  return {...f,referral:r.id as number,doctor:doctor.id as number};
}
it("rebooks referral through canonical validation and transactional audit, preserving old referral identity",async()=>{
  const f=await referralFixture(); const result=await rebookPlannedVisit(f.input,reception); expect(result).toMatchObject({ok:true}); if(!result.ok)throw new Error(result.message);
  expect((await q("SELECT workflow_state FROM patient_referrals WHERE id=$1",[f.referral]))[0].workflow_state).toBe("scheduled");
  expect((await q("SELECT referral_id FROM appointments WHERE id=$1 OR id=$2 ORDER BY id",[f.old,result.appointmentId])).map(row=>row.referral_id)).toEqual([f.referral,f.referral]);
  expect((await q("SELECT details FROM audit_log WHERE action='referral.schedule' AND entity_id=$1",[String(f.patient)]))[0].details).toMatchObject({الإحالة:f.referral,الموعد:result.appointmentId});
});
it("referral receiver doctor allowed, unrelated owning doctor forbidden",async()=>{
  const f=await referralFixture(); const [other]=await q("INSERT INTO parties(kind,name) VALUES ('doctor','Synthetic nonreceiver') RETURNING id");
  await q("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1",[f.patient,other.id]);
  expect(await rebookPlannedVisit(f.input,await actor("doctor",other.id))).toMatchObject({ok:false,status:403}); await assertNoReplacement(f);
  expect(await rebookPlannedVisit(f.input,await actor("doctor",f.doctor))).toMatchObject({ok:true});
});
it.each(["planned_visit.rebook","referral.schedule"])("rolls back every link and insertion if %s audit fails",async action=>{
  const f=await referralFixture(); const fingerprint=await untouchedFingerprint(); const before=await q("SELECT to_jsonb(a) AS row FROM appointments a WHERE id=$1",[f.old]);
  await observer.query(`CREATE FUNCTION synthetic_rebook_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' THEN RAISE EXCEPTION 'synthetic audit rejection'; END IF; RETURN NEW; END $$`);
  await observer.query("CREATE TRIGGER synthetic_rebook_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_rebook_fail()");
  try {
    await expect(rebookPlannedVisit(f.input,reception)).rejects.toThrow("synthetic audit rejection"); await assertNoReplacement(f);
    expect(await untouchedFingerprint()).toEqual(fingerprint);
    expect(await q("SELECT to_jsonb(a) AS row FROM appointments a WHERE id=$1",[f.old])).toEqual(before);
    expect((await q("SELECT workflow_state FROM patient_referrals WHERE id=$1",[f.referral]))[0].workflow_state).toBe("accepted");
  } finally {await observer.query("DROP TRIGGER synthetic_rebook_fail ON audit_log; DROP FUNCTION synthetic_rebook_fail()");}
});
async function waitForLock(advisory=false) {
  const end=Date.now()+10_000; while(Date.now()<end) {
    if((await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (wait_event='advisory')=$1 AND pid<>pg_backend_pid()",[advisory])).rows.length)return;
    await new Promise(resolve=>setTimeout(resolve,10));
  } throw new Error("Controlled writer did not reach lock barrier");
}
it.each(["retarget","cancel","patient","revoke"])("rechecks %s changed while waiting for planned row",async change=>{
  const f=await fixture(); const user=await actor(); const blocker=await observer.connect(); let pending:ReturnType<typeof rebookPlannedVisit>|undefined;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM planned_visits WHERE id=$1 FOR UPDATE",[f.planned]);
    pending=rebookPlannedVisit(f.input,user); await waitForLock();
    if(change === "cancel") await blocker.query("UPDATE planned_visits SET status='cancelled' WHERE id=$1",[f.planned]);
    if(change === "retarget") await blocker.query("UPDATE planned_visits SET appointment_id=NULL WHERE id=$1",[f.planned]);
    if(change === "patient") {const other=await fixture(); await blocker.query("UPDATE planned_visits SET patient_id=$2 WHERE id=$1",[f.planned,other.patient]);}
    if(change === "revoke") await blocker.query("UPDATE users SET is_active=false WHERE id=$1",[user.userId]);
    await blocker.query("COMMIT"); expect(await pending).toMatchObject({ok:false,status:change === "revoke" ? 401 : 409});
    expect((await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patient]))).toHaveLength(1);
  } finally {await blocker.query("ROLLBACK");blocker.release();await pending;}
});
it("rebooking versus planned start uses shared lock order and never attaches a visit to terminal history",async()=>{
  const f=await fixture(); const blocker=await observer.connect(); let pending:ReturnType<typeof rebookPlannedVisit>|undefined; let start:ReturnType<typeof db.startVisitFromPlannedVisit>|undefined;
  await observer.query(`CREATE FUNCTION synthetic_rebook_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.patient_id=${f.patient} THEN PERFORM pg_advisory_xact_lock(891234); END IF; RETURN NEW; END $$`);
  await observer.query("CREATE TRIGGER synthetic_rebook_barrier BEFORE INSERT ON appointments FOR EACH ROW EXECUTE FUNCTION synthetic_rebook_barrier()");
  try {
    await blocker.query("SELECT pg_advisory_lock(891234)"); pending=rebookPlannedVisit(f.input,reception); await waitForLock(true);
    start=db.startVisitFromPlannedVisit({plannedVisitId:f.planned,actor:"synthetic"}); await waitForLock();
    await blocker.query("SELECT pg_advisory_unlock(891234)"); expect(await pending).toMatchObject({ok:true});
    expect(await start).toEqual({appointmentConflict:true});
    expect(await q("SELECT id FROM visits WHERE appointment_id=$1",[f.old])).toEqual([]);
  } finally {
    await blocker.query("SELECT pg_advisory_unlock(891234)");blocker.release();await pending;await start;
    await observer.query("DROP TRIGGER synthetic_rebook_barrier ON appointments; DROP FUNCTION synthetic_rebook_barrier()");
  }
});
it.each(["done_item","cancelled_item","item_timestamp","item_visit","cross_patient_plan","cross_patient_session"])("rejects inconsistent clinical ancestry: %s",async evidence=>{
  const f=await fixture();
  if(evidence === "done_item" || evidence === "cancelled_item") await q("UPDATE plan_items SET status=$2 WHERE id=$1",[f.item,evidence === "done_item" ? "done" : "cancelled"]);
  if(evidence === "item_timestamp") await q("UPDATE plan_items SET done_at=NOW() WHERE id=$1",[f.item]);
  if(evidence === "item_visit") {const [v]=await q("INSERT INTO visits(patient_name,patient_id,status) VALUES ('Synthetic history',$1,'done') RETURNING id",[f.patient]);await q("UPDATE plan_items SET visit_id=$2 WHERE id=$1",[f.item,v.id]);}
  if(evidence === "cross_patient_plan" || evidence === "cross_patient_session") {
    const other=await fixture();
    if(evidence === "cross_patient_plan") await q("UPDATE planned_visits SET plan_id=$2 WHERE id=$1",[f.planned,other.plan]);
    else await q("UPDATE treatment_sessions SET plan_item_id=$2,sequence=2 WHERE planned_visit_id=$1",[f.planned,other.item]);
  }
  expect((await db.listPatientPlannedVisits(f.patient))[0].canRebook).toBe(false);
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409});await assertNoReplacement(f);
});
it.each(["treatment_plans","plan_items","treatment_sessions"])("fails closed without deadlock while %s is being changed",async table=>{
  const f=await fixture();const blocker=await observer.connect();
  try{
    await blocker.query("BEGIN");
    if(table === "treatment_sessions") await blocker.query("SELECT id FROM treatment_sessions WHERE planned_visit_id=$1 FOR UPDATE",[f.planned]);
    else await blocker.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`,[table === "treatment_plans" ? f.plan : f.item]);
    expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409});await assertNoReplacement(f);
  }finally{await blocker.query("ROLLBACK");blocker.release();}
});
it("rejects cancelled referral and inactive receiving doctor without altering either",async()=>{
  const f=await referralFixture();await q("UPDATE patient_referrals SET workflow_state='cancelled',status='cancelled',outcome_note='Synthetic cancellation',closed_at=NOW(),closed_by='synthetic' WHERE id=$1",[f.referral]);
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409});await assertNoReplacement(f);
  const g=await referralFixture();await q("UPDATE parties SET is_active=false WHERE id=$1",[g.doctor]);
  expect(await rebookPlannedVisit(g.input,reception)).toMatchObject({ok:false,status:409});await assertNoReplacement(g);
});
it("complete long reason survives the audit receipt and exact replay",async()=>{
  const f=await fixture();const input={...f.input,reason:"ر".repeat(500)};const result=await rebookPlannedVisit(input,reception);
  expect(result).toMatchObject({ok:true});expect(await rebookPlannedVisit(input,reception)).toEqual({...result,replayed:true});
  expect((await q("SELECT details FROM audit_log WHERE action='planned_visit.rebook' AND entity_id=$1",[String(f.planned)]))[0].details.intent.reason).toHaveLength(500);
});
it("still allows a new retry identity after a verified rollback",async()=>{
  const f=await fixture();await q("UPDATE planned_visits SET duration_minutes=0 WHERE id=$1",[f.planned]);
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409});
  await q("UPDATE planned_visits SET duration_minutes=30 WHERE id=$1",[f.planned]);
  expect(await rebookPlannedVisit({...f.input,requestId:f.input.requestId+'-retry'},reception)).toMatchObject({ok:true,replayed:false});
});
it("rejects an occupied named chair using the canonical capacity gate",async()=>{
  const f=await fixture();const other=await fixture();
  const [service]=await q("INSERT INTO appointment_services(code,name_ar,specialty,default_duration_minutes,requires_chair) VALUES ($1,'Synthetic chair service','general',30,true) RETURNING id",[`synthetic-${serial}`]);
  await q("UPDATE appointments SET chair_no=1,service_id=$2 WHERE id=$1",[f.old,service.id]);
  await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,duration_minutes,status,chair_no) VALUES ($1,$2,'10:00',30,'booked',1)",[other.patient,f.input.date]);
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409,conflict:{canOverride:false}});await assertNoReplacement(f);
});
it("rolls back if the admitted session expires while insertion is blocked",async()=>{
  const f=await fixture();const blocker=await observer.connect();const key=830000+serial;
  await blocker.query("SELECT pg_advisory_lock($1)",[key]);
  await q(`CREATE FUNCTION rebook_test_expiry_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.patient_id=${f.patient} THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$`);
  await q("CREATE TRIGGER rebook_test_expiry_wait BEFORE INSERT ON appointments FOR EACH ROW EXECUTE FUNCTION rebook_test_expiry_wait()");
  const admitted={...reception,expiresAt:Date.now()+5000};
  const pending=rebookPlannedVisit(f.input,admitted);
  try{
    await waitForLock(true);await blocker.query("SELECT pg_sleep(5.1)");await blocker.query("SELECT pg_advisory_unlock($1)",[key]);
    expect(await pending).toMatchObject({ok:false,status:401});await assertNoReplacement(f);
  }finally{
    await blocker.query("SELECT pg_advisory_unlock($1)",[key]);await pending.catch(()=>undefined);await q("DROP TRIGGER rebook_test_expiry_wait ON appointments");await q("DROP FUNCTION rebook_test_expiry_wait()");blocker.release();
  }
});
it("reports missing inverse pointer as blocked instead of offering a doomed rebook",async()=>{
  const f=await fixture();await q("UPDATE appointments SET planned_visit_id=NULL WHERE id=$1",[f.old]);
  expect((await db.listPatientPlannedVisits(f.patient))[0].canRebook).toBe(false);
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409});await assertNoReplacement(f);
});
it("does not detach an unexpected other live referral booking",async()=>{
  const f=await referralFixture();
  const [other]=await q("INSERT INTO appointments(patient_id,doctor_id,referral_id,scheduled_date,scheduled_time,status) VALUES ($1,$2,$3,$4,'12:00','booked') RETURNING id",[f.patient,f.doctor,f.referral,f.input.date]);
  expect((await db.listPatientPlannedVisits(f.patient))[0].canRebook).toBe(false);
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409});
  expect((await q("SELECT referral_id FROM appointments WHERE id=$1",[other.id]))[0].referral_id).toBe(f.referral);
  expect((await q("SELECT appointment_id FROM planned_visits WHERE id=$1",[f.planned]))[0].appointment_id).toBe(f.old);
});
it("protects linked session parent plans even when the grouping has no parent plan",async()=>{
  const f=await fixture();await q("UPDATE planned_visits SET plan_id=NULL WHERE id=$1",[f.planned]);
  const blocker=await observer.connect();try{
    await blocker.query("BEGIN");await blocker.query("SELECT id FROM treatment_plans WHERE id=$1 FOR UPDATE",[f.plan]);
    expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409});await assertNoReplacement(f);
  }finally{await blocker.query("ROLLBACK");blocker.release();}
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:true});
});
it("rejects completed linked session parent even when the grouping has no parent plan",async()=>{
  const f=await fixture();await q("UPDATE planned_visits SET plan_id=NULL WHERE id=$1",[f.planned]);
  await q("UPDATE treatment_plans SET status='completed' WHERE id=$1",[f.plan]);
  expect((await db.listPatientPlannedVisits(f.patient))[0].canRebook).toBe(false);
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409});await assertNoReplacement(f);
});
it("two doctors with cross-owned planned witnesses do not deadlock during rebooking authorization",async()=>{
  const a=await fixture();const b=await fixture();
  const [d1]=await q("INSERT INTO parties(name,kind) VALUES ('Synthetic cross doctor one','doctor') RETURNING id");
  const [d2]=await q("INSERT INTO parties(name,kind) VALUES ('Synthetic cross doctor two','doctor') RETURNING id");
  const u1=await actor('doctor',d1.id);const u2=await actor('doctor',d2.id);
  await q("UPDATE treatment_plans SET patient_id=$2 WHERE id=$1",[b.plan,a.patient]);
  await q("UPDATE appointments SET patient_id=$2 WHERE id=$1",[b.old,a.patient]);
  await q("UPDATE planned_visits SET doctor_id=$2 WHERE id=$1",[a.planned,d2.id]);
  await q("UPDATE planned_visits SET patient_id=$2,doctor_id=$3 WHERE id=$1",[b.planned,a.patient,d1.id]);
  const untouched=await untouchedFingerprint();const gate=await observer.connect();let pending:Promise<PromiseSettledResult<Awaited<ReturnType<typeof rebookPlannedVisit>>>[]>|undefined;
  try{
    await gate.query('BEGIN');await gate.query('SELECT id FROM users WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[[u1.userId,u2.userId]]);
    pending=Promise.allSettled([rebookPlannedVisit(a.input,u1),rebookPlannedVisit(b.input,u2)]);
    const deadline=Date.now()+10_000;let bothHeld=false;
    while(Date.now()<deadline){
      const {rows:[state]}=await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM users%' AND pid<>pg_backend_pid()");
      if(state.n>=2){bothHeld=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(bothHeld).toBe(true); // Both already hold their own target planned row.
    await gate.query('COMMIT');const outcomes=await pending;
    expect(outcomes.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
    const values=outcomes.flatMap(result=>result.status==='fulfilled' ? [result.value] : []);
    expect(values.filter(result=>!result.ok && result.status!==409)).toEqual([]);
    expect(values.some(result=>!result.ok && result.status===409)).toBe(true);
    expect((await q('SELECT id FROM appointments WHERE patient_id=$1',[a.patient]))).toHaveLength(2+values.filter(value=>value.ok).length);
    for(const [index,f] of [a,b].entries()){
      const value=values[index];const current=value.ok ? value.appointmentId : f.old;
      expect((await q('SELECT appointment_id FROM planned_visits WHERE id=$1',[f.planned]))[0].appointment_id).toBe(current);
      expect(await q('SELECT id FROM appointments WHERE planned_visit_id=$1',[f.planned])).toEqual([{id:current}]);
      expect((await q('SELECT planned_visit_id,status FROM appointments WHERE id=$1',[f.old]))[0]).toEqual({planned_visit_id:value.ok?null:f.planned,status:'no_show'});
      const receipts=await q("SELECT details FROM audit_log WHERE action='planned_visit.rebook' AND entity_id=$1",[String(f.planned)]);
      expect(receipts).toHaveLength(value.ok?1:0);
      if(value.ok)expect(receipts[0].details.newAppointmentId).toBe(value.appointmentId);
    }
    expect(await untouchedFingerprint()).toEqual(untouched);
  }finally{await gate.query('ROLLBACK');gate.release();await pending;}
},20_000);
it("historical retries keep their original result across later rebookings",async()=>{
  const f=await fixture();const first=await rebookPlannedVisit(f.input,reception);expect(first.ok).toBe(true);if(!first.ok)throw new Error(first.message);
  await q("UPDATE appointments SET status='no_show',ended_at=NOW() WHERE id=$1",[first.appointmentId]);
  const secondIntent={...f.input,expectedAppointmentId:first.appointmentId,date:addDays(f.input.date,1),requestId:f.input.requestId+'-second'};
  const second=await rebookPlannedVisit(secondIntent,reception);expect(second.ok).toBe(true);if(!second.ok)throw new Error(second.message);
  expect(await rebookPlannedVisit(f.input,reception)).toEqual({...first,replayed:true});
  expect((await q("SELECT appointment_id FROM planned_visits WHERE id=$1",[f.planned]))[0].appointment_id).toBe(second.appointmentId);
  await q("UPDATE appointments SET status='cancelled',ended_at=NOW(),cancel_reason='Synthetic later cancellation' WHERE id=$1",[second.appointmentId]);
  const third=await rebookPlannedVisit({...secondIntent,expectedAppointmentId:second.appointmentId,date:addDays(f.input.date,2),requestId:f.input.requestId+'-third'},reception);
  expect(third.ok).toBe(true);expect((await q("SELECT id FROM appointments WHERE patient_id=$1",[f.patient]))).toHaveLength(4);
  expect((await q("SELECT id FROM appointments WHERE planned_visit_id=$1",[f.planned]))).toHaveLength(1);
});
it("another authorized user cannot recover the original actor's receipt",async()=>{
  const f=await fixture();expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:true});
  const other=await actor();expect(await rebookPlannedVisit(f.input,other)).toMatchObject({ok:false,status:409});
  expect((await q("SELECT details FROM audit_log WHERE action='planned_visit.rebook' AND entity_id=$1",[String(f.planned)]))).toHaveLength(1);
});
it("denied attempts leave no replay receipt",async()=>{
  const f=await fixture();await q("UPDATE planned_visits SET status='cancelled' WHERE id=$1",[f.planned]);
  expect(await rebookPlannedVisit(f.input,reception)).toMatchObject({ok:false,status:409});
  expect(await q("SELECT id FROM audit_log WHERE action='planned_visit.rebook' AND entity_id=$1",[String(f.planned)])).toEqual([]);
});
