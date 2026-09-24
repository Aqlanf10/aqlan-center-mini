import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * (P1-1) لا سندان لتحصيلٍ واحد — في متصفحٍ حقيقي على التطبيق المبني.
 *
 * العيب: الخادم يدعم Idempotency-Key لكن نافذة التحصيل لم ترسله قط؛ فانقطاع الشبكة
 * بعد أن سجّل الخادم الدفعة، ثم «أعد المحاولة»، كان يُنتج سندين. هنا نقطع الردّ عمدًا
 * بعد وصول الطلب إلى الخادم (route.fetch ثم abort) ونعيد النقر كما يفعل المحصّل.
 */

let browser: Browser;
let db: Client;
let patientId = 0;
let securityHarness: Awaited<ReturnType<typeof harness>>;

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

async function paymentsCount(): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM payments WHERE patient_id = $1`, [patientId],
  );
  return rows[0].n;
}

async function openCollect(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(securityHarness.sessions.admin.cookie), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`);
  await page.getByRole("button", { name: /الحساب/ }).first().click();
  await page.getByRole("button", { name: "قبض دفعة" }).click();
  await page.getByRole("dialog", { name: "تحصيل دفعة" }).waitFor();
  return { context, page };
}

beforeAll(async () => {
  securityHarness = await harness();
  patientId = securityHarness.seeded.patientAId;
  db = new Client({ connectionString: securityHarness.seeded.dbUrl, ssl: false });
  await db.connect();
  await db.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'p11-ui', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`,
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await db?.end();
});

describe("نافذة التحصيل — سندٌ واحد مهما أُعيد الطلب", () => {
  it("انقطاع الشبكة بعد تسجيل الخادم ثم إعادة المحاولة ⇒ سندٌ واحد بالمفتاح نفسه", async () => {
    const { context, page } = await openCollect();
    const keys: string[] = [];
    let dropped = false;
    await page.route("**/api/payments", async (route) => {
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      if (!dropped) {
        dropped = true;
        await route.fetch(); // الخادم يسجّل الدفعة فعلًا…
        await route.abort("failed"); // …والمتصفح لا يصله الرد.
        return;
      }
      await route.continue();
    });
    try {
      const before = await paymentsCount();
      const dialog = page.getByRole("dialog", { name: "تحصيل دفعة" });
      await dialog.getByLabel("المبلغ").fill("1234");
      const submit = dialog.getByRole("button", { name: "سجّل الدفعة واطبع السند" });
      await submit.click();
      await dialog.getByText("تعذّر الاتصال بالخادم").waitFor();
      expect(await paymentsCount()).toBe(before + 1); // سُجّل رغم انقطاع الرد

      const replay = page.waitForResponse((response) => response.url().endsWith("/api/payments"));
      await submit.click();
      expect((await replay).status()).toBe(200); // إعادة (replay) لا سند جديد (201)
      await dialog.waitFor({ state: "hidden" });

      expect(await paymentsCount()).toBe(before + 1);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
      expect(keys[1]).toBe(keys[0]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("نقرٌ مزدوج سريع ⇒ طلبٌ واحد وسندٌ واحد", async () => {
    const { context, page } = await openCollect();
    const requests: Request[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/payments") && request.method() === "POST") requests.push(request);
    });
    try {
      const before = await paymentsCount();
      const dialog = page.getByRole("dialog", { name: "تحصيل دفعة" });
      await dialog.getByLabel("المبلغ").fill("777");
      await dialog.getByRole("button", { name: "سجّل الدفعة واطبع السند" }).dblclick();
      await dialog.waitFor({ state: "hidden" });
      expect(await paymentsCount()).toBe(before + 1);
      const distinctKeys = new Set(requests.map((request) => request.headers()["idempotency-key"]));
      expect(distinctKeys.size).toBe(1);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("تعديل المبلغ بعد خطأ طلبٌ جديد بمفتاحٍ جديد — لا تعارض مفتاح", async () => {
    const { context, page } = await openCollect();
    const keys: string[] = [];
    let failFirst = true;
    await page.route("**/api/payments", async (route) => {
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      if (failFirst) {
        failFirst = false;
        await route.abort("failed"); // لم يصل الخادم أصلًا
        return;
      }
      await route.continue();
    });
    try {
      const before = await paymentsCount();
      const dialog = page.getByRole("dialog", { name: "تحصيل دفعة" });
      await dialog.getByLabel("المبلغ").fill("500");
      const submit = dialog.getByRole("button", { name: "سجّل الدفعة واطبع السند" });
      await submit.click();
      await dialog.getByText("تعذّر الاتصال بالخادم").waitFor();
      await dialog.getByLabel("المبلغ").fill("600");
      await submit.click();
      await dialog.waitFor({ state: "hidden" });
      expect(await paymentsCount()).toBe(before + 1);
      expect(keys).toHaveLength(2);
      expect(keys[1]).not.toBe(keys[0]);
    } finally {
      await context.close();
    }
  }, 120_000);
});
