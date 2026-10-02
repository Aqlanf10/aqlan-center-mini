import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { baseUrl, harness } from "./_server";

// CI-only built-app coverage. The existing isolated HTTP harness supplies a
// synthetic reception session. Every page API request is fulfilled or blocked
// locally by this fixture; patient/appointment writes never reach the server.
// Patient search response headers and bodies are independently deferred below.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

type Patient = { id: number; fullName: string; patientNumber: string; phone: null };
const alice: Patient = { id: 91001, fullName: "أليس تجريبية", patientNumber: "SEARCH-SYNTHETIC-A", phone: null };
const bob: Patient = { id: 91002, fullName: "بوب تجريبي", patientNumber: "SEARCH-SYNTHETIC-B", phone: null };
type SearchRequest = {
  query: string;
  bodyStarted: boolean;
  resolveResponse: () => void;
  resolveBody: (patients: Patient[]) => void;
};
type SearchWindow = Window & { __quickPatientSearch: SearchRequest[] };
const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status, contentType: "application/json", body: JSON.stringify(body),
});

async function fixture(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const patientWrites: unknown[] = [];
  const appointmentWrites: unknown[] = [];
  const unexpected: string[] = [];
  // Block external requests and unexpected mutations instead of allowing a
  // fixture error to fall through to real APIs. Same-origin assets/page loads
  // still use the real built Next application from the isolated CI harness.
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(baseUrl).origin) {
      unexpected.push(`external ${url.origin}`);
      await route.abort();
      return;
    }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    if (request.method() === "POST" && url.pathname === "/api/patients") {
      patientWrites.push(request.postDataJSON());
      await json(route, { id: 91999 }, 201);
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/appointments") {
      appointmentWrites.push(request.postDataJSON());
      await json(route, { id: 92999 }, 201);
      return;
    }
    if (request.method() === "GET") {
      switch (url.pathname) {
        case "/api/parties":
        case "/api/appointments":
        case "/api/booking-requests": await json(route, []); return;
        case "/api/settings/appointment-services": await json(route, { services: [], chairs: 0 }); return;
        case "/api/appointments/availability": await json(route, { slots: [] }); return;
        case "/api/lab": await json(route, { late: 0 }); return;
        case "/api/messages": await json(route, { unread: 0, urgent: 0 }); return;
        case "/api/auth/me": await json(route, { username: "secreception", role: "reception" }); return;
      }
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    await json(route, { message: "Unmocked request blocked by patient-search fixture" }, 501);
  });
  await page.addInitScript(() => {
    const requests: SearchRequest[] = [];
    (window as unknown as SearchWindow).__quickPatientSearch = requests;
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.origin !== window.location.origin || url.pathname !== "/api/patients" || !url.searchParams.has("q") || method !== "GET") {
        return originalFetch(input, init);
      }
      let resolveResponse!: (response: Response) => void;
      let resolveBody!: (patients: Patient[]) => void;
      const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
      const body = new Promise<Patient[]>((resolve) => { resolveBody = resolve; });
      const record: SearchRequest = {
        query: url.searchParams.get("q")!, bodyStarted: false,
        resolveBody,
        resolveResponse: () => resolveResponse({
          ok: true, status: 200,
          json: () => { record.bodyStarted = true; return body; },
        } as Response),
      };
      requests.push(record);
      // Deliberately ignore AbortSignal: this exercises completion guards even
      // when cancellation races with a response/body that is already available.
      return response;
    }) as typeof window.fetch;
  });
  await page.goto(`${baseUrl}/appointments`, { waitUntil: "networkidle" });
  const open = () => page.getByRole("button", { name: /حجز موعد جديد/ }).click();
  await open();
  const dialog = page.getByRole("dialog");
  const query = dialog.getByLabel("المريض", { exact: true });
  const choices = dialog.locator("li > button");
  const submit = dialog.locator('button[type="submit"]');
  const assertIsolated = () => expect(unexpected).toEqual([]);
  return { context, page, open, dialog, query, choices, submit, patientWrites, appointmentWrites, assertIsolated };
}

async function expectSearch(page: Page, index: number, query: string) {
  await expect.poll(() => page.evaluate((i) => (window as unknown as SearchWindow).__quickPatientSearch[i]?.query, index)).toBe(query);
}
async function respond(page: Page, index: number) {
  await page.evaluate((i) => (window as unknown as SearchWindow).__quickPatientSearch[i].resolveResponse(), index);
  await expect.poll(() => page.evaluate((i) => (window as unknown as SearchWindow).__quickPatientSearch[i].bodyStarted, index)).toBe(true);
}
async function body(page: Page, index: number, patients: Patient[]) {
  await page.evaluate(async ({ i, matches }) => {
    (window as unknown as SearchWindow).__quickPatientSearch[i].resolveBody(matches);
    // Flush promise continuations and React's next visible commit before making
    // a negative assertion about stale results. No arbitrary timeout is needed.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, { i: index, matches: patients });
}

describe("quick booking patient search tracks the current query and open session", () => {
  it.each([1280, 390])("keeps the latest choice after an older body resolves and books its explicit selection at %i px", async (width) => {
    const f = await fixture(width);
    try {
      await f.query.fill("اسم قديم");
      await expectSearch(f.page, 0, "اسم قديم");
      await respond(f.page, 0); // Headers arrived; old JSON remains pending.
      await f.query.fill(bob.fullName);
      await expectSearch(f.page, 1, bob.fullName);
      await respond(f.page, 1);
      await body(f.page, 1, [bob]);
      await expect.poll(() => f.choices.allTextContents()).toEqual([expect.stringContaining(bob.patientNumber)]);
      await body(f.page, 0, []);
      expect(await f.choices.allTextContents()).toEqual([expect.stringContaining(bob.patientNumber)]);
      await f.dialog.getByRole("button", { name: new RegExp(bob.patientNumber) }).click();
      expect(await f.dialog.getByRole("heading").textContent()).toContain(bob.fullName);
      await f.submit.click();
      await expect.poll(() => f.appointmentWrites.length).toBe(1);
      expect(f.patientWrites).toEqual([]);
      expect(f.appointmentWrites[0]).toMatchObject({ patientId: bob.id, isNewPatient: false });
      await expect.poll(() => f.dialog.count()).toBe(0);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("removes old choices on an edit and never restores a late body after clear", async () => {
    const f = await fixture();
    try {
      await f.query.fill(alice.fullName);
      await expectSearch(f.page, 0, alice.fullName);
      await respond(f.page, 0);
      await body(f.page, 0, [alice]);
      await expect.poll(() => f.choices.count()).toBe(1);
      await f.query.fill(bob.fullName);
      await expect.poll(() => f.choices.count()).toBe(0);
      await expectSearch(f.page, 1, bob.fullName);
      await respond(f.page, 1);
      await f.query.fill("");
      await body(f.page, 1, [bob]);
      expect(await f.query.inputValue()).toBe("");
      expect(await f.choices.count()).toBe(0);
      expect(f.patientWrites).toEqual([]);
      expect(f.appointmentWrites).toEqual([]);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("ignores the previous session's body and refreshes a retained query after cancel/reopen", async () => {
    const f = await fixture();
    try {
      await f.query.fill(alice.fullName);
      await expectSearch(f.page, 0, alice.fullName);
      await respond(f.page, 0);
      await f.dialog.getByRole("button", { name: "إلغاء", exact: true }).click();
      await expect.poll(() => f.dialog.count()).toBe(0);
      await body(f.page, 0, [alice]);
      await f.open();
      expect(await f.query.inputValue()).toBe(alice.fullName);
      expect(await f.choices.count()).toBe(0); // Only until the fresh query resolves.
      await expectSearch(f.page, 1, alice.fullName);
      await respond(f.page, 1);
      await body(f.page, 1, [alice]);
      await expect.poll(() => f.choices.allTextContents()).toEqual([expect.stringContaining(alice.patientNumber)]);
      await f.dialog.getByRole("button", { name: new RegExp(alice.patientNumber) }).click();
      expect(await f.dialog.getByRole("heading").textContent()).toContain(alice.fullName);
      expect(f.patientWrites).toEqual([]);
      expect(f.appointmentWrites).toEqual([]);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });
});
