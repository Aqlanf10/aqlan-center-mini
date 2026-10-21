import {readCurrencyEvidenceDispatch} from "./invoice-currency-evidence-dispatch";
import {CURRENCY_PRINCIPAL_RELATION} from "./invoice-currency-principal";
import type {DbClient} from "./db";
import {invoiceEntry,type JournalEntry} from "./accounting";
import {readCurrencyReclassificationEvidence} from "./invoice-currency-evidence";
import {clinicDateString} from "./schedule";
export async function currencyReclassificationJournal(client:DbClient,from:string,to:string,timeZone:string):Promise<JournalEntry[]>{
  const {rows:documents}=await client.query<{patient_id:number;id:number;invoice_number:string;full_name:string;created_at:Date;total_minor:string;discount_minor:string;source_currency:"YER"|"SAR"|"USD";evidence_kind:string}>(`
    SELECT d.patient_id,d.id,i.invoice_number,p.full_name,d.created_at,i.total_minor::text,i.discount_minor::text,d.source_currency,d.evidence_kind
    FROM ${CURRENCY_PRINCIPAL_RELATION} d JOIN invoice_corrections c ON c.id=d.correction_id
    JOIN invoices i ON i.id=c.original_invoice_id JOIN patients p ON p.id=d.patient_id
    ORDER BY d.id`);
  await readCurrencyEvidenceDispatch(client,[...new Set(documents.map(row=>row.patient_id))]);
  const entries:JournalEntry[]=[];
  {
    for(const event of await readCurrencyReclassificationEvidence(client,[...new Set(documents.map(row=>row.patient_id))])){
      const date=clinicDateString(new Date(event.createdAt),timeZone);
      if(date<from||date>to)continue;
      const debit=event.direction===1?"debit":"credit",credit=event.direction===1?"credit":"debit";
      entries.push({source:"invoice-settlement-reclassification",reference:`ISR-${event.documentId}/P-${event.paymentId}`,date,
        description:`إعادة تصنيف تسوية السند ${event.paymentId} دون حركة نقدية`,lines:[
          {accountCode:"1201",currency:"YER",amountMinor:event.sourceMinor,side:debit},
          {accountCode:"1901",currency:"YER",amountMinor:event.sourceMinor,side:credit},
          {accountCode:"1901",currency:"SAR",amountMinor:event.targetMinor,side:debit},
          {accountCode:"1201",currency:"SAR",amountMinor:event.targetMinor,side:credit},
        ].filter(line=>line.amountMinor!==0) as JournalEntry["lines"]});
    }
  }
  for(const document of documents){
    const date=clinicDateString(document.created_at,timeZone);if(date<from||date>to)continue;
    const original=invoiceEntry({invoiceNumber:document.invoice_number,date,patientName:document.full_name,currency:document.source_currency,totalMinor:Number(document.total_minor),discountMinor:Number(document.discount_minor),cancelled:false});
    if(original)entries.push({...original,source:"invoice-currency-reversal",reference:`${document.evidence_kind==="unpaid_root_v1"?"UCR":"ISR"}-${document.id}/${document.invoice_number}`,description:`إبطال محاسبي لعملة الفاتورة ${document.invoice_number}`,lines:original.lines.map(line=>({...line,side:line.side==="debit"?"credit":"debit"}))});
  }
  return entries;
}
