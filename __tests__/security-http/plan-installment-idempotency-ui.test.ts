import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * (FIN-1) لا سندان لقسطٍ واحد — في متصفحٍ حقيقي على التطبيق المبني.
 *
 * «تحصيل قسط» في ملف المريض لم يرسل مفتاح إعادةٍ قط، والخادم لم يدعمه على هذا المسار:
 * انقطاع الرد بعد أن سجّل الخادم القسط ثم «أعد المحاولة» كان يُنتج فاتورتين وسندين عن
 * نقدٍ قُبض مرة. هنا نقطع الرد عمدًا بعد وصول الطلب (route.fetch ثم abort) ونعيد النقر
 * كما يفعل المحصّل — كاختبار نافذة التحصيل العادية (P1-1).
 */

let browser: Browser;
let db: Client;
let patientId = 0;
let planId = 0;
let securityHarness: Awaited<ReturnType<typeof harness>>;

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

async function planReceipts(): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM payments WHERE plan_id = $1`, [planId],
  );
  return rows[0].n;
}

async function openCollect(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(securityHarness.sessions.admin.cookie), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/patients/${patientId}?tab=plans`);
  await page.getByRole("button", { name: "تحصيل قسط" }).first().click();
  await page.getByLabel("مبلغ القسط").waitFor();
  return { context, page };
}

beforeAll(async () => {
  securityHarness = await harness();
  patientId = securityHarness.seeded.patientBId;
  db = new Client({ connectionString: securityHarness.seeded.dbUrl, ssl: false });
  await db.connect();
  await db.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'fin1-ui', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`,
  );
  const { rows: [plan] } = await db.query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, start_date, created_by)
     VALUES ($1, 'تقويم — اختبار الأقساط', 3000000, 'YER', CURRENT_DATE, 'fin1-ui') RETURNING id`,
    [patientId],
  );
  planId = plan.id;
  await db.query(
    `INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
     VALUES ($1, 1, CURRENT_DATE, 1000000), ($1, 2, CURRENT_DATE + 30, 1000000), ($1, 3, CURRENT_DATE + 60, 1000000)`,
    [planId],
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
}, 240_000);

describe("DOT-PF-01 installment acknowledgments", () => {
  it.each(["{", "{}"])("keeps a committed installment pending after response %s", async (body) => {
    const { context, page } = await openCollect();
    const keys: string[] = [];
    await page.route(`**/api/plans/${planId}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      if (keys.length === 1) {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.fulfill({ status: 201, contentType: "application/json", body });
      } else await route.continue();
    });
    try {
      const before = await planReceipts();
      await page.getByLabel("مبلغ القسط").fill("11");
      await page.getByRole("button", { name: "سجّل القسط واطبع السند" }).click();
      const retry = page.getByRole("button", { name: "إعادة التحقق من العملية السابقة" });
      await retry.waitFor();
      expect(await page.getByText("سُجّل القسط.").count()).toBe(0);
      expect(await planReceipts()).toBe(before + 1);
      await retry.click();
      await page.getByText("سُجّل القسط.").waitFor();
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      expect(await planReceipts()).toBe(before + 1);
    } finally { await context.close(); }
  }, 120_000);
});

afterAll(async () => {
  await browser?.close();
  await db?.end();
});

describe("تحصيل قسط الخطة — سندٌ واحد مهما أُعيد الطلب", () => {
  it("انقطاع الشبكة بعد تسجيل الخادم ثم إعادة المحاولة ⇒ سندٌ واحد بالمفتاح نفسه", async () => {
    const { context, page } = await openCollect();
    const keys: string[] = [];
    let dropped = false;
    await page.route(`**/api/plans/${planId}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      if (!dropped) {
        dropped = true;
        await route.fetch(); // الخادم يسجّل القسط فعلًا…
        await route.abort("failed"); // …والمتصفح لا يصله الرد.
        return;
      }
      await route.continue();
    });
    try {
      const before = await planReceipts();
      const submit = page.getByRole("button", { name: "سجّل القسط واطبع السند" });
      await submit.click();
      await page.getByRole("button", { name: "إعادة التحقق من العملية السابقة" }).waitFor();
      expect(await planReceipts()).toBe(before + 1); // سُجّل رغم انقطاع الرد

      const replay = page.waitForResponse((response) =>
        response.url().endsWith(`/api/plans/${planId}`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "إعادة التحقق من العملية السابقة" }).click();
      expect((await replay).status()).toBe(200); // إعادة (replay) لا قسط جديد (201)
      await page.getByText("سُجّل القسط.").waitFor();

      expect(await planReceipts()).toBe(before + 1);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
      expect(keys[1]).toBe(keys[0]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("نقرٌ مزدوج سريع ⇒ قسطٌ واحد", async () => {
    const { context, page } = await openCollect();
    try {
      const before = await planReceipts();
      await page.getByRole("button", { name: "سجّل القسط واطبع السند" }).dblclick();
      await page.getByText("سُجّل القسط.").waitFor();
      expect(await planReceipts()).toBe(before + 1);
    } finally {
      await context.close();
    }
  }, 120_000);
});
