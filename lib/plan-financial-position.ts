import type {DbClient} from './db';
import {readInvoiceSettlementPosition} from './invoice-settlement-position';
import {readDebtRepayments} from './debt-installments-db';
import type {Currency} from './money';
import type {PlanProgress} from './plans';

/** Read-only invoice schedules retain their own identity and revision semantics.
 * They must never become plan_installments accepted by the installment writer. */
export interface PlanInvoiceFinancialPosition {
  kind:'invoice_backed'|'review_required';
  invoiceIds:number[];
  paidMinor:number;
  remainingMinor:number;
  progress:PlanProgress;
  schedules:Pick<Awaited<ReturnType<typeof readDebtRepayments>>[number],"id"|"target"|"version"|"status"|"requiresReview"|"progress">[];
  message:string|null;
}
type PlanFinancialIdentity={id:number;patientId:number;currency:Currency};
type PlanInvoiceCandidate={id:number;patient_id:number;base_currency:string;owned:boolean;classic:boolean};
const PLAN_INVOICE_CANDIDATES_SQL=`
    SELECT i.id,i.patient_id,i.base_currency,
      (i.plan_id=$1 AND EXISTS(SELECT 1 FROM payments p WHERE p.invoice_id=i.id AND p.plan_id=$1 AND p.patient_id=i.patient_id)
        AND NOT EXISTS(SELECT 1 FROM invoice_items x WHERE x.invoice_id=i.id AND (x.plan_item_id IS NOT NULL OR x.source_type IS NOT NULL))) AS classic,
      ((i.plan_id IS NULL OR i.plan_id=$1) AND EXISTS(SELECT 1 FROM invoice_items x WHERE x.invoice_id=i.id) AND NOT EXISTS(
        SELECT 1 FROM invoice_items x LEFT JOIN plan_items pi ON pi.id=COALESCE(x.plan_item_id,CASE WHEN x.source_type='plan_item' THEN x.source_id END)
        WHERE x.invoice_id=i.id AND (pi.id IS NULL OR pi.plan_id<>$1 OR (x.source_type='plan_item' AND x.source_id IS DISTINCT FROM pi.id)))) AS owned
    FROM invoices i WHERE NOT EXISTS(SELECT 1 FROM invoice_corrections c WHERE c.original_invoice_id=i.id)
      AND (i.plan_id=$1 OR EXISTS(SELECT 1 FROM invoice_items x JOIN plan_items pi ON pi.id=COALESCE(x.plan_item_id,CASE WHEN x.source_type='plan_item' THEN x.source_id END)
        WHERE x.invoice_id=i.id AND pi.plan_id=$1)) ORDER BY i.id`;

/** Same ownership/classic tests as the single-plan reader, grouped on the caller's snapshot. */
export async function readPlanInvoiceFinancialPositions(client:DbClient,plans:PlanFinancialIdentity[],today:string){
  if(!plans.length)return new Map<number,Awaited<ReturnType<typeof readPlanInvoiceFinancialPosition>>>();
  const {rows}=await client.query<PlanInvoiceCandidate & {requested_plan_id:number}>(`
    SELECT requested.plan_id AS requested_plan_id, candidate.*
    FROM unnest($1::int[]) AS requested(plan_id)
    CROSS JOIN LATERAL (${PLAN_INVOICE_CANDIDATES_SQL.replaceAll("$1","requested.plan_id")}) AS candidate
    ORDER BY requested.plan_id,candidate.id`,[plans.map(plan=>plan.id)]);
  const grouped=new Map<number,PlanInvoiceCandidate[]>();
  for(const row of rows){const group=grouped.get(row.requested_plan_id)??[];group.push(row);grouped.set(row.requested_plan_id,group);}
  // Only this RR statement batch shares a patient-wide read. Cache the promise
  // before awaiting so concurrent plan resolvers cannot fan out identical work.
  // It is lazy (ownership/classic refusals still precede schedule reads), keyed
  // by patient, and dies with this invocation: never shared with another client,
  // request, date or writer. Rejections propagate through the snapshot cleanup.
  const schedulesByPatient=new Map<number,ReturnType<typeof readDebtRepayments>>();
  const schedulesFor=(patientId:number)=>{
    let pending=schedulesByPatient.get(patientId);
    if(!pending){pending=readDebtRepayments(client,patientId,today);schedulesByPatient.set(patientId,pending);}
    return pending;
  };
  return new Map(await Promise.all(plans.map(async plan=>[plan.id,await resolvePlanInvoiceFinancialPosition(client,plan,today,grouped.get(plan.id)??[],()=>schedulesFor(plan.patientId))] as const)));
}
export async function readPlanInvoiceFinancialPosition(client:DbClient,plan:PlanFinancialIdentity,today:string):Promise<PlanInvoiceFinancialPosition|{kind:"classic_installments"}|null>{
  const {rows}=await client.query<PlanInvoiceCandidate>(PLAN_INVOICE_CANDIDATES_SQL,[plan.id]);
  return resolvePlanInvoiceFinancialPosition(client,plan,today,rows);
}
async function resolvePlanInvoiceFinancialPosition(client:DbClient,plan:PlanFinancialIdentity,today:string,rows:PlanInvoiceCandidate[],readSchedules=()=>readDebtRepayments(client,plan.patientId,today)):Promise<PlanInvoiceFinancialPosition|{kind:"classic_installments"}|null>{
  if(!rows.length)return null;
  if(rows.every(r=>r.classic && r.patient_id===plan.patientId && r.base_currency===plan.currency))return {kind:'classic_installments'};
  const blank:PlanProgress={totalMinor:0,paidMinor:0,remainingMinor:0,dueToDateMinor:0,overdueMinor:0,nextDueDate:null,nextDueAmountMinor:0,paidCount:0,count:0};
  const review=():PlanInvoiceFinancialPosition=>({kind:'review_required',invoiceIds:rows.map(r=>r.id),paidMinor:0,remainingMinor:0,progress:blank,schedules:[],message:'ربط الخطة بمصادر الدين يحتاج مراجعة؛ راجع حساب المريض دون إصدار قسط جديد.'});
  // Full ownership is required before attributing an entire receipt. A shared
  // invoice or unrelated opening balance is never apportioned by guesswork.
  if(rows.some(r=>!r.owned||r.patient_id!==plan.patientId||r.base_currency!==plan.currency))return review();
  const positions=await Promise.all(rows.map(r=>readInvoiceSettlementPosition(client,{patientId:plan.patientId,invoiceId:r.id,currency:plan.currency})));
  const ids=new Set(positions.flatMap(p=>p.lineageInvoiceIds));
  const direct=(await client.query<{invoice_id:number|null}>(`SELECT invoice_id FROM payments WHERE plan_id=$1`,[plan.id])).rows;
  if(direct.some(p=>p.invoice_id===null||!ids.has(p.invoice_id)))return review();
  // Legacy agreements can be backed by an opening bucket. Its ownership must
  // be explicitly approved (the caller handles approved agreements first).
  if((await client.query('SELECT 1 FROM legacy_treatment_agreements a JOIN plan_items i ON i.id=a.plan_item_id WHERE i.plan_id=$1 LIMIT 1',[plan.id])).rows.length)return review();
  const allSchedules=await readSchedules();
  const schedules=allSchedules.filter(s=>positions.some(p=>p.invoiceId===s.target.invoiceId)).map(({id,target,version,status,requiresReview,progress})=>({id,target,version,status,requiresReview,progress:requiresReview?null:progress}));
  const progress={...blank};
  for(const position of positions){
    progress.totalMinor+=position.principalMinor;progress.paidMinor+=position.settledMinor;
    progress.remainingMinor+=position.remainingMinor;
    if(!position.available)continue;
    const schedule=schedules.find(s=>s.target.invoiceId===position.invoiceId&&s.status==='active');
    if(!schedule||schedule.requiresReview||!schedule.progress)continue;
    const p=schedule.progress;
    progress.overdueMinor+=p.overdueMinor;progress.count+=p.rows.length;
    progress.paidCount+=p.rows.filter(r=>r.remainingMinor===0).length;
    progress.dueToDateMinor+=p.rows.filter(r=>r.dueDate<=today).reduce((sum,r)=>sum+r.amountMinor,0);
    for(const row of p.rows.filter(r=>r.remainingMinor>0&&r.dueDate>=today)){
      if(progress.nextDueDate===null||row.dueDate<progress.nextDueDate){progress.nextDueDate=row.dueDate;progress.nextDueAmountMinor=row.remainingMinor;}
      else if(row.dueDate===progress.nextDueDate)progress.nextDueAmountMinor+=row.remainingMinor;
    }
  }
  if(Object.values(progress).some(value=>typeof value==='number'&&!Number.isSafeInteger(value)))throw new Error("Plan financial aggregate exceeds safe minor units");
  return {kind:'invoice_backed',invoiceIds:positions.map(p=>p.invoiceId),paidMinor:progress.paidMinor,remainingMinor:progress.remainingMinor,progress,schedules,
    message:schedules.some(s=>s.status==='active'&&s.requiresReview)?'تغيّر مصدر الدين؛ راجع جدول السداد في حساب المريض.':null};
}
