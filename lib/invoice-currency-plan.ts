import { invoiceCurrencyScopeReasons, invoiceCurrencyScopeMessage, type InvoiceCurrencyScopeFacts, type InvoiceCurrencyScopeReason } from "./invoice-currency-scope";
import type {DbClient,Invoice} from "./db";
import {DebtRepaymentError} from "./debt-installments-db";
import {readInvoiceSettlementPosition} from "./invoice-settlement-position";
import {planCurrencyReclassification,ReclassificationProofError,type ReclassificationPayment} from "./invoice-currency-reclassification";
export class InvoiceCurrencyScopeError extends DebtRepaymentError {
  readonly reasonCodes: InvoiceCurrencyScopeReason[];
  constructor(reasonCodes: InvoiceCurrencyScopeReason[]) {
    super("conflict", invoiceCurrencyScopeMessage(reasonCodes));
    this.reasonCodes = reasonCodes;
  }
}
const reject=(message:string):never=>{throw new DebtRepaymentError("conflict",message);};
/** Narrow first release: explicit YER -> recorded SAR, one fully covered
 * per-procedure plan at a time. Existing clinical identities remain untouched. */
export async function prepareInvoiceCurrencyChange(client:DbClient,invoice:Invoice,principalMinor:number){
  if(invoice.baseCurrency!=="YER")reject("تصحيح العملة يدعم الانتقال من اليمني إلى السعودي المسجل في السندات فقط.");
  const position=await readInvoiceSettlementPosition(client,{patientId:invoice.patientId,invoiceId:invoice.id,currency:"YER"});
  const ids=position.lineageInvoiceIds;
  // Unique clinical source references remain on original items after correction.
  // Inspect the whole authoritative family, including malformed partial sources.
  const {rows:[scope]}=await client.query<InvoiceCurrencyScopeFacts>(`SELECT
    EXISTS(SELECT 1 FROM invoices WHERE id=ANY($1::int[]) AND plan_id IS NOT NULL) AS plan_linked_lineage,
    EXISTS(SELECT 1 FROM invoice_items WHERE invoice_id=ANY($1::int[])
      AND (source_type IS NOT NULL OR source_id IS NOT NULL)
      AND source_type IS DISTINCT FROM 'plan_item') AS independent_item_source,
    EXISTS(SELECT 1 FROM invoice_settlement_reclassifications WHERE source_invoice_ids && $1::int[]) AS already_reclassified`,[ids]);
  const reasonCodes = invoiceCurrencyScopeReasons(scope);
  if(reasonCodes.length)throw new InvoiceCurrencyScopeError(reasonCodes);
  const {rows:plans}=await client.query<{id:number;supported:boolean}>(`SELECT p.id,
      (p.patient_id=$2 AND p.base_currency='YER' AND p.total_from_items AND p.billing_mode='per_procedure'
       AND NOT EXISTS(SELECT 1 FROM plan_items i WHERE i.plan_id=p.id AND NOT EXISTS(
         SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=$1 AND ii.plan_item_id=i.id))
       AND NOT EXISTS(SELECT 1 FROM payments WHERE plan_id=p.id)
       AND NOT EXISTS(SELECT 1 FROM invoices WHERE plan_id=p.id)
       AND NOT EXISTS(SELECT 1 FROM legacy_treatment_agreements a JOIN plan_items i ON i.id=a.plan_item_id WHERE i.plan_id=p.id)
       AND NOT EXISTS(SELECT 1 FROM invoice_items ii JOIN plan_items i ON i.id=ii.plan_item_id
         WHERE i.plan_id=p.id AND NOT(ii.invoice_id=ANY($3::int[])))) AS supported
    FROM treatment_plans p WHERE p.id IN(SELECT i.plan_id FROM plan_items i JOIN invoice_items ii ON ii.plan_item_id=i.id WHERE ii.invoice_id=$1) ORDER BY p.id`,[invoice.id,invoice.patientId,ids]);
  if(plans.some(plan=>!plan.supported))reject("الخطة مشتركة أو غير مغطاة بالكامل بهذه الفاتورة؛ لا يمكن إعادة تفسير أسعار بقية العلاج عند تغيير العملة.");
  const doctorIds=[...new Set(invoice.items.flatMap(item=>item.doctorId===null?[]:[item.doctorId]))];
  if(doctorIds.length){
    const {rows:[commission]}=await client.query<{blocked:boolean}>(`SELECT
      EXISTS(SELECT 1 FROM expenses WHERE category='commission' AND party_id=ANY($1::int[]))
      OR EXISTS(SELECT 1 FROM hr_payroll_items WHERE status<>'reversed' AND commissions_minor<>0) AS blocked`,[doctorIds]);
    if(commission.blocked)reject("توجد عمولات مصروفة أو معتمدة؛ يلزم تعديل عمولة صريح قبل إعادة تصنيف عملة الفاتورة.");
  }
  const {rows}=await client.query<{id:number;patient_id:number;invoice_id:number;kind:"payment"|"refund";reversal_of_id:number|null;currency:"SAR";base_currency:"YER";amount_minor:string;base_amount_minor:string;exchange_rate:string}>(
    "SELECT id,patient_id,invoice_id,kind,reversal_of_id,currency,base_currency,amount_minor::text,base_amount_minor::text,exchange_rate::text FROM payments WHERE invoice_id=ANY($1::int[]) ORDER BY id",[ids]);
  const payments:ReclassificationPayment[]=rows.map(row=>({id:row.id,patientId:row.patient_id,invoiceId:row.invoice_id,kind:row.kind,reversalOfId:row.reversal_of_id,currency:row.currency,baseCurrency:row.base_currency,amountMinor:Number(row.amount_minor),baseAmountMinor:Number(row.base_amount_minor),exchangeRate:Number(row.exchange_rate)}));
  let result:ReturnType<typeof planCurrencyReclassification>;
  try{result=planCurrencyReclassification({patientId:invoice.patientId,lineageInvoiceIds:ids,fromCurrency:"YER",toCurrency:"SAR",principalMinor,payments});}catch(error){if(error instanceof ReclassificationProofError)reject(error.message);throw error;}
  return {...result,lineageInvoiceIds:ids,planIds:plans.map(plan=>plan.id)};
}
export async function writeInvoiceCurrencyEvidence(client:DbClient,correctionId:number,patientId:number,lineageInvoiceIds:number[]){
  const {rows:[document]}=await client.query<{id:number}>(`INSERT INTO invoice_settlement_reclassifications(correction_id,patient_id,source_currency,target_currency,source_invoice_ids)
    VALUES($1,$2,'YER','SAR',$3) RETURNING id`,[correctionId,patientId,lineageInvoiceIds]);
  await client.query(`INSERT INTO invoice_settlement_reclassification_events(reclassification_id,payment_id,direction,source_minor,target_minor,payment_snapshot)
    SELECT $1,p.id,CASE WHEN p.kind='refund' THEN -1 ELSE 1 END,p.base_amount_minor,p.amount_minor,to_jsonb(p)
    FROM payments p WHERE p.invoice_id=ANY($2::int[]) ORDER BY p.id`,[document.id,lineageInvoiceIds]);
  return document.id;
}
