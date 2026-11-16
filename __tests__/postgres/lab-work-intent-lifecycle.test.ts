import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { assertRealPostgresUrl,stubPostgresEnv } from "./_setup";
import { sessionCredentialVersion,type SessionPayload } from "../../lib/auth";
import type { LabWorkDraft,LabWorkSourceRow } from "../../lib/lab-work-intent-contract";
assertRealPostgresUrl();stubPostgresEnv();process.env.SESSION_SECRET="synthetic-lab-work-intent-test-secret-only";
const db=await import("../../lib/db");
const lab=await import("../../lib/lab-work-intent-db");
const {settleRejectedClinicalLabCommand}=await import("../../lib/clinical-lab-command-settlement");
let isolated: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
const originalDatabaseUrl=process.env.DATABASE_URL;
const q=async(sql:string,values:unknown[]=[]) => (await db.getPool().query(sql,values)).rows;
let actor:SessionPayload,patientId:number,serviceId:number,doctorId:number,serial=0;
beforeAll(async()=>{
 isolated=await openBackupTimestampFixture({...process.env});
 process.env.DATABASE_URL=isolated.source.options.connectionString!;
 await db.resetPoolForTesting();await db.ensureSchema();
 expect(await lab.labWorkIntentSupported(db.getPool())).toBe(true);
 const suffix=Date.now(),username=`synthetic-lab-intent-${suffix}`;
 const user=(await q("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic lab intent','synthetic-hash','admin') RETURNING id",[username]))[0];
 actor={userId:user.id,username,role:"admin",expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion("synthetic-hash")};
 patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic lab intent patient') RETURNING id",[`INTENT-${suffix}`]))[0].id;
 serviceId=(await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES($1,'crown',1000,TRUE,TRUE) RETURNING id",[`Synthetic crown ${suffix}`]))[0].id;
 doctorId=(await q("INSERT INTO parties(name,kind) VALUES('Synthetic lab intent doctor','doctor') RETURNING id"))[0].id;
},180_000);
afterAll(async()=>{
 try{await db.resetPoolForTesting();}finally{
  if(originalDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=originalDatabaseUrl;
  await isolated?.close();
 }
},60_000);
const work=():LabWorkDraft=>({intentId:randomUUID(),memberId:randomUUID(),expectedRevision:0,groupKind:"single",prescription:{partyId:null,shade:"",stumpShade:"",toothNumbers:"",dueDate:"2026-11-01",impressionType:"physical",priority:"normal"}});
const source=(labWork:LabWorkDraft):LabWorkSourceRow=>({serviceId,toothCode:27,quantity:1,planItemId:null,doctorId,category:"crown",labWork});
const ownedVisitIds:number[]=[];
async function visit(){
 if(ownedVisitIds.length)await q("UPDATE visits SET status='done',finished_at=COALESCE(finished_at,NOW()) WHERE patient_id=$1 AND id=ANY($2::int[]) AND status IN ('waiting','called','in_chair')",[patientId,ownedVisitIds]);
 const id=(await db.addVisit({patientId,patientName:"Synthetic lab intent patient",patientPhone:null,note:null})).id;ownedVisitIds.push(id);return id;
}
async function tx<T>(fn:(client:import("../../lib/db").DbClient)=>Promise<T>){const c=await db.getPool().connect();try{await c.query("BEGIN");await c.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[patientId]);const r=await fn(c);await c.query("COMMIT");return r;}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}
async function save(visitId:number,draft:LabWorkDraft,requestKey=`lab-intent-save-${++serial}`,retirements:unknown=[]){
 return tx(async c=>{
  const context={patientId,visitId,sourceKind:"visit" as const,sourceId:visitId,session:actor,requestKey,requestHash:JSON.stringify({draft,retirements})};
  const result=await lab.prepareVisitLabWorkInTransaction(c,{...context,rows:[source(draft)],retirements});
  if(result.replayed)return result;
  await c.query("DELETE FROM visit_procedures WHERE visit_id=$1",[visitId]);
  await c.query(`INSERT INTO visit_procedures(visit_id,service_id,doctor_id,tooth_code,quantity,lab_work_intent_id,lab_work_member_id) VALUES($1,$2,$3,27,1,$4,$5)`,[visitId,serviceId,doctorId,draft.intentId,draft.memberId]);
  await lab.recordVisitLabWorkCommandInTransaction(c,context,result.revisions);return result;
 });
}
async function materialize(visitId:number){return tx(async c=>{
 const rows=await c.query<{id:string}>("SELECT id FROM visit_procedures WHERE visit_id=$1",[visitId]);
 const loaded=await lab.readLabWorkForVisitProcedures(c,patientId,visitId);
 const procedureId=Number(rows.rows[0].id),draft=loaded.get(procedureId)!.labWork;
 const result=await lab.materializeVisitLabWorkInTransaction(c,{patientId,visitId,invoiceId:null,session:actor,rows:[{...source(draft),procedureId}]});
 // First materialization signs this fresh synthetic visit. Replay never rewrites its immutable signature.
 await c.query("UPDATE visits SET signed_at=NOW() WHERE id=$1 AND signed_at IS NULL",[visitId]);return result;
});}
describe("explicit lab intent lifecycle on PostgreSQL",()=>{
 it("registers 0074 with actual identity constraints, not only its marker",async()=>{
  expect(await lab.labWorkIntentSupported(db.getPool())).toBe(true);
  const index=(await q("SELECT pg_get_indexdef('lab_orders_visit_tooth_uniq'::regclass) AS definition"))[0].definition;
  expect(index).toContain("lab_work_intent_id IS NULL");
  const ownership=(await q("SELECT pg_get_functiondef('aqlan_lab_intent_patient()'::regprocedure) AS definition"))[0].definition;
  expect(ownership).toContain("order_intent IS DISTINCT FROM NEW.id");
  expect(ownership).toContain("SELECT patient_id,lab_work_intent_id INTO expected_patient,order_intent");
 });
 it("save reload replacement preserves UUID while disposable procedure ID changes",async()=>{
  const v=await visit(),draft=work();const first=await save(v,draft);
  const before=(await q("SELECT id FROM visit_procedures WHERE visit_id=$1",[v]))[0].id;
  const loaded=await lab.readLabWorkForVisitProcedures(db.getPool(),patientId,v);
  expect(loaded.get(Number(before))?.labWork).toMatchObject({intentId:draft.intentId,memberId:draft.memberId,expectedRevision:1});
  await save(v,{...draft,expectedRevision:first.revisions[0].revision});
  const after=(await q("SELECT id FROM visit_procedures WHERE visit_id=$1",[v]))[0].id;
  expect(after).not.toBe(before);
  expect((await lab.readLabWorkForVisitProcedures(db.getPool(),patientId,v)).get(Number(after))?.labWork.memberId).toBe(draft.memberId);
 });
 it("same-key lost-response replay returns saved result before stale revision rejection",async()=>{
  const v=await visit(),draft=work(),key=`lab-replay-${++serial}`;
  const first=await save(v,draft,key);const second=await save(v,draft,key);
  expect(second.replayed).toBe(true);expect(second.revisions).toEqual(first.revisions);
  await expect(save(v,{...draft,prescription:{...draft.prescription,shade:"A2"}},key)).rejects.toMatchObject({code:"idempotency_conflict"});
 });
 it("materializes one pending order with exact signed member link and no payable",async()=>{
  const v=await visit(),draft=work();await save(v,draft);const first=await materialize(v);
  const signedAt=(await q("SELECT signed_at::text AS signature FROM visits WHERE id=$1",[v]))[0].signature;
  const second=await materialize(v);expect(first.createdCount).toBe(1);expect(second.createdCount).toBe(0);
  expect((await q("SELECT signed_at::text AS signature FROM visits WHERE id=$1",[v]))[0].signature).toBe(signedAt);
  expect(second.labWork[0].orderId).toBe(first.labWork[0].orderId);
  const order=await db.getLabOrderById(first.labWork[0].orderId!);expect(order).toMatchObject({status:"needed",patientId,doctorId,costMinor:null,payableId:null});
  expect((await q("SELECT * FROM lab_prescription_source_memberships WHERE intent_id=$1",[draft.intentId]))).toHaveLength(1);
 });
 it("stripped identity or stale second-tab save cannot delete a draft member",async()=>{
  const v=await visit(),draft=work();await save(v,draft);
  await expect(save(v,draft)).rejects.toMatchObject({code:"stale_intent"});
  await expect(tx(c=>lab.prepareVisitLabWorkInTransaction(c,{patientId,visitId:v,session:actor,requestKey:`lab-strip-${++serial}`,requestHash:"stripped",rows:[{...source(draft),labWork:undefined}]}))).rejects.toMatchObject({code:"stripped_lab_identity"});
  expect((await q("SELECT id FROM visit_procedures WHERE visit_id=$1",[v]))).toHaveLength(1);
 });
 it("transaction rollback leaves no durable intent or member",async()=>{
  const v=await visit(),draft=work();await expect(tx(async c=>{await lab.prepareVisitLabWorkInTransaction(c,{patientId,visitId:v,session:actor,requestKey:`lab-rollback-${++serial}`,requestHash:"rollback",rows:[source(draft)]});throw Error("synthetic source rollback");})).rejects.toThrow("synthetic source rollback");
  expect(await q("SELECT id FROM lab_work_intents WHERE id=$1",[draft.intentId])).toHaveLength(0);
 });
 it("actual source writer reloads, signs, and replays the sealed save after sign",async()=>{
  const v=await visit(),draft=work();
  await q("UPDATE visits SET diagnosis='Synthetic source lifecycle',doctor_id=$2 WHERE id=$1",[v,doctorId]);
  const procedures=[{...source(draft),labWork:draft,surfaces:null,unitPriceMinor:1000,note:null}];
  const input={visitId:v,procedures,labCommand:{expectedPatientId:patientId,session:actor,requestKey:`actual-save-${++serial}`,requestHash:JSON.stringify(procedures)}};
  expect(await db.setVisitProcedures(input)).toBe(true);
  const loaded=await db.getClinicalVisit(v);
  expect(loaded?.procedures[0].labWork).toMatchObject({intentId:draft.intentId,memberId:draft.memberId,expectedRevision:1});
  await expect(db.setVisitProcedures({...input,labCommand:undefined})).rejects.toMatchObject({code:"command_required"});
  await expect(db.setVisitProcedures({visitId:v,procedures:procedures.map(p=>({...p,labWork:undefined}))})).rejects.toMatchObject({code:"identity_required"});
  const signed=await db.signClinicalVisit({visitId:v,baseCurrency:"YER",signedBy:actor.username,signerRole:"admin",session:actor,labSignVersion:(await db.getClinicalVisit(v))?.labSignVersion});
  expect(signed.invoiceId).not.toBeNull();
  const after=await db.getClinicalVisit(v);
  expect(after?.procedures[0].labWorkOrderId).toBeTypeOf("number");
  expect(await db.setVisitProcedures(input)).toBe(true);
  expect(await q("SELECT id FROM lab_orders WHERE lab_work_intent_id=$1",[draft.intentId])).toHaveLength(1);
  expect(await q("SELECT id FROM lab_prescription_source_memberships WHERE intent_id=$1 AND invoice_item_id IS NOT NULL",[draft.intentId])).toHaveLength(1);
  await expect(db.setVisitProcedures({...input,labCommand:{...input.labCommand,requestHash:"changed body"}})).rejects.toMatchObject({code:"idempotency_conflict"});
 });
 it("actual source writer protects draft deletion and stripped null identity",async()=>{
  const v=await visit(),draft=work();
  const procedures=[{...source(draft),labWork:draft,surfaces:null,unitPriceMinor:1000,note:null}];
  await db.setVisitProcedures({visitId:v,procedures,labCommand:{expectedPatientId:patientId,session:actor,requestKey:`actual-guard-${++serial}`,requestHash:"guard"}});
  expect(await db.deleteVisit(v,{actor:actor.username,actorRole:"admin"})).toMatchObject({ok:false,reason:"lab_linked"});
  await expect(db.setVisitProcedures({visitId:v,procedures:procedures.map(p=>({...p,labWork:null})),labCommand:{expectedPatientId:patientId,session:actor,requestKey:`actual-strip-${++serial}`,requestHash:"null"}})).rejects.toMatchObject({code:"stripped_lab_identity"});
  expect(await q("SELECT id FROM visit_procedures WHERE visit_id=$1",[v])).toHaveLength(1);
 });
 it("two explicit independent same-tooth intents create distinct orders without dropping provenance",async()=>{
  const v=await visit(),drafts=[work(),work()];
  await q("UPDATE visits SET diagnosis='Synthetic independent crowns',doctor_id=$2 WHERE id=$1",[v,doctorId]);
  const procedures=drafts.map(draft=>({...source(draft),labWork:draft,surfaces:null,unitPriceMinor:1000,note:null}));
  await db.setVisitProcedures({visitId:v,procedures,labCommand:{expectedPatientId:patientId,session:actor,requestKey:`same-tooth-${++serial}`,requestHash:JSON.stringify(procedures)}});
  await db.signClinicalVisit({visitId:v,baseCurrency:"YER",signedBy:actor.username,signerRole:"admin",session:actor,labSignVersion:(await db.getClinicalVisit(v))?.labSignVersion});
  const orders=await q("SELECT id,visit_id,tooth_code,lab_work_intent_id FROM lab_orders WHERE visit_id=$1",[v]);
  expect(orders).toHaveLength(2);expect(new Set(orders.map(o=>o.lab_work_intent_id)).size).toBe(2);
  expect(orders.every(o=>o.visit_id===v&&o.tooth_code===27)).toBe(true);
 });
 it("legacy same-visit/tooth uniqueness remains enforced",async()=>{
  const v=await visit();
  const sql="INSERT INTO lab_orders(patient_id,lab_name,work_type,sent_date,due_date,status,visit_id,tooth_code,source) VALUES($1,'Synthetic legacy','تاج',CURRENT_DATE,CURRENT_DATE,'needed',$2,27,'auto')";
  await q(sql,[patientId,v]);await expect(q(sql,[patientId,v])).rejects.toMatchObject({code:"23505"});
 });
 it("cancelled initial order cannot be recreated by a new materialization request",async()=>{
  const v=await visit(),draft=work();await save(v,draft);const first=await materialize(v);
  await q("UPDATE lab_orders SET status='cancelled' WHERE id=$1",[first.labWork[0].orderId]);
  await expect(materialize(v)).rejects.toMatchObject({code:"cancelled_order"});
  expect(await q("SELECT id FROM lab_orders WHERE lab_work_intent_id=$1",[draft.intentId])).toHaveLength(1);
 });

 it("concurrent same-key creation serializes to one identity and receipt",async()=>{
  const v=await visit(),draft=work(),key=`concurrent-${++serial}`;
  const results=await Promise.all([save(v,draft,key),save(v,draft,key)]);
  expect(results.filter(r=>r.replayed)).toHaveLength(1);
  expect(await q("SELECT id FROM lab_work_intents WHERE id=$1",[draft.intentId])).toHaveLength(1);
  expect(await q("SELECT request_key FROM lab_work_commands WHERE actor_user_id=$1 AND request_key=$2",[actor.userId,key])).toHaveLength(1);
 });
 it("a durable member cannot be attached to a second intent",async()=>{
  const firstVisit=await visit(),secondVisit=await visit(),draft=work();await save(firstVisit,draft);
  await expect(save(secondVisit,{...work(),memberId:draft.memberId})).rejects.toMatchObject({code:"member_identity_conflict"});
  expect(await q("SELECT id FROM lab_work_members WHERE id=$1",[draft.memberId])).toHaveLength(1);
 });

 it("terminal rejection wins and prevents a later actual writer apply",async()=>{
  const v=await visit(),draft=work(),requestKey=`reject-first-${++serial}`,requestHash="sealed rejected source";
  const context={expectedPatientId:patientId,patientId,visitId:v,session:actor,requestKey,requestHash,code:"stale_intent"};
  expect(await settleRejectedClinicalLabCommand(context)).toEqual({outcome:"rejected",code:"stale_intent"});
  await expect(db.setVisitProcedures({visitId:v,procedures:[{...source(draft),labWork:draft,surfaces:null,unitPriceMinor:1000,note:null}],labCommand:context})).rejects.toMatchObject({code:"stale_intent"});
  expect(await q("SELECT id FROM lab_work_intents WHERE id=$1",[draft.intentId])).toHaveLength(0);
  await expect(settleRejectedClinicalLabCommand({...context,requestHash:"different payload"})).rejects.toMatchObject({code:"idempotency_conflict"});
 });
 it("applied source wins over later terminal settlement without changing receipt",async()=>{
  const v=await visit(),draft=work(),requestKey=`apply-first-${++serial}`,requestHash="sealed applied source";
  const context={expectedPatientId:patientId,patientId,visitId:v,session:actor,requestKey,requestHash,code:"stale_intent"};
  await db.setVisitProcedures({visitId:v,procedures:[{...source(draft),labWork:draft,surfaces:null,unitPriceMinor:1000,note:null}],labCommand:context});
  expect(await settleRejectedClinicalLabCommand(context)).toMatchObject({outcome:"applied",labWork:[{intentId:draft.intentId}]});
  expect(await q("SELECT request_key FROM lab_work_commands WHERE actor_user_id=$1 AND request_key=$2",[actor.userId,requestKey])).toHaveLength(1);
 });
 it("concurrent apply and rejection have one immutable outcome",async()=>{
  const v=await visit(),draft=work(),requestKey=`apply-reject-race-${++serial}`,requestHash="sealed concurrent source";
  const context={expectedPatientId:patientId,patientId,visitId:v,session:actor,requestKey,requestHash,code:"stale_intent"};
  await Promise.allSettled([
   db.setVisitProcedures({visitId:v,procedures:[{...source(draft),labWork:draft,surfaces:null,unitPriceMinor:1000,note:null}],labCommand:context}),
   settleRejectedClinicalLabCommand(context),
  ]);
  const rows=await q("SELECT result FROM lab_work_commands WHERE actor_user_id=$1 AND request_key=$2",[actor.userId,requestKey]);
  expect(rows).toHaveLength(1);expect(["applied","rejected"]).toContain(rows[0].result.outcome);
  expect(await settleRejectedClinicalLabCommand(context)).toEqual(rows[0].result);
  expect(await q("SELECT id FROM lab_work_intents WHERE id=$1",[draft.intentId])).toHaveLength(rows[0].result.outcome==="applied"?1:0);
 });

 it("explicit three-unit bridge materializes one order preserving all declared roles",async()=>{
  const v=await visit(),base=work(),bridgeId=(await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES('Synthetic explicit bridge','bridge',1000,TRUE,TRUE) RETURNING id"))[0].id;
  await q("UPDATE visits SET diagnosis='Synthetic bridge',doctor_id=$2 WHERE id=$1",[v,doctorId]);
  const prescription={...base.prescription,toothNumbers:"26(Abutment), 27(Pontic), 28(Abutment)"};
  const procedures=[26,27,28].map(toothCode=>({...source(base),serviceId:bridgeId,toothCode,surfaces:null,unitPriceMinor:1000,note:null,labWork:{...base,memberId:randomUUID(),groupKind:"bridge" as const,prescription}}));
  await db.setVisitProcedures({visitId:v,procedures,labCommand:{expectedPatientId:patientId,session:actor,requestKey:`bridge-${++serial}`,requestHash:JSON.stringify(procedures)}});
  await db.signClinicalVisit({visitId:v,baseCurrency:"YER",signedBy:actor.username,signerRole:"admin",session:actor,labSignVersion:(await db.getClinicalVisit(v))?.labSignVersion});
  const orders=await q("SELECT tooth_numbers FROM lab_orders WHERE lab_work_intent_id=$1",[base.intentId]);
  expect(orders).toHaveLength(1);expect(orders[0].tooth_numbers).toBe(prescription.toothNumbers);
  expect(await q("SELECT id FROM lab_work_members WHERE intent_id=$1",[base.intentId])).toHaveLength(3);
 });
 it("late source pricing refusal rolls back newly prepared intent and source rows",async()=>{
  const v=await visit(),draft=work();
  await expect(db.setVisitProcedures({visitId:v,procedures:[{...source(draft),labWork:draft,surfaces:null,unitPriceMinor:0,note:null}],authority:{role:"doctor",maxDiscountPercent:0},labCommand:{expectedPatientId:patientId,session:actor,requestKey:`late-rollback-${++serial}`,requestHash:"invalid pricing"}})).rejects.toThrow();
  expect(await q("SELECT id FROM lab_work_intents WHERE id=$1",[draft.intentId])).toHaveLength(0);
  expect(await q("SELECT id FROM visit_procedures WHERE visit_id=$1",[v])).toHaveLength(0);
 });
 it("revoked session and inactive provider cannot persist lab intent",async()=>{
  const v=await visit(),draft=work(),context={patientId,visitId:v,session:{...actor,credentialVersion:"revoked"},requestKey:`revoked-${++serial}`,requestHash:"revoked",rows:[source(draft)]};
  await expect(tx(c=>lab.prepareVisitLabWorkInTransaction(c,context))).rejects.toMatchObject({status:403});
  const partyId=(await q("INSERT INTO parties(name,kind,is_active) VALUES('Synthetic inactive lab','lab',FALSE) RETURNING id"))[0].id;
  await expect(save(v,{...draft,prescription:{...draft.prescription,partyId}})).rejects.toMatchObject({code:"inactive_lab"});
  expect(await q("SELECT id FROM lab_work_intents WHERE id=$1",[draft.intentId])).toHaveLength(0);
 });

 it("unassigned doctor cannot create work on another patient's visit",async()=>{
  const v=await visit(),draft=work(),username=`synthetic-unassigned-${Date.now()}-${++serial}`;
  const foreignDoctor=(await q("INSERT INTO parties(name,kind) VALUES('Synthetic unassigned doctor','doctor') RETURNING id"))[0].id;
  const user=(await q("INSERT INTO users(username,display_name,password_hash,role,party_id) VALUES($1,'Synthetic unassigned','synthetic-hash','doctor',$2) RETURNING id",[username,foreignDoctor]))[0];
  const session:SessionPayload={...actor,userId:user.id,username,role:"doctor"};
  await expect(tx(c=>lab.prepareVisitLabWorkInTransaction(c,{patientId,visitId:v,session,requestKey:`foreign-doctor-${++serial}`,requestHash:"foreign doctor",rows:[source(draft)]}))).rejects.toMatchObject({status:403});
  expect(await q("SELECT id FROM lab_work_intents WHERE id=$1",[draft.intentId])).toHaveLength(0);
 });

 it("partial bridge draft retains all source teeth with neutral roles in the order",async()=>{
  const v=await visit(),base=work(),bridgeId=(await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES('Synthetic neutral bridge','bridge',1000,TRUE,TRUE) RETURNING id"))[0].id;
  await q("UPDATE visits SET diagnosis='Synthetic neutral bridge',doctor_id=$2 WHERE id=$1",[v,doctorId]);
  const procedures=[26,27,28].map(toothCode=>({...source(base),serviceId:bridgeId,toothCode,surfaces:null,unitPriceMinor:1000,note:null,labWork:{...base,memberId:randomUUID(),groupKind:"bridge" as const}}));
  await db.setVisitProcedures({visitId:v,procedures,labCommand:{expectedPatientId:patientId,session:actor,requestKey:`neutral-bridge-${++serial}`,requestHash:JSON.stringify(procedures)}});
  await db.signClinicalVisit({visitId:v,baseCurrency:"YER",signedBy:actor.username,signerRole:"admin",session:actor,labSignVersion:(await db.getClinicalVisit(v))?.labSignVersion});
  const orders=await q("SELECT tooth_numbers FROM lab_orders WHERE lab_work_intent_id=$1",[base.intentId]);
  expect(orders).toHaveLength(1);expect(orders[0].tooth_numbers).toBe("26, 27, 28");
  expect((await q("SELECT prescription FROM lab_work_intents WHERE id=$1",[base.intentId]))[0].prescription.toothNumbers).toBe("");
  const {completeLabPrescription}=await import("../../lib/lab-prescription-write");
  const {labPrescriptionVersion}=await import("../../lib/lab-prescription-input");
  const id=(await q("SELECT id FROM lab_orders WHERE lab_work_intent_id=$1",[base.intentId]))[0].id;
  const before=(await db.getLabOrderById(id))!;
  for(const toothNumbers of ["26(Abutment), 27(Pontic)","26(Abutment), 27(Pontic), 28(Abutment), 25(Abutment)"]){
    await expect(completeLabPrescription(id,{...base.prescription,toothNumbers},labPrescriptionVersion(before),false,actor)).rejects.toMatchObject({status:409});
  }
  await completeLabPrescription(id,base.prescription,labPrescriptionVersion(before),false,actor);
  const neutral=(await db.getLabOrderById(id))!;expect(neutral.toothNumbers).toBe("26, 27, 28");
  const toothNumbers="26(Abutment), 27(Pontic), 28(Abutment)";
  await completeLabPrescription(id,{...base.prescription,toothNumbers},labPrescriptionVersion(neutral),false,actor);
  const complete=(await db.getLabOrderById(id))!;
  expect(complete).toMatchObject({toothNumbers,status:"needed",costMinor:before.costMinor,payableId:before.payableId});

 });

 it("source save winning before sign invalidates old reviewed token, and missing token refuses",async()=>{
  const v=await visit(),draft=work();await q("UPDATE visits SET diagnosis='Synthetic signature race',doctor_id=$2 WHERE id=$1",[v,doctorId]);
  const procedures=[{...source(draft),labWork:draft,surfaces:null,unitPriceMinor:1000,note:null}];
  await db.setVisitProcedures({visitId:v,procedures,labCommand:{expectedPatientId:patientId,session:actor,requestKey:`review-first-${++serial}`,requestHash:"review first"}});
  const reviewed=(await db.getClinicalVisit(v))!;
  const next={...draft,expectedRevision:1,prescription:{...draft.prescription,shade:"A2"}};
  await db.setVisitProcedures({visitId:v,procedures:[{...procedures[0],labWork:next}],labCommand:{expectedPatientId:patientId,session:actor,requestKey:`review-second-${++serial}`,requestHash:"review changed"}});
  const sign={visitId:v,baseCurrency:"YER" as const,signedBy:actor.username,signerRole:"admin",session:actor};
  await expect(db.signClinicalVisit({...sign,labSignVersion:reviewed.labSignVersion})).rejects.toMatchObject({code:"stale_lab_sign_review"});
  await expect(db.signClinicalVisit(sign)).rejects.toMatchObject({code:"stale_lab_sign_review"});
  expect((await db.getClinicalVisit(v))?.invoiceId).toBeNull();
 });
 it("sign winning before stale source save prevents any later draft alteration",async()=>{
  const v=await visit(),draft=work();await q("UPDATE visits SET diagnosis='Synthetic sign winner',doctor_id=$2 WHERE id=$1",[v,doctorId]);
  const procedures=[{...source(draft),labWork:draft,surfaces:null,unitPriceMinor:1000,note:null}];
  await db.setVisitProcedures({visitId:v,procedures,labCommand:{expectedPatientId:patientId,session:actor,requestKey:`sign-first-${++serial}`,requestHash:"sign first"}});
  const review=(await db.getClinicalVisit(v))!;
  await db.signClinicalVisit({visitId:v,baseCurrency:"YER",signedBy:actor.username,signerRole:"admin",session:actor,labSignVersion:review.labSignVersion});
  expect(await db.setVisitProcedures({visitId:v,procedures:[{...procedures[0],labWork:{...draft,expectedRevision:1,prescription:{...draft.prescription,shade:"A2"}}}],labCommand:{expectedPatientId:patientId,session:actor,requestKey:`late-after-sign-${++serial}`,requestHash:"late after sign"}})).toBe(false);
  const after=(await db.getClinicalVisit(v))!;expect(after.procedures[0].labWork?.prescription.shade).toBe("");
 });

 it("parallel sign and source save produce only a serializable reviewed outcome",async()=>{
  const v=await visit(),draft=work();await q("UPDATE visits SET diagnosis='Synthetic parallel sign',doctor_id=$2 WHERE id=$1",[v,doctorId]);
  const procedures=[{...source(draft),labWork:draft,surfaces:null,unitPriceMinor:1000,note:null}];
  await db.setVisitProcedures({visitId:v,procedures,labCommand:{expectedPatientId:patientId,session:actor,requestKey:`parallel-init-${++serial}`,requestHash:"parallel initial"}});
  const review=(await db.getClinicalVisit(v))!;
  const [signResult,saveResult]=await Promise.allSettled([
    db.signClinicalVisit({visitId:v,baseCurrency:"YER",signedBy:actor.username,signerRole:"admin",session:actor,labSignVersion:review.labSignVersion}),
    db.setVisitProcedures({visitId:v,procedures:[{...procedures[0],labWork:{...draft,expectedRevision:1,prescription:{...draft.prescription,shade:"A2"}}}],labCommand:{expectedPatientId:patientId,session:actor,requestKey:`parallel-change-${++serial}`,requestHash:"parallel changed"}}),
  ]);
  const after=(await db.getClinicalVisit(v))!;
  if(signResult.status==="fulfilled"){
    expect(saveResult).toMatchObject({status:"fulfilled",value:false});
    expect(after.procedures[0].labWork?.prescription.shade).toBe("");expect(after.invoiceId).not.toBeNull();
  }else{
    expect(signResult.reason).toMatchObject({code:"stale_lab_sign_review"});
    expect(saveResult).toMatchObject({status:"fulfilled",value:true});
    expect(after.procedures[0].labWork?.prescription.shade).toBe("A2");expect(after.invoiceId).toBeNull();
  }
 },18000);

 it("a concurrent relink winning after the original-patient read refuses the stale source save",async()=>{
  const v=await visit(),draft=work();
  const other=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic relink winner') RETURNING id",[`LAB-RELINK-${randomUUID()}`]))[0].id;
  const barrier=await db.getPool().connect();let pending:Promise<PromiseSettledResult<boolean>>|undefined;
  try{
   await barrier.query("BEGIN");await barrier.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[patientId]);
   pending=db.setVisitProcedures({visitId:v,procedures:[{...source(draft),labWork:draft,surfaces:null,unitPriceMinor:1000,note:null}],labCommand:{expectedPatientId:patientId,session:actor,requestKey:`relink-race-${++serial}`,requestHash:"original patient source"}}).then(value=>({status:"fulfilled" as const,value}),reason=>({status:"rejected" as const,reason}));
   let waiting=false;const deadline=Date.now()+5000;
   while(Date.now()<deadline){waiting=(await isolated.source.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE%'")).rows.length>0;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}
   expect(waiting).toBe(true);expect(await db.linkVisitToPatient(v,other)).toMatchObject({ok:true});
   await barrier.query("COMMIT");expect(await pending).toMatchObject({status:"rejected"});
   expect((await q("SELECT patient_id FROM visits WHERE id=$1",[v]))[0].patient_id).toBe(other);
   expect(await q("SELECT id FROM lab_work_intents WHERE origin_visit_id=$1",[v])).toHaveLength(0);
   expect(await q("SELECT id FROM visit_procedures WHERE visit_id=$1",[v])).toHaveLength(0);
  }finally{await barrier.query("ROLLBACK").catch(()=>{});barrier.release();await pending;}
 },15_000);
 it("a stale lab command starting after relink cannot bind original-patient work to the new patient",async()=>{
  const v=await visit(),draft=work();
  const other=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic earlier relink') RETURNING id",[`LAB-EARLIER-RELINK-${randomUUID()}`]))[0].id;
  expect(await db.linkVisitToPatient(v,other)).toMatchObject({ok:true});
  await expect(db.setVisitProcedures({visitId:v,procedures:[{...source(draft),labWork:draft,surfaces:null,unitPriceMinor:1000,note:null}],labCommand:{expectedPatientId:patientId,session:actor,requestKey:`stale-after-relink-${++serial}`,requestHash:"original patient sealed before relink"}})).rejects.toThrow();
  expect((await q("SELECT patient_id FROM visits WHERE id=$1",[v]))[0].patient_id).toBe(other);
  expect(await q("SELECT id FROM lab_work_intents WHERE origin_visit_id=$1",[v])).toHaveLength(0);
  expect(await q("SELECT id FROM visit_procedures WHERE visit_id=$1",[v])).toHaveLength(0);
  expect(await q("SELECT request_key FROM lab_work_commands WHERE source_kind='visit' AND source_id=$1",[v])).toHaveLength(0);
 });
 it("durable source save prevents concurrent application relink during materialization",async()=>{
  const v=await visit(),draft=work();
  const other=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic rejected relink') RETURNING id",[`LAB-NORELINK-${randomUUID()}`]))[0].id;
  expect(await db.setVisitProcedures({visitId:v,procedures:[{...source(draft),labWork:draft,surfaces:null,unitPriceMinor:1000,note:null}],labCommand:{expectedPatientId:patientId,session:actor,requestKey:`no-relink-${++serial}`,requestHash:"durable original patient"}})).toBe(true);
  const [relinked,result]=await Promise.all([db.linkVisitToPatient(v,other),materialize(v)]);
  expect(relinked).toMatchObject({ok:false});expect(result.createdCount).toBe(1);
  expect((await q("SELECT patient_id FROM visits WHERE id=$1",[v]))[0].patient_id).toBe(patientId);
  expect(await q("SELECT id FROM lab_orders WHERE lab_work_intent_id=$1 AND patient_id=$2",[draft.intentId,patientId])).toHaveLength(1);
 });
 it("concurrent application cancellation and materialization replay never resurrect or duplicate work",async()=>{
  const v=await visit(),draft=work();await save(v,draft);const first=await materialize(v),orderId=first.labWork[0].orderId!;
  const [cancelled,replayed]=await Promise.allSettled([db.setLabOrderStatus(orderId,"cancelled",{session:actor}),materialize(v)]);
  expect(cancelled.status).toBe("fulfilled");
  if(replayed.status==="fulfilled"){expect(replayed.value.createdCount).toBe(0);expect(replayed.value.labWork[0].orderId).toBe(orderId);}
  else expect(replayed.reason).toMatchObject({code:"cancelled_order"});
  expect((await db.getLabOrderById(orderId))?.status).toBe("cancelled");
  await expect(materialize(v)).rejects.toMatchObject({code:"cancelled_order"});
  expect(await q("SELECT id FROM lab_orders WHERE lab_work_intent_id=$1",[draft.intentId])).toEqual([{id:orderId}]);
  expect(await q("SELECT id FROM payables WHERE lab_order_id=$1",[orderId])).toHaveLength(0);
 });

});
