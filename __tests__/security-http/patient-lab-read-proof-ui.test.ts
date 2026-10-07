import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import type { LabOrder } from "@/lib/lab";
import { baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";

// Temporary candidate-only real React proof route, compiled by the actual Next build.
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
const phaseName = process.env.PATIENT_LAB_READ_PROOF_PHASE;
if (phaseName !== "candidate-before" && phaseName !== "candidate-after") throw new Error("Candidate-only extra proof phase required");
const evidenceRoot = `.patient-lab-read-proof-results/${phaseName}-ui`;
const title = "أعمال وتركيبات المعمل";
const readError = "تعذّر تحميل طلبات المعمل. أعد المحاولة.";
const empty = "لا توجد طلبات معمل مسجلة لهذا المريض";
const section = (page: Page) => page.getByRole("region", { name: "قراءة المختبر الاصطناعية", exact: true });
const listTitle = (page: Page) => section(page).getByRole("heading", { level: 3, name: /^أعمال وتركيبات المعمل(?: \(\d+\))?$/ });
const retry = (page: Page) => section(page).getByRole("button", { name: "إعادة تحميل طلبات المعمل", exact: true });
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
  await page.goto(`${baseUrl}/proof-patient-lab-read`, { waitUntil: "domcontentloaded" });
  await waitForRequest(page, 0); await pending(page);
}


async function bounds(locator: Locator) {
  const evidence = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect(), range = document.createRange();
    range.selectNodeContents(element);
    const sample = (box: DOMRect) => ({
      x: box.x, y: box.y, width: box.width, height: box.height,
      inViewport: box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
      owned: [[.25, .25], [.5, .5], [.75, .75]].map(([x, y]) =>
        element.contains(document.elementFromPoint(box.x + box.width * x, box.y + box.height * y))),
    });
    return {
      direction: getComputedStyle(document.documentElement).direction,
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      element: sample(rect),
      text: [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0).map(sample),
    };
  });
  expect(evidence.direction).toBe("rtl");
  expect(evidence.documentOverflow).toBe(false);
  expect(evidence.element.width).toBeGreaterThan(0);
  expect(evidence.element.height).toBeGreaterThan(0);
  expect(evidence.element.inViewport).toBe(true);
  expect(evidence.element.owned.every(Boolean)).toBe(true);
  expect(evidence.text.length).toBeGreaterThan(0);
  for (const text of evidence.text) {
    expect(text.inViewport).toBe(true);
    expect(text.owned.every(Boolean)).toBe(true);
  }
  return evidence;
}
async function capture(page: Page, width: number, scene: string, targets: Record<string, Locator>) {
  await targets[Object.keys(targets)[0]].evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await paint(page);
  const measured: Record<string, unknown> = { phase: phaseName, width, scene };
  for (const [name, locator] of Object.entries(targets)) measured[name] = await bounds(locator);
  await mkdir(evidenceRoot, { recursive: true });
  await page.screenshot({ path: `${evidenceRoot}/${scene}-${width}.png`, fullPage: false });
  await writeFile(`${evidenceRoot}/${scene}-${width}-bounds.json`, JSON.stringify(measured, null, 2));
}
const booking = (page: Page) => page.getByRole("heading", { name: "تذكير بحجز موعد تسليم وتركيب", exact: true });
const receive = (page: Page) => section(page).getByRole("button", { name: "✓ استلام من المختبر", exact: true });

describe("temporary real React patient lab read proof", () => {
  it.each([390, 1280])("captures truthful unavailable retry and confirmed empty at %ipx", async (width) => {
    const f = await fixture(width), page = f.page;
    await f.routes.run(async () => {
      await open(page); await head(page, 0, 500); await failed(page);
      await body(page, 0, { message: "خطأ اصطناعي" });
      await capture(page, width, "unavailable", { alert: section(page).getByRole("alert"), retry: retry(page) });
      await retry(page).click(); await waitForRequest(page, 1); await pending(page);
      await finish(page, 1, 200, { orders: [], labs: [] });
      await expect.poll(() => listTitle(page).textContent()).toBe(`${title} (0)`);
      await capture(page, width, "confirmed-empty", { heading: listTitle(page), empty: section(page).getByText(empty, { exact: true }) });
      expect((await requests(page)).length).toBe(2);
      f.assertIsolated();
    }, f.assertIsolated);
  });

  it.each([390, 1280].flatMap((width) => ["headers", "body"].map((boundary) => ({ width, boundary }))))(
    "retires A1 through A to B to A at $boundary and $width", async ({ width, boundary }) => {
      const f = await fixture(width), page = f.page;
      await f.routes.run(async () => {
        await open(page);
        if (boundary === "body") await head(page, 0);
        await page.getByTestId("proof-patient-b").click(); await waitForRequest(page, 1); await pending(page);
        await finish(page, 1, 200, payload("طلب ب الحالي", 82002));
        await expect.poll(() => listTitle(page).textContent()).toBe(`${title} (1)`);
        await page.getByTestId("proof-patient-a").click(); await waitForRequest(page, 2); await pending(page);
        expect(await section(page).getByText("طلب ب الحالي", { exact: true }).count()).toBe(0);
        if (boundary === "headers") await head(page, 0);
        await body(page, 0, payload("طلب أ المتقاعد"));
        await pending(page);
        expect((await requests(page))[0].aborted).toBe(true);
        expect((await requests(page))[0].decoding).toBe(boundary === "body");
        expect(await section(page).getByText("طلب أ المتقاعد", { exact: true }).count()).toBe(0);
        await finish(page, 2, 200, payload("طلب أ الجديد"));
        await expect.poll(() => section(page).getByText("طلب أ الجديد", { exact: true }).isVisible()).toBe(true);
        expect((await requests(page)).map((entry) => entry.query)).toEqual(["?patientId=82001", "?patientId=82002", "?patientId=82001"]);
        f.assertIsolated();
      }, f.assertIsolated);
    },
  );

  it.each([390, 1280].flatMap((width) => ["username", "role", "permissions", "null"].map((change) => ({ width, change }))))(
    "retires principal body for $change at $width", async ({ width, change }) => {
      const f = await fixture(width), page = f.page;
      await f.routes.run(async () => {
        await open(page); await head(page, 0);
        await page.getByTestId(`proof-${change}`).click(); await paint(page);
        if (change === "null") {
          await expect.poll(() => section(page).getByRole("alert").textContent()).toBe("انتهت الجلسة. سجّل الدخول من جديد.");
          expect((await requests(page)).length).toBe(1);
          expect(await section(page).getByRole("button", { name: "+ طلب معمل جديد", exact: true }).isEnabled()).toBe(false);
        } else { await waitForRequest(page, 1); await pending(page); }
        await body(page, 0, payload("طلب الهوية المتقاعدة"));
        expect((await requests(page))[0].aborted).toBe(true);
        expect(await section(page).getByText("طلب الهوية المتقاعدة", { exact: true }).count()).toBe(0);
        if (change === "null") {
          expect((await requests(page)).length).toBe(1);
          await page.getByTestId("proof-restore").click(); await waitForRequest(page, 1);
        }
        await finish(page, 1, 200, payload("طلب الهوية الحالية"));
        await expect.poll(() => section(page).getByText("طلب الهوية الحالية", { exact: true }).isVisible()).toBe(true);
        expect(await section(page).getByRole("alert").count()).toBe(0);
        f.assertIsolated();
      }, f.assertIsolated);
    },
  );

  it.each([390, 1280].flatMap((width) => ["success-headers", "refusal-body"].map((outcome) => ({ width, outcome }))))(
    "retires unmounted receive $outcome without follow-on UI at $width", async ({ width, outcome }) => {
      const f = await fixture(width), page = f.page;
      await f.routes.run(async () => {
        await open(page); await finish(page, 0, 200, payload("طلب الاستلام", 82001, "sent"));
        await receive(page).click(); await waitForRequest(page, 1);
        expect((await requests(page))[1].requestBody).toBe(JSON.stringify({ status: "received" }));
        if (outcome === "refusal-body") await head(page, 1, 409);
        await page.getByTestId("proof-toggle").click(); await expect.poll(() => section(page).count()).toBe(0);
        if (outcome === "success-headers") await head(page, 1);
        await body(page, 1, { message: "رفض قديم" });
        expect((await requests(page)).length).toBe(2);
        expect(await booking(page).count()).toBe(0);
        await page.getByTestId("proof-toggle").click(); await waitForRequest(page, 2);
        await finish(page, 2, 200, payload("طلب العودة", 82001, "sent"));
        await expect.poll(() => receive(page).isEnabled()).toBe(true);
        expect(await section(page).getByRole("alert").count()).toBe(0);
        expect(await booking(page).count()).toBe(0);
        f.assertIsolated();
      }, f.assertIsolated);
    },
  );

  it.each([390, 1280])("keeps accepted receipt booking truthful when its refresh fails at %ipx", async (width) => {
    const f = await fixture(width), page = f.page;
    await f.routes.run(async () => {
      await open(page); await finish(page, 0, 200, payload("طلب استلام مؤكد", 82001, "sent"));
      await receive(page).click(); await waitForRequest(page, 1);
      expect((await requests(page))[1].requestBody).toBe(JSON.stringify({ status: "received" }));
      await finish(page, 1, 200, null); await waitForRequest(page, 2); await pending(page);
      expect(await booking(page).count()).toBe(0);
      await finish(page, 2, 500, { message: "فشل قراءة اصطناعي" });
      await booking(page).waitFor();
      const overlay = booking(page).locator("xpath=ancestor::div[contains(@class, 'fixed')][1]");
      expect(await overlay.getByText("طلب استلام مؤكد", { exact: true }).isVisible()).toBe(true);
      expect(await overlay.getByPlaceholder("ملاحظات الموعد...").inputValue()).toContain("طلب معمل #81001");
      expect(await section(page).getByRole("alert").textContent()).toBe(readError);
      expect(await listTitle(page).textContent()).toBe(title);
      expect((await requests(page)).filter((entry) => entry.method === "PATCH")).toHaveLength(1);
      await capture(page, width, "accepted-receipt-booking", { booking: booking(page), order: overlay.getByText("طلب استلام مؤكد", { exact: true }) });
      await overlay.getByRole("button", { name: "إغلاق", exact: true }).click();
      await booking(page).waitFor({ state: "hidden" }); await failed(page);
      await capture(page, width, "accepted-receipt-unavailable", { alert: section(page).getByRole("alert"), retry: retry(page) });
      await retry(page).click(); await waitForRequest(page, 3);
      await finish(page, 3, 200, payload("طلب استلام مؤكد"));
      await expect.poll(() => listTitle(page).textContent()).toBe(`${title} (1)`);
      expect((await requests(page)).filter((entry) => entry.method === "PATCH")).toHaveLength(1);
      f.assertIsolated();
    }, f.assertIsolated);
  });
});
