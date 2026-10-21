import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {assertRealPostgresUrl,stubPostgresEnv,createIsolatedDatabase} from "./_setup";
import type {SessionPayload} from "../../lib/auth";
import {applyRuntimeMigrationFiles,loadMigrationFiles} from "../../lib/migrations";
import {AGREEMENT_DELTA_SQL} from "../../lib/agreement-delta-schema";
assertRealPostgresUrl();stubPostgresEnv();
process.env.DATABASE_URL=await createIsolatedDatabase("aqlan_agreement_delta_test");
const db=await import("../../lib/db"),auth=await import("../../lib/auth");
const api=await import("../../lib/agreement-amendment-db");
const approve=await import("../../lib/approved-agreements");
let session:SessionPayload,serial=0;
const q=(sql:string,values:unknown[]=[])=>db.getPool().query(sql,values);
beforeAll(async()=>{
 await db.ensureSchema();
 const file=(await loadMigrationFiles()).find(file=>file.version==="0066");
 expect(file?.sql).toBe(AGREEMENT_DELTA_SQL);
 await applyRuntimeMigrationFiles(db.getPool(),[file!]);
 const hash=await auth.hashPassword("synthetic-delta-only-password");
 const u=(await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('delta-admin','Synthetic delta admin',$1,'admin',TRUE) RETURNING id",[hash])).rows[0];
 session={userId:u.id,username:"delta-admin",role:"admin",credentialVersion:auth.sessionCredentialVersion(hash),expiresAt:Date.now()+3600000};
 await db.openShift({openedBy:session.username,opening:{YER:0,SAR:0,USD:0}});
},180000);
afterAll(async()=>{await db.resetPoolForTesting();});
async function fixture(currency:"YER"|"SAR"|"USD"="YER",paid=180000){
 const patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic agreement upgrade') RETURNING id",[`DELTA-${++serial}`])).rows[0].id as number;
 const oldServiceId=(await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES($1,50000,TRUE,TRUE,'prostho') RETURNING id",[`Old crown ${serial}`])).rows[0].id as number;
 const newServiceId=(await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES($1,80000,TRUE,TRUE,'prostho') RETURNING id",[`Zircon crown ${serial}`])).rows[0].id as number;
 const plan=await db.createPlanV2({patientId,title:"Synthetic ten crowns",specialty:null,primaryDoctorId:null,billingMode:"installments",baseCurrency:currency,startDate:"2026-10-01",note:null,createdBy:session.username,items:[],installments:[{dueDate:"2026-10-01",amountMinor:250000},{dueDate:"2026-12-01",amountMinor:250000}]});
 if(!plan.ok)throw Error(plan.message);
 const itemId=(await q("INSERT INTO plan_items(plan_id,service_id,service_name,quantity,unit_price_minor,billing_rule,session_count) VALUES($1,$2,'Ten crowns',10,50000,'once',1) RETURNING id",[plan.planId,oldServiceId])).rows[0].id;
 expect(await db.recordPlanConsent({planId:plan.planId,actor:session.username,note:null})).toMatchObject({ok:true});
 const agreement=await approve.approveAgreement({planId:plan.planId,expectedTotalMinor:500000,currency,source:{kind:"new"},reason:"Synthetic approved treatment",idempotencyKey:`delta-approve-${serial}`,session});
 let paymentId:number|null=null;
 if(paid){const result=await approve.collectApprovedAgreement({planId:plan.planId,amountMinor:paid,currency,method:"cash",note:null,idempotencyKey:`delta-paid-${serial}`,session});paymentId=result.paymentId;}
 return {patientId,planId:plan.planId,itemId,oldServiceId,newServiceId,currency,originalInvoiceId:agreement.agreement.invoice_id!,paymentId};
}
const command=async(f:Awaited<ReturnType<typeof fixture>>,key=`upgrade-${++serial}`,price=80000)=>{
 const view=await api.readAgreementAmendment(f.planId,session);
 return {idempotencyKey:key,expectedSourceHash:view.sourceHash,newServiceId:f.newServiceId,newUnitMinor:price,reason:"Documented patient's consent to zircon upgrade"};
};
describe("actual PostgreSQL 18 atomic agreement delta",()=>{
 it("posts exactly one delta and preserves invoice, cash and receipt bytes",async()=>{
  const f=await fixture(),input=await command(f);
  const original=(await q("SELECT to_jsonb(i) AS value FROM invoices i WHERE id=$1",[f.originalInvoiceId])).rows;
  const payment=(await q("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1",[f.patientId])).rows;
  const cash=(await db.getOpenShift())!.expected;
  const oldPlan=(await q("SELECT to_jsonb(p) AS value FROM plan_items p WHERE id=$1",[f.itemId])).rows;
  const saved=await api.saveAgreementAmendment(f.planId,input,session);
  expect(saved).toMatchObject({replayed:false,previousAgreementMinor:500000,deltaMinor:300000,revisedAgreementMinor:800000,settledMinor:180000,remainingMinor:620000,cashMovementMinor:0});
  expect((await q("SELECT total_minor::int,discount_minor::int FROM invoices WHERE id=$1",[saved.deltaInvoiceId])).rows).toEqual([{total_minor:300000,discount_minor:0}]);
  expect((await q("SELECT to_jsonb(i) AS value FROM invoices i WHERE id=$1",[f.originalInvoiceId])).rows).toEqual(original);
  expect((await q("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1",[f.patientId])).rows).toEqual(payment);
  expect((await q("SELECT to_jsonb(p) AS value FROM plan_items p WHERE id=$1",[f.itemId])).rows).toEqual(oldPlan);
  expect((await db.getOpenShift())!.expected).toEqual(cash);
  expect((await db.computeDebtRows([f.patientId])).find(row=>row.currency===f.currency)?.dueMinor).toBe(620000);
  expect(await approve.approvedAgreementPosition(f.planId,"2026-10-21")).toMatchObject({totalMinor:800000,paidMinor:180000,remainingMinor:620000});
  const plan=await db.getPlan(f.planId,"2026-10-21");expect(plan).not.toBeNull();
  const replay=await api.saveAgreementAmendment(f.planId,input,session);
  expect(replay).toEqual({...saved,replayed:true});
  expect((await q("SELECT id FROM agreement_delta_amendments WHERE plan_id=$1",[f.planId])).rows).toHaveLength(1);
  expect((await q("SELECT id FROM audit_log WHERE action='plan.agreement_delta_amendment' AND entity_id=$1",[String(f.planId)])).rows).toHaveLength(1);
  await expect(q("INSERT INTO invoice_items(invoice_id,plan_item_id,description,quantity,unit_price_minor,total_minor) VALUES($1,$2,'Duplicate principal',10,50000,500000)",[saved.deltaInvoiceId,f.itemId])).rejects.toThrow(/already financed|immutable|source/);
 });
 it("serializes two retries to the same event receipt",async()=>{
  const f=await fixture("SAR",120000),input=await command(f);
  const both=await Promise.all([api.saveAgreementAmendment(f.planId,input,session),api.saveAgreementAmendment(f.planId,input,session)]);
  expect(both.map(x=>x.deltaInvoiceId)).toEqual([both[0].deltaInvoiceId,both[0].deltaInvoiceId]);
  expect(both.filter(x=>!x.replayed)).toHaveLength(1);
  expect((await q("SELECT id FROM agreement_delta_amendments WHERE plan_id=$1",[f.planId])).rows).toHaveLength(1);
 });
 it("competing different requests cannot post twice from stale preview",async()=>{
  const f=await fixture("YER",0),view=await api.readAgreementAmendment(f.planId,session);
  const input=await command(f);
  const results=await Promise.allSettled([
   api.saveAgreementAmendment(f.planId,input,session),
   api.saveAgreementAmendment(f.planId,{...input,idempotencyKey:`compete-${++serial}`},session)]);
  expect(results.filter(x=>x.status==="fulfilled")).toHaveLength(1);
  expect(results.filter(x=>x.status==="rejected")).toHaveLength(1);
  expect((await q("SELECT id FROM agreement_delta_amendments WHERE plan_id=$1",[f.planId])).rows).toHaveLength(1);
  expect(view.sourceHash).toBe(input.expectedSourceHash);
 });
 it("rejects a payment arriving after preview and never posts a delta",async()=>{
  const f=await fixture("YER",0),input=await command(f);
  await approve.collectApprovedAgreement({planId:f.planId,amountMinor:10000,currency:"YER",method:"cash",note:null,idempotencyKey:`late-${++serial}`,session});
  await expect(api.saveAgreementAmendment(f.planId,input,session)).rejects.toMatchObject({code:"stale"});
  expect((await q("SELECT id FROM agreement_delta_amendments WHERE plan_id=$1",[f.planId])).rows).toHaveLength(0);
 });
 it("audit insertion failure rolls back BOTH invoice and event",async()=>{
  const f=await fixture("USD",50000),input=await command(f);
  const count=Number((await q("SELECT count(*)::int n FROM invoices WHERE patient_id=$1",[f.patientId])).rows[0].n);
  await q(`CREATE FUNCTION aqlan_synthetic_delta_audit_fail() RETURNS TRIGGER AS $$ BEGIN
   IF NEW.action='plan.agreement_delta_amendment' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END IF;RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await q("CREATE TRIGGER synthetic_delta_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION aqlan_synthetic_delta_audit_fail()");
  try{await expect(api.saveAgreementAmendment(f.planId,input,session)).rejects.toThrow(/SYNTHETIC_AUDIT_FAILURE/);}
  finally{await q("DROP TRIGGER synthetic_delta_audit_fail ON audit_log");await q("DROP FUNCTION aqlan_synthetic_delta_audit_fail()");}
  expect(Number((await q("SELECT count(*)::int n FROM invoices WHERE patient_id=$1",[f.patientId])).rows[0].n)).toBe(count);
  expect((await q("SELECT id FROM agreement_delta_amendments WHERE plan_id=$1",[f.planId])).rows).toHaveLength(0);
 });
 it("refund changes settlement immediately and keeps amendment history untouched",async()=>{
  const f=await fixture("SAR",180000),input=await command(f);
  const result=await api.saveAgreementAmendment(f.planId,input,session);
  expect(result.remainingMinor).toBe(620000);
  const refund=await db.recordPayment({patientId:f.patientId,invoiceId:null,planId:null,openingCurrency:null,
   kind:"refund",amountMinor:20000,currency:"SAR",baseCurrency:"YER",exchangeRate:999,method:"cash",note:"Synthetic refund",createdBy:session.username,reversalOfId:f.paymentId!});
  expect(refund.reason).toBeFalsy();
  const position=await approve.approvedAgreementPosition(f.planId,"2026-10-21");
  expect(position).toMatchObject({remainingMinor:640000,paidMinor:160000});
  expect((await q("SELECT id FROM agreement_delta_amendments WHERE plan_id=$1",[f.planId])).rows).toHaveLength(1);
 });
 it("refuses missing source, inactive service and unauthorized admin impersonation",async()=>{
  const f=await fixture("YER",0),input=await command(f);
  await expect(api.saveAgreementAmendment(f.planId,{...input,newServiceId:9000000},session)).rejects.toMatchObject({code:"invalid"});
  await expect(api.saveAgreementAmendment(f.planId,input,{...session,role:"reception"})).rejects.toMatchObject({code:"unauthorized"});
  await expect(api.saveAgreementAmendment(f.planId,{...input,expectedSourceHash:"0".repeat(64)},session)).rejects.toMatchObject({code:"stale"});
  expect((await q("SELECT id FROM agreement_delta_amendments WHERE plan_id=$1",[f.planId])).rows).toHaveLength(0);
 });
});
