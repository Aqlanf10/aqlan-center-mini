import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, harness } from "./_server";

/**
 * (P3-2) جاهزية النظام لا تقول «مضبوطة» عن سعر صرفٍ لم يحفظه أحد أو قَدُم.
 *
 * العيب (تدقيق الجاهزية): 140/530 معبّأة من يوم التثبيت، وفحص الجاهزية يعدّها
 * «مضبوطة» ما دامت أكبر من صفر — فنسيانُ تحديثها لا يظهر في أي شاشة.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let saved: { key: string; value: string }[] = [];

async function exchangeCheck() {
  const response = await authedGet("/api/settings/readiness", h.sessions.admin);
  expect(response.status).toBe(200);
  const payload = await response.json() as { checks: { id: string; status: string; description: string }[] };
  return payload.checks.find((check) => check.id === "exchange_rates")!;
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: saved } = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key IN ('finance.rate.SAR', 'finance.rate.USD')`,
  ));
}, 240_000);

afterAll(async () => {
  // يُعاد ما كان كما كان: ملفاتٌ أخرى تقرأ الأسعار من الجدول نفسه.
  await db?.query(`DELETE FROM settings WHERE key IN ('finance.rate.SAR', 'finance.rate.USD')`);
  for (const row of saved) {
    await db?.query(`INSERT INTO settings (key, value) VALUES ($1, $2)`, [row.key, row.value]);
  }
  await db?.end();
});

describe("P3-2 — exchange-rate readiness", () => {
  it("install defaults that nobody saved are a warning, not «مضبوطة»", async () => {
    await db.query(`DELETE FROM settings WHERE key IN ('finance.rate.SAR', 'finance.rate.USD')`);
    const check = await exchangeCheck();
    expect(check.status).toBe("warn");
    expect(check.description).toContain("القيمة الافتراضية");
  });

  it("rates saved long ago are a warning with their age", async () => {
    await db.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('finance.rate.SAR', '140', NOW() - INTERVAL '30 days'), ('finance.rate.USD', '530', NOW() - INTERVAL '2 days')`,
    );
    const check = await exchangeCheck();
    expect(check.status).toBe("warn");
    expect(check.description).toContain("30");
  });

  it("recently saved rates pass", async () => {
    await db.query(`UPDATE settings SET updated_at = NOW() WHERE key IN ('finance.rate.SAR', 'finance.rate.USD')`);
    expect((await exchangeCheck()).status).toBe("pass");
  });
});
