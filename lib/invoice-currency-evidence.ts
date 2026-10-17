import type {DbClient} from "./db";
import {ReclassificationProofError} from "./invoice-currency-reclassification";

export interface SettlementReclassification {
  documentId:number;correctionId:number;paymentId:number;sourceInvoiceId:number;
  sourceCurrency:"YER";targetCurrency:"SAR";sourceMinor:number;targetMinor:number;
  direction:1|-1;createdAt:string;
}
/** A recorded receipt remains the cash authority. This projection carries only
 * an independently verified, append-only settlement allocation. Read in the
 * same snapshot as the invoices/payments consuming it. */
export async function readCurrencyReclassificationEvidence(client:DbClient,patientId:number):Promise<SettlementReclassification[]>{
  const {rows:documents}=await client.query<{id:number;correction_id:number;source_invoice_ids:number[];valid:boolean}>(`
    SELECT d.id,d.correction_id,d.source_invoice_ids,
      (d.patient_id=c.patient_id AND d.source_currency='YER' AND d.target_currency='SAR'
       AND c.original_currency=d.source_currency AND c.currency=d.target_currency
       AND i.patient_id=d.patient_id AND i.base_currency=d.source_currency AND i.status='cancelled'
       AND n.patient_id=d.patient_id AND n.base_currency=d.target_currency
       AND d.source_invoice_ids=(WITH RECURSIVE lineage(id) AS (SELECT c.original_invoice_id UNION
         SELECT old.original_invoice_id FROM invoice_corrections old JOIN lineage l ON old.corrected_invoice_id=l.id)
         SELECT array_agg(id ORDER BY id) FROM lineage)
       AND NOT EXISTS(SELECT 1 FROM unnest(d.source_invoice_ids) x(id) LEFT JOIN invoices old ON old.id=x.id
         WHERE old.id IS NULL OR old.patient_id<>d.patient_id OR old.base_currency<>d.source_currency OR old.status<>'cancelled')
       AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.invoice_id=ANY(d.source_invoice_ids)
         AND NOT EXISTS(SELECT 1 FROM invoice_settlement_reclassification_events e WHERE e.reclassification_id=d.id AND e.payment_id=p.id))
      ) AS valid
    FROM invoice_settlement_reclassifications d
    LEFT JOIN invoice_corrections c ON c.id=d.correction_id
    LEFT JOIN invoices i ON i.id=c.original_invoice_id
    LEFT JOIN invoices n ON n.id=c.corrected_invoice_id WHERE d.patient_id=$1 ORDER BY d.id`,[patientId]);
  if(documents.some(row=>row.valid!==true))throw new ReclassificationProofError();
  const sourceIds=documents.flatMap(row=>row.source_invoice_ids);
  if(new Set(sourceIds).size!==sourceIds.length)throw new ReclassificationProofError();
  const {rows}=await client.query<{id:number;correction_id:number;payment_id:number;invoice_id:number;source_minor:string;target_minor:string;direction:1|-1;created_at:string;valid:boolean}>(`
    SELECT d.id,d.correction_id,e.payment_id,p.invoice_id,e.source_minor::text,e.target_minor::text,e.direction,
      to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      (e.payment_snapshot=to_jsonb(p) AND p.patient_id=d.patient_id AND p.invoice_id=ANY(d.source_invoice_ids)
       AND p.currency=d.target_currency AND p.base_currency=d.source_currency
       AND e.source_minor=p.base_amount_minor AND e.target_minor=p.amount_minor
       AND e.direction=(CASE WHEN p.kind='payment' THEN 1 WHEN p.kind='refund' THEN -1 ELSE 0 END)
       AND p.exchange_rate>0 AND p.base_amount_minor=ROUND(p.amount_minor::numeric/100*p.exchange_rate)
       AND ((p.kind='payment' AND p.reversal_of_id IS NULL) OR (p.kind='refund' AND EXISTS(
         SELECT 1 FROM payments original WHERE original.id=p.reversal_of_id AND original.kind='payment'
           AND original.invoice_id=p.invoice_id AND original.patient_id=p.patient_id AND original.currency=p.currency
           AND original.exchange_rate=p.exchange_rate)))
      ) AS valid
    FROM invoice_settlement_reclassification_events e JOIN invoice_settlement_reclassifications d ON d.id=e.reclassification_id
    LEFT JOIN payments p ON p.id=e.payment_id WHERE d.patient_id=$1 ORDER BY e.id`,[patientId]);
  return rows.map(row=>{
    const sourceMinor=Number(row.source_minor),targetMinor=Number(row.target_minor);
    if(row.valid!==true||!Number.isSafeInteger(sourceMinor)||sourceMinor<0||!Number.isSafeInteger(targetMinor)||targetMinor<0)throw new ReclassificationProofError();
    return {documentId:row.id,correctionId:row.correction_id,paymentId:row.payment_id,sourceInvoiceId:row.invoice_id,
      sourceCurrency:"YER",targetCurrency:"SAR",sourceMinor,targetMinor,direction:row.direction,createdAt:row.created_at};
  });
}
