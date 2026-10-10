import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Client } from "pg";
import { mkdir } from "node:fs/promises";
import { baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";

/**
 * (P3-4) الشاشات اليومية على هاتفٍ عرضه 390px — بلا تمريرٍ أفقي.
 *
 * العيب (تدقيق الجاهزية): /lab تفيض 113px على الهاتف، فيضيع زرّ أو عمود خارج
 * الشاشة ويسحب المستخدم الصفحة جانبيًّا. المقياس: عرض المستند لا يتجاوز عرض
 * النافذة.
 */

const PHONE = { width: 390, height: 844 };
const SCREENS = ["/", "/lab", "/appointments", "/patients", "/finance", "/waiting-list", "/recall", "/account"];
// Keep the long mixed-script name: native selects size themselves from every
// option, including unselected ones. This fixture must not depend on suite order.
const LONG_DOCTOR_NAME = "طبيب سياسة اصطناعي explicit-12.345 1791151200000-2";

let browser: Browser;
let context: BrowserContext;
let db: Client;
let fixtureDoctorId: number | undefined;
let fixtureVisitId: number | undefined;
let h: Awaited<ReturnType<typeof harness>>;

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const doctor = await db.query<{ id: number }>(
    "INSERT INTO parties (name, kind, is_active) VALUES ($1, 'doctor', TRUE) RETURNING id",
    [LONG_DOCTOR_NAME],
  );
  fixtureDoctorId = doctor.rows[0].id;
  // A completed visit makes this doctor eligible for the home filter without
  // occupying a chair, creating a patient account, or touching financial facts.
  const visit = await db.query<{ id: number }>(
    `INSERT INTO visits (patient_name, doctor_id, status, arrived_at, finished_at)
      VALUES ('مريض اختبار عرض الهاتف', $1, 'done', NOW(), NOW()) RETURNING id`,
    [fixtureDoctorId],
  );
  fixtureVisitId = visit.rows[0].id;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: PHONE, locale: "ar-YE", isMobile: true, hasTouch: true });
  await context.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
}, 240_000);

afterAll(async () => {
  try {
    await context?.close();
    await browser?.close();
  } finally {
    try {
      // Only rows owned by this fixture, in the guarded isolated HTTP database.
      if (fixtureVisitId !== undefined) await db.query("DELETE FROM visits WHERE id = $1", [fixtureVisitId]);
      if (fixtureDoctorId !== undefined) await db.query("DELETE FROM parties WHERE id = $1", [fixtureDoctorId]);
    } finally {
      await db?.end();
    }
  }
});

async function measureOverflow(page: Page) {
  return page.evaluate((doctorId) => {
    const root = document.documentElement;
    const wide = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.getBoundingClientRect().right > root.clientWidth + 1
        || element.getBoundingClientRect().left < -1)
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)}`);
    // Preserve the first-ancestor summary while recording the actual deepest
    // overflow boundaries. Never log live text or hide a horizontal overflow.
    const deepest = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter(element => element.getBoundingClientRect().right > root.clientWidth + 1
        || element.getBoundingClientRect().left < -1 || element.scrollWidth > element.clientWidth + 1)
      .map(element => {
        const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
        let depth = 0;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) depth++;
        return { depth, tag: element.tagName.toLowerCase(), className: String(element.className).slice(0, 160),
          left: bounds.left, right: bounds.right, width: bounds.width,
          clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          minWidth: style.minWidth, maxWidth: style.maxWidth, whiteSpace: style.whiteSpace,
          overflowWrap: style.overflowWrap, overflowX: style.overflowX, flexShrink: style.flexShrink };
      }).sort((a, b) => b.depth - a.depth).slice(0, 12);
    const selector = `select option[value="${doctorId}"]`;
    const select = document.querySelector<HTMLOptionElement>(selector)?.closest("select");
    const ancestors = [];
    for (let element: HTMLElement | null = select ?? null; element && ancestors.length < 6; element = element.parentElement) {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      ancestors.push({
        tag: element.tagName.toLowerCase(), className: String(element.className),
        left: bounds.left, right: bounds.right, width: bounds.width,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        minWidth: style.minWidth, maxWidth: style.maxWidth, flexShrink: style.flexShrink,
      });
    }
    return {
      excess: root.scrollWidth - root.clientWidth, wide, deepest,
      clientWidth: root.clientWidth, scrollWidth: root.scrollWidth,
      innerWidth: window.innerWidth, visualViewportWidth: window.visualViewport?.width,
      ancestors,
    };
  }, fixtureDoctorId);
}

describe("P3-4 — no horizontal overflow at phone width", () => {
  for (const path of SCREENS) {
    it(`${path} fits a 390px phone`, async () => {
      const page = await context.newPage();
      try {
        const response = await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
        expect(response?.status()).toBe(200);
        await page.evaluate(() => document.fonts.ready);
        const selectScope = path === "/"
          ? page.getByRole("combobox", { name: "الطبيب", exact: true })
          : page.locator("select");
        const option = selectScope.locator(`option[value="${fixtureDoctorId}"]`);
        if (path === "/" || path === "/appointments") await option.waitFor({ state: "attached" });
        const overflow = await measureOverflow(page);
        if (path === "/" || path === "/appointments") {
          expect(await option.count()).toBe(1);
          const fullLabel = path === "/" ? LONG_DOCTOR_NAME : `د. ${LONG_DOCTOR_NAME}`;
          expect((await option.textContent())?.trim()).toBe(fullLabel);
          const doctorFilter = option.locator("..");
          await doctorFilter.selectOption(String(fixtureDoctorId));
          expect(await doctorFilter.inputValue()).toBe(String(fixtureDoctorId));
          expect((await doctorFilter.locator("option:checked").textContent())?.trim()).toBe(fullLabel);
          const selected = await measureOverflow(page);
          console.info("[phone-doctor-filter]", JSON.stringify({ path, before: overflow, selected }));
          await mkdir(".settings-ui-artifacts", { recursive: true });
          await page.screenshot({
            path: `.settings-ui-artifacts/phone-doctor-filter-${path === "/" ? "home" : "appointments"}-390.png`,
            fullPage: true,
          });
          expect(selected.excess, `${path} selected doctor: ${JSON.stringify(selected)}`).toBeLessThanOrEqual(1);
        }
        expect(overflow.excess, `${path}: ${overflow.wide.join(" | ")}; ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(1);
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  it("wraps complete synthetic Recall names, notes and proposal titles within the physical 390px viewport", async () => {
    const local = await browser.newContext({ viewport: PHONE, locale: "ar-YE", isMobile: true, hasTouch: true, serviceWorkers: "block" });
    await local.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
    const unexpected: string[] = [], errors: string[] = [], reads: string[] = [];
    const token = "0123456789abcdef".repeat(5);
    const missedName = `مريض غائب اصطناعي ${token}`, openName = `مريض موعد اصطناعي ${token}`;
    const proposalName = `مريض عرض اصطناعي ${token}`, title = `خطة اصطناعية ${token}`, note = `ملاحظة اصطناعية ${token}`;
    const routes = await guardBrowserRoutes(local, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort(); return;
      }
      if (url.pathname === "/api/recall" && request.method() === "GET" && url.search === "?weeks=6") {
        reads.push(url.pathname + url.search);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ weeks: 6,
          openPast: [{ id: 989701, patientId: 989711, patientName: openName, patientPhone: null,
            scheduledDate: "2026-10-01", scheduledTime: "09:00", doctorName: null, note: null, daysLate: 1 }],
          missed: [{ kind: "missed", id: 989702, patientId: 989712, patientName: missedName,
            patientPhone: null, referenceDate: "2026-10-01", note }], lapsed: [] }) }); return;
      }
      if (url.pathname === "/api/plans/proposals" && request.method() === "GET" && url.search === "") {
        reads.push(url.pathname);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ followUpDays: 7,
          proposals: [{ planId: 989703, patientId: 989713, patientName: proposalName, patientPhone: null,
            title, doctorName: null, createdOn: "2026-10-01", lastContactOn: null, items: 1,
            totalMinor: null, currency: "YER", timing: { stage: "due", ageDays: 9, daysSinceContact: null }, whatsappAllowed: false }] }) }); return;
      }
      if (["/api/recall", "/api/plans/proposals"].includes(url.pathname)) {
        unexpected.push(`unconfigured ${request.method()} ${url.pathname}${url.search}`); await route.abort(); return;
      }
      await route.continue();
    });
    const page = await local.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => { unexpected.push(`unexpected ${dialog.type()}`); void dialog.dismiss(); });
    page.on("download", () => unexpected.push("unexpected download"));
    await routes.run(async () => {
      const response = await page.goto(`${baseUrl}/recall`, { waitUntil: "networkidle" });
      expect(response?.status()).toBe(200); await page.evaluate(() => document.fonts.ready);
      const textProof = [];
      for (const expected of [missedName, openName, proposalName, `${title} · 1 بند`, note]) {
        const text = page.getByText(expected, { exact: true });
        await text.waitFor(); expect(await text.count()).toBe(1); expect(await text.textContent()).toBe(expected);
        await text.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
        const bounds = await text.evaluate(element => {
          const range = document.createRange(); range.selectNodeContents(element);
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
          const lines = [...range.getClientRects()].filter(line => line.width > 0 && line.height > 0)
            .map(line => ({ left: line.left, right: line.right, top: line.top, bottom: line.bottom }));
          return { lines, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            whiteSpace: style.whiteSpace, textOverflow: style.textOverflow,
            unobscured: element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) };
        });
        expect(bounds.lines.length).toBeGreaterThan(1); expect(bounds.whiteSpace).not.toBe("nowrap");
        expect(bounds.textOverflow).not.toBe("ellipsis"); expect(bounds.unobscured).toBe(true);
        expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.bottom).toBeLessThanOrEqual(PHONE.height);
        for (const line of bounds.lines) {
          expect(line.left).toBeGreaterThanOrEqual(-1); expect(line.right).toBeLessThanOrEqual(PHONE.width + 1);
        }
        textProof.push({ expected, ...bounds });
      }
      const overflow = await measureOverflow(page);
      console.info("[phone-recall-long-text]", JSON.stringify({ overflow, textProof }));
      expect(overflow.clientWidth).toBe(PHONE.width);
      expect(overflow.excess, JSON.stringify(overflow)).toBeLessThanOrEqual(1);
      expect(reads.sort()).toEqual(["/api/plans/proposals", "/api/recall?weeks=6"]);
      expect(local.pages()).toHaveLength(1);
    }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); });
  }, 60_000);
});
