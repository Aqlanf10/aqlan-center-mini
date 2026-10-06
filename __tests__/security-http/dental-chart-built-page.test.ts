import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";

// Actual production-built Next patient page, SessionProvider and DentalChart.
// Only chart GET responses are synthetic/intercepted. Existing isolated harness
// sessions are used; this test sends no chart/clinical mutation and seeds no rows.
// Run only under the isolated security configuration, never against Production.
let browser: Browser, h: Awaited<ReturnType<typeof harness>>;
const DIR = ".settings-ui-artifacts", RETRY = "إعادة تحميل مخطط الأسنان";
const chart = (page: Page) => page.locator('[data-testid="dental-chart-workspace"]');
beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const db = new URL(h.seeded.dbUrl);
  expect(db.pathname).toBe("/aqlan_sec_http");
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(db.hostname);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(DIR, { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); });
async function retryGeometry(control: Locator) {
  await control.scrollIntoViewIfNeeded(); await control.focus();
  return control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const owner = element.closest('[data-testid="dental-chart-workspace"]')!.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(element);
    const text = Array.from(range.getClientRects()).map((box) => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom }));
    const points = [[rect.left + rect.width / 2, rect.top + 3], [rect.left + rect.width / 2, rect.bottom - 3],
      [rect.left + 3, rect.top + rect.height / 2], [rect.right - 3, rect.top + rect.height / 2],
      [rect.left + rect.width / 2, rect.top + rect.height / 2]];
    return { label: element.textContent?.trim(), width: rect.width, height: rect.height,
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      owner: { left: owner.left, right: owner.right, top: owner.top, bottom: owner.bottom }, text,
      viewportWidth: innerWidth, viewportHeight: innerHeight, focused: document.activeElement === element,
      hits: points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === element || element.contains(hit)); }),
    };
  });
}
async function capture(page: Page, width: number, state: "ready" | "error") {
  await page.evaluate(async () => { await document.fonts.ready; });
  await chart(page).scrollIntoViewIfNeeded();
  const retry = state === "error" ? await retryGeometry(chart(page).getByRole("button", { name: RETRY, exact: true })) : null;
  const evidence = { viewport: page.viewportSize(), route: "/patients/[synthetic-id]?tab=chart", state,
    renderer: "actual production-built Next patient page", chart: await chart(page).boundingBox(), retry,
    toothButtons: await chart(page).locator('button[aria-label]').count() };
  const path = `${DIR}/dental-chart-${state}-${width}`;
  // Save exact pixels/geometry even if a containment assertion below fails.
  await writeFile(`${path}-bounds.json`, JSON.stringify(evidence, null, 2) + "\n");
  await chart(page).screenshot({ path: `${path}.png` });
  if (retry) {
    expect(retry.label).toBe(RETRY); expect(retry.width).toBeGreaterThanOrEqual(44); expect(retry.height).toBeGreaterThanOrEqual(44);
    expect(retry.left).toBeGreaterThanOrEqual(0); expect(retry.right).toBeLessThanOrEqual(retry.viewportWidth);
    expect(retry.top).toBeGreaterThanOrEqual(0); expect(retry.bottom).toBeLessThanOrEqual(retry.viewportHeight);
    expect(retry.left).toBeGreaterThanOrEqual(retry.owner.left); expect(retry.right).toBeLessThanOrEqual(retry.owner.right);
    expect(retry.text.length).toBeGreaterThan(0);
    for (const box of retry.text) {
      expect(box.left).toBeGreaterThanOrEqual(retry.left - 1); expect(box.right).toBeLessThanOrEqual(retry.right + 1);
      expect(box.top).toBeGreaterThanOrEqual(retry.top - 1); expect(box.bottom).toBeLessThanOrEqual(retry.bottom + 1);
    }
    expect(retry.focused).toBe(true); expect(retry.hits).toEqual([true, true, true, true, true]);
  }
}

describe("Dental chart in the real built patient page", () => {
  it.each([390, 1280])("keeps the ready chart and readable fresh-load retry at %ipx", async (width) => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, locale: "ar-YE",
      timezoneId: "Asia/Aden", serviceWorkers: "block", acceptDownloads: false });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const endpoint = `/api/patients/${h.seeded.patientAId}/chart`;
    let failRead = false, chartReads = 0;
    const unexpected: string[] = [], errors: string[] = [];
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        unexpected.push(request.method() + " " + url.origin + url.pathname); await route.abort(); return;
      }
      if (request.method() === "GET" && url.pathname === endpoint && url.search === "") {
        chartReads++;
        await route.fulfill({ status: failRead ? 503 : 200, contentType: "application/json", body: JSON.stringify(failRead
          ? { message: "تعذّر تحميل مخطط الأسنان في الاختبار الاصطناعي." }
          : { records: [{ id: 990011, toothCode: 11, condition: "filling", stage: "existing", surfaces: "MO",
            note: "سجل اصطناعي لا يخص مريضاً حقيقياً", recordedBy: "synthetic-chart-acceptance", recordedAt: "2026-10-05T12:00:00Z", visitId: null }] }) });
        return;
      }
      await route.continue();
    });
    const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${baseUrl}/patients/${h.seeded.patientAId}?tab=chart`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => chart(page).getAttribute("data-read-state")).toBe("ready");
      expect(await chart(page).locator('button[aria-label]').count()).toBe(32);
      await capture(page, width, "ready");
      failRead = true; await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => chart(page).getAttribute("data-read-state")).toBe("error");
      expect(await chart(page).locator('button[aria-label]').count()).toBe(0);
      expect(await chart(page).getByLabel("ملاحظة", { exact: true }).count()).toBe(0);
      expect(await chart(page).textContent()).not.toContain("synthetic-chart-acceptance");
      await capture(page, width, "error");
      failRead = false; await chart(page).getByRole("button", { name: RETRY, exact: true }).click();
      await expect.poll(() => chart(page).getAttribute("data-read-state")).toBe("ready");
      expect(chartReads).toBe(3); expect(await chart(page).locator('button[aria-label]').count()).toBe(32);
      expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(context.pages()).toHaveLength(1);
    } finally { await context.close(); }
  }, 120_000);
});
