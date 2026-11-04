import {withLegacyStaffReadOnlySnapshot} from "./legacy-staff-readonly-snapshot";
import { foreignRatesFromSettings } from "./service-pricing";
import { invoicePricingAudit } from "./invoice-price-settings-db";
import type {SessionPayload} from "./auth";
import {CLINIC_TIME_ZONE,ensureSchema,getPool,getSettingsInTransaction,setPatientOpeningBalanceInTx,clearPatientOpeningBalanceInTx,insertAuditRow,type DbClient,type Service} from "./db";
import {assertDebtSession,DebtRepaymentError,debtRequestHash,readDebtPosition,writeDebtRepaymentInTransaction} from "./debt-installments-db";
import {debtAccountDue,lockDebtAccountForSchedule} from "./debt-account-position";
import {openingBalanceAccess} from "./opening-access";
import {clinicDateString} from "./schedule";
import {effectiveTemplates} from "./specialty-templates";
import {caseSiteOverlaps,siteText} from "./invoice-clinical-linkage";
import {parseHistoricalDocument,parseHistoricalCorrection,historicalLineRequest,allocateHistoricalDiscount,type HistoricalDocumentInput,type HistoricalDocumentReceipt} from "./legacy-treatment-document";
import {decideLegacyTreatment,liveAgreementRemaining,writeLegacyDocumentLine,LegacyTreatmentWriteError} from "./legacy-treatment-db";
import {LEGACY_TREATMENT_MESSAGE} from "./legacy-treatment";
import {isCurrency,type Currency} from "./money";

function bad(message:string,code:"invalid"|"stale"|"conflict"|"unauthorized"|"missing"="invalid"):never {throw new DebtRepaymentError(code,message);}
const minor=(value:unknown)=>{const number=Number(value);if(!Number.isSafeInteger(number)||number<0)bad("المبلغ خارج النطاق الآمن.");return number;};
const actor=(session:SessionPayload)=>({userId:session.userId??null,username:session.username,role:session.role});
const target=(patientId:number,currency:Currency)=>({patientId,currency,invoiceId:null,openingCurrency:currency});

async function catalog(client:DbClient,source:Record<string,unknown>,lock:boolean){
  const ids=Array.isArray(source.items)?[...new Set(source.items.flatMap(value=>value&&typeof value==="object"&&!Array.isArray(value)&&Number.isSafeInteger(value.serviceId)?[value.serviceId]:[]))].sort((a,b)=>a-b):[];
  const {rows}=await client.query<{id:number;name:string;category:string|null;price_minor:string;price_sar_minor:string|null;price_usd_minor:string|null;price_configured:boolean;price_provisional:boolean;is_active:boolean;sort_order:number}>(
    `SELECT * FROM services WHERE id=ANY($1::int[]) ORDER BY id${lock?" FOR SHARE NOWAIT":""}`,[ids]);
  const services=new Map<number,Service>(rows.map(row=>[row.id,{id:row.id,name:row.name,category:row.category,priceMinor:minor(row.price_minor),
    priceSarMinor:row.price_sar_minor===null?null:minor(row.price_sar_minor),priceUsdMinor:row.price_usd_minor===null?null:minor(row.price_usd_minor),priceConfigured:row.price_configured,
    priceProvisional:row.price_provisional,isActive:row.is_active,sortOrder:row.sort_order}]));
  const doctors=new Set((await client.query<{id:number}>(`SELECT id FROM parties WHERE kind='doctor' ORDER BY id${lock?" FOR SHARE NOWAIT":""}`)).rows.map(row=>row.id));
  return {services,doctors};
}
async function currentScheduleVersion(client:DbClient,patientId:number,currency:Currency){
  const {rows:[row]}=await client.query<{version:number}>(`SELECT r.version FROM debt_repayment_arrangements a JOIN LATERAL
    (SELECT version FROM debt_repayment_revisions WHERE arrangement_id=a.id ORDER BY version DESC LIMIT 1) r ON TRUE
    WHERE a.patient_id=$1 AND a.opening_currency=$2`,[patientId,currency]);
  return row?.version??0;
}
async function openingEvidence(client:DbClient,patientId:number,currency:Currency,enforceOwnership=true){
  const position=await readDebtPosition(client,target(patientId,currency));
  const {rows:[opening]}=await client.query<{amount_minor:string;as_of_date:string;note:string|null}>("SELECT amount_minor::text,as_of_date::text,note FROM patient_opening_balances WHERE patient_id=$1 AND currency=$2",[patientId,currency]);
  const owned=(opening?minor(opening.amount_minor):0)===await liveAgreementRemaining(client,patientId,currency);
  if(enforceOwnership&&!owned)bad(LEGACY_TREATMENT_MESSAGE.opening_not_owned,"conflict");
  return {position,owned,opening:opening?{amountMinor:minor(opening.amount_minor),asOfDate:opening.as_of_date,note:opening.note}:null,
    sourceHash:position.available?position.sourceHash:null,scheduleVersion:await currentScheduleVersion(client,patientId,currency)};
}
async function unallocatedPaidGuard(client:DbClient,patientId:number,previouslyPaid:number){
  if(previouslyPaid<=0)return;
  const {rows}=await client.query(`SELECT p.id FROM payments p LEFT JOIN payments r ON r.reversal_of_id=p.id AND r.kind='refund' AND r.currency=p.currency
    WHERE p.patient_id=$1 AND p.kind='payment' AND p.invoice_id IS NULL AND p.plan_id IS NULL AND p.opening_currency IS NULL AND p.reversal_of_id IS NULL
    GROUP BY p.id,p.currency HAVING p.amount_minor>COALESCE(SUM(r.amount_minor),0)`,[patientId]);
  if(rows.length)bad(LEGACY_TREATMENT_MESSAGE.prior_receipts_review,"conflict");
}
function verifyPeriod(settings:Record<string,string>,dates:string[]){
  const cutoff=settings["finance.locked_before"]?.trim();if(cutoff&&dates.some(date=>date<cutoff))bad(LEGACY_TREATMENT_MESSAGE.period_locked,"conflict");
}
async function inputInTx(client:DbClient,patientId:number,source:Record<string,unknown>,session:SessionPayload,lock:boolean){
  if(lock)await client.query("LOCK TABLE settings IN SHARE MODE");
  const settings=await getSettingsInTransaction(client,{requireStoredExchangeRates:true});
  const access=openingBalanceAccess(session.role,settings["finance.reception_adds_opening_balance"]==="true");
  if(!access.add)bad("تغيّرت صلاحية تسجيل العلاج السابق ورصيده.","unauthorized");
  const {services,doctors}=await catalog(client,source,lock);
  const parsed=parseHistoricalDocument({...source,patientId},services,doctors,{today:clinicDateString(new Date(),CLINIC_TIME_ZONE),role:session.role,maxDiscountPercent:Number(settings["billing.max_discount_percent"]),rates:foreignRatesFromSettings(settings)});
  if(!parsed.ok)bad(parsed.message);
  const input=parsed.value;
  for(let index=0;index<input.lines.length;index++)if(input.lines.slice(0,index).some(prior=>prior.serviceId===input.lines[index].serviceId
    &&caseSiteOverlaps(siteText(prior.site),input.lines[index].site)))bad("يتكرر العمل نفسه ضمن الاتفاق؛ راجع الأسنان ونطاق البنود.","conflict");
  await unallocatedPaidGuard(client,patientId,input.previouslyPaidMinor);
  return {input,settings,access};
}

export async function readHistoricalDocumentInTx(client:DbClient,id:number,patientId:number,version?:number):Promise<HistoricalDocumentReceipt|null>{
  const {rows:[row]}=await client.query<{id:number;patient_id:number;currency:string;revision_id:number;version:number;created_by:string;idempotency_key:string;total_minor:string;discount_minor:string;discount_reason:string|null;previously_paid_minor:string;remaining_minor:string;historical_as_of:string;note:string|null;reason:string;lines:HistoricalDocumentReceipt["lines"];repayment_receipt:HistoricalDocumentReceipt["repayment"]}>(
    `SELECT d.id,d.patient_id,d.currency,r.id AS revision_id,r.version,r.created_by,r.idempotency_key,r.total_minor::text,r.discount_minor::text,r.discount_reason,
      r.previously_paid_minor::text,r.remaining_minor::text,r.historical_as_of::text,r.note,r.reason,r.lines,r.repayment_receipt
     FROM legacy_treatment_documents d JOIN LATERAL (SELECT * FROM legacy_treatment_document_revisions WHERE document_id=d.id
       AND ($3::int IS NULL OR version=$3) ORDER BY version DESC LIMIT 1) r ON TRUE WHERE d.id=$1 AND d.patient_id=$2`,[id,patientId,version??null]);
  if(!row)return null;if(!isCurrency(row.currency))bad("عملة الاتفاق غير صالحة.");
  return {id:row.id,version:row.version,revisionId:row.revision_id,patientId:row.patient_id,currency:row.currency,createdBy:row.created_by,idempotencyKey:row.idempotency_key,
    totalMinor:minor(row.total_minor),discountMinor:minor(row.discount_minor),discountReason:row.discount_reason,agreedMinor:minor(row.total_minor)-minor(row.discount_minor),previouslyPaidMinor:minor(row.previously_paid_minor),
    remainingMinor:minor(row.remaining_minor),historicalAsOf:row.historical_as_of,note:row.note,reason:row.reason,lines:row.lines,repayment:row.repayment_receipt};
}

export async function previewHistoricalDocument(patientId:number,source:Record<string,unknown>,session:SessionPayload){
  return withLegacyStaffReadOnlySnapshot(session,{
    allows:current=>["admin","reception"].includes(current.role),
    unauthorized:()=>new DebtRepaymentError("unauthorized","انتهت الجلسة أو تغيّرت صلاحية إدارة الاتفاق؛ سجّل الدخول من جديد."),
  },async client=>{
    if(!(await client.query("SELECT id FROM patients WHERE id=$1",[patientId])).rows.length)bad("المريض غير موجود.","missing");
    const {input,access,settings}=await inputInTx(client,patientId,source,session,false);
    const prior=await openingEvidence(client,patientId,input.currency);
    if(prior.opening&&!access.edit&&input.remainingMinor>0)bad(LEGACY_TREATMENT_MESSAGE.opening_edit_forbidden,"unauthorized");
    verifyPeriod(settings,[input.historicalAsOf,...(prior.opening?[prior.opening.asOfDate]:[])]);
    const lines=[];
    for(const line of input.lines){
      const decision=await decideLegacyTreatment(client,{patientId,request:historicalLineRequest(input,line),canEditOpening:access.edit},false);
      lines.push({serviceId:line.serviceId,site:decision.site,specialty:decision.specialty,planId:decision.masterId,case:decision.casePlan});
    }
    const remainingMinor=prior.position.remainingMinor+input.remainingMinor;
    const accountDueMinor=(await debtAccountDue(client,patientId,input.currency)).due+input.remainingMinor;
    return {patientId,currency:input.currency,lines,remainingMinor,accountDueMinor,sourceHash:prior.sourceHash,scheduleVersion:prior.scheduleVersion,
      requiresAllocationReview:remainingMinor>Math.max(0,accountDueMinor),openingPrincipalMinor:prior.position.principalMinor+input.remainingMinor};
  });
}

async function writeOpening(client:DbClient,input:{patientId:number;currency:Currency;after:number;asOf:string;reason:string;session:SessionPayload;prior:Awaited<ReturnType<typeof openingEvidence>>;addOnly:boolean;allowCredit?:boolean}){
  const {prior}=input;const before=prior.opening;
  if(!Number.isSafeInteger(input.after)||input.after<0||!input.allowCredit&&input.after<prior.position.settledMinor)bad("المتبقي المصحّح لا يغطي التحصيل المثبت؛ راجع السندات قبل تعديل أصل الدين.","conflict");
  if(input.after===(before?.amountMinor??0)&&(!before||input.asOf===before.asOfDate))return null;
  const historyId=input.after===0&&before?await clearPatientOpeningBalanceInTx(client,input.patientId,input.session.username,input.reason,input.currency,before)
    :(await setPatientOpeningBalanceInTx(client,{patientId:input.patientId,currency:input.currency,amountMinor:input.after,asOfDate:input.asOf,note:before?.note??input.reason,
      createdBy:input.session.username,reason:input.reason,expectedBefore:before,addOnly:input.addOnly}))?.historyId??null;
  if(historyId===null)bad("تعذّر إثبات تغيير الرصيد السابق.","stale");
  await insertAuditRow(client,{action:input.after===0?"opening_balance.clear":"opening_balance.set",entity:"patient",entityId:input.patientId,actor:input.session.username,actorRole:input.session.role,
    details:{source:"historical_document",beforeMinor:before?.amountMinor??0,afterMinor:input.after,currency:input.currency,reason:input.reason,historyId}});
  return historyId;
}
async function writeTerms(client:DbClient,input:Pick<HistoricalDocumentInput,"patientId"|"currency"|"repaymentRemainingMinor"|"repaymentVersion"|"repaymentTerms">,key:string,reason:string,session:SessionPayload){
  if(input.repaymentRemainingMinor===0&&input.repaymentVersion===0)return null;
  const written=await writeDebtRepaymentInTransaction(client,{target:target(input.patientId,input.currency),terms:input.repaymentTerms,expectedVersion:input.repaymentVersion,
    expectedRemainingMinor:input.repaymentRemainingMinor,cancel:input.repaymentRemainingMinor===0,reason,idempotencyKey:key,session});
  return {arrangementId:written.arrangementId,revisionId:written.revisionId,version:written.version,terms:input.repaymentTerms};
}
async function insertRevision(client:DbClient,input:{documentId:number;version:number;totalMinor:number;discountMinor:number;discountReason:string|null;previouslyPaidMinor:number;remainingMinor:number;
  historicalAsOf:string;lines:HistoricalDocumentReceipt["lines"];note:string|null;reason:string;openingHistoryId:number|null;repayment:HistoricalDocumentReceipt["repayment"];idempotencyKey:string;hash:string;session:SessionPayload}){
  await client.query(`INSERT INTO legacy_treatment_document_revisions(document_id,version,total_minor,discount_minor,discount_reason,previously_paid_minor,remaining_minor,
    historical_as_of,lines,note,reason,opening_history_id,repayment_receipt,idempotency_key,request_hash,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb,$14,$15,$16)`,
    [input.documentId,input.version,input.totalMinor,input.discountMinor,input.discountReason,input.previouslyPaidMinor,input.remainingMinor,input.historicalAsOf,JSON.stringify(input.lines),input.note,input.reason,
      input.openingHistoryId,input.repayment?JSON.stringify(input.repayment):null,input.idempotencyKey,input.hash,input.session.username]);
}

export async function createHistoricalDocument(patientId:number,source:Record<string,unknown>,session:SessionPayload){
  if(typeof source.idempotencyKey!=="string"||!/^[A-Za-z0-9._:-]{8,128}$/.test(source.idempotencyKey)||source.patientId!==patientId)bad("هوية المريض ومفتاح الاتفاق مطلوبان.");
  const hash=debtRequestHash({purpose:"historical-document-v1",patientId,source,actor:actor(session)});
  await ensureSchema();const client=await getPool().connect();
  try{
    await client.query("BEGIN");await assertDebtSession(client,session);
    if(!(await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE",[patientId])).rows.length)bad("المريض غير موجود.","missing");
    const {rows:[replay]}=await client.query<{id:number;request_hash:string;patient_id:number}>("SELECT id,request_hash,patient_id FROM legacy_treatment_documents WHERE idempotency_key=$1",[source.idempotencyKey]);
    if(replay){if(replay.request_hash!==hash||replay.patient_id!==patientId)bad("مفتاح الاتفاق مستعمل بطلب مختلف.","conflict");
      const document=await readHistoricalDocumentInTx(client,replay.id,patientId,1);if(!document)bad("لم يكتمل إيصال الاتفاق السابق؛ أعد نفس الطلب.","stale");
      await assertDebtSession(client,session);await client.query("COMMIT");return {document,replayed:true};}
    await lockDebtAccountForSchedule(client,patientId);
    const {input,settings,access}=await inputInTx(client,patientId,source,session,true);
    const prior=await openingEvidence(client,patientId,input.currency);
    if(prior.sourceHash!==input.repaymentSourceHash||prior.scheduleVersion!==input.repaymentVersion||prior.position.remainingMinor+input.remainingMinor!==input.repaymentRemainingMinor)bad("تغيّر الرصيد السابق أو جدول السداد؛ حدّث معاينة الاتفاق.","stale");
    if(prior.opening&&!access.edit&&input.remainingMinor>0)bad(LEGACY_TREATMENT_MESSAGE.opening_edit_forbidden,"unauthorized");
    verifyPeriod(settings,[input.historicalAsOf,...(prior.opening?[prior.opening.asOfDate]:[])]);
    const {rows:[document]}=await client.query<{id:number}>(`INSERT INTO legacy_treatment_documents(patient_id,currency,line_count,intent,idempotency_key,request_hash,created_by,created_role)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING id`,[patientId,input.currency,input.lines.length,JSON.stringify(source),input.idempotencyKey,hash,session.username,session.role]);
    const links:HistoricalDocumentReceipt["lines"]=[];
    const allocations=allocateHistoricalDiscount(input.lines.map(line=>line.unitPriceMinor),input.discountMinor);
    for(const [index,line] of input.lines.entries()){
      const saved=await writeLegacyDocumentLine(client,{patientId,request:historicalLineRequest(input,line),actor:session.username,actorRole:session.role,canEditOpening:access.edit,session,
        templates:effectiveTemplates(settings["plans.specialty_templates"]).templates},{documentId:document.id,line:index,doctorId:line.doctorId});
      if(!saved.ok)bad(LEGACY_TREATMENT_MESSAGE[saved.reason],"conflict");
      const {rows:[link]}=await client.query<{plan_item_id:number;plan_id:number;case_id:number|null}>("SELECT a.plan_item_id,i.plan_id,a.case_id FROM legacy_treatment_agreements a JOIN plan_items i ON i.id=a.plan_item_id WHERE a.id=$1",[saved.id]);
      links.push({agreementId:saved.id,planItemId:link.plan_item_id,planId:link.plan_id,caseId:link.case_id,serviceId:line.serviceId,doctorId:line.doctorId,description:line.description,toothCode:line.site.toothCode,site:line.site,unitPriceMinor:line.unitPriceMinor,...allocations[index]});
    }
    const reason=`تسجيل اتفاق تاريخي متعدد البنود #${document.id}`;
    const openingHistoryId=await writeOpening(client,{patientId,currency:input.currency,after:prior.position.principalMinor+input.remainingMinor,
      asOf:prior.opening&&(input.remainingMinor===0||prior.opening.asOfDate<input.historicalAsOf)?prior.opening.asOfDate:input.historicalAsOf,prior,reason,session,addOnly:!access.edit});
    const repayment=await writeTerms(client,input,`historical-document:${document.id}:v1`,reason,session);
    await insertRevision(client,{documentId:document.id,version:1,...input,lines:links,reason,openingHistoryId,repayment,hash,session});
    await insertAuditRow(client,{action:"legacy_document.create",entity:"patient",entityId:patientId,actor:session.username,actorRole:session.role,
      details:{documentId:document.id,currency:input.currency,agreedMinor:input.agreedMinor,previouslyPaidMinor:input.previouslyPaidMinor,remainingMinor:input.remainingMinor,discountMinor:input.discountMinor,discountReason:input.discountReason,
        invoicePriceSnapshots:invoicePricingAudit(input.pricingSnapshots??[]),lines:links,openingHistoryId,receiptsCreated:0,invoicesCreated:0,historicalCashMovement:0}});
    await assertDebtSession(client,session);const receipt=await readHistoricalDocumentInTx(client,document.id,patientId,1);await client.query("COMMIT");return {document:receipt!,replayed:false};
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);if(error instanceof LegacyTreatmentWriteError)bad(LEGACY_TREATMENT_MESSAGE[error.reason],"conflict");throw error;}finally{client.release();}
}

export async function correctHistoricalDocument(patientId:number,documentId:number,source:Record<string,unknown>,session:SessionPayload){
  if(session.role!=="admin")bad("تصحيح الحقائق التاريخية للمدير وحده.","unauthorized");
  if(typeof source.idempotencyKey!=="string"||!/^[A-Za-z0-9._:-]{8,128}$/.test(source.idempotencyKey))bad("مفتاح التصحيح مطلوب.");
  const hash=debtRequestHash({purpose:"historical-document-correction-v1",patientId,documentId,source,actor:actor(session)});
  await ensureSchema();const client=await getPool().connect();
  try{
    await client.query("BEGIN");await assertDebtSession(client,session);
    await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE",[patientId]);
    const {rows:[replay]}=await client.query<{document_id:number;version:number;request_hash:string}>("SELECT document_id,version,request_hash FROM legacy_treatment_document_revisions WHERE idempotency_key=$1",[source.idempotencyKey]);
    if(replay){if(replay.document_id!==documentId||replay.request_hash!==hash)bad("مفتاح التصحيح مستعمل بطلب مختلف.","conflict");
      const document=await readHistoricalDocumentInTx(client,documentId,patientId,replay.version);if(!document)bad("الاتفاق لا يخص هذا المريض.","missing");await assertDebtSession(client,session);await client.query("COMMIT");return {document,replayed:true};}
    await lockDebtAccountForSchedule(client,patientId);
    await client.query("SELECT id FROM plan_items WHERE plan_id IN (SELECT id FROM treatment_plans WHERE patient_id=$1) ORDER BY id FOR UPDATE",[patientId]);
    await client.query("SELECT id FROM legacy_treatment_documents WHERE id=$1 AND patient_id=$2 FOR UPDATE",[documentId,patientId]);
    const current=await readHistoricalDocumentInTx(client,documentId,patientId);if(!current)bad("الاتفاق غير موجود لهذا المريض.","missing");
    const parsed=parseHistoricalCorrection(source,current,clinicDateString(new Date(),CLINIC_TIME_ZONE));if(!parsed.ok)bad(parsed.message,"stale");
    const input=parsed.value;const prior=await openingEvidence(client,patientId,current.currency);
    if((prior.sourceHash??debtRequestHash(null))!==input.expectedSourceHash||prior.scheduleVersion!==input.repaymentVersion)bad("تغيّر الرصيد أو جدول السداد منذ القراءة.","stale");
    const after=prior.position.principalMinor-current.remainingMinor+input.remainingMinor;
    if(Math.max(0,after-prior.position.settledMinor)!==input.repaymentRemainingMinor)bad("جدول السداد لا يطابق المتبقي بعد التصحيح.","stale");
    await unallocatedPaidGuard(client,patientId,input.previouslyPaidMinor);
    await client.query("LOCK TABLE settings IN SHARE MODE");const settings=await getSettingsInTransaction(client,{requireStoredExchangeRates:true});
    verifyPeriod(settings,[current.historicalAsOf,input.historicalAsOf,...(prior.opening?[prior.opening.asOfDate]:[])]);
    const reason=`تصحيح الاتفاق التاريخي #${documentId}: ${input.reason}`.slice(0,300);
    // The opening is owned by the current positive historical facts. An old
    // revision date cannot remain authoritative after that fact is corrected.
    const {rows:[dates]}=await client.query<{as_of:string|null}>(`SELECT min(day)::text AS as_of FROM (
      SELECT historical_as_of AS day FROM legacy_treatment_agreements
        WHERE patient_id=$1 AND currency=$2 AND document_id IS NULL AND status='live' AND remaining_minor>0 AND opening_effect<>'none'
      UNION ALL SELECT r.historical_as_of FROM legacy_treatment_documents d JOIN LATERAL
        (SELECT historical_as_of,remaining_minor FROM legacy_treatment_document_revisions WHERE document_id=d.id ORDER BY version DESC LIMIT 1) r ON TRUE
        WHERE d.patient_id=$1 AND d.currency=$2 AND d.id<>$3 AND r.remaining_minor>0
      UNION ALL SELECT $4::date WHERE $5::bigint>0
    ) current_facts`,[patientId,current.currency,documentId,input.historicalAsOf,input.remainingMinor]);
    const openingHistoryId=await writeOpening(client,{patientId,currency:current.currency,after,asOf:dates.as_of??input.historicalAsOf,prior,reason,session,addOnly:false,allowCredit:true});
    const repayment=await writeTerms(client,{...input,patientId,currency:current.currency},`historical-document:${documentId}:v${current.version+1}`,reason,session);
    const allocations=allocateHistoricalDiscount(input.prices,input.discountMinor);
    const lines=current.lines.map((line,index)=>({...line,unitPriceMinor:input.prices[index],...allocations[index]}));
    await insertRevision(client,{...input,documentId,version:current.version+1,lines,reason:input.reason,openingHistoryId,repayment,hash,session});
    await insertAuditRow(client,{action:"legacy_document.correct",entity:"patient",entityId:patientId,actor:session.username,actorRole:session.role,
      details:{documentId,version:current.version+1,reason:input.reason,before:current,after:{...input,lines},openingHistoryId,receiptsPreserved:true,clinicalIdentitiesPreserved:true,
        accountCreditMinor:Math.max(0,-(await debtAccountDue(client,patientId,current.currency)).due),cashMovement:0}});
    await assertDebtSession(client,session);const receipt=await readHistoricalDocumentInTx(client,documentId,patientId,current.version+1);await client.query("COMMIT");return {document:receipt!,replayed:false};
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
}

export async function listHistoricalDocuments(patientId:number){
  await ensureSchema();const client=await getPool().connect();
  try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const ids=(await client.query<{id:number}>("SELECT id FROM legacy_treatment_documents WHERE patient_id=$1 ORDER BY id DESC",[patientId])).rows;
    const documents=[];for(const {id} of ids){const document=await readHistoricalDocumentInTx(client,id,patientId);if(!document)continue;
      // Historical facts stay readable after an independent account correction.
      // Mutation paths still require exact ownership under their write locks.
      const opening=await openingEvidence(client,patientId,document.currency,false);const history=(await client.query("SELECT version,reason,created_by,created_at::text,total_minor::text,discount_minor::text,previously_paid_minor::text,remaining_minor::text FROM legacy_treatment_document_revisions WHERE document_id=$1 ORDER BY version",[id])).rows;
      documents.push({...document,sourceHash:opening.sourceHash??debtRequestHash(null),openingPrincipalMinor:opening.position.principalMinor,openingCollectedMinor:opening.position.settledMinor,openingRemainingMinor:opening.position.remainingMinor,accountDueMinor:(await debtAccountDue(client,patientId,document.currency)).due,scheduleVersion:opening.scheduleVersion,
        correctionAvailable:opening.owned,correctionMessage:opening.owned?null:LEGACY_TREATMENT_MESSAGE.opening_not_owned,history});}
    await client.query("COMMIT");return documents;
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
}
