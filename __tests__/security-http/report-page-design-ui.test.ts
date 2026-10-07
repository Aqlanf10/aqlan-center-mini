import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    patientName: `مريض اصطناعي ${["ألف", "باء", "جيم", "دال", "هاء", "واو", "زاي", "حاء"][index]}`,
    patientNumber: `SYN-${100 + index}`,
    title,
    doctorName: index % 2 === 0 ? "طبيب اصطناعي أ" : "طبيب اصطناعي ب",
    time: `${String(9 + index).padStart(2, "0")}:30`,
    durationMinutes: 30,
    status: index === 2 ? "in_progress" : "booked",
    appointmentId: index + 10,
  }));
}

/** Screen fixture exercises calm/warning/danger cards. The paper test replaces
 * counts with unique three-digit anchors for actual PDF geometry checks. */
function designDayPayload(date: string) {
  return {
    date,
    nextDate: addDays(date, 1),
    report: {
      arrived: 17, done: 13, stillOpen: 4, noShow: 4, cancelled: 0,
      averageWaitMinutes: 37, longestWaitMinutes: 58, averageChairMinutes: 43,
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
  await mkdir(ARTIFACTS, { recursive: true });
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

/** Composite each text/background pixel through its ancestor opacity groups.
 * Canvas resolves browser-supported CSS colors (rgb/rgba, space syntax, oklch,
 * color(srgb...), etc.) to sRGB, rather than guessing from one serialization. */
async function statContrast(page: Page) {
  return page.locator('[data-report-stat]').evaluateAll((cards) => {
    type Pixel = [number, number, number, number];
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("contrast: no color conversion context");
    const color = (css: string): Pixel => {
      if (!CSS.supports("color", css)) throw new Error(`contrast: unsupported color ${css}`);
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      return [pixel[0] / 255, pixel[1] / 255, pixel[2] / 255, pixel[3] / 255];
    };
    const over = (front: Pixel, back: Pixel): Pixel => {
      const alpha = front[3] + back[3] * (1 - front[3]);
      if (!alpha) return [0, 0, 0, 0];
      return [0, 1, 2].map((index) =>
        (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha,
      ).concat(alpha) as Pixel;
    };
    const luminance = (pixel: Pixel) => {
      const linear = pixel.slice(0, 3).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const effective = (element: Element) => {
      let text = color(getComputedStyle(element).color);
      let background: Pixel = [0, 0, 0, 0];
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        // Fail closed for effects not represented by this pixel model.
        if (style.backgroundImage !== "none" || style.filter !== "none" || style.mixBlendMode !== "normal") {
          throw new Error("contrast: unsupported compositing effect");
        }
        const layer = color(style.backgroundColor);
        text = over(text, layer);
        background = over(background, layer);
        const opacity = Number(style.opacity);
        text[3] *= opacity;
        background[3] *= opacity;
      }
      const white: Pixel = [1, 1, 1, 1];
      const a = luminance(over(text, white)), b = luminance(over(background, white));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    return cards.map((card) => ({
      label: card.querySelector('[data-stat-label]')!.textContent,
      samples: Array.from(card.querySelectorAll('[data-stat-label], [data-stat-value], [data-stat-unit]'))
        .map((element) => ({ text: element.textContent, ratio: effective(element) })),
    }));
  });
}

async function assertStatContrast(page: Page) {
  const cards = await statContrast(page);
  expect(cards, "contrast covers all six attendance/wait cards").toHaveLength(6);
  for (const card of cards) {
    expect(card.samples.length).toBeGreaterThanOrEqual(2);
    for (const sample of card.samples) {
      expect(sample.ratio, `contrast for ${card.label}: ${sample.text}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  return cards;
}

type PdfWord = { text: string; xMin: number; xMax: number; yMin: number; yMax: number };
type PdfPage = { width: number; height: number; words: PdfWord[] };
const plain = (text: string) => text.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
const wordsOf = (text: string) => plain(text).split(/\s+/).map((word) => word.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);

async function inspectPdf(page: Page, path: string) {
  const text = plain(execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], {
    encoding: "utf8", maxBuffer: 5 * 1024 * 1024,
  }));
  const xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", path, "-"], {
    encoding: "utf8", maxBuffer: 5 * 1024 * 1024,
  });
  const pages: PdfPage[] = await page.evaluate((xml) => {
    const document = new DOMParser().parseFromString(xml, "application/xml");
    if (document.querySelector("parsererror")) throw new Error("Invalid PDF bounding-box XML");
    return Array.from(document.getElementsByTagName("page")).map((page) => ({
      width: Number(page.getAttribute("width")), height: Number(page.getAttribute("height")),
      words: Array.from(page.getElementsByTagName("word")).map((word) => ({
        text: word.textContent || "", xMin: Number(word.getAttribute("xMin")),
        xMax: Number(word.getAttribute("xMax")), yMin: Number(word.getAttribute("yMin")),
        yMax: Number(word.getAttribute("yMax")),
      })),
    }));
  }, xml);
  for (const page of pages) for (const word of page.words) word.text = plain(word.text);
  return { text, pages };
}

type PdfEvidence = Awaited<ReturnType<typeof inspectPdf>>;
/** A unique value anchors the actual PDF glyphs, then its full label must be
 * nearby in the same card. A repeated chair count/time cannot satisfy this. */
function assertPdfContent(evidence: PdfEvidence) {
  const { text, pages } = evidence;
  expect(pages.length).toBeGreaterThanOrEqual(1);
  for (const page of pages) {
    // Chromium quantizes mm dimensions through CSS pixels; allow 1.5pt
    // rounding while still rejecting Letter and other page formats.
    expect(Math.abs(page.width - 595.28), "A4 paper width").toBeLessThanOrEqual(1.5);
    expect(Math.abs(page.height - 841.89), "A4 paper height").toBeLessThanOrEqual(1.5);
    for (const word of page.words) {
      expect(word.xMin, `PDF left cutoff: ${word.text}`).toBeGreaterThanOrEqual(0);
      expect(word.yMin, `PDF top cutoff: ${word.text}`).toBeGreaterThanOrEqual(0);
      expect(word.xMax, `PDF right cutoff: ${word.text}`).toBeLessThanOrEqual(page.width);
      expect(word.yMax, `PDF bottom cutoff: ${word.text}`).toBeLessThanOrEqual(page.height);
    }
  }
  const nearby = (anchor: string, label: string, horizontal: number, above: number, below: number) => {
    const hits = pages.flatMap((page) => page.words.filter((word) => word.text === anchor).map((word) => ({ page, word })));
    expect(hits, `PDF unique anchor ${anchor}`).toHaveLength(1);
    const { page, word } = hits[0];
    const neighbors = page.words.filter((candidate) =>
      candidate.yMin >= word.yMin - above && candidate.yMax <= word.yMax + below
      && candidate.xMax >= word.xMin - horizontal && candidate.xMin <= word.xMax + horizontal,
    ).flatMap((candidate) => wordsOf(candidate.text));
    for (const token of wordsOf(label)) {
      expect(neighbors, `PDF association ${anchor} with ${label}`).toContain(token);
    }
  };
  for (const [label, value] of [
    ["إجمالي الحضور", "117"], ["اكتملت زيارتهم", "113"], ["لم يحضروا", "104"],
    ["متوسط وقت الانتظار", "37"], ["أطول وقت انتظار", "58"], ["متوسط الجلسة على الكرسي", "43"],
  ]) nearby(value, label, 62, 1, 35);
  for (const [label, value] of [
    ["تراكيب متأخرة بالمختبر:", "103"], ["جاهزة للتركيب:", "105"],
    ["مواعيد غير مغلقة ليوم التقرير:", "109"],
  ]) nearby(value, label, 260, 4, 4);
  for (const row of plannedRows()) {
    expect(text, `PDF contains planned patient ${row.patientName}`).toContain(row.patientName);
    expect(text, `PDF contains planned title ${row.title}`).toContain(row.title);
    // Each unique name's final word anchors its own time, title, duration and doctor.
    nearby(wordsOf(row.patientName).at(-1)!, `${row.title} ${row.durationMinutes} دقيقة ${row.doctorName}`, 350, 1, 24);
    nearby(wordsOf(row.patientName).at(-1)!, row.time, 350, 3, 3);
  }
}

async function savePdf(page: Page, path: string) {
  await mkdir(ARTIFACTS, { recursive: true });
  const pdf = await page.pdf({ path, format: "A4", landscape: false,
    printBackground: true, displayHeaderFooter: false, preferCSSPageSize: false });
  expect(pdf.length).toBeGreaterThan(1000);
  expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  expect(pdf.subarray(-1024).toString("ascii")).toContain("%%EOF");
  expect(await readFile(path)).toEqual(pdf);
  return inspectPdf(page, path);
}

describe("built daily report design evidence", () => {
  it.each([1280, 390, 320])("renders a comfortable layout with no clipped text at width %s", async (width) => {
    const f = await fixture(width);
    try {
      // The requested date comes from the labeled field — the ISO contract the API received.
      const requested = await f.page.getByLabel("تاريخ التقرير", { exact: true }).inputValue();
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
      await assertStatContrast(f.page);
      const occupancy = await f.page.getByTestId("report-occupancy-track").evaluate((track) => {
        const fill = track.firstElementChild!;
        const a = track.getBoundingClientRect(), b = fill.getBoundingClientRect();
        const style = getComputedStyle(track);
        return { direction: style.direction, rightInset: a.right - b.right,
          proportion: b.width / (a.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)) };
      });
      expect(occupancy.direction).toBe("rtl");
      expect(occupancy.rightInset).toBeLessThanOrEqual(2);
      expect(occupancy.proportion).toBeCloseTo(0.75, 2);

      await mkdir(ARTIFACTS, { recursive: true });
      await f.page.getByTestId("daily-report").screenshot({ path: `${ARTIFACTS}/daily-report-design-${width}.png` });
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("captures the loading, error, empty-day and cleared-date states at 390px", async () => {
    const f = await fixture(390);
    try {
      const requested = await f.page.getByLabel("تاريخ التقرير", { exact: true }).inputValue();

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

  it("rejects low contrast on a non-first card and through ancestor opacity", async () => {
    const f = await fixture(390);
    try {
      const requested = await f.page.getByLabel("تاريخ التقرير", { exact: true }).inputValue();
      await f.complete(designDayPayload(requested));
      await expect.poll(() => f.page.locator('[data-report-stat]').count()).toBe(6);
      await assertStatContrast(f.page);
      const label = f.page.locator('[data-stat-label]').last();
      await label.evaluate((el) => { el.style.color = "color(srgb 1 1 1)"; });
      await expect(assertStatContrast(f.page)).rejects.toThrow(/contrast/);
      await label.evaluate((el) => { el.style.removeProperty("color"); });
      const card = f.page.locator('[data-report-stat]').last();
      await card.evaluate((el) => { el.style.opacity = "0.1"; });
      await expect(assertStatContrast(f.page)).rejects.toThrow(/contrast/);
      await card.evaluate((el) => { el.style.removeProperty("opacity"); });
      await assertStatContrast(f.page);
      f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("prints actual A4 paper with unique value associations and rejects a cut-off final row", async () => {
    const f = await fixture(320);
    try {
      const requested = await f.page.getByLabel("تاريخ التقرير", { exact: true }).inputValue();
      const payload = designDayPayload(requested);
      await f.complete({
        ...payload,
        report: { ...payload.report, arrived: 117, done: 113, noShow: 104, unresolved: 109 },
        tomorrow: { ...payload.tomorrow, percent: 95 },
        lab: { ...payload.lab, late: 103, waitingFitting: 105 },
      });
      await expect.poll(() => f.page.locator('[data-report-stat]').count()).toBe(6);
      await assertNoOverflow(f.page, 320);
      const screenContrast = await assertStatContrast(f.page);
      await f.page.getByTestId("daily-report").screenshot({ path: `${ARTIFACTS}/daily-report-high-occupancy-320.png` });

      // Actual controls receive unique witnesses before print: a leaked next-day
      // button is detectable without banning the legitimate next-day heading.
      const controlMarkers = await f.page.getByTestId("daily-report").locator("button, a, label").evaluateAll((controls) =>
        controls.map((control, index) => {
          const marker = `REPORT_CONTROL_${String(index).padStart(3, "0")}`;
          control.append(document.createTextNode(marker));
          return marker;
        }),
      );
      await f.page.setViewportSize({ width: 1280, height: 1000 });
      await f.page.emulateMedia({ media: "print" });
      await f.page.evaluate(async () => {
        await document.fonts.ready;
        window.scrollTo(0, 0);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      for (const control of await f.page.getByTestId("daily-report").locator("button, a, input").all()) {
        expect(await control.isVisible(), "interactive control hidden on paper").toBe(false);
      }
      const header = f.page.getByTestId("report-paper-header");
      const paperIdentity = (await header.locator("p").first().innerText()).trim();
      const paperContrast = await assertStatContrast(f.page);
      const paperColors = await f.page.getByTestId("daily-report").evaluate((report) => ({
        body: getComputedStyle(document.body).backgroundColor,
        report: getComputedStyle(report).backgroundColor,
        cards: Array.from(report.querySelectorAll('[data-print-card]')).map((card) => getComputedStyle(card).backgroundColor),
        badge: getComputedStyle(report.querySelector('[data-testid="report-occupancy-badge"]')!).color,
      }));
      expect(paperColors.body).toBe("rgb(255, 255, 255)");
      expect(paperColors.report).toBe("rgb(255, 255, 255)");
      expect(paperColors.cards.every((color) => color === "rgb(255, 255, 255)")).toBe(true);
      expect(paperColors.badge).toBe("rgb(0, 0, 0)");

      const pdfPath = `${ARTIFACTS}/daily-report-print-a4.pdf`;
      const evidence = await savePdf(f.page, pdfPath);
      assertPdfContent(evidence);
      expect(evidence.pages.length, "dense fixture actually exercises pagination").toBeGreaterThanOrEqual(2);
      const pages = evidence.text.split("\f").filter((text) => text.trim());
      expect(pages[0]).toContain(paperIdentity);
      expect(pages[0]).toContain("تقرير الأداء اليومي");
      expect(pages[0]).toContain(friendlyDateNamed(requested));
      expect(evidence.text.split("تقرير الأداء اليومي")).toHaveLength(2);
      expect(evidence.text.split(friendlyDateNamed(requested))).toHaveLength(2);
      const nextPage = pages.find((text) => text.includes("حجوزات اليوم التالي"));
      expect(nextPage, "next-day heading keeps its explicit date on the same page").toContain(friendlyDateNamed(addDays(requested, 1)));
      expect(evidence.text).toContain("أعمال المختبر — الحالة الآن");
      expect(evidence.text).toContain("إشغال 95٪");
      for (const marker of controlMarkers) expect(evidence.text).not.toContain(marker);
      for (const interactive of [
        "طباعة التقرير", "افتح الملف", "إرسال ملخص التقرير عبر واتساب", "اليوم السابق",
        "كل المواعيد", "فتح شاشة المختبر", "متابعتها في المواعيد", "أعد المحاولة", "تاريخ التقرير",
      ]) expect(evidence.text).not.toContain(interactive);

      // Move one unique stat value away from its card in a real PDF. The
      // association check must reject it even though the value still exists.
      await f.page.locator('[data-stat-value]').first().evaluate((value) => {
        value.setAttribute("data-moved-stat-value", "");
        document.querySelector('[data-testid="daily-report"]')!.append(value);
      });
      const separated = await savePdf(f.page, `${ARTIFACTS}/daily-report-association-negative.pdf`);
      expect(separated.text).toContain("117");
      expect(() => assertPdfContent(separated)).toThrow(/PDF association/);
      await f.page.locator('[data-moved-stat-value]').evaluate((value) => {
        document.querySelector('[data-report-stat]')!.prepend(value);
        value.removeAttribute("data-moved-stat-value");
      });

      // Clip the final planned row in a third real PDF; the same validator must
      // refuse it. Never overwrite/upload the accepted positive PDF with either
      // synthetic negative witness.
      await f.page.locator('[data-planned-row]').last().evaluate((row) => {
        row.style.height = "0px";
        row.style.minHeight = "0px";
        row.style.padding = "0px";
        row.style.border = "0px";
        row.style.overflow = "hidden";
      });
      const negative = await savePdf(f.page, `${ARTIFACTS}/daily-report-cutoff-negative.pdf`);
      expect(() => assertPdfContent(negative)).toThrow(/PDF/);
      expect(negative.text).not.toContain(plannedRows().at(-1)!.patientName);
      await writeFile(`${ARTIFACTS}/daily-report-design-proof.json`, JSON.stringify({
        synthetic: true, workflowCommit: process.env.GITHUB_SHA || null,
        screenContrast, paperContrast, paperColors, pdfPages: evidence.pages.length,
        coveredStats: 6, coveredPlannedRows: plannedRows().length,
        uniqueControlMarkersAbsent: controlMarkers.length,
        separatedStatValueRejected: true, clippedFinalRowRejected: true,
      }, null, 2));
      f.assertIsolated();
    } finally { await f.context.close(); }
  });
});
