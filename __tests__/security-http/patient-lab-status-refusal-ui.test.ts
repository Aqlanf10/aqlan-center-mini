import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import type { LabOrder } from "@/lib/lab";
import { baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";

// Actual built patient page and real isolated test login. Scoped lab reads,
// the exact summary GET and synthetic status commands are substituted before dispatch.
// No lab/booking writer is called. Other GETs use the existing disposable
// security harness. This is UI acceptance, not authorization or persistence.
// Source preparation must not collect/run this file locally: global setup
// starts the application and PostgreSQL. Execution is reviewed isolated CI only.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  expect(process.env.CI).toBe("true");
  expect(process.env.GITHUB_ACTIONS).toBe("true");
  expect(new URL(baseUrl).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  h = await harness();
  const database = new URL(h.seeded.dbUrl);
  expect(database.pathname).toBe("/aqlan_sec_http");
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(database.hostname);
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

type Pending = {
  method: string; path: string; query: string; body: unknown; settled: boolean;
  finish: (status: number, payload: unknown, malformed?: boolean) => void;
  fail: () => void;
};
type FixtureWindow = Window & { __labStatusRefusal: Pending[] };
const patientName = "مريض مختبر اصطناعي";
const order = (id: number, status: LabOrder["status"]): LabOrder => ({
  id, status, patientId: h.seeded.patientAId, patientName, patientNumber: "SYN-LAB",
  patientPhone: null, labName: "مختبر اصطناعي", labPhone: null, partyId: null, labServiceId: null,
  workType: `تاج اختبار ${id}`, details: "تعليمات اصطناعية", toothNumbers: "14", shade: "A2",
  stumpShade: null, priority: "normal", impressionType: "physical", sentDate: "2026-10-01",
  dueDate: "2026-10-10", receivedAt: null, deliveredAt: null, doctorId: null, visitId: null,
  qualityCheck: "pending", qualityNotes: null, remakeOriginalId: null, remakeReason: null,
  technicianName: null, note: "ملاحظة اصطناعية", createdAt: "2026-10-01T00:00:00Z",
});
const orders = () => [order(81001, "sent"), order(81002, "in_progress"), order(81003, "received")];
const commands = [
  { id: 81001, status: "received", label: "✓ استلام من المختبر", before: "قيد العمل بالمختبر" },
  { id: 81002, status: "received", label: "✓ استلام من المختبر", before: "قيد التصنيع في المعمل" },
  { id: 81003, status: "delivered", label: "✓ تسليم وتركيب للمريض", before: "مستلم بالعيادة" },
] as const;
const modalTitle = "تذكير بحجز موعد تسليم وتركيب";
const fallback = "تعذّر تحديث حالة طلب المعمل.";
const uncertain = "تعذّر تأكيد تحديث حالة طلب المعمل. تحقّق من حالته قبل إعادة المحاولة.";
const longMessage = "رفض اصطناعي: " + "راجع حالة الطلب قبل إعادة المحاولة. ".repeat(6)
  + "تفاصيلمتصلة".repeat(12);

async function fixture(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 1000 },
    locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [];
  const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(method)) {
      unexpected.push(`${method} ${url.origin}${url.pathname}`);
      await route.abort();
      return;
    }
    // All authorized lab reads use the exact fixture intercepts below. Reject
    // any remainder, including a nonempty query without a patient scope.
    if (url.pathname === "/api/lab") {
      unexpected.push(`${method} ${url.pathname}${url.search}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ patientId, ids }) => {
    const requests: Pending[] = [];
    (window as unknown as FixtureWindow).__labStatusRefusal = requests;
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      // AppShell's known badge read is also synthetic; no broader lab read is
      // allowed through the route guard, regardless of its query parameters.
      if (url.origin === window.location.origin && method === "GET"
        && url.pathname === "/api/lab" && url.search === "?summary=1") {
        return Promise.resolve(new Response(JSON.stringify({ late: 0 }), {
          status: 200, headers: { "Content-Type": "application/json" },
        }));
      }
      const scopedRead = url.pathname === "/api/lab" && url.search === `?patientId=${patientId}`;
      const command = ids.some((id) => url.pathname === `/api/lab/${id}`) && url.search === "";
      if (url.origin !== window.location.origin || (!scopedRead && !command)) return originalFetch(input, init);
      let resolve!: (value: Response) => void, reject!: (error: Error) => void;
      const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
      const pending: Pending = {
        method, path: url.pathname, query: url.search,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null, settled: false,
        finish: (status, payload, malformed = false) => {
          if (pending.settled) throw new Error("Synthetic request already settled");
          pending.settled = true;
          resolve(new Response(malformed ? "not-json" : JSON.stringify(payload), {
            status, headers: { "Content-Type": "application/json" },
          }));
        },
        fail: () => {
          if (pending.settled) throw new Error("Synthetic request already settled");
          pending.settled = true;
          reject(new TypeError("Synthetic response connection lost"));
        },
      };
      requests.push(pending);
      return promise;
    }) as typeof window.fetch;
  }, { patientId: h.seeded.patientAId, ids: commands.map((command) => command.id) });
  return { page, routes, assertIsolated: () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); } };
}
const section = (page: Page) => page.getByRole("region", { name: "طلبات المعمل والتركيبات", exact: true });
const modal = (page: Page) => page.getByRole("heading", { name: modalTitle, exact: true });
function card(page: Page, id: number) {
  return section(page).getByText(`تاج اختبار ${id}`, { exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'rounded-2xl')][1]");
}
const button = (page: Page, command: (typeof commands)[number]) =>
  card(page, command.id).getByRole("button", { name: command.label, exact: true });
async function paint(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function requests(page: Page) {
  return page.evaluate(() => (window as unknown as FixtureWindow).__labStatusRefusal.map(
    ({ method, path, query, body, settled }) => ({ method, path, query, body, settled }),
  ));
}
async function waitForRequest(page: Page, index: number) {
  await expect.poll(async () => (await requests(page)).length).toBe(index + 1);
}
async function finish(page: Page, index: number, status: number, payload: unknown, malformed = false) {
  await page.evaluate(({ index, status, payload, malformed }) => {
    (window as unknown as FixtureWindow).__labStatusRefusal[index].finish(status, payload, malformed);
  }, { index, status, payload, malformed });
  await paint(page);
}
async function fail(page: Page, index: number) {
  await page.evaluate((i) => (window as unknown as FixtureWindow).__labStatusRefusal[i].fail(), index);
  await paint(page);
}
async function open(page: Page) {
  await page.goto(`${baseUrl}/patients/${h.seeded.patientAId}?tab=treatment&sub=lab`, { waitUntil: "domcontentloaded" });
  await waitForRequest(page, 0);
  expect((await requests(page))[0]).toEqual({ method: "GET", path: "/api/lab",
    query: `?patientId=${h.seeded.patientAId}`, body: null, settled: false });
  await finish(page, 0, 200, { orders: orders(), labs: [] });
  await expect.poll(() => button(page, commands[0]).isVisible()).toBe(true);
}
async function assertOriginalRows(page: Page) {
  for (const command of commands) {
    expect(await card(page, command.id).textContent()).toContain(command.before);
    expect(await button(page, command).isEnabled()).toBe(true);
  }
  expect(await modal(page).count()).toBe(0);
}
async function assertWrite(page: Page, index: number, command: (typeof commands)[number]) {
  expect((await requests(page))[index]).toEqual({ method: "PATCH", path: `/api/lab/${command.id}`,
    query: "", body: { status: command.status }, settled: false });
}
async function paintedBounds(locator: Locator) {
  await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await locator.page().evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const evidence = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect(), range = document.createRange();
    range.selectNodeContents(element);
    const rects = [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0);
    const sample = (box: DOMRect) => {
      const points = [[box.x + box.width / 2, box.y + box.height / 2],
        [box.x + box.width / 4, box.y + box.height / 4], [box.x + box.width * 3 / 4, box.y + box.height * 3 / 4]];
      return { x: box.x, y: box.y, width: box.width, height: box.height,
        inViewport: box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
        owned: points.map(([x, y]) => element.contains(document.elementFromPoint(x, y))) };
    };
    return { direction: getComputedStyle(document.documentElement).direction,
      viewport: { width: innerWidth, height: innerHeight }, element: sample(rect), text: rects.map(sample),
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  expect(evidence.direction).toBe("rtl");
  expect(evidence.element.width).toBeGreaterThan(0);
  expect(evidence.element.height).toBeGreaterThan(0);
  expect(evidence.element.inViewport).toBe(true);
  expect(evidence.element.owned.every(Boolean)).toBe(true);
  expect(evidence.text.length).toBeGreaterThan(0);
  expect(evidence.documentOverflow).toBe(false);
  for (const rect of evidence.text) {
    expect(rect.inViewport).toBe(true);
    expect(rect.owned.every(Boolean)).toBe(true);
  }
  return evidence;
}

describe("built patient lab refusal containment", () => {
  it.each([390, 1280].flatMap((width) => commands.map((command) => ({ width, command, id: command.id }))))(
    "keeps exact order $id truthful through refusal, uncertainty and explicit retry at $width", async ({ width, command }) => {
      const f = await fixture(width), page = f.page;
      await f.routes.run(async () => {
        await open(page);
        const target = button(page, command);
        const evidence: Record<string, unknown> = { width, orderId: command.id, requestedStatus: command.status };
        for (const status of [401, 403, 409, 500]) {
          const index = (await requests(page)).length;
          // Native same-turn repeated clicks are real DOM events. The focused
          // handler suite separately proves the pre-render synchronous lock.
          await target.evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
          await waitForRequest(page, index);
          await assertWrite(page, index, command);
          for (const item of commands) expect(await button(page, item).isEnabled()).toBe(false);
          expect(await card(page, 81003).getByRole("button", { name: "📅 حجز موعد تسليم", exact: true }).isEnabled()).toBe(false);
          expect(await card(page, 81001).getByRole("button", { name: "✕ إلغاء الإرسالية", exact: true }).isEnabled()).toBe(false);
          await button(page, commands.find((item) => item.id !== command.id)!).evaluate((element) => (element as HTMLButtonElement).click());
          await paint(page);
          expect((await requests(page)).length).toBe(index + 1);
          const message = status === 409 ? longMessage : `رفض اصطناعي ${status}`;
          await finish(page, index, status, { message });
          const alert = section(page).getByRole("alert");
          await expect.poll(() => alert.textContent()).toBe(message);
          expect((await requests(page)).length).toBe(index + 1);
          await assertOriginalRows(page);
          if (status === 409) {
            evidence.refusal = await paintedBounds(alert);
            if (command.id === 81001) {
              await mkdir(".settings-ui-artifacts", { recursive: true });
              await page.screenshot({ path: `.settings-ui-artifacts/lab-status-refusal-${width}.png`, fullPage: false });
            }
            evidence.retry = await paintedBounds(target);
          }
        }
        let index = (await requests(page)).length;
        await target.click(); await waitForRequest(page, index); await assertWrite(page, index, command);
        await finish(page, index, 500, null, true);
        await expect.poll(() => section(page).getByRole("alert").textContent()).toBe(fallback);
        await assertOriginalRows(page);
        expect((await requests(page)).length).toBe(index + 1);

        index = (await requests(page)).length;
        await target.click(); await waitForRequest(page, index); await assertWrite(page, index, command);
        await fail(page, index);
        await expect.poll(() => section(page).getByRole("alert").textContent()).toBe(uncertain);
        await assertOriginalRows(page);
        expect((await requests(page)).length).toBe(index + 1);
        evidence.uncertain = await paintedBounds(section(page).getByRole("alert"));

        index = (await requests(page)).length;
        await target.click(); await waitForRequest(page, index); await assertWrite(page, index, command);
        expect(await section(page).getByRole("alert").count()).toBe(0);
        expect(await modal(page).count()).toBe(0);
        await finish(page, index, 200, { ...order(command.id, command.status) });
        await waitForRequest(page, index + 1);
        expect((await requests(page))[index + 1]).toEqual({ method: "GET", path: "/api/lab",
          query: `?patientId=${h.seeded.patientAId}`, body: null, settled: false });
        expect(await modal(page).count()).toBe(0);
        expect(await section(page).getByText("جارٍ التحميل…", { exact: true }).isVisible()).toBe(true);
        await finish(page, index + 1, 200, {
          orders: orders().map((item) => item.id === command.id ? { ...item, status: command.status } : item), labs: [],
        });
        if (command.status === "received") {
          await modal(page).waitFor();
          const overlay = modal(page).locator("xpath=ancestor::div[contains(@class, 'fixed')][1]");
          expect(await overlay.getByText(patientName, { exact: true }).count()).toBe(1);
          expect(await overlay.getByText(`تاج اختبار ${command.id}`, { exact: true }).count()).toBe(1);
          expect(await overlay.getByPlaceholder("ملاحظات الموعد...").inputValue()).toContain(`طلب معمل #${command.id}`);
          expect(await overlay.getByPlaceholder("ملاحظات الموعد...").inputValue()).toContain("تاج اختبار");
          await overlay.getByRole("button", { name: "إغلاق", exact: true }).click();
          await modal(page).waitFor({ state: "hidden" });
        } else {
          await expect.poll(() => card(page, command.id).textContent()).toContain("تم التسليم للمريض");
          expect(await modal(page).count()).toBe(0);
        }
        expect(await section(page).getByRole("alert").count()).toBe(0);
        expect((await requests(page)).length).toBe(index + 2);
        expect((await requests(page)).filter((entry) => entry.method === "PATCH")).toHaveLength(7);
        expect((await requests(page)).every((entry) => entry.settled)).toBe(true);
        if (command.id === 81001) {
          evidence.success = await paintedBounds(card(page, command.id).getByRole("button", { name: "✓ تسليم وتركيب للمريض", exact: true }));
          await page.screenshot({ path: `.settings-ui-artifacts/lab-status-retry-${width}.png`, fullPage: false });
          await writeFile(`.settings-ui-artifacts/lab-status-refusal-${width}-bounds.json`, JSON.stringify(evidence, null, 2));
        }
        f.assertIsolated();
      }, f.assertIsolated);
    },
  );

  it.each([390, 1280].flatMap((width) => ["received", "refused", "network"].map((outcome) => ({ width, outcome }))))(
    "contains a late $outcome completion after leaving the lab panel at $width", async ({ width, outcome }) => {
      const f = await fixture(width), page = f.page;
      await f.routes.run(async () => {
        await open(page);
        await button(page, commands[0]).click(); await waitForRequest(page, 1);
        await assertWrite(page, 1, commands[0]);
        await page.getByTestId("patient-tab-files").click();
        await expect.poll(() => page.getByTestId("patient-tab-files").getAttribute("aria-current")).toBe("page");
        expect(await section(page).count()).toBe(0);
        if (outcome === "network") await fail(page, 1);
        else await finish(page, 1, outcome === "received" ? 200 : 409, outcome === "received"
          ? order(81001, "received") : { message: "رفض اصطناعي بعد المغادرة" });
        let next = 2;
        if (outcome === "received") {
          // Disclosed existing behavior: success still makes its old scoped
          // read after unmount. This test does not claim request cancellation.
          await waitForRequest(page, 2);
          await finish(page, 2, 200, { orders: [order(81001, "received"), order(81002, "in_progress"), order(81003, "received")], labs: [] });
          next = 3;
        }
        expect(await modal(page).count()).toBe(0);
        expect(await section(page).count()).toBe(0);
        expect((await requests(page)).filter((entry) => entry.method === "PATCH")).toHaveLength(1);
        await page.getByTestId("patient-tab-treatment").click();
        await waitForRequest(page, next);
        const current = orders().map((item) => outcome === "received" && item.id === 81001 ? { ...item, status: "received" } : item);
        await finish(page, next, 200, { orders: current, labs: [] });
        await expect.poll(() => card(page, 81001).isVisible()).toBe(true);
        expect(await card(page, 81001).textContent()).toContain(outcome === "received" ? "مستلم بالعيادة" : "قيد العمل بالمختبر");
        expect(await modal(page).count()).toBe(0);
        expect(await section(page).getByRole("alert").count()).toBe(0);
        expect((await requests(page)).filter((entry) => entry.method === "PATCH")).toHaveLength(1);
        expect((await requests(page)).every((entry) => entry.settled)).toBe(true);
        f.assertIsolated();
      }, f.assertIsolated);
    },
  );
});
