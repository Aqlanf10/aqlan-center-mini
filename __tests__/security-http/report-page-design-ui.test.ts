import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { addDays } from "../../lib/schedule";
import { friendlyDateNamed } from "../../lib/reminders";
import { baseUrl, harness } from "./_server";

// Design evidence for the daily-report screen: real built page, synthetic
// intercepted /api/report payloads only, and every screenshot/PDF below is a
// fixture the test controls — no production record, no external message, and
// the WhatsApp share link is only inspected, never opened.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

const ARTIFACTS = ".settings-ui-artifacts";

type Pending = {
  respond: (status: number) => void;
  body: (payload: unknown) => void;
};
type FixtureWindow = Window & { __dailyDesignReports: Pending[] };
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function plannedRows() {
  const titles = [
    "تقويم — ضبط شهري", "تقويم — تركيب جهاز", "علاج جذور — جلسة",
    "تنظيف وتلميع", "حشو تجميلي", "قلع ضرس", "متابعة تقويم", "تركيب دائم",
  ];
  return titles.map((title, index) => ({
    id: index + 1,
    patientId: 900 + index,
    patientName: `مريض اصطناعي ${index + 1}`,
    patientNumber: `SYN-${100 + index}`,
    title,
    doctorName: index % 2 === 0 ? "طبيب اصطناعي أ" : "طبيب اصطناعي ب",
    time: `${String(9 + index).padStart(2, "0")}:30`,
    durationMinutes: 30,
    status: index === 2 ? "in_progress" : "booked",
    appointmentId: index + 10,
  }));
}

/** Distinct values on purpose: every stat number must be findable on the same
 *  PDF page as its label, so a card split across pages cannot hide. */
function designDayPayload(date: string) {
  return {
    date,
    nextDate: addDays(date, 1),
    report: {
      arrived: 17, done: 13, stillOpen: 4, noShow: 4, cancelled: 0,
      averageWaitMinutes: 12, longestWaitMinutes: 25, averageChairMinutes: 34,
      booked: 19, unresolved: 5,
    },
    tomorrow: { booked: 6, bookedMinutes: 180, capacityMinutes: 480, percent: 75 },
    // Lab figures keep their current-state semantics exactly as the route sends them.
    lab: { outstanding: 4, late: 3, dueToday: 1, waitingFitting: 2 },
    chairs: 4,
    plannedToday: plannedRows(),
  };
}

async function fixture(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
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
      }
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    await json(route, { message: "Unmocked request blocked by daily report design fixture" }, 501);
  });
  await page.addInitScript(() => {
    const requests: Pending[] = [];
    (window as unknown as FixtureWindow).__dailyDesignReports = requests;
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== "/api/report") return originalFetch(input, init);
      let respond!: (response: Response) => void;
      let body!: (payload: unknown) => void;
      const response = new Promise<Response>((resolve) => { respond = resolve; });
      const payload = new Promise<unknown>((resolve) => { body = resolve; });
      requests.push({
        respond: (status) => respond({ ok: status >= 200 && status < 300, status, json: () => payload } as Response),
        body,
      });
      return response;
    }) as typeof window.fetch;
  });
  await page.goto(`${baseUrl}/report`, { waitUntil: "networkidle" });
  await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).__dailyDesignReports.length)).toBe(1);
  const assertIsolated = () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); };
  const complete = async (payload: unknown, status = 200) => {
    await page.evaluate(async ({ payload, status }) => {
      const pending = (window as unknown as FixtureWindow).__dailyDesignReports[0];
      pending.respond(status);
      pending.body(payload);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, { payload, status });
  };
  return { page, context, assertIsolated, complete };
}

/** No card may overflow the viewport and no text may clip horizontally. */
async function assertNoOverflow(page: Page, width: number) {
  const main = page.getByTestId("daily-report");
  const bounds = await main.evaluate((report) => {
    const rect = report.getBoundingClientRect();
    return { left: rect.left, right: rect.right, scrollWidth: report.scrollWidth, clientWidth: report.clientWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width + 1);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
  const clipped = await main.evaluate((report) =>
    Array.from(report.querySelectorAll<HTMLElement>("*"))
      .filter((el) => el.tagName !== "INPUT" && el.clientWidth + 1 < el.scrollWidth)
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 50)}`),
  );
  expect(clipped, "no horizontally clipped text at this width").toEqual([]);
}

/** WCAG contrast of the stat labels against their card background. */
async function assertStatContrast(page: Page) {
  const ratios = await page.locator('[aria-label="الحضور"] > div').evaluateAll((cards) => {
    const luminance = (color: string) => {
      const match = color.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
      if (!match) return null;
      const channel = (raw: string) => {
        const c = Number(raw) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      // Composite over white (cards print on white anyway).
      const mix = (raw: string) => 255 * alpha * channel(raw) + 255 * (1 - alpha) * 1;
      const r = mix(match[1]), g = mix(match[2]), b = mix(match[3]);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const fg = luminance(getComputedStyle(cards[0].querySelector("p:last-child")!).color);
    const bg = luminance(getComputedStyle(cards[0]).backgroundColor);
    if (fg === null || bg === null) return [-1];
    return cards.map(() => (Math.min(fg, bg) + 0.05) / (Math.max(fg, bg) + 0.05));
  });
  expect(ratios[0]).toBeGreaterThanOrEqual(4.5);
}

describe("built daily report design evidence", () => {
  it.each([1280, 390, 320])("renders a comfortable layout with no clipped text at width %s", async (width) => {
    const f = await fixture(width);
    try {
      // The requested date comes from the labeled field — the ISO contract the API received.
      const requested = await f.page.getByLabel("تاريخ التقرير").inputValue();
      expect(requested).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await f.complete(designDayPayload(requested));

      await expect.poll(() => f.page.locator('[aria-label="الحضور"]').count()).toBe(1);
      expect(await f.page.getByTestId("selected-date-text").innerText()).toBe(friendlyDateNamed(requested));
      // Next-day reservations carry their own explicit date — no «الغد» wording.
      expect(await f.page.getByText(`حجوزات اليوم التالي — ${friendlyDateNamed(addDays(requested, 1))}`, { exact: false }).isVisible()).toBe(true);
      expect(await f.page.getByText("إشغال 75٪", { exact: false }).isVisible()).toBe(true);
      expect(await f.page.getByText("المحجوز: 6 مواعيد — 75٪ من طاقة اليوم", { exact: false }).isVisible()).toBe(true);
      // The lab section declares its current-state semantics.
      expect(await f.page.getByText("أعمال المختبر — الحالة الآن", { exact: false }).isVisible()).toBe(true);
      expect(await f.page.getByText("مواعيد غير مغلقة ليوم التقرير: 5", { exact: false }).isVisible()).toBe(true);

      await assertNoOverflow(f.page, width);
      if (width !== 1280) await assertStatContrast(f.page);

      await mkdir(ARTIFACTS, { recursive: true });
      await f.page.getByTestId("daily-report").screenshot({ path: `${ARTIFACTS}/daily-report-design-${width}.png` });
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("captures the loading, error, empty-day and cleared-date states at 390px", async () => {
    const f = await fixture(390);
    try {
      const requested = await f.page.getByLabel("تاريخ التقرير").inputValue();

      // Loading: the truthful notice names the day being prepared.
      await expect.poll(() => f.page.getByText("جارٍ إعداد التقرير اليومي", { exact: false }).count()).toBe(1);
      expect(await f.page.getByText(`ليوم ${friendlyDateNamed(requested)}`, { exact: false }).isVisible()).toBe(true);
      expect(await f.page.locator('[data-testid="print-report"]').count()).toBe(0);
      await f.page.getByTestId("daily-report").screenshot({ path: `${ARTIFACTS}/daily-report-loading-390.png` });

      // Error: an explicit alert with a retry, and nothing printable.
      await f.complete({ message: "Synthetic design failure" }, 500);
      await expect.poll(() => f.page.getByRole("alert").filter({ hasText: "Synthetic design failure" }).count()).toBe(1);
      expect(await f.page.getByRole("button", { name: "أعد المحاولة", exact: true }).count()).toBe(1);
      expect(await f.page.locator('[aria-label="الحضور"]').count()).toBe(0);
      expect(await f.page.locator('[data-testid="print-report"]').count()).toBe(0);
      expect(await f.page.locator('a[href*="wa.me"]').count()).toBe(0);
      await f.page.getByTestId("daily-report").screenshot({ path: `${ARTIFACTS}/daily-report-error-390.png` });

      // Valid empty day: a valid report that says so — no alert, print and share intact.
      await f.page.getByRole("button", { name: "أعد المحاولة", exact: true }).click();
      await expect.poll(() => f.page.evaluate(() => (window as unknown as FixtureWindow).__dailyDesignReports.length)).toBe(2);
      await f.page.evaluate(async (payload) => {
        const pending = (window as unknown as FixtureWindow).__dailyDesignReports[1];
        pending.respond(200);
        pending.body(payload);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }, {
        ...designDayPayload(requested),
        report: {
          arrived: 0, done: 0, stillOpen: 0, noShow: 0, cancelled: 0,
          averageWaitMinutes: 0, longestWaitMinutes: 0, averageChairMinutes: 0,
          booked: 0, unresolved: 0,
        },
        plannedToday: [],
      });
      await expect.poll(() => f.page.getByText("لا حضور ولا مواعيد مسجّلة في هذا اليوم", { exact: false }).count()).toBe(1);
      expect(await f.page.getByRole("alert").count()).toBe(0);
      expect(await f.page.locator('[data-testid="print-report"]').count()).toBe(1);
      expect(await f.page.locator('a[href*="wa.me"]').count()).toBe(1);
      await f.page.getByTestId("daily-report").screenshot({ path: `${ARTIFACTS}/daily-report-empty-day-390.png` });

      // Cleared date: a truthful notice, no request, nothing stale.
      await f.page.getByTestId("daily-report").locator('input[type="date"]').fill("");
      await expect.poll(() => f.page.getByText("التاريخ المختار غير صالح", { exact: false }).count()).toBe(1);
      await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await f.page.evaluate(() => (window as unknown as FixtureWindow).__dailyDesignReports.length)).toBe(2);
      expect(await f.page.locator('[data-testid="print-report"]').count()).toBe(0);
      await f.page.getByTestId("daily-report").screenshot({ path: `${ARTIFACTS}/daily-report-invalid-date-390.png` });
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("prints real A4 paper: identity once, no interactive controls, no split cards", async () => {
    const f = await fixture(1280);
    try {
      const requested = await f.page.getByLabel("تاريخ التقرير").inputValue();
      await f.complete(designDayPayload(requested));
      await expect.poll(() => f.page.locator('[aria-label="الحضور"]').count()).toBe(1);

      // Read the paper header's own identity text from the DOM first — the
      // seeded clinic name is whatever the harness DB carries.
      const paperIdentity = await f.page.locator("main > div.print\\:block").innerText();

      await f.page.evaluate(async () => {
        await document.fonts.ready;
        window.scrollTo(0, 0);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      const pdfPath = `${ARTIFACTS}/daily-report-print-a4.pdf`;
      const pdf = await f.page.pdf({ path: pdfPath, format: "A4", landscape: false,
        printBackground: true, displayHeaderFooter: false, preferCSSPageSize: false });
      expect(pdf.length).toBeGreaterThan(1000);
      expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect(pdf.subarray(-1024).toString("ascii")).toContain("%%EOF");
      expect(await readFile(pdfPath)).toEqual(pdf);

      // Read the actual paginated artifact, not the screen DOM.
      const pdfText = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
        encoding: "utf8", maxBuffer: 5 * 1024 * 1024,
      }).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
      const pages = pdfText.split("\f").filter((text) => text.trim());
      expect(pages.length).toBeGreaterThanOrEqual(1);

      // Page 1 carries the center identity, the title and the report date — once.
      expect(pages[0]).toContain("تقرير الأداء اليومي");
      expect(pages[0]).toContain(friendlyDateNamed(requested));
      const identityLine = paperIdentity.split("\n").find((line) => line.trim().length > 3);
      expect(identityLine && pages[0].includes(identityLine.trim()), "paper carries the center identity").toBe(true);
      for (const page of pages.slice(1)) {
        expect(page).not.toContain("تقرير الأداء اليومي");
      }

      // No interactive control leaks onto paper.
      for (const interactive of [
        "طباعة التقرير", "افتح الملف", "إرسال ملخص التقرير عبر واتساب", "اليوم السابق",
        "اليوم التالي", "كل المواعيد", "فتح شاشة المختبر", "متابعتها في المواعيد",
        "أعد المحاولة", "تاريخ التقرير",
      ]) {
        expect(pdfText).not.toContain(interactive);
      }

      // Every stat label shares its PDF page with its own number — a card split
      // between pages would separate them.
      const samePage = [
        ["إجمالي الحضور", "17"], ["اكتملت زيارتهم", "13"], ["لم يحضروا", "4"],
        ["متوسط وقت الانتظار", "12"], ["أطول وقت انتظار", "25"], ["متوسط الجلسة على الكرسي", "34"],
        ["تراكيب متأخرة بالمختبر", "3"], ["جاهزة للتركيب", "2"],
        ["مواعيد غير مغلقة ليوم التقرير", "5"],
        ["حجوزات اليوم التالي", friendlyDateNamed(addDays(requested, 1))],
      ] as const;
      for (const [label, value] of samePage) {
        const pageIndex = pages.findIndex((text) => text.includes(label));
        expect(pageIndex, `label «${label}» must appear on paper`).toBeGreaterThanOrEqual(0);
        const number = new RegExp(`(?<![0-9])${value}(?![0-9])`);
        expect(pages[pageIndex], `«${label}» and its value must share one page`).toMatch(number);
      }

      // The planned list content survives on paper (content, not buttons).
      expect(pdfText).toContain("مريض اصطناعي 1");
      f.assertIsolated();
    } finally { await f.context.close(); }
  });
});
