import {afterAll,beforeAll,expect,it} from "vitest";
import {assertRealPostgresUrl,createIsolatedDatabase,stubPostgresEnv} from "./_setup";
import type {SessionPayload} from "../../lib/auth";
assertRealPostgresUrl();stubPostgresEnv();
process.env.DATABASE_URL=await createIsolatedDatabase("aqlan_plan_ownership_audit");
const db=await import("../../lib/db");
const auth=await import("../../lib/auth");
const {approveAgreement,approvedAgreementPosition}=await import("../../lib/approved-agreements");
let session:SessionPayload;let serial=0;
const q=(sql:string,values:unknown[]=[])=>db.getPool().query(sql,values);
beforeAll(async()=>{
 await db.ensureSchema();
 const hash=await auth.hashPassword("synthetic-agreement-password");
 const u=(await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('agreement-admin','Synthetic approval',$1,'admin',TRUE) RETURNING id",[hash])).rows[0];
 session={userId:u.id,username:"agreement-admin",role:"admin",credentialVersion:auth.sessionCredentialVersion(hash),expiresAt:Date.now()+3600000};
 await db.openShift({openedBy:session.username,opening:{YER:0,SAR:0,USD:0}});
 await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
},180000);
afterAll(async()=>{await db.resetPoolForTesting();});
async function fixture(currency:"YER"|"SAR"|"USD",total:number,consent=true,pid?:number){
 const patientId=pid??(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic agreement') RETURNING id",[`APP-${++serial}`])).rows[0].id;
 const plan=await db.createPlanV2({patientId,title:"Synthetic agreement",specialty:null,primaryDoctorId:null,billingMode:"installments",baseCurrency:currency,
 startDate:"2026-10-01",note:null,createdBy:session.username,items:[],installments:[{dueDate:"2026-10-01",amountMinor:Math.floor(total/2)},{dueDate:"2026-12-01",amountMinor:total-Math.floor(total/2)}]});
 if(!plan.ok)throw new Error(plan.message);
 if(consent)expect(await db.recordPlanConsent({planId:plan.planId,actor:session.username,note:null})).toMatchObject({ok:true});
 return {planId:plan.planId,patientId,currency,total};
}
function approval(f:Awaited<ReturnType<typeof fixture>>,key=`approve-${++serial}`){return {planId:f.planId,expectedTotalMinor:f.total,currency:f.currency,source:{kind:"new" as const},reason:"Synthetic financial confirmation",idempotencyKey:key,session};}

async function sourceFixture(kind:string){
 const a=await fixture("SAR",150000),b=await fixture("SAR",150000,true,a.patientId);
 await q("DELETE FROM plan_installments WHERE plan_id=ANY($1::int[])",[[a.planId,b.planId]]);
 const owner=kind==="same_plan"?b:a;
 const item=(await q("INSERT INTO plan_items(plan_id,service_name,quantity,unit_price_minor,billing_rule,session_count) VALUES($1,'Synthetic owned work',1,150000,'per_session',1) RETURNING id",[owner.planId])).rows[0].id;
 let inv=(await q("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency) VALUES($1,$2,150000,'SAR') RETURNING id",[`OWNER-${++serial}`,a.patientId])).rows[0].id;
 let planItemId:number|null=null,sourceType:string|null=null,sourceId:number|null=null;
 if(["direct","same_plan","mixed"].includes(kind))planItemId=item;
 if(kind==="source_plan"){sourceType="plan_item";sourceId=item;}
 if(kind==="visit_procedure"||kind==="visit_header"||kind==="session"){
  const visit=await db.addVisit({patientName:"Synthetic",patientPhone:null,note:null,patientId:a.patientId});
  if(kind==="visit_procedure"||kind==="visit_header"){
   const service=(await q("INSERT INTO services(name,price_minor,is_active,price_configured) VALUES('Synthetic owned service',150000,TRUE,TRUE) RETURNING id")).rows[0].id;
   sourceId=(await q("INSERT INTO visit_procedures(visit_id,service_id,plan_item_id,unit_price_minor) VALUES($1,$2,$3,150000) RETURNING id",[visit.id,service,item])).rows[0].id;sourceType="visit_procedure";
   if(kind==="visit_header"){await q("UPDATE visits SET invoice_id=$2 WHERE id=$1",[visit.id,inv]);sourceType=null;sourceId=null;}
  }else{
   await q("UPDATE visits SET invoice_id=$2 WHERE id=$1",[visit.id,inv]);
   await q("INSERT INTO treatment_sessions(plan_item_id,sequence,visit_id) VALUES($1,1,$2)",[item,visit.id]);
  }
 }
 await q("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,plan_item_id,source_type,source_id) VALUES($1,'Synthetic owned work',1,150000,150000,$2,$3,$4)",[inv,planItemId,sourceType,sourceId]);
 if(kind==="mixed"){
  const other=(await q("INSERT INTO plan_items(plan_id,service_name,quantity,unit_price_minor) VALUES($1,'Synthetic B work',1,100) RETURNING id",[b.planId])).rows[0].id;
  await q("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,plan_item_id) VALUES($1,'Synthetic B work',1,0,0,$2)",[inv,other]);
 }
 const receipt=await db.recordPayment({patientId:a.patientId,invoiceId:inv,planId:null,openingCurrency:null,kind:"payment",amountMinor:50000,currency:"SAR",baseCurrency:"YER",exchangeRate:140,method:"cash",note:null,createdBy:session.username});
 expect(receipt.reason).toBeFalsy();
 expect((await q("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1",[inv])).rows[0].n).toBe(1);
 // Model a legacy receipt retaining both invoice and plan identity.
 if(kind==="payment_owner")await q("UPDATE payments SET plan_id=$2 WHERE invoice_id=$1",[inv,a.planId]);
 if(kind==="corrected_ancestor"){
  const {readInvoiceRevision,reviseInvoice}=await import("../../lib/invoice-revision-db");
  const view=await readInvoiceRevision(inv,session);
  const line=(await q("SELECT id FROM invoice_items WHERE invoice_id=$1",[inv])).rows[0].id;
  const correction=await reviseInvoice(inv,{idempotencyKey:`owner-correction-${++serial}`,expectedSourceHash:view.sourceHash,reason:"Synthetic correction ancestry",lines:[{itemId:line,quantity:1,unitPrice:"1500"}],discount:"0",discountReason:null,repaymentTerms:{mode:"full",installments:[]},expectedRemainingMinor:100000},session);
  if(!("corrected" in correction)||!correction.corrected)throw new Error("Synthetic correction failed");
  // Legacy ownership evidence may exist only on the retired ancestor.
  await q("UPDATE invoices SET plan_id=$2 WHERE id=$1",[inv,a.planId]);
  inv=correction.corrected.id;
 }
 if(kind==="approved")await approveAgreement({...approval(a),source:{kind:"invoice",invoiceId:inv}});
 return {a,b,inv};
}
async function financialState(){
 const result:Record<string,unknown>={};
 for(const table of ["invoices","invoice_items","payments","approved_agreement_principals","audit_log","plan_installments"]){
  result[table]=(await q(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t`)).rows[0].rows;
 }
 return result;
}
it.each(["direct","source_plan","visit_procedure","visit_header","session","mixed","approved","payment_owner","corrected_ancestor"])("rejects %s cross-plan ownership without financial writes",async(kind)=>{
 const {b,inv}=await sourceFixture(kind),before=await financialState();
 await expect(approveAgreement({...approval(b),source:{kind:"invoice",invoiceId:inv}})).rejects.toThrow(/ملكية المصدر/);
 expect(await financialState()).toEqual(before);
 expect(await approvedAgreementPosition(b.planId,"2026-10-20")).toBeNull();
 expect(await db.isPlanFundedByAgreement(b.planId,b.patientId)).toBe(false);
});
it.each(["unlinked","same_plan"])("allows %s historical reconciliation without another invoice or receipt",async(kind)=>{
 const {b,inv}=await sourceFixture(kind);
 const before=(await financialState());
 await approveAgreement({...approval(b),source:{kind:"invoice",invoiceId:inv}});
 const after=await financialState();
 expect(after.invoices).toEqual(before.invoices);expect(after.payments).toEqual(before.payments);
 expect(await approvedAgreementPosition(b.planId,"2026-10-20")).toMatchObject({available:true,paidMinor:50000,remainingMinor:100000,invoiceId:inv});
});
