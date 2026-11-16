/** Full application writers on the runner's fresh synthetic database. No reset,
 * preexisting database drop, live account or Production connection is used. */
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { openLegacyStaffFixture } from "./_legacy-staff-fixture";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { createSessionToken, readSessionToken, legacySessionEvidence, sessionCredentialVersion } from "../../lib/auth";
import type { DoctorCommissionConfig } from "../../lib/doctor-permissions";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db");
let fixture:Awaited<ReturnType<typeof openLegacyStaffFixture>>;
const savedUrl=process.env.DATABASE_URL;
const prefix=`legacy_bnd_${randomBytes(6).toString("hex")}`;
let actorId:number, targetId:number;
const username=`${prefix}_admin`;
const canonical=JSON.stringify({schemaVersion:2,confirmation:"owner",revision:1,patientScope:"none",appointmentScope:"none",grants:{}});
const config:DoctorCommissionConfig={calculationMode:"percentage",defaultPercent:30,categoryRates:{},fixedAmountPerVisitMinor:0,deductLabCost:true,deductMaterialCost:false,basis:"collected_cash",effectiveDate:"",rateHistory:[]};
function auth(){const p=readSessionToken(createSessionToken({userId:actorId,username,role:"admin",expiresAt:Date.now()+60_000,credentialVersion:sessionCredentialVersion("synthetic-hash")}))!;return {evidence:legacySessionEvidence(p)!};}
async function counts(){return (await db.getPool().query("SELECT (SELECT count(*)::text FROM users) AS users,(SELECT count(*)::text FROM parties) AS parties,(SELECT count(*)::text FROM doctor_commission_history) AS history,(SELECT count(*)::text FROM audit_log) AS audit")).rows[0];}
async function blockedBy(pid:number){const until=performance.now()+5000;while(performance.now()<until){const r=await db.getPool().query("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",[pid]);if(r.rows.length)return;await new Promise(r=>setTimeout(r,10));}throw new Error("expected real writer blocking barrier not observed");}
beforeAll(async()=>{
 fixture=await openLegacyStaffFixture({...process.env});process.env.DATABASE_URL=fixture.url;await db.resetPoolForTesting();
 await db.ensureSchema();
 actorId=(await db.getPool().query<{id:number}>("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,'synthetic-hash','admin') RETURNING id",[username])).rows[0].id;
},120000);
afterAll(async()=>{vi.restoreAllMocks();try{await db.resetPoolForTesting();await fixture?.close();}finally{process.env.DATABASE_URL=savedUrl;}});
it("ordinary legacy create/update/link succeeds with actual signed evidence and preserved commission history",async()=>{
 const created=await db.createStaffUser({username:`${prefix}_doctor`,displayName:`${prefix} doctor`,passwordHash:"target-hash",role:"doctor",commissionConfig:config},{actor:"forged-audit-label"},auth());
 targetId=created.id;expect(created.partyId).not.toBeNull();
 expect((await db.updateUser(targetId,{displayName:"updated synthetic"},{actor:"forged"},auth()))?.displayName).toBe("updated synthetic");
 expect((await db.linkUserDoctor(targetId,created.partyId,{actor:"forged"},auth()))?.partyId).toBe(created.partyId);
 const rows=(await db.getPool().query<{recorded_by:string}>("SELECT recorded_by FROM doctor_commission_history WHERE party_id=$1",[created.partyId])).rows;
 expect(rows.length).toBeGreaterThan(0);expect(rows.every(r=>r.recorded_by===username)).toBe(true);
});
it("missing/copied proof cannot create a user, doctor party, history or audit",async()=>{
 const before=await counts();
 await expect(db.createStaffUser({username:`${prefix}_denied`,displayName:`${prefix} denied`,passwordHash:"x",role:"doctor"},{actor:username})).rejects.toThrow("SIGNED_EVIDENCE_REQUIRED");
 const genuine=auth();
 await expect(db.createStaffUser({username:`${prefix}_copy`,displayName:`${prefix} copy`,passwordHash:"x",role:"doctor"},{actor:username},{evidence:{...genuine.evidence}})).rejects.toThrow("SIGNED_EVIDENCE_REQUIRED");
 expect(await counts()).toEqual(before);
});
it("raw canonical target is refused by lookup and actual legacy writer",async()=>{
 await db.getPool().query("UPDATE users SET permissions=$1 WHERE id=$2",[canonical,targetId]);
 try{
  await expect(db.findUserByUsername(`${prefix}_doctor`)).rejects.toThrow("PERMISSION_ENVELOPE_HELD");
  const before=await counts();await expect(db.updateUser(targetId,{displayName:"forbidden"},{actor:username},auth())).rejects.toThrow("PERMISSION_ENVELOPE_HELD");expect(await counts()).toEqual(before);
 }finally{await db.getPool().query("UPDATE users SET permissions=NULL WHERE id=$1",[targetId]);}
});
it.each(["actor","target"])("actual update observes %s conversion after an exclusive fence wait",async(which)=>{
 const id=which==="actor"?actorId:targetId,proof=auth(),holder=await db.getPool().connect();await holder.query("BEGIN");
 const pid=(await holder.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
 await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);
 const pending=db.updateUser(targetId,{displayName:"must-not-write"},{actor:username},proof).then(()=>null,e=>e);
 try{await blockedBy(pid);await holder.query("UPDATE users SET permissions=$1 WHERE id=$2",[canonical,id]);await holder.query("COMMIT");expect(await pending).toMatchObject({message:"LEGACY_STAFF_PERMISSION_ENVELOPE_HELD"});}
 finally{await holder.query("ROLLBACK");holder.release();await pending;await db.getPool().query("UPDATE users SET permissions=NULL WHERE id=$1",[id]);}
 expect((await db.getPool().query("SELECT display_name FROM users WHERE id=$1",[targetId])).rows[0].display_name).toBe("updated synthetic");
});
it("expiry after advanced commission history insertion rolls back user, doctor, history and audit",async()=>{
 const before=await counts(),proof=auth(),holder=await db.getPool().connect();const fence=`synthetic-final-check:${prefix}`;
 const fn=`${prefix}_wait`,trigger=`${prefix}_wait_trigger`;
 await db.getPool().query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source='advanced' AND NEW.recorded_by='${username}' THEN PERFORM pg_advisory_xact_lock(hashtextextended('${fence}',0)); END IF; RETURN NEW; END $$`);
 await db.getPool().query(`CREATE TRIGGER ${trigger} AFTER INSERT ON doctor_commission_history FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
 await holder.query("BEGIN");const pid=(await holder.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[fence]);
 const pending=db.createStaffUser({username:`${prefix}_expired`,displayName:`${prefix} expired`,passwordHash:"x",role:"doctor",commissionConfig:config},{actor:username},proof).then(()=>null,e=>e);
 try{await blockedBy(pid);vi.spyOn(Date,"now").mockReturnValue(Date.now()+120_000);await holder.query("COMMIT");expect(await pending).toMatchObject({message:"LEGACY_STAFF_SESSION_EXPIRED"});}
 finally{vi.restoreAllMocks();await holder.query("ROLLBACK");holder.release();await pending;await db.getPool().query(`DROP TRIGGER ${trigger} ON doctor_commission_history;DROP FUNCTION ${fn}()`);}
 expect(await counts()).toEqual(before);
});
it.each(["disable", "change-kind"])("link revalidates doctor after observed concurrent %s without side effects", async (change) => {
 const partyId=(await db.getPool().query<{id:number}>("INSERT INTO parties(name,kind,is_active) VALUES($1,'doctor',true) RETURNING id",[`${prefix}_${change}`])).rows[0].id;
 const before=await counts();
 const original=(await db.getPool().query("SELECT party_id,commission_config FROM users WHERE id=$1",[targetId])).rows[0];
 const holder=await db.getPool().connect();await holder.query("BEGIN");
 const pid=(await holder.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
 await holder.query(change==="disable" ? "UPDATE parties SET is_active=false WHERE id=$1" : "UPDATE parties SET kind='lab' WHERE id=$1",[partyId]);
 const pending=db.linkUserDoctor(targetId,partyId,{actor:username},auth()).then(value=>({value}),error=>({error}));
 try {
  await blockedBy(pid);await holder.query("COMMIT");expect(await pending).toEqual({value:null});
  expect((await db.getPool().query("SELECT party_id,commission_config FROM users WHERE id=$1",[targetId])).rows[0]).toEqual(original);
  expect(await counts()).toEqual(before);
 } finally {await holder.query("ROLLBACK");holder.release();await pending;}
});
