/** Cancelling a laboratory order whose payable has vouchers (real PostgreSQL, synthetic data).
 * Finding F2-1 of the 2026-11-10 finance audit: the cancel counted voucher ROWS, so a part
 * payment, or a payment that was later voided (two rows, net zero), marked the order "paid"
 * while the laboratory was still owed. The order may read "paid" only when the payable is
 * fully settled. Owner decision 2026-11-11: a laboratory debt is never dropped merely because no
 * voucher exists; only an order never sent to the laboratory takes its payable with it. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const rates = { YER: 1, SAR: 140, USD: 535 } as const;
const query = async (sql: string, params: unknown[] = []) => (await db.getPool().query(sql, params)).rows;

async function order(amountMinor: number, status: "needed" | "sent" = "sent") {
  const partyId = (await query("INSERT INTO parties (name, kind) VALUES ('SYN lab cancel', 'lab') RETURNING id"))[0].id as number;
  const patientId = (await query("INSERT INTO patients (patient_number, full_name) VALUES ('SYN-' || nextval('patients_id_seq'), 'SYN lab cancel patient') RETURNING id"))[0].id;
  const id = (await query(`INSERT INTO lab_orders (patient_id, lab_name, work_type, due_date, status, party_id, cost_minor, cost_currency, financial_status)
    VALUES ($1, 'SYN lab', 'test', CURRENT_DATE, $4, $2, $3, 'YER', 'payable_created') RETURNING id`, [patientId, partyId, amountMinor, status]))[0].id as number;
  const payable = await db.createPayable({ partyId, category: "lab", description: "SYN lab cancel payable", amountMinor, currency: "YER",
    baseCurrency: "YER", exchangeRate: 1, labOrderId: id, dueDate: null, createdBy: "SYN-test" });
  await query("UPDATE lab_orders SET payable_id=$1 WHERE id=$2", [payable!.id, id]);
  return { id, partyId, payableId: payable!.id };
}
const pay = (partyId: number, payableId: number, amountMinor: number) => db.recordExpense({ category: "lab", partyId, amountMinor, currency: "YER", payableId,
  baseCurrency: "YER", exchangeRate: 1, rates, createdBy: "SYN-test", payeeText: null, note: null });
const state = async (id: number) => (await query("SELECT status, financial_status, payable_id FROM lab_orders WHERE id=$1", [id]))[0];
const owed = async (partyId: number) => (await db.partyDueByCurrency()).filter(row => row.partyId === partyId).map(({ currency, dueMinor }) => ({ currency, dueMinor }));
const cancel = (id: number) => db.setLabOrderStatus(id, "cancelled", { actor: "SYN-test", actorRole: "admin" });

beforeEach(async () => {
  await db.resetPoolForTesting();
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  await query("INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd) VALUES ('SYN-lab-cancel', 100000000, 100000000, 100000000)");
});
afterAll(async () => { await db.resetPoolForTesting(); });

describe("cancelling a laboratory order never reads paid while the laboratory is owed", () => {
  it("never sent to the laboratory and no voucher: no work was commissioned, the payable goes with the order (exempt)", async () => {
    const o = await order(100_000, "needed");
    await cancel(o.id);
    expect(await state(o.id)).toEqual({ status: "cancelled", financial_status: "exempt", payable_id: null });
    expect(await owed(o.partyId)).toEqual([]);
  });

  it("sent to the laboratory, no voucher: the debt is not dropped merely because nothing was paid", async () => {
    const o = await order(100_000);
    await cancel(o.id);
    expect(await state(o.id)).toEqual({ status: "cancelled", financial_status: "payable_created", payable_id: o.payableId });
    expect(await owed(o.partyId)).toEqual([{ currency: "YER", dueMinor: 100_000 }]);
  });

  it("fully paid: the order reads paid and nothing is owed, as before", async () => {
    const o = await order(100_000);
    expect((await pay(o.partyId, o.payableId, 100_000)).reason).toBeNull();
    await cancel(o.id);
    expect(await state(o.id)).toEqual({ status: "cancelled", financial_status: "paid", payable_id: o.payableId });
    expect(await owed(o.partyId)).toEqual([]);
  });

  it("part paid: 60,000 is still owed, so the order does not read paid", async () => {
    const o = await order(100_000);
    expect((await pay(o.partyId, o.payableId, 40_000)).reason).toBeNull();
    await cancel(o.id);
    expect(await owed(o.partyId)).toEqual([{ currency: "YER", dueMinor: 60_000 }]);
    expect(await state(o.id)).toEqual({ status: "cancelled", financial_status: "payable_created", payable_id: o.payableId });
  });

  it("paid then voided (two voucher rows, net zero): the full 100,000 is owed, so the order does not read paid", async () => {
    const o = await order(100_000);
    const paid = await pay(o.partyId, o.payableId, 100_000);
    expect(paid.reason).toBeNull();
    expect((await db.voidExpense(paid.expense!.id, { actor: "SYN-test", actorRole: "admin", reason: "SYN void" })).ok).toBe(true);
    await cancel(o.id);
    expect(await owed(o.partyId)).toEqual([{ currency: "YER", dueMinor: 100_000 }]);
    expect(await state(o.id)).toEqual({ status: "cancelled", financial_status: "payable_created", payable_id: o.payableId });
  });

  it("a batch settlement that is later voided leaves the laboratory owed; the cancelled order does not read paid", async () => {
    const o = await order(100_000);
    await query("UPDATE lab_orders SET status='received' WHERE id=$1", [o.id]);
    await db.settleLabOrdersBatch({ partyId: o.partyId, orderIds: [o.id], amountMinor: 100_000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      note: "SYN batch", createdBy: "SYN-test", actorRole: "admin", rates });
    expect((await state(o.id)).financial_status).toBe("paid");
    const voucher = (await query("SELECT expense_id FROM expense_payable_allocations WHERE payable_id=$1 ORDER BY id LIMIT 1", [o.payableId]))[0].expense_id as number;
    expect((await db.voidExpense(voucher, { actor: "SYN-test", actorRole: "admin", reason: "SYN batch void" })).ok).toBe(true);
    await cancel(o.id);
    expect(await owed(o.partyId)).toEqual([{ currency: "YER", dueMinor: 100_000 }]);
    expect(await state(o.id)).toEqual({ status: "cancelled", financial_status: "payable_created", payable_id: o.payableId });
    // Both vouchers (the settlement and its reversal) are kept as the trail.
    expect((await query("SELECT count(*)::int AS n FROM expense_payable_allocations WHERE payable_id=$1", [o.payableId]))[0].n).toBe(2);
  });

  it("the cancel waits for a payment in flight on the payable and then counts it", async () => {
    const o = await order(100_000);
    const blocker = await db.getPool().connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM payables WHERE id=$1 FOR UPDATE", [o.payableId]);
      pending = cancel(o.id);
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        waiting = (await query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM payables WHERE id = $1 FOR UPDATE%'")).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      // The payment in flight commits its voucher while the cancel waits.
      await blocker.query(`INSERT INTO expenses (voucher_number, category, party_id, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, payable_id, shift_id, created_by,
          payable_currency, payable_amount_minor, payable_exchange_rate, payable_settled_minor)
        SELECT 'SYN-RACE-1', 'lab', $1, 40000, 'YER', 1, 40000, 'YER', $2, (SELECT id FROM cashier_shifts WHERE status='open' LIMIT 1), 'SYN-test', 'YER', 100000, 1, 40000`, [o.partyId, o.payableId]);
      await blocker.query("COMMIT");
      await pending;
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending?.catch(() => undefined); }
    // The payable survived with its voucher; nothing dangles and the order is not exempt.
    expect((await query("SELECT count(*)::int AS n FROM payables WHERE id=$1", [o.payableId]))[0].n).toBe(1);
    expect(await state(o.id)).toEqual({ status: "cancelled", financial_status: "payable_created", payable_id: o.payableId });
    expect(await owed(o.partyId)).toEqual([{ currency: "YER", dueMinor: 60_000 }]);
  });
});
