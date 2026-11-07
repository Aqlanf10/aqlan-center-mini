import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: context.token }) }), headers: async () => new Headers() }));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_clinical_text_test");
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const { POST } = await import("../../app/api/visits/[id]/clinical/route");
let actorId: number, expiry: number, serial = 0;
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
beforeAll(async () => {
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-sign-authority");
  [{ id: actorId }] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES ('synthetic-signer','Synthetic signer',$1,'admin') RETURNING id", [hash]);
  expiry = Date.now() + 3_600_000;
  context.token = auth.createSessionToken({ userId: actorId, username: "synthetic-signer", role: "admin", expiresAt: expiry, credentialVersion: auth.sessionCredentialVersion(hash) });
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture(unlinked = false) {
  const [{ id: patientId }] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic sign patient') RETURNING id", [`SIGN-AUTH-${++serial}`]);
  const [{ id: visitId }] = await q("INSERT INTO visits(patient_name,patient_id,diagnosis,treatment_done) VALUES('Synthetic sign patient',$1,'Synthetic diagnosis','Synthetic documented work') RETURNING id", [unlinked ? null : patientId]);
  const send = () => POST(new Request(`https://synthetic.invalid/api/visits/${visitId}/clinical`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sign" }) }), { params: Promise.resolve({ id: String(visitId) }) });
  return { patientId, visitId, send };
}
const snapshot = async () => Object.fromEntries(await Promise.all(["patients", "visits", "invoices", "payments", "ortho_adjustments", "audit_log", "treatment_plans", "plan_items", "visit_procedures", "tooth_conditions", "lab_orders", "inventory_movements", "treatment_sessions", "planned_visits"].map(async table => [table, await q(`SELECT * FROM ${table} ORDER BY 1`)])));
async function orthoFixture(){
 const f=await fixture();const created=await db.createOrthoCase({patientId:f.patientId,appliance:"fixed_metal",arches:"both",slot:"022",bracketSystem:null,startDate:"2026-10-01",plannedMonths:18,planId:null,note:null,createdBy:"synthetic-signer"});
 if(!created.ok)throw new Error(created.message);
 const send=(orthoSession:unknown)=>POST(new Request(`https://synthetic.invalid/api/visits/${f.visitId}/clinical`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"sign",orthoSession})}),{params:Promise.resolve({id:String(f.visitId)})});
 return {...f,caseId:created.id,send};
}
it.each(["x".repeat(401),{text:"intended clinical description"}])("refuses lossy staged description %j before signing",async done=>{
 const f=await orthoFixture(),before=await snapshot();const response=await f.send({caseId:f.caseId,nextWeeks:4,done});
 console.info("Synthetic staged text",{status:response.status,stored:await q("SELECT done FROM ortho_adjustments WHERE case_id=$1",[f.caseId])});
 expect(response.status).toBe(400);expect(await snapshot()).toEqual(before);
});
const limits={upperWire:40,lowerWire:40,elasticNote:120,done:400,note:300};
for(const [field,limit] of Object.entries(limits)){
 it(`${field} oversized and malformed admission preserves complete fixture snapshots`,async()=>{
  const f=await orthoFixture(),before=await snapshot();
  for(const value of ["x".repeat(limit+1),false,{text:"not a string"}]){
   expect((await f.send({caseId:f.caseId,nextWeeks:4,[field]:value})).status).toBe(400);expect(await snapshot()).toEqual(before);
  }
 });
}
it("persists all exact trimmed boundaries, then valid retry409 and malformed retry400 without changes",async()=>{
 const f=await orthoFixture(),body={caseId:f.caseId,nextWeeks:4,...Object.fromEntries(Object.entries(limits).map(([field,n])=>[field,`  ${"x".repeat(n)}  `]))};
 expect((await f.send(body)).status).toBe(200);
 expect(await q("SELECT upper_wire,lower_wire,elastic_note,done,note FROM ortho_adjustments WHERE case_id=$1",[f.caseId])).toEqual([{upper_wire:"x".repeat(40),lower_wire:"x".repeat(40),elastic_note:"x".repeat(120),done:"x".repeat(400),note:"x".repeat(300)}]);
 const before=await snapshot();expect((await f.send(body)).status).toBe(409);expect(await snapshot()).toEqual(before);
 expect((await f.send({...body,done:"x".repeat(401)})).status).toBe(400);expect(await snapshot()).toEqual(before);
});
it.each(["omitted","null","blank"])("preserves %s optional text semantics",async mode=>{
 const f=await orthoFixture(),fields=mode==="omitted"?{}:Object.fromEntries(Object.keys(limits).map(k=>[k,mode==="null"?null:" \t "]));
 expect((await f.send({caseId:f.caseId,nextWeeks:4,...fields})).status).toBe(200);
 expect(await q("SELECT upper_wire,lower_wire,elastic_note,done,note FROM ortho_adjustments WHERE case_id=$1",[f.caseId])).toEqual([{upper_wire:null,lower_wire:null,elastic_note:null,done:null,note:null}]);
});
it.each([undefined,null])("preserves previously stored source text when no new staged session is supplied (%j)",async absence=>{
 const f=await orthoFixture();const seeded=await db.recordAdjustment({caseId:f.caseId,visitId:f.visitId,doneOn:"2026-10-02",phase:null,upperWire:null,lowerWire:null,elastics:"none",elasticNote:null,done:"Previously stored clinical text",nextWeeks:4,note:null,recordedBy:"synthetic-signer",actorRole:"admin"});expect(seeded.ok).toBe(true);
 const clinical=await q("SELECT id,case_id,visit_id,done,recorded_by FROM ortho_adjustments WHERE case_id=$1",[f.caseId]);
 expect((await f.send(absence)).status).toBe(200);expect(await q("SELECT id,case_id,visit_id,done,recorded_by FROM ortho_adjustments WHERE case_id=$1",[f.caseId])).toEqual(clinical);
});
