import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import {randomUUID} from "node:crypto";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {assertRealPostgresUrl,stubPostgresEnv} from "./_setup";
import {sessionCredentialVersion,type SessionPayload} from "../../lib/auth";
import type {LabWorkDraft,LabWorkSourceRow} from "../../lib/lab-work-intent-contract";
import {parseInvoiceCommand,invoiceCommandFingerprint,invoiceCatalogRequestFingerprint} from "../../lib/invoice-template";
import {DEFAULT_SPECIALTY_TEMPLATES} from "../../lib/specialty-templates";
assertRealPostgresUrl();stubPostgresEnv();process.env.SESSION_SECRET="synthetic-lab-invoice-intent-integration-test-secret-only";
const db=await import("../../lib/db"),lab=await import("../../lib/lab-work-intent-db");
const invoice=await import("../../lib/invoice-linkage-db"),revision=await import("../../lib/invoice-revision-db");
let isolated: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
const originalDatabaseUrl=process.env.DATABASE_URL;
const q=async(sql:string,values:unknown[]=[]) => (await db.getPool().query(sql,values)).rows;
let actor:SessionPayload,serviceId:number,doctorId:number,serial=0;
const prefix=`LABINV-${randomUUID()}`;
beforeAll(async()=>{
 isolated=await openBackupTimestampFixture({...process.env});
 process.env.DATABASE_URL=isolated.source.options.connectionString!;
 await db.resetPoolForTesting();await db.ensureSchema();
 expect(await lab.labWorkIntentSupported(db.getPool())).toBe(true);
 const username=`synthetic-lab-invoice-${randomUUID()}`;
 const user=(await q("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic lab invoice','synthetic-password-hash','admin') RETURNING id",[username]))[0];
 actor={userId:user.id,username,role:"admin",expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion("synthetic-password-hash")};
 doctorId=(await q("INSERT INTO parties(name,kind) VALUES('Synthetic invoice lab doctor','doctor') RETURNING id"))[0].id;
 serviceId=(await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES($1,'crown',1000,TRUE,TRUE) RETURNING id",[`Synthetic invoice crown ${prefix}`]))[0].id;
 if(!await db.getOpenShift())await db.openShift({openedBy:username,opening:{YER:0,SAR:0,USD:0}});
},180000);
afterAll(async()=>{
 try{await db.resetPoolForTesting();}finally{
  if(originalDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=originalDatabaseUrl;
  await isolated?.close();
 }
},60_000);
const draft=():LabWorkDraft=>({intentId:randomUUID(),memberId:randomUUID(),expectedRevision:0,groupKind:"single",prescription:{partyId:null,shade:"",stumpShade:"",toothNumbers:"",dueDate:"2026-11-01",impressionType:"physical",priority:"normal"}});
async function patient(){return (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic lab invoice patient') RETURNING id",[`${prefix}-${++serial}`]))[0].id as number;}
const row=(work:LabWorkDraft,planItemId:number|null):LabWorkSourceRow=>({serviceId,toothCode:27,quantity:1,planItemId,doctorId,category:"crown",labWork:work});
async function tx<T>(patientId:number,fn:(c:import("../../lib/db").DbClient)=>Promise<T>){const c=await db.getPool().connect();try{await c.query("BEGIN");await c.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[patientId]);const result=await fn(c);await c.query("COMMIT");return result;}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}
async function create(patientId:number,work:LabWorkDraft,planItemId?:number,sessions=1){
 const source={patientId,currency:"YER",idempotencyKey:`lab-invoice-${randomUUID()}`,items:[{serviceId,doctorId,quantity:1,price:"1000",sessions,toothCode:27,episodeTeeth:[27],...(planItemId?{planItemId}:{}),labWork:work}]};
 const parsed=parseInvoiceCommand(source,new Map((await db.listServices()).map(s=>[s.id,s])),new Set([doctorId]),await db.getSettings(),true);if(!parsed.ok)throw Error(parsed.message);
 const input={patientId,baseCurrency:parsed.baseCurrency,discountMinor:parsed.discountMinor,note:parsed.note,existingPlanId:parsed.existingPlanId,items:parsed.items,createdBy:actor.username,actorRole:actor.role,templates:DEFAULT_SPECIALTY_TEMPLATES,idempotencyKey:source.idempotencyKey,requestHash:invoiceCatalogRequestFingerprint(source,actor),catalogueAuthority:{source,fingerprint:invoiceCommandFingerprint(parsed),session:actor},auditDetails:{}};
 const result=await invoice.createLinkedInvoice(input);if(!result.ok)throw Error(result.reason);return {result,input};
}
async function addVisit(patientId:number){return (await db.addVisit({patientId,patientName:"Synthetic lab invoice patient",patientPhone:null,note:null})).id;}
/** Tests the real source-materialization transaction, not the wider clinical signing/billing UI. */
async function executePlanned(patientId:number,planItemId:number,invoiceId:number,work:LabWorkDraft){
 const visitId=await addVisit(patientId);
 return tx(patientId,async c=>{const prepared=await lab.prepareVisitLabWorkInTransaction(c,{patientId,visitId,session:actor,requestKey:`planned-execution-${randomUUID()}`,requestHash:"synthetic-planned-execution",rows:[row(work,planItemId)]});
  const procedure=(await c.query<{id:number}>("INSERT INTO visit_procedures(visit_id,service_id,doctor_id,tooth_code,quantity,plan_item_id,lab_work_intent_id,lab_work_member_id) VALUES($1,$2,$3,27,1,$4,$5,$6) RETURNING id",[visitId,serviceId,doctorId,planItemId,work.intentId,work.memberId])).rows[0];
  const fresh={...work,expectedRevision:prepared.revisions[0].revision};
  const materialized=await lab.materializeVisitLabWorkInTransaction(c,{patientId,visitId,invoiceId,session:actor,rows:[{...row(fresh,planItemId),procedureId:Number(procedure.id)}]});
  await c.query("UPDATE visits SET signed_at=NOW() WHERE id=$1",[visitId]);return materialized;
 });
}
async function revisionInput(invoiceId:number,unit=900){const view=await revision.readInvoiceRevision(invoiceId,actor);return {view,body:{idempotencyKey:`lab-financial-${randomUUID()}`,expectedSourceHash:view.sourceHash,reason:"Synthetic financial-only adjustment",lines:view.invoice.items.map(item=>({itemId:item.id,quantity:item.quantity,unitPrice:String(unit)})),discount:"0",discountReason:null,repaymentTerms:{mode:"full",installments:[]},expectedRemainingMinor:unit}};}
describe("invoice lab identity integration on owned synthetic PostgreSQL",()=>{
 it("actual invoice writer materializes exact persisted item and planned execution reuses same order",async()=>{
  const patientId=await patient(),work=draft(),{result,input}=await create(patientId,work);
  expect(result.labWork).toHaveLength(1);const receipt=result.labWork![0],planItemId=result.invoice.items[0].planItemId!;
  expect(receipt).toMatchObject({intentId:work.intentId,memberIds:[work.memberId]});expect(planItemId).toBeGreaterThan(0);
  expect(await q("SELECT invoice_item_id FROM lab_prescription_source_memberships WHERE intent_id=$1 AND invoice_item_id IS NOT NULL",[work.intentId])).toEqual([{invoice_item_id:result.invoice.items[0].id}]);
  const replay=await invoice.createLinkedInvoice(input);expect(replay.ok&&replay.labWork).toEqual(result.labWork);
  const loaded=(await lab.readLabWorkForPlanItems(db.getPool(),patientId,[planItemId])).get(planItemId)!;
  const executed=await executePlanned(patientId,planItemId,result.invoice.id,loaded.labWork);
  expect(executed.createdCount).toBe(0);expect(executed.labWork[0].orderId).toBe(receipt.orderId);
  expect(await q("SELECT id FROM lab_orders WHERE patient_id=$1",[patientId])).toHaveLength(1);
  expect(await db.getLabOrderById(receipt.orderId)).toMatchObject({status:"needed",costMinor:null,payableId:null});
 });
 it("saved visit draft plan alias converges into actual invoice writer without a new intent",async()=>{
  const patientId=await patient(),work=draft(),visitId=await addVisit(patientId);
  const plan=await db.createPlanV2({patientId,title:"Synthetic lab planned crown",specialty:null,primaryDoctorId:doctorId,billingMode:"per_procedure",baseCurrency:"YER",startDate:"2026-10-01",note:null,createdBy:actor.username,installments:[],items:[{serviceId,serviceName:"Synthetic planned crown",category:"crown",toothCode:27,surfaces:null,quantity:1,unitPriceMinor:1000,billingRule:"on_completion",sessionCount:1,note:null}]});if(!plan.ok)throw Error(plan.message);
  const planItemId=(await q("SELECT id FROM plan_items WHERE plan_id=$1",[plan.planId]))[0].id as number;
  await q("UPDATE plan_items SET doctor_id=$2 WHERE id=$1",[planItemId,doctorId]);
  await tx(patientId,async c=>{await lab.prepareVisitLabWorkInTransaction(c,{patientId,visitId,session:actor,requestKey:`draft-before-invoice-${randomUUID()}`,requestHash:"synthetic-draft",rows:[row(work,planItemId)]});await c.query("INSERT INTO visit_procedures(visit_id,service_id,doctor_id,tooth_code,quantity,plan_item_id,lab_work_intent_id,lab_work_member_id) VALUES($1,$2,$3,27,1,$4,$5,$6)",[visitId,serviceId,doctorId,planItemId,work.intentId,work.memberId]);});
  const loaded=(await lab.readLabWorkForPlanItems(db.getPool(),patientId,[planItemId])).get(planItemId)!;expect(loaded.labWork.intentId).toBe(work.intentId);expect(loaded.labWorkOrderId).toBeNull();
  const {result}=await create(patientId,loaded.labWork,planItemId);expect(result.labWork![0].intentId).toBe(work.intentId);
  expect(await q("SELECT id,origin_visit_id FROM lab_work_intents WHERE patient_id=$1",[patientId])).toEqual([{id:work.intentId,origin_visit_id:visitId}]);
  expect(await q("SELECT id FROM lab_orders WHERE patient_id=$1",[patientId])).toHaveLength(1);
 });
 it("actual financial-only correction appends exact replacement alias without another lab order",async()=>{
  const patientId=await patient(),work=draft(),{result}=await create(patientId,work),{body}=await revisionInput(result.invoice.id);
  const before=await q("SELECT to_jsonb(o) AS snapshot FROM lab_orders o WHERE patient_id=$1",[patientId]);
  await revision.reviseInvoice(result.invoice.id,body,actor);
  const aliases=await q("SELECT a.invoice_item_id,ii.invoice_id FROM lab_prescription_source_memberships a JOIN invoice_items ii ON ii.id=a.invoice_item_id WHERE a.intent_id=$1 ORDER BY a.invoice_item_id",[work.intentId]);
  expect(aliases).toHaveLength(2);expect(aliases[0].invoice_item_id).toBe(result.invoice.items[0].id);expect(aliases[1].invoice_id).not.toBe(result.invoice.id);
  expect(await q("SELECT to_jsonb(o) AS snapshot FROM lab_orders o WHERE patient_id=$1",[patientId])).toEqual(before);
 });
 it("actual revision refuses clinical identity change and preserves all source and order records",async()=>{
  const patientId=await patient(),work=draft(),{result}=await create(patientId,work),{view,body}=await revisionInput(result.invoice.id,1000);
  expect(view.work[0].clinical_locked).toBe(true);
  const before=await q("SELECT to_jsonb(o) AS snapshot FROM lab_orders o WHERE patient_id=$1",[patientId]);
  await expect(revision.reviseInvoice(result.invoice.id,{...body,lines:body.lines.map(line=>({...line,toothCode:28}))},actor)).rejects.toThrow();
  expect(await q("SELECT id FROM invoice_corrections WHERE original_invoice_id=$1",[result.invoice.id])).toHaveLength(0);
  expect(await q("SELECT to_jsonb(o) AS snapshot FROM lab_orders o WHERE patient_id=$1",[patientId])).toEqual(before);
  expect(await q("SELECT id FROM lab_prescription_source_memberships WHERE intent_id=$1 AND invoice_item_id IS NOT NULL",[work.intentId])).toHaveLength(1);
 });
 it("refuses a competing intent/member claiming an existing exact plan alias",async()=>{
  const patientId=await patient(),original=draft(),{result}=await create(patientId,original);
  const planItemId=result.invoice.items[0].planItemId!,competing=draft(),visitId=await addVisit(patientId);
  await expect(tx(patientId,c=>lab.prepareVisitLabWorkInTransaction(c,{patientId,visitId,session:actor,requestKey:`competing-plan-${randomUUID()}`,requestHash:"synthetic-competing-plan-alias",rows:[row(competing,planItemId)]}))).rejects.toThrow();
  expect(await q("SELECT id FROM lab_work_intents WHERE id=$1",[competing.intentId])).toHaveLength(0);
  expect(await q("SELECT id FROM lab_work_members WHERE id=$1",[competing.memberId])).toHaveLength(0);
  expect(await q("SELECT intent_id,member_id FROM lab_prescription_source_memberships WHERE plan_item_id=$1",[planItemId])).toEqual([{intent_id:original.intentId,member_id:original.memberId}]);
  expect(await q("SELECT id FROM lab_orders WHERE patient_id=$1",[patientId])).toHaveLength(1);
 });
 it("two real planned visit saves and signatures reuse invoice lab work with no second receivable",async()=>{
  const patientId=await patient(),work=draft(),{result}=await create(patientId,work,undefined,2);
  const planItemId=result.invoice.items[0].planItemId!,orderId=result.labWork![0].orderId;
  expect(await db.recordPlanConsent({planId:result.planId!,actor:actor.username,note:"Explicit synthetic clinical consent"})).toMatchObject({ok:true});
  const financialBefore=await q("SELECT to_jsonb(i) AS snapshot FROM invoices i WHERE patient_id=$1 ORDER BY id",[patientId]);
  const signedVisits:number[]=[];
  for(let sessionIndex=0;sessionIndex<2;sessionIndex++){
    const visitId=await addVisit(patientId);
    await q("UPDATE visits SET doctor_id=$2,case_id=$3,diagnosis='Synthetic planned crown execution' WHERE id=$1",[visitId,doctorId,result.links[0].caseId]);
    const loaded=(await lab.readLabWorkForPlanItems(db.getPool(),patientId,[planItemId])).get(planItemId)!;
    const procedures=[{serviceId,doctorId,toothCode:27,surfaces:null,quantity:1,unitPriceMinor:0,priceReason:null,note:null,planItemId,labWork:loaded.labWork}];
    expect(await db.setVisitProcedures({visitId,procedures,labCommand:{expectedPatientId:patientId,session:actor,requestKey:`real-planned-session-${randomUUID()}`,requestHash:JSON.stringify(procedures)}})).toBe(true);
    const reviewed=await db.getClinicalVisit(visitId);expect(reviewed?.labSignVersion).toBeTruthy();
    const signed=await db.signClinicalVisit({visitId,baseCurrency:"YER",signedBy:actor.username,signerRole:actor.role,signerDoctorPartyId:doctorId,session:actor,labSignVersion:reviewed!.labSignVersion});
    expect(signed.reason).toBeNull();expect(signed.invoiceId).toBeNull();signedVisits.push(visitId);
    // Close only this synthetic arrival before creating its next planned session.
    await q("UPDATE visits SET status='done' WHERE id=$1",[visitId]);
  }
  expect(await q("SELECT to_jsonb(i) AS snapshot FROM invoices i WHERE patient_id=$1 ORDER BY id",[patientId])).toEqual(financialBefore);
  expect(await q("SELECT id FROM lab_orders WHERE patient_id=$1",[patientId])).toEqual([{id:orderId}]);
  expect(await q("SELECT visit_id FROM treatment_sessions WHERE plan_item_id=$1 AND status='done' ORDER BY sequence",[planItemId])).toEqual(signedVisits.map(visit_id=>({visit_id})));
  const aliases=await q("SELECT a.member_id,p.visit_id FROM lab_prescription_source_memberships a JOIN visit_procedures p ON p.id=a.visit_procedure_id WHERE a.intent_id=$1 ORDER BY p.visit_id",[work.intentId]);
  expect(aliases).toEqual(signedVisits.map(visit_id=>({member_id:work.memberId,visit_id})));
  expect(await db.getLabOrderById(orderId)).toMatchObject({status:"needed",costMinor:null,payableId:null});
 });
 it("one exact member execution of an existing three-unit bridge returns only touched member receipt",async()=>{
  const patientId=await patient(),base=draft(),bridgeServiceId=(await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES($1,'bridge',1000,TRUE,TRUE) RETURNING id",[`Synthetic invoice bridge ${randomUUID()}`]))[0].id as number;
  const prescription={...base.prescription,toothNumbers:"26(Abutment), 27(Pontic), 28(Abutment)"};
  const works=[26,27,28].map(()=>({...base,memberId:randomUUID(),groupKind:"bridge" as const,prescription}));
  const source={patientId,currency:"YER",idempotencyKey:`bridge-invoice-${randomUUID()}`,items:[26,27,28].map((toothCode,index)=>({serviceId:bridgeServiceId,doctorId,quantity:1,price:"1000",sessions:1,toothCode,episodeTeeth:[26,27,28],labWork:works[index]}))};
  const parsed=parseInvoiceCommand(source,new Map((await db.listServices()).map(s=>[s.id,s])),new Set([doctorId]),await db.getSettings(),true);if(!parsed.ok)throw Error(parsed.message);
  const created=await invoice.createLinkedInvoice({patientId,baseCurrency:parsed.baseCurrency,discountMinor:0,note:null,items:parsed.items,createdBy:actor.username,actorRole:actor.role,templates:DEFAULT_SPECIALTY_TEMPLATES,idempotencyKey:source.idempotencyKey,requestHash:invoiceCatalogRequestFingerprint(source,actor),catalogueAuthority:{source,fingerprint:invoiceCommandFingerprint(parsed),session:actor},auditDetails:{}});if(!created.ok)throw Error(created.reason);
  const orderId=created.labWork![0].orderId;expect(created.labWork![0].memberIds).toHaveLength(3);
  const planItemId=created.invoice.items[0].planItemId!,loaded=(await lab.readLabWorkForPlanItems(db.getPool(),patientId,[planItemId])).get(planItemId)!,visitId=await addVisit(patientId);
  const result=await tx(patientId,async c=>{
    const sourceRow={serviceId:bridgeServiceId,doctorId,toothCode:26,quantity:1,planItemId,category:"bridge",labWork:loaded.labWork};
    await lab.prepareVisitLabWorkInTransaction(c,{patientId,visitId,session:actor,requestKey:`bridge-member-execution-${randomUUID()}`,requestHash:"synthetic exact bridge member",rows:[sourceRow]});
    const procedure=(await c.query<{id:number}>("INSERT INTO visit_procedures(visit_id,service_id,doctor_id,tooth_code,quantity,plan_item_id,lab_work_intent_id,lab_work_member_id) VALUES($1,$2,$3,26,1,$4,$5,$6) RETURNING id",[visitId,bridgeServiceId,doctorId,planItemId,base.intentId,loaded.labWork.memberId])).rows[0];
    const materialized=await lab.materializeVisitLabWorkInTransaction(c,{patientId,visitId,invoiceId:created.invoice.id,session:actor,rows:[{...sourceRow,procedureId:Number(procedure.id)}]});await c.query("UPDATE visits SET signed_at=NOW() WHERE id=$1",[visitId]);return materialized;
  });
  expect(result.createdCount).toBe(0);expect(result.labWork).toHaveLength(1);expect(result.labWork[0]).toMatchObject({intentId:base.intentId,orderId,memberIds:[loaded.labWork.memberId]});
  expect(await q("SELECT id FROM lab_orders WHERE patient_id=$1",[patientId])).toEqual([{id:orderId}]);
  expect((await db.getLabOrderById(orderId))?.toothNumbers).toBe(prescription.toothNumbers);
 });
});
