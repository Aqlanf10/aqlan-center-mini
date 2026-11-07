// Real PostgreSQL server-route fixture, outside Next's server-module resolver.
// Only the framework marker is stubbed; transactional authority and storage stay real.
vi.mock("server-only", () => ({}));

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { createAdjustmentCommand } from "../../lib/ortho-adjustment-command";
import { clinicDateString } from "../../lib/schedule";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: context.token } : undefined }),
  headers: async () => new Headers(),
}));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_adjustment_date_test");
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

describe("new adjustment date admission",()=>{
 it.each(["not-a-date", "2026-02-30", "0000-01-01"])("rejects explicit invalid date %j before new writes",async value=>{
  const f=await fixture(),before=await f.footprint();
  const response=await f.sendRaw({...JSON.parse(f.command.body),doneOn:value});
  expect(response.status).toBe(400);expect(await f.footprint()).toEqual(before);
 });
});

it.each(["", " ", false, 20261002, [], {}, "1900-02-29", "2026-04-31"])("refuses malformed explicit date %j with no new footprint",async doneOn=>{
 const f=await fixture(), before=await f.footprint();
 expect((await f.sendRaw({...JSON.parse(f.command.body),doneOn,newDateAdmissionError:null})).status).toBe(400);
 expect(await f.footprint()).toEqual(before);
 expect((await f.send()).status).toBe(201); // refused key was not reserved
});
it.each(["0001-01-01","0099-12-31","2000-02-29","2024-02-29","9999-12-31",undefined,null])("accepts exact Gregorian date/default %j and replays",async doneOn=>{
 const f=await fixture(),body={...JSON.parse(f.command.body),doneOn};
 expect((await f.sendRaw(body)).status).toBe(201);
 const expected=doneOn??clinicDateString(new Date(),db.CLINIC_TIME_ZONE);
 expect((await db.getPool().query("SELECT done_on::text AS day FROM ortho_adjustments WHERE case_id=$1",[f.scope.caseId])).rows).toEqual([{day:expected}]);
 const before=await f.footprint();expect((await f.sendRaw(body)).status).toBe(200);expect(await f.footprint()).toEqual(before);
});
it("reconciles an already committed malformed-date fallback on the same clinic day, with no new writes",async()=>{
 const f=await fixture(),body={...JSON.parse(f.command.body),doneOn:"invalid-old-date"};
 const today=clinicDateString(new Date(),db.CLINIC_TIME_ZONE);
 const seeded=await db.recordAdjustment({caseId:f.scope.caseId,visitId:null,doneOn:today,phase:null,
  upperWire:"016 NiTi",lowerWire:null,elastics:"none",elasticNote:null,done:"Synthetic HTTP adjustment",nextWeeks:4,note:null,
  recordedBy:"synthetic-http-replay",actorRole:"admin",request:{key:f.command.key,patientId:f.scope.patientId,session:auth.readSessionToken(context.token)!}});
 expect(seeded.ok).toBe(true);const before=await f.footprint();
 const response=await f.sendRaw(body);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({existing:true,replayed:true});
 expect(await f.footprint()).toEqual(before);
 expect((await f.sendRaw({...body,done:"changed normalized content"})).status).toBe(409);
 expect(await f.footprint()).toEqual(before);
 await db.getPool().query("UPDATE users SET is_active=false WHERE id=$1",[actorId]);
 try { expect((await f.sendRaw(body)).status).toBe(401);expect(await f.footprint()).toEqual(before); }
 finally {await db.getPool().query("UPDATE users SET is_active=true WHERE id=$1",[actorId]);}
});
it("reconciles default-date midnight retry without duplicate creation, while frozen explicit date replays",async()=>{
 const f=await fixture(),explicit=await fixture();
 const body=JSON.parse(f.command.body);delete body.doneOn;
 expect((await f.sendRaw(body)).status).toBe(201);expect((await explicit.send()).status).toBe(201);
 const before=await f.footprint(),now=Date.now();
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(now+86_400_000);
 try {
  const replayDefault=await f.sendRaw(body);expect(replayDefault.status).toBe(200);
  expect(await replayDefault.json()).toMatchObject({existing:true,replayed:true});
  const replay=await explicit.send();expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({existing:true,replayed:true});
  expect(await f.footprint()).toEqual(before);
 } finally {vi.useRealTimers();}
});
