import {afterAll,beforeAll,expect,it} from 'vitest';
import {assertRealPostgresUrl,stubPostgresEnv,createIsolatedDatabase} from './_setup';
import {DEFAULT_SPECIALTY_TEMPLATES} from '../../lib/specialty-templates';
import type {SessionPayload} from '../../lib/auth';
import type {Currency} from '../../lib/money';
assertRealPostgresUrl();stubPostgresEnv();
process.env.DATABASE_URL=await createIsolatedDatabase('aqlan_plan_position_test');
const db=await import('../../lib/db'),auth=await import('../../lib/auth');
const {createLinkedInvoice}=await import('../../lib/invoice-linkage-db');
const {saveDebtRepayment}=await import('../../lib/debt-installments-db');
const {collectDebtInstallment}=await import('../../lib/debt-installment-collection');
const {approveAgreement,collectApprovedAgreement}=await import('../../lib/approved-agreements');
const q=async(sql:string,params:unknown[]=[]) => (await db.getPool().query(sql,params)).rows;
let session:SessionPayload;let serial=0;
beforeAll(async()=>{
 await db.ensureSchema();const hash=await auth.hashPassword('synthetic-plan-regression');
 const [user]=await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('plan-read-test','Synthetic',$1,'admin',TRUE) RETURNING id",[hash]);
 session={userId:user.id,username:'plan-read-test',role:'admin',credentialVersion:auth.sessionCredentialVersion(hash),expiresAt:Date.now()+3600000};
 await db.openShift({openedBy:session.username,opening:{YER:0,SAR:0,USD:0}});
 await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
},180000);
afterAll(async()=>db.resetPoolForTesting());
async function fixture(currency:Currency){
 const n=++serial;
 const [patient]=await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic plan') RETURNING id",[`READ-${n}`]);
 const [doctor]=await q("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic provider') RETURNING id");
 const [service]=await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('Synthetic RCT',1000,TRUE,TRUE,'rct') RETURNING id");
 const created=await createLinkedInvoice({patientId:patient.id,baseCurrency:currency,discountMinor:0,note:null,createdBy:session.username,actorRole:'admin',items:[{serviceId:service.id,category:'rct',doctorId:doctor.id,description:'Synthetic RCT',quantity:1,unitPriceMinor:1000,toothCode:36,caseId:null,sessions:null,surfaces:null,episodeTeeth:null,scope:null}],templates:DEFAULT_SPECIALTY_TEMPLATES,idempotencyKey:null,requestHash:null,auditDetails:{}});
 if(!created.ok||created.planId===null)throw Error('Fixture invoice linkage failed');
 const target={patientId:patient.id,currency,invoiceId:created.invoice.id,openingCurrency:null};
 const schedule=await saveDebtRepayment({target,terms:{mode:'installments',installments:[{dueDate:'2026-10-01',amountMinor:1000,kind:'installment'}]},expectedVersion:0,expectedRemainingMinor:1000,reason:'Synthetic schedule',idempotencyKey:`plan-schedule-${n}`,session});
 const collect=(amountMinor:number)=>collectDebtInstallment({patientId:patient.id,arrangementId:schedule.arrangementId,amountMinor,idempotencyKey:`plan-collect-${++serial}`,currency,expectedVersion:1,method:'cash',note:null,session});
 return {patientId:patient.id,planId:created.planId,invoiceId:created.invoice.id,currency,schedule,target,collect};
}
it.each(['YER','SAR','USD'] as const)('reads %s invoice-first settlement once, including partial/full refunds',async currency=>{
 const f=await fixture(currency);const paid=await f.collect(400);const plan=await db.getPlan(f.planId,'2026-10-19');
 expect(plan).toMatchObject({paidMinor:400,progress:{paidMinor:400,remainingMinor:600,overdueMinor:600},installments:[],invoiceFinancial:{kind:'invoice_backed'}});
 expect(plan!.invoiceFinancial!.schedules).toHaveLength(1);
 const summary=await db.patientWorkflow(f.patientId,'2026-10-19');
 expect(summary.financial?.byCurrency[currency]).toMatchObject({balanceMinor:600,approvedAgreements:null,classicInstallments:null});
 const refund=async(amountMinor:number)=>db.recordPayment({patientId:f.patientId,invoiceId:f.invoiceId,kind:'refund',amountMinor,currency,baseCurrency:'YER',exchangeRate:paid.payment!.exchangeRate,method:'cash',note:null,createdBy:session.username,reversalOfId:paid.payment!.id,idempotencyKey:`plan-refund-${++serial}`});
 expect((await refund(100)).reason).toBeNull();expect((await db.getPlan(f.planId,'2026-10-19'))?.paidMinor).toBe(300);
 expect((await refund(300)).reason).toBeNull();expect((await db.getPlan(f.planId,'2026-10-19'))?.progress.remainingMinor).toBe(1000);
});
it('uses revision-relative settlement instead of spending earlier receipts twice',async()=>{
 const f=await fixture('YER');await f.collect(400);
 await saveDebtRepayment({target:f.target,terms:{mode:'installments',installments:[{dueDate:'2026-10-01',amountMinor:600,kind:'installment'}]},expectedVersion:1,expectedRemainingMinor:600,reason:'Synthetic revision',idempotencyKey:`plan-revise-${++serial}`,session});
 const plan=await db.getPlan(f.planId,'2026-10-19');expect(plan?.progress.overdueMinor).toBe(600);expect(plan?.invoiceFinancial?.schedules[0].progress?.settledSinceRevisionMinor).toBe(0);
});
it('reads a fully collected source without creating or rewriting financial rows',async()=>{
 const f=await fixture('YER');await f.collect(1000);
 const before=await q('SELECT (SELECT count(*) FROM invoices)::int AS invoices,(SELECT count(*) FROM payments)::int AS payments,(SELECT count(*) FROM debt_repayment_revisions)::int AS revisions');
 expect((await db.getPlan(f.planId,'2026-10-19'))?.progress.remainingMinor).toBe(0);
 await db.listPatientPlans(f.patientId,'2026-10-19');await db.listActivePlans('2026-10-19');
 expect(await q('SELECT (SELECT count(*) FROM invoices)::int AS invoices,(SELECT count(*) FROM payments)::int AS payments,(SELECT count(*) FROM debt_repayment_revisions)::int AS revisions')).toEqual(before);
});
it.each(['YER','SAR','USD'] as const)('retains approved %s principal authority and draft distinction',async currency=>{
 const [patient]=await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic approved') RETURNING id",[`APP-READ-${++serial}`]);
 const p=await db.createPlanV2({patientId:patient.id,title:'Synthetic agreement',specialty:null,primaryDoctorId:null,billingMode:'installments',baseCurrency:currency,startDate:'2026-10-01',note:null,createdBy:session.username,items:[],installments:[{dueDate:'2026-10-01',amountMinor:1000}]});
 if(!p.ok)throw Error(p.message);
 expect((await db.getPlan(p.planId,'2026-10-19'))?.debtSource).toBeNull();
 await db.recordPlanConsent({planId:p.planId,actor:session.username,note:null});
 await approveAgreement({planId:p.planId,expectedTotalMinor:1000,currency,source:{kind:'new'},reason:'Synthetic approval',idempotencyKey:`plan-approve-${++serial}`,session});
 await collectApprovedAgreement({planId:p.planId,amountMinor:400,currency,method:'cash',note:null,idempotencyKey:`plan-approved-pay-${++serial}`,session});
 expect(await db.getPlan(p.planId,'2026-10-19')).toMatchObject({paidMinor:400,invoiceFinancial:null,debtSource:'approved_agreement',approvedAgreement:{paidMinor:400,remainingMinor:600},progress:{remainingMinor:600}});
});
it('preserves the classic installment writer after a first partial receipt',async()=>{
 const [patient]=await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic classic') RETURNING id",[`CLASSIC-${++serial}`]);
 const p=await db.createPlanV2({patientId:patient.id,title:'Synthetic classic',specialty:null,primaryDoctorId:null,billingMode:'installments',baseCurrency:'YER',startDate:'2026-10-01',note:null,createdBy:session.username,items:[],installments:[{dueDate:'2026-10-01',amountMinor:400},{dueDate:'2026-11-01',amountMinor:600}]});
 if(!p.ok)throw Error(p.message);
 const pay=(amountMinor:number,installmentNumber:number)=>db.recordPlanInstallment({planId:p.planId,patientId:patient.id,installmentNumber,planTitle:'Synthetic classic',amountMinor,currency:'YER',baseCurrency:'YER',exchangeRate:1,method:'cash',note:null,createdBy:session.username,actorRole:'admin',idempotencyKey:`classic-${++serial}`});
 expect(await pay(400,1)).not.toHaveProperty('reason');
 expect(await db.getPlan(p.planId,'2026-10-19')).toMatchObject({invoiceFinancial:null,debtSource:'classic_installments',paidMinor:400,progress:{remainingMinor:600}});
 expect(await pay(600,2)).not.toHaveProperty('reason');
 expect((await db.getPlan(p.planId,'2026-10-19'))?.progress.remainingMinor).toBe(0);
});
it('follows documented invoice corrections and receipt replacement without counting ancestors twice',async()=>{
 const f=await fixture('YER');const paid=await f.collect(400);
 const revision=await import('../../lib/invoice-revision-db');
 const view=await revision.readInvoiceRevision(f.invoiceId,session);
 const result=await revision.reviseInvoice(f.invoiceId,{idempotencyKey:`plan-correction-${++serial}`,expectedSourceHash:view.sourceHash,reason:'Synthetic corrected invoice',lines:view.invoice.items.map(item=>({itemId:item.id,quantity:1,unitPrice:'900'})),discount:'0',repaymentTerms:{mode:'full',installments:[]},expectedRemainingMinor:500},session);
 expect(result).toHaveProperty('corrected');
 expect(await db.getPlan(f.planId,'2026-10-19')).toMatchObject({paidMinor:400,progress:{totalMinor:900,remainingMinor:500}});
 const corrected=await db.correctPayment({paymentId:paid.payment!.id,reason:'Synthetic receipt replacement',actor:session.username,actorRole:'admin',idempotencyKey:`plan-receipt-${++serial}`,replacement:{amountMinor:300,currency:'YER',exchangeRate:1,method:'cash',target:{kind:'explicit',invoiceId:('corrected' in result ? result.corrected?.id : null)??null,planId:null,openingCurrency:null}}});
 expect(corrected.reason).toBeNull();
 expect(await db.getPlan(f.planId,'2026-10-19')).toMatchObject({paidMinor:300,progress:{remainingMinor:600}});
});
it('refuses to attribute a shared invoice and unrelated direct plan receipts',async()=>{
 const f=await fixture('YER');
 await q("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Unassigned synthetic fee',1,1,1)",[f.invoiceId]);
 expect((await db.getPlan(f.planId,'2026-10-19'))?.invoiceFinancial?.kind).toBe('review_required');
});
it('reads a proven YER-to-SAR reclassification at recorded receipt value',async()=>{
 const f=await fixture('YER');
 const receipt=await db.recordPayment({patientId:f.patientId,invoiceId:f.invoiceId,kind:'payment',amountMinor:100,currency:'SAR',baseCurrency:'YER',exchangeRate:140,method:'cash',note:null,createdBy:session.username,idempotencyKey:`plan-fx-${++serial}`});expect(receipt.reason).toBeNull();
 const revision=await import('../../lib/invoice-revision-db');const view=await revision.readInvoiceRevision(f.invoiceId,session);
 await revision.reviseInvoice(f.invoiceId,{idempotencyKey:`plan-fx-revise-${++serial}`,expectedSourceHash:view.sourceHash,currency:'SAR',reason:'Synthetic recorded currency correction',lines:view.invoice.items.map(item=>({itemId:item.id,quantity:1,unitPrice:'1000'})),discount:'0',repaymentTerms:{mode:'full',installments:[]},expectedRemainingMinor:99900},session);
 await q("UPDATE settings SET value='999' WHERE key='finance.rate.SAR'");
 expect(await db.getPlan(f.planId,'2026-10-19')).toMatchObject({baseCurrency:'SAR',paidMinor:100,progress:{totalMinor:100000,remainingMinor:99900}});
 await q("UPDATE settings SET value='140' WHERE key='finance.rate.SAR'");
});
it('does not double count a receipt bearing both explicit plan and invoice references',async()=>{
 const f=await fixture('YER');
 await q(`INSERT INTO payments(receipt_number,patient_id,invoice_id,plan_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by)
 VALUES($1,$2,$3,$4,(SELECT id FROM cashier_shifts WHERE status='open' LIMIT 1),'payment',400,'YER',1,400,'YER','cash','synthetic')`,[`PLAN-DUAL-${++serial}`,f.patientId,f.invoiceId,f.planId]);
 expect(await db.getPlan(f.planId,'2026-10-19')).toMatchObject({paidMinor:400,progress:{remainingMinor:600}});
});
it('keeps cancelled invoice principal out of current plan debt',async()=>{
 const f=await fixture('YER');await q("UPDATE invoices SET status='cancelled' WHERE id=$1",[f.invoiceId]);
 expect(await db.getPlan(f.planId,'2026-10-19')).toMatchObject({invoiceFinancial:{kind:'invoice_backed'},progress:{totalMinor:0,remainingMinor:0,overdueMinor:0}});
});

it('suppresses source-drift schedule progress after unrelated account credit',async()=>{
 const f=await fixture('YER');
 const paid=await db.recordPayment({patientId:f.patientId,invoiceId:null,kind:'payment',amountMinor:100,currency:'YER',baseCurrency:'YER',exchangeRate:1,method:'cash',note:null,createdBy:session.username,idempotencyKey:`drift-${++serial}`});
 expect(paid.reason).toBeNull();
 const {readDebtRepayments}=await import('../../lib/debt-installments-db');
 const client=await db.getPool().connect();
 try { const [raw]=await readDebtRepayments(client,f.patientId,'2026-10-19');expect(raw.requiresReview).toBe(true);expect(raw.progress).not.toBeNull(); } finally {client.release();}
 const plan=await db.getPlan(f.planId,'2026-10-19');
 expect(plan).toMatchObject({debtSource:'invoice',progress:{remainingMinor:1000,overdueMinor:0},invoiceFinancial:{schedules:[{requiresReview:true,progress:null}]}});
});

it('keeps statement-batched positions identical for all populated financial source cases',async()=>{
 const patients=await q('SELECT DISTINCT patient_id FROM treatment_plans ORDER BY patient_id');
 expect(patients.length).toBeGreaterThan(10);
 for(const {patient_id} of patients){
  const standalone=await db.listPatientPlans(patient_id,'2026-10-19');
  const snapshot=await db.patientStatementSnapshot(patient_id,'2026-10-19');
  expect(snapshot.plans).toEqual(standalone);
  expect(snapshot.planCurrencies).toEqual(await db.patientPlanCurrencies(patient_id));
 }
});
