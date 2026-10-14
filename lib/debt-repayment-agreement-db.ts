import { ensureSchema, getPool, getSettingsInTransaction } from "./db";
import { readDebtRepayments } from "./debt-installments-db";

/** Read the saved schedule and actual settlement in one snapshot. No plan,
 * invoice, installment or receipt writes occur on the old contract print route. */
export async function readSavedRepaymentAgreement(arrangementId: number, version: number, today: string) {
  if (!Number.isSafeInteger(arrangementId) || arrangementId <= 0 || !Number.isSafeInteger(version) || version <= 0) return null;
  await ensureSchema(); const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: [source] } = await client.query<{ patient_id: number; full_name: string; patient_number: string; phone: string | null; invoice_number: string | null }>(
      `SELECT a.patient_id,p.full_name,p.patient_number,p.phone,i.invoice_number
       FROM debt_repayment_arrangements a JOIN patients p ON p.id=a.patient_id
       LEFT JOIN invoices i ON i.id=a.invoice_id AND i.patient_id=a.patient_id WHERE a.id=$1`, [arrangementId]);
    if (!source) { await client.query("ROLLBACK"); return null; }
    const schedule = (await readDebtRepayments(client, source.patient_id, today)).find(row => row.id === arrangementId);
    const settings = await getSettingsInTransaction(client);
    await client.query("COMMIT");
    if (!schedule || schedule.version !== version || schedule.status !== "active" || schedule.terms.mode !== "installments"
      || !schedule.available || schedule.requiresReview || !schedule.progress) return null;
    return { source, schedule, settings };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
