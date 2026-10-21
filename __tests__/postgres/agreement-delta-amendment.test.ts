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
 // The suite uses synthetic local FX settings, never live currency rates.
 await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
},180000);
afterAll(async()=>{await db.resetPoolForTesting();});
async function fixture(currency:"YER"|"SAR"|"USD"="YER",paid=180000,doctorPolicy?:"no_cost"|"missing_cost"|"primary_no_cost"){
 const patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic agreement upgrade') RETURNING id",[`DELTA-${++serial}`])).rows[0].id as number;
 const oldServiceId=(await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES($1,50000,TRUE,TRUE,'prostho') RETURNING id",[`Old crown ${serial}`])).rows[0].id as number;
 const newServiceId=(await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES($1,80000,TRUE,TRUE,'prostho') RETURNING id",[`Zircon crown ${serial}`])).rows[0].id as number;
 let doctorId:number|null=null;
 if(doctorPolicy){
  doctorId=(await q("INSERT INTO parties(kind,name,commission_percent) VALUES('doctor',$1,20) RETURNING id",[`Synthetic delta doctor ${serial}`])).rows[0].id as number;
  const config=(doctorPolicy==="no_cost"||doctorPolicy==="primary_no_cost")
    ? {...(await import("../../lib/doctor-permissions")).DEFAULT_DOCTOR_COMMISSION_CONFIG,
       defaultPercent:20,deductLabCost:false,deductMaterialCost:false,basis:"collected_cash"}
    : null;
  await q("INSERT INTO doctor_commission_history(party_id,percent,config,effective_from,source) VALUES($1,20,$2::jsonb,now()-interval '1 day','baseline')",
    [doctorId,config?JSON.stringify(config):null]);
 }
 const plan=await db.createPlanV2({patientId,title:"Synthetic ten crowns",specialty:null,primaryDoctorId:doctorPolicy==="primary_no_cost"?doctorId:null,billingMode:"installments",baseCurrency:currency,startDate:"2026-10-01",note:null,createdBy:session.username,items:[],installments:[{dueDate:"2026-10-01",amountMinor:250000},{dueDate:"2026-12-01",amountMinor:250000}]});
 if(!plan.ok)throw Error(plan.message);
 const itemId=(await q("INSERT INTO plan_items(plan_id,service_id,service_name,quantity,unit_price_minor,billing_rule,session_count,doctor_id) VALUES($1,$2,'Ten crowns',10,50000,'once',1,$3) RETURNING id",[plan.planId,oldServiceId,doctorPolicy==="primary_no_cost"?null:doctorId])).rows[0].id;
 expect(await db.recordPlanConsent({planId:plan.planId,actor:session.username,note:null})).toMatchObject({ok:true});
 const agreement=await approve.approveAgreement({planId:plan.planId,expectedTotalMinor:500000,currency,source:{kind:"new"},reason:"Synthetic approved treatment",idempotencyKey:`delta-approve-${serial}`,session});
 let paymentId:number|null=null;
 if(paid){const result=await approve.collectApprovedAgreement({planId:plan.planId,amountMinor:paid,currency,method:"cash",note:null,idempotencyKey:`delta-paid-${serial}`,session});paymentId=result.paymentId;}
 return {patientId,planId:plan.planId,itemId,oldServiceId,newServiceId,currency,originalInvoiceId:agreement.agreement.invoice_id!,paymentId,doctorId};
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
  await approve.collectApprovedAgreement({planId:f.planId,amountMinor:10000,currency:"YER",method:"cash",note:null,idempotencyKey:`late-source-${++serial}`,session});
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
it("settles 620000 once across original 320000 and delta 300000 and matches plan, checkout, statement and cash",async()=>{
 const f=await fixture("YER",180000),command1=await command(f);
 const saved=await api.saveAgreementAmendment(f.planId,command1,session);
 const {readCheckoutDueRecommendationInSnapshot}=await import("../../lib/checkout-due-recommendation-db");
 const {buildReport,parseFilters}=await import("../../lib/reports");
 const args=(from:string,to:string)=>parseFilters(new URLSearchParams({preset:"custom",from,to,patientId:String(f.patientId)}));
 const history=await buildReport("patient-statement",args("2025-01-01","2026-10-20"));
 expect((await db.computeDebtRows([f.patientId])).find(r=>r.currency==="YER")?.dueMinor).toBe(620000);
 const checkout=async()=>{
  const client=await db.getPool().connect();
  try{
   await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
   const value=await readCheckoutDueRecommendationInSnapshot(client,{patientId:f.patientId,visitInvoiceId:null,today:"2026-10-21"});
   await client.query("COMMIT");return value;
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
 };
 expect((await checkout()).currencies.find(x=>x.currency==="YER")?.currentBalanceMinor).toBe(620000);
 const before=(await db.getOpenShift())!.expected;
 const input={planId:f.planId,amountMinor:620000,currency:"YER" as const,method:"cash" as const,note:null,idempotencyKey:`whole-upgrade-${++serial}`,session};
 const received=await approve.collectApprovedAgreement(input);
 if(!("paymentIds" in received)||!received.paymentIds)throw Error("Missing complete split payment identity");
 expect(received.paymentIds).toHaveLength(2);
 const receipts=(await q("SELECT invoice_id,amount_minor::int AS amount FROM payments WHERE id=ANY($1::int[]) ORDER BY id",[received.paymentIds])).rows;
 expect(receipts).toEqual([{invoice_id:f.originalInvoiceId,amount:320000},{invoice_id:saved.deltaInvoiceId,amount:300000}]);
 const after=(await db.getOpenShift())!.expected;
 expect(after.YER-before.YER).toBe(620000);
 expect(await approve.collectApprovedAgreement(input)).toMatchObject({paymentIds:received.paymentIds,replayed:true});
 expect((await db.getOpenShift())!.expected).toEqual(after);
 expect((await q("SELECT id FROM payments WHERE id=ANY($1::int[])",[received.paymentIds])).rows).toHaveLength(2);
 expect((await q("SELECT idempotency_key FROM agreement_delta_collection_receipts WHERE plan_id=$1",[f.planId])).rows).toEqual([{idempotency_key:input.idempotencyKey}]);
 expect((await db.computeDebtRows([f.patientId])).find(r=>r.currency==="YER")?.dueMinor??0).toBe(0);
 expect(await approve.approvedAgreementPosition(f.planId,"2026-10-21")).toMatchObject({totalMinor:800000,paidMinor:800000,remainingMinor:0});
 expect((await checkout()).currencies.find(x=>x.currency==="YER")?.currentBalanceMinor??0).toBe(0);
 const current=await buildReport("patient-statement",args("2026-10-01","2099-12-31"));
 expect(current.kpis.find(k=>k.key==="balance-YER")?.minor??0).toBe(0);
 expect(await buildReport("patient-statement",args("2025-01-01","2026-10-20"))).toEqual(history);
});
it.each(["no_cost","missing_cost"] as const)("uses actual doctor policy for $s and never mutates historical commission",async policy=>{
 const f=await fixture("SAR",180000,policy),cmd=await command(f);
 const prior=(await q("SELECT to_jsonb(h) AS value FROM doctor_commission_history h WHERE party_id=$1 ORDER BY id",[f.doctorId])).rows;
 const result=await api.saveAgreementAmendment(f.planId,cmd,session);
 expect((await q("SELECT doctor_id FROM agreement_delta_amendments WHERE id=$1",[result.eventId])).rows).toEqual([{doctor_id:f.doctorId}]);
 const line=(await q("SELECT doctor_id FROM invoice_items WHERE invoice_id=$1",[result.deltaInvoiceId])).rows[0];
 if(policy==="no_cost"){expect(result.commissionDecision.state).toBe("policy_resolved");expect(line.doctor_id).toBe(f.doctorId);}
 else {expect(result.commissionDecision).toMatchObject({state:"pending_cost_evidence",required:["lab"]});expect(line.doctor_id).toBeNull();}
 expect((await q("SELECT to_jsonb(h) AS value FROM doctor_commission_history h WHERE party_id=$1 ORDER BY id",[f.doctorId])).rows).toEqual(prior);
 await q("INSERT INTO doctor_commission_history(party_id,percent,config,effective_from,source) VALUES($1,40,NULL,now()+interval '1 second','party')",[f.doctorId]);
 const stored=(await q("SELECT receipt FROM agreement_delta_amendments WHERE id=$1",[result.eventId])).rows[0].receipt;
 expect(stored.commissionHistoryId).toBe(result.commissionHistoryId);
 expect(stored.commissionDecision).toEqual(result.commissionDecision);
});
it("rolls back both halves and logical collection receipt when payment audit insert fails",async()=>{
 const f=await fixture("YER",180000);
 await api.saveAgreementAmendment(f.planId,await command(f),session);
 const balances=(await db.computeDebtRows([f.patientId])).find(x=>x.currency==="YER")?.dueMinor;
 const originalCount=(await q("SELECT count(*)::int n FROM payments WHERE patient_id=$1",[f.patientId])).rows[0].n;
 await q(`CREATE FUNCTION aqlan_synthetic_collection_audit_fail() RETURNS TRIGGER AS $$ BEGIN
   IF NEW.action='plan.approved_collection' AND NEW.details::text LIKE '%deltaCollection%'
     THEN RAISE EXCEPTION 'SYNTHETIC_SPLIT_AUDIT_FAIL'; END IF;RETURN NEW; END; $$ LANGUAGE plpgsql`);
 await q("CREATE TRIGGER synthetic_collection_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION aqlan_synthetic_collection_audit_fail()");
 try{
  await expect(approve.collectApprovedAgreement({planId:f.planId,amountMinor:620000,currency:"YER",method:"cash",note:null,idempotencyKey:`audit-split-${++serial}`,session}))
   .rejects.toThrow(/SYNTHETIC_SPLIT_AUDIT_FAIL/);
 }finally{await q("DROP TRIGGER synthetic_collection_audit_fail ON audit_log");await q("DROP FUNCTION aqlan_synthetic_collection_audit_fail()");}
 expect((await q("SELECT count(*)::int n FROM payments WHERE patient_id=$1",[f.patientId])).rows[0].n).toBe(originalCount);
 expect((await db.computeDebtRows([f.patientId])).find(x=>x.currency==="YER")?.dueMinor).toBe(balances);
});

});


it("attributes a missing item doctor to the APPROVED primary doctor at the amendment event",async()=>{
 const f=await fixture("SAR",180000,"primary_no_cost");
 expect((await q("SELECT doctor_id FROM plan_items WHERE id=$1",[f.itemId])).rows).toEqual([{doctor_id:null}]);
 const before=(await q("SELECT to_jsonb(h) row FROM doctor_commission_history h WHERE party_id=$1 ORDER BY id",[f.doctorId])).rows;
 const saved=await api.saveAgreementAmendment(f.planId,await command(f),session);
 expect(saved.doctorId).toBe(f.doctorId);
 expect(saved.commissionDecision.state).toBe("policy_resolved");
 expect((await q("SELECT doctor_id FROM agreement_delta_amendments WHERE id=$1",[saved.eventId])).rows).toEqual([{doctor_id:f.doctorId}]);
 expect((await q("SELECT doctor_id FROM invoice_items WHERE invoice_id=$1",[saved.deltaInvoiceId])).rows).toEqual([{doctor_id:f.doctorId}]);
 expect((await q("SELECT to_jsonb(h) row FROM doctor_commission_history h WHERE party_id=$1 ORDER BY id",[f.doctorId])).rows).toEqual(before);
});


it("preserves a populated historical statement before upgrade and after two-source settlement",async()=>{
 const f=await fixture();
 // A separate fully-settled, dated source on the SAME synthetic patient.
 // This is existing history, not an artificial empty pre-amendment report.
 const shift=(await q("SELECT id FROM cashier_shifts WHERE status='open' ORDER BY id LIMIT 1")).rows[0].id;
 const historicInvoice=(await q(`INSERT INTO invoices
  (invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by,created_at)
  VALUES($1,$2,25000,0,'YER','synthetic-history','2026-09-12T10:00:00+03:00') RETURNING id`,
  [`HIST-UPGRADE-${f.planId}`,f.patientId])).rows[0].id;
 await q("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Synthetic old checkup',1,25000,25000)",[historicInvoice]);
 await q(`INSERT INTO payments
  (receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,
   base_amount_minor,base_currency,method,created_by,created_at)
  VALUES($1,$2,$3,$4,'payment',25000,'YER',1,25000,'YER','cash','synthetic-history','2026-09-13T10:00:00+03:00')`,
  [`HIST-RECEIPT-${f.planId}`,f.patientId,historicInvoice,shift]);
 const {buildReport,parseFilters}=await import("../../lib/reports");
 const filters=parseFilters(new URLSearchParams({preset:"custom",from:"2026-09-01",to:"2026-09-30",patientId:String(f.patientId)}));
 const history=await buildReport("patient-statement",filters);
 expect(history.rows?.length??0).toBeGreaterThan(0);
 const change=await api.saveAgreementAmendment(f.planId,await command(f),session);
 expect(change.deltaMinor).toBe(300000);
 const received=await approve.collectApprovedAgreement({planId:f.planId,amountMinor:620000,currency:"YER",
  method:"cash",note:null,idempotencyKey:`history-collect-${f.planId}`,session});
 expect("paymentIds" in received&&received.paymentIds?.length).toBe(2);
 expect(await buildReport("patient-statement",filters)).toEqual(history);
 expect((await db.computeDebtRows([f.patientId])).find(r=>r.currency==="YER")?.dueMinor??0).toBe(0);
});


it("records a durable same-key stale rejection AFTER changed cash, never trusts a missing event",async()=>{
 const f=await fixture("YER",180000),old=await command(f);
 const before=await api.readAgreementAmendmentAttemptStatus(f.planId,old,session);
 expect(before).toMatchObject({state:"unresolved"});
 const changed=await approve.collectApprovedAgreement({
  planId:f.planId,amountMinor:20000,currency:"YER",method:"cash",note:null,
  idempotencyKey:`stale-proof-payment-${f.planId}`,session});
 expect(changed.paymentId).toBeGreaterThan(0);
 await expect(api.saveAgreementAmendment(f.planId,old,session)).rejects.toMatchObject({code:"stale"});
 const status=await api.readAgreementAmendmentAttemptStatus(f.planId,old,session);
 expect(status).toMatchObject({state:"rejected_stale",requestKey:old.idempotencyKey});
 expect((await q("SELECT count(*)::int n FROM agreement_delta_attempt_rejections WHERE idempotency_key=$1",[old.idempotencyKey])).rows[0].n).toBe(1);
 await expect(api.saveAgreementAmendment(f.planId,old,session)).rejects.toMatchObject({code:"stale"});
 expect((await q("SELECT count(*)::int n FROM agreement_delta_amendments WHERE plan_id=$1",[f.planId])).rows[0].n).toBe(0);
 const current=await command(f,`after-stale-${f.planId}`);
 const saved=await api.saveAgreementAmendment(f.planId,current,session);
 expect(saved).toMatchObject({revisedAgreementMinor:800000,settledMinor:200000,remainingMinor:600000});
 expect(await api.readAgreementAmendmentAttemptStatus(f.planId,current,session)).toMatchObject({state:"committed",receipt:{deltaInvoiceId:saved.deltaInvoiceId}});
 expect((await db.computeDebtRows([f.patientId])).find(x=>x.currency==="YER")?.dueMinor).toBe(600000);
});
it("status waits behind the exact command fence; an absent row is unresolved, never approved to reset",async()=>{
 const f=await fixture("YER",0),intent=await command(f);
 const client=await db.getPool().connect();
 try{
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('aqlan:agreement-delta:' || $1::text,0))",[intent.idempotencyKey]);
  const state=api.readAgreementAmendmentAttemptStatus(f.planId,intent,session);
  const early=await Promise.race([state.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),125))]);
  expect(early).toBe(false);
  await client.query("COMMIT");
  expect(await state).toMatchObject({state:"unresolved"});
 }finally{await client.query("ROLLBACK").catch(()=>{});client.release();}
});
