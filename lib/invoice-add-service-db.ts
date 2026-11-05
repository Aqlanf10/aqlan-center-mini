/** A new service is a separate dated receivable, never a rewrite of an issued invoice. */
import type {SessionPayload} from "./auth";
import {CLINIC_TIME_ZONE,ensureSchema,getPool,getInvoice,getSettingsInTransaction,insertAuditRow,type DbClient,type Service,type Invoice} from "./db";
import {revalidateSessionInTransaction} from "./session";
import {invoiceAddServiceSchemaReady} from "./invoice-add-service-schema";
import {debtRequestHash} from "./debt-source-proof";
import {debtAccountDue} from "./debt-account-position";
import {readInvoiceSettlementPosition} from "./invoice-settlement-position";
import {createLinkedInvoiceInTransaction,invoicePlanChoices,previewInvoiceLinkage,InvoiceLinkageError,type LineLink} from "./invoice-linkage-db";
import {parseInvoiceCommand,invoiceCommandFingerprint,invoiceCatalogRequestFingerprint} from "./invoice-template";
import {INVOICE_IDEMPOTENCY_PATTERN,INVOICE_LINKAGE_MESSAGE} from "./invoice-clinical-linkage";
import {checkInvoiceAuthority,formatPriceOverrides} from "./invoice-pricing";
import {foreignRatesFromSettings} from "./service-pricing";
import {effectiveTemplates} from "./specialty-templates";
import {clinicDateString} from "./schedule";
import type {Currency} from "./money";
import {invoiceCatalogPrice} from "./invoice-catalog-price";
import {InvoiceTemplateAuthorityError,InvoiceTemplateAuthorizationError,InvoiceTemplateBusyError} from "./invoice-template-db";

export class InvoiceAddServiceError extends Error {
  constructor(readonly code:string,message:string,readonly terminal=false,readonly idempotencyKey?:string,readonly requestHash?:string){super(message);}
}
function fail(code:string,message:string):never {throw new InvoiceAddServiceError(code,message);}
const positive=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0&&v<=2_147_483_647;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
export interface InvoiceAddServiceCommand {
  idempotencyKey:string;expectedSourceHash:string;reason:string;serviceId:number;currency:Currency;
  price:string;discount:string;doctorId?:number|null;priceReason?:string|null;discountReason?:string|null;
  toothCode?:number|null;surfaces?:string|null;scope?:string|null;caseId?:number|null;existingPlanId?:number|null;
}
export interface InvoiceAddServiceReceipt {
  originalInvoiceId:number;additionalInvoiceId:number;additionalInvoiceNumber:string;additionalCreatedAt:string;
  patientId:number;currency:Currency;addedNetMinor:number;sourceVisitIds:number[];
  idempotencyKey:string;requestHash:string;createdBy:string;cashMovementMinor:0;
  clinical:{planId:number|null;links:LineLink[]};replayed:boolean;
}
function command(source:unknown):InvoiceAddServiceCommand {
  const allowed=["idempotencyKey","expectedSourceHash","reason","serviceId","doctorId","price","priceReason","discount","discountReason","currency","toothCode","surfaces","scope","caseId","existingPlanId"];
  if(!object(source)||Object.keys(source).some(key=>!allowed.includes(key))
    ||typeof source.idempotencyKey!=="string"||!INVOICE_IDEMPOTENCY_PATTERN.test(source.idempotencyKey)
    ||typeof source.expectedSourceHash!=="string"||!/^[a-f0-9]{64}$/.test(source.expectedSourceHash)
    ||typeof source.reason!=="string"||source.reason.trim().length<3||source.reason.trim().length>300
    ||!positive(source.serviceId)||typeof source.price!=="string"||typeof source.discount!=="string"
    ||!(["YER","SAR","USD"] as unknown[]).includes(source.currency))fail("invalid","راجع الخدمة والسعر والعملة والخصم وسبب الإضافة ومفتاح الطلب.");
  for(const key of ["doctorId","caseId","existingPlanId","toothCode"]){if(source[key]!==undefined&&source[key]!==null&&!positive(source[key]))fail("invalid","هوية الطبيب أو الخطة أو الحالة أو السن غير صالحة.");}
  for(const key of ["priceReason","discountReason","surfaces","scope"]){if(source[key]!==undefined&&source[key]!==null&&(typeof source[key]!=="string"||(source[key] as string).length>300))fail("invalid","تفاصيل الخدمة غير صالحة.");}
  return source as unknown as InvoiceAddServiceCommand;
}
const requestHash=(invoiceId:number,body:InvoiceAddServiceCommand,session:SessionPayload)=>debtRequestHash({purpose:"invoice-service-addition-v1",invoiceId,body,actor:{id:session.userId,username:session.username,role:session.role}});
async function authorize(client:DbClient,session:SessionPayload){
  const current=await revalidateSessionInTransaction(session,client);
  if(!current||current.role!=="admin"||current.username!==session.username)fail("unauthorized","إضافة خدمة إلى فاتورة قائمة تحتاج جلسة مدير سارية.");
}
async function ready(client:DbClient){if(!await invoiceAddServiceSchemaReady(client))fail("schema_unavailable","إضافة الخدمة غير متاحة: مخطط سجل المستندات الإضافية غير جاهز أو غير مطابق.");}
async function catalogue(client:DbClient){
  const {rows}=await client.query<{id:number;name:string;category:string|null;price_minor:string;price_sar_minor:string|null;price_usd_minor:string|null;is_active:boolean;price_configured:boolean;price_provisional:boolean;sort_order:number}>(
    "SELECT id,name,category,price_minor::text,price_sar_minor::text,price_usd_minor::text,is_active,price_configured,price_provisional,sort_order FROM services ORDER BY id");
  const services:Service[]=rows.map(row=>({id:row.id,name:row.name,category:row.category,priceMinor:Number(row.price_minor),priceSarMinor:row.price_sar_minor===null?null:Number(row.price_sar_minor),priceUsdMinor:row.price_usd_minor===null?null:Number(row.price_usd_minor),isActive:row.is_active,priceConfigured:row.price_configured,priceProvisional:row.price_provisional,sortOrder:row.sort_order}));
  const doctors=(await client.query<{id:number;name:string}>("SELECT id,name FROM parties WHERE kind='doctor' ORDER BY id")).rows;
  return {services,doctors};
}
async function snapshot(client:DbClient,invoiceId:number){
  const invoice=await getInvoice(invoiceId,client);if(!invoice)fail("missing","الفاتورة غير موجودة.");
  if(invoice.status==="cancelled")fail("conflict","الفاتورة ألغيت أو استبدلت؛ افتح المستند الحالي قبل إضافة خدمة.");
  const settlement=await readInvoiceSettlementPosition(client,{patientId:invoice.patientId,invoiceId,currency:invoice.baseCurrency});
  if(!settlement.available)fail("conflict","لا يمكن إثبات أصل الفاتورة وتسويته.");
  const accountDueMinor=(await debtAccountDue(client,invoice.patientId,invoice.baseCurrency)).due;
  const sourceVisits=(await client.query<{id:number;status:string;signed_at:Date|null;signed_by:string|null}>("SELECT id,status,signed_at,signed_by FROM visits WHERE patient_id=$1 AND invoice_id=$2 ORDER BY id",[invoice.patientId,invoiceId])).rows;
  const previous=(await client.query<{id:string;additional_invoice_id:number}>("SELECT id::text,additional_invoice_id FROM invoice_service_additions WHERE original_invoice_id=$1 ORDER BY id",[invoiceId])).rows;
  const catalog=await catalogue(client),settings=await getSettingsInTransaction(client,{requireStoredExchangeRates:true});
  const planChoices=await invoicePlanChoices(client,invoice.patientId,invoice.baseCurrency);
  const clinicalItems=(await client.query<{id:number;plan_id:number;doctor_id:number|null}>("SELECT i.* FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1 ORDER BY i.id",[invoice.patientId])).rows;
  const clinicalCases=(await client.query("SELECT * FROM clinical_cases WHERE patient_id=$1 ORDER BY id",[invoice.patientId])).rows;
  const clinicalPlans=(await client.query("SELECT * FROM treatment_plans WHERE patient_id=$1 ORDER BY id",[invoice.patientId])).rows;
  const clinicalSessions=(await client.query("SELECT s.* FROM treatment_sessions s JOIN plan_items i ON i.id=s.plan_item_id JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1 ORDER BY s.id",[invoice.patientId])).rows;
  const clinicalProcedures=(await client.query("SELECT p.* FROM visit_procedures p JOIN visits v ON v.id=p.visit_id WHERE v.patient_id=$1 ORDER BY p.id",[invoice.patientId])).rows;
  const original={id:invoice.id,invoiceNumber:invoice.invoiceNumber,createdAt:invoice.createdAt,patientId:invoice.patientId,currency:invoice.baseCurrency,netMinor:settlement.principalMinor,settledMinor:settlement.settledMinor,remainingMinor:settlement.remainingMinor};
  // Previous additions prevent two different keys from spending the same preview.
  // Catalogue and pricing settings bind the displayed price authority as well.
  const sourceHash=debtRequestHash(JSON.parse(JSON.stringify({invoice,proof:settlement.proofHash,accountDueMinor,sourceVisits,previous,planChoices,clinicalItems,clinicalCases,clinicalPlans,clinicalSessions,clinicalProcedures,catalog,
    pricing:{lockedBefore:settings["finance.locked_before"],maxDiscount:settings["billing.max_discount_percent"],sar:settings["finance.rate.SAR"],usd:settings["finance.rate.USD"],templates:settings["plans.specialty_templates"]}})));
  return {invoice,original,sourceHash,accountDueMinor,sourceVisitIds:sourceVisits.map(visit=>visit.id),planChoices,clinicalItems,...catalog,settings};
}
type Snapshot=Awaited<ReturnType<typeof snapshot>>;
function checkPeriod(view:Snapshot){
  const cutoff=view.settings["finance.locked_before"]?.trim();
  const issued=clinicDateString(new Date(view.original.createdAt),CLINIC_TIME_ZONE),today=clinicDateString(new Date(),CLINIC_TIME_ZONE);
  if(cutoff&&(issued<cutoff||today<cutoff))fail("locked_period","أصل الفاتورة أو تاريخ المستند الإضافي في فترة مقفلة؛ يلزم قرار مالي معتمد.");
}
function prepare(view:Snapshot,body:InvoiceAddServiceCommand,session:SessionPayload){
  if(body.currency!==view.original.currency)fail("invalid","المستند الإضافي بعملة الأصل؛ تغيير العملة ليس إضافة خدمة.");
  const source:Record<string,unknown>={patientId:view.original.patientId,currency:body.currency,idempotencyKey:body.idempotencyKey,
    discount:body.discount,discountReason:body.discountReason??null,existingPlanId:body.existingPlanId??null,
    note:`خدمة إضافية مرتبطة بالفاتورة ${view.original.invoiceNumber} (الأصل بتاريخ ${view.original.createdAt.slice(0,10)}) — مستند جديد بتاريخ الإصدار؛ ${body.reason.trim()}`.slice(0,300),
    items:[{serviceId:body.serviceId,doctorId:body.doctorId??null,price:body.price,priceReason:body.priceReason??null,quantity:1,
      toothCode:body.toothCode??null,surfaces:body.surfaces??null,scope:body.scope??null,caseId:body.caseId??null}]};
  // A quoted intent gives the canonical writer a raw actor-bound replay digest.
  const service=view.services.find(row=>row.id===body.serviceId);
  if(!service?.isActive)fail("invalid","الخدمة المختارة غير متاحة؛ اختر خدمة نشطة.");
  (source.items as Record<string,unknown>[])[0].catalogPriceMinor=invoiceCatalogPrice(service,body.currency);
  const parsed=parseInvoiceCommand(source,new Map(view.services.map(row=>[row.id,row])),new Set(view.doctors.map(row=>row.id)),view.settings,true);
  if(!parsed.ok)fail("invalid",parsed.message);
  const total=parsed.items.reduce((sum,item)=>sum+item.quantity*item.unitPriceMinor,0),net=total-parsed.discountMinor;
  if(!Number.isSafeInteger(net)||net<=0||parsed.discountMinor<0||parsed.discountMinor>total||!Number.isSafeInteger(view.accountDueMinor+net))fail("invalid","إضافة الخدمة تحتاج مبلغًا موجبًا بعد الخصم؛ لا تنشئ تخفيضًا أو استردادًا.");
  const pricing=checkInvoiceAuthority({requireInvoiceManualReason:true,lines:parsed.authorityLines,currency:parsed.baseCurrency,rates:foreignRatesFromSettings(view.settings),role:session.role,maxDiscountPercent:Number(view.settings["billing.max_discount_percent"]),totalMinor:total,discountMinor:parsed.discountMinor,discountReason:body.discountReason??null});
  if(!pricing.ok)fail("invalid",pricing.message);
  return {source,parsed,pricing,net};
}
async function readTransaction<T>(invoiceId:number,session:SessionPayload,read:(client:DbClient,view:Snapshot)=>Promise<T>):Promise<T>{
  if(!positive(invoiceId))fail("invalid","رقم الفاتورة غير صالح.");
  await ensureSchema();const client=await getPool().connect();let destroy=false;
  try{await authorize(client,session);await ready(client);await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result=await read(client,await snapshot(client,invoiceId));await client.query("COMMIT");return result;
  }catch(error){try{await client.query("ROLLBACK");}catch{destroy=true;}throw error;}finally{client.release(destroy);}
}
export async function readInvoiceAddService(invoiceId:number,session:SessionPayload){
  return readTransaction(invoiceId,session,async(_client,view)=>({original:view.original,sourceHash:view.sourceHash,accountDueMinor:view.accountDueMinor,
    services:view.services.filter(service=>service.isActive),doctors:view.doctors,planChoices:view.planChoices,sourceVisitIds:view.sourceVisitIds}));
}
export async function previewInvoiceAddService(invoiceId:number,source:unknown,session:SessionPayload){
  const body=command(source);
  return readTransaction(invoiceId,session,async(client,view)=>{
    checkPeriod(view);if(view.sourceHash!==body.expectedSourceHash)fail("stale","تغيّرت الفاتورة أو السندات أو الخدمات؛ حدّث السياق قبل المعاينة.");
    const {parsed,net}=prepare(view,body,session);
    const clinical=await previewInvoiceLinkage({patientId:parsed.patientId,baseCurrency:parsed.baseCurrency,existingPlanId:parsed.existingPlanId,items:parsed.items},client);
    return {original:view.original,sourceHash:view.sourceHash,requestHash:requestHash(invoiceId,body,session),currency:body.currency,
      addedNetMinor:net,accountDueBeforeMinor:view.accountDueMinor,accountDueAfterMinor:view.accountDueMinor+net,sourceVisitIds:view.sourceVisitIds,
      clinical:clinical.map(line=>{
        const effectiveDoctorId=(line.item?.mode==="existing"?view.clinicalItems.find(item=>item.id===line.item!.id)?.doctor_id:null)??body.doctorId??null;
        const effectivePlanId=line.item===null?null:line.item?.mode==="existing"?view.clinicalItems.find(item=>item.id===line.item!.id)?.plan_id??null:body.existingPlanId??(view.planChoices.length===1&&view.planChoices[0].compatible?view.planChoices[0].id:null);
        return {...line,effectivePlanId,refusalMessage:line.refusal?INVOICE_LINKAGE_MESSAGE[line.refusal]:null,effectiveDoctorId,effectiveDoctorName:view.doctors.find(doctor=>doctor.id===effectiveDoctorId)?.name??null};
      }),status:"planned" as const};
  });
}
async function lockAttempt(client:DbClient,key:string){await client.query("SELECT pg_advisory_xact_lock(hashtextextended('aqlan:invoice-service-addition:'||$1::text,0))",[key]);}
async function replay(client:DbClient,invoiceId:number,body:InvoiceAddServiceCommand,session:SessionPayload,hash:string){
  const saved=(await client.query<{original_invoice_id:number;actor_id:number;request_hash:string;receipt:InvoiceAddServiceReceipt}>("SELECT original_invoice_id,actor_id,request_hash,receipt FROM invoice_service_additions WHERE idempotency_key=$1",[body.idempotencyKey])).rows[0];
  if(saved){
    if(saved.original_invoice_id!==invoiceId||saved.actor_id!==session.userId||saved.request_hash!==hash)fail("conflict","مفتاح الإضافة يخص طلبًا مختلفًا.");
    if(saved.receipt.originalInvoiceId!==invoiceId||saved.receipt.requestHash!==hash||saved.receipt.idempotencyKey!==body.idempotencyKey||saved.receipt.createdBy!==session.username)fail("conflict","إقرار المستند الإضافي غير متطابق؛ يلزم مراجعة مالية.");
    return {...saved.receipt,replayed:true};
  }
  const rejected=(await client.query<{original_invoice_id:number;actor_id:number;request_hash:string}>("SELECT original_invoice_id,actor_id,request_hash FROM invoice_service_addition_rejections WHERE idempotency_key=$1",[body.idempotencyKey])).rows[0];
  if(rejected){if(rejected.original_invoice_id!==invoiceId||rejected.actor_id!==session.userId||rejected.request_hash!==hash)fail("conflict","مفتاح المحاولة المرفوضة يخص طلبًا مختلفًا.");
    throw new InvoiceAddServiceError("stale","هذه المحاولة رُفضت دون إصدار مستند بسبب تغيّر المصدر؛ يمكن تحديث المعاينة بمفتاح جديد.",true,body.idempotencyKey,hash);}
  return null;
}
export async function addInvoiceService(invoiceId:number,source:unknown,session:SessionPayload):Promise<InvoiceAddServiceReceipt>{
  if(!positive(invoiceId))fail("invalid","رقم الفاتورة غير صالح.");
  const body=command(source),hash=requestHash(invoiceId,body,session);
  await ensureSchema();const client=await getPool().connect();let destroy=false,committed=false;
  try{
    await client.query("BEGIN");await authorize(client,session);await ready(client);await lockAttempt(client,body.idempotencyKey);
    const prior=await replay(client,invoiceId,body,session,hash);
    if(prior){await authorize(client,session);await client.query("COMMIT");committed=true;return prior;}
    const owner=(await client.query<{patient_id:number}>("SELECT patient_id FROM invoices WHERE id=$1",[invoiceId])).rows[0];if(!owner)fail("missing","الفاتورة غير موجودة.");
    await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE",[owner.patient_id]);
    await client.query("SELECT id FROM cashier_shifts WHERE status='open' ORDER BY id FOR UPDATE");
    await client.query("SELECT id FROM visits WHERE patient_id=$1 ORDER BY id FOR UPDATE",[owner.patient_id]);
    await client.query("SELECT id FROM treatment_plans WHERE patient_id=$1 ORDER BY id FOR UPDATE",[owner.patient_id]);
    await client.query("SELECT i.id FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1 ORDER BY i.id FOR UPDATE OF i",[owner.patient_id]);
    await client.query("SELECT id FROM clinical_cases WHERE patient_id=$1 ORDER BY id FOR UPDATE",[owner.patient_id]);
    await client.query("LOCK TABLE patient_opening_balances IN SHARE MODE");
    await client.query("SELECT id FROM invoices WHERE patient_id=$1 ORDER BY id FOR UPDATE",[owner.patient_id]);
    await client.query("LOCK TABLE settings IN SHARE MODE");
    await authorize(client,session);
    const rejectStale=async(observedHash:string):Promise<never>=>{
      await client.query("INSERT INTO invoice_service_addition_rejections(idempotency_key,original_invoice_id,actor_id,request_hash,expected_source_hash,observed_source_hash) VALUES ($1,$2,$3,$4,$5,$6)",[body.idempotencyKey,invoiceId,session.userId,hash,body.expectedSourceHash,observedHash]);
      await authorize(client,session);await client.query("COMMIT");committed=true;
      throw new InvoiceAddServiceError("stale","تغيّرت الفاتورة أو السندات أو الإضافات؛ لم يُصدر مستند لهذه المحاولة. حدّث المعاينة بمفتاح جديد.",true,body.idempotencyKey,hash);
    };
    const status=(await client.query<{status:string}>("SELECT status FROM invoices WHERE id=$1",[invoiceId])).rows[0];
    if(status?.status==="cancelled")await rejectStale(debtRequestHash({invoiceId,status:"cancelled"}));
    const view=await snapshot(client,invoiceId);
    if(view.sourceHash!==body.expectedSourceHash)await rejectStale(view.sourceHash);
    checkPeriod(view);
    const {source:canonical,parsed,pricing,net}=prepare(view,body,session);
    const written=await createLinkedInvoiceInTransaction(client,{patientId:parsed.patientId,baseCurrency:parsed.baseCurrency,existingPlanId:parsed.existingPlanId,
      discountMinor:parsed.discountMinor,note:parsed.note,createdBy:session.username,actorRole:session.role,items:parsed.items,
      templates:effectiveTemplates(view.settings["plans.specialty_templates"]).templates,idempotencyKey:body.idempotencyKey,
      requestHash:invoiceCatalogRequestFingerprint(canonical,session),catalogueAuthority:{source:canonical,fingerprint:invoiceCommandFingerprint(parsed),session},
      auditDetails:{...(pricing.discount?{سبب_الخصم:pricing.discount.reason,نسبة_الخصم:pricing.discount.percent}:{}),...(pricing.overrides.length?{أسعار_معدلة:formatPriceOverrides(pricing.overrides)}:{}),الفاتورة_الأصلية:invoiceId}});
    if(written.replayed)fail("conflict","المفتاح مستعمل خارج أمر الإضافة المثبت؛ لم يُنشأ رابط جديد.");
    const invoice:Invoice=written.invoice??(await getInvoice(written.invoiceId,client))!;
    const receipt:InvoiceAddServiceReceipt={originalInvoiceId:invoiceId,additionalInvoiceId:invoice.id,additionalInvoiceNumber:invoice.invoiceNumber,additionalCreatedAt:invoice.createdAt,
      patientId:view.original.patientId,currency:view.original.currency,addedNetMinor:net,sourceVisitIds:view.sourceVisitIds,idempotencyKey:body.idempotencyKey,requestHash:hash,createdBy:session.username,cashMovementMinor:0,clinical:{planId:written.planId,links:written.links},replayed:false};
    await client.query(`INSERT INTO invoice_service_additions(original_invoice_id,additional_invoice_id,patient_id,currency,source_hash,idempotency_key,request_hash,actor_id,created_by,reason,receipt)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,[invoiceId,invoice.id,view.original.patientId,view.original.currency,view.sourceHash,body.idempotencyKey,hash,session.userId,session.username,body.reason.trim(),JSON.stringify(receipt)]);
    await insertAuditRow(client,{action:"invoice.service_add",entity:"invoice",entityId:invoiceId,entityLabel:view.original.invoiceNumber,
      details:{الفاتورة_الإضافية:invoice.invoiceNumber,المستند_الإضافي:invoice.id,السبب:body.reason.trim(),الزيادة:net,العملة:body.currency,زيارات_المصدر:view.sourceVisitIds,حركة_نقدية:0},actor:session.username,actorRole:session.role});
    await authorize(client,session);await client.query("COMMIT");committed=true;return receipt;
  }catch(error){
    if(!committed)try{await client.query("ROLLBACK");}catch{destroy=true;}
    if(error instanceof InvoiceLinkageError)fail(error.reason,error.reason==="no_patient"?"المريض غير موجود.":INVOICE_LINKAGE_MESSAGE[error.reason]);
    if(error instanceof InvoiceTemplateAuthorizationError)fail("unauthorized",error.message);
    if(error instanceof InvoiceTemplateAuthorityError||error instanceof InvoiceTemplateBusyError)fail("conflict",error.message);
    throw error;
  }finally{client.release(destroy);}
}
