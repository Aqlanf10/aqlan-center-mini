import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { financeSummaryFixture as full } from "./fixtures/finance-summary";
import { financeReportAccess, projectFinanceSummary, type VisibleFinanceSummary } from "../lib/finance-report-visibility";
import { parseDoctorPermissions } from "../lib/doctor-permissions";

// Execute the real component's effects and render output without browser/DB.
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
vi.mock("../components/PageHeader", () => ({ PageHeader: ({ children }: { children: ReactNode }) => createElement("header", null, children) }));
vi.mock("../components/SettingsProvider", () => ({ useSetting: () => "Synthetic clinic" }));
vi.mock("../components/Icon", () => ({ Logo: () => null }));
vi.mock("../components/PrintButton", () => ({ PrintButton: () => createElement("button", { "data-testid": "print-report" }, "Print") }));
vi.mock("../components/financeLinks", () => ({ financeLinks: () => [] }));
import FinanceReportsPage from "../app/finance/reports/page";

const revenueOnly = projectFinanceSummary(full, financeReportAccess("doctor", parseDoctorPermissions({ canViewClinicRevenue: true })))!;
function loaded(summary: VisibleFinanceSummary, requestedFrom = full.from, requestedTo = full.to) {
  return { requestedFrom, requestedTo, summary };
}
function render() {
  harness.cursor = 0; harness.effects = [];
  return renderToStaticMarkup(createElement(FinanceReportsPage));
}
function start() { render(); return harness.effects[0]() as () => void; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (payload: unknown, status = 200): Response => ({ status, ok: status < 300, json: async () => payload }) as Response;
async function settle() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); return render(); }
function noRestricted(html: string) {
  expect(html).not.toContain('data-testid="finance-net"');
  expect(html).not.toContain('data-testid="finance-expenses"');
  expect(html).not.toContain('data-testid="opening-settlements"');
  expect(html).not.toContain("صُرف");
}
beforeEach(() => {
  harness.states = [full.from, full.to, null, true, null];
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("real financial report page effects and conditional sections", () => {
  it("omits denied sections rather than displaying false zeros or empty-expense claims", () => {
    harness.states[2] = loaded(revenueOnly); harness.states[3] = false;
    const html = render();
    noRestricted(html);
    expect(html).toContain("خدمة تجريبية");
    expect(html).toContain('data-testid="print-report"');
    expect(html).not.toContain("لا مصروفات في هذه المدة.");
  });

  it("shows authorized expense data independently and preserves zero-valued profit", () => {
    harness.states[2] = loaded({ ...revenueOnly, expenses: full.expenses, openingSettlements: full.openingSettlements });
    harness.states[3] = false;
    expect(render()).toContain('data-testid="finance-expenses"');
    expect(render()).toContain('data-testid="opening-settlements"');
    expect(render()).not.toContain('data-testid="finance-net"');
    expect(render()).toContain('data-testid="print-report"');
    harness.states[2] = loaded({ ...full, netMinor: 0 });
    expect(render()).toContain('data-testid="finance-net"');
  });

  it.each([401, 403])("clears loaded data on reload and prevents stale success after %s", async (status) => {
    harness.states[2] = loaded(full); harness.states[3] = false;
    const older = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(older.promise);
    const cleanup = start();
    noRestricted(render());
    expect(harness.states[2]).toBeNull();
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    cleanup();
    expect(signal?.aborted).toBe(true);
    harness.states[0] = "2026-09-02";
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: "Synthetic access denied" }, status));
    start();
    expect(await settle()).toContain("Synthetic access denied");
    older.resolve(response(full));
    noRestricted(await settle());
    expect(harness.states[2]).toBeNull();
    expect(harness.states[4]).toBe("Synthetic access denied");
    expect(render()).not.toContain('data-testid="print-report"');
    expect(render()).not.toContain('aria-label="الأرقام الرئيسية"');
  });

  it("blocks stale JSON after a newer reduced-access success", async () => {
    const olderBody = deferred<unknown>();
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: () => olderBody.promise } as Response);
    const cleanup = start();
    await settle(); cleanup();
    harness.states[0] = "2026-09-02";
    vi.mocked(fetch).mockResolvedValueOnce(response(revenueOnly));
    start(); await settle();
    olderBody.resolve(full);
    const html = await settle();
    noRestricted(html);
    expect(html).toContain("خدمة تجريبية");
    expect(html).toContain('data-testid="print-report"');
    expect(harness.states[2]).toEqual(loaded(revenueOnly, "2026-09-02"));
    expect(harness.states[4]).toBeNull();
  });

  it("ignores obsolete rejection and cannot reset the active loading state", async () => {
    const older = deferred<Response>(); const current = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise);
    const cleanup = start(); cleanup();
    harness.states[0] = "2026-09-02"; start();
    older.reject(new Error("obsolete")); await settle();
    expect(harness.states[3]).toBe(true);
    expect(harness.states[4]).toBeNull();
    current.resolve(response(revenueOnly)); await settle();
    expect(harness.states[2]).toEqual(loaded(revenueOnly, "2026-09-02"));
    expect(harness.states[3]).toBe(false);
  });

  it.each([401, 403])("keeps report data absent if a %s error response has an unreadable body", async (status) => {
    harness.states[2] = loaded(full); harness.states[3] = false;
    const denied = new Response("", { status });
    vi.spyOn(denied, "json").mockRejectedValue(new Error("Unreadable error body"));
    vi.mocked(fetch).mockResolvedValueOnce(denied);
    start(); noRestricted(await settle());
    expect(harness.states[2]).toBeNull();
    expect(harness.states[4]).toBe("Unreadable error body");
    expect(render()).not.toContain('data-testid="print-report"');
  });

  it("does not repopulate state after unmount", async () => {
    const pending = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    const cleanup = start(); cleanup();
    pending.resolve(response(full)); await settle();
    expect(harness.states[2]).toBeNull();
  });
});

describe("financial report selected-period identity", () => {
  function noReport(html: string) {
    noRestricted(html);
    expect(html).not.toContain("خدمة تجريبية");
    expect(html).not.toContain('aria-label="الأرقام الرئيسية"');
    expect(html).not.toContain('data-testid="print-report"');
  }

  it.each([0, 1])("withholds loaded values and print before the effect runs after date %s changes", async (index) => {
    vi.mocked(fetch).mockResolvedValueOnce(response(full));
    start();
    expect(await settle()).toContain('data-testid="print-report"');
    // Commit the next selected date but deliberately do not run its passive effect.
    harness.states[index] = "2026-10-01";
    const html = render();
    noReport(html);
    expect(html).toContain("جارٍ التحميل…");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["headers", "body"])("withholds old %s that finish after a date render but before effect cleanup", async (boundary) => {
    const headers = deferred<Response>();
    const body = deferred<unknown>();
    if (boundary === "headers") vi.mocked(fetch).mockReturnValueOnce(headers.promise);
    else vi.mocked(fetch).mockResolvedValueOnce({ status: 200, ok: true, json: () => body.promise } as Response);
    const cleanup = start();
    await settle();
    harness.states[1] = "2026-10-01";
    render();
    if (boundary === "headers") headers.resolve(response(full));
    else body.resolve(full);
    noReport(await settle());
    cleanup();
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("keeps a matching successful zero-valued report renderable and printable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ...full, netMinor: 0, expenses: { ...full.expenses, count: 0, baseTotalMinor: 0 } }));
    start();
    const html = await settle();
    expect(html).toContain('data-testid="finance-net"');
    expect(html).toContain('data-testid="finance-expenses"');
    expect(html).toContain("لا مصروفات في هذه المدة.");
    expect(html).toContain('data-testid="print-report"');
    expect(render()).toBe(html);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("pairs a server-normalized interval with the original requested date order", async () => {
    harness.states[0] = full.to;
    harness.states[1] = full.from;
    vi.mocked(fetch).mockResolvedValueOnce(response(full));
    start();
    expect(await settle()).toContain("خدمة تجريبية");
    expect(fetch).toHaveBeenCalledWith(`/api/finance/report?from=${full.to}&to=${full.from}`, expect.any(Object));
    harness.states[0] = full.from;
    harness.states[1] = full.to;
    // The normalized payload is equal but this selected request has not loaded.
    noReport(render());
  });
});
