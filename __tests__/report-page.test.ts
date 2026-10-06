import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, clinicDateString } from "../lib/schedule";
import { friendlyDateLong } from "../lib/reminders";
import { reportText } from "../lib/report";
import { CLINIC_ZONE_FALLBACK } from "../lib/clinicZone";

// Execute the real daily-report page's effects and render output without
// browser/DB. Response order is controlled with deferred promises — no timers.
const harness = vi.hoisted(() => ({
  states: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[],
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [harness.states[index], (next: unknown) => {
      harness.states[index] = typeof next === "function" ? next(harness.states[index]) : next;
    }];
  }, useEffect: (effect: () => void | (() => void)) => { harness.effects.push(effect); } };
});
vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ children }: { children: ReactNode }) => createElement("header", null, children),
  StatCard: ({ label, value }: { label: string; value: string | number }) =>
    createElement("div", { "data-stat": String(label) }, String(value)),
}));
vi.mock("../components/SettingsProvider", () => ({
  useClinicName: () => "Synthetic clinic",
  useSetting: () => "Synthetic",
}));
vi.mock("../components/Icon", () => ({ Logo: () => null }));
vi.mock("../components/PrintButton", () => ({ PrintButton: () => createElement("button", { "data-testid": "print-report" }, "Print") }));
import ReportPage from "../app/report/page";

// Page useState order: date, loadedFeed, loading, failure, retry.
const DATE = 0, LOADED = 1, LOADING = 2, FAILURE = 3, RETRY = 4;
const today = () => clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);

function dayPayload(date: string, arrived: number, labLate = 0): Record<string, unknown> {
  return {
    date,
    nextDate: addDays(date, 1),
    report: {
      arrived, done: Math.max(0, arrived - 3), stillOpen: 1, noShow: 2, cancelled: 0,
      averageWaitMinutes: 12, longestWaitMinutes: 25, averageChairMinutes: 34,
      booked: arrived + 2, unresolved: 1,
    },
    tomorrow: { booked: 6, bookedMinutes: 180, capacityMinutes: 360, percent: 50 },
    lab: { outstanding: 4, late: labLate, dueToday: 1, waitingFitting: 2 },
    chairs: 4,
    plannedToday: [],
  };
}
const emptyDay = (date: string) => ({
  ...dayPayload(date, 0),
  report: {
    arrived: 0, done: 0, stillOpen: 0, noShow: 0, cancelled: 0,
    averageWaitMinutes: 0, longestWaitMinutes: 0, averageChairMinutes: 0,
    booked: 0, unresolved: 0,
  },
  plannedToday: [],
});

function render() {
  harness.cursor = 0; harness.effects = [];
  return renderToStaticMarkup(createElement(ReportPage));
}
/** Runs the latest render's effect once; returns its cleanup (invalid dates have none). */
function start() { render(); return harness.effects[0]() as (() => void) | undefined; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (payload: unknown, status = 200): Response =>
  ({ status, ok: status < 300, json: async () => payload }) as Response;
async function settle() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); return render(); }

/** No report values, no print action and no WhatsApp share link may exist. */
function noReport(html: string) {
  expect(html).not.toContain("تقرير يوم:");
  expect(html).not.toContain('data-testid="print-report"');
  expect(html).not.toContain("wa.me");
}
function shareText(html: string): string | null {
  const match = html.match(/href="https:\/\/wa\.me\/\?text=([^"]*)"/);
  return match ? decodeURIComponent(match[1]) : null;
}
const fetchedDate = (call: number) => {
  const url = vi.mocked(fetch).mock.calls[call][0] as string;
  return new URL(url, "http://synthetic").searchParams.get("date");
};

beforeEach(() => {
  harness.states = [today(), null, true, null, 0];
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("daily report page — matching day, print and share", () => {
  it("renders the requested day with print and a share link for that same day", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(dayPayload(today(), 17, 3)));
    start();
    const html = await settle();
    expect(fetchedDate(0)).toBe(today());
    expect(html).toContain(`تقرير يوم: ${friendlyDateLong(today())}`);
    expect(html).toContain('data-testid="print-report"');
    const shared = shareText(html);
    expect(shared).toContain(`تقرير ${friendlyDateLong(today())}`);
    expect(shared).toContain("الحضور: 17");
    // Current lab semantics stay as delivered by the route — no historical rewrite.
    expect(shared).toContain("تراكيب متأخرة: 3");
    expect(html).toContain("تراكيب متأخرة بالمختبر: 3");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a correct empty-activity day a valid report, not an error or endless loading", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(emptyDay(today())));
    start();
    const html = await settle();
    expect(html).toContain(`تقرير يوم: ${friendlyDateLong(today())}`);
    expect(html).toContain('data-testid="print-report"');
    expect(shareText(html)).not.toBeNull();
    expect(html).not.toContain("جارٍ إعداد التقرير اليومي");
    expect(html).not.toContain('role="alert"');
  });
});

describe("daily report selected-date identity", () => {
  it("withholds the previous report, print and share between a date change and its effect", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(dayPayload(today(), 17)));
    start();
    expect(await settle()).toContain('data-testid="print-report"');
    // Commit the new selected date but deliberately do not run its passive effect.
    harness.states[DATE] = addDays(today(), -1);
    const html = render();
    noReport(html);
    expect(html).toContain("جارٍ إعداد التقرير اليومي");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["headers", "body"])("withholds old %s that finish after a date render but before effect cleanup", async (boundary) => {
    const headers = deferred<Response>();
    const body = deferred<unknown>();
    if (boundary === "headers") vi.mocked(fetch).mockReturnValueOnce(headers.promise);
    else vi.mocked(fetch).mockResolvedValueOnce({ status: 200, ok: true, json: () => body.promise } as Response);
    const cleanup = start();
    await settle();
    harness.states[DATE] = addDays(today(), -1);
    render();
    if (boundary === "headers") headers.resolve(response(dayPayload(today(), 17)));
    else body.resolve(dayPayload(today(), 17));
    noReport(await settle());
    cleanup?.();
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});

describe("daily report late-response containment", () => {
  // a and b are deliberately non-adjacent: the "tomorrow load" of one day must
  // never render the other day's long date text.
  const a = () => addDays(today(), -1), b = () => addDays(today(), -3);

  it("keeps day B when day A's response arrives after B's success", async () => {
    harness.states[DATE] = a();
    const older = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(older.promise);
    const first = start();
    first?.();
    harness.states[DATE] = b();
    vi.mocked(fetch).mockResolvedValueOnce(response(dayPayload(b(), 42)));
    start();
    const html = await settle();
    expect(html).toContain(`تقرير يوم: ${friendlyDateLong(b())}`);
    older.resolve(response(dayPayload(a(), 17)));
    const afterLate = await settle();
    expect(afterLate).toContain(`تقرير يوم: ${friendlyDateLong(b())}`);
    expect(afterLate).not.toContain(friendlyDateLong(a()));
    expect(harness.states[LOADED]).toEqual({ requestedDate: b(), feed: dayPayload(b(), 42) });
    expect(harness.states[FAILURE]).toBeNull();
    expect(harness.states[LOADING]).toBe(false);
  });

  it("ignores a late rejection after the newer day succeeded", async () => {
    harness.states[DATE] = a();
    const older = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(older.promise);
    const first = start();
    first?.();
    harness.states[DATE] = b();
    vi.mocked(fetch).mockResolvedValueOnce(response(dayPayload(b(), 42)));
    start();
    await settle();
    older.reject(new Error("obsolete network failure"));
    const html = await settle();
    expect(html).toContain(`تقرير يوم: ${friendlyDateLong(b())}`);
    expect(harness.states[FAILURE]).toBeNull();
    expect(harness.states[LOADING]).toBe(false);
  });

  it("ignores a late success after the newer day failed", async () => {
    harness.states[DATE] = a();
    const older = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(older.promise);
    const first = start();
    first?.();
    harness.states[DATE] = b();
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: "تعذّر تحميل التقرير." }, 500));
    start();
    const failed = await settle();
    noReport(failed);
    older.resolve(response(dayPayload(a(), 17)));
    const html = await settle();
    noReport(html);
    expect(html).toContain("تعذّر تحميل التقرير.");
    expect(harness.states[LOADED]).toBeNull();
    expect(harness.states[FAILURE]).toEqual({ requestedDate: b(), message: "تعذّر تحميل التقرير." });
  });

  it("keeps the loading indicator on when an old request ends while the current one continues", async () => {
    harness.states[DATE] = a();
    const older = deferred<Response>();
    const current = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise);
    const first = start();
    first?.();
    harness.states[DATE] = b();
    start();
    older.resolve(response(dayPayload(a(), 17)));
    const during = await settle();
    noReport(during);
    expect(during).toContain("جارٍ إعداد التقرير اليومي");
    expect(harness.states[LOADING]).toBe(true);
    current.resolve(response(dayPayload(b(), 42)));
    const html = await settle();
    expect(html).toContain(`تقرير يوم: ${friendlyDateLong(b())}`);
    expect(harness.states[LOADING]).toBe(false);
  });

  it("A→B→A with stale traffic landing before the current response stays pending until it arrives", async () => {
    harness.states[DATE] = a();
    const staleA = deferred<Response>();
    const staleB = deferred<Response>();
    const current = deferred<Response>();
    vi.mocked(fetch)
      .mockReturnValueOnce(staleA.promise)  // date A
      .mockReturnValueOnce(staleB.promise)   // date B
      .mockReturnValueOnce(current.promise); // date A again
    const first = start();
    first?.();
    harness.states[DATE] = b();
    const second = start();
    second?.();
    harness.states[DATE] = a();
    start();
    expect(fetchedDate(0)).toBe(a());
    expect(fetchedDate(1)).toBe(b());
    expect(fetchedDate(2)).toBe(a());
    // Stale B succeeds, then stale A succeeds — both belong to retired effects.
    staleB.resolve(response(dayPayload(b(), 42)));
    let html = await settle();
    noReport(html);
    expect(harness.states[LOADING]).toBe(true);
    staleA.resolve(response(dayPayload(a(), 17)));
    html = await settle();
    noReport(html);
    expect(harness.states[LOADING]).toBe(true);
    // Only the latest request for the selected date may paint.
    current.resolve(response(dayPayload(a(), 23)));
    html = await settle();
    expect(html).toContain(`تقرير يوم: ${friendlyDateLong(a())}`);
    expect(html).not.toContain(friendlyDateLong(b()));
    expect(harness.states[LOADED]).toEqual({ requestedDate: a(), feed: dayPayload(a(), 23) });
  });

  it("A→B→A with the current response first keeps it against later stale completions", async () => {
    harness.states[DATE] = a();
    const staleA = deferred<Response>();
    const staleB = deferred<Response>();
    const current = deferred<Response>();
    vi.mocked(fetch)
      .mockReturnValueOnce(staleA.promise)  // date A
      .mockReturnValueOnce(staleB.promise)   // date B
      .mockReturnValueOnce(current.promise); // date A again
    const first = start();
    first?.();
    harness.states[DATE] = b();
    const second = start();
    second?.();
    harness.states[DATE] = a();
    start();
    current.resolve(response(dayPayload(a(), 23)));
    let html = await settle();
    expect(html).toContain(`تقرير يوم: ${friendlyDateLong(a())}`);
    // A same-date stale success and a different-date stale success both arrive late.
    staleA.resolve(response(dayPayload(a(), 17)));
    staleB.resolve(response(dayPayload(b(), 42)));
    html = await settle();
    expect(html).toContain(`تقرير يوم: ${friendlyDateLong(a())}`);
    expect(html).not.toContain(friendlyDateLong(b()));
    expect(harness.states[LOADED]).toEqual({ requestedDate: a(), feed: dayPayload(a(), 23) });
    expect(harness.states[FAILURE]).toBeNull();
    expect(harness.states[LOADING]).toBe(false);
  });

  it("does not repopulate state after unmount", async () => {
    const pending = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    const cleanup = start();
    cleanup?.();
    pending.resolve(response(dayPayload(today(), 17)));
    await settle();
    expect(harness.states[LOADED]).toBeNull();
    expect(harness.states[LOADING]).toBe(true);
  });
});

describe("daily report JSON completion after effect retirement", () => {
  it.each([
    ["success", "pending"], ["rejection", "pending"],
    ["success", "success"], ["rejection", "success"],
    ["success", "failure"], ["rejection", "failure"],
  ] as const)("ignores late JSON %s while the newer selected day is %s", async (outcome, currentState) => {
    const a = addDays(today(), -1), b = addDays(today(), -3);
    harness.states[DATE] = a;
    const oldBody = deferred<unknown>();
    const bodyStarted = deferred<void>();
    const current = deferred<Response>();
    vi.mocked(fetch)
      .mockResolvedValueOnce({ status: 200, ok: true, json: () => {
        bodyStarted.resolve();
        return oldBody.promise;
      } } as Response)
      .mockReturnValueOnce(current.promise);
    const cleanup = start();
    // The first ownership check has passed and json() is really in flight.
    // Retiring before this barrier would only exercise stale response headers.
    await bodyStarted.promise;
    cleanup?.();
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    harness.states[DATE] = b;
    start();
    if (currentState === "success") current.resolve(response(dayPayload(b, 42)));
    if (currentState === "failure") current.resolve(response({ message: "Current report failure" }, 500));
    await settle();
    if (outcome === "success") oldBody.resolve(dayPayload(a, 17));
    else oldBody.reject(new Error("Obsolete JSON failure"));
    const html = await settle();
    expect(html).not.toContain(friendlyDateLong(a));
    if (currentState === "success") {
      expect(harness.states[LOADED]).toEqual({ requestedDate: b, feed: dayPayload(b, 42) });
      expect(html).toContain(`تقرير يوم: ${friendlyDateLong(b)}`);
      expect(shareText(html)).toContain("الحضور: 42");
    } else {
      noReport(html);
      expect(harness.states[LOADED]).toBeNull();
    }
    expect(harness.states[FAILURE]).toEqual(currentState === "failure"
      ? { requestedDate: b, message: "Current report failure" } : null);
    expect(harness.states[LOADING]).toBe(currentState === "pending");
    if (currentState === "pending") {
      expect(html).toContain("جارٍ إعداد التقرير اليومي");
      current.resolve(response(dayPayload(b, 42)));
      expect(await settle()).toContain(`تقرير يوم: ${friendlyDateLong(b)}`);
    }
  });
});

describe("daily report StrictMode same-date effect replay", () => {
  it.each([
    ["headers", "success", false], ["headers", "rejection", false],
    ["headers", "success", true], ["headers", "rejection", true],
    ["body", "success", false], ["body", "rejection", false],
    ["body", "success", true], ["body", "rejection", true],
  ] as const)("ignores retired setup %s %s (replacement completes first: %s)", async (boundary, outcome, currentFirst) => {
    const selected = today();
    const oldHeaders = deferred<Response>();
    const oldBody = deferred<unknown>();
    const bodyStarted = deferred<void>();
    const current = deferred<Response>();
    const delayedResponse = { status: 200, ok: true, json: () => {
      bodyStarted.resolve();
      return oldBody.promise;
    } } as Response;
    vi.mocked(fetch)
      .mockReturnValueOnce(boundary === "headers" ? oldHeaders.promise : Promise.resolve(delayedResponse))
      .mockReturnValueOnce(current.promise);
    render();
    const setup = harness.effects[0];
    const cleanup = setup();
    // Headers: synchronous setup → cleanup → setup, as StrictMode replays it.
    // Body: also prove ownership if cleanup occurs after json() has started.
    if (boundary === "body") await bodyStarted.promise;
    // Use the exact same committed effect: no date or retry change, no new
    // render closure and no reset of the page's state.
    if (typeof cleanup === "function") cleanup();
    const replacementCleanup = setup();
    expect(fetchedDate(0)).toBe(selected);
    expect(fetchedDate(1)).toBe(selected);
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.mocked(fetch).mock.calls[1][1]?.signal?.aborted).toBe(false);
    if (currentFirst) {
      current.resolve(response(dayPayload(selected, 23)));
      await settle();
    }
    if (boundary === "headers") {
      if (outcome === "success") oldHeaders.resolve(response(dayPayload(selected, 17)));
      else oldHeaders.reject(new Error("Retired same-date request failure"));
    } else {
      if (outcome === "success") oldBody.resolve(dayPayload(selected, 17));
      else oldBody.reject(new Error("Retired same-date JSON failure"));
    }
    const html = await settle();
    expect(harness.states[FAILURE]).toBeNull();
    expect(harness.states[LOADING]).toBe(!currentFirst);
    if (currentFirst) {
      expect(harness.states[LOADED]).toEqual({ requestedDate: selected, feed: dayPayload(selected, 23) });
      expect(shareText(html)).toContain("الحضور: 23");
    } else {
      noReport(html);
      expect(harness.states[LOADED]).toBeNull();
      expect(html).toContain("جارٍ إعداد التقرير اليومي");
      current.resolve(response(dayPayload(selected, 23)));
      expect(shareText(await settle())).toContain("الحضور: 23");
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    if (typeof replacementCleanup === "function") replacementCleanup();
  });
});

describe("daily report failure, retry and invalid dates", () => {
  it("leaves nothing from a previous success printable or shareable when the new day fails", async () => {
    const a = addDays(today(), -1), b = addDays(today(), -3);
    harness.states[DATE] = a;
    vi.mocked(fetch).mockResolvedValueOnce(response(dayPayload(a, 17)));
    start();
    expect(await settle()).toContain('data-testid="print-report"');
    harness.states[DATE] = b;
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: "تعذّر تحميل التقرير." }, 500));
    start();
    const html = await settle();
    noReport(html);
    expect(html).not.toContain(friendlyDateLong(a));
    expect(html).toContain("تعذّر تحميل التقرير.");
    expect(html).toContain("أعد المحاولة");
  });

  it("shows a clear error without a persistent loading message, then a retry succeeds", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: "تعذّر تحميل التقرير." }, 500));
    start();
    const failed = await settle();
    expect(failed).toContain("تعذّر تحميل التقرير.");
    expect(failed).not.toContain("جارٍ إعداد التقرير اليومي");
    expect(failed).toContain("أعد المحاولة");
    // The retry button increments this token; the effect refetches the same date.
    harness.states[RETRY] = 1;
    vi.mocked(fetch).mockResolvedValueOnce(response(dayPayload(today(), 17)));
    start();
    const html = await settle();
    expect(html).toContain(`تقرير يوم: ${friendlyDateLong(today())}`);
    expect(html).toContain('data-testid="print-report"');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetchedDate(1)).toBe(today());
  });

  it("treats a response carrying a different date as an explicit error", async () => {
    const other = addDays(today(), -5);
    vi.mocked(fetch).mockResolvedValueOnce(response(dayPayload(other, 17)));
    start();
    const html = await settle();
    noReport(html);
    expect(html).not.toContain(friendlyDateLong(other));
    expect(html).toContain("وصل تقريرٌ بتاريخٍ غير التاريخ المطلوب.");
    expect(harness.states[LOADED]).toBeNull();
  });

  it.each([
    ["cleared", ""],
    ["calendar-invalid", "2026-13-45"],
  ])("sends no ambiguous request for a %s date and shows a truthful notice", async (name, value) => {
    const a = addDays(today(), -1);
    harness.states[DATE] = a;
    vi.mocked(fetch).mockResolvedValueOnce(response(dayPayload(a, 17)));
    start();
    expect(await settle()).toContain('data-testid="print-report"');
    harness.states[DATE] = value;
    // Pre-effect commit: the identity guard alone already hides the old report.
    const preEffect = render();
    noReport(preEffect);
    expect(preEffect).not.toContain(friendlyDateLong(a));
    expect(preEffect).toContain("التاريخ المختار غير صالح");
    // The effect runs: no fetch leaves the page, and nothing stale survives.
    start();
    const html = render();
    noReport(html);
    expect(html).not.toContain(friendlyDateLong(a));
    expect(html).toContain("التاريخ المختار غير صالح");
    expect(html).toContain('aria-invalid="true"');
    // Both prev/next steppers are disabled; only «اليوم» recovers.
    expect(html.match(/disabled=""/g)?.length).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(harness.states[LOADED]).toBeNull();
    expect(harness.states[LOADING]).toBe(false);
    expect(harness.states[FAILURE]).toBeNull();

    // Recovery: choosing a real date again sends a clean request and renders it.
    harness.states[DATE] = a;
    vi.mocked(fetch).mockResolvedValueOnce(response(dayPayload(a, 17)));
    start();
    const recovered = await settle();
    expect(recovered).toContain(`تقرير يوم: ${friendlyDateLong(a)}`);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetchedDate(1)).toBe(a);
  });
});

describe("share link identity", () => {
  it("carries exactly the displayed day's summary text", async () => {
    const a = addDays(today(), -1);
    harness.states[DATE] = a;
    const payload = dayPayload(a, 17, 3);
    vi.mocked(fetch).mockResolvedValueOnce(response(payload));
    start();
    const html = await settle();
    expect(shareText(html)).toBe(reportText({
      clinicName: "Synthetic clinic",
      dateText: friendlyDateLong(a),
      report: payload.report as never,
      tomorrowPercent: 50,
      lateLabOrders: 3,
    }));
  });
});
