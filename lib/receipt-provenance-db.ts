import { getPool, type DbClient } from "./db";
import {
  projectReceiptProvenance, receiptId, unavailableReceiptProvenance,
  type ReceiptProvenance, type ReceiptProvenanceAudit, type ReceiptProvenancePayment,
} from "./receipt-provenance";

export const RECEIPT_PROVENANCE_REQUEST_LIMIT = 1_000;
export const RECEIPT_PROVENANCE_CONTEXT_LIMIT = 5_000;
export const RECEIPT_PROVENANCE_AUDIT_LIMIT = 5_000;

/**
 * Invoked ONLY after an existing authorized ledger/shift/receipt read. IDs are
 * taken from that server-side result, never a client-supplied patient scope.
 *
 * Replacement has no structural FK to its original. A bounded patient context
 * supplies candidate original IDs; the existing audit (entity, entity_id) index
 * then supplies structured evidence. No JSON audit scan, note inference or N+1.
 * Foreign-owned reversals pointing at scoped receipts are included to invalidate
 * corrupt totals, but their references are never projected across patients.
 * The limit+1 sentinel means an incomplete context is explicitly unavailable.
 * Neither this reader nor its callers alter canonical Payment/writer responses.
 */
export async function readReceiptProvenance(paymentIds: readonly number[]): Promise<Record<string, ReceiptProvenance>> {
  const ids = [...new Set(paymentIds.filter((id) => receiptId(id) !== null))];
  if (ids.length === 0) return {};
  const unavailable = () => Object.fromEntries(ids.map((id) => [id, unavailableReceiptProvenance()]));
  if (ids.length > RECEIPT_PROVENANCE_REQUEST_LIMIT) return unavailable();
  let client: DbClient | null = null;
  let payments: ReceiptProvenancePayment[] | null = null;
  let paymentsComplete = false;
  try {
    client = await getPool().connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const context = await client.query<ReceiptProvenancePayment>(
      `WITH owners AS MATERIALIZED (
         SELECT DISTINCT patient_id FROM payments WHERE id = ANY($1::int[])
       ), owned AS MATERIALIZED (
         SELECT id FROM payments WHERE patient_id IN (SELECT patient_id FROM owners)
          ORDER BY id LIMIT $2
       )
       SELECT p.id::text AS id, p.receipt_number AS "receiptNumber", p.patient_id::text AS "patientId",
              p.kind, p.amount_minor::text AS "amountMinor", p.currency, p.reversal_of_id::text AS "reversalOfId",
              p.created_by AS "createdBy", p.created_at::text AS "createdAt"
         FROM payments p
        WHERE p.id IN (SELECT id FROM owned)
           OR p.reversal_of_id IN (SELECT id FROM owned)
        ORDER BY p.id LIMIT $2`,
      [ids, RECEIPT_PROVENANCE_CONTEXT_LIMIT + 1],
    );
    payments = context.rows;
    paymentsComplete = payments.length <= RECEIPT_PROVENANCE_CONTEXT_LIMIT;
    if (!paymentsComplete) {
      await client.query("COMMIT");
      return unavailable();
    }
    const originalIds = [...new Set(payments.filter((row) => row.kind === "payment")
      .map((row) => receiptId(row.id)).filter((id): id is number => id !== null))].map(String);
    const audits = originalIds.length === 0 ? { rows: [] as ReceiptProvenanceAudit[] }
      : await client.query<ReceiptProvenanceAudit>(
        `SELECT id::text AS id, action, entity, entity_id AS "entityId", details, actor, created_at::text AS "createdAt"
           FROM audit_log
          WHERE entity = 'payment' AND entity_id = ANY($1::text[]) AND action = 'payment.correct'
          ORDER BY id LIMIT $2`,
        [originalIds, RECEIPT_PROVENANCE_AUDIT_LIMIT + 1],
      );
    await client.query("COMMIT");
    return projectReceiptProvenance(ids, payments, audits.rows,
      { payments: true, audits: audits.rows.length <= RECEIPT_PROVENANCE_AUDIT_LIMIT });
  } catch {
    // A display lookup cannot turn an already-read/committed financial document
    // into an apparent transaction failure. Complete direct links remain useful.
    if (client) await client.query("ROLLBACK").catch(() => {});
    return payments && paymentsComplete
      ? projectReceiptProvenance(ids, payments, [], { payments: true, audits: false }) : unavailable();
  } finally {
    client?.release();
  }
}
