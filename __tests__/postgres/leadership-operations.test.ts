import { beforeAll, afterAll, expect, it } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv, dropPublicSchema } from "./_setup";
import { addDays, clinicDateString } from "../../lib/schedule";
import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { readOperationalOverview } from "../../lib/leadership-operations-db";
import { decodeOperationalOverview, type OperationalSection } from "../../lib/leadership-operations";
assertRealPostgresUrl(); stubPostgresEnv();
process.env.SESSION_SECRET = "synthetic-leadership-test-secret-not-for-production";
const db = await import("../../lib/db");
const { rebookPlannedVisit } = await import("../../lib/planned-visit-rebooking");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let serial = 0;
let actor: SessionPayload;
const day = "2026-01-05";
const read = (date = day, zone = "Asia/Aden", appointmentPage = 0, lane: "all" | "reception" | "doctor" = "all") =>
  readOperationalOverview(db.getPool(), { day: date, lane, appointmentPage, referralPage: 0 }, zone);
const ready = (section: OperationalSection) => { expect(section.status).toBe("ready"); if (section.status !== "ready") throw new Error(section.message); return section; };
beforeAll(async () => {
  await dropPublicSchema(assertRealPostgresUrl()); await db.ensureSchema();
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES ('synthetic-leadership','Synthetic leader','synthetic-unused','admin') RETURNING id");
  actor = { userId: user.id, username: "synthetic-leadership", role: "admin", partyId: null,
    expiresAt: Date.now() + 3_600_000, credentialVersion: sessionCredentialVersion("synthetic-unused") };
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture(status = "no_show", date = day) {
  const [p] = await q("INSERT INTO patients(patient_number,full_name) VALUES ($1,'Synthetic operational patient') RETURNING id", [`SYN-OPS-${++serial}`]);
  const [a] = await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status) VALUES ($1,$2,'16:00',$3) RETURNING id", [p.id,date,status]);
  const [pv] = await q("INSERT INTO planned_visits(patient_id,sequence,title,status,appointment_id) VALUES ($1,1,'Synthetic session','scheduled',$2) RETURNING id",[p.id,a.id]);
  await q("UPDATE appointments SET planned_visit_id=$2 WHERE id=$1",[a.id,pv.id]);
  return {patient:p.id as number, old:a.id as number, planned:pv.id as number};
}
async function actualRebook(f: Awaited<ReturnType<typeof fixture>>, old = f.old) {
  const plan = (await db.listPatientPlannedVisits(f.patient))[0];
  const result = await rebookPlannedVisit({plannedVisitId:f.planned,expectedAppointmentId:old,expectedGeneration:plan.rebookGeneration,
    date:addDays(clinicDateString(new Date(),db.CLINIC_TIME_ZONE),++serial),time:"16:00",reason:"Synthetic patient requested replacement",requestId:`synthetic-ops-rebook-${serial}`},actor);
  expect(result.ok).toBe(true); if(!result.ok) throw new Error(result.message); return result.appointmentId;
}
async function state(f: Awaited<ReturnType<typeof fixture>>) { return ready((await read()).sections[0]).items.find(item=>item.id===f.old); }
it("reads current selected-day states, preserving no-show vs cancellation and excluding neighboring days", async () => {
  const noShow=await fixture(); const cancelled=await fixture("cancelled"); await fixture("booked"); await fixture("no_show","2026-01-06");
  const result=await read();const source=ready(result.sections[0]);
  expect(source.total).toBe(2);expect(source.items.map(item=>item.status).sort()).toEqual(["cancelled","no_show"]);
  expect(source.items.map(item=>item.patientId).sort()).toEqual([noShow.patient,cancelled.patient].sort());
  expect(source.items.every(item=>item.state==="needs_review"&&item.replacement===null)).toBe(true);
  expect(decodeOperationalOverview(result,day,"all")).not.toBeNull();
});
it("proves actual rebooking, follows repeated rebooking, and retains the original cancelled/no-show history", async () => {
  const f=await fixture("cancelled"); const first=await actualRebook(f);
  expect(await state(f)).toMatchObject({status:"cancelled",state:"replacement_active",replacement:{id:first,status:"booked"},plannedVisitId:f.planned});
  await q("UPDATE appointments SET status='no_show' WHERE id=$1",[first]);
  expect(await state(f)).toMatchObject({state:"replacement_terminal",replacement:{id:first,status:"no_show"}});
  const second=await actualRebook(f,first);
  expect(await state(f)).toMatchObject({state:"replacement_active",replacement:{id:second,status:"booked"}});
  expect((await q("SELECT status,planned_visit_id FROM appointments WHERE id=$1",[f.old]))[0]).toEqual({status:"cancelled",planned_visit_id:null});
});
it("does not infer handling from an unrelated later appointment for the same patient", async () => {
  const f=await fixture();await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time) VALUES ($1,'2026-02-02','16:00')",[f.patient]);
  expect(await state(f)).toMatchObject({state:"needs_review",replacement:null});
});
it("contradictory attendance always requires record review even with valid rebooking proof", async () => {
  const f=await fixture();await actualRebook(f);
  await q("INSERT INTO visits(patient_name,patient_id,appointment_id,status) VALUES ('Synthetic visit',$1,$2,'done')",[f.patient,f.old]);
  expect(await state(f)).toMatchObject({state:"history_review"});
});
it.each(["duplicate_inverse","duplicate_forward","cross_patient_plan"])("rejects replacement evidence with %s", async conflict => {
  const f=await fixture();const replacement=await actualRebook(f);
  if(conflict==="duplicate_inverse")await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,planned_visit_id) VALUES ($1,'2026-02-02','16:00',$2)",[f.patient,f.planned]);
  if(conflict==="duplicate_forward")await q("INSERT INTO planned_visits(patient_id,sequence,title,appointment_id) VALUES ($1,2,'Synthetic duplicate',$2)",[f.patient,replacement]);
  if(conflict==="cross_patient_plan"){
    const foreign=await fixture("booked");const [plan]=await q("INSERT INTO treatment_plans(patient_id,title,total_minor) VALUES ($1,'Synthetic unrelated plan',0) RETURNING id",[foreign.patient]);
    await q("UPDATE planned_visits SET plan_id=$2 WHERE id=$1",[f.planned,plan.id]);
  }
  expect(await state(f)).toMatchObject({state:"history_review",replacement:null});
});
it.each(["original","intermediate","one_way_intermediate"])("does not trust a reattached %s appointment in a historical rebooking chain", async node => {
  const f=await fixture(); const first=await actualRebook(f);
  let reattached=f.old;
  if(node!=="original") { await q("UPDATE appointments SET status='no_show' WHERE id=$1",[first]); await actualRebook(f,first); reattached=first; }
  const [other]=await q("INSERT INTO planned_visits(patient_id,sequence,title,appointment_id) VALUES ($1,2,'Synthetic reattached plan',$2) RETURNING id",[f.patient,reattached]);
  if(node!=="one_way_intermediate")await q("UPDATE appointments SET planned_visit_id=$2 WHERE id=$1",[reattached,other.id]);
  expect(await state(f)).toMatchObject({state:"needs_review",replacement:null});
});
it("terminal replacement with clinical attendance evidence requires record review", async () => {
  const f=await fixture();const replacement=await actualRebook(f);
  await q("UPDATE appointments SET status='cancelled',arrived_at=NOW() WHERE id=$1",[replacement]);
  expect(await state(f)).toMatchObject({state:"history_review",replacement:null});
});
it("unknown current replacement status is not mislabeled as no-show or cancellation", async () => {
  const f=await fixture();const replacement=await actualRebook(f);await q("UPDATE appointments SET status='synthetic_unknown' WHERE id=$1",[replacement]);
  expect(await state(f)).toMatchObject({state:"history_review"});
});
it("stops ambiguous same-generation audit edges instead of branching or trusting either proof", async () => {
  const f=await fixture();await actualRebook(f);
  await q(`INSERT INTO audit_log(action,entity,entity_id,summary,details,actor,actor_role)
    SELECT action,entity,entity_id,'Synthetic duplicate edge',details,actor,actor_role FROM audit_log
    WHERE action='planned_visit.rebook' AND details->>'oldAppointmentId'=$1`,[String(f.old)]);
  expect(await state(f)).toMatchObject({state:"needs_review",replacement:null});
});
it("reset generation invalidates an otherwise coherent historical audit without inventing resolution", async () => {
  const f=await fixture();await actualRebook(f);expect(await state(f)).toMatchObject({state:"replacement_active"});
  await q("INSERT INTO audit_log(action,summary,actor) VALUES ('system.reset','Synthetic generation fence','synthetic')");
  expect(await state(f)).toMatchObject({state:"needs_review",replacement:null});
});
it("requires exact patient and appointment creation identities in audit proof", async () => {
  const f=await fixture();const replacement=await actualRebook(f);
  await q("UPDATE appointments SET created_at=created_at + INTERVAL '1 second' WHERE id=$1",[replacement]);
  expect(await state(f)).toMatchObject({state:"needs_review",replacement:null});
});
it("counts and clamps bounded pages from the same source snapshot", async () => {
  let replaced: Awaited<ReturnType<typeof fixture>> | undefined;
  for(let i=0;i<13;i++)replaced=await fixture("no_show","2026-03-05");
  await actualRebook(replaced!);
  const first=ready((await read("2026-03-05")).sections[0]);expect(first).toMatchObject({total:13,page:0,hasMore:true});expect(first.items).toHaveLength(10);
  expect(first.items[0]).toMatchObject({id:replaced!.old,state:"replacement_active"});
  const last=ready((await read("2026-03-05","Asia/Aden",999)).sections[0]);expect(last).toMatchObject({total:13,page:1,hasMore:false});expect(last.items).toHaveLength(3);
});
it("keeps an exhausted proof chain unknown rather than inferring a resolution beyond its bound", async () => {
  const f=await fixture("no_show","2026-03-06"); let current=f.old;
  for(let edge=0;edge<31;edge++) {
    current=await actualRebook(f,current);
    await q("UPDATE appointments SET status='no_show' WHERE id=$1",[current]);
  }
  expect(ready((await read("2026-03-06")).sections[0]).items[0]).toMatchObject({state:"replacement_terminal",replacement:{id:current}});
  await actualRebook(f,current);
  expect(ready((await read("2026-03-06")).sections[0]).items[0]).toMatchObject({state:"needs_review",replacement:null});
});
it("uses the canonical return-recipient override rather than the original referring doctor for review context", async () => {
  const [patient]=await q("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-REF-RETURN','Synthetic override patient') RETURNING id");
  const [original]=await q("INSERT INTO parties(name,kind) VALUES ('Synthetic original referrer','doctor') RETURNING id");
  const [reviewer]=await q("INSERT INTO parties(name,kind) VALUES ('Synthetic result reviewer','doctor') RETURNING id");
  await q(`INSERT INTO patient_referrals(patient_id,to_name,to_specialty,reason,status,created_by,closed_at,kind,to_party_id,workflow_state,doctor_party_id,completed_at,return_to_party_id)
    VALUES ($1,'Synthetic receiver','other','Synthetic reason','completed','synthetic','2026-04-08T12:00:00Z','internal',$2,'completed',$2,'2026-04-08T12:00:00Z',$3)`,[patient.id,original.id,reviewer.id]);
  const result=ready((await read("2026-04-08","Asia/Aden",0,"doctor")).sections[0]);
  expect(result.items[0]).toMatchObject({patientId:patient.id,reviewDoctor:"Synthetic result reviewer"});
  const canonical=await db.listMyReferrals(reviewer.id);
  expect(canonical.returnedToMe.some(item=>item.patientId===patient.id)).toBe(true);
});
it("filters completion timestamps by clinic midnight and excludes acknowledged, external and other-day referrals", async () => {
  const [patient]=await q("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-REF-OPS','Synthetic referral patient') RETURNING id");
  const [doctor]=await q("INSERT INTO parties(name,kind) VALUES ('Synthetic referrer','doctor') RETURNING id");
  async function referral(at:string, workflow="completed", kind="internal"){
    const [r]=await q(`INSERT INTO patient_referrals(patient_id,to_name,to_specialty,reason,status,created_by,closed_at,kind,to_party_id,workflow_state,doctor_party_id,completed_at,returned_at)
      VALUES ($1,'Synthetic receiver','other','Synthetic reason','completed','synthetic',$3,$4,$2,$5,$2,$3,CASE WHEN $5='returned_to_referrer' THEN $3::timestamptz ELSE NULL END) RETURNING id`,
      [patient.id,doctor.id,at,kind,kind==="external"?null:workflow]);return r.id;
  }
  const inside=await referral("2026-04-04T21:00:00Z");await referral("2026-04-04T20:59:59Z");await referral("2026-04-05T21:00:00Z");
  await referral("2026-04-05T15:00:00Z","returned_to_referrer");await referral("2026-04-05T15:00:00Z","completed","external");
  const result=await read("2026-04-05","Asia/Aden",0,"doctor");const section=ready(result.sections[0]);
  expect(section.total).toBe(1);expect(section.items[0]).toMatchObject({id:inside,patientId:patient.id,reviewDoctor:"Synthetic referrer",state:"awaiting_referrer"});
  expect(decodeOperationalOverview(result,"2026-04-05","doctor")).not.toBeNull();
});
it("is a pure read over both operational and financial rows", async () => {
  const tables=["appointments","planned_visits","patient_referrals","visits","audit_log","invoices","payments","journal_manual","treatment_sessions"];
  const fingerprint=async()=>Promise.all(tables.map(async table=>(await q(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) AS hash FROM ${table} t`))[0].hash));
  const before=await fingerprint();await read();expect(await fingerprint()).toEqual(before);
});
it("keeps count, links and rebooking evidence in one statement snapshot during a concurrent rebook", async () => {
  const date="2026-05-01";const f=await fixture("no_show",date);
  const pool={ query: db.getPool().query.bind(db.getPool()) };
  const slow={query:async<T>(sql:string,values?:unknown[])=>pool.query<T>(sql.replace("WITH RECURSIVE", "WITH RECURSIVE leadership_snapshot_pause AS MATERIALIZED (SELECT pg_sleep(1)),")
    .replace("FROM appointments a JOIN patients", "FROM appointments a CROSS JOIN leadership_snapshot_pause JOIN patients"),values)};
  const pending=readOperationalOverview(slow,{day:date,lane:"reception",appointmentPage:0,referralPage:0},"Asia/Aden");
  let sleeping=false;
  for(let i=0;i<100;i++){
    const active=await q("SELECT 1 FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%leadership_snapshot_pause%'");
    if(active.length){sleeping=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(sleeping).toBe(true);const replacement=await actualRebook(f);await fixture("cancelled",date);
  const during=ready((await pending).sections[0]);expect(during.total).toBe(1);expect(during.items[0]).toMatchObject({id:f.old,state:"needs_review",replacement:null});
  const after=ready((await read(date,"Asia/Aden",0,"reception")).sections[0]);expect(after.total).toBe(2);
  expect(after.items.find(item=>item.id===f.old)).toMatchObject({state:"replacement_active",replacement:{id:replacement}});
});
