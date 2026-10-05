import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Locator, type Page, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUCKET_LABEL, BUCKET_ORDER, classifyFollowups, groupByBucket, type FollowupCase } from "../../lib/ortho-followup";
import { friendlyDate, reminderText, unbookedFollowupText } from "../../lib/reminders";
import { baseUrl, harness } from "./_server";

// Actual built /ortho page and existing isolated security-harness admin session.
// Follow-up and shell API GETs are synthetic intercepted responses. This test
// adds no DB seed/writer and blocks every browser mutation and external request.
// WhatsApp hrefs are decoded in memory, never clicked or opened.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
const TODAY = "2026-10-05";
const unbooked: FollowupCase = {
  caseId: 91401, patientId: 91101, patientName: "مريض متابعة اصطناعي بلا حجز", patientPhone: "770111001",
  status: "retention", phase: "retention", startDate: "2025-01-01", lastAdjustmentDate: "2026-07-01",
  nextWeeks: 4, upperWire: null, lowerWire: null, nextAppointment: null, lastWasNoShow: false,
};
const booked: FollowupCase = {
  ...unbooked, caseId: 91402, patientId: 91102, patientName: "مريض متابعة اصطناعي بموعد محجوز", patientPhone: "770111002",
  nextAppointment: { id: 91501, date: "2026-10-08", time: "10:30", status: "booked" },
};
const rows = classifyFollowups({ cases: [unbooked, booked], today: TODAY });
const groups = groupByBucket(rows);
const feed = { today: TODAY, buckets: BUCKET_ORDER.map((bucket) => ({
  bucket, count: groups.get(bucket)?.length ?? 0, rows: groups.get(bucket) ?? [],
})) };
const json = (route: Route, payload: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });

beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); });

async function openBoard(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE",
    timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = []; const errors: string[] = []; const downloads: string[] = [];
  const navigations: string[] = []; let followupReads = 0;
  await context.route("**/*", async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== new URL(baseUrl).origin) {
      unexpected.push(`external ${request.method()} ${url.origin}${url.pathname}`); await route.abort(); return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      unexpected.push(`mutation ${request.method()} ${url.pathname}`); await route.abort(); return;
    }
    if (request.isNavigationRequest() && url.pathname !== "/ortho") {
      unexpected.push(`navigation ${url.pathname}`); await route.abort(); return;
    }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    if (request.method() === "GET") {
      switch (url.pathname) {
        case "/api/ortho/followups":
          if (url.search === "") { followupReads++; await json(route, feed); return; }
          break;
        case "/api/ortho/billing-decisions": await json(route, { pending: [] }); return;
        case "/api/booking-requests": await json(route, []); return;
        case "/api/lab": await json(route, { late: 0 }); return;
        case "/api/messages": await json(route, { unread: 0, urgent: 0 }); return;
        case "/api/auth/me": await json(route, { username: "secadmin", role: "admin" }); return;
      }
    }
    unexpected.push(`unmocked ${request.method()} ${url.pathname}`);
    await route.fulfill({ status: 501, contentType: "application/json", body: '{"message":"Unmocked follow-up fixture request blocked"}' });
  });
  const page = await context.newPage();
  context.on("page", () => unexpected.push("unexpected new page"));
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  await page.clock.setFixedTime(new Date("2026-10-05T09:00:00Z"));
  try {
    await page.goto(`${baseUrl}/ortho`, { waitUntil: "networkidle" });
    await expect.poll(() => followupReads).toBe(1);
    await page.getByRole("link", { name: "واتساب لترتيب متابعة", exact: true }).waitFor();
    await page.getByRole("button", { name: new RegExp(`^${BUCKET_LABEL.retention}`) }).click();
    const unbookedRow = page.locator("li").filter({ has: page.getByRole("link", { name: unbooked.patientName, exact: true }) });
    const bookedRow = page.locator("li").filter({ has: page.getByRole("link", { name: booked.patientName, exact: true }) });
    expect(await unbookedRow.count()).toBe(1); expect(await bookedRow.count()).toBe(1);
    const invitation = unbookedRow.getByRole("link", { name: "واتساب لترتيب متابعة", exact: true });
    const reminder = bookedRow.getByRole("link", { name: "واتساب تذكير", exact: true });
    await invitation.waitFor(); await reminder.waitFor();
    return { page, context, invitation, reminder, assertIsolated: () => {
      expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(downloads).toEqual([]);
      expect(navigations).toEqual([`${baseUrl}/ortho`]);
      expect(followupReads).toBe(1);
    } };
  } catch (error) { await context.close(); throw error; }
}

async function messageFrom(link: Locator, phone: string) {
  const href = await link.getAttribute("href"); expect(href).not.toBeNull();
  const url = new URL(href!);
  expect(url.origin).toBe("https://wa.me"); expect(url.pathname).toBe(`/967${phone}`);
  expect([...url.searchParams.keys()]).toEqual(["text"]);
  expect(await link.getAttribute("target")).toBe("_blank");
  expect((await link.getAttribute("rel"))?.split(/\s+/)).toContain("noopener");
  return { href, text: url.searchParams.get("text") };
}

async function geometry(link: Locator) {
  await link.scrollIntoViewIfNeeded();
  // Focus only: no Enter, Space, click, window.open or navigation to WhatsApp.
  await link.focus();
  return link.evaluate((element) => {
    const rect = element.getBoundingClientRect(); const row = element.closest("li")!.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(element);
    const text = Array.from(range.getClientRects()).map((box) => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom }));
    // Midpoints of each painted edge avoid the rounded-corner cutouts.
    const points = [[rect.left + rect.width / 2, rect.top + 3], [rect.left + rect.width / 2, rect.bottom - 3],
      [rect.left + 3, rect.top + rect.height / 2], [rect.right - 3, rect.top + rect.height / 2],
      [rect.left + rect.width / 2, rect.top + rect.height / 2]];
    return { label: element.textContent?.trim(), width: rect.width, height: rect.height,
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      row: { left: row.left, right: row.right, top: row.top, bottom: row.bottom }, text,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
      focused: document.activeElement === element,
      hits: points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === element || element.contains(hit)); }),
    };
  });
}

async function capture(page: Page, invitation: Locator, reminder: Locator, width: number,
  messages: { unbooked: Awaited<ReturnType<typeof messageFrom>>; booked: Awaited<ReturnType<typeof messageFrom>> }) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const controls = [await geometry(invitation), await geometry(reminder)];
  const artifact = `.settings-ui-artifacts/ortho-unbooked-followup-${width}`;
  // Save actual failure geometry and the real built page before fatal assertions.
  // Only two PNGs and their two synthetic evidence records are allowlisted.
  await writeFile(`${artifact}-bounds.json`, `${JSON.stringify({ viewport: { width, height: 1000 }, page: "/ortho", messages, controls }, null, 2)}\n`);
  await page.screenshot({ path: `${artifact}.png`, fullPage: true });
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  for (const control of controls) {
    expect(control.width).toBeGreaterThanOrEqual(44); expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.left).toBeGreaterThanOrEqual(0); expect(control.top).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(control.viewportWidth); expect(control.bottom).toBeLessThanOrEqual(control.viewportHeight);
    expect(control.left).toBeGreaterThanOrEqual(control.row.left); expect(control.right).toBeLessThanOrEqual(control.row.right);
    expect(control.top).toBeGreaterThanOrEqual(control.row.top); expect(control.bottom).toBeLessThanOrEqual(control.row.bottom);
    expect(control.text.length).toBeGreaterThan(0);
    for (const box of control.text) {
      expect(box.left).toBeGreaterThanOrEqual(control.left - 1); expect(box.right).toBeLessThanOrEqual(control.right + 1);
      expect(box.top).toBeGreaterThanOrEqual(control.top - 1); expect(box.bottom).toBeLessThanOrEqual(control.bottom + 1);
    }
    expect(control.noHorizontalOverflow).toBe(true); expect(control.focused).toBe(true);
    expect(control.hits).toEqual([true, true, true, true, true]);
  }
}

describe("truthful unbooked follow-up on the real built orthodontic board", () => {
  it.each([390, 1280])("distinguishes an invitation from a real booking without navigating to WhatsApp at %ipx", async (width) => {
    const f = await openBoard(width);
    try {
      const invitation = await messageFrom(f.invitation, unbooked.patientPhone!);
      const reminder = await messageFrom(f.reminder, booked.patientPhone!);
      expect(invitation.text).toBe(unbookedFollowupText(unbooked.patientName));
      const due = rows.find((row) => row.caseId === unbooked.caseId)!.dueDate;
      for (const invented of [due, friendlyDate(due), "16:00", "4:00", "الساعة", "مكانكم محفوظ", "نذكّركم بموعدكم", "لنؤجله"]) {
        expect(invitation.text).not.toContain(invented);
      }
      const appointment = booked.nextAppointment!;
      expect(reminder.text).toBe(reminderText({ id: appointment.id, patientId: booked.patientId,
        patientName: booked.patientName, patientPhone: booked.patientPhone,
        scheduledDate: appointment.date, scheduledTime: appointment.time, durationMinutes: 15,
        note: null, status: "booked" }, "upcoming"));
      expect(reminder.text).toContain("الخميس 08/10 الساعة 10:30 صباحًا");
      expect(reminder.text).not.toContain(friendlyDate(due));
      await capture(f.page, f.invitation, f.reminder, width, { unbooked: invitation, booked: reminder });
      expect(f.context.pages()).toHaveLength(1);
      f.assertIsolated();
    } finally {
      await f.context.close();
      expect(f.context.pages()).toHaveLength(0);
      f.assertIsolated();
    }
  });
});
