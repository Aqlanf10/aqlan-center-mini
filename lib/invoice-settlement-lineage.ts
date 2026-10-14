import type { DbClient } from "./db";
import type { Currency } from "./money";
export class InvoiceSettlementLineageError extends Error {
  constructor(){super("مرجع تسوية تصحيح الفاتورة لا يطابق المريض أو العملة.");}
}

/** Immutable receipts keep their original invoice reference. Only explicit,
 * same-patient/currency correction edges carry settlement to a replacement. */
export async function invoiceSettlementLineage(client: DbClient, invoiceId: number, patientId: number, currency: Currency): Promise<number[]> {
  const { rows } = await client.query<{ id: number; patient_id: number; base_currency: string }>(
    `WITH RECURSIVE lineage(id) AS (
      SELECT $1::int
      UNION SELECT c.original_invoice_id FROM invoice_corrections c JOIN lineage l ON c.corrected_invoice_id = l.id
    ) SELECT i.id,i.patient_id,i.base_currency FROM lineage l JOIN invoices i ON i.id=l.id ORDER BY i.id`, [invoiceId]);
  if (!rows.length || rows.some(row => row.patient_id !== patientId || row.base_currency !== currency)) {
    throw new InvoiceSettlementLineageError();
  }
  return rows.map(row => row.id);
}
