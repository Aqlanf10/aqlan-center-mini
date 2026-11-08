import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: context.token }) }), headers: async () => new Headers() }));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_clinical_case_input_test");
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
it.each(["boolean","array","precision-string"])("refuses coercive staged case identity (%s) before signing effects",async representation=>{
 const f=await fixture();const created=await db.createOrthoCase({patientId:f.patientId,appliance:"fixed_metal",arches:"both",slot:"022",bracketSystem:null,startDate:"2026-10-01",plannedMonths:18,planId:null,note:null,createdBy:"synthetic-signer"});
 if(!created.ok)throw new Error(created.message);
 const caseId=representation==="boolean"?true:representation==="array"?[created.id]:`${created.id}.00000000000000001`;
 if(representation==="boolean")expect(created.id).toBe(1);
 const before=await snapshot();
 const response=await POST(new Request(`https://synthetic.invalid/api/visits/${f.visitId}/clinical`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"sign",orthoSession:{caseId,nextWeeks:4,done:"Synthetic session"}})}),{params:Promise.resolve({id:String(f.visitId)})});
 console.info("Synthetic coerced case identity",{caseId,status:response.status,stored:await q("SELECT case_id,visit_id FROM ortho_adjustments WHERE visit_id=$1",[f.visitId])});
 expect(response.status).toBe(400);expect(await snapshot()).toEqual(before);
});
async function createCase(patientId:number){
 const created=await db.createOrthoCase({patientId,appliance:"fixed_metal",arches:"both",slot:"022",bracketSystem:null,startDate:"2026-10-01",plannedMonths:18,planId:null,note:null,createdBy:"synthetic-signer"});
 if(!created.ok)throw new Error(created.message);return created.id;
}
async function send(visitId:number,orthoSession:unknown){return POST(new Request(`https://synthetic.invalid/api/visits/${visitId}/clinical`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"sign",orthoSession})}),{params:Promise.resolve({id:String(visitId)})});}
it.each([undefined,null,"",0,-1,2147483648,Number.MAX_SAFE_INTEGER+1,"1e0","+1","1.0"])("refuses new malformed case %j without effects",async caseId=>{
 const f=await fixture(),before=await snapshot();expect((await send(f.visitId,{caseId,nextWeeks:4})).status).toBe(400);expect(await snapshot()).toEqual(before);
});
it.each([false,true])("signs exact numeric/digit-string case once (string=%j)",async asString=>{
 const f=await fixture(),caseId=await createCase(f.patientId),body={caseId:asString?` 00${caseId} `:caseId,nextWeeks:4};
 expect((await send(f.visitId,body)).status).toBe(200);expect(await q("SELECT case_id,visit_id FROM ortho_adjustments WHERE visit_id=$1",[f.visitId])).toEqual([{case_id:caseId,visit_id:f.visitId}]);
 const before=await snapshot();expect((await send(f.visitId,body)).status).toBe(409);expect(await snapshot()).toEqual(before);
 expect((await send(f.visitId,{...body,caseId:[caseId]})).status).toBe(400);expect(await snapshot()).toEqual(before);
});
it("valid foreign case is refused by existing source ownership, without side effects",async()=>{
 const f=await fixture(),foreign=await fixture(),caseId=await createCase(foreign.patientId),before=await snapshot();
 expect((await send(f.visitId,{caseId,nextWeeks:4})).status).toBe(409);expect(await snapshot()).toEqual(before);
});
it("valid same-patient different case cannot replace a recorded visit adjustment",async()=>{
 const f=await fixture(),original=await createCase(f.patientId);
 const recorded=await db.recordAdjustment({caseId:original,visitId:f.visitId,doneOn:"2026-10-02",phase:null,upperWire:null,lowerWire:null,elastics:"none",elasticNote:null,done:"Stored source",nextWeeks:4,note:null,recordedBy:"synthetic-signer",actorRole:"admin"});expect(recorded.ok).toBe(true);
 await q("UPDATE ortho_cases SET status='completed' WHERE id=$1",[original]);const replacement=await createCase(f.patientId),before=await snapshot();
 expect((await send(f.visitId,{caseId:replacement,nextWeeks:4})).status).toBe(409);expect(await snapshot()).toEqual(before);
 // No submitted session still signs from the existing recorded source, without replacement.
 expect((await send(f.visitId,null)).status).toBe(200);expect(await q("SELECT case_id,visit_id FROM ortho_adjustments WHERE visit_id=$1",[f.visitId])).toEqual([{case_id:original,visit_id:f.visitId}]);
});
