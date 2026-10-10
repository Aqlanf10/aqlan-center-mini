import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright";
import { Client } from "pg";
import { mkdir } from "node:fs/promises";
import { baseUrl, harness } from "./_server";

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
      excess: root.scrollWidth - root.clientWidth, wide,
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
      // Observe only the synthetic home visits read. Never log bodies, names,
      // query strings, cookies, headers or arbitrary browser/server messages.
      type Read = { epoch: number; status: number | null; finished: boolean;
        fixturePresent: boolean; failure: "aborted" | "transport" | "invalid-json" | null };
      const reads: Read[] = [], pending = new Map<Request, Read>();
      let readCount = 0, traceOverflow = false, pageErrorCount = 0;
      page.on("pageerror", () => { pageErrorCount += 1; });
      page.on("request", request => {
        const url = new URL(request.url());
        if (path !== "/" || request.method() !== "GET" || url.origin !== baseUrl
          || url.pathname !== "/api/visits" || url.search !== "") return;
        readCount += 1;
        if (reads.length >= 32) { traceOverflow = true; return; }
        const read: Read = { epoch: readCount, status: null, finished: false, fixturePresent: false, failure: null };
        reads.push(read); pending.set(request, read);
      });
      page.on("requestfailed", request => {
        const read = pending.get(request); if (!read) return;
        read.failure = request.failure()?.errorText === "net::ERR_ABORTED" ? "aborted" : "transport";
        pending.delete(request);
      });
      page.on("requestfinished", request => {
        const read = pending.get(request); if (!read) return;
        void (async () => {
          try {
            const response = await request.response();
            read.status = response?.status() ?? null;
            const payload: unknown = await response?.json();
            read.fixturePresent = Array.isArray(payload) && payload.some(row => row !== null && typeof row === "object"
              && "id" in row && row.id === fixtureVisitId && "doctorId" in row && row.doctorId === fixtureDoctorId
              && "status" in row && row.status === "done");
            read.finished = true;
          } catch { read.failure = "invalid-json"; }
          finally { pending.delete(request); }
        })();
      });
      try {
        // The home board owns polling; network silence is not its ready state.
        // Other routes retain their existing navigation contract.
        const response = await page.goto(`${baseUrl}${path}`, { waitUntil: path === "/" ? "domcontentloaded" : "networkidle" });
        expect(response?.status()).toBe(200);
        await page.evaluate(() => document.fonts.ready);
        const selectScope = path === "/"
          ? page.getByRole("combobox", { name: "الطبيب", exact: true })
          : page.locator("select");
        const option = selectScope.locator(`option[value="${fixtureDoctorId}"]`);
        if (path === "/" || path === "/appointments") await option.waitFor({ state: "attached" });
        if (path === "/") {
          await expect.poll(() => {
            const latest = reads.at(-1);
            return { pending: pending.size, overflow: traceOverflow, status: latest?.status,
              finished: latest?.finished, fixturePresent: latest?.fixturePresent, failure: latest?.failure };
          }).toEqual({ pending: 0, overflow: false, status: 200, finished: true, fixturePresent: true, failure: null });
          expect(await page.getByRole("tabpanel", { name: "الانتظار والكراسي" }).isVisible()).toBe(true);
          await expect.poll(async () => (await option.textContent())?.trim()).toBe(LONG_DOCTOR_NAME);
          expect(await page.getByRole("region", { name: "مرشّحات اليوم" }).isVisible()).toBe(true);
        }
        const overflow = await measureOverflow(page);
        if (path === "/" || path === "/appointments") {
          expect(await option.count()).toBe(1);
          const fullLabel = path === "/" ? LONG_DOCTOR_NAME : `د. ${LONG_DOCTOR_NAME}`;
          expect((await option.textContent())?.trim()).toBe(fullLabel);
          const doctorFilter = option.locator("..");
          await doctorFilter.selectOption(String(fixtureDoctorId));
          expect(await doctorFilter.inputValue()).toBe(String(fixtureDoctorId));
          expect((await doctorFilter.locator("option:checked").textContent())?.trim()).toBe(fullLabel);
          if (path === "/") {
            // Native selection must update application-owned content, not just
            // the select element: this doctor's single done fixture is adopted.
            const doneCount = page.locator('dl[aria-label="عدّادات اليوم"]').getByText("أُنجز", { exact: true }).locator("..").locator("dd");
            await expect.poll(() => doneCount.textContent()).toBe("1");
          }
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
      } catch (error) {
        console.info("PHONE_READY_DIAGNOSTIC_V1", JSON.stringify({ synthetic: true, route: path,
          viewport: PHONE, readCount, traceOverflow, pending: pending.size, pageErrorCount, reads }));
        throw error;
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
