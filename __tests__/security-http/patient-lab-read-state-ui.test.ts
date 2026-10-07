import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { LabOrder } from "@/lib/lab";
import { baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";

// Actual built patient page and real isolated test login. Scoped lab reads and
// the exact summary GET are synthetic; every write is rejected before dispatch. Other GETs use the existing disposable
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
  headersSettled: boolean; bodySettled: boolean; decoding: boolean; aborted: () => boolean;
  head: (status: number) => void; body: (payload: unknown, malformed?: boolean) => void;
  fail: () => void;
};
type FixtureWindow = Window & { __labReadState: Pending[] };
const title = "أعمال وتركيبات المعمل";
const readError = "تعذّر تحميل طلبات المعمل. أعد المحاولة.";
const empty = "لا توجد طلبات معمل مسجلة لهذا المريض";
const section = (page: Page) => page.getByRole("region", { name: "طلبات المعمل والتركيبات", exact: true });
const listTitle = (page: Page) => section(page).getByRole("heading", { level: 3 });
const retry = (page: Page) => section(page).getByRole("button", { name: "إعادة تحميل طلبات المعمل", exact: true });
const payload = (label: string) => ({
  orders: [{
    id: 81001, status: "received", patientId: h.seeded.patientAId, patientName: "مريض اصطناعي",
    patientNumber: "SYN-LAB", patientPhone: null, labName: "مختبر اصطناعي", labPhone: null,
    partyId: null, labServiceId: null, workType: label, details: null, toothNumbers: null,
    shade: null, stumpShade: null, priority: "normal", impressionType: "physical",
    sentDate: "2026-10-01", dueDate: "2026-10-10", receivedAt: null, deliveredAt: null,
    doctorId: null, visitId: null, qualityCheck: "pending", qualityNotes: null,
    remakeOriginalId: null, remakeReason: null, technicianName: null, note: null,
    createdAt: "2026-10-01T00:00:00Z",
  } satisfies LabOrder],
  labs: [{ labName: `اقتراح ${label}`, labPhone: null }],
});

async function fixture(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 1000 },
    locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [];
  const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(method) || url.pathname === "/api/lab") {
      unexpected.push(`${method} ${url.origin}${url.pathname}${url.search}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ patientId }) => {
    const entries: Pending[] = [];
    (window as unknown as FixtureWindow).__labReadState = entries;
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.origin === window.location.origin && method === "GET" && url.pathname === "/api/lab" && url.search === "?summary=1") {
        return Promise.resolve(new Response(JSON.stringify({ late: 0 }), {
          status: 200, headers: { "Content-Type": "application/json" },
        }));
      }
      if (url.origin !== window.location.origin || method !== "GET"
        || url.pathname !== "/api/lab" || url.search !== `?patientId=${patientId}`) return originalFetch(input, init);
      let resolve!: (value: Response) => void, reject!: (reason: Error) => void;
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
      const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
      const entry: Pending = {
        headersSettled: false, bodySettled: false, decoding: false,
        aborted: () => !!init?.signal?.aborted,
        head: (status) => {
          if (entry.headersSettled) throw new Error("Synthetic headers already settled");
          entry.headersSettled = true;
          const response = new Response(stream, { status, headers: { "Content-Type": "application/json" } });
          const json = response.json.bind(response);
          response.json = () => { entry.decoding = true; return json(); };
          resolve(response);
        },
        body: (data, malformed = false) => {
          if (entry.bodySettled) throw new Error("Synthetic body already settled");
          entry.bodySettled = true;
          streamController.enqueue(new TextEncoder().encode(malformed ? "not-json" : JSON.stringify(data)));
          streamController.close();
        },
        fail: () => {
          if (entry.headersSettled) throw new Error("Synthetic headers already settled");
          entry.headersSettled = true; entry.bodySettled = true;
          streamController.close();
          reject(new TypeError("Synthetic disconnected read"));
        },
      };
      entries.push(entry);
      // Deliberately ignore abort: correctness must also survive a late transport.
      return promise;
    }) as typeof window.fetch;
  }, { patientId: h.seeded.patientAId });
  return { page, routes, assertIsolated: () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); } };
}
async function requests(page: Page) {
  return page.evaluate(() => (window as unknown as FixtureWindow).__labReadState.map(
    ({ headersSettled, bodySettled, decoding, aborted }) => ({ headersSettled, bodySettled, decoding, aborted: aborted() }),
  ));
}
async function paint(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function waitForRequest(page: Page, index: number) {
  await expect.poll(async () => (await requests(page)).length).toBe(index + 1);
}
async function head(page: Page, index: number, status = 200) {
  await page.evaluate(({ index, status }) => (window as unknown as FixtureWindow).__labReadState[index].head(status), { index, status });
  await paint(page);
}
async function body(page: Page, index: number, data: unknown, malformed = false) {
  await page.evaluate(({ index, data, malformed }) => (window as unknown as FixtureWindow).__labReadState[index].body(data, malformed), { index, data, malformed });
  await paint(page);
}
async function finish(page: Page, index: number, status: number, data: unknown, malformed = false) {
  await head(page, index, status); await body(page, index, data, malformed);
}
async function pending(page: Page) {
  await expect.poll(() => listTitle(page).textContent()).toBe(title);
  expect(await section(page).getByText("جارٍ التحميل…", { exact: true }).isVisible()).toBe(true);
  expect(await section(page).getByText(empty, { exact: true }).count()).toBe(0);
}
async function failed(page: Page) {
  await expect.poll(() => section(page).getByRole("alert").textContent()).toBe(readError);
  expect(await listTitle(page).textContent()).toBe(title);
  expect(await section(page).getByText(empty, { exact: true }).count()).toBe(0);
  expect(await retry(page).isEnabled()).toBe(true);
}
async function open(page: Page) {
  await page.goto(`${baseUrl}/patients/${h.seeded.patientAId}?tab=treatment&sub=lab`, { waitUntil: "domcontentloaded" });
  await waitForRequest(page, 0); await pending(page);
}

describe("patient lab read states in the built page", () => {
  it.each([390, 1280])("contains refused/malformed/failed reads and explicitly recovers at %ipx", async (width) => {
    const f = await fixture(width), page = f.page;
    await f.routes.run(async () => {
      await open(page);
      let index = 0;
      for (const status of [401, 403, 404, 409, 500]) {
        await head(page, index, status); await failed(page);
        expect((await requests(page))[index].decoding).toBe(false);
        expect((await requests(page)).length).toBe(index + 1);
        await body(page, index, { message: "رفض اصطناعي" });
        await retry(page).click(); await waitForRequest(page, ++index); await pending(page);
      }
      await page.evaluate((index) => (window as unknown as FixtureWindow).__labReadState[index].fail(), index);
      await failed(page); await retry(page).click(); await waitForRequest(page, ++index);
      await head(page, index); await pending(page);
      expect((await requests(page))[index].decoding).toBe(true);
      await body(page, index, null, true); await failed(page);
      await retry(page).click(); await waitForRequest(page, ++index);
      await finish(page, index, 200, { orders: null, labs: [] }); await failed(page);
      await retry(page).click(); await waitForRequest(page, ++index);
      await finish(page, index, 200, payload("تاج القراءة الحالية"));
      await expect.poll(() => listTitle(page).textContent()).toBe(`${title} (1)`);
      expect(await section(page).getByText("تاج القراءة الحالية", { exact: true }).isVisible()).toBe(true);
      expect(await section(page).getByRole("alert").count()).toBe(0);
      expect((await requests(page)).every((entry) => entry.headersSettled && entry.bodySettled)).toBe(true);
      f.assertIsolated();
    }, f.assertIsolated);
  });

  it.each([390, 1280])("shows zero only after a valid empty body at %ipx", async (width) => {
    const f = await fixture(width), page = f.page;
    await f.routes.run(async () => {
      await open(page); await head(page, 0); await pending(page);
      await body(page, 0, { orders: [], labs: [] });
      await expect.poll(() => listTitle(page).textContent()).toBe(`${title} (0)`);
      expect(await section(page).getByText(empty, { exact: true }).isVisible()).toBe(true);
      expect(await section(page).getByRole("alert").count()).toBe(0);
      f.assertIsolated();
    }, f.assertIsolated);
  });

  it.each([390, 1280].flatMap((width) => ["headers", "body"].map((phase) => ({ width, phase }))))(
    "contains old $phase after leaving and reopening the lab panel at $width", async ({ width, phase }) => {
      const f = await fixture(width), page = f.page;
      await f.routes.run(async () => {
        await open(page);
        if (phase === "body") {
          await head(page, 0); await pending(page);
          expect((await requests(page))[0].decoding).toBe(true);
        }
        await page.getByTestId("patient-tab-files").click();
        await expect.poll(() => page.getByTestId("patient-tab-files").getAttribute("aria-current")).toBe("page");
        expect(await section(page).count()).toBe(0);
        expect((await requests(page))[0].aborted).toBe(true);
        await page.getByTestId("patient-tab-treatment").click();
        await waitForRequest(page, 1); await pending(page);
        if (phase === "headers") await head(page, 0);
        await body(page, 0, payload("تاج قديم مرفوض"));
        await pending(page);
        if (phase === "headers") expect((await requests(page))[0].decoding).toBe(false);
        expect(await section(page).getByText("تاج قديم مرفوض", { exact: true }).count()).toBe(0);
        await finish(page, 1, 200, payload("تاج جديد مؤكد"));
        await expect.poll(() => listTitle(page).textContent()).toBe(`${title} (1)`);
        expect(await section(page).getByText("تاج جديد مؤكد", { exact: true }).isVisible()).toBe(true);
        expect(await section(page).getByRole("alert").count()).toBe(0);
        expect((await requests(page)).length).toBe(2);
        expect((await requests(page)).every((entry) => entry.headersSettled && entry.bodySettled)).toBe(true);
        f.assertIsolated();
      }, f.assertIsolated);
    },
  );
});
