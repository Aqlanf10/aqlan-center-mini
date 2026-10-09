import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { formatMoney } from "../../lib/money";

let browser: Browser, h: Awaited<ReturnType<typeof harness>>;
const patientId = 98801, firstId = 98802, secondId = 98803, openId = 98804, invoiceId = 98805;
const patient = { id: patientId, patientNumber: "SYN-EXACT-HANDOFF", fullName: "مريض تحصيل الزيارة المحددة اصطناعياً",
  phone: null, altPhone: null, gender: "unknown", birthYear: null, birthDate: null, address: null, medicalAlert: null,
  note: null, createdAt: "2026-10-09T08:00:00Z", photoDocumentId: null, flags: [], email: null, preferredChannel: null };
const money = (balanceMinor: number) => ({ balanceMinor, invoicedMinor: 0, paidMinor: 0, openingMinor: balanceMinor,
  agreedMinor: 999999, treatmentDoneMinor: 0, remainingTreatmentMinor: 999999, agreementPaidMinor: 0, agreementRemainingMinor: 999999 });
const workflow = () => ({ patient,
  openVisit: { id: openId, arrivedAt: "2026-10-09T11:00:00Z", status: "waiting", chair: null, plannedTitle: null },
  lastVisit: { id: secondId, date: "2026-10-09", treatmentDone: "زيارة أحدث", proceduresSummary: null, nextPlan: null },
  nextAppointment: null, activePlans: [], plannedVisits: [], counts: { visits: 3, openLabOrders: 0, documents: 0, orthoCase: false },
  financial: { ...money(180000), byCurrency: { YER: money(180000), SAR: money(5000), USD: money(2300) } },
  alerts: [], canSeeFinancial: true, assessmentCases: [], legacyCases: [] });
function walkout(id: number, collected = false, yer = 180000) {
  const sar = collected ? 0 : 5000;
  return { visitId: id, patientId, patientName: patient.fullName, patientNumber: patient.patientNumber,
    arrivedAt: "2026-09-01T08:00:00Z", signedAt: "2026-09-01T09:00:00Z", signedToday: false, deferred: false,
    lines: [], orthoAdjustment: { id: id + 20, billingClass: "LEGACY_INCLUDED", pendingDecision: false, decision: null },
    invoice: { id: invoiceId + (id - firstId), number: `SYN-${id}`, netMinor: 5000, currency: "SAR" },
    payments: [], nextAppointment: null,
    balances: [{ currency: "YER", balanceMinor: yer }, ...(sar ? [{ currency: "SAR", balanceMinor: sar }] : []), { currency: "USD", balanceMinor: 2300 }],
    checkout: { previous: { YER: 180000, SAR: collected ? -5000 : 0, USD: 2300 }, current: { YER: yer, SAR: sar, USD: 2300 },
      invoicePaidMinor: collected ? 5000 : 0, paymentsToday: [], openingPaidToday: [] }, summary: [] };
}
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const checkout = (page: Page) => page.getByRole("region", { name: "شبّاك ما بعد الزيارة" });
const urlFor = (id: number) => `${baseUrl}/patients/${patientId}?tab=today&checkoutVisit=${id}`;
beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1"); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

describe("exact reception checkout on the built patient workspace", () => {
  it.each([1280, 390])("at %ipx keeps the selected historical signed visit, native currencies and live post-payment truth", async width => {
    const context = await browser.newContext({ viewport: { width, height: 1100 }, locale: "ar-YE", serviceWorkers: "block" });
    const [name, ...value] = h.sessions.reception.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const unexpected: string[] = [], errors: string[] = [], reads: number[] = [], writes: { body: unknown; key: string | undefined }[] = [];
    let mode: "ready" | "missing" | "unsigned" | "foreign" | "denied" | "malformed" | "failed" = "ready";
    let collected = false, permitPayment = false, holdNext = false, nextYer = 180000;
    const held: Array<{ release: () => void; done: Promise<void> }> = [];
    const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
      if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}${path}`); await route.abort(); return; }
      if (method === "POST" && path === "/api/payments" && permitPayment) {
        permitPayment = false;
        const body: unknown = request.postDataJSON();
        expect(body).toMatchObject({ patientId, invoiceId: String(invoiceId), currency: "SAR", amount: "50", kind: "payment" });
        expect(body).not.toHaveProperty("planId");
        expect(body).not.toHaveProperty("openingCurrency");
        writes.push({ body, key: request.headers()["idempotency-key"] });
        collected = true; mode = "failed";
        await json(route, { id: 98891 }); return; // Fulfilled synthetic response; never a real payment write.
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) { unexpected.push(`${method} ${path}`); await route.abort(); return; }
      if (path === `/api/patients/${patientId}/workflow`) { await json(route, workflow()); return; }
      if (path === `/api/patients/${patientId}`) { await json(route, { patient, visits: [], appointments: [] }); return; }
      const visit = path.match(/^\/api\/visits\/(\d+)\/walkout$/);
      if (visit) {
        const id = Number(visit[1]); reads.push(id);
        if (![firstId, secondId].includes(id)) { unexpected.push(`${method} ${path}`); await route.abort(); return; }
        const body = walkout(id, collected, nextYer), thisMode = mode;
        if (thisMode === "foreign") body.patientId++;
        if (thisMode === "unsigned") (body as { signedAt: unknown }).signedAt = null;
        if (thisMode === "malformed") delete (body.checkout.current as Partial<typeof body.checkout.current>).USD;
        if (holdNext) {
          holdNext = false; let release!: () => void, done!: () => void;
          const released = new Promise<void>(resolve => { release = resolve; });
          const finished = new Promise<void>(resolve => { done = resolve; });
          held.push({ release, done: finished }); await released;
          try { await json(route, body); } finally { done(); } return;
        }
        const status = thisMode === "missing" ? 404 : thisMode === "denied" ? 403 : thisMode === "failed" ? 503 : 200;
        await json(route, status === 200 ? body : { message: "القراءة غير متاحة اصطناعياً" }, status); return;
      }
      if (path === "/api/visits/readiness") { await json(route, { visit: null }); return; }
      if (["/api/visits", "/api/booking-requests", "/api/services"].includes(path)) { await json(route, []); return; }
      if (path === "/api/lab") { await json(route, { late: 0 }); return; }
      if (path === "/api/messages") { await json(route, { unread: 0, urgent: 0 }); return; }
      if (path === "/api/auth/me") { await json(route, { username: "secreception", role: "reception" }); return; }
      if (path === "/print/payment/98891") { await route.fulfill({ contentType: "text/html", body: "<html lang='ar'><body>سند اصطناعي</body></html>" }); return; }
      if (path.startsWith("/api/") || path.startsWith("/print/")) { unexpected.push(`${method} ${path}`); await route.abort(); return; }
      if (path === `/patients/${patientId}` || path.startsWith("/_next/") || ["/logo.png", "/favicon.ico", "/icon.png", "/apple-icon.png", "/manifest.webmanifest", "/sw.js"].includes(path)) { await route.continue(); return; }
      unexpected.push(`${method} ${path}`); await route.abort();
    });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    const verified = async (id = firstId) => {
      await expect.poll(() => checkout(page).getAttribute("data-financial-state")).toBe("verified");
      expect(await checkout(page).getAttribute("data-visit-id")).toBe(String(id));
    };
    await guard.run(async () => {
      try {
        await page.goto(urlFor(firstId), { waitUntil: "domcontentloaded" }); await verified();
        expect(reads.every(id => id === firstId)).toBe(true);
        expect(await page.getByRole("region", { name: "الزيارة المحددة للتحصيل" }).innerText()).toContain(`#${openId}`);
        expect(await page.getByRole("region", { name: "زيارة اليوم", exact: true }).count()).toBe(0);
        expect(await checkout(page).getByRole("link", { name: "🖨️ ملخّص المغادرة" }).getAttribute("href")).toBe(`/print/walkout/${firstId}`);
        for (const [currency, amount] of [["YER", 180000], ["SAR", 5000], ["USD", 2300]] as const) {
          expect(await checkout(page).locator(`[data-testid="checkout-current-balance"][data-currency="${currency}"]`).innerText()).toContain(formatMoney(amount, currency));
        }
        expect(await checkout(page).innerText()).not.toContain(formatMoney(187300, "YER"));
        // Header action stays within selected checkout rather than collecting another workflow target.
        expect(await page.getByTestId("patient-primary-action").innerText()).toContain(`#${firstId}`);
        await page.getByTestId("patient-primary-action").click();
        expect(await page.getByRole("dialog", { name: "تحصيل دفعة", exact: true }).count()).toBe(0);
        await checkout(page).getByRole("button", { name: "تحصيل وطباعة السند", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "تحصيل دفعة", exact: true }); await dialog.waitFor();
        // The shared modal initializes its target/currency/amount in the opening
        // session effect. Visible DOM alone is not evidence that it is ready.
        await expect.poll(async () => ({
          invoiceId: await dialog.getByLabel("فاتورة الهدف", { exact: true }).inputValue(),
          currency: await dialog.getByLabel("العملة", { exact: true }).inputValue(),
          amount: await dialog.getByLabel("المبلغ", { exact: true }).inputValue(),
        })).toEqual({ invoiceId: String(invoiceId), currency: "SAR", amount: "50.00" });
        await dialog.getByLabel("المبلغ", { exact: true }).fill("50"); permitPayment = true;
        await dialog.getByRole("button", { name: "سجّل الدفعة واطبع السند", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await expect.poll(() => page.getByTestId("checkout-financial-read").innerText()).toContain("تعذّر التحقق");
        // Parent workflow refresh may retire the explicit money owner entirely.
        expect(await page.getByRole("button", { name: "تحصيل وطباعة السند", exact: true }).count()).toBe(0);
        expect(await page.locator("body").innerText()).not.toContain("تم التحصيل —");
        mode = "ready";
        await page.getByTestId("checkout-financial-read").getByRole("button").click(); await verified();
        expect(await checkout(page).locator('[data-testid="checkout-current-balance"][data-currency="SAR"]').innerText()).toBe(formatMoney(0, "SAR"));
        expect(writes).toHaveLength(1); expect(writes[0].key).toBeTruthy();

        for (const fault of ["missing", "unsigned", "foreign", "denied", "malformed"] as const) {
          mode = fault; reads.length = 0;
          await page.reload({ waitUntil: "domcontentloaded" });
          await expect.poll(() => page.getByTestId("checkout-financial-read").innerText()).toContain("تعذّر التحقق");
          expect(await checkout(page).count()).toBe(0);
          expect(reads.length).toBeGreaterThan(0); expect(reads.every(id => id === firstId)).toBe(true);
          expect(await page.locator("body").innerText()).not.toContain("لا مبلغ مطلوب لهذه الزيارة");
        }
        mode = "ready";
        for (const bad of ["", "0", "-1", "1.5", "9007199254740992", `${firstId}&checkoutVisit=${secondId}`]) {
          reads.length = 0;
          await page.goto(`${baseUrl}/patients/${patientId}?tab=today&checkoutVisit=${bad}`, { waitUntil: "domcontentloaded" });
          await page.getByRole("alert").filter({ hasText: "رابط تحصيل الزيارة غير صالح" }).waitFor();
          expect(await checkout(page).count()).toBe(0); expect(reads).toEqual([]);
        }

        // A is held across B and a new A navigation. A retired response cannot overwrite the new A.
        holdNext = true; nextYer = 180000;
        await page.goto(urlFor(firstId), { waitUntil: "domcontentloaded" }); await expect.poll(() => held.length).toBe(1);
        nextYer = 210000; await page.goto(urlFor(secondId), { waitUntil: "domcontentloaded" }); await verified(secondId);
        nextYer = 220000; await page.goto(urlFor(firstId), { waitUntil: "domcontentloaded" }); await verified();
        held[0].release(); await held[0].done;
        expect(await checkout(page).locator('[data-testid="checkout-current-balance"][data-currency="YER"]').innerText()).toContain(formatMoney(220000, "YER"));
        expect(await checkout(page).getAttribute("data-visit-id")).toBe(String(firstId));
        // A newer denied read retires an older allowed response for the same exact visit.
        holdNext = true;
        await page.getByRole("button", { name: "تحديث بيانات الزيارة المحددة", exact: true }).click();
        await expect.poll(() => held.length).toBe(2);
        mode = "denied";
        await page.getByRole("button", { name: "تحديث بيانات الزيارة المحددة", exact: true }).click();
        await expect.poll(() => checkout(page).getAttribute("data-financial-state")).toBe("error");
        held[1].release(); await held[1].done;
        expect(await checkout(page).getAttribute("data-financial-state")).toBe("error");
        expect(await checkout(page).locator('[data-testid="checkout-current-balance"]').count()).toBe(0);
        expect(await checkout(page).getByRole("button", { name: "تحصيل وطباعة السند", exact: true }).count()).toBe(0);
        expect(await page.getByRole("dialog", { name: "تحصيل دفعة", exact: true }).count()).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      } finally { for (const pending of held) pending.release(); }
    }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(permitPayment).toBe(false); });
  }, 120_000);
});
