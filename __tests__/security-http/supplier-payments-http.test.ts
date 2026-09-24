import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

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
    billId = (await response.json()).id;
    const audit = await lastAudit("payable.create");
    expect(audit.actor).toBe("secadmin");
    expect(audit.details["العملة"]).toBe("USD");
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
