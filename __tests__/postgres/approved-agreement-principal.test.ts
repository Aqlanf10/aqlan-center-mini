import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {assertRealPostgresUrl,createIsolatedDatabase,stubPostgresEnv} from "./_setup";
import type {SessionPayload} from "../../lib/auth";
assertRealPostgresUrl();stubPostgresEnv();
process.env.DATABASE_URL=await createIsolatedDatabase("aqlan_approved_agreement_test");
const db=await import("../../lib/db");
const auth=await import("../../lib/auth");
const {approveAgreement,collectApprovedAgreement,approvedAgreementPosition}=await import("../../lib/approved-agreements");
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
function collection(f:Awaited<ReturnType<typeof fixture>>,amount:number,key=`collect-${++serial}`){return {planId:f.planId,amountMinor:amount,currency:f.currency,method:"cash" as const,note:null,idempotencyKey:key,session};}
describe("approved complete principal",()=>{
 it.each([{currency:"SAR" as const,total:150000,paid:50000},{currency:"USD" as const,total:150000,paid:50000},{currency:"SAR" as const,total:30000,paid:14000}])("$currency $total less $paid is ledger debt",async({currency,total,paid})=>{
  const f=await fixture(currency,total);await approveAgreement(approval(f));
  expect((await db.computeDebtRows([f.patientId])).find(r=>r.currency===currency)?.dueMinor).toBe(total);
  await collectApprovedAgreement(collection(f,paid));
  const ledger=await db.patientLedger(f.patientId);expect(ledger.invoices).toHaveLength(1);expect(ledger.payments).toHaveLength(1);
  expect((await db.computeDebtRows([f.patientId])).find(r=>r.currency===currency)?.dueMinor).toBe(total-paid);
  expect(await approvedAgreementPosition(f.planId,"2026-10-18")).toMatchObject({remainingMinor:total-paid,dueNowMinor:Math.max(0,total/2-paid)});
 });
 it("replays concurrent approval and payment exactly once",async()=>{
  const f=await fixture("USD",150000),a=approval(f);
  const results=await Promise.all([approveAgreement(a),approveAgreement(a)]);expect(results.filter(r=>!r.replayed)).toHaveLength(1);
  const c=collection(f,50000);const receipts=await Promise.all([collectApprovedAgreement(c),collectApprovedAgreement(c)]);
  expect((await q("SELECT action FROM audit_log WHERE entity='payment' AND entity_id=$1 ORDER BY id",[String(receipts[0].payment!.id)])).rows)
    .toEqual([{action:"plan.approved_collection"}]);
  expect(receipts[0].paymentId).toBe(receipts[1].paymentId);expect((await db.patientLedger(f.patientId)).invoices).toHaveLength(1);
  await expect(collectApprovedAgreement({...c,amountMinor:40000})).rejects.toThrow(/مفتاح/);
 });
 it("does not approve a proposal",async()=>{const f=await fixture("SAR",30000,false);await expect(approveAgreement(approval(f))).rejects.toThrow(/موافقة/);expect((await db.patientLedger(f.patientId)).invoices).toHaveLength(0);});
 it("matches old opening without posting principal or historical cash",async()=>{
  const f=await fixture("USD",150000);await db.setPatientOpeningBalance({patientId:f.patientId,currency:"USD",amountMinor:100000,asOfDate:"2026-09-01",note:null,createdBy:session.username,reason:"Synthetic historic balance"});
  await expect(approveAgreement(approval(f))).rejects.toThrow(/سابق/);
  await approveAgreement({...approval(f),source:{kind:"opening",historicalPaidMinor:50000}});
  expect((await db.patientLedger(f.patientId)).invoices).toHaveLength(0);
  await collectApprovedAgreement(collection(f,10000));
  expect(await approvedAgreementPosition(f.planId,"2026-10-18")).toMatchObject({paidMinor:60000,remainingMinor:90000,dueNowMinor:15000});
 });
 it("rejects a new principal for a live historical agreement and preserves its opening-only debt",async()=>{
  const {parseLegacyTreatmentRequest}=await import("../../lib/legacy-treatment");
  const {createLegacyTreatment}=await import("../../lib/legacy-treatment-db");
  const {DEFAULT_SPECIALTY_TEMPLATES}=await import("../../lib/specialty-templates");
  const patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic historical principal guard') RETURNING id",[`APP-HIST-${++serial}`])).rows[0].id;
  const serviceId=(await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('Synthetic historic orthodontics',420000,TRUE,TRUE,'ortho') RETURNING id")).rows[0].id;
  const parsed=parseLegacyTreatmentRequest({serviceId,scope:"both",currency:"SAR",agreedAmount:"4200",previouslyPaidAmount:"1700",historicalAsOf:"2026-08-01",idempotencyKey:`historic-principal-${serial}`},"2026-10-01");
  if(!parsed.ok)throw new Error(parsed.message);
  const result=await createLegacyTreatment({patientId,request:parsed.value,actor:session.username,actorRole:"admin",canEditOpening:true,templates:DEFAULT_SPECIALTY_TEMPLATES});
  if(!result.ok)throw new Error(result.reason);
  const f={patientId,planId:result.agreement.planId,total:420000,currency:"SAR" as const};
  expect(await db.recordPlanConsent({planId:f.planId,actor:session.username,note:"Synthetic current consent"})).toMatchObject({ok:true});
  const before=(await q("SELECT * FROM legacy_treatment_agreements WHERE id=$1",[result.agreement.id])).rows;
  const openingBefore=(await q("SELECT * FROM patient_opening_balances WHERE patient_id=$1",[patientId])).rows;
  expect(result.agreement).toMatchObject({status:"live",agreedMinor:420000,previouslyPaidMinor:170000,remainingMinor:250000,openingEffect:"created"});
  await expect(approveAgreement(approval(f))).rejects.toThrow(/أصل سابق/);
  expect((await q("SELECT * FROM legacy_treatment_agreements WHERE id=$1",[result.agreement.id])).rows).toEqual(before);
  expect((await q("SELECT * FROM patient_opening_balances WHERE patient_id=$1",[patientId])).rows).toEqual(openingBefore);
  expect((await db.patientLedger(patientId)).invoices).toHaveLength(0);
  expect((await db.patientLedger(patientId)).payments).toHaveLength(0);
  expect((await q("SELECT plan_id FROM approved_agreement_principals WHERE plan_id=$1",[f.planId])).rows).toHaveLength(0);
  expect((await db.computeDebtRows([patientId])).find(row=>row.currency==="SAR")?.dueMinor).toBe(250000);
 });
 it("keeps multiple plans separate and rejects over-collection",async()=>{
  const a=await fixture("SAR",30000),b=await fixture("SAR",150000,true,a.patientId);await approveAgreement(approval(a));await approveAgreement(approval(b));
  await collectApprovedAgreement(collection(a,14000));expect((await approvedAgreementPosition(b.planId,"2026-10-18"))?.remainingMinor).toBe(150000);
  await expect(collectApprovedAgreement(collection(a,17000))).rejects.toThrow(/يتجاوز/);
 });
 it("refuses unapproved financial amendments",async()=>{const f=await fixture("SAR",30000);await approveAgreement(approval(f));await expect(q("UPDATE treatment_plans SET total_minor=40000 WHERE id=$1",[f.planId])).rejects.toThrow(/review/);});
});

describe("approved source integrity and compatibility",()=>{
 it("keeps YER/SAR/USD independent on one account",async()=>{
  const a=await fixture("YER",1500),b=await fixture("SAR",150000,true,a.patientId),c=await fixture("USD",150000,true,a.patientId);
  for(const f of [a,b,c]){await approveAgreement(approval(f));await collectApprovedAgreement(collection(f,f===a?500:50000));}
  const rows=await db.computeDebtRows([a.patientId]);
  for(const [currency,due] of [["YER",1000],["SAR",100000],["USD",100000]])expect(rows.find(r=>r.currency===currency)?.dueMinor).toBe(due);
 });
 it("uses a recorded YER conversion and refuses foreign-to-foreign guessing",async()=>{
  const yer=await fixture("YER",10000);await approveAgreement(approval(yer));
  const result=await collectApprovedAgreement({...collection(yer,1000),currency:"SAR"});
  expect(result.payment).toMatchObject({currency:"SAR",exchangeRate:140,baseAmountMinor:1400});
  expect((await approvedAgreementPosition(yer.planId,"2026-10-18"))?.remainingMinor).toBe(8600);
  const usd=await fixture("USD",150000);await approveAgreement(approval(usd));
  await expect(collectApprovedAgreement({...collection(usd,10000),currency:"SAR"})).rejects.toThrow(/بعملته/);
 });
 it("matches an existing full invoice and uses its receipts without duplication",async()=>{
  const f=await fixture("USD",150000);
  const inv=(await q("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency) VALUES($1,$2,$3,'USD') RETURNING id",[`OLD-${++serial}`,f.patientId,f.total])).rows[0].id;
  const p=await db.recordPayment({patientId:f.patientId,invoiceId:inv,planId:null,openingCurrency:null,kind:"payment",amountMinor:50000,currency:"USD",baseCurrency:"YER",exchangeRate:530,method:"cash",note:null,createdBy:session.username});expect(p.reason).toBeFalsy();
  await approveAgreement({...approval(f),source:{kind:"invoice",invoiceId:inv}});
  expect(await db.getPlan(f.planId,"2026-10-18")).toMatchObject({paidMinor:50000,approvedAgreement:{remainingMinor:100000}});
  await collectApprovedAgreement(collection(f,10000));expect((await db.patientLedger(f.patientId)).invoices).toHaveLength(1);
 });
 it("rejects obsolete installment and plan-only writers after approval",async()=>{
  const f=await fixture("SAR",30000);await approveAgreement(approval(f));
  expect(await db.recordPlanInstallment({planId:f.planId,patientId:f.patientId,installmentNumber:1,planTitle:"Synthetic",amountMinor:10000,currency:"SAR",baseCurrency:"YER",exchangeRate:140,method:"cash",note:null,createdBy:session.username})).toMatchObject({reason:"plan_financial_history_requires_review"});
  expect(await db.recordPayment({patientId:f.patientId,planId:f.planId,invoiceId:null,openingCurrency:null,amountMinor:10000,currency:"SAR",baseCurrency:"YER",exchangeRate:140,kind:"payment",method:"cash",note:null,createdBy:session.username})).toMatchObject({reason:"invalid_plan_target"});
  expect((await db.patientLedger(f.patientId)).invoices).toHaveLength(1);
 });
 it("refund restores remaining principal and recollection issues only a receipt",async()=>{
  const f=await fixture("SAR",30000);await approveAgreement(approval(f));const receipt=await collectApprovedAgreement(collection(f,14000));
  const refund=await db.recordPayment({patientId:f.patientId,invoiceId:null,planId:null,openingCurrency:null,kind:"refund",amountMinor:14000,currency:"SAR",baseCurrency:"YER",exchangeRate:999,method:"cash",note:"Synthetic refund",createdBy:session.username,reversalOfId:receipt.paymentId});
  expect(refund.reason).toBeFalsy();expect((await approvedAgreementPosition(f.planId,"2026-10-18"))?.remainingMinor).toBe(30000);
  await collectApprovedAgreement(collection(f,14000));expect((await db.patientLedger(f.patientId)).invoices).toHaveLength(1);
  expect((await approvedAgreementPosition(f.planId,"2026-10-18"))?.remainingMinor).toBe(16000);
 });
 it("freezes source cancellation, price, and installments; permits clinical completion",async()=>{
  const f=await fixture("USD",150000);const {agreement}=await approveAgreement(approval(f));
  await expect(q("UPDATE invoices SET status='cancelled' WHERE id=$1",[agreement.invoice_id])).rejects.toThrow(/review/);
  await expect(q("UPDATE invoices SET discount_minor=100 WHERE id=$1",[agreement.invoice_id])).rejects.toThrow(/review/);
  await expect(q("UPDATE plan_installments SET amount_minor=1 WHERE plan_id=$1",[f.planId])).rejects.toThrow(/review/);
  await q("UPDATE treatment_plans SET status='completed' WHERE id=$1",[f.planId]);
  await collectApprovedAgreement(collection(f,10000));expect((await approvedAgreementPosition(f.planId,"2026-10-18"))?.remainingMinor).toBe(140000);
 });
 it("serializes distinct concurrent collections against the remaining source",async()=>{
  const f=await fixture("SAR",30000);await approveAgreement(approval(f));
  const results=await Promise.allSettled([collectApprovedAgreement(collection(f,20000)),collectApprovedAgreement(collection(f,20000))]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect((await approvedAgreementPosition(f.planId,"2026-10-18"))?.remainingMinor).toBe(10000);
 });
 it("uses current roles and refuses doctor, stale credentials, and stale-admin historical matching",async()=>{
  const f=await fixture("SAR",30000);
  await q("UPDATE users SET role='doctor' WHERE id=$1",[session.userId]);
  try{await expect(approveAgreement(approval(f))).rejects.toThrow(/صلاحية/);}finally{await q("UPDATE users SET role='admin' WHERE id=$1",[session.userId]);}
  await expect(approveAgreement({...approval(f),session:{...session,credentialVersion:"stale"}})).rejects.toThrow(/صلاحية/);
  await db.setPatientOpeningBalance({patientId:f.patientId,currency:"SAR",amountMinor:20000,asOfDate:"2026-09-01",note:null,createdBy:session.username,reason:"Synthetic opening"});
  await q("UPDATE users SET role='reception' WHERE id=$1",[session.userId]);
  try{await expect(approveAgreement({...approval(f),source:{kind:"opening",historicalPaidMinor:10000}})).rejects.toThrow(/صلاحية|للإدارة/);}finally{await q("UPDATE users SET role='admin' WHERE id=$1",[session.userId]);}
 });
 it("reports the same source once and uses reference paid from an opening match",async()=>{
  const f=await fixture("USD",150000);await db.setPatientOpeningBalance({patientId:f.patientId,currency:"USD",amountMinor:100000,asOfDate:"2026-09-01",note:null,createdBy:session.username,reason:"Synthetic historic opening"});
  await approveAgreement({...approval(f),source:{kind:"opening",historicalPaidMinor:50000}});await collectApprovedAgreement(collection(f,10000));
  const {buildReport,parseFilters}=await import("../../lib/reports");const result=await buildReport("debt",parseFilters(new URLSearchParams({preset:"custom",from:"2026-01-01",to:"2099-12-31",patientId:String(f.patientId)})));
  expect(result.rows).toEqual([expect.objectContaining({currency:"USD",balanceMinor:90000,planPaidMinor:60000})]);
 });
});

it("covers approved clinical work without installments and accrues commission once",async()=>{
 const f=await fixture("YER",300000,false);
 await q("DELETE FROM plan_installments WHERE plan_id=$1",[f.planId]);
 const doctor=(await q("INSERT INTO parties(kind,name,commission_percent) VALUES('doctor','Synthetic approved doctor',30) RETURNING id")).rows[0].id;
 const service=(await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('Synthetic approved service',300000,TRUE,TRUE,'ortho') RETURNING id")).rows[0].id;
 const item=(await q("INSERT INTO plan_items(plan_id,service_id,service_name,quantity,unit_price_minor,doctor_id,billing_rule,session_count) VALUES($1,$2,'Synthetic approved service',1,300000,$3,'per_session',3) RETURNING id",[f.planId,service,doctor])).rows[0].id;
 await db.recordPlanConsent({planId:f.planId,actor:session.username,note:null});await approveAgreement(approval(f));
 const before=(await db.commissionReport("2026-01-01","2099-12-31")).find(r=>r.doctorId===doctor&&r.currency==="YER");expect(before).toMatchObject({accruedMinor:90000,earnedMinor:0});
 await collectApprovedAgreement(collection(f,100000));
 expect((await db.commissionReport("2026-01-01","2099-12-31")).find(r=>r.doctorId===doctor&&r.currency==="YER")).toMatchObject({accruedMinor:90000,earnedMinor:30000});
 const visit=await db.addVisit({patientName:"Synthetic",patientPhone:null,note:null,patientId:f.patientId});
 await q("UPDATE visits SET doctor_id=$2,diagnosis='Synthetic follow-up' WHERE id=$1",[visit.id,doctor]);
 await db.setVisitProcedures({visitId:visit.id,procedures:[{serviceId:service,toothCode:null,surfaces:null,quantity:1,unitPriceMinor:100000,priceReason:null,doctorId:doctor,note:null,planItemId:item}]});
 expect((await db.getClinicalVisit(visit.id))?.sessionPricing[0]).toMatchObject({priceMinor:0});
 const signed=await db.signClinicalVisit({visitId:visit.id,baseCurrency:"YER",signedBy:"doctor"});expect(signed).toMatchObject({reason:null,invoiceId:null,duesMinor:0});
 expect((await db.patientLedger(f.patientId)).invoices).toHaveLength(1);
 await expect(q("INSERT INTO plan_items(plan_id,service_name,quantity,unit_price_minor) VALUES($1,'Unapproved addition',1,5000)",[f.planId])).rejects.toThrow(/approval/);
});

it("restores approved sources, frozen terms, receipts and completed plans with triggers enabled",async()=>{
 const {Pool}=await import("pg");const {migrate}=await import("../../lib/migrations");
 const {execFile}=await import("node:child_process");const {promisify}=await import("node:util");
 const {mkdtemp,writeFile,rm}=await import("node:fs/promises");const {join}=await import("node:path");const {tmpdir}=await import("node:os");
 const url=await createIsolatedDatabase("aqlan_approved_agreement_restore_test");const target=new Pool({connectionString:url,ssl:false});const directory=await mkdtemp(join(tmpdir(),"approved-restore-"));
 try{
  const before=(await q("SELECT to_jsonb(a)::text AS value FROM approved_agreement_principals a ORDER BY plan_id")).rows;
  let sql="";for await(const line of db.backupSqlLines())sql+=line;
  const path=join(directory,"backup.sql");await writeFile(path,sql);
  await migrate(target,{apply:true});
  await promisify(execFile)(process.execPath,["scripts/restore.mjs",path],{env:{...process.env,DATABASE_URL:url,SKIP_SEED:"true"},maxBuffer:4*1024*1024});
  expect((await target.query("SELECT to_jsonb(a)::text AS value FROM approved_agreement_principals a ORDER BY plan_id")).rows).toEqual(before);
  expect((await target.query("SELECT id,visit_id FROM plan_items ORDER BY id")).rows).toEqual((await q("SELECT id,visit_id FROM plan_items ORDER BY id")).rows);
  expect((await target.query("SELECT count(*)::int AS count FROM payments")).rows).toEqual((await q("SELECT count(*)::int AS count FROM payments")).rows);
  await expect(target.query("UPDATE approved_agreement_principals SET reason='changed'")).rejects.toThrow(/immutable/);
 }finally{await target.end();await rm(directory,{recursive:true,force:true});}
},180000);
it("uses inclusive due dates and propagates settlement read errors instead of showing zero",async()=>{
 const f=await fixture("USD",150000);await approveAgreement(approval(f));
 expect((await approvedAgreementPosition(f.planId,"2026-09-30"))?.dueNowMinor).toBe(0);
 expect((await approvedAgreementPosition(f.planId,"2026-10-01"))?.dueNowMinor).toBe(75000);
 await collectApprovedAgreement(collection(f,50000));
 expect((await approvedAgreementPosition(f.planId,"2026-10-01"))?.dueNowMinor).toBe(25000);
 expect((await approvedAgreementPosition(f.planId,"2026-12-01"))?.dueNowMinor).toBe(100000);
 const pool=db.getPool(),connect=pool.connect.bind(pool);let restore:(()=>void)|undefined;
 const spy=vi.spyOn(pool,"connect").mockImplementationOnce(async()=>{
  const client=await connect(),query=client.query.bind(client);
  const failing=vi.spyOn(client,"query").mockImplementation((sql,values)=>{
   if(String(sql).includes("FROM payments WHERE invoice_id=ANY"))return Promise.reject(new Error("synthetic receipt read unavailable"));
   return query(sql,values);
  });restore=()=>failing.mockRestore();return client;
 });
 try{await expect(approvedAgreementPosition(f.planId,"2026-10-18")).rejects.toThrow("synthetic receipt read unavailable");}finally{restore?.();spy.mockRestore();}
});

it.each(["invoice","opening"] as const)("all writers guard approved %s source and mixed-target concurrency",async kind=>{
 const f=await fixture("SAR",30000);
 if(kind==="opening")await db.setPatientOpeningBalance({patientId:f.patientId,currency:"SAR",amountMinor:30000,asOfDate:"2026-09-01",note:null,createdBy:session.username,reason:"Synthetic source"});
 const {agreement}=await approveAgreement({...approval(f),source:kind==="opening"?{kind:"opening",historicalPaidMinor:0}:{kind:"new"}});
 const direct=(amountMinor:number,key?:string)=>db.recordPayment({patientId:f.patientId,invoiceId:agreement.invoice_id,planId:null,openingCurrency:agreement.opening_currency,kind:"payment",amountMinor,currency:"SAR",baseCurrency:"YER",exchangeRate:140,method:"cash",note:null,createdBy:session.username,idempotencyKey:key});
 await expect.soft(direct(10000)).rejects.toThrow(/مفتاح/);
 await expect.soft(direct(31000,`over-review-${++serial}`)).rejects.toThrow(/يتجاوز/);
 const results=await Promise.allSettled([collectApprovedAgreement(collection(f,20000)),direct(20000,`mixed-review-${++serial}`)]);
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
 expect((await approvedAgreementPosition(f.planId,"2026-10-18"))?.remainingMinor).toBe(10000);
});

it("serializes direct approved SAR collection with addOnly USD opening before the FK/table lock cycle",async()=>{
 const f=await fixture("SAR",30000);const {agreement}=await approveAgreement(approval(f));
 const pool=db.getPool(),connect=pool.connect.bind(pool);
 let openingLocked=false,receiptReached=false,releaseOpening!:()=>void;
 const openingGate=new Promise<void>(resolve=>{releaseOpening=resolve;});
 const restores=new Map<object,()=>void>();const writes:Promise<unknown>[]=[];
 const hookConnection=async()=>{
  const client=await connect();
  const query=client.query.bind(client);
  const hooked=vi.spyOn(client,"query").mockImplementation(async(sql,values)=>{
   const text=String(sql);
   if(text.includes("FROM patients WHERE id = $1 FOR UPDATE")&&values?.[0]===f.patientId){
    const result=await query(sql,values);openingLocked=true;await openingGate;return result;
   }
   // Old code reaches INSERT with opening-table SHARE held. Fixed code waits
   // at the patient fence before acquiring the shift or opening-table locks.
   if((/FROM patients WHERE id = \$1 FOR KEY SHARE/.test(text)||/INSERT INTO payments\s*\(/.test(text))&&values?.[0]===f.patientId)receiptReached=true;
   return query(sql,values);
  });
  const release=client.release.bind(client);
  const released=vi.spyOn(client,"release").mockImplementation(()=>{hooked.mockRestore();released.mockRestore();release();});
  restores.set(client,()=>{hooked.mockRestore();released.mockRestore();});return client;
 };
 const spy=vi.spyOn(pool,"connect").mockImplementationOnce(hookConnection).mockImplementationOnce(hookConnection);
 try{
  writes.push(db.setPatientOpeningBalance({patientId:f.patientId,currency:"USD",amountMinor:7000,asOfDate:"2026-10-01",note:null,createdBy:session.username,addOnly:true,expectedBefore:null}));
  void writes[0].catch(()=>{});
  await expect.poll(()=>openingLocked,{timeout:5000}).toBe(true);
  writes.push(db.recordPayment({patientId:f.patientId,invoiceId:agreement.invoice_id,planId:null,openingCurrency:null,kind:"payment",amountMinor:10000,currency:"SAR",baseCurrency:"YER",exchangeRate:140,method:"cash",note:null,createdBy:session.username,idempotencyKey:`opening-race-${++serial}`}));
  void writes[1].catch(()=>{});
  await expect.poll(()=>receiptReached,{timeout:5000}).toBe(true);
  releaseOpening();
  const results=await Promise.allSettled(writes);
  expect(results.filter(r=>r.status==="rejected").map(r=>({code:r.reason.code,message:r.reason.message}))).toEqual([]);
  expect(results.map(r=>r.status)).toEqual(["fulfilled","fulfilled"]);
  expect(results[1]).toMatchObject({status:"fulfilled",value:{reason:null}});
 }finally{releaseOpening();await Promise.allSettled(writes);for(const restore of restores.values())restore();spy.mockRestore();}
 expect(await db.getPatientOpeningBalance(f.patientId,"USD")).toMatchObject({amountMinor:7000});
 expect((await approvedAgreementPosition(f.planId,"2026-10-18"))?.remainingMinor).toBe(20000);
 expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1",[f.patientId])).rows[0].n).toBe(1);
});

it("refuses new principal for a plan session already billed through clinical signing",async()=>{
 const f=await fixture("YER",300000,false);await q("DELETE FROM plan_installments WHERE plan_id=$1",[f.planId]);
 const doctor=(await q("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic prior performer') RETURNING id")).rows[0].id;
 const service=(await q("INSERT INTO services(name,price_minor,is_active,price_configured) VALUES('Synthetic prior session',300000,TRUE,TRUE) RETURNING id")).rows[0].id;
 const item=(await q("INSERT INTO plan_items(plan_id,service_id,service_name,quantity,unit_price_minor,doctor_id,billing_rule,session_count) VALUES($1,$2,'Synthetic prior session',1,300000,$3,'per_session',3) RETURNING id",[f.planId,service,doctor])).rows[0].id;
 await q("INSERT INTO treatment_sessions(plan_item_id,sequence) SELECT $1,n FROM generate_series(1,3) AS n",[item]);
 await db.recordPlanConsent({planId:f.planId,actor:session.username,note:null});
 const visit=await db.addVisit({patientName:"Synthetic",patientPhone:null,note:null,patientId:f.patientId});await q("UPDATE visits SET doctor_id=$2,diagnosis='Synthetic prior treatment' WHERE id=$1",[visit.id,doctor]);
 await db.setVisitProcedures({visitId:visit.id,procedures:[{serviceId:service,toothCode:null,surfaces:null,quantity:1,unitPriceMinor:100000,priceReason:null,doctorId:doctor,note:null,planItemId:item}]});
 const signed=await db.signClinicalVisit({visitId:visit.id,baseCurrency:"YER",signedBy:"doctor"});expect(signed.invoiceId).toBeGreaterThan(0);
 await expect(approveAgreement(approval(f))).rejects.toThrow(/سابق|مطابقة/);
 expect((await db.patientLedger(f.patientId)).invoices).toHaveLength(1);
});
it("matches corrected invoice lineage in plan, ledger and report without counting ancestor receipt twice",async()=>{
 const f=await fixture("USD",150000);
 const inv=(await q("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency) VALUES($1,$2,160000,'USD') RETURNING id",[`ANCESTOR-${++serial}`,f.patientId])).rows[0].id;
 const line=(await q("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Synthetic original',1,160000,160000) RETURNING id",[inv])).rows[0].id;
 await db.recordPayment({patientId:f.patientId,invoiceId:inv,planId:null,openingCurrency:null,kind:"payment",amountMinor:50000,currency:"USD",baseCurrency:"YER",exchangeRate:530,method:"cash",note:null,createdBy:session.username});
 const revision=await import("../../lib/invoice-revision-db");const view=await revision.readInvoiceRevision(inv,session);
 const correction=await revision.reviseInvoice(inv,{idempotencyKey:`lineage-review-${++serial}`,expectedSourceHash:view.sourceHash,reason:"Synthetic price correction",lines:[{itemId:line,quantity:1,unitPrice:"1500"}],discount:"0",discountReason:null,repaymentTerms:{mode:"full",installments:[]},expectedRemainingMinor:100000},session);
 if(!("corrected" in correction)||!correction.corrected)throw new Error("correction failed");
 await approveAgreement({...approval(f),source:{kind:"invoice",invoiceId:correction.corrected.id}});
 expect(await approvedAgreementPosition(f.planId,"2026-10-18")).toMatchObject({paidMinor:50000,remainingMinor:100000});
 expect((await db.computeDebtRows([f.patientId])).find(r=>r.currency==="USD")?.dueMinor).toBe(100000);
 const {buildReport,parseFilters}=await import("../../lib/reports");const result=await buildReport("debt",parseFilters(new URLSearchParams({preset:"custom",from:"2026-01-01",to:"2099-12-31",patientId:String(f.patientId)})));
 expect(result.rows).toEqual([expect.objectContaining({currency:"USD",balanceMinor:100000,paidMinor:50000,planPaidMinor:50000})]);
 const statement=await buildReport("patient-statement",parseFilters(new URLSearchParams({preset:"custom",from:"2026-01-01",to:"2099-12-31",patientId:String(f.patientId)})));
 expect(statement.kpis.find(k=>k.key==="balance-USD")?.minor).toBe(100000);
 const before=await buildReport("patient-statement",parseFilters(new URLSearchParams({preset:"custom",from:"2025-01-01",to:"2025-12-31",patientId:String(f.patientId)})));
 expect(before.rows??[]).toHaveLength(0);
});

it.each(["approved", "direct_installments"] as const)("refuses unlinked single-session work already covered by %s", async (funding) => {
 const f=await fixture("SAR",150000,false);
 if(funding==="approved") await q("DELETE FROM plan_installments WHERE plan_id=$1",[f.planId]);
 const doctor=(await q("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic single-session doctor') RETURNING id")).rows[0].id;
 const service=(await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('Synthetic single-session service',150000,TRUE,TRUE,'general') RETURNING id")).rows[0].id;
 const item=(await q("INSERT INTO plan_items(plan_id,service_id,service_name,quantity,unit_price_minor,doctor_id,billing_rule,session_count) VALUES($1,$2,'Synthetic single-session service',1,150000,$3,'per_session',1) RETURNING id",[f.planId,service,doctor])).rows[0].id;
 await db.recordPlanConsent({planId:f.planId,actor:session.username,note:null});
 if(funding==="approved") await approveAgreement(approval(f));
 const visit=await db.addVisit({patientName:"Synthetic",patientPhone:null,note:null,patientId:f.patientId});
 await q("UPDATE visits SET doctor_id=$2,diagnosis='Synthetic single-session',billing_currency='SAR' WHERE id=$1",[visit.id,doctor]);
 await db.setVisitProcedures({visitId:visit.id,procedures:[{serviceId:service,toothCode:null,surfaces:null,quantity:1,unitPriceMinor:150000,priceReason:null,doctorId:doctor,note:null,planItemId:null}]});
 const before=await db.patientLedger(f.patientId);
 const result=await db.signClinicalVisit({visitId:visit.id,baseCurrency:"SAR",signedBy:session.username});
 const after=await db.patientLedger(f.patientId);
 const state=(await q("SELECT status,billing_status FROM plan_items WHERE id=$1",[item])).rows[0];
 expect(result.reason).toBe("plan_session_unlinked");
 expect(after.invoices).toEqual(before.invoices);
 expect(state.status).toBe("planned");
});
