import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: context.token }) }), headers: async () => new Headers() }));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_clinical_interval_test");
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
it.each([1.5,true,[4]])("refuses newly supplied coercive clinical interval %j without signing or session writes",async nextWeeks=>{
 const f=await fixture();const created=await db.createOrthoCase({patientId:f.patientId,appliance:"fixed_metal",arches:"both",slot:"022",bracketSystem:null,startDate:"2026-10-01",plannedMonths:18,planId:null,note:null,createdBy:"synthetic-signer"});
 if(!created.ok)throw new Error(created.message);const before=await snapshot();
 const response=await POST(new Request(`https://synthetic.invalid/api/visits/${f.visitId}/clinical`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"sign",orthoSession:{caseId:created.id,nextWeeks,done:"Synthetic session"}})}),{params:Promise.resolve({id:String(f.visitId)})});
 console.info("Synthetic clinical interval",{nextWeeks,status:response.status,stored:await q("SELECT next_weeks FROM ortho_adjustments WHERE case_id=$1",[created.id])});
 expect(response.status).toBe(400);expect(await snapshot()).toEqual(before);
});
async function orthoFixture(){
 const f=await fixture();const created=await db.createOrthoCase({patientId:f.patientId,appliance:"fixed_metal",arches:"both",slot:"022",bracketSystem:null,startDate:"2026-10-01",plannedMonths:18,planId:null,note:null,createdBy:"synthetic-signer"});
 if(!created.ok)throw new Error(created.message);
 const send=(orthoSession:unknown)=>POST(new Request(`https://synthetic.invalid/api/visits/${f.visitId}/clinical`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"sign",orthoSession})}),{params:Promise.resolve({id:String(f.visitId)})});
 return {...f,caseId:created.id,send};
}
it.each([undefined,null,1,52," 04 "])("signs supported clinical interval %j once, then returns existing signed refusal",async nextWeeks=>{
 const f=await orthoFixture(),body={caseId:f.caseId,nextWeeks,done:"Synthetic session"};const response=await f.send(body);
 expect(response.status,JSON.stringify(await response.json())).toBe(200);
 expect(await q("SELECT next_weeks FROM ortho_adjustments WHERE case_id=$1",[f.caseId])).toEqual([{next_weeks:nextWeeks==null?4:Number(nextWeeks)}]);
 const before=await snapshot();expect((await f.send(body)).status).toBe(409);expect(await snapshot()).toEqual(before);
});
it.each(["",false,{},"1.00000000000000001","1.0","1e0"])("rejects malformed HTTP interval %j before signing effects",async nextWeeks=>{
 const f=await orthoFixture(),before=await snapshot();expect((await f.send({caseId:f.caseId,nextWeeks})).status).toBe(400);expect(await snapshot()).toEqual(before);
});
it.each([undefined,null])("signs previously recorded integer session without resubmission (%j)",async absence=>{
 const f=await orthoFixture();
 // Legacy normalization already persisted this integer. No original raw fraction is invented.
 const stored=await db.recordAdjustment({caseId:f.caseId,visitId:f.visitId,doneOn:"2026-10-02",phase:null,upperWire:null,lowerWire:null,elastics:"none",elasticNote:null,done:"Previously recorded",nextWeeks:2,note:null,recordedBy:"synthetic-signer",actorRole:"admin"});expect(stored.ok).toBe(true);
 const clinicalBefore=await q("SELECT id,visit_id,done_on,next_weeks,done,recorded_by FROM ortho_adjustments WHERE case_id=$1",[f.caseId]);
 expect((await f.send(absence)).status).toBe(200);
 expect(await q("SELECT id,visit_id,done_on,next_weeks,done,recorded_by FROM ortho_adjustments WHERE case_id=$1",[f.caseId])).toEqual(clinicalBefore);
 const before=await snapshot();expect((await f.send(absence)).status).toBe(409);expect(await snapshot()).toEqual(before);
});
it("malformed retry of a signed visit is400 rather than409, with unchanged stored result",async()=>{
 const f=await orthoFixture();expect((await f.send({caseId:f.caseId,nextWeeks:2})).status).toBe(200);const before=await snapshot();
 expect((await f.send({caseId:f.caseId,nextWeeks:1.5})).status).toBe(400);expect(await snapshot()).toEqual(before);
 expect((await f.send({caseId:f.caseId,nextWeeks:2})).status).toBe(409);expect(await snapshot()).toEqual(before);
});
