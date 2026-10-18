import {readCurrencyReclassificationEvidence} from "./invoice-currency-evidence";
import type { DbClient } from "./db";
import { patientBalancesByCurrency, requireCurrency, toCurrencyPaymentLikes, type Currency } from "./money";
/** Uses the same canonical currency buckets as the ledger. Caller has locked
 * shifts, opening principal, invoices and plans before reading this snapshot. */
export async function debtAccountDue(client: DbClient, patientId: number, currency: Currency) {
  const { rows: invoices } = await client.query<{id:number;total_minor:string;discount_minor:string;status:"open"|"paid"|"cancelled";base_currency:string}>("SELECT id,total_minor::text,discount_minor::text,status,base_currency FROM invoices WHERE patient_id=$1 ORDER BY id",[patientId]);
  const { rows: plans } = await client.query<{id:number;base_currency:string}>("SELECT id,base_currency FROM treatment_plans WHERE patient_id=$1 ORDER BY id",[patientId]);
  const { rows: payments } = await client.query<{id:number;invoice_id:number|null;plan_id:number|null;opening_currency:string|null;kind:"payment"|"refund";amount_minor:string;base_amount_minor:string;currency:string;exchange_rate:string}>(
    "SELECT id,invoice_id,plan_id,opening_currency,kind,amount_minor::text,base_amount_minor::text,currency,exchange_rate::text FROM payments WHERE patient_id=$1 ORDER BY id",[patientId]);
  const { rows: openings } = await client.query<{currency:string;amount_minor:string}>("SELECT currency,amount_minor::text FROM patient_opening_balances WHERE patient_id=$1",[patientId]);
  const allocations=new Map((await readCurrencyReclassificationEvidence(client,patientId)).map(row=>[row.paymentId,row]));
  const balances=patientBalancesByCurrency(invoices.map(row=>({totalMinor:Number(row.total_minor),discountMinor:Number(row.discount_minor),status:row.status,baseCurrency:requireCurrency(row.base_currency,"فاتورة",row.id)})),
    toCurrencyPaymentLikes(patientId,payments.map(row=>({settlementAllocation:allocations.get(row.id),id:row.id,invoiceId:row.invoice_id,planId:row.plan_id,openingCurrency:row.opening_currency===null?null:requireCurrency(row.opening_currency,"رصيد",patientId),
      kind:row.kind,amountMinor:Number(row.amount_minor),baseAmountMinor:Number(row.base_amount_minor),currency:requireCurrency(row.currency,"سند",row.id),exchangeRate:Number(row.exchange_rate)})),
    new Map(invoices.map(row=>[row.id,{patientId,currency:requireCurrency(row.base_currency,"فاتورة",row.id)}])),
    new Map(plans.map(row=>[row.id,{patientId,currency:requireCurrency(row.base_currency,"خطة",row.id)}]))),
    Object.fromEntries(openings.map(row=>[requireCurrency(row.currency,"رصيد",patientId),Number(row.amount_minor)])));
  const due=balances[currency].dueMinor;if(!Number.isSafeInteger(due))throw new Error("رصيد الحساب يحتاج مراجعة مالية.");
  return {due,invoiceIds:invoices.map(row=>row.id),planIds:plans.map(row=>row.id)};
}

/** Caller already owns the patient financial fence. Acquire in canonical order. */
export async function lockDebtAccountForSchedule(client:DbClient,patientId:number,includeUnbilledVisits=false) {
  await client.query("SELECT id FROM cashier_shifts WHERE status='open' FOR UPDATE");
  // Signing/checkout owns visit before invoice. Schedule changes must wait at
  // that same fence, including visits relinked by an invoice correction.
  await client.query(`SELECT id FROM visits WHERE patient_id=$1 ${includeUnbilledVisits?"":"AND invoice_id IS NOT NULL"} ORDER BY id FOR UPDATE`,[patientId]);
  await client.query("LOCK TABLE patient_opening_balances IN SHARE MODE");
  await client.query("SELECT id FROM invoices WHERE patient_id=$1 ORDER BY id FOR UPDATE",[patientId]);
  await client.query("SELECT id FROM treatment_plans WHERE patient_id=$1 ORDER BY id FOR SHARE",[patientId]);
}
