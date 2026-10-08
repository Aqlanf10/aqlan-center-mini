import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, baseUrl, harness } from "./_server";

/**
 * (P0-2) سداد الموردين والمختبرات على HTTP الحقيقي — التطبيق المبني نفسه.
 *
 * ما لا يثبته اختبار المكتبة: أن الشاشة تعاين ثم تسجّل الرقم نفسه، وأن الرفض
 * يصل برسالةٍ عربية ورمزٍ تقرؤه الواجهة، وأن تعديل السعر والدفعة المقدمة للمدير
 * وحده، وأن كل ذلك يُدقَّق.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let labId = 0;
let supplierId = 0;
let billId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  await db.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'p02-http', 0, 0, 0
      WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`,
  );
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('finance.rate.USD', '530'), ('finance.rate.SAR', '140')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  ({ rows: [{ id: labId }] } = await db.query<{ id: number }>(
    `INSERT INTO parties (name, kind) VALUES ('مختبر P02 HTTP', 'lab') RETURNING id`,
  ));
  ({ rows: [{ id: supplierId }] } = await db.query<{ id: number }>(
    `INSERT INTO parties (name, kind) VALUES ('مورد P02 HTTP', 'supplier') RETURNING id`,
  ));
}, 240_000);

afterAll(async () => {
  await db?.end();
});

const post = (path: string, session: typeof h.sessions.admin, body: unknown) =>
  authedMutation(path, session, "POST", JSON.stringify(body));

async function lastAudit(action: string) {
  const { rows } = await db.query<{ actor: string; details: Record<string, unknown> }>(
    `SELECT actor, details FROM audit_log WHERE action = $1 ORDER BY id DESC LIMIT 1`, [action],
  );
  return rows[0];
}

describe("فاتورة مختبر بالدولار تُسدَّد بالريال — معاينة ثم تسجيل بلقطة", () => {
  it("تسجيل الالتزام يُدقَّق", async () => {
    const response = await post("/api/payables", h.sessions.admin, {
      partyId: labId, description: "تيجان زيركون", amount: "100", currency: "USD",
    });
    expect(response.status).toBe(201);
    const saved = await response.json();
    billId = saved.id;
    expect(saved.category).toBe("lab");
    const { rows: persisted } = await db.query<{ category: string }>(
      "SELECT category FROM payables WHERE id = $1", [billId],
    );
    expect(persisted[0]?.category).toBe("lab");
    const audit = await lastAudit("payable.create");
    expect(audit.actor).toBe("secadmin");
    expect(audit.details["العملة"]).toBe("USD");
    expect(audit.details["التصنيف"]).toBe("lab");
  });

  it("المعاينة تعرض السعر والمكافئ والمتبقي ولا تكتب شيئًا", async () => {
    const before = await db.query(`SELECT COUNT(*)::int AS n FROM expenses`);
    const response = await post("/api/expenses/quote", h.sessions.reception, {
      category: "lab", partyId: labId, payableId: billId, amount: "26500", currency: "YER",
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.quote.rateText).toBe("1 USD = 530 YER");
    expect(payload.quote.payable).toMatchObject({ settledMinor: 5_000, remainingAfterMinor: 5_000 });
    const after = await db.query(`SELECT COUNT(*)::int AS n FROM expenses`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("تأكيدٌ بافتراضات معاينةٍ لم تعد صحيحة ⇒ 409 stale_quote ولا يُكتب شيء", async () => {
    const before = await db.query(`SELECT COUNT(*)::int AS n FROM expenses`);
    const response = await post("/api/expenses", h.sessions.reception, {
      category: "lab", partyId: labId, payableId: billId, amount: "26500", currency: "YER",
      expected: { paymentExchangeRate: 1, payableExchangeRate: 999, payableSettledMinor: 5_000, payableRemainingBeforeMinor: 10_000 },
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("stale_quote");
    const after = await db.query(`SELECT COUNT(*)::int AS n FROM expenses`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("التسجيل يحفظ اللقطة كاملة ويُدقَّق بعملة الفاتورة والمخصوم", async () => {
    const response = await post("/api/expenses", h.sessions.reception, {
      category: "lab", partyId: labId, payableId: billId, amount: "26500", currency: "YER",
    });
    expect(response.status).toBe(201);
    const expense = await response.json();
    expect(expense).toMatchObject({
      currency: "YER", amountMinor: 26_500, payableCurrency: "USD", payableAmountMinor: 10_000,
      payableExchangeRate: 530, payableSettledMinor: 5_000,
    });
    const audit = await lastAudit("expense.create");
    expect(audit.details["عملة_الفاتورة"]).toBe("USD");
    expect(audit.details["المخصوم_من_الفاتورة"]).toBe(5_000);
  });

  it("٩٩٩٬٩٩٩ على المتبقي ⇒ 409 برسالة عربية ورمزٍ للواجهة", async () => {
    const response = await post("/api/expenses", h.sessions.reception, {
      category: "lab", partyId: labId, payableId: billId, amount: "999999", currency: "YER",
    });
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.code).toBe("exceeds_payable");
    expect(payload.message).toContain("المتبقي");
  });

  it("الاستقبال لا يعدّل السعر ولا يعلّم دفعةً مقدمة", async () => {
    const rate = await post("/api/expenses", h.sessions.reception, {
      category: "lab", partyId: labId, payableId: billId, amount: "10000", currency: "YER",
      payableExchangeRate: 540, rateOverrideReason: "سعر السوق",
    });
    expect(rate.status).toBe(403);
    const prepay = await post("/api/expenses", h.sessions.reception, {
      category: "supplier", partyId: supplierId, amount: "5000", currency: "YER",
      prepayment: true, prepaymentReason: "حجز",
    });
    expect(prepay.status).toBe(403);
  });

  it("المدير يعدّل السعر بسبب ⇒ يُحفظ في السند ويُدقَّق بسعر الإعدادات والمستعمل", async () => {
    const response = await post("/api/expenses", h.sessions.admin, {
      category: "lab", partyId: labId, payableId: billId, amount: "10800", currency: "YER",
      payableExchangeRate: 540, rateOverrideReason: "سعر الصرّاف الفعلي",
    });
    expect(response.status).toBe(201);
    const expense = await response.json();
    expect(expense).toMatchObject({ payableExchangeRate: 540, payableSettledMinor: 2_000, rateOverrideReason: "سعر الصرّاف الفعلي" });
    const audit = await lastAudit("expense.rate_override");
    expect(audit.details["سعر_الفاتورة_بالإعدادات"]).toBe(530);
    expect(audit.details["سعر_الفاتورة_المستعمل"]).toBe(540);
  });

  it("إبطال سداد الفاتورة يعيد المتبقي ويُدقَّق", async () => {
    const { rows: [paid] } = await db.query<{ id: number }>(
      `SELECT id FROM expenses WHERE payable_id = $1 AND payable_settled_minor = 5000`, [billId],
    );
    const response = await authedMutation(
      `/api/expenses?id=${paid.id}`, h.sessions.admin, "DELETE", JSON.stringify({ reason: "رقم خاطئ" }),
    );
    expect(response.status).toBe(200);
    const { rows: [left] } = await db.query<{ settled: string }>(
      `SELECT COALESCE(SUM(payable_settled_minor), 0)::text AS settled FROM expenses WHERE payable_id = $1`, [billId],
    );
    expect(Number(left.settled)).toBe(2_000);
  });
});

describe("رصيد المورد — امنع دائمًا فوق المستحق", () => {
  it("سند عادي فوق الرصيد ⇒ 409، والمدير بدفعةٍ مقدمة وسبب ⇒ 201 مدقَّقة", async () => {
    const over = await post("/api/expenses", h.sessions.reception, {
      category: "supplier", partyId: supplierId, amount: "5000", currency: "YER",
    });
    expect(over.status).toBe(409);
    expect((await over.json()).code).toBe("exceeds_party_balance");

    const prepay = await post("/api/expenses", h.sessions.admin, {
      category: "supplier", partyId: supplierId, amount: "5000", currency: "YER",
      prepayment: true, prepaymentReason: "حجز شحنة الشهر القادم",
    });
    expect(prepay.status).toBe(201);
    const audit = await lastAudit("expense.prepayment");
    expect(audit.details["السبب"]).toBe("حجز شحنة الشهر القادم");
  });

  it("تسوية المختبر المجمّعة ترفض عملةً غير صالحة", async () => {
    const response = await post("/api/finance/lab-reconciliation", h.sessions.admin, {
      partyId: labId, orderIds: [1], amountMinor: 100, currency: "EUR",
    });
    expect(response.status).toBe(400);
  });
});

// AUTHORED successor additions. All pre-existing direct quote/confirm, stale
// quote, cross-currency, reversal, rate/prepayment and audit tests above remain.
async function syntheticBatchFixture() {
  const { rows: [party] } = await db.query<{ id: number }>(
    "INSERT INTO parties (name, kind) VALUES ('Synthetic HTTP containment lab', 'lab') RETURNING id");
  const selected: { id: number; payableId: number; amount: number }[] = [];
  for (const amount of [10_000, 10_000, 7_000]) {
    const { rows: [order] } = await db.query<{ id: number }>(
      `INSERT INTO lab_orders (patient_id, lab_name, work_type, due_date, status, party_id,
        cost_minor, cost_currency, financial_status)
       VALUES ($1, 'Synthetic HTTP containment lab', 'Synthetic crown', CURRENT_DATE,
        'delivered', $2, $3, 'YER', 'payable_created') RETURNING id`, [h.seeded.patientAId, party.id, amount]);
    const { rows: [payable] } = await db.query<{ id: number }>(
      `INSERT INTO payables (party_id, category, description, amount_minor, currency, exchange_rate,
        base_amount_minor, base_currency, lab_order_id, created_by)
       VALUES ($1, 'lab', 'Synthetic HTTP debt', $2, 'YER', 1, $2, 'YER', $3, 'synthetic-http') RETURNING id`,
      [party.id, amount, order.id]);
    await db.query("UPDATE lab_orders SET payable_id = $1 WHERE id = $2", [payable.id, order.id]);
    selected.push({ id: order.id, payableId: payable.id, amount });
  }
  return { partyId: party.id, orders: selected, orderIds: selected.slice(0, 2).map((row) => row.id) };
}
async function batchHttpSnapshot(partyId: number) {
  const response = await fetch(`${baseUrl}/api/payables?partyId=${partyId}`, { headers: { Cookie: h.sessions.admin.cookie } });
  expect(response.status).toBe(200);
  return {
    expenses: (await db.query("SELECT * FROM expenses ORDER BY id")).rows,
    allocations: (await db.query("SELECT * FROM expense_payable_allocations ORDER BY id")).rows,
    orders: (await db.query("SELECT * FROM lab_orders ORDER BY id")).rows,
    payables: (await db.query("SELECT * FROM payables ORDER BY id")).rows,
    tracking: (await db.query("SELECT * FROM lab_order_tracking ORDER BY id")).rows,
    audit: (await db.query("SELECT * FROM audit_log ORDER BY id")).rows,
    canonical: await response.json(), // actual partyStatement owner via real HTTP
  };
}
const labBatchPath = "/api/finance/lab-reconciliation";

describe("full-allocation lab batch containment on actual HTTP", () => {
  it("partial selected amount is 409 without financial, marker, tracking or audit mutation, including explicit prepayment", async () => {
    const fixture = await syntheticBatchFixture();
    const before = await batchHttpSnapshot(fixture.partyId);
    for (const prepayment of [false, true]) {
      const response = await post(labBatchPath, h.sessions.admin, { partyId: fixture.partyId,
        orderIds: fixture.orderIds, amountMinor: 15_000, currency: "YER", prepayment,
        prepaymentReason: prepayment ? "Synthetic reason cannot bypass exact selection" : undefined });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({ code: "batch_requires_full_allocation", quote: null });
      expect(body.message).toEqual(expect.any(String)); expect(body).not.toHaveProperty("totalPaidMinor");
      expect(await batchHttpSnapshot(fixture.partyId)).toEqual(before);
    }
    expect(before.canonical.payables.map((row: { remainingMinor: number }) => row.remainingMinor).sort((a: number, b: number) => a - b))
      .toEqual([7_000, 10_000, 10_000]);
  });

  it("valid exact full batch preserves success/audit shape and normalized retry has no second write", async () => {
    const fixture = await syntheticBatchFixture();
    const before = await batchHttpSnapshot(fixture.partyId);
    const ids = [fixture.orderIds[1], fixture.orderIds[0], fixture.orderIds[1]];
    const request = { partyId: fixture.partyId, orderIds: ids, amountMinor: 20_000, currency: "YER", requestId: "ignored-synthetic-token" };
    const response = await post(labBatchPath, h.sessions.admin, request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, settledCount: 2, totalPaidMinor: 20_000, currency: "YER" });
    expect(body.expenseId).toEqual(expect.any(Number)); expect(body.voucherNumber).toEqual(expect.any(String));
    const after = await batchHttpSnapshot(fixture.partyId);
    expect(after.expenses).toHaveLength(before.expenses.length + 1);
    expect(after.allocations).toHaveLength(before.allocations.length + 2);
    expect(after.tracking).toHaveLength(before.tracking.length + 2);
    expect(after.audit).toHaveLength(before.audit.length + 1);
    expect(after.payables).toEqual(before.payables);
    expect(after.allocations.filter((row) => row.expense_id === body.expenseId)).toMatchObject(
      fixture.orders.slice(0, 2).map((row) => ({ expense_id: body.expenseId, payable_id: row.payableId,
        paid_minor: "10000", settled_minor: "10000", payable_currency: "YER", payable_exchange_rate: "1.000000" })));
    expect(after.canonical.payables.filter((row: { id: number }) => fixture.orders.slice(0, 2).some((order) => order.payableId === row.id)))
      .toEqual(expect.arrayContaining(fixture.orders.slice(0, 2).map((row) => expect.objectContaining({ id: row.payableId, remainingMinor: 0 }))));
    const unselected = fixture.orders[2];
    expect(after.orders.find((row) => row.id === unselected.id)).toEqual(before.orders.find((row) => row.id === unselected.id));
    expect(after.canonical.payables.find((row: { id: number }) => row.id === unselected.payableId).remainingMinor).toBe(7_000);
    expect(after.tracking.filter((row) => row.expense_id === body.expenseId).map((row) => row.lab_order_id).sort((a, b) => a - b)).toEqual(fixture.orderIds);
    const audit = await lastAudit("expense.create");
    expect(audit.actor).toBe("secadmin");
    expect(audit.details).toMatchObject({ type: "lab_batch_reconciliation", partyId: fixture.partyId,
      orderIds: fixture.orderIds, settledOrdersCount: 2, amountMinor: 20_000, currency: "YER", voucherNumber: body.voucherNumber });
    const retry = await post(labBatchPath, h.sessions.admin, request);
    expect(retry.status).toBe(409); expect((await retry.json()).code).toBe("orders_already_paid");
    expect(await batchHttpSnapshot(fixture.partyId)).toEqual(after);
  });

  it("batch remains admin-only through real session/proxy admission, even with a full valid selection", async () => {
    const fixture = await syntheticBatchFixture(), before = await batchHttpSnapshot(fixture.partyId);
    for (const role of ["doctorA", "reception", "accountant", "cashier"] as const) {
      const response = await post(labBatchPath, h.sessions[role], { partyId: fixture.partyId,
        orderIds: fixture.orderIds, amountMinor: 20_000, currency: "YER" });
      expect(response.status, role).toBe(403);
      expect(await batchHttpSnapshot(fixture.partyId)).toEqual(before);
    }
  });
});
