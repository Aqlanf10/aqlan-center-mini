import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import type { ReportResult } from "../../lib/reports-types";
import { baseUrl, harness } from "./_server";

// Real built React page and authentication. Report/options/saved endpoints are
// intercepted synthetic fixtures: no report data, saved views or financial rows
// are read from or written to the test database by these interactions.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

type GenerationMetadata = { generatedAt?: string; clinicTimeZone?: unknown };
function payload(params: URLSearchParams, generation: GenerationMetadata = {}) {
  const report = params.get("report") ?? "daily";
  const from = params.get("from") ?? "2026-09-01";
  const to = params.get("to") ?? "2026-09-30";
  const result: ReportResult = {
    report, title: `تقرير تجريبي ${report}`, from, to, periodLabel: `${from} → ${to}`,
    baseCurrency: "YER", kpis: [], filtersLabel: "فلاتر تجريبية",
    columns: [
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "count", label: "العدد", type: "count" },
    ],
    rows: [{ patientId: 991, patientName: "مريض تجريبي", count: 1 }],
  };
  return { result, generatedAt: "2026-10-02T08:00:00Z", generatedBy: "synthetic", clinicTimeZone: "Asia/Aden", ...generation };
}

async function fixture(generation: GenerationMetadata = {}, browserTimeZone = "Asia/Aden") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE", timezoneId: browserTimeZone });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { (window as Window & { reportCopiedText?: string }).reportCopiedText = text; },
    } });
  });
  const savedRequests: { queryString: string }[] = [];
  const pending: Route[] = [];
  let hold = false;
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/reports/saved", async (route) => {
    if (route.request().method() === "POST") {
      savedRequests.push(route.request().postDataJSON());
      await json(route, {}, 201);
    } else await json(route, { saved: [], templates: [], canShare: false });
  });
  await page.route("**/api/reports?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("report") === "options") {
      await json(route, { doctors: [], specialties: [], services: [], methods: [], receivers: [], baseCurrency: "YER", clinicName: "Synthetic" });
    } else if (hold) pending.push(route);
    else await json(route, payload(params, generation));
  });
  await page.goto(`${baseUrl}/reports?section=operational&report=daily&preset=custom&from=2026-09-01&to=2026-09-30`);
  await page.getByRole("heading", { name: "تقرير تجريبي daily", exact: true }).waitFor();
  return { context, page, savedRequests, pending, errors,
    setHold: (next: boolean) => { hold = next; },
    fail: async () => {
      await expect.poll(() => pending.length).toBeGreaterThan(0);
      await json(pending.shift()!, { message: "تعذّر إعداد التقرير التجريبي" }, 500);
      await page.locator("main [role=alert]").waitFor();
    },
  };
}

async function printParams(page: Page) {
  const href = await page.getByRole("link", { name: "مستند رسمي / PDF", exact: true }).getAttribute("href");
  return new URL(href!, baseUrl).searchParams;
}
async function copiedParams(page: Page) {
  await page.getByRole("button", { name: "نسخ رابط التقرير", exact: true }).click();
  const text = await page.evaluate(() => (window as Window & { reportCopiedText?: string }).reportCopiedText);
  return new URL(text!).searchParams;
}

describe("report center applied filters in the built browser", () => {
  it.each([
    { clinicTimeZone: "America/New_York", expected: "الأربعاء 02/02/2000 · 5:00 مساءً" },
    { clinicTimeZone: "Asia/Aden", expected: "الخميس 03/02/2000 · 1:00 صباحًا" },
    { clinicTimeZone: undefined, expected: "الأربعاء 02/02/2000 · 10:00 مساءً (UTC)" },
    { clinicTimeZone: "invalid-zone", expected: "الأربعاء 02/02/2000 · 10:00 مساءً (UTC)" },
  ])("uses matching screen/page-print generation metadata for zone $clinicTimeZone despite browser timezone", async ({ clinicTimeZone, expected }) => {
    const f = await fixture({ generatedAt: "2000-02-02T22:00:00.000Z", clinicTimeZone }, "Pacific/Honolulu");
    try {
      const screen = f.page.locator("main p").filter({ hasText: "أُنشئ في" });
      expect(await screen.textContent()).toContain(`أُنشئ في ${expected} بواسطة synthetic`);
      expect(await screen.isVisible()).toBe(true);
      expect(await f.page.locator(".report-print-footer").textContent())
        .toContain(`أُنشئ في ${expected} بواسطة synthetic`);
      expect((await printParams(f.page)).get("from")).toBe("2026-09-01");
      expect((await printParams(f.page)).get("to")).toBe("2026-09-30");
      await f.page.emulateMedia({ media: "print" });
      expect(await f.page.locator(".report-print-footer").isVisible()).toBe(true);
      expect(await screen.isVisible()).toBe(false);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  }, 120_000);

  it("keeps print/copy/save on the displayed period through draft edits and a failed Apply, then advances on success", async () => {
    const f = await fixture();
    try {
      await f.page.getByLabel("من تاريخ", { exact: true }).fill("2026-10-01");
      await f.page.getByLabel("إلى تاريخ", { exact: true }).fill("2026-10-02");
      expect((await printParams(f.page)).get("from")).toBe("2026-09-01");
      expect((await copiedParams(f.page)).get("from")).toBe("2026-09-01");
      await f.page.getByRole("button", { name: "+ حفظ التقرير الحالي", exact: true }).click();
      await f.page.getByLabel("اسم التقرير المحفوظ").fill("اختبار الفترة المعروضة");
      await f.page.getByRole("button", { name: "حفظ", exact: true }).click();
      await expect.poll(() => f.savedRequests.length).toBe(1);
      expect(new URLSearchParams(f.savedRequests[0].queryString).get("from")).toBe("2026-09-01");

      f.setHold(true);
      await f.page.getByRole("button", { name: "تطبيق وإظهار التقرير", exact: true }).click();
      await expect.poll(() => f.pending.length).toBe(1);
      expect((await copiedParams(f.page)).get("from")).toBe("2026-09-01");
      await f.fail();
      await f.page.getByRole("heading", { name: "تقرير تجريبي daily", exact: true }).waitFor();
      expect((await printParams(f.page)).get("from")).toBe("2026-09-01");
      expect((await copiedParams(f.page)).get("from")).toBe("2026-09-01");

      f.setHold(false);
      await f.page.getByRole("button", { name: "تطبيق وإظهار التقرير", exact: true }).click();
      await expect.poll(async () => (await printParams(f.page)).get("from")).toBe("2026-10-01");
      expect((await copiedParams(f.page)).get("from")).toBe("2026-10-01");
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it("retains section, columns, filters and drill/back context when navigation requests fail", async () => {
    const f = await fixture();
    try {
      await f.page.getByRole("button", { name: /العرض والأعمدة/ }).click();
      // Hiding moves this column to a different list and changes its accessible
      // label; assert the committed replacement instead of uncheck() polling a
      // checkbox that is removed by the click.
      await f.page.getByLabel("إخفاء العدد", { exact: true }).click();
      await f.page.getByLabel("إظهار العدد", { exact: true }).waitFor();
      expect(await f.page.getByLabel("إظهار العدد", { exact: true }).isChecked()).toBe(false);
      await f.page.getByRole("button", { name: /العرض والأعمدة/ }).click();
      expect((await printParams(f.page)).get("columns")).toBe("patientName");
      f.setHold(true);
      await f.page.getByRole("navigation", { name: "أقسام التقارير" }).getByRole("button", { name: "تقارير مالية", exact: true }).click();
      await f.fail();
      await f.page.getByRole("heading", { name: "تقرير تجريبي daily", exact: true }).waitFor();
      expect(await f.page.getByRole("button", { name: "الحركات المالية اليومية", exact: true }).count()).toBe(1);
      expect((await printParams(f.page)).get("columns")).toBe("patientName");
      expect((await copiedParams(f.page)).get("report")).toBe("daily");

      await f.page.getByRole("button", { name: "مريض تجريبي", exact: true }).click();
      await f.fail();
      expect(await f.page.getByLabel("من تاريخ", { exact: true }).count()).toBe(1);
      expect(await f.page.getByRole("button", { name: "رجوع إلى التقرير", exact: true }).count()).toBe(0);
      expect((await printParams(f.page)).has("patientId")).toBe(false);

      f.setHold(false);
      await f.page.getByRole("button", { name: "مريض تجريبي", exact: true }).click();
      await f.page.getByRole("heading", { name: "تقرير تجريبي patient-statement", exact: true }).waitFor();
      expect((await copiedParams(f.page)).get("report")).toBe("patient-statement");
      expect((await copiedParams(f.page)).get("patientId")).toBe("991");
      await f.page.getByRole("button", { name: /العرض والأعمدة/ }).click();
      await f.page.getByLabel("إظهار العدد", { exact: true }).click();
      await f.page.getByLabel("إخفاء العدد", { exact: true }).waitFor();
      expect(await f.page.getByLabel("إخفاء العدد", { exact: true }).isChecked()).toBe(true);
      await f.page.getByRole("button", { name: /العرض والأعمدة/ }).click();
      f.setHold(true);
      await f.page.getByRole("button", { name: "رجوع إلى التقرير", exact: true }).click();
      await f.fail();
      expect(await f.page.getByRole("heading", { name: "تقرير تجريبي patient-statement", exact: true }).count()).toBe(1);
      expect(await f.page.getByRole("button", { name: "رجوع إلى التقرير", exact: true }).count()).toBe(1);
      expect(await f.page.getByLabel("من تاريخ", { exact: true }).count()).toBe(0);
      expect((await printParams(f.page)).get("patientId")).toBe("991");

      f.setHold(false);
      await f.page.getByRole("button", { name: "رجوع إلى التقرير", exact: true }).click();
      await f.page.getByRole("heading", { name: "تقرير تجريبي daily", exact: true }).waitFor();
      expect(await f.page.getByLabel("من تاريخ", { exact: true }).count()).toBe(1);
      expect((await printParams(f.page)).has("patientId")).toBe(false);
      expect((await copiedParams(f.page)).get("report")).toBe("daily");
      expect((await copiedParams(f.page)).has("patientId")).toBe(false);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it("reopens a copied statement URL on reload and keeps an allowed summary Back destination", async () => {
    const f = await fixture();
    try {
      await f.page.getByRole("button", { name: "مريض تجريبي", exact: true }).click();
      await f.page.getByRole("heading", { name: "تقرير تجريبي patient-statement", exact: true }).waitFor();
      const copied = await copiedParams(f.page);
      expect(copied.get("report")).toBe("patient-statement");
      expect(copied.get("patientId")).toBe("991");
      await f.page.goto(`${baseUrl}/reports?${copied.toString()}`);
      await f.page.getByRole("heading", { name: "تقرير تجريبي patient-statement", exact: true }).waitFor();
      expect((await printParams(f.page)).get("patientId")).toBe("991");
      await f.page.getByRole("button", { name: "رجوع إلى التقرير", exact: true }).click();
      await f.page.getByRole("heading", { name: "تقرير تجريبي visits", exact: true }).waitFor();
      expect((await copiedParams(f.page)).get("report")).toBe("visits");
      expect((await printParams(f.page)).has("patientId")).toBe(false);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });
});
