import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { formatMoney, toInputAmount, type Currency } from "../../lib/money";
import { authedGet, authedMutation, harness } from "./_server";

// Real HTTP commands plus independent PostgreSQL assertions. No browser, mocked
// route, or direct financial writer: SQL only seeds synthetic reference data.
let h: Awaited<ReturnType<typeof harness>>, db: Client, serial = 0;
let settings: { key: string; value: string }[] = [];
const rateKeys = ["finance.rate.SAR", "finance.rate.USD"];
const currencies = ["YER", "SAR", "USD"] as const;
beforeAll(async () => {
  h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(target.hostname).toBe("127.0.0.1");
  expect(target.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  expect((await db.query("SELECT current_database() AS name")).rows[0].name).toBe("aqlan_sec_http");
  settings = (await db.query("SELECT key,value FROM settings WHERE key=ANY($1::text[])", [rateKeys])).rows;
  // Existing synthetic fixture values from debt-installment-collection.test.ts,
  // explicitly persisted evidence, never market rates or a fallback assumption.
  await db.query("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  await db.query("INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd) SELECT 'synthetic-lifecycle',0,0,0 WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')");
});
afterAll(async () => {
  if (!db) return;
  await db.query("DELETE FROM settings WHERE key=ANY($1::text[])", [rateKeys]);
  for (const row of settings) await db.query("INSERT INTO settings(key,value) VALUES($1,$2)", [row.key, row.value]);
  await db.end();
});
const key = () => `synthetic-lifecycle-${Date.now()}-${++serial}`;
const post = (path: string, body: unknown, idempotencyKey?: string) => authedMutation(path, h.sessions.admin, "POST", JSON.stringify(body), idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined);
async function payload(response: Response, status = 200) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}
async function patient() {
  return (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic HTTP debt lifecycle') RETURNING id", [key()])).rows[0].id as number;
}
const workspace = async (id: number) => payload(await authedGet(`/api/patients/${id}/debt-repayments`, h.sessions.admin));
const ledger = async (id: number) => payload(await authedGet(`/api/patients/${id}/ledger`, h.sessions.admin));
const receipts = async (id: number) => (await db.query("SELECT to_jsonb(p) AS receipt FROM payments p WHERE patient_id=$1 ORDER BY id", [id])).rows;
async function balances(id: number, expected: Partial<Record<Currency, number>>) {
  const result = await ledger(id);
  for (const currency of currencies) expect(result.balances[currency].dueMinor, currency).toBe(expected[currency] ?? 0);
  return result;
}
async function invoice(patientId: number, currency: Currency, amountMinor = 1000, visitId?: number) {
  const body = { patientId, currency, ...(visitId ? { visitId } : {}), items: [{ description: "Synthetic original debt", quantity: 1, price: toInputAmount(amountMinor, currency) }], discount: "0", idempotencyKey: key() };
  // Discard the first acknowledgement, then recover the durable identity.
  const first = await post("/api/invoices", body);
  expect(first.status, await first.clone().text()).toBe(201);
  await first.arrayBuffer();
  const recovered = await payload(await post("/api/invoices", body));
  expect(recovered.replayed).toBe(true);
  expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1 AND base_currency=$2", [patientId, currency])).rows).toEqual([{ id: recovered.id }]);
  return recovered;
}
async function schedule(patientId: number, invoiceId: number, currency: Currency) {
  const view = await workspace(patientId);
  const target = view.targets.find((row: { target: { invoiceId: number } }) => row.target.invoiceId === invoiceId);
  const body = { invoiceId, openingCurrency: null, currency, expectedVersion: target.version,
    expectedRemainingMinor: target.remainingMinor, expectedSourceHash: target.sourceHash,
    reason: "Synthetic schedule of existing invoice", idempotencyKey: key(),
    terms: { mode: "installments", installments: [
      { dueDate: "2000-01-01", amountMinor: 400, kind: "installment" },
      { dueDate: "2099-01-01", amountMinor: 600, kind: "installment" },
    ] } };
  const path = `/api/patients/${patientId}/debt-repayments`;
  const saved = await payload(await post(path, body), 201);
  expect(await payload(await post(path, body))).toEqual({ ...saved, replayed: true });
  expect((await db.query("SELECT id FROM debt_repayment_revisions WHERE arrangement_id=$1", [saved.arrangementId])).rows).toHaveLength(1);
  return { ...saved, body };
}
const collect = (patientId: number, arrangementId: number, currency: Currency, amountMinor: number, requestKey: string) => post(
  `/api/patients/${patientId}/debt-repayments/${arrangementId}/collect`,
  { amount: toInputAmount(amountMinor, currency), currency, expectedVersion: 1, method: "cash", note: null }, requestKey);

describe("invoice → debt schedule → partial receipt → correction/refund → account, real HTTP/PG", () => {
  it.each(currencies)("%s retains one principal and receipt through lost acknowledgements, correction, credit and cancellation", async currency => {
    const id = await patient();
    const visitId = (await db.query("INSERT INTO visits(patient_id,patient_name,status) VALUES($1,'Synthetic debt lifecycle visit','waiting') RETURNING id", [id])).rows[0].id;
    const bill = await invoice(id, currency, 1000, visitId);
    const arranged = await schedule(id, bill.id, currency);
    await balances(id, { [currency]: 1000 });
    expect((await ledger(id)).payments).toHaveLength(0);
    const firstKey = key();
    const first = await collect(id, arranged.arrangementId, currency, 200, firstKey);
    expect(first.status, await first.clone().text()).toBe(201);
    await first.arrayBuffer(); // application never consumes this acknowledgement
    const recovered = await payload(await collect(id, arranged.arrangementId, currency, 200, firstKey));
    expect(recovered).toMatchObject({ replayed: true, payment: { patientId: id, invoiceId: bill.id, currency, amountMinor: 200 } });
    expect((await receipts(id))).toHaveLength(1);
    await payload(await collect(id, arranged.arrangementId, currency, 201, firstKey), 409);
    const view = await workspace(id);
    expect(view.arrangements[0]).toMatchObject({ remainingMinor: 800, collectedMinor: 200, principalMinor: 1000, requiresReview: false,
      progress: { overdueMinor: 200, rows: [{ remainingMinor: 200 }, { remainingMinor: 600 }] } });
    await balances(id, { [currency]: 800 });
    const walkout = await payload(await authedGet(`/api/visits/${visitId}/walkout`, h.sessions.admin));
    expect(walkout.dueRecommendation.currencies.find((row: { currency: string }) => row.currency === currency))
      .toMatchObject({ currentBalanceMinor: 800, dueNowMinor: 200, status: "verified", sources: [
        { kind: "repayment_schedule", remainingMinor: 800, dueNowMinor: 200 },
      ] });
    const before = await receipts(id);
    const correctionKey = key();
    const correction = { mode: "correct", reason: "Synthetic receipt amount correction", amount: toInputAmount(150, currency), currency, method: "cash", target: "original" };
    const correctionPath = `/api/payments/${recovered.payment.id}/correct`;
    const corrected = await payload(await post(correctionPath, correction, correctionKey), 201);
    expect(corrected).toMatchObject({ reversal: { amountMinor: 200, kind: "refund" }, replacement: { amountMinor: 150, invoiceId: bill.id } });
    const retry = await payload(await post(correctionPath, correction, correctionKey));
    expect(retry).toMatchObject({ replayed: true, reversal: { id: corrected.reversal.id }, replacement: { id: corrected.replacement.id } });
    expect((await receipts(id))[0]).toEqual(before[0]);
    expect(await receipts(id)).toHaveLength(3);
    await balances(id, { [currency]: 850 });
    expect((await workspace(id)).arrangements[0].requiresReview).toBe(true);
    await payload(await collect(id, arranged.arrangementId, currency, 100, key()), 409);
    // Existing debt collection is bounded; an explicit ordinary payment can
    // produce a credit. No new principal is manufactured for that credit.
    const overpayment = await payload(await post("/api/payments", { patientId: id, invoiceId: bill.id, amount: toInputAmount(1000, currency), currency, method: "cash" }, key()), 201);
    expect(overpayment.invoiceId).toBe(bill.id);
    await balances(id, { [currency]: -150 });
    const historical = await receipts(id);
    const cancelled = await payload(await authedMutation(`/api/invoices/${bill.id}`, h.sessions.admin, "PATCH", JSON.stringify({ status: "cancelled", reason: "Synthetic cancellation preserves receipt history" })));
    expect(cancelled.status).toBe("cancelled");
    expect(await receipts(id)).toEqual(historical); // includes original timestamps
    await balances(id, { [currency]: -1150 });
    const voidKey = key();
    const voidBody = { mode: "void", reason: "Synthetic void of cancelled invoice receipt" };
    const voidPath = `/api/payments/${overpayment.id}/correct`;
    const voided = await payload(await post(voidPath, voidBody, voidKey), 201);
    expect(await payload(await post(voidPath, voidBody, voidKey))).toMatchObject({ replayed: true, reversal: { id: voided.reversal.id } });
    expect((await receipts(id)).slice(0, historical.length)).toEqual(historical);
    await balances(id, { [currency]: -150 });
    expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1", [id])).rows).toEqual([{ id: bill.id }]);
    const statement = await authedGet(`/print/statement/${id}`, h.sessions.admin);
    expect(statement.status).toBe(200);
    const html = await statement.text();
    expect(html).toContain(`للمريض ${formatMoney(150, currency)}`);
    expect(html).toContain(corrected.replacement.receiptNumber);
    // A void/correction reversal is internal evidence, not a patient-facing refund.
    const internal = [recovered.payment, corrected.reversal, overpayment, voided.reversal];
    for (const receipt of internal) expect(html).not.toContain(receipt.receiptNumber);
    const canonical = await ledger(id);
    expect(canonical.payments.map((receipt: { id: number }) => receipt.id).sort((a: number, b: number) => a - b))
      .toEqual([...internal, corrected.replacement].map(receipt => receipt.id).sort((a, b) => a - b));
    const immutable = await receipts(id);
    expect(immutable).toHaveLength(5);

    // A genuine refund remains visible, while internal pairs and immutable history
    // remain separate. Exercise the refund writer, not the correction/void endpoint.
    const refundKey = key();
    const refundBody = { patientId: id, kind: "refund", reversalOfId: corrected.replacement.id,
      amount: toInputAmount(50, currency), currency, method: "cash", note: "Synthetic actual patient refund" };
    const refunded = await payload(await post("/api/payments", refundBody, refundKey), 201);
    expect(refunded).toMatchObject({ kind: "refund", reversalOfId: corrected.replacement.id, amountMinor: 50, currency });
    expect(await payload(await post("/api/payments", refundBody, refundKey))).toMatchObject({ id: refunded.id });
    expect((await receipts(id)).slice(0, immutable.length)).toEqual(immutable);
    expect(await receipts(id)).toHaveLength(6);
    await balances(id, { [currency]: -100 });
    const refundedStatement = await authedGet(`/print/statement/${id}`, h.sessions.admin);
    expect(refundedStatement.status).toBe(200);
    const refundedHtml = await refundedStatement.text();
    expect(refundedHtml).toContain(`للمريض ${formatMoney(100, currency)}`);
    expect(refundedHtml).toContain(corrected.replacement.receiptNumber);
    expect(refundedHtml).toContain(refunded.receiptNumber);
    expect(refundedHtml).toContain("استرداد");
    for (const receipt of internal) expect(refundedHtml).not.toContain(receipt.receiptNumber);
  });

  it.each(currencies)("%s reports zero due now with future principal intact; cancelling only the schedule preserves receipts", async currency => {
    const id = await patient();
    const visitId = (await db.query("INSERT INTO visits(patient_id,patient_name,status) VALUES($1,'Synthetic future installments','waiting') RETURNING id", [id])).rows[0].id;
    const bill = await invoice(id, currency, 1000, visitId);
    const arranged = await schedule(id, bill.id, currency);
    await payload(await collect(id, arranged.arrangementId, currency, 400, key()), 201);
    const view = await workspace(id);
    expect(view.arrangements[0]).toMatchObject({ remainingMinor: 600, collectedMinor: 400,
      progress: { overdueMinor: 0, rows: [{ remainingMinor: 0 }, { remainingMinor: 600 }] } });
    const walkout = await payload(await authedGet(`/api/visits/${visitId}/walkout`, h.sessions.admin));
    expect(walkout.dueRecommendation.currencies.find((row: { currency: string }) => row.currency === currency))
      .toMatchObject({ currentBalanceMinor: 600, dueNowMinor: 0, status: "verified" });
    await balances(id, { [currency]: 600 });
    const history = await receipts(id);
    const target = view.targets.find((row: { target: { invoiceId: number } }) => row.target.invoiceId === bill.id);
    const cancel = { ...arranged.body, cancel: true, expectedVersion: 1, expectedRemainingMinor: 600,
      expectedSourceHash: target.sourceHash, idempotencyKey: key(), reason: "Synthetic cancellation of schedule only",
      terms: { mode: "full", installments: [] } };
    const path = `/api/patients/${id}/debt-repayments`;
    const saved = await payload(await post(path, cancel), 201);
    expect(await payload(await post(path, cancel))).toEqual({ ...saved, replayed: true });
    expect((await workspace(id)).arrangements[0]).toMatchObject({ status: "cancelled", version: 2, remainingMinor: 600 });
    expect(await receipts(id)).toEqual(history);
    await balances(id, { [currency]: 600 });
    expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1", [id])).rows).toEqual([{ id: bill.id }]);
  });

  it("keeps all three currencies separate and refuses cross-patient schedule, collection and receipt linkage", async () => {
    const owner = await patient(), other = await patient();
    for (const currency of currencies) await invoice(owner, currency);
    await balances(owner, { YER: 1000, SAR: 1000, USD: 1000 });
    const bills = (await ledger(owner)).invoices;
    const bill = bills.find((row: { baseCurrency: string }) => row.baseCurrency === "SAR");
    const arranged = await schedule(owner, bill.id, "SAR");
    await payload(await post(`/api/patients/${other}/debt-repayments`, { ...arranged.body, idempotencyKey: key() }), 409);
    await payload(await collect(other, arranged.arrangementId, "SAR", 200, key()), 409);
    const invalid = await post("/api/payments", { patientId: other, invoiceId: bill.id, amount: "2", currency: "SAR", method: "cash" }, key());
    expect([400, 409]).toContain(invalid.status);
    expect(await receipts(other)).toHaveLength(0);
    await payload(await collect(owner, arranged.arrangementId, "USD", 100, key()), 400);
    await payload(await collect(owner, arranged.arrangementId, "SAR", 1001, key()), 400);
    expect(await receipts(owner)).toHaveLength(0);
    await payload(await collect(owner, arranged.arrangementId, "SAR", 200, key()), 201);
    await balances(owner, { YER: 1000, SAR: 800, USD: 1000 });
  });

  it.each(["SAR", "USD"] as const)("settles YER using persisted %s FX, preserves replay/refund evidence after settings change", async currency => {
    const id = await patient(), bill = await invoice(id, "YER");
    const arranged = await schedule(id, bill.id, "YER");
    const setting = `finance.rate.${currency}`;
    const rate = Number((await db.query("SELECT value FROM settings WHERE key=$1", [setting])).rows[0].value);
    const firstKey = key();
    const receipt = await payload(await collect(id, arranged.arrangementId, currency, 100, firstKey), 201);
    expect(receipt.payment).toMatchObject({ currency, amountMinor: 100, exchangeRate: rate, baseAmountMinor: rate });
    await balances(id, { YER: 1000 - rate });
    const historical = await receipts(id);
    try {
      // Remove present-day FX instead of inventing a substitute exchange rate.
      await db.query("DELETE FROM settings WHERE key=$1", [setting]);
      const replay = await payload(await collect(id, arranged.arrangementId, currency, 100, firstKey));
      expect(replay.payment.id).toBe(receipt.payment.id);
      expect(replay.payment.exchangeRate).toBe(rate);
      await payload(await collect(id, arranged.arrangementId, currency, 100, key()), 400);
      const refunded = await payload(await post(`/api/payments/${receipt.payment.id}/correct`, { mode: "void", reason: "Synthetic refund uses stored FX evidence" }, key()), 201);
      expect(refunded.reversal).toMatchObject({ currency, amountMinor: 100, exchangeRate: rate, baseAmountMinor: rate });
      expect((await receipts(id))[0]).toEqual(historical[0]);
      await balances(id, { YER: 1000 });
    } finally {
      await db.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [setting, String(rate)]);
    }
  });
});
