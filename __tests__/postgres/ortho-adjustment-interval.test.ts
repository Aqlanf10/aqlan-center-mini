import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { createAdjustmentCommand } from "../../lib/ortho-adjustment-command";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: context.token } : undefined }),
  headers: async () => new Headers(),
}));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_adjustment_interval_test");
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
    expiresAt: Date.now() + 3_600_000, credentialVersion: auth.sessionCredentialVersion(passwordHash) });
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

describe("new adjustment interval admission",()=>{
 it.each([1.5,true,[4],"1.0000000000000001","51.9999999999999999"])("rejects explicit coercive interval %j before new writes",async value=>{
  const f=await fixture(),before=await f.footprint();
  const response=await f.sendRaw({...JSON.parse(f.command.body),nextWeeks:value});
  expect(response.status).toBe(400);expect(await f.footprint()).toEqual(before);
 });
});

it.each([undefined,null,1,52,"2"," 04 ","1.0","1e0","+1",".1e1","0x34"])("preserves supported API interval/default %j",async value=>{
 const f=await fixture(), body={...JSON.parse(f.command.body),nextWeeks:value};
 const expected=value==null?4:Number(value);
 expect((await f.sendRaw(body)).status).toBe(201);
 expect((await db.getPool().query("SELECT next_weeks FROM ortho_adjustments WHERE case_id=$1",[f.scope.caseId])).rows).toEqual([{next_weeks:expected}]);
 const before=await f.footprint();expect((await f.sendRaw(body)).status).toBe(200);expect(await f.footprint()).toEqual(before);
});
it.each([1.5,true,[4],"1.5","1.0000000000000001","51.9999999999999999"])("replays an already committed normalized interval %j without a second write",async value=>{
 const f=await fixture(),body={...JSON.parse(f.command.body),nextWeeks:value},normalized=Math.round(Number(value));
 const seeded=await db.recordAdjustment({caseId:f.scope.caseId,visitId:null,doneOn:"2026-10-02",phase:null,
  upperWire:"016 NiTi",lowerWire:null,elastics:"none",elasticNote:null,done:"Synthetic HTTP adjustment",nextWeeks:normalized,note:null,
  recordedBy:"synthetic-http-replay",actorRole:"admin",request:{key:f.command.key,patientId:f.scope.patientId,session:auth.readSessionToken(context.token)!}});
 expect(seeded.ok).toBe(true); const before=await f.footprint();
 const response=await f.sendRaw(body);expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({existing:true,replayed:true});expect(await f.footprint()).toEqual(before);
 if ((typeof value === "string" && value.includes("999999")) || value === "1.0000000000000001") {
  expect((await f.sendRaw(body, "new-precision-key-" + f.scope.caseId)).status).toBe(400);
  expect(await f.footprint()).toEqual(before);
 }
 expect((await f.sendRaw({...body,nextWeeks:normalized === 52 ? 51 : normalized+1})).status).toBe(409);expect(await f.footprint()).toEqual(before);
});
it("rejects a new coercive interval without reserving its key, then accepts an explicit correction",async()=>{
 const f=await fixture(),body=JSON.parse(f.command.body),before=await f.footprint();
 expect((await f.sendRaw({...body,nextWeeks:1.5,newIntervalAdmissionError:null,request:{newIntervalAdmissionError:null}})).status).toBe(400);
 expect(await f.footprint()).toEqual(before);expect((await f.sendRaw({...body,nextWeeks:2})).status).toBe(201);
});
