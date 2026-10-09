import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";

let h: Awaited<ReturnType<typeof harness>>, browser: Browser, db: Client;
let patientId = 0, visitId = 0;
const NAME = "مريض تسليم التوقيع الاصطناعي";
const register = (page: Page) => page.getByRole("region", { name: "الزيارات الموقّعة للاستقبال" });
const item = (page: Page, id: number) => register(page).locator(`[data-handoff-visit="${id}"]`);
async function contextFor(cookie: string, width = 1280): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  return context;
}
const SAFE_API = new Set(["/api/visits", "/api/visits/readiness", "/api/appointments", "/api/parties", "/api/booking-requests", "/api/display/notice", "/api/lab", "/api/messages", "/api/auth/me"]);
async function allowBuiltBoardRead(route: Route, unexpected: string[]) {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  if (url.origin === baseUrl && ["GET", "HEAD"].includes(method)
    && (SAFE_API.has(url.pathname) || url.pathname === "/" || url.pathname.startsWith("/_next/")
      || ["/logo.png", "/favicon.ico", "/icon.png", "/apple-icon.png", "/manifest.webmanifest", "/sw.js"].includes(url.pathname))) {
    await route.continue(); return;
  }
  unexpected.push(`${method} ${url.origin}${url.pathname}${url.search}`); await route.abort();
}
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(["127.0.0.1", "localhost"]).toContain(new URL(h.seeded.dbUrl).hostname);
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctor = (await db.query(`SELECT party_id FROM users WHERE username = 'secdoctora'`)).rows[0].party_id;
  patientId = (await db.query(`INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`RH-HTTP-${Date.now()}`, NAME, doctor])).rows[0].id;
  // The reception board's ordinary arrival-day/status poll cannot discover this signature.
  visitId = (await db.query(`INSERT INTO visits (patient_id, patient_name, doctor_id, status, arrived_at, finished_at, treatment_done)
    VALUES ($1, $2, $3, 'done', NOW() - INTERVAL '5 days', NOW() - INTERVAL '4 days', 'مراجعة موثقة بلا فاتورة جديدة') RETURNING id`,
    [patientId, NAME, doctor])).rows[0].id;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

describe("reception signature discovery on the built application", () => {
  it("discovers an old-arrival done→signed visit in an already-open independent reception browser", async () => {
    const reception = await contextFor(h.sessions.reception.cookie), doctor = await contextFor(h.sessions.doctorA.cookie);
    const unexpected: string[] = [], errors: string[] = [];
    let signPermit = false;
    const receptionGuard = await guardBrowserRoutes(reception, baseUrl, unexpected, route => allowBuiltBoardRead(route, unexpected));
    const doctorGuard = await guardBrowserRoutes(doctor, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === baseUrl && request.method() === "POST" && url.pathname === `/api/visits/${visitId}/clinical`
        && signPermit && JSON.stringify(request.postDataJSON()) === JSON.stringify({ action: "sign" })) {
        signPermit = false; await route.continue(); return;
      }
      await allowBuiltBoardRead(route, unexpected);
    });
    const receptionPage = await reception.newPage(), doctorPage = await doctor.newPage();
    for (const page of [receptionPage, doctorPage]) page.on("pageerror", error => errors.push(error.message));
    await receptionGuard.run(async () => {
      await doctorGuard.run(async () => {
        await receptionPage.clock.install();
        await receptionPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
        await expect.poll(() => register(receptionPage).innerText()).not.toContain("جارٍ تحميل");
        expect(await item(receptionPage, visitId).count()).toBe(0);
        await doctorPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
        expect(await register(doctorPage).count()).toBe(0);
        signPermit = true;
        const signed = await doctorPage.evaluate(async id => {
          const response = await fetch(`/api/visits/${id}/clinical`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sign" }) });
          return { status: response.status, body: await response.json() };
        }, visitId);
        expect(signed.status).toBe(200); expect(signed.body.invoiceId).toBeNull();
        // Advance the existing polling interval, with no manual refresh/focus and no sign toast in reception.
        await receptionPage.clock.fastForward(20_001);
        await expect.poll(() => item(receptionPage, visitId).count()).toBe(1);
        expect(await item(receptionPage, visitId).innerText()).toContain(NAME);
        expect(await item(receptionPage, visitId).innerText()).toContain("توقيع جديد");
        expect(await item(receptionPage, visitId).getByRole("link").getAttribute("href")).toBe(`/patients/${patientId}?tab=today&checkoutVisit=${visitId}`);
        await receptionPage.clock.fastForward(20_001);
        expect(await item(receptionPage, visitId).count()).toBe(1);
        signPermit = true;
        const retry = await doctorPage.evaluate(async id => (await fetch(`/api/visits/${id}/clinical`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sign" }),
        })).status, visitId);
        expect(retry).toBe(409);
        await receptionPage.reload({ waitUntil: "domcontentloaded" });
        await expect.poll(() => item(receptionPage, visitId).count()).toBe(1);
        expect(await item(receptionPage, visitId).innerText()).not.toContain("توقيع جديد");
        expect((await db.query(`SELECT status, invoice_id, signed_at FROM visits WHERE id = $1`, [visitId])).rows[0]).toMatchObject({ status: "done", invoice_id: null, signed_at: expect.any(Date) });
        expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
      }, () => {});
    }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); });
  }, 120_000);

  it("rejects non-front-desk sessions on the real projection and keeps ordinary visits stripped", async () => {
    for (const session of [h.sessions.doctorA, h.sessions.doctorB, h.sessions.accountant, h.sessions.cashier, h.sessions.portalA]) {
      expect([401, 403]).toContain((await authedGet("/api/visits?view=reception-handoff", session)).status);
    }
    const response = await authedGet("/api/visits", h.sessions.reception);
    expect(response.status).toBe(200);
    for (const row of await response.json()) { expect(row).not.toHaveProperty("signedAt"); expect(row).not.toHaveProperty("invoiceId"); }
    const anonymous = await fetch(`${baseUrl}/api/visits?view=reception-handoff`);
    expect(anonymous.status).toBe(401);
  });

  it.each([1280, 390])("at %ipx handles stale/error/permission loss and late A→B→A date reads without false empty state", async width => {
    const context = await contextFor(h.sessions.reception.cookie, width);
    const unexpected: string[] = [], errors: string[] = [];
    let mode: "ready" | "failed" | "malformed" | "denied" | "other-owner" = "ready";
    let activeId = 901, hold = false;
    const releases: Array<() => void> = [];
    const payload = (date: string | null) => {
      const toDate = date ?? "2026-10-10";
      const fromDate = new Date(Date.parse(`${toDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      return { owner: { username: mode === "other-owner" ? "different-reception" : "secreception", role: "reception" },
        fromDate, toDate, clinicTimeZone: "Asia/Aden", items: [{ visitId: activeId, patientId: 31,
          patientName: `مريض تسليم اصطناعي ${activeId}`, patientNumber: "SYN-31", signedAt: `${toDate}T09:00:00Z` }] };
    };
    const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === baseUrl && request.method() === "GET" && url.pathname === "/api/visits" && url.searchParams.get("view") === "reception-handoff") {
        const body = payload(url.searchParams.get("date")), thisMode = mode;
        if (hold) { hold = false; await new Promise<void>(resolve => releases.push(resolve)); }
        if (thisMode === "failed" || thisMode === "denied") { await route.fulfill({ status: thisMode === "denied" ? 403 : 503, json: { message: "تعذّر التحميل اصطناعياً" } }); return; }
        await route.fulfill({ json: thisMode === "malformed" ? { ...body, items: null } : body }); return;
      }
      await allowBuiltBoardRead(route, unexpected);
    });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    const refresh = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await guard.run(async () => {
      try {
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
        await expect.poll(() => item(page, 901).count()).toBe(1);
        for (const failure of ["failed", "malformed"] as const) {
          mode = failure; await refresh();
          await expect.poll(() => register(page).innerText()).toContain("آخر قائمة غير محدثة");
          expect(await item(page, 901).count()).toBe(1);
          expect(await item(page, 901).getByRole("link").count()).toBe(0);
          expect(await register(page).innerText()).not.toContain("لا توجد توقيعات");
          mode = "ready"; await register(page).getByRole("button", { name: "تحديث التوقيعات" }).click();
          await expect.poll(() => item(page, 901).getByRole("link").count()).toBe(1);
        }
        // Start A, navigate to B, then A again before releasing the old A response.
        hold = true; await refresh(); await expect.poll(() => releases.length).toBe(1);
        activeId = 902; await register(page).getByLabel("نهاية فترة التوقيع").fill("2026-10-09");
        await expect.poll(() => item(page, 902).count()).toBe(1);
        activeId = 903; await register(page).getByLabel("نهاية فترة التوقيع").fill("2026-10-10");
        await expect.poll(() => item(page, 903).count()).toBe(1);
        releases.shift()!();
        await refresh(); await expect.poll(() => item(page, 903).count()).toBe(1);
        expect(await item(page, 901).count()).toBe(0); expect(await item(page, 902).count()).toBe(0);
        const bounds = await item(page, 903).getByRole("link").evaluate(element => {
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height, right: rect.right, left: rect.left, viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
        });
        expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.viewport); expect(bounds.overflow).toBe(false);
        mode = "denied"; await refresh();
        await expect.poll(() => item(page, 903).count()).toBe(0);
        expect(await register(page).innerText()).toContain("صلاحية الوصول");
        mode = "ready"; await refresh(); await expect.poll(() => item(page, 903).count()).toBe(1);
        mode = "other-owner"; await refresh(); await expect.poll(() => item(page, 903).count()).toBe(0);
        expect(await register(page).innerText()).toContain("صلاحية الوصول");
      } finally { for (const release of releases.splice(0)) release(); }
    }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); });
  }, 120_000);
});
