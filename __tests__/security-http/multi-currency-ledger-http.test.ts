import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (TD-REG-028) الدفتر بعملاته الأصلية عبر المسارات الحقيقية:
 *  - القيد اليدوي: عملة كل سطر إلزامية، والتوازن داخل كل عملة يُفحص على الخادم (رسالة عربية)،
 *    والقيد المقبول يُدقَّق بعملات أسطره.
 *  - ميزان المراجعة وقوائمه لكل عملة؛ وCSV القيود يحمل عمود العملة.
 *  - ترحيل «إعادة التقييم» متوقف بقرارٍ موثَّق (409 عربي) — لا حذفٌ صامت.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
}, 120_000);
afterAll(async () => { await db?.end(); });

const DATE = "2026-09-15";
const post = (lines: unknown[], description = "قيد اختبار العملات") => authedMutation("/api/accounting", h.sessions.admin, "POST",
  JSON.stringify({ date: DATE, description, lines }));

describe("(TD-REG-028) manual journal — one currency unit per line, balanced per currency", () => {
  it("refuses Dr Cash 100 SAR / Cr Revenue 100 YER with an Arabic message and writes nothing", async () => {
    const response = await post([
      { accountCode: "1102", currency: "SAR", amount: "100", side: "debit" },
      { accountCode: "4101", currency: "YER", amount: "100", side: "credit" },
    ], "قيد ممزوج مرفوض");
    expect(response.status).toBe(400);
    expect((await response.json() as { message: string }).message).toContain("كل عملة");
    const { rows } = await db.query(`SELECT id FROM journal_manual WHERE description = 'قيد ممزوج مرفوض'`);
    expect(rows).toHaveLength(0);
  });

  it("refuses a line without a currency", async () => {
    const response = await post([
      { accountCode: "1101", amount: "100", side: "debit" },
      { accountCode: "4101", currency: "YER", amount: "100", side: "credit" },
    ]);
    expect(response.status).toBe(400);
    expect((await response.json() as { message: string }).message).toBe("حدّد عملة كل سطر في القيد.");
  });

  it("accepts a balanced SAR entry, stores its currency, audits it, and the trial balance shows it in SAR only", async () => {
    const response = await post([
      { accountCode: "1102", currency: "SAR", amount: "100", side: "debit" },
      { accountCode: "4101", currency: "SAR", amount: "100", side: "credit" },
    ], "تسوية سعودية HTTP");
    expect(response.status).toBe(201);
    const { id } = await response.json() as { id: number };
    const { rows: lines } = await db.query<{ currency: string; amount_minor: string }>(
      `SELECT currency, amount_minor::text FROM journal_manual_lines WHERE entry_id = $1 ORDER BY id`, [id]);
    expect(lines).toEqual([{ currency: "SAR", amount_minor: "10000" }, { currency: "SAR", amount_minor: "10000" }]);
    const { rows: [audit] } = await db.query<{ details: Record<string, string> }>(
      `SELECT details FROM audit_log WHERE action = 'journal.manual' AND entity_id = $1`, [String(id)]);
    expect(audit.details.الأسطر).toContain("SAR");

    const ledger = await authedGet(`/api/accounting?from=${DATE}&to=${DATE}`, h.sessions.admin);
    expect(ledger.status).toBe(200);
    const body = await ledger.json() as {
      balances: { code: string; currency: string; balanceMinor: number }[];
      statements: { currency: string; sheet: { differenceMinor: number } }[];
    };
    expect(body.balances.find((row) => row.code === "1102" && row.currency === "SAR")?.balanceMinor).toBe(10000);
    expect(body.balances.some((row) => row.code === "1102" && row.currency === "YER")).toBe(false);
    for (const statement of body.statements) expect(statement.sheet.differenceMinor).toBe(0);
    expect("income" in body).toBe(false);
  });

  it("manual journals are append-only in the database", async () => {
    const { rows: [line] } = await db.query<{ id: number }>(
      `SELECT l.id FROM journal_manual_lines l JOIN journal_manual m ON m.id = l.entry_id WHERE m.description = 'تسوية سعودية HTTP' LIMIT 1`);
    await expect(db.query(`UPDATE journal_manual_lines SET amount_minor = 1 WHERE id = $1`, [line.id])).rejects.toThrow(/لا يُعدَّل/);
  });

  it("the journal CSV carries the currency of every line", async () => {
    const csv = await authedGet(`/api/export?table=journal&from=${DATE}&to=${DATE}`, h.sessions.admin);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text).toContain("العملة");
    expect(text).toMatch(/1102,SAR,10000/);
  });
});

describe("(TD-REG-028) FX revaluation posting is retired by a documented decision", () => {
  it("POST refuses with 409 and an Arabic reason; GET is a translation view", async () => {
    const response = await authedMutation("/api/finance/fx", h.sessions.admin, "POST", JSON.stringify({ currency: "USD" }));
    expect(response.status).toBe(409);
    expect((await response.json() as { message: string }).message).toContain("بعملاتها الأصلية");
    const view = await authedGet("/api/finance/fx", h.sessions.admin);
    expect(view.status).toBe(200);
    expect((await view.json() as { mode: string }).mode).toBe("translation_only");
  });
});
