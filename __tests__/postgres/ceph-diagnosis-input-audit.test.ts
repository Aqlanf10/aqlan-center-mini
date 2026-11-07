import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: context.token }) }), headers: async () => new Headers() }));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_ceph_diagnosis_input_audit");
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const { PATCH } = await import("../../app/api/ceph/[id]/route");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let actorId: number, expiry: number, serial = 0;
beforeAll(async () => {
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-ceph-draft");
  [{ id: actorId }] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-ceph-draft','Synthetic ceph author',$1,'admin') RETURNING id", [hash]);
  expiry = Date.now() + 3_600_000;
  context.token = auth.createSessionToken({ userId: actorId, username: "synthetic-ceph-draft", role: "admin", expiresAt: expiry, credentialVersion: auth.sessionCredentialVersion(hash) });
});
afterAll(async () => { await db.resetPoolForTesting(); });
const commands = {
  calibration: { calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, expectedCalibration: { calibration: null, mmPerPixel: null } },
  landmarks: { landmarks: [{ code: "S", x: 20, y: 30, source: "manual" }], expectedLandmarks: [] },
  diagnosis: { diagnosis: { finalDx: "Synthetic reviewed documentary text" }, expectedDiagnosis: null },
};
async function fixture() {
  const [{ id: patientId }] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic ceph patient') RETURNING id", [`CEPH-AUTH-${++serial}`]);
  const [{ id: documentId }] = await q(`INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
    VALUES($1,'imaging','Synthetic image','image/jpeg',123,$2,$3,'synthetic-ceph-draft') RETURNING id`, [patientId, "a".repeat(64), `synthetic/no-file-${serial}.jpg`]);
  const created = await db.createCephAnalysis({ patientId, documentId, createdBy: "synthetic-ceph-draft" });
  if (!created.ok) throw new Error(created.message);
  const send = (kind: keyof typeof commands) => PATCH(new Request(`https://synthetic.invalid/api/ceph/${created.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(commands[kind]) }), { params: Promise.resolve({ id: String(created.id) }) });
  return { patientId, documentId, id: created.id, send };
}
describe("diagnosis input must not silently erase or truncate authored content",()=>{
 it.each([123,{text:"not a string"}])("rejects malformed optional text %j without replacing saved diagnosis",async value=>{
  const f=await fixture();
  const old={skeletal:"Preserve this authored skeletal finding",dental:null,softTissue:null,note:null,finalDx:"Saved conclusion"};
  const send=(diagnosis:unknown,expectedDiagnosis:unknown)=>PATCH(new Request(`https://synthetic.invalid/api/ceph/${f.id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({diagnosis,expectedDiagnosis})}),{params:Promise.resolve({id:String(f.id)})});
  expect((await send(old,null)).status).toBe(200);
  const audits=await q("SELECT * FROM audit_log ORDER BY id");
  const response=await send({...old,skeletal:value},old);
  expect(await q("SELECT * FROM audit_log ORDER BY id")).toEqual(audits);
  const stored=(await q("SELECT skeletal FROM ceph_diagnoses WHERE analysis_id=$1",[f.id]))[0];
  expect({status:response.status,skeletal:stored.skeletal}).toEqual({status:400,skeletal:old.skeletal});
 });
 it("rejects oversized conclusion rather than acknowledging its truncated prefix",async()=>{
  const f=await fixture();
  const audits=await q("SELECT * FROM audit_log ORDER BY id");
  const response=await PATCH(new Request(`https://synthetic.invalid/api/ceph/${f.id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({diagnosis:{finalDx:"x".repeat(2000)+"DO NOT OMIT"},expectedDiagnosis:null})}),{params:Promise.resolve({id:String(f.id)})});
  expect(await q("SELECT * FROM audit_log ORDER BY id")).toEqual(audits);
  const rows=await q("SELECT final_dx FROM ceph_diagnoses WHERE analysis_id=$1",[f.id]);
  expect({status:response.status,savedLength:rows[0]?.final_dx.length??null}).toEqual({status:400,savedLength:null});
 });
});

it("preserves optional missing/null/blank compatibility and exact 2000-character boundary",async()=>{
 const f=await fixture();
 const send=(diagnosis:unknown,expectedDiagnosis:unknown)=>PATCH(new Request(`https://synthetic.invalid/api/ceph/${f.id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({diagnosis,expectedDiagnosis})}),{params:Promise.resolve({id:String(f.id)})});
 let response=await send({finalDx:"  "+"a".repeat(2000)+"  ",note:"  ",dental:null},null);
 expect(response.status).toBe(200);
 const saved=(await response.json()).diagnosis;
 expect(saved).toEqual({skeletal:null,dental:null,softTissue:null,note:null,finalDx:"a".repeat(2000)});
 response=await send({finalDx:"new",skeletal:" b ",note:""},saved);
 expect(response.status).toBe(200);
 expect((await response.json()).diagnosis).toEqual({skeletal:"b",dental:null,softTissue:null,note:null,finalDx:"new"});
 expect((await send({finalDx:"stale"},saved)).status).toBe(409);
});
it("refuses direct authenticated wrapper invalid input before effects",async()=>{
 const f=await fixture(), request={patientId:f.patientId,documentId:f.documentId,session:auth.readSessionToken(context.token)!};
 const before=await q("SELECT * FROM audit_log ORDER BY id");
 for(const input of [{finalDx:"new",note:123},{finalDx:"x".repeat(2001)}]) expect(()=>db.updateAuthorizedCephDiagnosis(f.id,input as never,null,request)).toThrow();
 expect(await q("SELECT * FROM ceph_diagnoses WHERE analysis_id=$1",[f.id])).toEqual([]);
 expect(await q("SELECT * FROM audit_log ORDER BY id")).toEqual(before);
});
