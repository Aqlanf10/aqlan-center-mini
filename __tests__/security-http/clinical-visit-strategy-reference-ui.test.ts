import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { emptyStrategy, strategyHistory, STRATEGY_IDS, STRATEGY_TEXT } from "../fixtures/ortho-strategy";
import { assertStrategyControlBounds, settleStrategy, type Harness } from "./_ortho-strategy-ui-fixture";
import { baseUrl, harness } from "./_server";

// STATUS: UNRUN. Built ClinicalVisit + real session + exact synthetic case reads.
// All mutations, new windows, downloads and unconfigured API reads fail closed.
let browser: Browser, h: Harness;
const VISIT = 959781, DOCTOR = 959782, ADJUSTMENT = 959783;
const ids = STRATEGY_IDS.a, text = STRATEGY_TEXT.a;
const clinicalPath = `/api/visits/${VISIT}/clinical`, strategyPath = `/api/ortho/${ids.orthoCaseId}/strategy`;
const reference = (page: Page) => page.getByTestId("ortho-strategy-reference");
const notes = (page: Page) => page.locator("#visit-notes");
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
beforeAll(async () => {
  h = await harness(); expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });
async function fixture(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [], writes: string[] = [], reads: string[] = [], downloads: string[] = [];
  let response = { body: strategyHistory(h.seeded.patientAId) as unknown, status: 200 };
  const stored = {
    id: VISIT, patientId: h.seeded.patientAId, patientName: "مريض مرجع استراتيجية اصطناعي",
    chiefComplaint: "شكوى اليوم الأصلية", examination: "فحص اليوم الأصلي", diagnosis: "تشخيص اليوم الأصلي",
    treatmentDone: "توثيق اليوم الأصلي", nextPlan: "المتابعة الأصلية", doctorId: DOCTOR,
    status: "open", signedAt: null, signedBy: null, invoiceId: null, addendum: null, procedures: [], totalMinor: 0,
    planItemsMatched: 0, planTitle: null, planWarning: null, plannedVisit: null, previousVisit: null,
    latestDiagnosis: null, activeCases: [], outstanding: [], billingCurrency: "YER", sessionPricing: [], labOrders: [],
    ortho: { caseId: ids.orthoCaseId, appliance: "fixed_metal", phase: "working", slot: "022",
      upperWire: "014 NiTi", lowerWire: "012 NiTi", lastAdjustment: "2026-10-01", daysSinceLast: 9,
      lastDone: "جلسة تقويم سابقة اصطناعية", elastics: "none", elasticNote: null, suggestedUpper: null,
      suggestedLower: null, visitAdjustmentId: ADJUSTMENT, legacyBaseline: false, nextWeeks: 4, adjustmentBillingClass: "INCLUDED" },
  };
  const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}${path}`); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      writes.push(`${method} ${path}${url.search}`); unexpected.push(`read-only visit attempted ${method} ${path}`); await route.abort(); return;
    }
    if (path === strategyPath) {
      reads.push(`${path}${url.search}`);
      if (url.search === "") await json(route, response.body, response.status);
      else if (url.search === `?revisionId=${ids.revision1}`) await json(route, strategyHistory(h.seeded.patientAId, "a", 1));
      else { unexpected.push(`unconfigured strategy ${path}${url.search}`); await route.abort(); }
    } else if (path === clinicalPath) await json(route, stored);
    else if (path === `/api/visits/${VISIT}/materials`) await json(route, { lines: [], patientId: h.seeded.patientAId });
    else if (path === `/api/visits/${VISIT}/billing-preview`) await json(route, { message: "Synthetic preview unavailable" }, 503);
    else if (path === `/api/patients/${h.seeded.patientAId}/diagnoses`) {
      expect(url.search).toBe(`?orthoCaseId=${ids.orthoCaseId}`); await json(route, { diagnoses: [] });
    } else if (path === "/api/services") await json(route, []);
    else if (path === "/api/parties") { expect(url.search).toBe("?kind=doctor"); await json(route, [{ id: DOCTOR, name: "طبيب اصطناعي" }]); }
    else if (path === "/api/booking-requests") await json(route, []);
    else if (path === "/api/lab") await json(route, { late: 0 });
    else if (path === "/api/messages") await json(route, { unread: 0, urgent: 0 });
    else if (path === "/api/auth/me") await route.continue();
    else if (path.startsWith("/api/") || path.startsWith("/print/")) {
      unexpected.push(`${method} ${path}${url.search}`); await route.abort();
    } else await route.continue();
  });
  const page = await context.newPage();
  context.on("page", () => unexpected.push("unexpected new page"));
  page.on("pageerror", error => errors.push(error.message));
  page.on("download", download => downloads.push(download.suggestedFilename()));
  page.on("dialog", dialog => { unexpected.push(`unexpected ${dialog.type()} dialog`); void dialog.dismiss(); });
  const verify = () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(writes).toEqual([]); expect(downloads).toEqual([]); };
  return { page, reads, setResponse: (body: unknown, status = 200) => { response = { body, status }; },
    run: (body: () => Promise<void>) => routes.run(async () => {
      const result = await page.goto(`${baseUrl}/visits/${VISIT}`, { waitUntil: "domcontentloaded" });
      expect(result?.status()).toBe(200); await notes(page).getByRole("textbox", { name: "فحص اليوم (إن أُجري)", exact: true }).waitFor();
      // This fixture is an Ortho follow-up, not an ordinary consultation.
      // Verify all original notes before the reference can be opened.
      for (const [label, value] of [
        ["شكوى جديدة أو تغيّر اليوم (إن وجد)", stored.chiefComplaint],
        ["فحص اليوم (إن أُجري)", stored.examination],
        ["تشخيص جديد أو محدّث (إن وجد)", stored.diagnosis],
        ["توثيق عمل إضافي اليوم", stored.treatmentDone],
        ["الخطوة القادمة", stored.nextPlan],
      ]) expect(await notes(page).getByRole("textbox", { name: label, exact: true }).inputValue()).toBe(value);
      await body(); expect(context.pages()).toHaveLength(1); verify();
    }, verify),
  };
}
async function openReference(page: Page) {
  const section = page.getByTestId("ortho-visit-reference");
  await section.locator("summary").first().click(); await reference(page).waitFor();
  await expect.poll(() => reference(page).getByText("جارٍ التحقق من خطة الحالة…", { exact: true }).count()).toBe(0);
}
async function snapshot(page: Page) {
  return notes(page).locator("input,textarea,select").evaluateAll(elements => elements.map(node => ({
    label: node.getAttribute("aria-label"), value: (node as HTMLInputElement).value,
  })));
}

describe("Visit's exact case strategy reference", () => {
  it.each([390, 1280])("reads only after opening the existing reference and never changes today's notes or sends POST at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      const original = await snapshot(f.page); expect(f.reads).toEqual([]);
      await openReference(f.page); expect(f.reads).toEqual([strategyPath]);
      expect(await reference(f.page).innerText()).toContain(`${text.strategy} مراجعة صريحة`);
      expect(await reference(f.page).locator("textarea,input").count()).toBe(0);
      expect(await reference(f.page).getByRole("button").allTextContents()).toEqual(["تحديث سجل الخطة"]);
      expect(await f.page.getByTestId("ortho-strategy-editor").count()).toBe(0);
      const versions = reference(f.page).getByLabel("نسخة خطة الحالة", { exact: true });
      await versions.selectOption(String(ids.revision1));
      await expect.poll(() => f.reads.at(-1)).toBe(`${strategyPath}?revisionId=${ids.revision1}`);
      await expect.poll(() => reference(f.page).getByTestId("ortho-strategy-saved").innerText()).not.toContain("مراجعة صريحة");
      expect(await snapshot(f.page)).toEqual(original);
      await assertStrategyControlBounds(f.page, width, "visit-readonly", [versions,
        reference(f.page).getByRole("button", { name: "تحديث سجل الخطة", exact: true })]);
      await f.page.getByTestId("ortho-visit-reference").locator("summary").first().click();
      await expect.poll(() => reference(f.page).count()).toBe(0); expect(await snapshot(f.page)).toEqual(original);
      await openReference(f.page); expect(f.reads.at(-1)).toBe(strategyPath); expect(await snapshot(f.page)).toEqual(original);
    });
  });

  it.each([390, 1280])("fails closed on wrong-owner or denied strategy without replacing the saved clinical notes at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      const original = await snapshot(f.page); await openReference(f.page);
      const foreign = strategyHistory(h.seeded.patientBId); f.setResponse(foreign);
      await reference(f.page).getByRole("button", { name: "تحديث سجل الخطة", exact: true }).click();
      await expect.poll(() => reference(f.page).getByRole("alert").count()).toBe(1);
      expect(await reference(f.page).getByTestId("ortho-strategy-saved").count()).toBe(0);
      expect(await reference(f.page).innerText()).not.toContain(text.objective);
      expect(await snapshot(f.page)).toEqual(original);
      f.setResponse({ message: "مرجع غير مصرّح" }, 403);
      await reference(f.page).getByRole("button", { name: "تحديث سجل الخطة", exact: true }).click();
      await expect.poll(() => reference(f.page).innerText()).toContain("غير مصرّح"); expect(await snapshot(f.page)).toEqual(original);
      f.setResponse(emptyStrategy(h.seeded.patientAId));
      await reference(f.page).getByRole("button", { name: "تحديث سجل الخطة", exact: true }).click();
      await expect.poll(() => reference(f.page).innerText()).toContain("لا توجد نسخة موثّقة");
      expect(await reference(f.page).getByRole("button").allTextContents()).toEqual(["تحديث سجل الخطة"]);
      await settleStrategy(f.page); expect(await snapshot(f.page)).toEqual(original);
    });
  });
});
