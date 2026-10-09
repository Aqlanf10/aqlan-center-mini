import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (FIN-DISC, owner decision: option 2) The accounting contract of an admin discount, end to end on real PostgreSQL with the
 * real writers (createInvoice, recordPayment, applyAdminInvoiceDiscount) and readers (commissionReport,
 * commissionDetailReport, computeDebtRows). Synthetic rows only; minor units.
 *
 * How the reader sees a discount:
 *  - each decision is stored as one row per invoice line (invoice_admin_discount_lines) at its decision time;
 *  - a report includes only decisions whose clinic date is on or before its `to` date; a later decision is invisible to it
 *    and the invoice net is read as it stood at that cutoff;
 *  - a line's commission base is its value after the decisions it sees; collections before a decision keep what they earned.
 */
assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { getPool, resetPoolForTesting, ensureSchema, createInvoice, recordPayment, applyAdminInvoiceDiscount,
  commissionReport, commissionDetailReport, computeDebtRows, correctInvoice, recordExpense, createStaffUser, updateUser,
  CLINIC_TIME_ZONE } = db;

let doctorA = 0;
let doctorB = 0;
let service = 0;
let seq = 0;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: CLINIC_TIME_ZONE }).format(new Date());
const yesterday = () => new Intl.DateTimeFormat("en-CA", { timeZone: CLINIC_TIME_ZONE }).format(new Date(Date.now() - 86_400_000));

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  await pool.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd) VALUES ('disc-comm', 0, 0, 0)`);
  ({ rows: [{ id: doctorA }] } = await pool.query(`INSERT INTO parties (name, kind, commission_percent) VALUES ('د. أ اصطناعي', 'doctor', 50) RETURNING id`));
  ({ rows: [{ id: doctorB }] } = await pool.query(`INSERT INTO parties (name, kind, commission_percent) VALUES ('د. ب اصطناعي', 'doctor', 30) RETURNING id`));
  ({ rows: [{ id: service }] } = await pool.query(`INSERT INTO services (name, category, price_minor, is_active) VALUES ('خدمة اصطناعية', 'synthetic-disc', 100000, TRUE) RETURNING id`));
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function patient() {
  seq += 1;
  return (await getPool().query<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض خصم اصطناعي') RETURNING id`,
    [`DISC-C-${seq}`])).rows[0].id;
}
async function pay(patientId: number, invoiceId: number | null, amountMinor: number, currency: "YER" | "SAR" = "YER") {
  const result = await recordPayment({ patientId, invoiceId, kind: "payment", amountMinor, currency, baseCurrency: "YER",
    exchangeRate: currency === "YER" ? 1 : 140, method: "cash", note: null, createdBy: "cashier", reversalOfId: null, openingCurrency: null });
  if (result.reason !== null || !result.payment) throw new Error(`payment refused: ${result.reason}`);
  return result.payment;
}
const settled = async (invoiceId: number) => Number((await getPool().query(`SELECT COALESCE(SUM(CASE WHEN kind = 'refund'
  THEN -amount_minor ELSE amount_minor END), 0)::int AS n FROM payments WHERE invoice_id = $1`, [invoiceId])).rows[0].n);
const discountOf = async (id: number) => Number((await getPool().query(`SELECT discount_minor FROM invoices WHERE id = $1`, [id])).rows[0].discount_minor);
const discount = async (invoiceId: number, additionalMinor: number) => applyAdminInvoiceDiscount({ invoiceId, additionalMinor,
  reason: "قرار الإدارة", actor: "admin1", actorRole: "admin",
  expected: { discountMinor: await discountOf(invoiceId), settledMinor: await settled(invoiceId) } });
const row = (rows: Awaited<ReturnType<typeof commissionReport>>, doctorId: number, currency = "YER") => {
  const found = rows.find((one) => one.doctorId === doctorId && one.currency === currency);
  return found ? { accrued: found.accruedMinor, earned: found.earnedMinor } : { accrued: 0, earned: 0 };
};
/** Moves an invoice and its receipts one day back: fixture history, so a report can end before the discount. */
async function backdate(invoiceId: number) {
  await getPool().query(`UPDATE invoices SET created_at = created_at - INTERVAL '1 day' WHERE id = $1`, [invoiceId]);
  await getPool().query(`UPDATE payments SET created_at = created_at - INTERVAL '1 day' WHERE invoice_id = $1`, [invoiceId]);
}

describe("reading contract: per-line rows at their decision time, seen by reports up to their cutoff", () => {
  it("two doctors, partial collection before the discount, a report before the discount, then full collection", async () => {
    const patientId = await patient();
    const invoice = await createInvoice({ patientId, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "reception",
      items: [
        { serviceId: service, doctorId: doctorA, description: "عمل أ", quantity: 1, unitPriceMinor: 60000 },
        { serviceId: service, doctorId: doctorB, description: "عمل ب", quantity: 1, unitPriceMinor: 40000 },
      ] });
    if (!invoice) throw new Error("invoice");
    await pay(patientId, invoice.id, 50000);
    await backdate(invoice.id);
    const from = yesterday();

    const before = await commissionReport(from, today());
    expect(row(before, doctorA)).toEqual({ accrued: 30000, earned: 15000 });
    expect(row(before, doctorB)).toEqual({ accrued: 12000, earned: 6000 });

    expect(await discount(invoice.id, 10000)).toMatchObject({ ok: true, afterDiscountMinor: 10000 });
    // Stored as one row per line, split by line value, at the decision time (after the receipt).
    const { rows: lines } = await getPool().query<{ item: number; doctor: number; amount: number; after_receipt: boolean }>(
      `SELECT l.invoice_item_id AS item, it.doctor_id AS doctor, l.amount_minor::int AS amount,
              l.discounted_at > (SELECT MAX(created_at) FROM payments WHERE invoice_id = l.invoice_id) AS after_receipt
         FROM invoice_admin_discount_lines l JOIN invoice_items it ON it.id = l.invoice_item_id
        WHERE l.invoice_id = $1 ORDER BY it.doctor_id = $2 DESC`, [invoice.id, doctorA]);
    expect(lines.map(({ doctor, amount, after_receipt }) => ({ doctor, amount, after_receipt }))).toEqual([
      { doctor: doctorA, amount: 6000, after_receipt: true }, { doctor: doctorB, amount: 4000, after_receipt: true },
    ]);

    // Current report: base after the discount; the 50,000 collected before it keeps its commission.
    const after = await commissionReport(from, today());
    expect(row(after, doctorA)).toEqual({ accrued: 27000, earned: 15000 });
    expect(row(after, doctorB)).toEqual({ accrued: 10800, earned: 6000 });

    // A report that ends before the discount date does not see it.
    const historical = await commissionReport(from, from);
    expect(row(historical, doctorA)).toEqual({ accrued: 30000, earned: 15000 });
    expect(row(historical, doctorB)).toEqual({ accrued: 12000, earned: 6000 });

    // Full collection ends exactly at the reduced accrual, per doctor.
    await pay(patientId, invoice.id, 40000);
    const full = await commissionReport(from, today());
    expect(row(full, doctorA)).toEqual({ accrued: 27000, earned: 27000 });
    expect(row(full, doctorB)).toEqual({ accrued: 10800, earned: 10800 });

    // The doctor statement (detail) adds up to the same totals and shows the allocated discount per line.
    const detail = await commissionDetailReport(from, today());
    const mine = detail.lines.filter((line) => line.invoiceId === invoice.id);
    expect(mine.map((line) => [line.doctorId, line.adminDiscountMinor, line.accruedMinor, line.earnedMinor]).sort()).toEqual([
      [doctorA, 6000, 27000, 27000], [doctorB, 4000, 10800, 10800],
    ].sort());
    // The patient statement: nothing due on a fully collected, discounted invoice.
    expect((await computeDebtRows([patientId])).find((one) => one.currency === "YER")?.dueMinor ?? 0).toBe(0);
  });
});

/** A fresh doctor per scenario, so all-time dues (and payouts) stay independent. */
async function doctor(percent: number, config?: Record<string, unknown>) {
  seq += 1;
  const { rows: [{ id }] } = await getPool().query<{ id: number }>(
    `INSERT INTO parties (name, kind, commission_percent) VALUES ($1, 'doctor', $2) RETURNING id`, [`د. اصطناعي ${seq}`, percent]);
  if (config) {
    const user = await createStaffUser({ username: `discdoc${seq}`, displayName: `discdoc${seq}`, passwordHash: "x", role: "doctor", partyId: id });
    await updateUser(user.id, { commissionConfig: { calculationMode: "percentage", defaultPercent: percent, categoryRates: {},
      fixedAmountPerVisitMinor: 0, deductLabCost: true, deductMaterialCost: false, basis: "collected_cash", effectiveDate: "",
      rateHistory: [], ...config } }, { actor: "owner" });
  }
  return id;
}
async function bill(patientId: number, lines: [number, number][], currency: "YER" | "SAR" = "YER") {
  const created = await createInvoice({ patientId, baseCurrency: currency, discountMinor: 0, note: null, createdBy: "reception",
    items: lines.map(([doctorId, amount], index) => ({ serviceId: service, doctorId, description: `عمل ${index + 1}`, quantity: 1, unitPriceMinor: amount })) });
  if (!created) throw new Error("invoice");
  return created.id;
}
const adminRows = async (invoiceId: number) => (await getPool().query<{ id: number; item: number; amount: number; at: string; from: number | null }>(
  `SELECT id, invoice_item_id AS item, amount_minor::int AS amount, discounted_at::text AS at, carried_from_id AS "from"
     FROM invoice_admin_discount_lines WHERE invoice_id = $1 ORDER BY id`, [invoiceId])).rows;
const dueOf = async (patientId: number, currency = "YER") =>
  (await computeDebtRows([patientId], true)).find((one) => one.currency === currency)?.dueMinor ?? 0;
/** The doctor statement (detail) adds up to the report row, per doctor and currency. */
async function statementMatchesReport(doctorIds: number[]) {
  const to = today();
  const rows = await commissionReport("2000-01-01", to);
  const detail = await commissionDetailReport("2000-01-01", to);
  for (const doctorId of doctorIds) {
    for (const currency of ["YER", "SAR"]) {
      const lines = detail.lines.filter((line) => line.doctorId === doctorId && line.currency === currency);
      const sum = { accrued: lines.reduce((a, line) => a + line.accruedMinor, 0), earned: lines.reduce((a, line) => a + line.earnedMinor, 0) };
      expect(sum).toEqual(row(rows, doctorId, currency));
    }
  }
}

describe("ceiling after on-account money (FIFO coverage), with a payout already made", () => {
  it("refuses to discount what on-account money covers; the allowed part keeps the earned commission that was paid", async () => {
    const d = await doctor(50);
    const patientId = await patient();
    const id = await bill(patientId, [[d, 100000]]);
    await pay(patientId, null, 70000); // on account: no invoice named
    const paid = await recordExpense({ category: "commission", partyId: d, payeeText: null, amountMinor: 35000, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, payableId: null, note: null, createdBy: "cashier" });
    expect(paid.expense).not.toBeNull();
    expect(await discount(id, 40000)).toMatchObject({ ok: false, reason: "covered_on_account" });
    expect(await adminRows(id)).toEqual([]);
    expect(await discountOf(id)).toBe(0);
    expect(await discount(id, 30000)).toMatchObject({ ok: true, afterDiscountMinor: 30000, remainingAfterMinor: 70000 });
    const after = await commissionReport("2000-01-01", today());
    // Collected before the decision: 70,000 of 100,000 at 50% = 35,000 earned, kept exactly; base is now 70,000 → accrued 35,000.
    expect(row(after, d)).toEqual({ accrued: 35000, earned: 35000 });
    expect(after.find((one) => one.doctorId === d && one.currency === "YER")).toMatchObject({ paidMinor: 35000, dueMinor: 0 });
    expect(await dueOf(patientId)).toBe(0);
    await statementMatchesReport([d]);
  });
});

describe("repeated and concurrent decisions", () => {
  it("each decision is allocated on what the lines still carry; a concurrent duplicate is stale; totals reconcile", async () => {
    const a = await doctor(50);
    const b = await doctor(30);
    const patientId = await patient();
    const id = await bill(patientId, [[a, 60000], [b, 40000]]);
    await pay(patientId, id, 20000);
    expect(await discount(id, 5000)).toMatchObject({ ok: true });
    expect(await discount(id, 5000)).toMatchObject({ ok: true });
    const seen = { discountMinor: 10000, settledMinor: 20000 };
    const both = await Promise.all([1, 2].map(() => applyAdminInvoiceDiscount({ invoiceId: id, additionalMinor: 5000, reason: "قرار الإدارة",
      actor: "admin1", actorRole: "admin", expected: seen })));
    expect(both.filter((one) => one.ok)).toHaveLength(1);
    expect(both.filter((one) => !one.ok && one.reason === "stale")).toHaveLength(1);
    const rows = await adminRows(id);
    expect(rows.map((one) => one.amount)).toEqual([3000, 2000, 3000, 2000, 3000, 2000]);
    expect(await discountOf(id)).toBe(15000);
    expect(Number((await getPool().query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'invoice.discount' AND entity_id = $1`,
      [String(id)])).rows[0].n)).toBe(3);
    const mid = await commissionReport("2000-01-01", today());
    // 20,000 collected before every decision keeps its classic share; accrual is on the net-of-discount lines.
    expect(row(mid, a)).toEqual({ accrued: 25500, earned: 6000 });
    expect(row(mid, b)).toEqual({ accrued: 10200, earned: 2400 });
    await pay(patientId, id, 65000);
    const full = await commissionReport("2000-01-01", today());
    expect(row(full, a)).toEqual({ accrued: 25500, earned: 25500 });
    expect(row(full, b)).toEqual({ accrued: 10200, earned: 10200 });
    expect(await dueOf(patientId)).toBe(0);
    await statementMatchesReport([a, b]);
  });
});

describe("locks: closed period and the cashbox shift", () => {
  it("a closed period refuses with nothing written", async () => {
    const d = await doctor(50);
    const patientId = await patient();
    const id = await bill(patientId, [[d, 50000]]);
    await getPool().query(`UPDATE invoices SET created_at = created_at - INTERVAL '40 days' WHERE id = $1`, [id]);
    await getPool().query(`INSERT INTO settings (key, value) VALUES ('finance.locked_before', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [today()]);
    try {
      expect(await discount(id, 1000)).toMatchObject({ ok: false, reason: "period_locked" });
      expect(await adminRows(id)).toEqual([]);
    } finally {
      await getPool().query(`DELETE FROM settings WHERE key = 'finance.locked_before'`);
    }
  });

  it("no open shift: refused (receipts and commission payouts are fenced by the shift lock), nothing written", async () => {
    const d = await doctor(50);
    const patientId = await patient();
    const id = await bill(patientId, [[d, 50000]]);
    await getPool().query(`UPDATE cashier_shifts SET status = 'closed', closed_at = NOW() WHERE status = 'open'`);
    try {
      const result = await discount(id, 1000);
      expect(result).toMatchObject({ ok: false, reason: "no_shift" });
      if (!result.ok) expect(result.message).toMatch(/وردية/);
      expect(await adminRows(id)).toEqual([]);
      expect(await discountOf(id)).toBe(0);
    } finally {
      // A closed shift is append-only; the next scenarios get a new open shift.
      await getPool().query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd) VALUES ('disc-comm', 0, 0, 0)`);
    }
  });
});

describe("invoice correction carries the decisions without losing history or doubling them", () => {
  it("a kept line carries its rows (same decision time, carried_from_id); a removed line's part goes with it", async () => {
    const a = await doctor(50);
    const b = await doctor(30);
    const patientId = await patient();
    const id = await bill(patientId, [[a, 60000], [b, 40000]]);
    await pay(patientId, id, 30000);
    expect(await discount(id, 10000)).toMatchObject({ ok: true });
    const original = await adminRows(id);
    const { rows: [itemA] } = await getPool().query<{ id: number }>(`SELECT id FROM invoice_items WHERE invoice_id = $1 AND doctor_id = $2`, [id, a]);
    const corrected = await correctInvoice({ invoiceId: id, lines: [{ itemId: itemA.id, quantity: 1, unitPriceMinor: 60000 }],
      reason: "بند لم يُعمل", actor: "admin1", actorRole: "admin" });
    if (!corrected.ok) throw new Error(corrected.message);
    const next = corrected.corrected.id;
    expect(await discountOf(next)).toBe(6000);
    expect(await adminRows(id)).toEqual(original); // the cancelled original keeps its history untouched
    const carried = await adminRows(next);
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ amount: 6000, from: original.find((one) => one.item === itemA.id)!.id,
      at: original.find((one) => one.item === itemA.id)!.at });
    const report = await commissionReport("2000-01-01", today());
    // Once, not twice: A on the corrected invoice only; B's line is gone.
    expect(row(report, a)).toEqual({ accrued: 27000, earned: 15000 });
    expect(row(report, b)).toEqual({ accrued: 0, earned: 0 });
    const audit = (await getPool().query<{ details: Record<string, string> }>(
      `SELECT details FROM audit_log WHERE action = 'invoice.correct' AND entity_id = $1`, [String(id)])).rows[0].details;
    expect(audit).toHaveProperty("خصم_إداري_منقول");
    expect(audit).toHaveProperty("خصم_إداري_سقط_مع_البنود");
    expect(await dueOf(patientId)).toBe(24000);
    await statementMatchesReport([a, b]);
  });
});

describe("currencies stay separate", () => {
  it("a SAR decision changes only the SAR row; the YER row is untouched", async () => {
    const d = await doctor(50);
    const patientId = await patient();
    const yer = await bill(patientId, [[d, 20000]]);
    const sar = await bill(patientId, [[d, 10000]], "SAR");
    await pay(patientId, sar, 4000, "SAR");
    const before = await commissionReport("2000-01-01", today());
    expect(row(before, d, "YER")).toEqual({ accrued: 10000, earned: 0 });
    expect(row(before, d, "SAR")).toEqual({ accrued: 5000, earned: 2000 });
    expect(await discount(sar, 2000)).toMatchObject({ ok: true });
    expect(await adminRows(yer)).toEqual([]);
    const after = await commissionReport("2000-01-01", today());
    expect(row(after, d, "YER")).toEqual({ accrued: 10000, earned: 0 });
    expect(row(after, d, "SAR")).toEqual({ accrued: 4000, earned: 2000 });
    expect(await dueOf(patientId, "SAR")).toBe(4000);
    expect(await dueOf(patientId, "YER")).toBe(20000);
    await statementMatchesReport([d]);
  });
});

describe("lab cost in the commission base", () => {
  it("the base is the discounted line minus its lab cost; what was earned before is kept, and full collection ends at the new accrual", async () => {
    const d = await doctor(50);
    const patientId = await patient();
    const id = await bill(patientId, [[d, 100000]]);
    const { rows: [visit] } = await getPool().query<{ id: number }>(
      `INSERT INTO visits (patient_name, patient_id, doctor_id, invoice_id) VALUES ('مريض خصم اصطناعي', $1, $2, $3) RETURNING id`, [patientId, d, id]);
    await getPool().query(`INSERT INTO lab_orders (patient_id, lab_name, work_type, sent_date, due_date, status, visit_id, doctor_id, cost_minor, cost_currency)
      VALUES ($1, 'مختبر', 'تاج', CURRENT_DATE, CURRENT_DATE, 'delivered', $2, $3, 20000, 'YER')`, [patientId, visit.id, d]);
    await pay(patientId, id, 30000);
    expect(row(await commissionReport("2000-01-01", today()), d)).toEqual({ accrued: 40000, earned: 12000 });
    expect(await discount(id, 50000)).toMatchObject({ ok: true });
    expect(row(await commissionReport("2000-01-01", today()), d)).toEqual({ accrued: 15000, earned: 12000 });
    await pay(patientId, id, 20000);
    expect(row(await commissionReport("2000-01-01", today()), d)).toEqual({ accrued: 15000, earned: 15000 });
    await statementMatchesReport([d]);
  });
});

describe("paid commission is a fact: a conflicting decision is refused for an administrative settlement", () => {
  it("invoiced basis: a decision that takes the accrual below what was paid is refused; one that fits is accepted", async () => {
    const d = await doctor(50, { basis: "invoiced" });
    const patientId = await patient();
    const id = await bill(patientId, [[d, 100000]]);
    expect(row(await commissionReport("2000-01-01", today()), d)).toEqual({ accrued: 50000, earned: 50000 });
    const paid = await recordExpense({ category: "commission", partyId: d, payeeText: null, amountMinor: 45000, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, payableId: null, note: null, createdBy: "cashier" });
    expect(paid.expense).not.toBeNull();
    const refused = await discount(id, 20000);
    expect(refused).toMatchObject({ ok: false, reason: "commission_paid" });
    if (!refused.ok) expect(refused.message).toMatch(/تسوية إدارية/);
    expect(await adminRows(id)).toEqual([]);
    expect(await discountOf(id)).toBe(0);
    const report = await commissionReport("2000-01-01", today());
    expect(report.find((one) => one.doctorId === d && one.currency === "YER")).toMatchObject({ earnedMinor: 50000, paidMinor: 45000, dueMinor: 5000 });
    expect(await discount(id, 10000)).toMatchObject({ ok: true });
    expect((await commissionReport("2000-01-01", today())).find((one) => one.doctorId === d && one.currency === "YER"))
      .toMatchObject({ accruedMinor: 45000, earnedMinor: 45000, paidMinor: 45000, dueMinor: 0 });
    await statementMatchesReport([d]);
  });
});

describe("full settlement with odd minor units ends exactly at the reduced accrual (review 5464652001)", () => {
  it("one line of 3 at 50%: receipt 1, discount 1, receipt 1 — earned 1, not 2", async () => {
    const d = await doctor(50);
    const patientId = await patient();
    const id = await bill(patientId, [[d, 3]]);
    await pay(patientId, id, 1);
    expect(await discount(id, 1)).toMatchObject({ ok: true, afterDiscountMinor: 1 });
    expect(row(await commissionReport("2000-01-01", today()), d)).toEqual({ accrued: 1, earned: 1 }); // prefix kept
    await pay(patientId, id, 1);
    expect(row(await commissionReport("2000-01-01", today()), d)).toEqual({ accrued: 1, earned: 1 });
    expect(await dueOf(patientId)).toBe(0);
    await statementMatchesReport([d]);
  });

  it.each(["YER", "SAR"] as const)("two doctors at 50%% and 33%%, odd lines, full settlement in %s: each ends at their accrual", async (currency) => {
    const a = await doctor(50);
    const b = await doctor(33);
    const patientId = await patient();
    const id = await bill(patientId, [[a, 7], [b, 5]], currency);
    await pay(patientId, id, 2, currency);
    expect(await discount(id, 3)).toMatchObject({ ok: true });
    await pay(patientId, id, 7, currency);
    const report = await commissionReport("2000-01-01", today());
    for (const doctorId of [a, b]) {
      const { accrued, earned } = row(report, doctorId, currency);
      expect(earned).toBe(accrued);
    }
    expect(await dueOf(patientId, currency)).toBe(0);
    await statementMatchesReport([a, b]);
  });
});
