import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { baseUrl, harness } from "./_server";
import { assertStrategyCiBoundary, createStrategyFixture, type StrategyFixture } from "./_ortho-strategy-live-fixture";

/** Live, unmocked UI reader proof. Synthetic historical graph is supplied by the
 * existing CI-only fixture; writer acceptance is a separate suite. Screenshots
 * are review output, not an automatic substitute for a human visual review.
 */
let browser: Browser;
let fixture: StrategyFixture;
let newerId = 0;
beforeAll(async () => {
  assertStrategyCiBoundary();
  await mkdir("artifacts/unified-linkage", { recursive: true });
  await writeFile("artifacts/unified-linkage/started.txt", "synthetic-suite-started\n");
  const h = await harness();
  fixture = await createStrategyFixture(h, "unified RTL historical navigation", { status: "completed" });
  newerId = (await fixture.db.query<{ id: number }>(`INSERT INTO ortho_cases
    (patient_id,created_by,status) VALUES($1,$2,'active') RETURNING id`, [fixture.patientId, fixture.username])).rows[0].id;
  await fixture.db.query(`INSERT INTO clinical_cases(patient_id,specialty,title,site,ortho_case_id,created_by)
    VALUES($1,'orthodontics','Synthetic later case','upper and lower',$2,$3)`, [fixture.patientId, newerId, fixture.username]);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 120_000);
afterAll(async () => { await browser?.close(); await fixture?.close(); });

describe("Unified treatment identity survives RTL reload and explicit case selection", () => {
  it.each([390, 1280])("shows the requested closed case at %ipx, preserves diagnostics on reload and rejects invalid context", async width => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE" });
    const [name, ...value] = fixture.session.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const mutations: string[] = [];
    // Never fabricate endpoint results. Refuse unexpected UI writes on this read-only journey.
    await page.route("**/api/**", async route => {
      if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) {
        mutations.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
        await route.abort(); return;
      }
      await route.continue();
    });
    try {
      const before = await fixture.snapshot();
      const href = `${baseUrl}/patients/${fixture.patientId}?tab=treatment&sub=ortho&planItemId=${fixture.itemId}&pillar=diagnostics`;
      await page.goto(href, { waitUntil: "domcontentloaded" });
      const ready = page.locator('[data-testid="patient-ortho-workspace"][data-read-state="ready"]');
      await ready.waitFor();
      expect(await page.getByLabel("حالة التقويم المحددة", { exact: true }).inputValue()).toBe(String(fixture.orthoCaseId));
      expect(await page.getByTestId(`ortho-case-${fixture.orthoCaseId}`).count()).toBe(1);
      expect(await page.getByTestId(`ortho-case-${newerId}`).count()).toBe(0);
      await page.getByTestId(`ortho-case-${fixture.orthoCaseId}`).getByRole("heading", {
        name: "التحليل السيفالومتري ومخطط ويب سيف (WebCeph)", exact: true,
      }).waitFor();
      expect(await page.getByRole("button", { name: `دراسات الحالة #${fixture.orthoCaseId}`, exact: true }).count()).toBe(1);
      expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `artifacts/unified-linkage/closed-case-diagnostics-${width}.png`, fullPage: true });
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready.waitFor();
      expect(new URL(page.url()).searchParams.get("pillar")).toBe("diagnostics");
      expect(await page.getByLabel("حالة التقويم المحددة", { exact: true }).inputValue()).toBe(String(fixture.orthoCaseId));
      await page.getByTestId(`ortho-case-${fixture.orthoCaseId}`).getByRole("heading", {
        name: "التحليل السيفالومتري ومخطط ويب سيف (WebCeph)", exact: true,
      }).waitFor();
      // The explicit selector is the only action allowed to move to the later case.
      await page.getByLabel("حالة التقويم المحددة", { exact: true }).selectOption(String(newerId));
      await page.getByTestId(`ortho-case-${newerId}`).waitFor();
      expect(new URL(page.url()).searchParams.get("orthoCaseId")).toBe(String(newerId));
      expect(new URL(page.url()).searchParams.has("planItemId")).toBe(false);
      expect(await page.getByTestId(`ortho-case-${fixture.orthoCaseId}`).count()).toBe(0);
      await page.goto(`${href}&planItemId=${fixture.itemId}`, { waitUntil: "domcontentloaded" });
      await page.locator('[data-testid="clinical-context-state"][role="alert"]').waitFor();
      expect(await page.getByTestId("patient-ortho-workspace").count()).toBe(0);
      await page.screenshot({ path: `artifacts/unified-linkage/invalid-context-${width}.png`, fullPage: true });
      expect(mutations).toEqual([]);
      expect(await fixture.snapshot()).toEqual(before);
    } finally { await context.close(); }
  }, 120_000);
});
