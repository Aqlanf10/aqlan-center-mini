import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Route } from "playwright";
import { baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { formatMoney } from "../../lib/money";
import { isTreatmentFinancialContext } from "../../lib/treatment-financial-context-validation";
import type { TreatmentFinancialContext } from "../../lib/treatment-financial-context";
import { MONEY_UNCERTAIN } from "../../lib/money-attempt";

/** Actual built patient page. Synthetic transport only; unknown routes and all unplanned writes remain blocked.
 * Persistence/signing is tested separately in postgres/legacy-ortho-billing.test.ts.
 */
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
const patientId = 98781, visitId = 98782;
const patient = { id: patientId, patientNumber: "SYNTHETIC-WALKOUT-98781", fullName: "مريض مغادرة اصطناعي",
  phone: null, altPhone: null, gender: "unknown", birthYear: null, birthDate: null, address: null,
  medicalAlert: null, note: null, createdAt: "2026-10-09T08:00:00Z", photoDocumentId: null, flags: [], email: null, preferredChannel: null };
const money = (balanceMinor: number) => ({ balanceMinor, invoicedMinor: 0, paidMinor: 0, openingMinor: balanceMinor,
  agreedMinor: 999999, treatmentDoneMinor: 0, remainingTreatmentMinor: 999999, agreementPaidMinor: 0, agreementRemainingMinor: 999999 });
const workflow = () => ({ patient, openVisit: null,
  lastVisit: { id: visitId, date: "2026-10-09", treatmentDone: "شدّة موثقة", proceduresSummary: null, nextPlan: null },
  nextAppointment: null, activePlans: [], plannedVisits: [], counts: { visits: 1, openLabOrders: 0, documents: 0, orthoCase: false },
  financial: { ...money(180000), byCurrency: { YER: money(180000), SAR: money(2300), USD: money(0) } },
  alerts: [], canSeeFinancial: true, assessmentCases: [], legacyCases: [] });
const walkout = () => ({ visitId, patientId, patientName: patient.fullName, patientNumber: patient.patientNumber,
  arrivedAt: "2026-10-09T08:00:00Z", signedAt: "2026-10-09T09:00:00Z", signedToday: true, deferred: false,
  lines: [], orthoAdjustment: { id: 98783, billingClass: "LEGACY_INCLUDED", pendingDecision: false, decision: null },
  invoice: null, payments: [], nextAppointment: null,
  balances: [{ currency: "YER", balanceMinor: 180000 }, { currency: "SAR", balanceMinor: 2300 }],
  checkout: { previous: { YER: 180000, SAR: 2300, USD: 0 }, current: { YER: 180000, SAR: 2300, USD: 0 },
    invoicePaidMinor: 0, paymentsToday: [], openingPaidToday: [] }, summary: [] });
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });
describe("built patient walkout verifies balances for reception", () => {
  it("reopens adjustment-only work with 180000, keeps currencies separate, and contains read failures", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar-YE", serviceWorkers: "block" });
    const [name, ...value] = h.sessions.reception.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const unexpected: string[] = [], errors: string[] = [], writes: string[] = [];
    let paidInvoice = false;
    const heldWalkoutReads: Route[] = [];
    let releaseHeldWalkoutReads!: () => void;
    const heldWalkoutGate = new Promise<void>((resolve) => { releaseHeldWalkoutReads = resolve; });
    let foreignCurrency: "SAR" | "USD" | null = null;
    const paymentAttempts: { body: Record<string, unknown>; key: string | undefined }[] = [];
    let fault: "none" | "http500" | "json" | "null" | "empty" | "missing" | "amount" | "foreign" | "hold" = "none";
    const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async (route) => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
      if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}${path}`); await route.abort(); return; }
      if (method === "POST" && path === "/api/payments" && paidInvoice) {
        paymentAttempts.push({ body: request.postDataJSON() as Record<string, unknown>, key: request.headers()["idempotency-key"] });
        await json(route, paymentAttempts.length === 1 ? { message: "Synthetic retry" } : { id: 98785 }, paymentAttempts.length === 1 ? 500 : 200);
        return; // Synthetic fulfillment; no payment request reaches the application server.
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) { writes.push(`${method} ${path}`); await json(route, {}, 409); return; }
      if (path === `/api/patients/${patientId}/workflow`) {
        const body = workflow();
        if (foreignCurrency) {
          body.financial = { ...money(0), byCurrency: { YER: money(0), SAR: money(0), USD: money(0) } };
          body.financial.byCurrency[foreignCurrency] = money(2300);
        }
        await json(route, body);
      }
      else if (path === `/api/patients/${patientId}/ledger` && foreignCurrency) {
        const balance = (dueMinor: number) => ({ billedMinor: 0, collectedMinor: 0, openingMinor: dueMinor, dueMinor });
        const balances = { YER: balance(0), SAR: balance(0), USD: balance(0) };
        balances[foreignCurrency] = balance(2300);
        await json(route, {
          invoices: [{ id: 98784, invoiceNumber: "SYN-PAID", status: "paid", patientId, totalMinor: 5000, discountMinor: 0,
            baseCurrency: "SAR", note: null, createdAt: "2026-10-09T09:00:00Z", items: [] }],
          payments: [], plans: [], opening: null, baseCurrency: "YER",
          balance: balance(0), balances, openings: [{ patientId, currency: foreignCurrency, amountMinor: 2300, asOfDate: "2026-10-09", note: null }],
          openingAccess: { add: false, edit: false }, legacyBalanceArrangements: [], legacyOpeningPositions: [], legacyArrangementAccess: { manage: false } });
      }
      else if (method === "GET" && path === `/api/patients/${patientId}/treatment-financial-context` && url.search === "") {
        const position = (dueMinor: number) => ({ billedMinor: 0, collectedMinor: 0, openingMinor: dueMinor, dueMinor });
        const accountPositions = { YER: position(foreignCurrency ? 0 : 180000), SAR: position(foreignCurrency ? 0 : 2300), USD: position(0) };
        if (foreignCurrency) accountPositions[foreignCurrency] = position(2300);
        const body: TreatmentFinancialContext = { patientId, references: [], plans: [], openingPositions: [], accountPositions,
          documents: paidInvoice ? [{ invoiceId: 98784, invoiceNumber: "SYN-PAID", status: "paid", currency: "SAR", grossMinor: 5000,
            discountMinor: 0, netMinor: 5000, installmentPlanId: null, settlements: [], directlyLinkedSettledMinor: 0,
            allocatedRemainingMinor: null, allocationState: "not_available" }] : [] };
        expect(isTreatmentFinancialContext(body, patientId)).toBe(true);
        await json(route, body);
      }
      else if (path === `/api/patients/${patientId}/legacy`) await json(route, { treatments: [], orphanPayments: [] });
      else if (path === `/api/patients/${patientId}/legacy-treatments`) await json(route, { agreements: [], canVoid: false });
      else if (path === "/api/services") await json(route, []);
      else if (path === `/api/patients/${patientId}`) await json(route, { patient, visits: [], appointments: [] });
      else if (path === `/api/visits/${visitId}/walkout`) {
        if (fault === "hold") {
          heldWalkoutReads.push(route);
          // Hold every request epoch, including a replacement after authority refresh.
          await heldWalkoutGate;
          await json(route, walkout());
          return;
        }
        if (fault === "http500") { await json(route, {}, 500); return; }
        if (fault === "json") { await route.fulfill({ status: 200, contentType: "application/json", body: "{" }); return; }
        if (fault === "null") { await json(route, null); return; }
        const body = walkout();
        if (paidInvoice) {
          (body as { invoice: unknown }).invoice = { id: 98784, number: "SYN-PAID", netMinor: 5000, currency: "SAR" };
          body.checkout.invoicePaidMinor = 5000;
        }
        if (foreignCurrency) {
          body.balances = [{ currency: foreignCurrency, balanceMinor: 2300 }];
          body.checkout.previous = { YER: 0, SAR: 0, USD: 0 };
          body.checkout.current = { YER: 0, SAR: 0, USD: 0 };
          body.checkout.previous[foreignCurrency] = 2300;
          body.checkout.current[foreignCurrency] = 2300;
        }
        if (fault === "empty") body.checkout.current = {} as typeof body.checkout.current;
        if (fault === "missing") delete (body.checkout.current as Partial<typeof body.checkout.current>).USD;
        if (fault === "amount") (body.checkout.current as { YER: unknown }).YER = "0";
        if (fault === "foreign") body.patientId++;
        await json(route, body);
      } else if (path === "/api/visits/readiness") await json(route, { visit: null });
      else if (path === "/api/visits") await json(route, []);
      else if (path === "/api/booking-requests") await json(route, []);
      else if (path === "/api/lab") await json(route, { late: 0 });
      else if (path === "/api/messages") await json(route, { unread: 0, urgent: 0 });
      else if (path === "/api/auth/me") await json(route, { username: "secreception", role: "reception" });
      else if (path.startsWith("/api/") || path.startsWith("/print/")) {
        unexpected.push(`${method} ${path}`); await json(route, {}, 404);
      } else await route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const verify = () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(writes).toEqual([]); };
    await routes.run(async () => {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=today`, { waitUntil: "domcontentloaded" });
      const checkout = page.getByRole("region", { name: "شبّاك ما بعد الزيارة" });
      await checkout.waitFor();
      await expect.poll(() => checkout.innerText()).toContain(formatMoney(180000, "YER"));
      expect(await checkout.innerText()).toContain(formatMoney(2300, "SAR"));
      expect(await checkout.innerText()).not.toContain(formatMoney(182300, "YER"));
      expect(await checkout.innerText()).toContain("شدّة تقويم");
      expect(await checkout.innerText()).toContain("مشمول بالعلاج السابق");
      expect(await checkout.innerText()).not.toContain("لا مبلغ مطلوب لهذه الزيارة");
      expect(await checkout.getByRole("link", { name: "🖨️ ملخّص المغادرة" }).getAttribute("href")).toBe(`/print/walkout/${visitId}`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => checkout.innerText()).toContain(formatMoney(180000, "YER"));
      for (const failure of ["http500", "json", "null", "empty", "missing", "amount", "foreign"] as const) {
        fault = failure;
        await page.reload({ waitUntil: "domcontentloaded" });
        const state = page.getByTestId("checkout-financial-read");
        await state.filter({ hasText: "تعذّر التحقق من الأرصدة" }).waitFor();
        expect(await page.locator("body").innerText()).not.toContain("لا مبلغ مطلوب لهذه الزيارة");
        expect(await page.locator("body").innerText()).not.toContain("لا رصيد سابق");
        fault = "none";
        await state.getByRole("button", { name: "إعادة التحقق من الأرصدة" }).click();
        await expect.poll(() => checkout.innerText()).toContain(formatMoney(180000, "YER"));
      }
      // Hold the real restore read deterministically. Until its response arrives,
      // absence of verified money must not expose a payment target or infer zero.
      try {
        fault = "hold";
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect.poll(() => heldWalkoutReads.length).toBeGreaterThanOrEqual(1);
        const delayedRead = page.getByTestId("checkout-financial-read");
        await delayedRead.filter({ hasText: "جارٍ التحقق من الأرصدة" }).waitFor();
        expect(await page.locator("body").innerText()).not.toContain("لا مبلغ مطلوب لهذه الزيارة");
        expect(await page.locator("body").innerText()).not.toContain("لا رصيد سابق");
        expect(await page.locator('[aria-label="شبّاك ما بعد الزيارة"][data-financial-state="verified"]').count()).toBe(0);
        expect(await page.getByRole("button", { name: "تحصيل وطباعة السند", exact: true }).count()).toBe(0);
        expect(await page.getByRole("dialog", { name: "تحصيل دفعة", exact: true }).count()).toBe(0);
        // A workflow refresh retires the first read's authority and starts a new
        // restore epoch. Both responses stay held: a FIFO-only release can strand
        // the current request while successfully fulfilling an aborted predecessor.
        const readsBeforeRefresh = heldWalkoutReads.length;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => heldWalkoutReads.length).toBeGreaterThan(readsBeforeRefresh);
        await delayedRead.filter({ hasText: "جارٍ التحقق من الأرصدة" }).waitFor();
        expect(await page.locator('[aria-label="شبّاك ما بعد الزيارة"][data-financial-state="verified"]').count()).toBe(0);
        expect(await page.getByRole("button", { name: "تحصيل وطباعة السند", exact: true }).count()).toBe(0);
      } finally {
        fault = "none";
        releaseHeldWalkoutReads();
      }
      await expect.poll(() => checkout.getAttribute("data-financial-state")).toBe("verified");
      await expect.poll(() => checkout.innerText()).toContain(formatMoney(180000, "YER"));
      expect(await checkout.innerText()).not.toContain("لا مبلغ مطلوب لهذه الزيارة");

      paidInvoice = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => checkout.innerText()).toContain(formatMoney(180000, "YER"));
      await checkout.getByRole("button", { name: "تحصيل وطباعة السند", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "تحصيل دفعة", exact: true });
      await dialog.waitFor();
      expect(await dialog.getByLabel("العملة", { exact: true }).inputValue()).toBe("YER");
      expect(await dialog.getByLabel("فاتورة الهدف", { exact: true }).count()).toBe(0);
      expect(await dialog.innerText()).toContain("دفعة على الحساب بالريال اليمني");
      await dialog.getByLabel("المبلغ", { exact: true }).fill("1000");
      await dialog.getByRole("button", { name: "سجّل الدفعة واطبع السند", exact: true }).click();
      const reconcile = dialog.getByRole("button", { name: "إعادة التحقق من العملية السابقة", exact: true });
      await reconcile.waitFor();
      expect(await dialog.innerText()).toContain(MONEY_UNCERTAIN);
      expect(await dialog.innerText()).not.toContain("Synthetic retry");
      expect(paymentAttempts).toHaveLength(1);
      expect(paymentAttempts[0].body).toMatchObject({ patientId, amount: "1000", currency: "YER", kind: "payment" });
      expect(paymentAttempts[0].body).not.toHaveProperty("invoiceId");
      expect(paymentAttempts[0].body).not.toHaveProperty("planId");
      expect(paymentAttempts[0].key).toBeTruthy();
      // PR313 preserves the unresolved request and locks new submission. Reconcile
      // the same attempt through its explicit action, never submit a fresh payment.
      expect(await dialog.getByRole("button", { name: "سجّل الدفعة واطبع السند", exact: true }).isDisabled()).toBe(true);
      expect(await dialog.getByLabel("المبلغ", { exact: true }).isDisabled()).toBe(true);
      await reconcile.click();
      await dialog.waitFor({ state: "detached" });
      expect(paymentAttempts).toHaveLength(2);
      expect(paymentAttempts[0].body).toMatchObject({ patientId, amount: "1000", currency: "YER", kind: "payment" });
      expect(paymentAttempts[0].body).not.toHaveProperty("invoiceId");
      expect(paymentAttempts[0].body).not.toHaveProperty("planId");
      expect(paymentAttempts[0].key).toBeTruthy();
      expect(paymentAttempts[1]).toEqual(paymentAttempts[0]);
      for (const currency of ["SAR", "USD"] as const) {
        foreignCurrency = currency;
        await page.goto(`${baseUrl}/patients/${patientId}?tab=today`, { waitUntil: "domcontentloaded" });
        await expect.poll(() => checkout.innerText()).toContain("يوجد رصيد بعملة أخرى");
        expect(await checkout.getByRole("button", { name: "تحصيل وطباعة السند", exact: true }).count()).toBe(0);
        const account = checkout.getByRole("link", { name: "اختيار هدف التحصيل من الحساب", exact: true });
        expect(await account.getAttribute("href")).toBe(`/patients/${patientId}?tab=account`);
        await account.click();
        await page.getByRole("button", { name: "قبض دفعة", exact: true }).click();
        const foreignDialog = page.getByRole("dialog", { name: "تحصيل دفعة", exact: true });
        await foreignDialog.getByLabel("رصيد سابق", { exact: true }).selectOption(currency);
        expect(await foreignDialog.getByLabel("العملة", { exact: true }).inputValue()).toBe(currency);
        await foreignDialog.getByLabel("المبلغ", { exact: true }).fill("10");
        await foreignDialog.getByRole("button", { name: "سجّل الدفعة واطبع السند", exact: true }).click();
        await foreignDialog.waitFor({ state: "detached" });
        expect(paymentAttempts.at(-1)?.body).toMatchObject({ patientId, amount: "10", currency, openingCurrency: currency });
        expect(paymentAttempts.at(-1)?.body).not.toHaveProperty("invoiceId");
        expect(paymentAttempts.at(-1)?.body).not.toHaveProperty("planId");
      }
      verify();
    }, verify);
  });
});


