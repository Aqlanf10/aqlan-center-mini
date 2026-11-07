import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { createAdjustmentCommand } from "../../lib/ortho-adjustment-command";
import { clinicDateString } from "../../lib/schedule";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: context.token } : undefined }),
  headers: async () => new Headers(),
}));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_adjustment_visit_input_test");
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

it("refuses malformed explicit visit identity instead of autoattaching today's latest visit",async()=>{
 const f=await fixture();
 const {rows}=await db.getPool().query("INSERT INTO visits(patient_name,patient_id) VALUES('Synthetic earlier visit',$1),('Synthetic later visit',$1) RETURNING id",[f.scope.patientId]);
 const before=await f.footprint();
 const response=await f.sendRaw({...JSON.parse(f.command.body),doneOn:clinicDateString(new Date(),db.CLINIC_TIME_ZONE),visitId:"not-a-visit"});
 const payload=await response.json();console.info("Synthetic malformed visit response",{status:response.status,payload,openVisitIds:rows.map(r=>r.id)});
 expect(response.status).toBe(400);expect(await f.footprint()).toEqual(before);
});

it.each(["", " ", 0, -1, 1.5, true, false, [], [1], {}, "1.00000000000000001", "2147483647.0000001", 2147483648, Number.MAX_SAFE_INTEGER+1])("refuses explicit invalid visit %j before new footprint and keeps key reusable",async visitId=>{
 const f=await fixture(),before=await f.footprint(),body=JSON.parse(f.command.body);
 const response=await f.sendRaw({...body,visitId,newVisitAdmissionError:null,request:{newVisitAdmissionError:null}});
 expect(response.status).toBe(400);expect(await response.json()).toMatchObject({code:"invalid_adjustment_visit"});expect(await f.footprint()).toEqual(before);
 expect((await f.sendRaw(body)).status).toBe(201);
});
it.each([undefined,null])("preserves intentional autoattachment for %j",async visitId=>{
 const f=await fixture();const {rows:[visit]}=await db.getPool().query("INSERT INTO visits(patient_name,patient_id) VALUES('Synthetic autoattach',$1) RETURNING id",[f.scope.patientId]);
 const response=await f.sendRaw({...JSON.parse(f.command.body),doneOn:clinicDateString(new Date(),db.CLINIC_TIME_ZONE),visitId});
 expect(response.status).toBe(201);expect(await response.json()).toMatchObject({visitId:visit.id,attachedToToday:true});
});
it.each([false,true])("preserves valid explicit numeric/string visit (string=%j)",async asString=>{
 const f=await fixture();const {rows:[visit]}=await db.getPool().query("INSERT INTO visits(patient_name,patient_id) VALUES('Synthetic explicit visit',$1) RETURNING id",[f.scope.patientId]);
 const body={...JSON.parse(f.command.body),visitId:asString?String(visit.id):visit.id};
 const first=await f.sendRaw(body);expect(first.status).toBe(201);expect(await first.json()).toMatchObject({visitId:visit.id,attachedToToday:false});const before=await f.footprint();
 expect((await f.sendRaw(body)).status).toBe(200);expect(await f.footprint()).toEqual(before);
});
async function seedLegacy(f:Awaited<ReturnType<typeof fixture>>,visitId:number|null){
 return db.recordAdjustment({caseId:f.scope.caseId,visitId,doneOn:"2026-10-02",phase:null,upperWire:"016 NiTi",lowerWire:null,elastics:"none",elasticNote:null,done:"Synthetic HTTP adjustment",nextWeeks:4,note:null,
 recordedBy:"synthetic-http-replay",actorRole:"admin",request:{key:f.command.key,patientId:f.scope.patientId,session:auth.readSessionToken(context.token)!}});
}
it.each(["invalid",false])("replays a legacy malformed visit normalized to null (%j) without a new link",async visitId=>{
 const f=await fixture();expect((await seedLegacy(f,null)).ok).toBe(true);const before=await f.footprint();
 const response=await f.sendRaw({...JSON.parse(f.command.body),visitId});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({replayed:true,visitId:null});expect(await f.footprint()).toEqual(before);
 expect((await f.sendRaw({...JSON.parse(f.command.body),visitId,done:"changed"})).status).toBe(409);
});
it.each(["array","fractional-string","exponent-string"])("replays legacy normalized visit (%s) but rejects the new representation",async representation=>{
 const f=await fixture();const {rows:[visit]}=await db.getPool().query("INSERT INTO visits(patient_name,patient_id) VALUES('Synthetic legacy visit',$1) RETURNING id",[f.scope.patientId]);
 expect((await seedLegacy(f,visit.id)).ok).toBe(true);const before=await f.footprint(),body={...JSON.parse(f.command.body),visitId:representation==="array"?[visit.id]:representation==="fractional-string"?`${visit.id}.00000000000000001`:`${visit.id}e0`};
 const response=await f.sendRaw(body);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({replayed:true,visitId:visit.id});
 expect((await f.sendRaw(body,f.command.key+"-new")).status).toBe(400);expect(await f.footprint()).toEqual(before);
});
it("valid foreign visit is refused, never silently replaced by today's own visit",async()=>{
 const f=await fixture(),foreign=await fixture();const {rows:[visit]}=await db.getPool().query("INSERT INTO visits(patient_name,patient_id) VALUES('Synthetic foreign visit',$1) RETURNING id",[foreign.scope.patientId]);
 await db.getPool().query("INSERT INTO visits(patient_name,patient_id) VALUES('Synthetic own visit',$1)",[f.scope.patientId]);const before=await f.footprint();
 const response=await f.sendRaw({...JSON.parse(f.command.body),doneOn:clinicDateString(new Date(),db.CLINIC_TIME_ZONE),visitId:visit.id});
 expect(response.status).toBe(409);expect(await f.footprint()).toEqual(before);
});
