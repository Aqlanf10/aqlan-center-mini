import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page, type Route } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseUrl, harness } from "./_server";

// Actual built page with an isolated synthetic session. Recall reads and writes
// are intercepted before network dispatch; this is UI acceptance, not server
// authorization or persistence proof. No real patient records are read/written.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

type Pending = {
  method: string; path: string; query: string; body: unknown;
  finish: (status: number, payload: unknown) => void;
};
type FixtureWindow = Window & { __recallRefusal: Pending[] };
const json = (route: Route, payload: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
const feed = {
  weeks: 6,
  openPast: [{
    id: 81001, patientId: 82001, patientName: "مريض معلّق تجريبي", patientPhone: null,
    scheduledDate: "2026-10-01", scheduledTime: "09:00", doctorName: null, note: null, daysLate: 1,
  }],
  missed: [{
    kind: "missed", id: 81002, patientId: 82002,
    patientName: "مريض متغيّب تجريبي", patientPhone: null, referenceDate: "2026-10-01", note: null,
  }],
  lapsed: [{
    kind: "lapsed", id: 82003, patientId: 82003,
    patientName: "مريض منقطع تجريبي", patientPhone: null, referenceDate: "2026-01-01", note: null,
  }],
};
const emptyFeed = { weeks: 12, openPast: [], missed: [], lapsed: [] };
const refusal = "رفض تجريبي: تغيّرت حالة السجل. راجع البيانات ثم أعد المحاولة.";
const commands = [
  { name: "close_done", section: "مواعيد معلّقة", label: "تمّت", path: "/api/appointments/81001", method: "PATCH", body: { action: "close_done" } },
  { name: "close_no_show", section: "مواعيد معلّقة", label: "لم يحضر", path: "/api/appointments/81001", method: "PATCH", body: { action: "close_no_show" } },
  { name: "missed", section: "متغيّبون", label: "تمت المتابعة ✓", path: "/api/recall", method: "POST", body: { kind: "missed", id: 81002 } },
  { name: "lapsed", section: "منقطعون", label: "تمت المتابعة ✓", path: "/api/recall", method: "POST", body: { kind: "lapsed", id: 82003 } },
] as const;

async function fixture(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(baseUrl).origin) {
      unexpected.push(`external ${url.origin}`); await route.abort(); return;
    }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    if (request.method() === "GET") {
      switch (url.pathname) {
        case "/api/booking-requests": await json(route, []); return;
        case "/api/lab": await json(route, { late: 0 }); return;
        case "/api/messages": await json(route, { unread: 0, urgent: 0 }); return;
        case "/api/auth/me": await json(route, { username: "secadmin", role: "admin" }); return;
        case "/api/plans/proposals": await json(route, { proposals: [], followUpDays: 7 }); return;
      }
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    await route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ message: "Unmocked recall fixture request blocked" }) });
  });
  await page.addInitScript(() => {
    const requests: Pending[] = [];
    (window as unknown as FixtureWindow).__recallRefusal = requests;
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.href);
      if (url.origin !== window.location.origin
        || !["/api/recall", "/api/appointments/81001"].includes(url.pathname)) return originalFetch(input, init);
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>((yes) => { resolve = yes; });
      requests.push({
        method: init?.method ?? "GET", path: url.pathname, query: url.search,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        finish: (status, payload) => resolve({
          status, ok: status >= 200 && status < 300, json: async () => payload,
        } as Response),
      });
      return promise;
    }) as typeof window.fetch;
  });
  await page.goto(`${baseUrl}/recall`, { waitUntil: "networkidle" });
  await waitForRequest(page, 0);
  return { page, context, assertIsolated: () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); } };
}
async function waitForRequest(page: Page, index: number) {
  await expect.poll(() => page.evaluate((i) => Boolean((window as unknown as FixtureWindow).__recallRefusal[i]), index)).toBe(true);
}
async function finish(page: Page, index: number, payload: unknown, status = 200) {
  await page.evaluate(async ({ index, payload, status }) => {
    (window as unknown as FixtureWindow).__recallRefusal[index].finish(status, payload);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, { index, payload, status });
}
async function requestCount(page: Page) {
  return page.evaluate(() => (window as unknown as FixtureWindow).__recallRefusal.length);
}
async function requestDetails(page: Page, index: number) {
  return page.evaluate((i) => {
    const { method, path, query, body } = (window as unknown as FixtureWindow).__recallRefusal[i];
    return { method, path, query, body };
  }, index);
}
async function paintedBounds(locator: Locator) {
  await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  const evidence = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0);
    const sample = (box: DOMRect) => {
      const points = [
        [box.x + box.width / 2, box.y + box.height / 2],
        [box.x + box.width / 4, box.y + box.height / 4],
        [box.x + box.width * 3 / 4, box.y + box.height / 4],
        [box.x + box.width / 4, box.y + box.height * 3 / 4],
        [box.x + box.width * 3 / 4, box.y + box.height * 3 / 4],
      ];
      return { x: box.x, y: box.y, width: box.width, height: box.height,
        inViewport: box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
        points: points.map(([x, y]) => ({ x, y, owned: element.contains(document.elementFromPoint(x, y)) })) };
    };
    return { direction: getComputedStyle(document.documentElement).direction,
      viewport: { width: innerWidth, height: innerHeight }, element: sample(rect), text: rects.map(sample) };
  });
  expect(evidence.direction).toBe("rtl");
  expect(evidence.element.width).toBeGreaterThan(0);
  expect(evidence.element.height).toBeGreaterThan(0);
  expect(evidence.element.inViewport).toBe(true);
  expect(evidence.element.points.every((point) => point.owned)).toBe(true);
  expect(evidence.text.length).toBeGreaterThan(0);
  for (const rect of evidence.text) {
    expect(rect.inViewport).toBe(true);
    expect(rect.points.every((point) => point.owned)).toBe(true);
  }
  return evidence;
}

describe("built recall mutation refusal and explicit retry", () => {
  it.each([1280, 390].flatMap((width) => commands.map((command) => ({ width, command, name: command.name }))))(
    "preserves $name refusal through an unrelated read and permits explicit retry at $width",
    async ({ width, command }) => {
      const f = await fixture(width);
      try {
        await finish(f.page, 0, feed);
        const button = f.page.locator(`section[aria-label="${command.section}"]`).getByRole("button", { name: command.label, exact: true });
        await expect.poll(() => button.isVisible()).toBe(true);
        await button.click();
        await waitForRequest(f.page, 1);
        expect(await requestDetails(f.page, 1)).toEqual({
          method: command.method, path: command.path, query: "", body: command.body,
        });
        // A filter read begins independently while the command remains pending.
        await f.page.getByRole("button", { name: "أكثر من ٣ أشهر", exact: true }).click();
        await waitForRequest(f.page, 2);
        expect(await requestDetails(f.page, 2)).toEqual({ method: "GET", path: "/api/recall", query: "?weeks=12", body: null });
        await finish(f.page, 1, { message: refusal }, 409);
        await expect.poll(() => f.page.getByRole("alert").textContent()).toBe(refusal);
        await finish(f.page, 2, { ...feed, weeks: 12 });
        await expect.poll(() => button.isVisible()).toBe(true);
        expect(await f.page.getByRole("alert").textContent()).toBe(refusal);
        expect(await requestCount(f.page)).toBe(3);
        expect(await button.isEnabled()).toBe(true);
        expect(await f.page.getByText("✓ تم التواصل مع جميع المرضى ومتابعة كافة المواعيد بنجاح!", { exact: true }).count()).toBe(0);

        if (command.name === "close_done") {
          const output = ".settings-ui-artifacts";
          await mkdir(output, { recursive: true });
          const alertBounds = await paintedBounds(f.page.getByRole("alert"));
          await f.page.screenshot({ path: join(output, `recall-refusal-${width}.png`) });
          const retryBounds = await paintedBounds(button);
          await f.page.screenshot({ path: join(output, `recall-retry-${width}.png`) });
          await writeFile(join(output, `recall-refusal-${width}-bounds.json`),
            JSON.stringify({ alert: alertBounds, retry: retryBounds }, null, 2));
        }

        await button.click();
        await waitForRequest(f.page, 3);
        expect(await requestDetails(f.page, 3)).toEqual({
          method: command.method, path: command.path, query: "", body: command.body,
        });
        await finish(f.page, 3, { ok: true });
        await waitForRequest(f.page, 4);
        expect(await requestDetails(f.page, 4)).toEqual({ method: "GET", path: "/api/recall", query: "?weeks=12", body: null });
        expect(await button.isDisabled()).toBe(true);
        expect(await requestCount(f.page)).toBe(5);
        await finish(f.page, 4, emptyFeed);
        await expect.poll(() => f.page.getByText("✓ تم التواصل مع جميع المرضى ومتابعة كافة المواعيد بنجاح!", { exact: true }).isVisible()).toBe(true);
        expect(await f.page.getByRole("alert").count()).toBe(0);
        expect(await requestCount(f.page)).toBe(5);
        f.assertIsolated();
      } finally { await f.context.close(); }
    },
  );
});

