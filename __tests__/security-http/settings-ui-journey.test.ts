import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

/** Browser proof for Phase 1B: UI -> persistence -> audit -> real recall consumer. */
let browser: Browser;
let context: BrowserContext;
let page: Page;
let db: Client;
let appointmentId: number;
let securityHarness: Awaited<ReturnType<typeof harness>>;

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

function settingCard(label: string) {
  return page.getByRole("article", { name: label });
}

async function openFollowUpEditor(value: string) {
  const search = page.getByRole("searchbox", { name: "بحث في الإعدادات" });
  await search.fill("مدى متابعة المواعيد");
  await settingCard("مدى متابعة المواعيد").getByRole("button", { name: "تعديل", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "مدى متابعة المواعيد" });
  await dialog.getByLabel("مدى متابعة المواعيد").fill(value);
  await dialog.getByRole("button", { name: "حفظ التغيير" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("status").filter({ hasText: "حُفظ الإعداد" }).waitFor();
}

async function recallIncludes(id: number): Promise<boolean> {
  return page.evaluate(async (wanted) => {
    const response = await fetch("/api/recall", { cache: "no-store" });
    if (!response.ok) throw new Error(`recall HTTP ${response.status}`);
    const payload = await response.json();
    return payload.openPast.some((row: { id: number }) => row.id === wanted);
  }, id);
}

beforeAll(async () => {
  const h = await harness();
  securityHarness = h;
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const inserted = await db.query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, note)
     VALUES ($1, ((NOW() AT TIME ZONE 'Asia/Aden')::date - 20), '10:00', 30, 'phase-1b-ui-proof')
     RETURNING id`,
    [h.seeded.patientAId],
  );
  appointmentId = inserted.rows[0].id;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
  page = await context.newPage();
  await page.goto(`${baseUrl}/settings`);
  await page.getByRole("heading", { name: "الإعدادات المركزية", exact: true }).waitFor();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  if (db) {
    if (appointmentId) await db.query("DELETE FROM appointments WHERE id = $1", [appointmentId]);
    await db.end();
  }
});

describe("رحلة واجهة الإعداد إلى المستهلك الحقيقي", () => {
  it("تغيّر نافذة المتابعة وتحفظ التدقيق ثم تعيد الافتراضي", async () => {
    const output = join(process.cwd(), ".settings-ui-artifacts");
    await mkdir(output, { recursive: true });
    expect(await recallIncludes(appointmentId)).toBe(true);

    const search = page.getByRole("searchbox", { name: "بحث في الإعدادات" });
    await search.fill("مدى متابعة المواعيد");
    await settingCard("مدى متابعة المواعيد").getByRole("button", { name: "تعديل", exact: true }).click();
    const cancelled = page.getByRole("dialog", { name: "مدى متابعة المواعيد" });
    await cancelled.getByLabel("مدى متابعة المواعيد").fill("5");
    await cancelled.getByRole("button", { name: "إلغاء", exact: true }).click();
    await cancelled.waitFor({ state: "hidden" });
    expect(await recallIncludes(appointmentId)).toBe(true);

    await openFollowUpEditor("10");
    expect(await recallIncludes(appointmentId)).toBe(false);
    const firstHistory = await page.evaluate(async () => (await fetch(
      "/api/settings/history?key=ops.follow_up_lookback_days&limit=10", { cache: "no-store" },
    )).json());
    expect(firstHistory[0]).toMatchObject({ before: "30", after: "10", action: "clinic_settings.update" });

    await openFollowUpEditor("60");
    expect(await recallIncludes(appointmentId)).toBe(true);
    await page.screenshot({ path: join(output, "settings-desktop-rtl.png"), fullPage: true });

    await settingCard("مدى متابعة المواعيد").getByRole("button", { name: "إعادة الافتراضي" }).click();
    const reset = page.getByRole("dialog", { name: /إعادة.*مدى متابعة المواعيد/ });
    await reset.getByRole("button", { name: "تأكيد الإعادة" }).click();
    await reset.waitFor({ state: "hidden" });
    expect(await recallIncludes(appointmentId)).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/settings`);
    await settingCard("اسم المركز").waitFor();
    expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
    expect(await page.getByRole("navigation", { name: "فئات الإعدادات" }).isVisible()).toBe(false);
    await page.getByRole("button", { name: /الفئات ·/ }).click();
    expect(await page.getByRole("navigation", { name: "فئات الإعدادات" }).isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: join(output, "settings-mobile-rtl.png"), fullPage: true });

    await page.goto(`${baseUrl}/settings/history`);
    await page.getByRole("heading", { name: "سجل تغييرات الإعدادات", exact: true }).waitFor();
    await page.getByRole("article").first().waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await page.getByRole("article").count()).toBeGreaterThan(0);
    await page.screenshot({ path: join(output, "settings-history-mobile-rtl.png"), fullPage: true });

    await page.getByLabel("الإعداد", { exact: true }).selectOption("ops.follow_up_lookback_days");
    await page.getByLabel("الفعل", { exact: true }).selectOption("clinic_settings.update");
    const filtered = page.waitForResponse((response) => response.url().includes("/api/settings/history?")
      && response.url().includes("action=clinic_settings.update"));
    await page.getByRole("button", { name: "تطبيق الفلاتر" }).click();
    const filteredRows = await (await filtered).json();
    expect(filteredRows).toHaveLength(2);
    expect(filteredRows.every((row: { action: string }) => row.action === "clinic_settings.update")).toBe(true);
    await page.getByRole("article").first().getByRole("button", { name: "استعادة القيمة السابقة" }).click();
    const restore = page.getByRole("dialog", { name: "استعادة قيمة سابقة" });
    await restore.getByLabel(/سبب الاستعادة/).fill("إثبات الاستعادة من واجهة المالك");
    await restore.getByRole("button", { name: "تأكيد الاستعادة" }).click();
    await restore.waitFor({ state: "hidden" });
    expect(await recallIncludes(appointmentId)).toBe(false);
    const restoredHistory = await page.evaluate(async () => (await fetch(
      "/api/settings/history?key=ops.follow_up_lookback_days&limit=10",
    )).json());
    expect(restoredHistory).toHaveLength(4);
    expect(restoredHistory[0]).toMatchObject({ before: "30", after: "10", reason: "إثبات الاستعادة من واجهة المالك" });
    await page.goto(`${baseUrl}/settings`);
    await openFollowUpEditor("30");
  }, 120_000);

  it("يعرض تجربة قراءة نظيفة للاستقبال بلا أزرار تحرير", async () => {
    const readOnly = await browser.newContext({ viewport: { width: 768, height: 900 }, locale: "ar-YE" });
    try {
      await readOnly.addCookies([{ ...sessionCookie(securityHarness.sessions.reception.cookie), url: baseUrl }]);
      const readOnlyPage = await readOnly.newPage();
      await readOnlyPage.goto(`${baseUrl}/settings`);
      await readOnlyPage.getByText("عرض للقراءة فقط حسب صلاحيات حسابك.").waitFor();
      expect(await readOnlyPage.getByRole("button", { name: "تعديل", exact: true }).count()).toBe(0);
      expect(await readOnlyPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    } finally {
      await readOnly.close();
    }
  });

  it("يعرض تعارض 409 ويحتفظ بالمقترح للمراجعة بلا إعادة تلقائية", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/settings`);
    await page.getByRole("searchbox", { name: "بحث في الإعدادات" }).fill("هاتف المركز");
    const card = settingCard("هاتف المركز");
    await card.getByRole("button", { name: "تعديل", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "هاتف المركز" });
    const original = await page.evaluate(async () => (await fetch("/api/settings", { cache: "no-store" })).json());
    await dialog.getByLabel("هاتف المركز").fill("04-333333");
    const concurrent = await page.evaluate(async (version) => {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "clinic.phone": "04-111111", __versions: { "clinic.phone": version } }),
      });
      return response.status;
    }, original.__versions["clinic.phone"]);
    expect(concurrent).toBe(200);
    await dialog.getByRole("button", { name: "حفظ التغيير" }).click();
    await dialog.getByText("تعارض تعديل").waitFor();
    expect(await dialog.textContent()).toContain("04-333333");
    expect(await dialog.textContent()).toContain("04-111111");
    await dialog.getByRole("button", { name: "إلغاء تعديلي" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(await card.textContent()).not.toContain("04-333333");

    const cleanup = await page.evaluate(async (value) => {
      const latest = await (await fetch("/api/settings", { cache: "no-store" })).json();
      return (await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "clinic.phone": value, __versions: { "clinic.phone": latest.__versions["clinic.phone"] } }),
      })).status;
    }, original["clinic.phone"]);
    expect(cleanup).toBe(200);
  });

  it("يفرض السبب والتحقق ويعرض المقفل ويحصر التركيز داخل الحوار", async () => {
    await page.goto(`${baseUrl}/settings`);
    const search = page.getByRole("searchbox", { name: "بحث في الإعدادات" });
    await search.fill("العملة الأساسية");
    await settingCard("العملة الأساسية").getByRole("button", { name: "تعديل", exact: true }).click();
    const finance = page.getByRole("dialog", { name: "العملة الأساسية" });
    await finance.getByLabel("العملة الأساسية").selectOption("SAR");
    expect(await finance.getByRole("button", { name: "حفظ التغيير" }).isDisabled()).toBe(true);
    expect(await finance.textContent()).toContain("قبل التأكيد");
    await finance.getByLabel(/سبب التغيير/).fill("مراجعة فقط");
    expect(await finance.getByRole("button", { name: "حفظ التغيير" }).isEnabled()).toBe(true);
    expect(await finance.evaluate((element) => element.matches(":modal"))).toBe(true);
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      // Native dialogs may let Tab visit browser chrome (activeElement=body),
      // but must never focus an actionable control in the background page.
      expect(await finance.evaluate((element) => document.activeElement === document.body
        || element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await finance.waitFor({ state: "hidden" });

    await search.fill("تحذير الانتظار");
    await settingCard("تحذير الانتظار").getByRole("button", { name: "تعديل", exact: true }).click();
    const waiting = page.getByRole("dialog", { name: "تحذير الانتظار" });
    await waiting.getByLabel("تحذير الانتظار").fill("40");
    expect(await waiting.getByRole("alert").count()).toBeGreaterThan(0);
    expect(await waiting.getByRole("button", { name: "حفظ التغيير" }).isDisabled()).toBe(true);
    await page.keyboard.press("Escape");
    await search.fill("Google Drive");
    const locked = settingCard("الوجهة: Google Drive");
    expect(await locked.textContent()).toContain("محكوم بالنظام");
    expect(await locked.getByRole("button").count()).toBe(0);
  });
});
