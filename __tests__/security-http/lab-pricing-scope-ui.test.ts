import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Route } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { addDays } from "@/lib/schedule";
import { baseUrl, harness } from "./_server";

// Real built /lab page and session; only this page's catalog/quote/order endpoints
// are fixture-backed. No lab order or financial transaction is written to the DB.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

const services = [
  // Deliberately misleading name: scope must come from stored metadata, not text.
  { id: 9101, name: "طقم كامل", code: "DNT_FULL", toothScope: "single_tooth" },
  { id: 9102, name: "جسر الاختبار", toothScope: "multi_teeth_bridge" },
  { id: 9103, name: "فك الاختبار", toothScope: "full_arch" },
  { id: 9104, name: "عمل عام", toothScope: "general" },
  { id: 9105, name: "بلا سعر", toothScope: "full_arch" },
  { id: 9106, name: "خطأ جلب السعر", toothScope: "general" },
  { id: 9107, name: "سعر غير معروف", toothScope: "general" },
  { id: 9108, name: "نطاق غير معروف", toothScope: null },
  { id: 9109, name: "سعر صفري صريح", toothScope: "general" },
].map((service) => ({ category: "prostho", isActive: true, ...service }));

function quote(params: URLSearchParams) {
  const id = Number(params.get("labServiceId"));
  const amount = id === 9109 ? 0 : id === 9103 ? 8000 : id === 9104 ? 1500 : 2000;
  return { resolved: { costMinor: amount, costCurrency: "USD", ruleId: id } };
}

async function fixture() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const orders: Record<string, unknown>[] = [];
  const pending: Route[] = [];
  let holdQuotes = false;
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/lab/services", (route) => json(route, { services }));
  await page.route("**/api/laboratories", (route) => json(route, { laboratories: [
    { id: 9100, name: "مختبر الاختبار", currency: "USD", isActive: true, deliveryDays: 7 },
    { id: 9200, name: "مختبر ثان", currency: "YER", isActive: true, deliveryDays: 7 },
  ] }));
  await page.route("**/api/patients?q=*", (route) => json(route, [{ id: h.seeded.patientAId, fullName: "مريض تسعير تجريبي", patientNumber: "LAB-UI" }]));
  await page.route("**/api/lab", async (route) => {
    if (route.request().method() === "POST") {
      orders.push(route.request().postDataJSON());
      await json(route, {}, 201);
    } else await json(route, { orders: [], labs: [] });
  });
  await page.route("**/api/lab/pricing?*", async (route) => {
    if (holdQuotes) { pending.push(route); return; }
    const params = new URL(route.request().url()).searchParams;
    const id = params.get("labServiceId");
    if (id === "9105") await json(route, { resolved: null });
    else if (id === "9106") await json(route, { message: "fixture failure" }, 500);
    else if (id === "9107") await json(route, { resolved: { costMinor: null, costCurrency: "XXX", ruleId: 7 } });
    else await json(route, quote(params));
  });
  await page.goto(`${baseUrl}/lab`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "+ إرسال عمل جديد للمختبر" }).click();
  await page.getByLabel("بحث عن المريض").fill("تجريبي");
  await page.getByRole("button", { name: /مريض تسعير تجريبي/ }).click();
  const lab = page.locator('select:has(option[value="9100"])');
  const service = page.locator('select:has(option[value="9101"])');
  const cost = page.getByPlaceholder("إجمالي تكلفة المختبر", { exact: true });
  const teeth = page.getByPlaceholder("مثال: 14(Abutment), 15(Pontic), 16(Abutment)");
  const currency = page.locator('form select:has(option[value="USD"])').last();
  const scope = page.locator("[data-lab-pricing-scope]");
  const equation = page.locator("[data-lab-pricing-equation]");
  const status = page.locator("[data-lab-pricing-status]");
  const save = page.getByRole("button", { name: "حفظ وإرسال الطلب", exact: true });
  await lab.selectOption("9100");
  return { context, page, lab, service, cost, teeth, currency, scope, equation, status, save, orders, pending,
    hold: () => { holdQuotes = true; },
    release: (index: number, body?: unknown, statusCode = 200) => json(pending[index], body ?? quote(new URL(pending[index].request().url()).searchParams), statusCode),
  };
}

describe("lab quote scope and financial provenance", () => {
  it("shows stored scope and price × actual quantity, including single units and unknown scope", async () => {
    const f = await fixture();
    try {
      await f.teeth.fill("14(Abutment), 15(Pontic), 16(Abutment)");
      for (const [id, scope, basis, amount, equation] of [
        ["9101", "سن مفرد", "التسعير لكل سن محدد", "60", "20.00 × 3 = 60.00"],
        ["9102", "جسر متعدد", "التسعير لكل سن محدد", "60", "20.00 × 3 = 60.00"],
        ["9103", "فك كامل", "سعر العمل كاملاً كوحدة واحدة", "80", "80.00 × 1 = 80.00"],
        ["9104", "عام", "سعر العمل كاملاً كوحدة واحدة", "15", "15.00 × 1 = 15.00"],
        ["9108", "غير محدد", "الكمية المحتسبة: 1 وحدة", "20", "20.00 × 1 = 20.00"],
        ["9109", "عام", "الكمية المحتسبة: 1 وحدة", "0", "0.00 × 1 = 0.00"],
        ["9101", "سن مفرد", "التسعير لكل سن محدد", "60", "20.00 × 3 = 60.00"],
      ]) {
        await f.service.selectOption(id);
        await expect.poll(() => f.cost.inputValue()).toBe(amount);
        expect(await f.scope.textContent()).toContain(scope);
        expect(await f.scope.textContent()).toContain(basis);
        expect(await f.equation.textContent()).toContain(equation);
        if (id === "9103") {
          const screenshotPath = process.env.LAB_PRICING_UI_SCREENSHOT ?? ".settings-ui-artifacts/lab-pricing-scope.png";
          await mkdir(dirname(screenshotPath), { recursive: true });
          await f.scope.locator("..").screenshot({ path: screenshotPath });
          await f.page.setViewportSize({ width: 390, height: 844 });
          await f.scope.locator("..").screenshot({ path: screenshotPath.replace(/\.png$/, "-mobile.png") });
          await f.page.setViewportSize({ width: 1280, height: 1000 });
        }
      }
      for (const teeth of ["14", ""]) {
        await f.teeth.fill(teeth);
        await expect.poll(() => f.cost.inputValue()).toBe("20");
        expect(await f.equation.textContent()).toContain("20.00 × 1 = 20.00");
      }
      // Cancel/reopen keeps the same form consistently; clearing the selector
      // clears both the quote and the auto amount rather than retaining a price.
      await f.page.getByRole("button", { name: "إلغاء", exact: true }).click();
      await f.page.getByRole("button", { name: "+ إرسال عمل جديد للمختبر" }).click();
      expect(await f.cost.inputValue()).toBe("20");
      await f.service.selectOption("");
      await expect.poll(() => f.cost.inputValue()).toBe("");
      expect(await f.equation.count()).toBe(0);
      expect(await f.scope.count()).toBe(0);
      expect(f.orders).toEqual([]);
    } finally { await f.context.close(); }
  });

  it.each(["9105", "9106", "9107"])("never submits a previous automatic price after unavailable quote %s", async (service) => {
    const f = await fixture();
    try {
      await f.teeth.fill("14,15,16");
      await f.service.selectOption("9101");
      await expect.poll(() => f.cost.inputValue()).toBe("60");
      await f.service.selectOption(service);
      await expect.poll(() => f.status.textContent()).toContain(service === "9105" ? "لا توجد قاعدة" : "تعذّر جلب");
      expect(await f.cost.inputValue()).toBe("");
      expect(await f.equation.count()).toBe(0);
      await f.save.click();
      await expect.poll(() => f.orders.length).toBe(1);
      expect(f.orders[0]).not.toHaveProperty("cost");
      expect(f.orders[0]).not.toHaveProperty("costCurrency");
      expect(f.orders[0].labServiceId).toBe(Number(service));
      // Successful submit resets the form and cannot resurrect a quote.
      await f.page.getByRole("button", { name: "+ إرسال عمل جديد للمختبر" }).click();
      expect(await f.cost.inputValue()).toBe("");
      expect(await f.scope.count()).toBe(0);
      expect(await f.equation.count()).toBe(0);
    } finally { await f.context.close(); }
  });

  it("invalidates cached A during A→B→A, ignores out-of-order replies, and blocks pending auto submission", async () => {
    const f = await fixture();
    try {
      await f.service.selectOption("9101");
      await expect.poll(() => f.cost.inputValue()).toBe("20");
      f.hold();
      await f.service.selectOption("9103");
      await expect.poll(() => f.pending.length).toBe(1);
      expect(await f.cost.inputValue()).toBe("");
      expect(await f.save.isDisabled()).toBe(true);
      // Also test the submit handler, independently of the button guard.
      await f.page.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
      expect(f.orders).toEqual([]);
      await f.service.selectOption("9101");
      await expect.poll(() => f.pending.length).toBe(2);
      expect(await f.cost.inputValue()).toBe("");
      expect(await f.equation.count()).toBe(0);
      await f.release(1, { resolved: { costMinor: 2500, costCurrency: "USD", ruleId: 900 } });
      await expect.poll(() => f.cost.inputValue()).toBe("25");
      await f.release(0);
      await f.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await f.cost.inputValue()).toBe("25");
      await f.teeth.fill("14,15,16");
      await expect.poll(() => f.cost.inputValue()).toBe("75");
      expect(await f.equation.textContent()).toContain("25.00 × 3 = 75.00");
      await f.save.click();
      await expect.poll(() => f.orders.length).toBe(1);
      expect(f.orders[0]).toMatchObject({ labServiceId: 9101, cost: "75", costCurrency: "USD" });
    } finally { await f.context.close(); }
  });

  it("ignores an old response whose JSON finishes after a newer selection", async () => {
    const f = await fixture();
    try {
      await f.page.evaluate(() => {
        const state = window as typeof window & { releaseOldPrice?: () => void; oldPriceJsonWaiting?: boolean };
        const original = window.fetch;
        window.fetch = async (...args) => {
          const response = await original(...args);
          if (String(args[0]).includes("labServiceId=9101&")) {
            const originalJson = response.json.bind(response);
            response.json = async () => {
              const body = await originalJson();
              state.oldPriceJsonWaiting = true;
              await new Promise<void>((resolve) => { state.releaseOldPrice = resolve; });
              return body;
            };
          }
          return response;
        };
      });
      await f.service.selectOption("9101");
      await expect.poll(() => f.page.evaluate(() => (window as typeof window & { oldPriceJsonWaiting?: boolean }).oldPriceJsonWaiting)).toBe(true);
      await f.service.selectOption("9103");
      await expect.poll(() => f.cost.inputValue()).toBe("80");
      await f.page.evaluate(() => (window as typeof window & { releaseOldPrice?: () => void }).releaseOldPrice?.());
      await f.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await f.teeth.fill("14,15,16");
      expect(await f.cost.inputValue()).toBe("80");
      expect(await f.equation.textContent()).toContain("80.00 × 1 = 80.00");
      expect(await f.scope.textContent()).toContain("فك كامل");
    } finally { await f.context.close(); }
  });

  it("preserves fresh manual amount/currency during pending quotes, then resets with a later valid selection", async () => {
    const f = await fixture();
    try {
      await f.service.selectOption("9101");
      await expect.poll(() => f.cost.inputValue()).toBe("20");
      f.hold();
      await f.service.selectOption("9103");
      await expect.poll(() => f.pending.length).toBe(1);
      await f.cost.fill("37");
      await f.currency.selectOption("SAR");
      expect(await f.save.isDisabled()).toBe(false);
      await f.release(0);
      await expect.poll(() => f.equation.textContent()).toContain("80.00 × 1 = 80.00");
      expect(await f.cost.inputValue()).toBe("37");
      expect(await f.currency.inputValue()).toBe("SAR");
      expect(await f.equation.textContent()).toContain("القيمة المعدّلة يدوياً");
      await f.teeth.fill("14,15,16");
      expect(await f.cost.inputValue()).toBe("37");
      await f.service.selectOption("9102");
      await expect.poll(() => f.pending.length).toBe(2);
      await f.release(1);
      await expect.poll(() => f.cost.inputValue()).toBe("60");
      expect(await f.currency.inputValue()).toBe("USD");
      expect(await f.page.locator("[data-lab-manual-cost]").count()).toBe(0);
    } finally { await f.context.close(); }
  });

  it("keeps the displayed amount when currency alone becomes a manual override", async () => {
    const f = await fixture();
    try {
      await f.teeth.fill("14,15,16");
      await f.service.selectOption("9101");
      await expect.poll(() => f.cost.inputValue()).toBe("60");
      await f.currency.selectOption("SAR");
      expect(await f.cost.inputValue()).toBe("60");
      await f.teeth.fill("14");
      expect(await f.cost.inputValue()).toBe("60");
      expect(await f.equation.textContent()).toContain("القيمة المعدّلة يدوياً");
      await f.save.click();
      await expect.poll(() => f.orders.length).toBe(1);
      expect(f.orders[0]).toMatchObject({ cost: "60", costCurrency: "SAR" });
    } finally { await f.context.close(); }
  });

  it("labels a cleared amount as server fallback, never an accepted manual total", async () => {
    const f = await fixture();
    try {
      await f.service.selectOption("9101");
      await expect.poll(() => f.cost.inputValue()).toBe("20");
      await f.cost.fill("");
      expect(await f.equation.textContent()).toContain("الخانة فارغة؛ سيُطبّق الخادم قاعدة التسعير السارية عند الحفظ");
      expect(await f.equation.textContent()).not.toContain("التكلفة المعتمدة هي القيمة المعدّلة يدوياً");
      expect(await f.page.locator("[data-lab-manual-cost]").count()).toBe(0);
      await f.save.click();
      await expect.poll(() => f.orders.length).toBe(1);
      expect(f.orders[0]).not.toHaveProperty("cost");
      expect(f.orders[0]).not.toHaveProperty("costCurrency");
    } finally { await f.context.close(); }
  });

  it("keys quotes to laboratory and sent date, retaining explicit manual money when lookup fails", async () => {
    const f = await fixture();
    try {
      await f.service.selectOption("9101");
      await expect.poll(() => f.cost.inputValue()).toBe("20");
      f.hold();
      await f.lab.selectOption("9200");
      await expect.poll(() => f.pending.length).toBe(1);
      expect(await f.cost.inputValue()).toBe("");
      await f.release(0, { resolved: { costMinor: 7000, costCurrency: "YER", ruleId: 901 } });
      await expect.poll(() => f.cost.inputValue()).toBe("7000");
      const sentDateInput = f.page.locator('form input[type="date"]').first();
      const initialSentDate = await sentDateInput.inputValue();
      // Change the rendered clinic date; a fixed date eventually becomes today.
      const sentDate = addDays(initialSentDate, 1);
      expect(sentDate).not.toBe(initialSentDate);
      await sentDateInput.fill(sentDate);
      expect(await sentDateInput.inputValue()).toBe(sentDate);
      await expect.poll(() => f.pending.length).toBe(2);
      expect(new URL(f.pending[1].request().url()).searchParams.get("date")).toBe(sentDate);
      expect(await f.cost.inputValue()).toBe("");
      await f.cost.fill("41");
      await f.currency.selectOption("USD");
      await f.release(1, { message: "failure" }, 500);
      await expect.poll(() => f.status.textContent()).toContain("تعذّر جلب");
      expect(await f.cost.inputValue()).toBe("41");
      await f.lab.selectOption("9100");
      await expect.poll(() => f.pending.length).toBe(3);
      expect(await f.currency.inputValue()).toBe("USD");
      await f.release(2, { resolved: null });
      await expect.poll(() => f.status.textContent()).toContain("لا توجد قاعدة");
      await f.save.click();
      await expect.poll(() => f.orders.length).toBe(1);
      expect(f.orders[0]).toMatchObject({ partyId: 9100, sentDate, cost: "41", costCurrency: "USD" });
    } finally { await f.context.close(); }
  });
});
