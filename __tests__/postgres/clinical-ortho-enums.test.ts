import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: context.token }) }), headers: async () => new Headers() }));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_clinical_enums_test");
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
it.each([{phase:"unrecognized_phase"},{elastics:"unrecognized_elastics"},{elastics:"constructor"},{phase:"constructor"}])("refuses malformed supplied clinical enum %j",async fields=>{
 const f=await orthoFixture(),before=await snapshot();const response=await f.send({caseId:f.caseId,nextWeeks:4,...fields});
 console.info("Synthetic enum admission",{fields,status:response.status,stored:await q("SELECT phase,elastics FROM ortho_adjustments WHERE case_id=$1",[f.caseId])});
 expect(response.status).toBe(400);expect(await snapshot()).toEqual(before);
});
for(const field of ["phase","elastics"] as const)it(`${field} rejects explicit malformed values without effects`,async()=>{
 const f=await orthoFixture(),before=await snapshot();for(const value of ["", " ","toString","__proto__",false,{},[]]){
  expect((await f.send({caseId:f.caseId,[field]:value})).status).toBe(400);expect(await snapshot()).toEqual(before);
 }
});
it.each([undefined,null])("preserves absent/null enum defaults %j",async value=>{
 const f=await orthoFixture();expect((await f.send({caseId:f.caseId,phase:value,elastics:value})).status).toBe(200);
 expect(await q("SELECT phase,elastics FROM ortho_adjustments WHERE case_id=$1",[f.caseId])).toEqual([{phase:null,elastics:"none"}]);
});
it.each(["aligning","working","finishing","retention"])("preserves known treatment phase %s",async phase=>{
 const f=await orthoFixture();expect((await f.send({caseId:f.caseId,phase,elastics:"none"})).status).toBe(200);
 expect(await q("SELECT phase FROM ortho_adjustments WHERE case_id=$1",[f.caseId])).toEqual([{phase}]);
});
it.each(["none","class_ii","class_iii","vertical","triangle","cross"])("preserves exact valid elastics %s",async elastics=>{
 const f=await orthoFixture();expect((await f.send({caseId:f.caseId,elastics})).status).toBe(200);
 expect(await q("SELECT elastics FROM ortho_adjustments WHERE case_id=$1",[f.caseId])).toEqual([{elastics}]);
});
it("assessment phase remains subject to unchanged new-session writer refusal",async()=>{
 const f=await orthoFixture(),before=await snapshot();expect((await f.send({caseId:f.caseId,phase:"assessment"})).status).toBe(409);expect(await snapshot()).toEqual(before);
});
it("valid signed repeat stays409 and malformed signed repeat400 without writes",async()=>{
 const f=await orthoFixture(),body={caseId:f.caseId,phase:"working",elastics:"class_ii"};expect((await f.send(body)).status).toBe(200);const before=await snapshot();
 expect((await f.send(body)).status).toBe(409);expect(await snapshot()).toEqual(before);
 expect((await f.send({...body,elastics:"constructor"})).status).toBe(400);expect(await snapshot()).toEqual(before);
});
it.each([undefined,null])("does not reinterpret previously stored enum when session is omitted %j",async absence=>{
 const f=await orthoFixture();const seeded=await db.recordAdjustment({caseId:f.caseId,visitId:f.visitId,doneOn:"2026-10-02",phase:null,upperWire:null,lowerWire:null,elastics:"none",elasticNote:null,done:"Stored source",nextWeeks:4,note:null,recordedBy:"synthetic-signer",actorRole:"admin"});expect(seeded.ok).toBe(true);
 // Simulate pre-fix stored text, not a new approved authoring operation.
 await q("UPDATE ortho_adjustments SET elastics='constructor' WHERE case_id=$1",[f.caseId]);
 const before=await q("SELECT id,case_id,visit_id,phase,elastics FROM ortho_adjustments WHERE case_id=$1",[f.caseId]);
 expect((await f.send(absence)).status).toBe(200);expect(await q("SELECT id,case_id,visit_id,phase,elastics FROM ortho_adjustments WHERE case_id=$1",[f.caseId])).toEqual(before);
});
