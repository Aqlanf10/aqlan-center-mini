// Real PostgreSQL server-route fixture, outside Next's server-module resolver.
// Only the framework marker is stubbed; transactional authority and storage stay real.
vi.mock("server-only", () => ({}));

import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { createAdjustmentCommand } from "../../lib/ortho-adjustment-command";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: context.token } : undefined }),
  headers: async () => new Headers(),
}));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_adjustment_enum_test");
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

it.each([{phase:"unknown_phase"},{elastics:"unknown_elastics"},{elastics:"constructor"}])("refuses a new malformed enum %j without writes",async fields=>{
 const f=await fixture(),before=await f.footprint();const response=await f.sendRaw({...JSON.parse(f.command.body),...fields});
 console.info("Synthetic standalone enum",{fields,status:response.status,rows:(await db.getPool().query("SELECT phase,elastics FROM ortho_adjustments WHERE case_id=$1",[f.scope.caseId])).rows});
 expect(response.status).toBe(400);expect(await f.footprint()).toEqual(before);
});

for(const field of ["phase","elastics"] as const)it(`${field} refuses explicit malformed values and leaves key reusable`,async()=>{
 const f=await fixture(),body=JSON.parse(f.command.body),before=await f.footprint();
 for(const value of ["", " ","constructor","toString","__proto__",false,{},[]]){
  const result=await f.sendRaw({...body,[field]:value,newEnumAdmissionError:null,request:{newEnumAdmissionError:null}});expect(result.status).toBe(400);expect(await result.json()).toMatchObject({code:"invalid_adjustment_enum"});expect(await f.footprint()).toEqual(before);
 }
 expect((await f.sendRaw(body)).status).toBe(201);
});
it.each([undefined,null])("retains omitted/null phase and elastic defaults %j",async value=>{
 const f=await fixture();expect((await f.sendRaw({...JSON.parse(f.command.body),phase:value,elastics:value})).status).toBe(201);
 expect((await db.getPool().query("SELECT phase,elastics FROM ortho_adjustments WHERE case_id=$1",[f.scope.caseId])).rows).toEqual([{phase:null,elastics:"none"}]);
});
it.each(["aligning","working","finishing","retention"])("persists own treatment phase %s",async phase=>{
 const f=await fixture();expect((await f.sendRaw({...JSON.parse(f.command.body),phase})).status).toBe(201);
 expect((await db.getPool().query("SELECT phase FROM ortho_adjustments WHERE case_id=$1",[f.scope.caseId])).rows).toEqual([{phase}]);
});
it.each(["none","class_ii","class_iii","vertical","triangle","cross"])("persists own elastic class %s",async elastics=>{
 const f=await fixture();expect((await f.sendRaw({...JSON.parse(f.command.body),elastics})).status).toBe(201);
 expect((await db.getPool().query("SELECT elastics FROM ortho_adjustments WHERE case_id=$1",[f.scope.caseId])).rows).toEqual([{elastics}]);
});
it("retains assessment's existing new-session writer refusal",async()=>{
 const f=await fixture(),before=await f.footprint();expect((await f.sendRaw({...JSON.parse(f.command.body),phase:"assessment"})).status).toBe(409);expect(await f.footprint()).toEqual(before);
});
async function seedLegacy(f:Awaited<ReturnType<typeof fixture>>,elastics="none"){
 const input={caseId:f.scope.caseId,visitId:null,doneOn:"2026-10-02",phase:null,upperWire:"016 NiTi",lowerWire:null,elastics:elastics as "none",elasticNote:null,done:"Synthetic HTTP adjustment",nextWeeks:4,note:null,
 recordedBy:"synthetic-http-replay",actorRole:"admin",request:{key:f.command.key,patientId:f.scope.patientId,session:auth.readSessionToken(context.token)!}};
 if(elastics==="none")return db.recordAdjustment(input);
 // Historical row from before writer-level enum validation: the merged writer now refuses
 // a non-enum value itself, so the old row and its exact v1 receipt are seeded directly.
 const {request,...legacy}=input,written=await db.recordAdjustment({...legacy,elastics:"none"});if(!written.ok)return written;
 const hash=createHash("sha256").update(JSON.stringify({version:1,actorId:request.session.userId,patientId:request.patientId,caseId:input.caseId,visitId:input.visitId,doneOn:input.doneOn,phase:input.phase,
  upperWire:input.upperWire,lowerWire:input.lowerWire,elastics,elasticNote:input.elasticNote,done:input.done,nextWeeks:input.nextWeeks,note:input.note})).digest("hex");
 await db.getPool().query("UPDATE ortho_adjustments SET elastics=$2 WHERE id=$1",[written.id,elastics]);
 await db.getPool().query(`INSERT INTO ortho_adjustment_requests(actor_user_id,request_key,request_hash,patient_id,case_id,adjustment_id,visit_id,attached_to_today)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[request.session.userId,request.key,hash,request.patientId,input.caseId,written.id,written.visitId,written.attachedToToday]);
 return written;
}
it.each([{phase:"unknown_phase"},{phase:"constructor"},{elastics:"unknown_elastics"},{elastics:"constructor"}])("replays old normalized enum receipt %j without a new write",async fields=>{
 const f=await fixture();expect((await seedLegacy(f,fields.elastics==="constructor"?"constructor":"none")).ok).toBe(true);
 const before=await f.footprint(),rows=(await db.getPool().query("SELECT * FROM ortho_adjustments WHERE case_id=$1",[f.scope.caseId])).rows;
 const body={...JSON.parse(f.command.body),...fields};const response=await f.sendRaw(body);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({existing:true,replayed:true});expect(await f.footprint()).toEqual(before);
 expect((await f.sendRaw({...body,done:"changed normalized facts"})).status).toBe(409);expect(await f.footprint()).toEqual(before);
 expect((await db.getPool().query("SELECT * FROM ortho_adjustments WHERE case_id=$1",[f.scope.caseId])).rows).toEqual(rows);
 expect((await f.sendRaw(body,f.command.key+"-new")).status).toBe(400);expect(await f.footprint()).toEqual(before);
});
it("expired actor cannot use a legacy invalid-enum receipt",async()=>{
 const f=await fixture();expect((await seedLegacy(f,"constructor")).ok).toBe(true);const before=await f.footprint(),saved=context.token;
 context.token=auth.createSessionToken({...auth.readSessionToken(saved)!,expiresAt:Date.now()-1});
 try {expect((await f.sendRaw({...JSON.parse(f.command.body),elastics:"constructor"})).status).toBe(401);expect(await f.footprint()).toEqual(before);}
 finally {context.token=saved;}
});
it("different actor cannot reuse an invalid-enum receipt or create a second record",async()=>{
 const f=await fixture();expect((await seedLegacy(f,"constructor")).ok).toBe(true);const before=await f.footprint(),saved=context.token;
 const hash=await auth.hashPassword("synthetic-other-actor");const {rows:[other]}=await db.getPool().query("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-other-actor','Other synthetic actor',$1,'admin') RETURNING id",[hash]);
 context.token=auth.createSessionToken({userId:other.id,username:"synthetic-other-actor",role:"admin",expiresAt:Date.now()+3600000,credentialVersion:auth.sessionCredentialVersion(hash)});
 try {expect((await f.sendRaw({...JSON.parse(f.command.body),elastics:"constructor"})).status).toBe(400);expect(await f.footprint()).toEqual(before);}
 finally {context.token=saved;}
});
