// Real PostgreSQL server-route fixture, outside Next's server-module resolver.
// Only the framework marker is stubbed; transactional authority and storage stay real.
vi.mock("server-only", () => ({}));

import { Client } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { createAdjustmentCommand } from "../../lib/ortho-adjustment-command";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: context.token } : undefined }),
  headers: async () => new Headers(),
}));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_adjustment_midnight_test");
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const { POST } = await import("../../app/api/ortho/[id]/route");
let actorId: number, serial = 0;
beforeAll(async () => {
  await db.ensureSchema();
  const passwordHash = await auth.hashPassword("synthetic-http-replay");
  const { rows: [user] } = await db.getPool().query(`INSERT INTO users(username,display_name,password_hash,role)
    VALUES ('synthetic-http-replay','Synthetic HTTP replay',$1,'admin') RETURNING id`, [passwordHash]);
  actorId = user.id;
  context.token = auth.createSessionToken({ userId: actorId, username: "synthetic-http-replay", role: "admin",
    expiresAt: Date.now() + 864_000_000, credentialVersion: auth.sessionCredentialVersion(passwordHash) });
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture() {
  const { rows: [patient] } = await db.getPool().query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic replay patient') RETURNING id", [`ORTHO-HTTP-${++serial}`]);
  const created = await db.createOrthoCase({ patientId: patient.id, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: null, startDate: "2026-10-01", plannedMonths: 18, planId: null, note: null, createdBy: "synthetic-http-replay" });
  if (!created.ok) throw new Error(created.message);
  const scope = { patientId: patient.id, caseId: created.id, authority: `user:${actorId}` };
  const rows = new Map<string, string>();
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
  const command = createAdjustmentCommand(storage, scope, { doneOn: "2026-10-02", upperWire: "016 NiTi", lowerWire: "",
    elastics: "none", elasticNote: "", done: "Synthetic HTTP adjustment", nextWeeks: 4 });
  const send = () => POST(new Request(`https://synthetic.invalid/api/ortho/${scope.caseId}`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": command.key }, body: command.body,
  }), { params: Promise.resolve({ id: String(scope.caseId) }) });
  const footprint = async () => (await db.getPool().query(`SELECT
    (SELECT count(*) FROM ortho_adjustments WHERE case_id=$1)::int AS adjustments,
    (SELECT count(*) FROM ortho_adjustment_requests WHERE case_id=$1)::int AS commands,
    (SELECT count(*) FROM audit_log WHERE action='ortho.adjustment')::int AS audits,
    (SELECT count(*) FROM invoices)::int AS invoices,
    (SELECT count(*) FROM payments)::int AS payments,
    (SELECT count(*) FROM visits)::int AS visits`, [scope.caseId])).rows;
  const sendRaw=(body:unknown,key=command.key)=>POST(new Request(`https://synthetic.invalid/api/ortho/${scope.caseId}`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":key},body:JSON.stringify(body)}),{params:Promise.resolve({id:String(scope.caseId)})});
  return { scope, storage, command, send, footprint, sendRaw };
}

it("reconciles omitted date after midnight using full original hash and stored date, without a new row",async()=>{
 const f=await fixture(),body=JSON.parse(f.command.body);delete body.doneOn;
 const first=await f.sendRaw(body);expect(first.status).toBe(201);const receipt=await first.json(),before=await f.footprint();
 const now=Date.now();vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(now+86_400_000);
 try {const retry=await f.sendRaw(body);expect(retry.status).toBe(200);expect(await retry.json()).toMatchObject({...receipt,existing:true,replayed:true});expect(await f.footprint()).toEqual(before);}
 finally {vi.useRealTimers();}
});

it.each([undefined,null])("omitted/null %j can recover an originally explicit recorded date only by full hash",async doneOn=>{
 const f=await fixture();const first=await f.send();expect(first.status).toBe(201);const receipt=await first.json(),before=await f.footprint();
 const replay=await f.sendRaw({...JSON.parse(f.command.body),doneOn});expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({...receipt,replayed:true});
 expect(await f.footprint()).toEqual(before);
 expect((await f.sendRaw({...JSON.parse(f.command.body),doneOn,done:"changed"})).status).toBe(409);
 expect(await f.footprint()).toEqual(before);
});
it.each(["2026-10-03","wrong-date",""])("explicit date %j cannot forge omitted recovery",async doneOn=>{
 const f=await fixture();expect((await f.send()).status).toBe(201);const before=await f.footprint();
 expect((await f.sendRaw({...JSON.parse(f.command.body),doneOn,omittedDateForReplay:true,request:{omittedDateForReplay:true}})).status).toBe(409);
 expect(await f.footprint()).toEqual(before);
});
it("mutated stored date fails the original fingerprint and never rewrites it",async()=>{
 const f=await fixture();expect((await f.send()).status).toBe(201);
 const journal=(await db.getPool().query("SELECT * FROM ortho_adjustment_requests WHERE case_id=$1",[f.scope.caseId])).rows;
 await db.getPool().query("UPDATE ortho_adjustments SET done_on='2026-10-03' WHERE case_id=$1",[f.scope.caseId]);const before=await f.footprint();
 expect((await f.sendRaw({...JSON.parse(f.command.body),doneOn:null})).status).toBe(409);
 expect(await f.footprint()).toEqual(before);expect((await db.getPool().query("SELECT * FROM ortho_adjustment_requests WHERE case_id=$1",[f.scope.caseId])).rows).toEqual(journal);
});
it("busy candidate refuses after rollback and can retry with the same key",async()=>{
 const f=await fixture();expect((await f.send()).status).toBe(201);const before=await f.footprint();
 const holder=new Client({connectionString:process.env.DATABASE_URL});await holder.connect();await holder.query("BEGIN");
 try {await holder.query("SELECT id FROM ortho_adjustments WHERE case_id=$1 FOR UPDATE",[f.scope.caseId]);
  const busy=await f.sendRaw({...JSON.parse(f.command.body),doneOn:null});expect(busy.status).toBe(409);expect(await busy.json()).toMatchObject({code:"adjustment_receipt_busy"});
 } finally {await holder.query("ROLLBACK");await holder.end();}
 expect(await f.footprint()).toEqual(before);expect((await f.sendRaw({...JSON.parse(f.command.body),doneOn:null})).status).toBe(200);
});
it("current revoked actor cannot recover a prior date",async()=>{
 const f=await fixture();expect((await f.send()).status).toBe(201);const before=await f.footprint();await db.getPool().query("UPDATE users SET is_active=false WHERE id=$1",[actorId]);
 try {expect((await f.sendRaw({...JSON.parse(f.command.body),doneOn:null})).status).toBe(401);expect(await f.footprint()).toEqual(before);}
 finally {await db.getPool().query("UPDATE users SET is_active=true WHERE id=$1",[actorId]);}
});
async function observedWait(observer:Client,pid:number,queryPattern:string){
 for(let i=0;i<200;i++) {await observer.query("SELECT pg_stat_clear_snapshot()");
  const r=await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query ILIKE $2",[pid,queryPattern]);
  if(r.rows.length) return r.rows[0].pid as number;
  await new Promise(resolve=>setTimeout(resolve,15));
 }
 throw new Error("Expected actual blocking PID/query was not observed");
}
it("two next-day retriers wait for the original uncommitted request and receive its one receipt",async()=>{
 const f=await fixture(),body=JSON.parse(f.command.body);delete body.doneOn;
 const holder=new Client({connectionString:process.env.DATABASE_URL});await holder.connect();await holder.query("BEGIN");const {rows:[{pid}]}=await holder.query("SELECT pg_backend_pid() AS pid");
 await holder.query("LOCK TABLE audit_log IN SHARE MODE");
 const original=f.sendRaw(body);let retry1:Promise<Response>|undefined,retry2:Promise<Response>|undefined;
 try {
  const originalPid=await observedWait(holder,pid,"%INSERT INTO audit_log%");
  const now=Date.now();vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(now+86_400_000);
  retry1=f.sendRaw(body);await observedWait(holder,originalPid,"%pg_advisory_xact_lock%");
  retry2=f.sendRaw(body);
  await holder.query("COMMIT");
  const first=await original;expect(first.status).toBe(201);const receipt=await first.json();
  for(const response of await Promise.all([retry1,retry2])){expect(response.status).toBe(200);expect(await response.json()).toMatchObject({...receipt,existing:true,replayed:true});}
  expect((await db.getPool().query("SELECT count(*)::int AS n FROM ortho_adjustments WHERE case_id=$1",[f.scope.caseId])).rows).toEqual([{n:1}]);
  expect((await db.getPool().query("SELECT count(*)::int AS n FROM ortho_adjustment_requests WHERE case_id=$1",[f.scope.caseId])).rows).toEqual([{n:1}]);
 } finally {await holder.query("ROLLBACK");await holder.end();await Promise.allSettled([original,...[retry1,retry2].filter((p):p is Promise<Response>=>Boolean(p))]);vi.useRealTimers();}
});

it.each(["unchanged","changed","expired"])("recorded-date replay preserves visit-first order and final expiry (%s)",async outcome=>{
 const expire=outcome==="expired";
 const f=await fixture();const {rows:[visit]}=await db.getPool().query("INSERT INTO visits(patient_name,patient_id) VALUES('Synthetic midnight visit',$1) RETURNING id",[f.scope.patientId]);
 const body={...JSON.parse(f.command.body),visitId:visit.id};expect((await f.sendRaw(body)).status).toBe(201);const before=await f.footprint();
 const holder=new Client({connectionString:process.env.DATABASE_URL});await holder.connect();await holder.query("BEGIN");
 const {rows:[{pid}]}=await holder.query("SELECT pg_backend_pid() AS pid");await holder.query("SELECT id FROM visits WHERE id=$1 FOR UPDATE",[visit.id]);
 const pending=f.sendRaw({...body,doneOn:null});
 try {
  await observedWait(holder,pid,"SELECT id FROM visits WHERE id = $1 FOR UPDATE");
  // A visit-first writer can still take the adjustment lock: no inverse lock held.
  await holder.query("SELECT id FROM ortho_adjustments WHERE case_id=$1 FOR UPDATE NOWAIT",[f.scope.caseId]);
  await holder.query("UPDATE ortho_adjustments SET done_on=CASE WHEN $2 THEN DATE '2026-10-03' ELSE done_on END WHERE case_id=$1",[f.scope.caseId,outcome==="changed"]);
  if(expire){vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(auth.readSessionToken(context.token)!.expiresAt+1);}
  await holder.query("COMMIT");const response=await pending;expect(response.status).toBe(expire?401:outcome==="changed"?409:200);expect(await f.footprint()).toEqual(before);
 } finally {await holder.query("ROLLBACK");await holder.end();await Promise.allSettled([pending]);vi.useRealTimers();}
});
