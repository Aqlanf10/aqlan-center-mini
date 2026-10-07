import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { LabOrder } from "@/lib/lab";
import { baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";

// Temporary real React lifetime counterfactual, compiled by the actual Next build.
// Real component, providers and modals; controlled scoped reads and the exact
// synthetic receive PATCH never reach a writer. Other writes/origins are rejected.
// The eight normal-page and twelve status browser cases are run unchanged too.
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
  method: string; path: string; query: string; requestBody: unknown;
  headersSettled: boolean; bodySettled: boolean; decoding: boolean; aborted: () => boolean;
  head: (status: number) => void; body: (payload: unknown, malformed?: boolean) => void;
  fail: () => void;
};
type FixtureWindow = Window & { __labReadState: Pending[] };
const title = "أعمال وتركيبات المعمل";
const empty = "لا توجد طلبات معمل مسجلة لهذا المريض";
const section = (page: Page) => page.getByRole("region", { name: "قراءة المختبر الاصطناعية", exact: true });
const listTitle = (page: Page) => section(page).getByRole("heading", { level: 3 });
const payload = (label: string, patientId = 82001, status: LabOrder["status"] = "received") => ({
  orders: [{
    id: 81001, status, patientId, patientName: "مريض اصطناعي",
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
  await page.addInitScript(() => {
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
      if (url.origin === window.location.origin && method === "GET" && url.pathname === "/api/laboratories" && url.search === "") {
        return Promise.resolve(new Response(JSON.stringify({ laboratories: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      const scopedRead = method === "GET" && url.pathname === "/api/lab"
        && ["?patientId=82001", "?patientId=82002"].includes(url.search);
      const command = method === "PATCH" && url.pathname === "/api/lab/81001" && url.search === ""
        && typeof init?.body === "string" && init.body === JSON.stringify({ status: "received" });
      if (url.origin !== window.location.origin || (!scopedRead && !command)) return originalFetch(input, init);
      let resolve!: (value: Response) => void, reject!: (reason: Error) => void;
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
      const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
      const entry: Pending = {
        method, path: url.pathname, query: url.search, requestBody: init?.body ?? null,
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
  });
  return { page, routes, assertIsolated: () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); } };
}
async function requests(page: Page) {
  return page.evaluate(() => (window as unknown as FixtureWindow).__labReadState.map(
    ({ method, path, query, requestBody, headersSettled, bodySettled, decoding, aborted }) => ({ method, path, query, requestBody, headersSettled, bodySettled, decoding, aborted: aborted() }),
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
async function open(page: Page) {
  await page.goto(`${baseUrl}/proof-patient-lab-read`, { waitUntil: "domcontentloaded" });
  await waitForRequest(page, 0);
}



const receive = (page: Page) => section(page).getByRole("button", { name: "✓ استلام من المختبر", exact: true });
const current = (page: Page, label: string) => section(page).getByText(label, { exact: true });

describe("real React lab ownership counterfactual", () => {
  it.each([390, 1280])("ignores stale A body after confirmed B at %ipx", async (width) => {
    const f = await fixture(width), page = f.page;
    await f.routes.run(async () => {
      await open(page); await head(page, 0);
      await page.getByTestId("proof-patient-b").click(); await waitForRequest(page, 1);
      await finish(page, 1, 200, payload("حالي ب", 82002));
      await expect.poll(() => current(page, "حالي ب").isVisible()).toBe(true);
      await body(page, 0, payload("قديم أ"));
      expect(await current(page, "قديم أ").count()).toBe(0);
      expect(await current(page, "حالي ب").isVisible()).toBe(true);
      f.assertIsolated();
    }, f.assertIsolated);
  });

  it.each([390, 1280])("ignores stale A1 headers after confirmed A2 at %ipx", async (width) => {
    const f = await fixture(width), page = f.page;
    await f.routes.run(async () => {
      await open(page);
      await page.getByTestId("proof-patient-b").click(); await waitForRequest(page, 1);
      await finish(page, 1, 200, payload("حالي ب", 82002));
      await expect.poll(() => current(page, "حالي ب").isVisible()).toBe(true);
      await page.getByTestId("proof-patient-a").click(); await waitForRequest(page, 2);
      await finish(page, 2, 200, payload("حالي أ٢"));
      await expect.poll(() => current(page, "حالي أ٢").isVisible()).toBe(true);
      await finish(page, 0, 200, payload("قديم أ١"));
      expect(await current(page, "قديم أ١").count()).toBe(0);
      expect(await current(page, "حالي أ٢").isVisible()).toBe(true);
      f.assertIsolated();
    }, f.assertIsolated);
  });

  it.each([390, 1280])("ignores accepted body after principal removal at %ipx", async (width) => {
    const f = await fixture(width), page = f.page;
    await f.routes.run(async () => {
      await open(page); await head(page, 0);
      await page.getByTestId("proof-null").click(); await paint(page);
      await body(page, 0, payload("هوية متقاعدة"));
      expect(await current(page, "هوية متقاعدة").count()).toBe(0);
      expect((await requests(page)).length).toBe(1);
      expect(await section(page).getByRole("alert").textContent()).toBe("انتهت الجلسة. سجّل الدخول من جديد.");
      f.assertIsolated();
    }, f.assertIsolated);
  });

  it.each([390, 1280])("does not refresh an accepted command after unmount at %ipx", async (width) => {
    const f = await fixture(width), page = f.page;
    await f.routes.run(async () => {
      await open(page); await finish(page, 0, 200, payload("استلام اصطناعي", 82001, "sent"));
      await expect.poll(() => receive(page).isEnabled()).toBe(true);
      await receive(page).click(); await waitForRequest(page, 1);
      await page.getByTestId("proof-toggle").click(); await expect.poll(() => section(page).count()).toBe(0);
      await finish(page, 1, 200, null);
      expect((await requests(page)).length).toBe(2);
      expect((await requests(page)).filter((entry) => entry.method === "PATCH")).toHaveLength(1);
      f.assertIsolated();
    }, f.assertIsolated);
  });

  it.each([390, 1280])("preserves accepted empty-list semantics at %ipx", async (width) => {
    const f = await fixture(width), page = f.page;
    await f.routes.run(async () => {
      await open(page); await finish(page, 0, 200, { orders: [], labs: [] });
      await expect.poll(() => listTitle(page).textContent()).toBe(`${title} (0)`);
      expect(await section(page).getByText(empty, { exact: true }).isVisible()).toBe(true);
      expect(await section(page).getByRole("alert").count()).toBe(0);
      expect((await requests(page)).length).toBe(1);
      f.assertIsolated();
    }, f.assertIsolated);
  });
});
