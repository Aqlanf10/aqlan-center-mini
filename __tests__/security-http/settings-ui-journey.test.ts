import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

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

// Create real JSON audit history even when this file runs alone; restore the
// setting immediately so this regression does not depend on another suite.
async function seedTemplateHistory() {
  const key = "plans.specialty_templates";
  const original = await (await authedGet("/api/settings", securityHarness.sessions.admin)).json();
  const catalog = await (await authedGet("/api/plan-templates", securityHarness.sessions.admin)).json();
  const template = catalog.templates.find((entry: { id: string }) => entry.id === "endo") ?? catalog.templates[0];
  expect(template).toBeTruthy();
  for (const value of [JSON.stringify([template]), original[key]]) {
    const current = await (await authedGet("/api/settings", securityHarness.sessions.admin)).json();
    const saved = await authedMutation("/api/settings", securityHarness.sessions.admin, "PATCH", JSON.stringify({
      [key]: value, __versions: { [key]: current.__versions[key] }, __reason: "إثبات عرض سجل القوالب دون تجاوز العرض",
    }));
    expect(saved.status).toBe(200);
  }
}

async function reachableControl(control: Locator, output: string, name: string) {
  const inspect = () => control.evaluate((element) => {
    const r = element.getBoundingClientRect(); const x = (r.left + r.right) / 2; const y = (r.top + r.bottom) / 2;
    const points = [[x, y], [r.left + 2, y], [r.right - 2, y], [x, r.top + 2], [x, r.bottom - 2]];
    return { rect: r.toJSON(), viewport: { width: innerWidth, height: innerHeight }, scrollX,
      entire: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
      hit: points.every(([px, py]) => { const target = document.elementFromPoint(px, py); return target !== null && element.contains(target); }),
    };
  });
  let geometry = await inspect();
  const wheelSteps: { deltaY: number; before: typeof geometry; after: typeof geometry }[] = [];
  // Native wheel input over the visible content gutter; never reposition the DOM.
  // Bound attempts and distance, then retain the same complete-box/five-hit checks.
  for (let attempt = 0; attempt < 16 && (!geometry.entire || !geometry.hit); attempt++) {
    const before = geometry;
    const distance = (before.rect.top + before.rect.bottom) / 2 - before.viewport.height / 2;
    const deltaY = Math.sign(distance || 1) * Math.min(600, Math.max(120, Math.abs(distance)));
    await control.page().mouse.move(24, before.viewport.height / 2);
    await control.page().mouse.wheel(0, deltaY);
    await control.page().waitForTimeout(100); // Allow the native compositor scroll to settle.
    geometry = await inspect();
    wheelSteps.push({ deltaY, before, after: geometry });
  }
  await writeFile(join(output, `${name}-hit-area.json`), JSON.stringify({ ...geometry, wheelSteps }, null, 2));
  expect(geometry.entire).toBe(true);
  expect(geometry.hit).toBe(true);
  expect(geometry.scrollX).toBe(0);
  expect(await control.isEnabled()).toBe(true);
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

    await seedTemplateHistory();
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
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      const geometry = await page.evaluate(() => ({
        viewport: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
        offenders: Array.from(document.querySelectorAll<HTMLElement>("main *")).flatMap((el) => {
          const r = el.getBoundingClientRect(); const c = getComputedStyle(el);
          return r.width && (r.left < 0 || r.right > window.innerWidth || el.scrollWidth > el.clientWidth + 1) ? [{
            tag: el.tagName, html: el.outerHTML.slice(0, 800), rect: r.toJSON(), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
            minWidth: c.minWidth, width: c.width, overflowX: c.overflowX, overflowWrap: c.overflowWrap, display: c.display,
          }] : [];
        }),
      }));
      await writeFile(join(output, `settings-history-${width}-geometry.json`), JSON.stringify(geometry, null, 2));
      await page.screenshot({ path: join(output, `settings-history-${width}-diagnostic.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(geometry.offenders).toEqual([]);
      await reachableControl(page.getByRole("button", { name: "تطبيق الفلاتر" }), output, `settings-history-${width}-filter`);
      const templateEntry = page.getByRole("article", { name: "قوالب الخطط حسب التخصص", exact: true }).first();
      const restoreButton = templateEntry.getByRole("button", { name: "استعادة القيمة السابقة" });
      await reachableControl(restoreButton, output, `settings-history-${width}-restore`);
      await page.screenshot({ path: join(output, `settings-history-${width}-template-value.png`) });
      await page.screenshot({ path: join(output, `settings-history-${width}-restore-action.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await page.getByRole("article").count()).toBeGreaterThan(0);
    await page.screenshot({ path: join(output, "settings-history-mobile-rtl.png"), fullPage: true });

    await page.getByLabel("الإعداد", { exact: true }).selectOption("ops.follow_up_lookback_days");
    await page.getByLabel("الفعل", { exact: true }).selectOption("clinic_settings.update");
    const filtered = page.waitForResponse((response) => response.url().includes("/api/settings/history?")
      && response.url().includes("action=clinic_settings.update"));
    await page.getByRole("button", { name: "تطبيق الفلاتر" }).click();
    const filteredResponse = await filtered;
    expect(filteredResponse.status()).toBe(200);
    const filterUrl = new URL(filteredResponse.url());
    expect(filterUrl.searchParams.get("key")).toBe("ops.follow_up_lookback_days");
    expect(filterUrl.searchParams.get("action")).toBe("clinic_settings.update");
    const filteredRows = await filteredResponse.json() as Array<{
      id: string; key: string; action: string; before: string; after: string; at: string;
    }>;
    expect(filteredRows).toHaveLength(2);
    expect(filteredRows.every((row) => row.action === "clinic_settings.update")).toBe(true);
    expect(filteredRows).toMatchObject([
      { key: "ops.follow_up_lookback_days", action: "clinic_settings.update", before: "10", after: "60" },
      { key: "ops.follow_up_lookback_days", action: "clinic_settings.update", before: "30", after: "10" },
    ]);
    expect(BigInt(filteredRows[0].id) > BigInt(filteredRows[1].id)).toBe(true);
    // Bind the rendered restore target to the exact verified response entry.
    // A history response alone does not prove that React has rendered it yet.
    const selected = page.getByRole("article", { name: "مدى متابعة المواعيد", exact: true }).filter({
      has: page.locator(`time[datetime="${filteredRows[0].at}"]`),
    });
    await selected.waitFor({ state: "visible" });
    expect(await selected.count()).toBe(1);
    expect(await page.getByRole("article").count()).toBe(2);
    expect(await selected.getByText("ops.follow_up_lookback_days", { exact: true }).count()).toBe(1);
    expect(await selected.getByText("قبل", { exact: true }).locator("..").textContent()).toBe("قبل10 يوم");
    expect(await selected.getByText("بعد", { exact: true }).locator("..").textContent()).toBe("بعد60 يوم");
    await reachableControl(selected.getByRole("button", { name: "استعادة القيمة السابقة" }), output, "settings-history-selected-restore");
    await selected.getByRole("button", { name: "استعادة القيمة السابقة" }).click();
    const restore = page.getByRole("dialog", { name: "استعادة قيمة سابقة" });
    await restore.waitFor({ state: "visible" });
    expect(await restore.getByText("10 يوم", { exact: true }).count()).toBe(1);
    await restore.getByLabel(/سبب الاستعادة/).fill("إثبات الاستعادة من واجهة المالك");
    const restoreResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/settings"
      && response.request().method() === "PATCH");
    await restore.getByRole("button", { name: "تأكيد الاستعادة" }).click();
    const restored = await restoreResponse;
    expect(restored.request().postDataJSON()).toEqual({
      "ops.follow_up_lookback_days": "10",
      __versions: { "ops.follow_up_lookback_days": expect.any(String) },
      __reason: "إثبات الاستعادة من واجهة المالك",
    });
    expect(restored.status()).toBe(200);
    const restoredPayload = await restored.json();
    expect(restoredPayload["ops.follow_up_lookback_days"]).toBe("10");
    expect(restoredPayload.__changed).toEqual(["ops.follow_up_lookback_days"]);
    await restore.waitFor({ state: "hidden" });
    const persisted = await page.evaluate(async () => {
      const response = await fetch("/api/settings", { cache: "no-store" });
      if (!response.ok) throw new Error(`settings HTTP ${response.status}`);
      return response.json();
    });
    expect(persisted["ops.follow_up_lookback_days"]).toBe("10");
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

    /* (TD-05) العملة الأساسية دستورية: بطاقتها معروضة محكومةً بالنظام بلا زر
       تعديل — مثل وجهة Google Drive تمامًا — فمصدرها الكود لا الإعدادات. */
    await search.fill("العملة الأساسية");
    const currencyCard = settingCard("العملة الأساسية");
    expect(await currencyCard.textContent()).toContain("محكوم بالنظام");
    expect(await currencyCard.getByRole("button").count()).toBe(0);

    // والسبب الإلزامي يُختبر على إعدادٍ حساس آخر ما يزال قابلًا للتعديل (قفل الدفاتر).
    await search.fill("قفل الدفاتر قبل تاريخ");
    await settingCard("قفل الدفاتر قبل تاريخ").getByRole("button", { name: "تعديل", exact: true }).click();
    const finance = page.getByRole("dialog", { name: "قفل الدفاتر قبل تاريخ" });
    await finance.getByLabel("قفل الدفاتر قبل تاريخ").fill("2026-01-31");
    expect(await finance.getByRole("button", { name: "حفظ التغيير" }).isDisabled()).toBe(true);
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
