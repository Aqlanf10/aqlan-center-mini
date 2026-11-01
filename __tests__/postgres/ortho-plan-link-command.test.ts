import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
vi.mock("server-only", () => ({}));
// Hosted PostgreSQL only: dedicated isolated test database, never application data.
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_ortho_plan_link_command_test");
const db = await import("../../lib/db");
const auth = await import("../../lib/auth");
const { commandOrthoPlanLink, readOrthoPlanLink } = await import("../../lib/ortho-plan-link-command");
let session: SessionPayload; let serial = 0;
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
beforeAll(async () => {
 await db.ensureSchema();
 const hash = await auth.hashPassword("synthetic-ortho-lock-fixture");
 const [user] = await q<{id:number}>("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('synthetic-ortho-lock','Synthetic lock',$1,'admin',TRUE) RETURNING id",[hash]);
 session = {userId:user.id,username:"synthetic-ortho-lock",role:"admin",credentialVersion:auth.sessionCredentialVersion(hash),expiresAt:Date.now()+3_600_000};
},180_000);
afterAll(async()=>{await db.resetPoolForTesting();});
async function fixture() {
 const [patient] = await q<{id:number}>("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic link fixture') RETURNING id",[`ORTHO-LINK-${++serial}`]);
 const [plan] = await q<{id:number}>("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency) VALUES($1,'Synthetic existing plan',10000,'YER') RETURNING id",[patient.id]);
 const created = await db.createOrthoCase({patientId:patient.id,appliance:"fixed_metal",arches:"both",slot:"022",bracketSystem:null,startDate:"2026-11-01",plannedMonths:18,planId:null,note:null,createdBy:session.username});
 if(!created.ok)throw new Error(created.message);
 return {patientId:patient.id,planId:plan.id,caseId:created.id};
}
async function connection(){const c=new Client({connectionString:process.env.DATABASE_URL,ssl:false});await c.connect();return c;}
async function waitForBlocker(pid:number) {
 const deadline=Date.now()+8000;
 while(Date.now()<deadline){
  const rows=await q<{n:number}>("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>$1::int AND state='active' AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM users WHERE LOWER(username) = LOWER($1)%FOR SHARE' AND $1::int=ANY(pg_blocking_pids(pid))",[pid]);
  if(rows[0].n===1)return;
  await delay(20);
 }
 throw new Error("Expected actual PostgreSQL wait edge did not occur");
}
const observed = (caseId:number)=>readOrthoPlanLink(session,caseId);
const money = (patientId:number)=>q("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT sum(total_minor)::text FROM treatment_plans WHERE patient_id=$1) principal",[patientId]);
describe("Stage plan link: native locks, current authority and opaque observations",()=>{
 it("links with an observed version; preserves money; stale noop/unlink never succeeds",async()=>{
  const f=await fixture();const before=await observed(f.caseId);const amounts=await money(f.patientId);
  expect(await commandOrthoPlanLink(session,f.caseId,{planId:f.planId,expectedVersion:before.observedVersion})).toMatchObject({ok:true,changed:true});
  const after=await observed(f.caseId);expect(after.planId).toBe(f.planId);expect(after.observedVersion).not.toBe(before.observedVersion);
  await expect(commandOrthoPlanLink(session,f.caseId,{planId:f.planId,expectedVersion:before.observedVersion})).rejects.toMatchObject({status:409});
  await expect(commandOrthoPlanLink(session,f.caseId,{planId:null,expectedVersion:before.observedVersion})).rejects.toMatchObject({status:409});
  expect(await money(f.patientId)).toEqual(amounts);
  expect(await commandOrthoPlanLink(session,f.caseId,{planId:f.planId,expectedVersion:after.observedVersion})).toMatchObject({changed:false});
 });
 it("rejects another patient's target and a cancelled target, preserving old source",async()=>{
  const a=await fixture(),b=await fixture();const view=await observed(a.caseId);
  await expect(commandOrthoPlanLink(session,a.caseId,{planId:b.planId,expectedVersion:view.observedVersion})).rejects.toMatchObject({status:409});
  await q("UPDATE treatment_plans SET status='cancelled' WHERE id=$1",[a.planId]);
  await expect(commandOrthoPlanLink(session,a.caseId,{planId:a.planId,expectedVersion:view.observedVersion})).rejects.toMatchObject({status:409});
  expect((await observed(a.caseId)).planId).toBeNull();
 });
 it("rejects a busy patient without waiting in reverse user/patient order",async()=>{
  const f=await fixture(),view=await observed(f.caseId),c=await connection();
  try{await c.query("BEGIN");await c.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[f.patientId]);
   await expect(commandOrthoPlanLink(session,f.caseId,{planId:f.planId,expectedVersion:view.observedVersion})).rejects.toMatchObject({status:409});
  }finally{await c.query("ROLLBACK");await c.end();}
  expect((await observed(f.caseId)).planId).toBeNull();
 });
 it("revalidates the admitted session after a real user-lock wait and rejects revocation",async()=>{
  const f=await fixture(),view=await observed(f.caseId),c=await connection();let pending:Promise<unknown>|undefined;
  try{await c.query("BEGIN");await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[session.userId]);
   const pid=(await c.query<{pid:number}>("SELECT pg_backend_pid() pid")).rows[0].pid;
   pending=commandOrthoPlanLink(session,f.caseId,{planId:f.planId,expectedVersion:view.observedVersion}).catch(error=>error);
   await waitForBlocker(pid);await c.query("UPDATE users SET is_active=FALSE WHERE id=$1",[session.userId]);await c.query("COMMIT");
   expect(await pending).toMatchObject({status:401});
  }finally{await c.query("ROLLBACK").catch(()=>undefined);await c.end();await pending;await q("UPDATE users SET is_active=TRUE WHERE id=$1",[session.userId]);}
  expect((await observed(f.caseId)).planId).toBeNull();
 });
 it("refuses a target plan being cancelled under lock; reread still rejects after commit",async()=>{
  const f=await fixture(),view=await observed(f.caseId),c=await connection();
  try{await c.query("BEGIN");await c.query("UPDATE treatment_plans SET status='cancelled' WHERE id=$1",[f.planId]);
   await expect(commandOrthoPlanLink(session,f.caseId,{planId:f.planId,expectedVersion:view.observedVersion})).rejects.toMatchObject({status:409});
   await c.query("COMMIT");
  }finally{await c.query("ROLLBACK").catch(()=>undefined);await c.end();}
  await expect(commandOrthoPlanLink(session,f.caseId,{planId:f.planId,expectedVersion:view.observedVersion})).rejects.toMatchObject({status:409});
 });
 it("rolls the link back when audit persistence fails",async()=>{
  const f=await fixture(),view=await observed(f.caseId);
  await q("CREATE FUNCTION synthetic_link_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.plan_link' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$");
  await q("CREATE TRIGGER synthetic_link_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_link_audit_failure()");
  try{await expect(commandOrthoPlanLink(session,f.caseId,{planId:f.planId,expectedVersion:view.observedVersion})).rejects.toThrow("synthetic audit failure");}
  finally{await q("DROP TRIGGER synthetic_link_audit_failure ON audit_log");await q("DROP FUNCTION synthetic_link_audit_failure()");}
  expect((await observed(f.caseId)).planId).toBeNull();
 });
 it("preserves authorized all-patient writes without widening own-plan reads",async()=>{
  const f=await fixture(),view=await observed(f.caseId);
  const hash=await auth.hashPassword("synthetic-doctor-lock-fixture");
  const [party]=await q<{id:number}>("INSERT INTO parties(name,kind,is_active) VALUES('Synthetic scope doctor','doctor',TRUE) RETURNING id");
  const [user]=await q<{id:number}>("INSERT INTO users(username,display_name,password_hash,role,is_active,party_id,permissions) VALUES('synthetic-scope-doctor','Synthetic doctor',$1,'doctor',TRUE,$2,$3) RETURNING id",[hash,party.id,JSON.stringify({canViewAllPatients:true,canViewPlans:false,canEditPlans:true})]);
  const doctor:SessionPayload={userId:user.id,username:"synthetic-scope-doctor",role:"doctor",credentialVersion:auth.sessionCredentialVersion(hash),expiresAt:Date.now()+3_600_000};
  await expect(readOrthoPlanLink(doctor,f.caseId)).rejects.toMatchObject({status:403});
  expect(await commandOrthoPlanLink(doctor,f.caseId,{planId:f.planId,expectedVersion:view.observedVersion})).toMatchObject({ok:true,planId:f.planId});
  const fresh=await observed(f.caseId);
  await q("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewPlans:true,canEditPlans:false}),user.id]);
  await expect(commandOrthoPlanLink(doctor,f.caseId,{planId:null,expectedVersion:fresh.observedVersion})).rejects.toMatchObject({status:403});
  await expect(readOrthoPlanLink(doctor,f.caseId)).rejects.toMatchObject({status:403});
  await q("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true,canViewPlans:true,canEditPlans:true}),user.id]);
  await q("UPDATE parties SET is_active=FALSE WHERE id=$1",[party.id]);
  await expect(commandOrthoPlanLink(doctor,f.caseId,{planId:null,expectedVersion:fresh.observedVersion})).rejects.toMatchObject({status:403});
  expect((await observed(f.caseId)).planId).toBe(f.planId);
 });
 it("rejects expired sessions and does not expose internal tuple identity",async()=>{
  const f=await fixture();const view=await observed(f.caseId);
  expect(Object.keys(view).sort()).toEqual(["caseId","observedVersion","patientId","planId","status"]);
  expect(view.observedVersion).toMatch(/^[a-f0-9]{64}$/);
  await expect(commandOrthoPlanLink({...session,expiresAt:Date.now()-1},f.caseId,{planId:f.planId,expectedVersion:view.observedVersion})).rejects.toMatchObject({status:401});
 });
});
