import type { DbClient, Invoice, OpeningBalance, Payment } from "./db";
import { emptyStatementEvidence, StatementProjectionError, type StatementEvidence } from "./patient-statement-projection";
import { requireCurrency } from "./money";

/** Three bounded patient-scoped reads on the caller's financial snapshot, never one query per row. */
export async function readPatientStatementEvidence(client: Pick<DbClient, "query">, patientId: number,
  ledger: { invoices: readonly Invoice[]; payments: readonly Payment[]; openings: readonly OpeningBalance[] }): Promise<StatementEvidence> {
  const evidence = emptyStatementEvidence();
  const { rows: corrections } = await client.query<{ original_invoice_id: number; corrected_invoice_id: number; created_at: Date }>(
    `SELECT original_invoice_id, corrected_invoice_id, created_at FROM invoice_corrections WHERE patient_id=$1 ORDER BY id`, [patientId]);
  evidence.invoiceCorrections = corrections.map(row => ({ originalInvoiceId: row.original_invoice_id, correctedInvoiceId: row.corrected_invoice_id, createdAt: row.created_at.toISOString() }));
  const { rows: audit } = await client.query<{ action: string; entity_id: string; details: Record<string, unknown> | null; created_at: Date }>(
    `SELECT action, entity_id, details, created_at FROM audit_log WHERE
      (action='payment.correct' AND entity='payment' AND entity_id=ANY($1::text[])) OR
      (action IN ('invoice.cancel','invoice.correct') AND entity='invoice' AND entity_id=ANY($2::text[])) ORDER BY id`,
    [ledger.payments.map(p => String(p.id)), ledger.invoices.map(i => String(i.id))]);
  const byReceipt = new Map(ledger.payments.map(p => [p.receiptNumber, p]));
  const byInvoiceNumber = new Map(ledger.invoices.map(invoice => [invoice.invoiceNumber, invoice]));
  const byInvoiceId = new Map(ledger.invoices.map(invoice => [invoice.id, invoice]));
  if (byInvoiceNumber.size !== ledger.invoices.length) throw new StatementProjectionError();
  for (const row of audit) {
    if (!row.details || row.details["المريض"] !== patientId) throw new StatementProjectionError();
    if (row.action === "invoice.correct") {
      // Legacy correctInvoice persisted its relationship in structured audit fields,
      // not invoice_corrections. Never infer relationships from free-text notes.
      const original = byInvoiceId.get(Number(row.entity_id));
      const replacement = byInvoiceNumber.get(String(row.details["الفاتورة_المصححة"]));
      if (!original || !replacement || original.patientId !== patientId || replacement.patientId !== patientId
        || original.id === replacement.id || original.status !== "cancelled") throw new StatementProjectionError();
      const edge = { originalInvoiceId: original.id, correctedInvoiceId: replacement.id, createdAt: row.created_at.toISOString() };
      const overlapping = evidence.invoiceCorrections.filter(candidate => candidate.originalInvoiceId === original.id || candidate.correctedInvoiceId === replacement.id);
      if (overlapping.length) {
        if (overlapping.length !== 1 || overlapping[0].originalInvoiceId !== original.id || overlapping[0].correctedInvoiceId !== replacement.id
          || overlapping[0].createdAt !== edge.createdAt) throw new StatementProjectionError();
      } else evidence.invoiceCorrections.push(edge);
      continue;
    }
    if (row.action === "invoice.cancel") {
      evidence.invoiceCancellations.push({ invoiceId: Number(row.entity_id), createdAt: row.created_at.toISOString() });
      continue;
    }
    const reversal = byReceipt.get(String(row.details["سند_العكس"]));
    const replacementNumber = row.details["السند_الصحيح"];
    const replacement = replacementNumber === null ? null : byReceipt.get(String(replacementNumber));
    if (!reversal || (replacementNumber !== null && !replacement) || row.details["المبلغ_المعكوس"] !== reversal.amountMinor
      || row.details["العملة_المعكوسة"] !== reversal.currency || (replacement && (row.details["المبلغ_الصحيح"] !== replacement.amountMinor || row.details["العملة_الصحيحة"] !== replacement.currency))) throw new StatementProjectionError();
    evidence.paymentCorrections.push({ originalId: Number(row.entity_id), reversalId: reversal.id, replacementId: replacement?.id ?? null, createdAt: row.created_at.toISOString() });
  }
  const { rows: history } = await client.query<{ id: number; currency: string; before_amount_minor: string | null; before_as_of_date: string | null; after_amount_minor: string | null; after_as_of_date: string | null; created_at: Date }>(
    `SELECT id,currency,before_amount_minor::text,before_as_of_date::text,after_amount_minor::text,after_as_of_date::text,created_at
       FROM patient_opening_balance_history WHERE patient_id=$1 ORDER BY id`, [patientId]);
  const minor = (value: string | null) => { if (value === null) return null; const number = Number(value); if (!Number.isSafeInteger(number)) throw new StatementProjectionError(); return number; };
  evidence.openingHistory = history.map(row => ({ id: row.id, currency: requireCurrency(row.currency, "كشف الحساب", row.id),
    beforeAmountMinor: minor(row.before_amount_minor), beforeAsOfDate: row.before_as_of_date,
    afterAmountMinor: minor(row.after_amount_minor), afterAsOfDate: row.after_as_of_date, createdAt: row.created_at.toISOString() }));
  // listPatientPayments already attached independently verified allocation evidence in this snapshot.
  for (const payment of ledger.payments) if (payment.settlementAllocation) {
    const proof = payment.settlementAllocation as typeof payment.settlementAllocation & { createdAt?: string };
    if (!proof.createdAt) throw new StatementProjectionError();
    evidence.allocationEffectiveAt[payment.id] = proof.createdAt;
  }
  return evidence;
}
