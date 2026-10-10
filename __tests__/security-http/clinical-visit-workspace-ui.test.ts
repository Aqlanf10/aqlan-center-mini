import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { baseUrl, harness } from "./_server";

// Real built app + isolated HTTP harness. Synthetic intercepted browser API data;
// no browser clinical, inventory, payment, signature or other write reaches a server.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });
const patientId = 98301, visitId = 98302, doctorId = 98303;
const clinicalPath = `/api/visits/${visitId}/clinical`;
const services = [
  { id: 98304, name: "خدمة حشو اصطناعية", category: "filling", priceMinor: 100, priceConfigured: true },
  { id: 98305, name: "خدمة بفئة مخصصة اصطناعية", category: "قسم مخصص", priceMinor: 0, priceConfigured: false },
  { id: 98306, name: "خدمة عامة اصطناعية", category: null, priceMinor: 200, priceConfigured: true },
  { id: 98307, name: "خدمة معطلة اصطناعية", category: "consultation", isActive: false, priceMinor: 100, priceConfigured: true },
];
const outstanding = Array.from({ length: 14 }, (_, index) => ({
  planItemId: 98400 + index, serviceId: services[0].id, serviceName: `بند اصطناعي ${index + 1}`,
  planTitle: "خطة اصطناعية", caseId: 98501, caseSite: "الفك العلوي", toothCode: 16, surfaces: "MO",
  billingRule: "per_session", sessionCount: 2, doneSessions: 0, quantity: 1, unitPriceMinor: 2000,
  status: "in_progress", planCurrency: "SAR", clinicalConsentRecorded: false, financialReviewRequired: true,
  origin: "invoice", unmetRequirements: index === 0 ? ["انتظار تقييم البند المرجعي #98502"] : undefined,
}));
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status,
  contentType: "application/json", body: JSON.stringify(body) });
const field = (page: Page, label: string) => page.locator("#visit-notes").getByRole("textbox", { name: label, exact: true });

async function fixture(width: number, planned = true) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [], writes: Record<string, unknown>[] = [];
  let stored: Record<string, unknown> = {
    id: visitId, patientId, patientName: "مريض مساحة زيارة اصطناعي", chiefComplaint: "نص الشكوى الأصلي",
    examination: "", diagnosis: "", treatmentDone: "ملاحظة الطبيب الأصلية", nextPlan: "",
    doctorId, status: "open", signedAt: null, signedBy: null, invoiceId: null, addendum: null,
    procedures: [], totalMinor: 0, planItemsMatched: 0, planTitle: null, planWarning: null,
    ortho: null, plannedVisit: null, previousVisit: null, latestDiagnosis: null, activeCases: [],
    outstanding: planned ? outstanding : [], billingCurrency: "YER", sessionPricing: [], labOrders: [],
  };
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}${path}`); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const body = path === clinicalPath && method === "POST" ? request.postDataJSON() as Record<string, unknown> : null;
      if (body && !("action" in body)) {
        writes.push(body); stored = { ...stored, ...body };
        await json(route, { ok: true }); return;
      }
      unexpected.push(`${method} ${path}`); await json(route, { message: "Synthetic write blocked" }, 409); return;
    }
    if (path === clinicalPath) await json(route, stored);
    else if (path === `/api/visits/${visitId}/billing-preview`) await json(route, { message: "Synthetic preview unavailable" }, 503);
    else if (path === `/api/visits/${visitId}/materials`) await json(route, { lines: [], patientId });
    else if (path === "/api/services") await json(route, services);
    else if (path === "/api/parties") await json(route, [{ id: doctorId, name: "طبيب اصطناعي" }]);
    else if (path === "/api/booking-requests") await json(route, []);
    else if (path === "/api/lab") await json(route, { late: 0 });
    else if (path === "/api/messages") await json(route, { unread: 0, urgent: 0 });
    else if (path === "/api/auth/me") await json(route, { username: "secadmin", role: "admin" });
    else if (path.startsWith("/api/") || path.startsWith("/print/")) {
      unexpected.push(`${method} ${path}`); await json(route, { message: "Synthetic read blocked" }, 404);
    } else await route.continue();
  });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/visits/${visitId}`);
    await field(page, "② الفحص").waitFor();
    return { page, context, writes, verify: () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); } };
  } catch (error) { await context.close(); throw error; }
}

describe("actual visit workspace choices and review", () => {
  it.each([390, 1280])("searches and scrolls phrases without losing narrative at %ipx", async (width) => {
    const f = await fixture(width);
    try {
      const { page } = f;
      expect(await field(page, "② الفحص").inputValue()).toBe("");
      expect(await field(page, "② التشخيص").inputValue()).toBe("");
      const group = page.locator('[aria-label="عبارات سريعة — ① الشكوى الرئيسية"]');
      const trigger = group.getByRole("button", { name: "اختر عبارة محفوظة", exact: true });
      await trigger.click();
      const search = group.getByRole("combobox"), options = group.getByRole("option");
      await expect.poll(() => options.count()).toBeGreaterThan(1);
      const phrase = (await options.first().textContent())!.trim();
      const list = group.getByRole("listbox");
      expect(await list.evaluate((node) => getComputedStyle(node).overflowY)).toBe("auto");
      await search.press("ArrowDown");
      expect(await search.getAttribute("aria-activedescendant")).toBeTruthy();
      expect(await field(page, "① الشكوى الرئيسية").inputValue()).toBe("نص الشكوى الأصلي");
      await search.press("Escape");
      expect(await trigger.evaluate((node) => document.activeElement === node)).toBe(true);
      expect(await field(page, "① الشكوى الرئيسية").inputValue()).toBe("نص الشكوى الأصلي");
      await trigger.click(); await search.fill(phrase); await search.press("Enter");
      // Searching, including Enter without an active option, never picks the first result.
      expect(await field(page, "① الشكوى الرئيسية").inputValue()).toBe("نص الشكوى الأصلي");
      await search.press("ArrowDown");
      const activeId = await search.getAttribute("aria-activedescendant");
      expect(await group.getByRole("option", { selected: true }).getAttribute("id")).toBe(activeId);
      await search.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
      expect(await field(page, "① الشكوى الرئيسية").inputValue()).toBe("نص الشكوى الأصلي");
      await search.press("Enter");
      expect(await field(page, "① الشكوى الرئيسية").inputValue()).toBe(`نص الشكوى الأصلي، ${phrase}`);
      await trigger.click(); await search.fill("ZZZ-no-saved-phrase");
      expect(await options.count()).toBe(0);
      expect(await search.getAttribute("aria-activedescendant")).toBeNull();
      expect(await group.getByText("لا توجد عبارة تطابق البحث.").count()).toBe(1);
      await group.getByRole("button", { name: "كتابة نص آخر", exact: true }).click();
      const narrative = field(page, "① الشكوى الرئيسية");
      expect(await narrative.evaluate((node) => document.activeElement === node)).toBe(true);
      await narrative.fill("نص حر أصلي");
      await trigger.click(); await search.press("Tab");
      await group.getByRole("button", { name: "إغلاق العبارات" }).click();
      expect(await narrative.inputValue()).toBe("نص حر أصلي");
      await narrative.fill("س".repeat(499)); await trigger.click(); await search.press("ArrowDown"); await search.press("Enter");
      expect(await narrative.inputValue()).toBe("س".repeat(499));
      expect(await group.getByText(/لا تتسع هذه العبارة/).count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(await field(page, "② الفحص").inputValue()).toBe("");
      expect(await field(page, "② التشخيص").inputValue()).toBe("");
      expect(f.writes).toHaveLength(0); f.verify();
    } finally { await f.context.close(); }
  });

  it("retains every active catalog category and unpriced choices through one keyboard-accessible action", async () => {
    const f = await fixture(390);
    try {
      const { page } = f;
      const add = page.getByRole("button", { name: "أضف إجراءً", exact: true });
      expect(await add.count()).toBe(1); expect(await page.getByRole("combobox", { name: "أضف إجراءً", exact: true }).count()).toBe(0);
      await add.click();
      const picker = page.getByRole("dialog", { name: "أضف إجراءً للزيارة", exact: true });
      for (const service of services.filter((row) => row.isActive !== false)) expect(await picker.getByText(service.name, { exact: true }).count()).toBe(1);
      expect(await picker.getByText(services[3].name, { exact: true }).count()).toBe(0);
      const close = picker.getByRole("button", { name: "إغلاق", exact: true });
      const finalLink = picker.getByRole("link", { name: /إدارة الأسعار/ });
      await page.setViewportSize({ width: 390, height: 400 });
      const footerBox = (await finalLink.boundingBox())!;
      expect(footerBox.y).toBeGreaterThanOrEqual(0); expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(400);
      await finalLink.focus(); await page.keyboard.press("Tab");
      expect(await close.evaluate((node) => document.activeElement === node)).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(await finalLink.evaluate((node) => document.activeElement === node)).toBe(true);
      expect(await picker.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      const search = picker.getByRole("textbox", { name: "بحث في الخدمات" });
      await search.fill(services[1].name);
      const custom = picker.getByRole("button").filter({ hasText: services[1].name });
      await custom.focus(); await custom.press("Enter");
      await expect.poll(() => picker.count()).toBe(0);
      expect(await page.getByTestId("visit-work-recorded").count()).toBe(1);
      expect(await page.getByRole("textbox", { name: "السعر", exact: true }).inputValue()).toBe("0");
      expect(await field(page, "③ ما نُفّذ").inputValue()).toBe("ملاحظة الطبيب الأصلية");
      await add.click(); await picker.getByRole("textbox", { name: "بحث في الخدمات" }).press("Escape");
      expect(await add.evaluate((node) => document.activeElement === node)).toBe(true);
      expect(f.writes).toHaveLength(0); f.verify();
    } finally { await f.context.close(); }
  });

  it("keeps a staged plan item, its tooth, currency and unmet requirements together without marking clearance", async () => {
    const f = await fixture(1280);
    try {
      const { page } = f;
      await page.getByTestId("planned-item-98400").getByRole("button", { name: "+ نفّذ اليوم", exact: true }).click();
      expect(await page.getByTestId("planned-item-98400").count()).toBe(0);
      const staged = page.getByTestId("visit-work-recorded");
      expect(await staged.count()).toBe(1);
      expect(await staged.textContent()).toContain("الحالة #98501");
      expect(await staged.textContent()).toContain("انتظار تقييم البند المرجعي #98502");
      expect(await staged.textContent()).toContain("قيد التنفيذ");
      expect(await staged.textContent()).not.toContain("جميع الشروط متحققة");
      expect(await staged.getByRole("textbox", { name: "السعر", exact: true }).isDisabled()).toBe(true);
      expect(await staged.getByRole("textbox", { name: "السعر", exact: true }).inputValue()).toBe("20.00");
      expect(await staged.getByRole("textbox", { name: "الأسطح", exact: true }).inputValue()).toBe("MO");
      expect(await staged.getByRole("button", { name: "رقم السن", exact: true }).textContent()).toContain("16");
      expect(await page.getByRole("radio", { name: "ريال سعودي", exact: true }).getAttribute("aria-checked")).toBe("true");
      await staged.getByRole("button", { name: "احذف", exact: true }).click();
      expect(await page.getByTestId("planned-item-98400").count()).toBe(1);
      expect(await field(page, "③ ما نُفّذ").inputValue()).toBe("ملاحظة الطبيب الأصلية");
      expect(f.writes).toHaveLength(0); f.verify();
    } finally { await f.context.close(); }
  });

  it.each([390, 1280])("keeps no-procedure review truthful and scrollable with focus retained at %ipx", async (width) => {
    const f = await fixture(width);
    try {
      const { page } = f;
      await page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }).click();
      const review = page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة", exact: true });
      await review.waitFor(); expect(f.writes).toHaveLength(1);
      expect(await review.textContent()).toContain("لا إجراءات مسجلة");
      expect(await review.textContent()).toContain("الاستحقاق المالي غير متحقق");
      expect(await review.getByTestId("no-additional-due").count()).toBe(0);
      expect(await review.getByText("بند اصطناعي 14", { exact: false }).count()).toBe(1);
      const scroll = review.getByTestId("visit-review-scroll");
      expect(await scroll.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
      await scroll.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      const back = review.getByRole("button", { name: "رجوع — أكمل العمل", exact: true });
      const box = (await back.boundingBox())!; expect(box.y + box.height).toBeLessThanOrEqual(844);
      await review.locator("section").focus(); await page.keyboard.press("Tab");
      expect(await review.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      const first = review.locator("summary").first();
      const last = review.getByRole("button").last();
      await last.focus(); await page.keyboard.press("Tab");
      expect(await first.evaluate((node) => document.activeElement === node)).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(await last.evaluate((node) => document.activeElement === node)).toBe(true);
      await page.keyboard.press("Escape"); await expect.poll(() => review.count()).toBe(0);
      expect(await field(page, "③ ما نُفّذ").inputValue()).toBe("ملاحظة الطبيب الأصلية");
      expect(f.writes).toHaveLength(1); f.verify();
    } finally { await f.context.close(); }
  });
});
