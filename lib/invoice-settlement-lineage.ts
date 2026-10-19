import type { DbClient } from "./db";
import type { Currency } from "./money";
export class InvoiceSettlementLineageError extends Error {
  constructor(){super("مرجع تسوية تصحيح الفاتورة لا يطابق المريض أو العملة.");}
}

/** Immutable receipts keep their original invoice reference. Only explicit,
 * same-patient/currency correction edges carry settlement to a replacement. */
export async function invoiceSettlementLineage(client: Pick<DbClient,"query">, invoiceId: number, patientId: number, currency: Currency): Promise<number[]> {
  const { rows } = await client.query<{ id: number; patient_id: number; base_currency: string; reclassified:boolean }>(
    `WITH RECURSIVE lineage(id) AS (
      SELECT $1::int
      UNION SELECT c.original_invoice_id FROM invoice_corrections c JOIN lineage l ON c.corrected_invoice_id = l.id
    ) SELECT i.id,i.patient_id,i.base_currency,
      EXISTS(SELECT 1 FROM invoice_settlement_reclassifications d JOIN invoice_corrections c ON c.id=d.correction_id
       WHERE i.id=ANY(d.source_invoice_ids) AND d.patient_id=$2 AND d.source_currency=i.base_currency
        AND d.target_currency=$3 AND c.corrected_invoice_id IN(SELECT id FROM lineage)) AS reclassified
      FROM lineage l JOIN invoices i ON i.id=l.id ORDER BY i.id`, [invoiceId,patientId,currency]);
  if (!rows.length || rows.some(row => row.patient_id !== patientId || (row.base_currency !== currency && !row.reclassified))) {
    throw new InvoiceSettlementLineageError();
  }
  return rows.map(row => row.id);
}
