import { CLINIC_TIME_ZONE, ensureSchema, getPool } from "./db";
import { clinicTodaySql } from "./clinic-day-sql";
import { readCheckoutDueRecommendationInSnapshot } from "./checkout-due-recommendation-db";
import { openingPosition } from "./legacy-balance-arrangements-db";
import { CollectionScopeDenied, receptionCollectionAllowed } from "./reception-collection-scope";
import type { Currency } from "./money";

export async function readReceptionCollectionLedger(patientId: number, username: string) {
  await ensureSchema();
  const client = await getPool().connect();
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    if (!await receptionCollectionAllowed(client, patientId, username, CLINIC_TIME_ZONE)) throw new CollectionScopeDenied();
    const today = (await client.query<{ today: string }>(`SELECT ${clinicTodaySql("$1")}::text AS today`, [CLINIC_TIME_ZONE])).rows[0].today;
    const invoices = await client.query<{ id: number; invoiceNumber: string; baseCurrency: Currency; totalMinor: number; discountMinor: number; status: string }>(
      `SELECT id, invoice_number AS "invoiceNumber", base_currency AS "baseCurrency", total_minor::float8 AS "totalMinor",
        discount_minor::float8 AS "discountMinor", status FROM invoices WHERE patient_id=$1 AND status='open' ORDER BY id DESC`, [patientId]);
    const plans = await client.query<{ id: number; baseCurrency: Currency; title: string; status: string }>(
      `SELECT id, base_currency AS "baseCurrency", 'اتفاق ' || id::text AS title, status
       FROM treatment_plans WHERE patient_id=$1 AND status='active' ORDER BY id`, [patientId]);
    const receipts = await client.query<{ id: number; receiptNumber: string; amountMinor: number; currency: Currency }>(
      `SELECT id, receipt_number AS "receiptNumber", amount_minor::float8 AS "amountMinor", currency
       FROM payments WHERE patient_id=$1 AND created_by=$2 AND kind='payment' ORDER BY id DESC`, [patientId, username]);
    const currencies = (await client.query<{ currency: Currency }>("SELECT currency FROM patient_opening_balances WHERE patient_id=$1 ORDER BY currency", [patientId])).rows;
    const openings = [];
    for (const { currency } of currencies) {
      const position = await openingPosition(client, patientId, currency);
      if (position && position.remainingMinor > 0) openings.push({ currency, dueMinor: position.remainingMinor });
    }
    const dueRecommendation = await readCheckoutDueRecommendationInSnapshot(client, { patientId, today, visitInvoiceId: null });
    await client.query("COMMIT");
    return { patientId, invoices: invoices.rows, plans: plans.rows, payments: receipts.rows, openings, dueRecommendation };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}
