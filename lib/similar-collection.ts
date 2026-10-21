/**
 * Advisory duplicate-collection review; never a financial deduplication key.
 * The existing writer + Idempotency-Key remain the only authority for posting.
 */
import {ensureSchema,getPool} from "./db";
import type {Currency} from "./money";

export const SIMILAR_COLLECTION_WINDOW_HOURS=24;
const MATCH_LIMIT=32;
export interface SimilarCollectionReceipt {
  id:number;receiptNumber:string;amountMinor:number;currency:Currency;
  createdAt:string;method:string;invoiceId:number|null;planId:number|null;
  openingCurrency:Currency|null;createdBy:string;
}
export interface SimilarCollectionReview {observedReceiptIds:number[];confirmed:boolean}
type ReceiptRow={
  id:number;receipt_number:string;amount_minor:string;currency:Currency;created_at:Date|string;
  method:string;invoice_id:number|null;plan_id:number|null;opening_currency:Currency|null;created_by:string;
};
export function parseSimilarCollectionReview(value:unknown):SimilarCollectionReview|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const record=value as Record<string,unknown>;
  if(Object.keys(record).sort().join(",")!=="confirmed,observedReceiptIds"
    ||typeof record.confirmed!=="boolean"||!Array.isArray(record.observedReceiptIds)
    ||record.observedReceiptIds.length>MATCH_LIMIT
    ||!record.observedReceiptIds.every(n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0)
    ||new Set(record.observedReceiptIds).size!==record.observedReceiptIds.length)return null;
  return {confirmed:record.confirmed,observedReceiptIds:record.observedReceiptIds};
}
export function reviewMatchesReceipts(review:SimilarCollectionReview,receipts:readonly SimilarCollectionReceipt[]):boolean {
  return receipts.length<=MATCH_LIMIT
    &&(receipts.length===0||review.confirmed)
    &&review.observedReceiptIds.length===receipts.length
    &&review.observedReceiptIds.every((id,index)=>id===receipts[index].id);
}
/**
 * One patient, exact native tender amount/currency, preceding rolling 24h.
 * A fully reversed payment is not currently collected; partial reversals remain
 * visible for awareness. Never compare converted base amounts or adjacent patients.
 */
export async function findSimilarCollections(patientId:number,amountMinor:number,currency:Currency):Promise<SimilarCollectionReceipt[]> {
  if(!Number.isSafeInteger(patientId)||patientId<=0||!Number.isSafeInteger(amountMinor)||amountMinor<=0)throw new Error("invalid_collection_query");
  await ensureSchema();
  const {rows}=await getPool().query<ReceiptRow>(`
    SELECT p.id,p.receipt_number,p.amount_minor::text,p.currency,p.created_at,
      p.method,p.invoice_id,p.plan_id,p.opening_currency,p.created_by
    FROM payments p
    WHERE p.patient_id=$1 AND p.kind='payment' AND p.reversal_of_id IS NULL
      AND p.amount_minor=$2 AND p.currency=$3
      AND p.created_at >= NOW()-INTERVAL '24 hours'
      AND p.amount_minor > COALESCE((
        SELECT SUM(r.amount_minor) FROM payments r
        WHERE r.reversal_of_id=p.id AND r.kind='refund' AND r.currency=p.currency
      ),0)
    ORDER BY p.created_at DESC,p.id DESC LIMIT $4
  `,[patientId,amountMinor,currency,MATCH_LIMIT]);
  return rows.map(row=>({
    id:row.id,receiptNumber:row.receipt_number,amountMinor:Number(row.amount_minor),
    currency:row.currency,createdAt:new Date(row.created_at).toISOString(),method:row.method,
    invoiceId:row.invoice_id,planId:row.plan_id,openingCurrency:row.opening_currency,createdBy:row.created_by,
  }));
}
