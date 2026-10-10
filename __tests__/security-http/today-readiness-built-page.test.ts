import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import type { Visit } from "../../lib/flow";
import type { VisitReadiness } from "../../components/today/useChairReadiness";
import { clearanceGate, normalizeEmergencyReason, CLEARANCE_WARNING, CLEARANCE_REQUIRED_MESSAGE } from "../../lib/chair-readiness";

// Actual built Today page/CSS, existing synthetic security-harness session.
// Every visit/readiness response is synthetic. All writes are intercepted and
// require an exact per-click permit; none reaches a clinical route/database.
let h: Awaited<ReturnType<typeof harness>>, browser: Browser;
const FIRST = "مريض اليوم الأول الاصطناعي", SECOND = "مريض اليوم الثاني الاصطناعي";
const RELINKED = "ملف اليوم المعاد ربطه اصطناعياً";
const EMERGENCY = "مريض انتظار طارئ اصطناعي جديد";
const OLD_WARNING = "تحذير سابق اصطناعي للمريض الأول";
const NEW_WARNING = "تحذير اصطناعي للملف الصحيح";
const REASON = "حالة طارئة اصطناعية لاختبار التجاوز";
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); });
const row = (page: Page, name: string) => page.locator("li").filter({ has: page.getByText(name, { exact: true }) });
const focusReadiness = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));
async function revealChecklist(visit: Locator) {
  const details = visit.locator("details");
  await expect.poll(() => details.count()).toBe(1);
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
}
async function geometry(locator: Locator) {
  return locator.evaluate(element => {
    const r = element.getBoundingClientRect();
    const points = [[.2, .2], [.8, .2], [.2, .8], [.8, .8], [.5, .5]];
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
      viewportWidth: innerWidth, viewportHeight: innerHeight, direction: getComputedStyle(element).direction,
      noOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
      clear: points.map(([x, y]) => {
        const target = document.elementFromPoint(r.left + r.width * x, r.top + r.height * y);
        return target !== null && (target === element || element.contains(target));
      }) };
  });
}
function assertBounds(bounds: Awaited<ReturnType<typeof geometry>>, target: boolean) {
  expect(bounds.left).toBeGreaterThanOrEqual(-1); expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth + 1);
  expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
  expect(bounds.direction).toBe("rtl"); expect(bounds.noOverflow).toBe(true); expect(bounds.clear.every(Boolean)).toBe(true);
  if (target) { expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44); }
}
declare global { interface Window { __todayBuiltRetainedRetry?: () => unknown } }
async function captureRetry(retry: Locator) {
  await retry.evaluate(element => {
    const key = Object.getOwnPropertyNames(element).find(name => name.startsWith("__reactProps$"));
    const props = key ? (element as unknown as Record<string, unknown>)[key] : null;
    const handler = props && typeof props === "object" ? (props as Record<string, unknown>).onClick : null;
    if (typeof handler !== "function") throw new Error("Missing actual committed retry callback");
    window.__todayBuiltRetainedRetry = handler as () => unknown;
  });
}
describe("Today readiness on the built RTL board", () => {
  it.each([1280, 390])("at %ipx preserves patient/owner freshness and ordinary movement/override policy", async width => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 },
      locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const unexpected: string[] = [], errors: string[] = [], repeatedPrompts: string[] = [];
    const writes: Array<{ path: string; body: unknown }> = [];
    const permits: Array<{ path: string; body: unknown }> = [];
    const held: Array<{ release: () => void; finished: Promise<void> }> = [];
    let readinessCount = 0, mode: "ready" | "failed" | "denied" = "ready", holdNext = false, gateOn = false;
    const arrivedAt = new Date().toISOString();
    const visits: Visit[] = [
      { id: 701, patientId: 91, patientName: FIRST, patientPhone: null, note: null, status: "waiting",
        chair: null, arrivedAt, calledAt: null, seatedAt: null, finishedAt: null },
      { id: 702, patientId: 92, patientName: SECOND, patientPhone: null, note: null, status: "called",
        chair: 1, arrivedAt, calledAt: arrivedAt, seatedAt: null, finishedAt: null },
    ];
    const readiness = (): { items: VisitReadiness[]; requireClearance: boolean } => ({
      requireClearance: gateOn, items: visits.map(visit => {
        const warning = visit.patientId === 91 ? OLD_WARNING : visit.id === 701 ? NEW_WARNING : "تحذير المريض المنادى اصطناعياً";
        return { visitId: visit.id, patientId: visit.patientId, status: visit.status, chair: visit.chair,
          arrivedAt, seatedAt: visit.seatedAt, signedAt: null, cleared: null,
          checklist: [{ key: "alerts", state: "attention", label: warning }], attention: 1,
          alerts: [warning], historyAlerts: [], editableAlert: warning,
          balances: [{ currency: "SAR", dueMinor: 900_000, warn: true }] };
      }),
    });
    const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin !== baseUrl) { unexpected.push(method + " " + url.origin + url.pathname); await route.abort(); return; }
      if (method !== "GET" && method !== "HEAD") {
        const body: unknown = request.postDataJSON(), permit = permits.shift();
        const actual = { path: url.pathname, body };
        if (method !== "PATCH" || !permit || JSON.stringify(permit) !== JSON.stringify(actual)) {
          unexpected.push(method + " " + url.pathname + " without exact permit"); await route.abort(); return;
        }
        writes.push(actual);
        const command = body as { action: string; chair: number; emergency?: boolean; emergencyReason?: string };
        const index = visits.findIndex(visit => url.pathname === "/api/visits/" + visit.id);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(["call", "seat"]).toContain(command.action);
        // Use the unchanged pure producer policy, including called→seat's
        // exemption from a second emergency prompt.
        const decision = clearanceGate({ cleared: false, requireClearance: gateOn,
          action: command.action as "call" | "seat", fromStatus: visits[index].status,
          emergency: command.emergency === true, emergencyReason: normalizeEmergencyReason(command.emergencyReason) });
        if (!decision.allow) {
          await route.fulfill({ status: 409, json: { code: decision.code, message: decision.message } }); return;
        }
        if (decision.bypass) expect(command.emergencyReason).toBe(REASON);
        visits[index] = { ...visits[index], status: command.action === "call" ? "called" : "in_chair", chair: command.chair,
          calledAt: arrivedAt, seatedAt: command.action === "seat" ? arrivedAt : null };
        await route.fulfill({ json: { ...visits[index], warning: decision.warning } });
        return;
      }
      if (url.pathname === "/api/visits" && !url.search) { await route.fulfill({ json: visits }); return; }
      if (url.pathname === "/api/visits" && url.search === "?view=reception-handoff") {
        await route.fulfill({ json: { owner: { username: "secadmin", role: "admin" }, fromDate: "2026-10-08", toDate: "2026-10-09", clinicTimeZone: "Asia/Aden", items: [] } }); return;
      }
      if (url.pathname === "/api/visits/readiness" && !url.search) {
        readinessCount++;
        const status = mode === "failed" ? 503 : mode === "denied" ? 403 : 200;
        const body = status === 200 ? readiness() : { message: "قراءة جاهزية اصطناعية غير متاحة" };
        if (holdNext) {
          holdNext = false;
          let release!: () => void, finish!: () => void;
          const released = new Promise<void>(resolve => { release = resolve; });
          const finished = new Promise<void>(resolve => { finish = resolve; });
          held.push({ release, finished }); await released;
          try { await route.fulfill({ status, json: body }); } finally { finish(); }
          return;
        }
        await route.fulfill({ status, json: body }); return;
      }
      if (url.pathname === "/api/appointments" || url.pathname === "/api/parties"
        || url.pathname === "/api/booking-requests") { await route.fulfill({ json: [] }); return; }
      if (url.pathname === "/api/display/notice") { await route.fulfill({ json: { on: false } }); return; }
      if (url.pathname === "/api/lab") { await route.fulfill({ json: { late: 0 } }); return; }
      if (url.pathname === "/api/messages") { await route.fulfill({ json: { unread: 0, urgent: 0 } }); return; }
      if (url.pathname.startsWith("/api/")) { unexpected.push(method + " " + url.pathname); await route.abort(); return; }
      // Existing ClinicLogo asset only; queries, other methods and off-origin
      // requests still reach their rejection paths.
      if (method === "GET" && url.pathname === "/logo.png" && url.search === "") {
        await route.continue(); return;
      }
      // Original built page, its same-origin assets, and harmless metadata only.
      if (url.pathname === "/" || url.pathname.startsWith("/_next/") ||
        ["/favicon.ico", "/icon.png", "/apple-icon.png", "/manifest.webmanifest", "/sw.js"].includes(url.pathname)) {
        await route.continue(); return;
      }
      unexpected.push(method + " " + url.pathname); await route.abort();
    });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await guard.run(async () => {
      try {
        await page.clock.install();
        await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
        await expect.poll(() => row(page, FIRST).count()).toBe(1);
        await expect.poll(() => row(page, FIRST).innerText()).toContain("عليه");
        expect(await row(page, SECOND).innerText()).toContain("عليه");
        expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
        expect(writes).toEqual([]);

        mode = "failed"; await focusReadiness(page);
        await expect.poll(() => row(page, FIRST).innerText()).toContain("الجاهزية غير متاحة");
        const waiting = row(page, FIRST), called = row(page, SECOND);
        for (const item of [waiting, called]) {
          expect(await item.innerText()).toContain("آخر تنبيه محفوظ");
          expect(await item.innerText()).not.toContain("عليه");
          expect(await item.innerText()).not.toContain("جاهز ✓");
          expect(await item.getByRole("button", { name: "أقِرّ الجاهزية", exact: true }).count()).toBe(0);
        }
        expect(await called.getByRole("button", { name: "دخل الكرسي", exact: true }).isEnabled()).toBe(true);
        expect(await waiting.getByRole("button", { name: /^نادِ · كرسي/ })
          .evaluateAll(buttons => buttons.some(button => !(button as HTMLButtonElement).disabled))).toBe(true);
        const retry = waiting.getByRole("button", { name: "أعد التحقق", exact: true });
        await captureRetry(retry); await retry.scrollIntoViewIfNeeded();
        const warning = waiting.getByText("آخر تنبيه محفوظ: " + OLD_WARNING, { exact: true });
        const notice = waiting.getByRole("status");
        const bounds = { width, retry: await geometry(retry), warning: await geometry(warning), notice: await geometry(notice) };
        assertBounds(bounds.retry, true); assertBounds(bounds.warning, false); assertBounds(bounds.notice, false);
        await writeFile(".settings-ui-artifacts/today-readiness-" + width + "-bounds.json", JSON.stringify(bounds, null, 2) + "\n");
        await page.screenshot({ path: ".settings-ui-artifacts/today-readiness-" + width + ".png", fullPage: false });

        mode = "ready"; await retry.focus(); await page.keyboard.press("Enter");
        await expect.poll(() => waiting.innerText()).toContain("عليه");
        // Hold an old patient response across the actual board poll/relink.
        holdNext = true; await focusReadiness(page);
        await expect.poll(() => held.length).toBe(1);
        expect(await waiting.innerText()).toContain("قيد التحقق");
        expect(await waiting.innerText()).not.toContain("عليه");
        visits[0] = { ...visits[0], patientId: 93, patientName: RELINKED };
        await page.clock.fastForward(20_001);
        await expect.poll(() => row(page, RELINKED).count()).toBe(1);
        await expect.poll(() => row(page, RELINKED).innerText()).toContain("عليه");
        await revealChecklist(row(page, RELINKED));
        expect(await row(page, RELINKED).innerText()).toContain(NEW_WARNING);
        expect(await row(page, RELINKED).innerText()).not.toContain(OLD_WARNING);
        const late = held.splice(0); late.forEach(read => read.release());
        await Promise.all(late.map(read => read.finished));
        await page.evaluate(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
        await revealChecklist(row(page, RELINKED));
        expect(await row(page, RELINKED).innerText()).toContain(NEW_WARNING);
        expect(await row(page, RELINKED).innerText()).toContain("عليه");
        expect(await row(page, RELINKED).innerText()).not.toContain(OLD_WARNING);
        const count = readinessCount;
        await page.evaluate(() => { if (!window.__todayBuiltRetainedRetry) throw new Error("Missing retained retry"); void window.__todayBuiltRetainedRetry(); });
        await page.evaluate(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
        expect(readinessCount).toBe(count);

        mode = "denied"; await focusReadiness(page);
        await expect.poll(() => row(page, RELINKED).innerText()).toContain("الجاهزية غير متاحة");
        expect(await row(page, RELINKED).innerText()).not.toContain(NEW_WARNING);
        expect(await row(page, RELINKED).innerText()).not.toContain("عليه");
        mode = "ready"; await row(page, RELINKED).getByRole("button", { name: "أعد التحقق", exact: true }).click();
        await expect.poll(() => row(page, RELINKED).innerText()).toContain("عليه");

        // Gate-off call remains available with debt and no clearance.
        const call = row(page, RELINKED).getByRole("button", { name: /^نادِ · كرسي/ }).filter({ visible: true });
        const available = await call.evaluateAll(buttons => buttons.filter(button => !(button as HTMLButtonElement).disabled)
          .map(button => ({ text: button.textContent ?? "" })));
        expect(available.length).toBeGreaterThan(0);
        const chair = Number(available[0].text.match(/\d+/)?.[0]); expect(chair).toBeGreaterThan(0);
        permits.push({ path: "/api/visits/701", body: { action: "call", chair } });
        await row(page, RELINKED).getByRole("button", { name: available[0].text.trim(), exact: true }).click();
        await expect.poll(() => writes.length).toBe(1);
        await expect.poll(() => row(page, RELINKED).getByRole("button", { name: "دخل الكرسي", exact: true }).isEnabled()).toBe(true);
        expect(await page.getByText(CLEARANCE_WARNING, { exact: true }).count()).toBe(1);

        // A fresh waiting visit must pass the gate on CALL. Release the
        // unrelated synthetic called row so this needs no extra chair setting.
        gateOn = true;
        visits[1] = { ...visits[1], status: "done", chair: null, finishedAt: arrivedAt };
        visits.push({ id: 703, patientId: 94, patientName: EMERGENCY, patientPhone: null, note: null,
          status: "waiting", chair: null, arrivedAt, calledAt: null, seatedAt: null, finishedAt: null });
        await page.clock.fastForward(20_001);
        await expect.poll(() => row(page, EMERGENCY).count()).toBe(1);
        const emergencyCalls = await row(page, EMERGENCY).getByRole("button", { name: /^نادِ · كرسي/ })
          .evaluateAll(buttons => buttons.filter(button => !(button as HTMLButtonElement).disabled)
            .map(button => (button.textContent ?? "").trim()));
        expect(emergencyCalls.length).toBeGreaterThan(0);
        const emergencyChair = Number(emergencyCalls[0].match(/\d+/)?.[0]);
        expect(emergencyChair).toBeGreaterThan(0);
        permits.push({ path: "/api/visits/703", body: { action: "call", chair: emergencyChair } },
          { path: "/api/visits/703", body: { action: "call", chair: emergencyChair, emergency: true, emergencyReason: REASON } });
        const prompted = page.waitForEvent("dialog").then(async dialog => {
          expect(dialog.type()).toBe("prompt"); expect(dialog.message()).toContain(CLEARANCE_REQUIRED_MESSAGE);
          await dialog.accept(REASON);
        });
        await Promise.all([
          row(page, EMERGENCY).getByRole("button", { name: emergencyCalls[0], exact: true }).click(),
          prompted,
        ]);
        await expect.poll(() => writes.length).toBe(3);
        await expect.poll(() => row(page, EMERGENCY).getByRole("button", { name: "دخل الكرسي", exact: true }).isEnabled()).toBe(true);
        // Already-called seating is permitted without another prompt or
        // another emergency body, even with the gate on and debt outstanding.
        page.on("dialog", dialog => {
          repeatedPrompts.push(dialog.message());
          void dialog.dismiss().catch(error => errors.push(String(error)));
        });
        permits.push({ path: "/api/visits/703", body: { action: "seat", chair: emergencyChair } });
        await row(page, EMERGENCY).getByRole("button", { name: "دخل الكرسي", exact: true }).click();
        await expect.poll(() => writes.length).toBe(4);
        expect(writes).toEqual([
          { path: "/api/visits/701", body: { action: "call", chair } },
          { path: "/api/visits/703", body: { action: "call", chair: emergencyChair } },
          { path: "/api/visits/703", body: { action: "call", chair: emergencyChair, emergency: true, emergencyReason: REASON } },
          { path: "/api/visits/703", body: { action: "seat", chair: emergencyChair } },
        ]);
        expect(permits).toEqual([]);
        await expect.poll(() => row(page, EMERGENCY).count()).toBe(0);
        expect(repeatedPrompts).toEqual([]);
        expect(unexpected).toEqual([]); expect(errors).toEqual([]);
      } finally { held.splice(0).forEach(read => read.release()); }
    }, () => {
      expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(permits).toEqual([]); expect(repeatedPrompts).toEqual([]);
    });
  }, 120_000);
});

