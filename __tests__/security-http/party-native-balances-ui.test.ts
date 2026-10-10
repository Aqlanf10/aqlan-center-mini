import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { authedGet, baseUrl, harness } from "./_server";
import type { PartyBalanceIdentity, PartyNativeBalance } from "@/lib/party-native-balances";
import { emitPartyNativeBalanceEvidence, type PartyNativeBalanceEvidenceMember } from "./_party-native-balance-evidence";

// Actual built page, existing isolated auth harness, intercepted synthetic DTOs.
// No financial fixture writers, Production records, or permission changes.
// Existing business assertions remain DOM-based. A separate paired witness emits
// bounded ready-state browser PNGs only after both contexts close successfully.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

describe("native party balance HTTP admission", () => {
  it("serves the native envelope with private no-store caching while preserving the legacy no-view response", async () => {
    const native = await authedGet("/api/payables?view=party-balances-v1", h.sessions.admin);
    expect(native.status).toBe(200);
    expect(native.headers.get("cache-control")).toContain("private");
    expect(native.headers.get("cache-control")).toContain("no-store");
    const payload = await native.json();
    expect(payload.view).toBe("party-balances-v1");
    expect(typeof payload.observedAt).toBe("string");
    expect(Number.isFinite(Date.parse(payload.observedAt))).toBe(true);
    expect(Array.isArray(payload.balancesByCurrency)).toBe(true);
    expect(Array.isArray(payload.partyIdentities)).toBe(true);
    expect(payload).not.toHaveProperty("balances");
    expect(payload).not.toHaveProperty("baseCurrency");
    const identities = new Map<number, { id: number; name: string; kind: string }>();
    for (const party of payload.partyIdentities) {
      expect(Number.isSafeInteger(party.id) && party.id > 0).toBe(true);
      expect(typeof party.name === "string" && party.name.trim().length > 0).toBe(true);
      expect(["lab", "supplier"]).toContain(party.kind);
      expect(identities.has(party.id)).toBe(false);
      identities.set(party.id, { id: party.id, name: party.name, kind: party.kind });
    }
    const seen = new Set<string>();
    for (const row of payload.balancesByCurrency) {
      expect(Number.isSafeInteger(row.partyId) && row.partyId > 0).toBe(true);
      expect(typeof row.name === "string" && row.name.trim().length > 0).toBe(true);
      expect(["lab", "supplier"]).toContain(row.kind);
      expect(["USD", "SAR", "YER"]).toContain(row.currency);
      expect(Number.isSafeInteger(row.dueMinor) && row.dueMinor !== 0).toBe(true);
      expect(identities.get(row.partyId)).toEqual({ id: row.partyId, name: row.name, kind: row.kind });
      const key = `${row.partyId}:${row.currency}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }

    const legacy = await authedGet("/api/payables", h.sessions.admin);
    expect(legacy.status).toBe(200);
    const legacyPayload = await legacy.json();
    expect(Array.isArray(legacyPayload.balances)).toBe(true);
    expect(legacyPayload.baseCurrency).toBe("YER");
    expect(legacyPayload).not.toHaveProperty("view");
    expect(legacyPayload).not.toHaveProperty("balancesByCurrency");
    expect(legacyPayload).not.toHaveProperty("partyIdentities");
  });

  it.each(["doctorA", "portalA"] as const)("denies the native money view to %s without financial data", async (role) => {
    const response = await authedGet("/api/payables?view=party-balances-v1", h.sessions[role]);
    expect([401, 403]).toContain(response.status);
    const body = await response.text();
    expect(body).not.toContain("balancesByCurrency");
    expect(body).not.toContain("partyIdentities");
  });
});

const parties = [
  { id: 910001, name: "مورد الدولار التجريبي", kind: "supplier", isActive: true },
  { id: 910002, name: "مورد السعودي التجريبي", kind: "supplier", isActive: true },
  { id: 910003, name: "مختبر اليمني التجريبي", kind: "lab", isActive: true },
  { id: 910004, name: "مورد العملات التجريبي", kind: "supplier", isActive: false },
  { id: 910005, name: "مورد الصافي الصفري التجريبي", kind: "supplier", isActive: true },
  { id: 910006, name: "طبيب العمولة التجريبي", kind: "doctor", isActive: true },
].map((party) => ({ ...party, phone: null, note: null, commissionPercent: party.kind === "doctor" ? 10 : 0 }));
const bucket = (index: number, currency: string, dueMinor: number) => ({
  partyId: parties[index].id, name: parties[index].name, kind: parties[index].kind, currency, dueMinor,
});
const full = {
  view: "party-balances-v1", observedAt: "2026-10-09T00:00:00.000Z",
  partyIdentities: parties.filter((party) => party.kind !== "doctor").map(({ id, name, kind }) => ({ id, name, kind })),
  balancesByCurrency: [
    bucket(0, "USD", 10000), bucket(1, "SAR", -37500), bucket(2, "YER", 50000),
    bucket(3, "USD", 10000), bucket(3, "SAR", -10000), bucket(3, "YER", 1200),
  ],
};
const zero = { ...full, balancesByCurrency: [] };
type SyntheticNativeSnapshot = {
  view: "party-balances-v1";
  observedAt: string;
  partyIdentities: PartyBalanceIdentity[];
  balancesByCurrency: (PartyNativeBalance & { partyId: number; name: string; kind: "lab" | "supplier" })[];
};
// Screenshot-only typed DTO. The existing business fixtures stay unchanged.
// 123,456,789,012 cents is a long, safe integer, not an actual financial record.
const evidenceSnapshot: SyntheticNativeSnapshot = {
  view: "party-balances-v1", observedAt: "2026-10-09T00:00:00.000Z",
  partyIdentities: [
    { id: 910001, name: parties[0].name, kind: "supplier" },
    { id: 910002, name: parties[1].name, kind: "supplier" },
    { id: 910003, name: parties[2].name, kind: "lab" },
    { id: 910004, name: parties[3].name, kind: "supplier" },
    { id: 910005, name: parties[4].name, kind: "supplier" },
  ],
  balancesByCurrency: [
    { partyId: 910001, name: parties[0].name, kind: "supplier", currency: "USD", dueMinor: 123456789012 },
    { partyId: 910002, name: parties[1].name, kind: "supplier", currency: "SAR", dueMinor: -37500 },
    { partyId: 910003, name: parties[2].name, kind: "lab", currency: "YER", dueMinor: 50000 },
    { partyId: 910004, name: parties[3].name, kind: "supplier", currency: "USD", dueMinor: 10000 },
    { partyId: 910004, name: parties[3].name, kind: "supplier", currency: "SAR", dueMinor: -10000 },
    { partyId: 910004, name: parties[3].name, kind: "supplier", currency: "YER", dueMinor: 1200 },
  ],
};
type Pending = {
  url: string; method: string; cache: RequestCache | undefined; bodyStarted: boolean;
  respond: (status: number) => void;
  body: (payload: unknown) => void;
  failFetch: () => void;
  failBody: () => void;
};
type FixtureWindow = Window & { __partyNativeReads: Pending[] };
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function fixture(width = 1280, role: "admin" | "accountant" = "admin") {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions[role].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const unexpected: string[] = [];
  const errors: string[] = [];
  const writes: string[] = [];
  const mutations: { method: string; path: string; body: unknown }[] = [];
  let allowPartyMutations = false;
  let currentParties = parties.map((party) => ({ ...party }));
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isRead = request.method() === "GET" || request.method() === "HEAD";
    if (!isRead) writes.push(`${request.method()} ${url.pathname}`);
    if (url.origin !== new URL(baseUrl).origin) {
      unexpected.push(`external ${url.origin}`); await route.abort(); return;
    }
    if (!url.pathname.startsWith("/api/")) {
      if (!isRead) { unexpected.push(`${request.method()} ${url.pathname}`); await route.abort(); return; }
      await route.continue(); return;
    }
    if (request.method() === "GET") {
      switch (url.pathname) {
        case "/api/parties": await json(route, currentParties); return;
        case "/api/booking-requests": await json(route, []); return;
        case "/api/lab": await json(route, { late: 0 }); return;
        case "/api/messages": await json(route, { unread: 0, urgent: 0 }); return;
        case "/api/auth/me": await json(route, { username: role === "admin" ? "secadmin" : "secaccountant", role }); return;
      }
    }
    if (allowPartyMutations && request.method() === "PATCH" && url.pathname === `/api/parties/${parties[3].id}`) {
      const body = request.postDataJSON() as { isActive: boolean };
      mutations.push({ method: request.method(), path: url.pathname, body });
      currentParties = currentParties.map((party) => party.id === parties[3].id ? { ...party, isActive: body.isActive } : party);
      await json(route, currentParties[3]); return;
    }
    unexpected.push(`${request.method()} ${url.pathname}${url.search}`);
    await json(route, { message: "Unmocked request blocked by native party fixture" }, 501);
  });
  await page.addInitScript(() => {
    const requests: Pending[] = [];
    (window as unknown as FixtureWindow).__partyNativeReads = requests;
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.origin !== window.location.origin || url.pathname !== "/api/payables"
        || url.search !== "?view=party-balances-v1" || method !== "GET") return originalFetch(input, init);
      let resolveResponse!: (response: Response) => void;
      let rejectResponse!: (error: Error) => void;
      let body!: (payload: unknown) => void;
      let rejectBody!: (error: Error) => void;
      const response = new Promise<Response>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
      const payload = new Promise<unknown>((resolve, reject) => { body = resolve; rejectBody = reject; });
      const record: Pending = {
        url: url.toString(), method, cache: init?.cache, bodyStarted: false, body,
        respond: (status) => resolveResponse({ ok: status >= 200 && status < 300, status,
          json: () => { record.bodyStarted = true; return payload; },
        } as Response),
        failFetch: () => rejectResponse(new TypeError("Synthetic native balance network failure")),
        failBody: () => rejectBody(new SyntaxError("Synthetic invalid native balance JSON")),
      };
      requests.push(record);
      // Deliberately ignore AbortSignal. A late response/body must still lose
      // to a newer load or component cleanup, independently of browser aborts.
      return response;
    }) as typeof window.fetch;
  });
  await page.goto(`${baseUrl}/finance/parties`, { waitUntil: "networkidle" });
  await waitForRequest(page, 0);
  return {
    page, context, mutations,
    setCatalog: (catalog: typeof parties) => { currentParties = catalog.map((party) => ({ ...party })); },
    enablePartyMutations: () => { allowPartyMutations = true; },
    assertIsolated: () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); },
    assertNoWrites: () => { expect(writes).toEqual([]); expect(mutations).toEqual([]); },
  };
}

async function waitForRequest(page: Page, index: number) {
  await expect.poll(() => page.evaluate((i) => Boolean((window as unknown as FixtureWindow).__partyNativeReads[i]), index)).toBe(true);
}
async function respond(page: Page, index: number, status = 200) {
  await page.evaluate(({ i, status }) => (window as unknown as FixtureWindow).__partyNativeReads[i].respond(status), { i: index, status });
}
async function body(page: Page, index: number, payload: unknown) {
  await page.evaluate(async ({ i, payload }) => {
    (window as unknown as FixtureWindow).__partyNativeReads[i].body(payload);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, { i: index, payload });
}
async function complete(page: Page, index: number, payload: unknown, status = 200) {
  await respond(page, index, status);
  await body(page, index, payload);
}
async function reload(page: Page, index: number) {
  await page.getByRole("button", { name: "تحديث أرصدة الجهات", exact: true }).click();
  await waitForRequest(page, index);
  await assertNoAmounts(page);
}
async function assertNoAmounts(page: Page) {
  await expect.poll(() => page.getByTestId("party-native-balance").count()).toBe(0);
  await expect.poll(() => page.getByTestId("party-native-zero").count()).toBe(0);
}
// Business alerts belong to this financial region. Next 16.3.8 also renders
// an accessibility route-announcer alert in a separate body-level shadow host.
const partyAlerts = (page: Page) => page.getByTestId("party-native-balances").getByRole("alert");
async function assertUnavailable(page: Page, expectedParties = 5) {
  await expect.poll(() => partyAlerts(page).count()).toBe(1);
  await expect.poll(() => partyAlerts(page).filter({ hasText: "الأرصدة غير متاحة الآن" }).count()).toBe(1);
  await assertNoAmounts(page);
  expect(await page.getByText("الرصيد غير متاح", { exact: true }).count()).toBe(expectedParties);
  expect(await page.getByRole("button", { name: "تحديث أرصدة الجهات", exact: true }).textContent()).toContain("إعادة المحاولة");
}

describe("built party list native balances", () => {
  it("captures paired ready native badges at 1280 and 390 only after both isolated read-only witnesses close", async () => {
    const captures: PartyNativeBalanceEvidenceMember[] = [];
    for (const width of [1280, 390] as const) {
      const f = await fixture(width);
      try {
        // Loading and unavailable are DOM assertions, not pictured evidence.
        await assertNoAmounts(f.page);
        expect(await f.page.getByTestId("party-native-balances").getByText("جارٍ التحميل…", { exact: true }).count()).toBe(1);
        await complete(f.page, 0, { message: "Synthetic unavailable before screenshot" }, 403);
        await assertUnavailable(f.page);
        await reload(f.page, 1);
        expect(await f.page.getByTestId("party-native-balances").getByText("جارٍ التحميل…", { exact: true }).count()).toBe(1);
        expect(evidenceSnapshot.balancesByCurrency.every(row => Number.isSafeInteger(row.dueMinor))).toBe(true);
        await complete(f.page, 1, evidenceSnapshot);
        await expect.poll(() => f.page.getByTestId("party-native-balance").count()).toBe(6);
        await f.page.evaluate(() => document.fonts.ready.then(() => undefined));
        // Keep the framework announcement intact while checking that this
        // financial view has actually cleared its own failed-read alert.
        const routeAnnouncer = f.page.locator("next-route-announcer").getByRole("alert");
        await expect.poll(() => routeAnnouncer.count()).toBe(1);
        expect(await f.page.getByTestId("party-native-balances").locator("next-route-announcer").count()).toBe(0);
        expect(await partyAlerts(f.page).count()).toBe(0);
        expect(await f.page.getByText("الرصيد غير متاح", { exact: true }).count()).toBe(0);
        expect(await f.page.getByTestId("party-native-balances").getByText("جارٍ التحميل…", { exact: true }).count()).toBe(0);
        expect(await f.page.getByTestId("party-row-910001").getByTestId("party-native-balance").textContent()).toBe("علينا 1,234,567,890.12 $ (USD)");
        expect(await f.page.getByTestId("party-row-910002").getByTestId("party-native-balance").textContent()).toBe("لنا 375.00 ر.س (SAR)");
        expect(await f.page.getByTestId("party-row-910003").getByTestId("party-native-balance").textContent()).toBe("علينا 50,000 ر.ي (YER)");
        expect(await f.page.getByTestId("party-row-910004").getByTestId("party-native-balance").allTextContents()).toEqual([
          "علينا 1,200 ر.ي (YER)", "لنا 100.00 ر.س (SAR)", "علينا 100.00 $ (USD)",
        ]);
        expect(await f.page.getByTestId("party-row-910004").getByRole("button", { name: "تفعيل", exact: true }).count()).toBe(1);
        expect(await f.page.getByTestId("party-row-910005").getByTestId("party-native-zero").textContent()).toBe("صافي الجهة صفر");
        expect(await f.page.getByTestId("party-native-zero").count()).toBe(1);
        expect(await f.page.getByTestId("party-row-910006").getByTestId("party-native-balance").count()).toBe(0);
        expect(await f.page.getByTestId("party-row-910006").getByText("عمولة 10%", { exact: true }).count()).toBe(1);
        const geometry = await f.page.getByTestId("party-native-balances").evaluate((main) => ({
          viewport: window.innerWidth, left: main.getBoundingClientRect().left, right: main.getBoundingClientRect().right,
          height: document.documentElement.scrollHeight,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          badges: [...main.querySelectorAll<HTMLElement>('[data-testid="party-native-balance"], [data-testid="party-native-zero"]')].map((badge) => {
            const rect = badge.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(badge);
            const style = getComputedStyle(badge);
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
              visible: style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0,
              text: [...range.getClientRects()].map(text => ({ left: text.left, right: text.right, top: text.top, bottom: text.bottom })),
            };
          }),
        }));
        expect(geometry.viewport).toBe(width);
        expect(geometry.overflow).toBe(false);
        expect(geometry.height).toBeLessThanOrEqual(5000);
        expect(geometry.badges).toHaveLength(7);
        for (const badge of geometry.badges) {
          expect(badge.visible).toBe(true);
          expect(badge.width).toBeGreaterThan(0);
          expect(badge.height).toBeGreaterThan(0);
          expect(badge.left).toBeGreaterThanOrEqual(Math.max(0, geometry.left));
          expect(badge.right).toBeLessThanOrEqual(Math.min(geometry.right, geometry.viewport));
          expect(badge.top).toBeGreaterThanOrEqual(0);
          expect(badge.bottom).toBeLessThanOrEqual(geometry.height);
          expect(badge.text.length).toBeGreaterThan(0);
          for (const text of badge.text) {
            expect(text.left).toBeGreaterThanOrEqual(badge.left);
            expect(text.right).toBeLessThanOrEqual(badge.right);
            expect(text.top).toBeGreaterThanOrEqual(badge.top);
            expect(text.bottom).toBeLessThanOrEqual(badge.bottom);
          }
        }
        expect(await f.page.evaluate(() => (window as unknown as FixtureWindow).__partyNativeReads.map(({ method, cache }) => ({ method, cache })))).toEqual([
          { method: "GET", cache: "no-store" }, { method: "GET", cache: "no-store" },
        ]);
        f.assertIsolated();
        f.assertNoWrites();
        // Actual full-page browser return, no paths, masks, styles or image edits.
        const bytes = await f.page.screenshot({ type: "png", fullPage: true });
        expect(await f.page.getByTestId("party-native-balance").count()).toBe(6);
        expect(await f.page.getByTestId("party-native-zero").count()).toBe(1);
        f.assertIsolated();
        f.assertNoWrites();
        captures.push({ filename: width === 1280 ? "party-native-balances-desktop-1280.png" : "party-native-balances-mobile-390.png",
          mime: "image/png", bytes });
      } finally { await f.context.close(); }
      // Include requests/errors observed during teardown in the witness gate.
      f.assertIsolated();
      f.assertNoWrites();
    }
    // Neither viewport emits on its own. Any assertion/capture/close failure
    // above prevents this sole call; frames describe only this paired witness.
    emitPartyNativeBalanceEvidence(captures);
  });

  it.each([1280, 390])("shows USD/SAR/YER separately, including mixed signs, inactive and zero parties at width %s", async (width) => {
    const f = await fixture(width);
    try {
      await assertNoAmounts(f.page);
      // Extra legacy fields must never be chosen over the versioned buckets.
      await complete(f.page, 0, { ...full, baseCurrency: "YER", balances: [{ partyId: parties[0].id, dueMinor: 999999999 }] });
      await expect.poll(() => f.page.getByTestId("party-native-balance").count()).toBe(6);
      expect(await f.page.getByTestId("party-row-910001").getByTestId("party-native-balance").textContent()).toBe("علينا 100.00 $ (USD)");
      expect(await f.page.getByTestId("party-row-910002").getByTestId("party-native-balance").textContent()).toBe("لنا 375.00 ر.س (SAR)");
      expect(await f.page.getByTestId("party-row-910003").getByTestId("party-native-balance").textContent()).toBe("علينا 50,000 ر.ي (YER)");
      expect(await f.page.getByTestId("party-row-910004").getByTestId("party-native-balance").allTextContents()).toEqual([
        "علينا 1,200 ر.ي (YER)", "لنا 100.00 ر.س (SAR)", "علينا 100.00 $ (USD)",
      ]);
      expect(await f.page.getByTestId("party-row-910004").getByRole("button", { name: "تفعيل", exact: true }).count()).toBe(1);
      expect(await f.page.getByTestId("party-row-910005").getByTestId("party-native-zero").textContent()).toBe("صافي الجهة صفر");
      expect(await f.page.getByTestId("party-row-910006").getByTestId("party-native-balance").count()).toBe(0);
      expect(await f.page.getByTestId("party-row-910006").getByText("عمولة 10%", { exact: true }).count()).toBe(1);
      expect(await f.page.getByText("صافي الجهة بكل عملة على حدة، ويشمل الدفعات على الحساب غير المرتبطة بفاتورة. صافي الصفر لا يعني تسوية كل فاتورة.", { exact: true }).count()).toBe(1);
      expect(await f.page.getByTestId("party-native-balances").textContent()).not.toContain("999,999,999");
      const geometry = await f.page.getByTestId("party-native-balances").evaluate((main) => ({
        viewport: window.innerWidth, right: main.getBoundingClientRect().right, left: main.getBoundingClientRect().left,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        badges: [...main.querySelectorAll('[data-testid="party-native-balance"]')].map((badge) => {
          const rect = badge.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width };
        }),
      }));
      expect(geometry.overflow).toBe(false);
      for (const badge of geometry.badges) {
        expect(badge.width).toBeGreaterThan(0);
        expect(badge.left).toBeGreaterThanOrEqual(geometry.left);
        expect(badge.right).toBeLessThanOrEqual(Math.min(geometry.right, geometry.viewport));
      }
      expect(await f.page.evaluate(() => (window as unknown as FixtureWindow).__partyNativeReads[0].cache)).toBe("no-store");
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("accepts an authoritative zero snapshot and keeps the accountant view read-only", async () => {
    const f = await fixture(390, "accountant");
    try {
      await complete(f.page, 0, zero);
      await expect.poll(() => f.page.getByTestId("party-native-zero").count()).toBe(5);
      expect(await f.page.getByTestId("party-native-balance").count()).toBe(0);
      expect(await f.page.getByRole("button", { name: /^(أضف|إيقاف|تفعيل)$/ }).count()).toBe(0);
      expect(await partyAlerts(f.page).count()).toBe(0);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("rejects a native snapshot missing a newly created zero-activity party and recovers after complete coverage matches", async () => {
    const f = await fixture();
    try {
      // The catalog contains party 910005. The earlier native snapshot lacks
      // that identity even though both native snapshots have zero money rows.
      await complete(f.page, 0, { ...zero, partyIdentities: zero.partyIdentities.filter((party) => party.id !== 910005) });
      await assertUnavailable(f.page);
      expect(await f.page.getByTestId("party-row-910005").getByText("الرصيد غير متاح", { exact: true }).count()).toBe(1);
      await reload(f.page, 1);
      await complete(f.page, 1, zero);
      await expect.poll(() => f.page.getByTestId("party-native-zero").count()).toBe(5);
      expect(await f.page.getByTestId("party-row-910005").getByTestId("party-native-zero").count()).toBe(1);
      expect(await partyAlerts(f.page).count()).toBe(0);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("rejects a native snapshot retaining a deleted zero-activity party, then admits matching zero and complete empty coverage", async () => {
    const f = await fixture();
    try {
      await complete(f.page, 0, zero);
      await expect.poll(() => f.page.getByTestId("party-native-zero").count()).toBe(5);
      f.setCatalog(parties.filter((party) => party.id !== 910005));
      await reload(f.page, 1);
      await complete(f.page, 1, zero);
      await assertUnavailable(f.page, 4);
      expect(await f.page.getByTestId("party-row-910005").count()).toBe(0);
      await reload(f.page, 2);
      await complete(f.page, 2, { ...zero, partyIdentities: zero.partyIdentities.filter((party) => party.id !== 910005) });
      await expect.poll(() => f.page.getByTestId("party-native-zero").count()).toBe(4);
      expect(await partyAlerts(f.page).count()).toBe(0);

      f.setCatalog([]);
      await reload(f.page, 3);
      await complete(f.page, 3, { ...zero, partyIdentities: [] });
      await expect.poll(() => f.page.getByText("لا جهات بعد. أضف مختبراتك وأطباءك أولًا.", { exact: true }).count()).toBe(1);
      await assertNoAmounts(f.page);
      expect(await partyAlerts(f.page).count()).toBe(0);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it.each([401, 403, 500])("removes loaded values on reload and shows unavailable, never zero, after HTTP %s", async (status) => {
    const f = await fixture();
    try {
      await complete(f.page, 0, full);
      await expect.poll(() => f.page.getByTestId("party-native-balance").count()).toBe(6);
      await reload(f.page, 1);
      await complete(f.page, 1, { message: "Synthetic unavailable" }, status);
      await assertUnavailable(f.page);
      await reload(f.page, 2);
      await complete(f.page, 2, zero);
      await expect.poll(() => f.page.getByTestId("party-native-zero").count()).toBe(5);
      expect(await partyAlerts(f.page).count()).toBe(0);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("rejects malformed, duplicate and mismatched responses without a base fallback", async () => {
    const f = await fixture();
    try {
      const malformed = [
        { balances: [{ partyId: 910001, dueMinor: 10000 }], baseCurrency: "YER" },
        { ...full, balancesByCurrency: null },
        { ...full, partyIdentities: undefined },
        { ...zero, partyIdentities: [...zero.partyIdentities, zero.partyIdentities[0]] },
        { ...zero, partyIdentities: zero.partyIdentities.map((party) => party.id === 910005 ? { ...party, name: "اسم قديم" } : party) },
        { ...full, balancesByCurrency: [full.balancesByCurrency[0], full.balancesByCurrency[0]] },
        { ...full, balancesByCurrency: [bucket(0, "EUR", 10000)] },
        { ...full, balancesByCurrency: [{ ...bucket(0, "USD", 10000), dueMinor: "10000" }] },
        { ...full, balancesByCurrency: [{ ...bucket(0, "USD", 10000), name: "اسم لا يطابق الجهة" }] },
      ];
      for (const [index, payload] of malformed.entries()) {
        if (index > 0) await reload(f.page, index);
        await complete(f.page, index, payload);
        await assertUnavailable(f.page);
      }
      await reload(f.page, malformed.length);
      await complete(f.page, malformed.length, full);
      await expect.poll(() => f.page.getByTestId("party-native-balance").count()).toBe(6);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("contains network and JSON failures and recovers through retry", async () => {
    const f = await fixture();
    try {
      await f.page.evaluate(() => (window as unknown as FixtureWindow).__partyNativeReads[0].failFetch());
      await assertUnavailable(f.page);
      await reload(f.page, 1);
      await respond(f.page, 1);
      await expect.poll(() => f.page.evaluate(() => (window as unknown as FixtureWindow).__partyNativeReads[1].bodyStarted)).toBe(true);
      await f.page.evaluate(() => (window as unknown as FixtureWindow).__partyNativeReads[1].failBody());
      await assertUnavailable(f.page);
      await reload(f.page, 2);
      await complete(f.page, 2, full);
      await expect.poll(() => f.page.getByTestId("party-native-balance").count()).toBe(6);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("ignores old headers and late JSON after a newer failure, then ignores them after a newer zero success", async () => {
    const f = await fixture();
    try {
      await respond(f.page, 0);
      await expect.poll(() => f.page.evaluate(() => (window as unknown as FixtureWindow).__partyNativeReads[0].bodyStarted)).toBe(true);
      await reload(f.page, 1);
      await reload(f.page, 2);
      await complete(f.page, 2, { message: "Synthetic forbidden" }, 403);
      await assertUnavailable(f.page);
      await body(f.page, 0, full);
      await complete(f.page, 1, full);
      await assertUnavailable(f.page);

      await reload(f.page, 3);
      await respond(f.page, 3);
      await expect.poll(() => f.page.evaluate(() => (window as unknown as FixtureWindow).__partyNativeReads[3].bodyStarted)).toBe(true);
      await reload(f.page, 4);
      await complete(f.page, 4, zero);
      await expect.poll(() => f.page.getByTestId("party-native-zero").count()).toBe(5);
      await body(f.page, 3, full);
      expect(await f.page.getByTestId("party-native-zero").count()).toBe(5);
      expect(await f.page.getByTestId("party-native-balance").count()).toBe(0);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("keeps the party activation request intact and clears balances while its reload is pending", async () => {
    const f = await fixture();
    try {
      f.enablePartyMutations();
      await complete(f.page, 0, full);
      await expect.poll(() => f.page.getByTestId("party-native-balance").count()).toBe(6);
      await f.page.getByTestId("party-row-910004").getByRole("button", { name: "تفعيل", exact: true }).click();
      await waitForRequest(f.page, 1);
      await assertNoAmounts(f.page);
      await complete(f.page, 1, zero);
      await expect.poll(() => f.page.getByTestId("party-native-zero").count()).toBe(5);
      expect(await f.page.getByTestId("party-row-910004").getByRole("button", { name: "إيقاف", exact: true }).isEnabled()).toBe(true);
      expect(f.mutations).toEqual([{ method: "PATCH", path: "/api/parties/910004", body: { isActive: true } }]);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });
});
