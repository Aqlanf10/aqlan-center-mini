import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { Client } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
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
const LONG_PATIENT_NUMBER = "PHONE-WIDTH-SYNTHETIC-PATIENT-1791151200000-1234567890";
// Thirty characters is the supported flag limit, including unbroken labels.
const LONG_PATIENT_FLAG = "W".repeat(30);
const FIXTURE_PATIENT_FLAG = "PHONE-WIDTH-BASE";
const SHORT_PATIENT_NUMBER = `PHONE-${Date.now()}`;

let browser: Browser;
let context: BrowserContext;
let db: Client;
let fixtureDoctorId: number | undefined;
let fixtureVisitId: number | undefined;
let fixturePatientId: number | undefined;
let originalFlags: { value: string } | undefined;
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
  originalFlags = (await db.query<{ value: string }>("SELECT value FROM settings WHERE key = 'patients.flags'")).rows[0];
  fixturePatientId = (await db.query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id",
    [LONG_PATIENT_NUMBER, "مريض اصطناعي لاختبار عرض القائمة"],
  )).rows[0].id;
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
      if (fixturePatientId !== undefined) await db.query("DELETE FROM patients WHERE id = $1", [fixturePatientId]);
      await restoreFlags();
      if (fixtureVisitId !== undefined) await db.query("DELETE FROM visits WHERE id = $1", [fixtureVisitId]);
      if (fixtureDoctorId !== undefined) {
        // The real patient page can create append-only doctor history. Retire only
        // this synthetic doctor; global teardown drops its isolated database.
        await db.query("UPDATE parties SET is_active = FALSE WHERE id = $1", [fixtureDoctorId]);
      }
    } finally {
      await db?.end();
    }
  }
});

async function measureOverflow(page: Page) {
  return page.evaluate((doctorId) => {
    const root = document.documentElement;
    const outside = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0
          && (bounds.right > root.clientWidth + 1 || bounds.left < -1);
      });
    const wide = outside
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)}`);
    const describe = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { tag: element.tagName.toLowerCase(), className: String(element.className),
        label: element.getAttribute("aria-label"), text: element.innerText?.trim().slice(0, 180),
        left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        minWidth: style.minWidth, maxWidth: style.maxWidth, flexShrink: style.flexShrink,
        whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, overflowX: style.overflowX };
    };
    // Keep the inner offenders, not only their first five stretched shell ancestors.
    const deepest = outside.filter((element) => !outside.some((child) => child !== element && element.contains(child)))
      .slice(0, 20).map((element) => {
        const parents = [];
        for (let parent = element.parentElement; parent && parents.length < 6; parent = parent.parentElement) parents.push(describe(parent));
        return { ...describe(element), parents };
      });
    const overflowingContent = [...document.querySelectorAll<HTMLElement>("main *")]
      .filter(element => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1
        && getComputedStyle(element).overflowX === "visible")
      .map(describe);
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
      excess: root.scrollWidth - root.clientWidth, wide, outsideCount: outside.length, deepest, overflowingContent,
      clientWidth: root.clientWidth, scrollWidth: root.scrollWidth,
      innerWidth: window.innerWidth, visualViewportWidth: window.visualViewport?.width,
      ancestors,
    };
  }, fixtureDoctorId);
}

async function restoreFlags() {
  if (!db) return;
  if (originalFlags) await db.query("UPDATE settings SET value = $1 WHERE key = 'patients.flags'", [originalFlags.value]);
  else await db.query("DELETE FROM settings WHERE key = 'patients.flags'");
}

async function captureOverflow(page: Page, name: string) {
  const geometry = await measureOverflow(page);
  await mkdir(".settings-ui-artifacts", { recursive: true });
  const prefix = `.settings-ui-artifacts/phone-width-${name}`;
  await writeFile(`${prefix}.json`, `${JSON.stringify(geometry, null, 2)}\n`);
  await page.screenshot({ path: `${prefix}.png`, fullPage: false });
  console.info("[phone-width-evidence]", JSON.stringify({ name, excess: geometry.excess,
    clientWidth: geometry.clientWidth, scrollWidth: geometry.scrollWidth, geometry: `${prefix}.json`,
    deepest: geometry.deepest.map(({ tag, label, text, left, right, width }) => ({ tag, label, text, left, right, width })) }));
  return geometry;
}

async function nativeSelect(page: Page, select: Locator, expected: string) {
  // Reveal the actual native control with wheel input, then use its keyboard UI.
  for (let step = 0; step < 8; step++) {
    const box = await select.boundingBox(); expect(box).not.toBeNull();
    const height = page.viewportSize()!.height;
    if (box!.y >= 60 && box!.y + box!.height <= height - 60) break;
    await page.mouse.move(4, height / 2);
    await page.mouse.wheel(0, box!.y + box!.height / 2 - height / 2);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  expect(await select.evaluate(element => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return (hit === element || !!hit && element.contains(hit)) && box.left >= 0 && box.right <= document.documentElement.clientWidth;
  })).toBe(true);
  const box = await select.boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.press("Escape");
  expect(await select.evaluate(element => document.activeElement === element)).toBe(true);
  const index = await select.locator("option").evaluateAll((options, value) =>
    options.findIndex(option => (option as HTMLOptionElement).value === value), expected);
  expect(index).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Home");
  for (let step = 0; step < index; step++) await page.keyboard.press("ArrowDown");
  await expect.poll(() => select.inputValue()).toBe(expected);
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
        if (overflow.excess > 1) await captureOverflow(page, `${path.replaceAll("/", "") || "home"}-390-failure`);
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

  for (const width of [390, 1280]) {
    for (const scenario of ["patient-number", "flag", "combined"] as const) {
      it(`/patients preserves long ${scenario} and native filters at ${width}px`, async () => {
        const longNumber = scenario !== "flag", longFlag = scenario !== "patient-number";
        const number = longNumber ? LONG_PATIENT_NUMBER : SHORT_PATIENT_NUMBER;
        await db.query("UPDATE patients SET patient_number = $1, flags = $2::text[] WHERE id = $3",
          [number, longFlag ? [LONG_PATIENT_FLAG] : [], fixturePatientId]);
        // Own the options even when the previous setting has no effective flags.
        // The exact previous value is restored in finally.
        const expectedFlags = longFlag ? [FIXTURE_PATIENT_FLAG, LONG_PATIENT_FLAG] : [FIXTURE_PATIENT_FLAG];
        await db.query("INSERT INTO settings (key, value) VALUES ('patients.flags', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
          [expectedFlags.join(",")]);
        const view = await browser.newContext({ viewport: { width, height: 844 }, locale: "ar-YE", isMobile: width === 390, hasTouch: width === 390 });
        await view.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
        const page = await view.newPage();
        const writes: string[] = [], errors: string[] = [];
        page.on("request", request => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
        page.on("pageerror", error => errors.push(error.message));
        try {
          await page.goto(`${baseUrl}/patients`, { waitUntil: "networkidle" });
          // Direct fixture SQL does not invalidate the server's five-second
          // settings cache. Establish the intended options before measuring;
          // never retry a layout assertion until it happens to pass.
          await expect.poll(async () => {
            await page.reload({ waitUntil: "networkidle" });
            return page.getByRole("combobox", { name: "علَم", exact: true }).locator("option")
              .evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
          }, { timeout: 10_000 }).toEqual(["", ...expectedFlags]);
          const card = page.locator(`a[href="/patients/${fixturePatientId}"]`);
          await card.waitFor();
          await page.evaluate(() => document.fonts.ready);
          expect(await card.innerText()).toContain(number);
          if (longFlag) expect(await card.innerText()).toContain(LONG_PATIENT_FLAG);
          const before = await captureOverflow(page, `${scenario}-${width}-initial`);
          expect(before.excess, JSON.stringify(before)).toBeLessThanOrEqual(1);
          const numberChip = card.getByText(number, { exact: true });
          expect(await numberChip.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
          if (longFlag) {
            const flagChip = card.getByTitle("علَم المريض", { exact: true });
            expect(await flagChip.evaluate(element => {
              const box = element.getBoundingClientRect(), owner = element.parentElement!.getBoundingClientRect();
              return box.left >= owner.left - 1 && box.right <= owner.right + 1;
            })).toBe(true);
          }
          const sort = page.getByRole("combobox", { name: "ترتيب القائمة", exact: true });
          const sorted = page.waitForResponse(response => {
            const url = new URL(response.url());
            return url.pathname === "/api/patients" && url.searchParams.get("sort") === "name";
          });
          await nativeSelect(page, sort, "name");
          const namedResponse = await sorted;
          expect(namedResponse.ok()).toBe(true);
          const named = await namedResponse.json();
          expect(Array.isArray(named.rows)).toBe(true);
          // Alphabetical page one may legitimately exclude this patient. Return
          // through the native control to the newest fixture before locating it.
          const recent = page.waitForResponse(response => {
            const url = new URL(response.url());
            return url.pathname === "/api/patients" && url.searchParams.get("sort") === "recent";
          });
          await nativeSelect(page, sort, "recent");
          const recentResponse = await recent;
          expect(recentResponse.ok()).toBe(true);
          const latest = await recentResponse.json();
          expect(latest.rows.map((patient: { id: number }) => patient.id)).toContain(fixturePatientId);
          console.info("[phone-width-sort-pages]", JSON.stringify({ scenario, width, patientId: fixturePatientId,
            namePageIds: named.rows.map((patient: { id: number }) => patient.id),
            recentPageIds: latest.rows.map((patient: { id: number }) => patient.id) }));
          if (longFlag) {
            const flags = page.getByRole("combobox", { name: "علَم", exact: true });
            const filtered = page.waitForResponse(response => {
              const url = new URL(response.url());
              return url.pathname === "/api/patients" && url.searchParams.get("flag") === LONG_PATIENT_FLAG;
            });
            await nativeSelect(page, flags, LONG_PATIENT_FLAG);
            expect(await flags.locator("option:checked").textContent()).toBe(`🏷️ ${LONG_PATIENT_FLAG}`);
            const response = await filtered;
            expect(response.ok()).toBe(true);
            expect((await response.json()).rows.map((patient: { id: number }) => patient.id)).toEqual([fixturePatientId]);
            await expect.poll(() => page.locator("main ul > li > a").count()).toBe(1);
          }
          await card.waitFor();
          const selected = await captureOverflow(page, `${scenario}-${width}-selected`);
          expect(selected.excess, JSON.stringify(selected)).toBeLessThanOrEqual(1);
          await card.click();
          await expect.poll(() => new URL(page.url()).pathname).toBe(`/patients/${fixturePatientId}`);
          expect(writes).toEqual([]); expect(errors).toEqual([]);
        } finally {
          await view.close();
          await db.query("UPDATE patients SET patient_number = $1, flags = '{}'::text[] WHERE id = $2", [LONG_PATIENT_NUMBER, fixturePatientId]);
          await restoreFlags();
        }
      }, 60_000);
    }
  }
});
