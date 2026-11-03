import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { labPrescriptionVersion } from "../../lib/lab-prescription-input";
assertRealPostgresUrl();stubPostgresEnv();
process.env.SESSION_SECRET = "synthetic-lab-prescription-integration-secret";
const db=await import("../../lib/db");
const {completeLabPrescription}=await import("../../lib/lab-prescription-write");
let session:SessionPayload;
const q=async(sql:string,args:unknown[]=[]) => (await db.getPool().query(sql,args)).rows;
let patientId:number,labId:number,otherLab:number;
const input=()=>({partyId:labId,shade:"A2",stumpShade:"ND2",toothNumbers:"25(Abutment), 26(Pontic), 27(Abutment)",dueDate:"2026-11-01",impressionType:"digital_scan",priority:"urgent"});
beforeAll(async()=>{
 await db.ensureSchema();
 const suffix=Date.now();
 const user=(await q("INSERT INTO users(username,display_name,password_hash,role) VALUES ($1,'Synthetic lab editor','synthetic-lab-hash','admin') RETURNING id",[`lab-editor-${suffix}`]))[0];
 session={userId:user.id,username:`lab-editor-${suffix}`,role:"admin",expiresAt:Date.now()+3_600_000,credentialVersion:sessionCredentialVersion("synthetic-lab-hash")};
 patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES ($1,$2) RETURNING id",[`LAB-RX-${suffix}`,"Synthetic lab editor patient"]))[0].id;
 labId=(await db.createLaboratory({name:`Synthetic lab editor ${suffix}`})).id;
 otherLab=(await db.createLaboratory({name:`Synthetic other lab ${suffix}`})).id;
});
afterAll(async()=>{await db.resetPoolForTesting();});
async function pending(){
 const id=(await q(`INSERT INTO lab_orders(patient_id,lab_name,work_type,sent_date,due_date,status,tooth_code,source,note)
 VALUES ($1,'لم يحدد بعد','جسر',CURRENT_DATE,'2026-11-01','needed',27,'auto','Synthetic provenance') RETURNING id`,[patientId]))[0].id;
 const order=await db.getLabOrderById(id);if(!order)throw Error("missing synthetic order");return order;
}
async function footprint(id:number){
 return {rows:await q("SELECT id,patient_id,visit_id,tooth_code,source,note,doctor_id,cost_minor,cost_currency,exchange_rate,base_amount_minor,is_posted,payable_id,financial_status FROM lab_orders WHERE id=$1",[id]),payables:await q("SELECT * FROM payables WHERE lab_order_id=$1",[id])};
}
describe("same-order clinical lab completion on PostgreSQL",()=>{
 it("refuses a concurrent composed clinical table boundary without waiting",async()=>{
  const order=await pending(),client=await db.getPool().connect();
  try { await client.query("BEGIN");await client.query("LOCK TABLE lab_orders IN SHARE ROW EXCLUSIVE MODE");
   await expect(completeLabPrescription(order.id,input(),labPrescriptionVersion(order),false,session)).rejects.toMatchObject({status:409});
  } finally { await client.query("ROLLBACK");client.release(); }
  expect(await q("SELECT * FROM lab_order_tracking WHERE lab_order_id=$1",[order.id])).toHaveLength(0);
 });
 it("saves incomplete draft but never dispatches it, then retains the exact source tooth",async()=>{
  const order=await pending();
  const draft={...input(),partyId:null,shade:"",toothNumbers:""};
  await completeLabPrescription(order.id,draft,labPrescriptionVersion(order),false,session);
  expect((await db.getLabOrderById(order.id))?.status).toBe("needed");
  await expect(completeLabPrescription(order.id,draft,labPrescriptionVersion(order),true,session)).rejects.toThrow();
  await expect(completeLabPrescription(order.id,{...input(),toothNumbers:"18(Abutment)"},labPrescriptionVersion((await db.getLabOrderById(order.id))!),false,session)).rejects.toMatchObject({status:409});
  expect((await db.getLabOrderById(order.id))?.toothCode).toBe(27);
 });
 it("revalidates deactivated credentials inside the transaction",async()=>{
  const order=await pending();
  await q("UPDATE users SET is_active=FALSE WHERE id=$1",[session.userId]);
  try { await expect(completeLabPrescription(order.id,input(),labPrescriptionVersion(order),false,session)).rejects.toMatchObject({status:403}); }
  finally { await q("UPDATE users SET is_active=TRUE WHERE id=$1",[session.userId]); }
  expect(await q("SELECT * FROM lab_order_tracking WHERE lab_order_id=$1",[order.id])).toHaveLength(0);
 });
 it("permits an authorized clinician without inventing a plan-edit requirement",async()=>{
  const username=`lab-doctor-${Date.now()}`;
  const user=(await q(`INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES ($1,'Synthetic doctor','synthetic-doctor-hash','doctor',$2) RETURNING id`,[username,JSON.stringify({canViewAllPatients:true,canEditPlans:false})]))[0];
  const doctor:SessionPayload={userId:user.id,username,role:"doctor",expiresAt:Date.now()+3_600_000,credentialVersion:sessionCredentialVersion("synthetic-doctor-hash")};
  const order=await pending();
  await expect(completeLabPrescription(order.id,input(),labPrescriptionVersion(order),false,doctor)).resolves.toEqual({id:order.id,status:"needed"});
 });

 it("completes and edits the existing pending order without rewriting provenance or creating money",async()=>{
  const order=await pending(),before=await footprint(order.id);
  await completeLabPrescription(order.id,input(),labPrescriptionVersion(order),false,session);
  const saved=(await db.getLabOrderById(order.id))!;
  expect(saved).toMatchObject({id:order.id,status:"needed",partyId:labId,shade:"A2",toothCode:27,source:"auto"});
  expect(await footprint(order.id)).toEqual(before);
  await completeLabPrescription(order.id,{...input(),shade:"A3"},labPrescriptionVersion(saved),false,session);
  expect((await db.getLabOrderById(order.id))?.shade).toBe("A3");
  expect(await footprint(order.id)).toEqual(before);
 });
 it("concurrent dispatches record exactly one transition and create no payable",async()=>{
  const order=await pending(),before=await footprint(order.id);
  const attempts=await Promise.allSettled([1,2].map(()=>completeLabPrescription(order.id,input(),labPrescriptionVersion(order),true,session)));
  expect(attempts.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect(attempts.filter(r=>r.status==="rejected")).toHaveLength(1);
  expect((await db.getLabOrderById(order.id))?.status).toBe("sent");
  expect(await footprint(order.id)).toEqual(before);
  expect(await q("SELECT action,to_status FROM lab_order_tracking WHERE lab_order_id=$1",[order.id])).toEqual([{action:"prescription_completed",to_status:"sent"}]);
 });
 it("rejects stale save and inactive or non-lab party without side effects",async()=>{
  const order=await pending();
  await completeLabPrescription(order.id,input(),labPrescriptionVersion(order),false,session);
  await expect(completeLabPrescription(order.id,{...input(),shade:"A3"},labPrescriptionVersion(order),false,session)).rejects.toMatchObject({status:409});
  const fresh=(await db.getLabOrderById(order.id))!;
  await q("UPDATE parties SET is_active=FALSE WHERE id=$1",[otherLab]);
  await expect(completeLabPrescription(order.id,{...input(),partyId:otherLab},labPrescriptionVersion(fresh),false,session)).rejects.toMatchObject({status:409});
  expect((await db.getLabOrderById(order.id))?.shade).toBe("A2");
  expect((await q("SELECT * FROM lab_order_tracking WHERE lab_order_id=$1",[order.id]))).toHaveLength(1);
 });
 it("rejects accountant and unassigned doctor",async()=>{
  const order=await pending();
  for(const role of ["accountant","reception","assistant","doctor"] as const){
   await expect(completeLabPrescription(order.id,input(),labPrescriptionVersion(order),false,{...session,role})).rejects.toMatchObject({status:403});
  }
  expect((await db.getLabOrderById(order.id))?.status).toBe("needed");
  expect(await q("SELECT * FROM lab_order_tracking WHERE lab_order_id=$1",[order.id])).toHaveLength(0);
 });
});
