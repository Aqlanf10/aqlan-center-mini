import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilterState } from "../components/reports/shared";
import type { ReportResult } from "../lib/reports-types";
import { EMPTY_REPORT_VIEW, type ReportViewSpec } from "../lib/report-view";

// The actual page renders with synthetic hook state and inert child components.
// No database, browser, network or financial calculation participates in this test.
const harness = vi.hoisted(() => ({
  states: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0,
  effects: [] as (() => void | (() => void))[],
  session: { role: "admin", username: "synthetic" } as { role: string; username: string } | null,
  filterProps: null as null | {
    onChange: (patch: Partial<FilterState>) => void; onApply: () => void;
  },
  reportProps: null as null | {
    printHref: string; result: ReportResult; onViewChange: (view: ReportViewSpec) => void;
    onPatientClick: (patientId: number) => void; onBack?: () => void;
  },
  savedProps: null as null | { queryString: string; sectionId: string },
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [harness.states[index], (next: unknown) => {
      harness.states[index] = typeof next === "function" ? next(harness.states[index]) : next;
    }];
  }, useRef: (initial: unknown) => {
    const index = harness.refCursor++;
    harness.refs[index] ??= { current: initial };
    return harness.refs[index];
  }, useEffect: (effect: () => void | (() => void)) => {
    harness.effects.push(effect);
  } };
});
vi.mock("../components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic" }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => harness.session }));
vi.mock("../components/Icon", () => ({ Icon: () => null }));
vi.mock("../components/financeLinks", () => ({ financeLinks: () => [] }));
vi.mock("../components/reports/shared", () => ({
  FilterBar: (props: typeof harness.filterProps) => { harness.filterProps = props; return null; },
}));
vi.mock("../components/reports/ReportView", () => ({
  ReportView: (props: typeof harness.reportProps) => { harness.reportProps = props; return null; },
}));
vi.mock("../components/reports/SavedReportsBar", () => ({
  SavedReportsBar: (props: typeof harness.savedProps) => { harness.savedProps = props; return null; },
}));

import ReportsPage from "../app/reports/page";

const applied: FilterState = {
  preset: "custom", from: "2026-09-01", to: "2026-09-30", specialty: null,
  doctorId: null, patientId: null, serviceId: null, currency: "all",
  patientStatus: "all", debtStatus: "all", debtMode: "outstanding", compare: "none",
  method: null, receivedBy: null,
};
const result: ReportResult = {
  report: "daily", title: "Synthetic September report", from: applied.from, to: applied.to,
  periodLabel: "September", baseCurrency: "YER", kpis: [], filtersLabel: "",
};
function render() {
  harness.cursor = 0;
  harness.refCursor = 0;
  harness.effects = [];
  harness.reportProps = null;
  harness.filterProps = null;
  return renderToStaticMarkup(createElement(ReportsPage));
}
function printed() {
  return new URL(harness.reportProps!.printHref, "https://synthetic.invalid").searchParams;
}
function saved() { return new URLSearchParams(harness.savedProps!.queryString); }
function edit(patch: Partial<FilterState>) {
  harness.filterProps!.onChange(patch);
  render();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(from: string, to = from, options: { report?: string; ok?: boolean } = {}): Response {
  const payload = options.ok === false ? { message: "Synthetic rejected request" } : {
    result: { ...result, report: options.report ?? "daily", from, to, title: `Synthetic ${from}` },
    generatedAt: "2026-10-02T08:00:00Z", generatedBy: "synthetic",
  };
  return { ok: options.ok ?? true, json: async () => payload } as Response;
}
async function settle() {
  // Both fetch and response.json are promise boundaries in the actual page.
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  return render();
}
beforeEach(() => {
  harness.states = ["operational", "daily", null,
    { result, generatedAt: "2026-10-02T08:00:00Z", generatedBy: "synthetic", filters: { ...applied }, sectionId: "operational" },
    false, null, null, EMPTY_REPORT_VIEW, { ...applied }];
  harness.refs = [];
  harness.session = { role: "admin", username: "synthetic" };
  harness.filterProps = null;
  harness.reportProps = null;
  harness.savedProps = null;
  vi.stubGlobal("window", {
    location: { href: "https://synthetic.invalid/reports", search: "" },
    history: { replaceState: vi.fn() },
  });
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("report center applied filter integrity", () => {
  it("keeps the official print period aligned with displayed results until Apply", () => {
    render();
    expect(new URL(harness.reportProps!.printHref, "https://synthetic.invalid").searchParams.get("from"))
      .toBe("2026-09-01");
    harness.filterProps!.onChange({ from: "2026-10-01", to: "2026-10-02" });
    render();
    expect(harness.reportProps!.result).toBe(result);
    expect(new URL(harness.reportProps!.printHref, "https://synthetic.invalid").searchParams.get("from"))
      .toBe("2026-09-01");
  });
  it("keeps a saved displayed report aligned with its applied dates until Apply", () => {
    render();
    harness.filterProps!.onChange({ from: "2026-10-01", to: "2026-10-02" });
    render();
    expect(new URLSearchParams(harness.savedProps!.queryString).get("from")).toBe("2026-09-01");
  });

  it("does not silently apply edited provider, currency, status or collection filters to print/save", () => {
    render();
    const before = harness.reportProps!.printHref;
    edit({ doctorId: 42, serviceId: 99, patientId: 17, currency: "USD", specialty: "ortho",
      patientStatus: "active", debtStatus: "overdue", debtMode: "movement", compare: "prev_year",
      method: "transfer", receivedBy: "synthetic cashier" });
    expect(harness.reportProps!.printHref).toBe(before);
    expect(saved().get("currency")).toBeNull();
    expect(saved().get("doctorId")).toBeNull();
  });

  it("commits a successful response with the request-start snapshot, not later draft edits", async () => {
    const pending = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    render();
    edit({ from: "2026-10-01", to: "2026-10-02", currency: "SAR", doctorId: 42 });
    harness.filterProps!.onApply();
    // The user can edit the form again while the first request is in flight.
    edit({ from: "2026-11-01", currency: "USD", doctorId: 99 });
    pending.resolve(response("2026-10-01", "2026-10-02"));
    await settle();
    expect(harness.reportProps!.result.from).toBe("2026-10-01");
    expect(printed().get("from")).toBe("2026-10-01");
    expect(printed().get("currency")).toBe("SAR");
    expect(printed().get("doctorId")).toBe("42");
    expect(saved().get("currency")).toBe("SAR");
    const request = new URL(String(vi.mocked(fetch).mock.calls[0][0]), "https://synthetic.invalid");
    expect(request.searchParams.get("from")).toBe("2026-10-01");
    expect(request.searchParams.get("doctorId")).toBe("42");
  });

  it.each(["network", "HTTP"])("retains the previous result and print context after a failed %s Apply", async (failure) => {
    if (failure === "network") vi.mocked(fetch).mockRejectedValueOnce(new Error("Synthetic network failure"));
    else vi.mocked(fetch).mockResolvedValueOnce(response("2026-10-01", undefined, { ok: false }));
    render();
    edit({ from: "2026-10-01", to: "2026-10-02", currency: "USD" });
    harness.filterProps!.onApply();
    const html = await settle();
    expect(html).toContain('role="alert"');
    expect(harness.reportProps!.result).toBe(result);
    expect(printed().get("from")).toBe("2026-09-01");
    expect(printed().get("currency")).toBeNull();
    expect(saved().get("from")).toBe("2026-09-01");
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });

  it.each([401, 403])("clears prior results when Apply reports authorization failure %s", async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, status, json: async () => ({ message: "Synthetic authorization failure" }),
    } as Response);
    render();
    harness.filterProps!.onApply();
    const html = await settle();
    expect(html).toContain("Synthetic authorization failure");
    expect(harness.reportProps).toBeNull();
  });

  it.each([401, 403])("clears prior results before parsing an empty authorization failure %s", async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, status, json: async () => { throw new SyntaxError("No JSON body"); },
    } as unknown as Response);
    render();
    harness.filterProps!.onApply();
    await settle();
    expect(harness.reportProps).toBeNull();
  });

  it.each([
    {}, { result: { ...result, report: "monthly" } },
    { result },
    { result: { ...result, kpis: undefined }, generatedAt: "2026-10-02T08:00:00Z", generatedBy: "synthetic" },
  ])(
    "does not commit a missing or mismatched report payload", async (payload) => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => payload } as Response);
      render();
      edit({ from: "2026-10-01", to: "2026-10-02" });
      harness.filterProps!.onApply();
      expect(await settle()).toContain('role="alert"');
      expect(harness.reportProps!.result).toBe(result);
      expect(printed().get("from")).toBe("2026-09-01");
      expect(window.history.replaceState).not.toHaveBeenCalled();
    },
  );

  it.each([null, { role: "doctor", username: "other-synthetic" }])(
    "invalidates prior results and in-flight requests after a session change to %j", async (session) => {
      const pending = deferred<Response>();
      vi.mocked(fetch).mockReturnValueOnce(pending.promise);
      render();
      harness.filterProps!.onApply();
      harness.session = session;
      render();
      // Run only the session-routing effect; options and mount effects remain inert.
      harness.effects[2]();
      render();
      expect(harness.reportProps).toBeNull();
      pending.resolve(response("2026-10-01"));
      await settle();
      expect(harness.reportProps).toBeNull();
    },
  );

  it.each(["success", "failure"])("ignores an older %s arriving after the latest successful Apply", async (olderOutcome) => {
    const older = deferred<Response>();
    const newer = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render();
    edit({ from: "2026-10-01", to: "2026-10-01", doctorId: 11 });
    harness.filterProps!.onApply();
    edit({ from: "2026-10-02", to: "2026-10-02", doctorId: 22 });
    harness.filterProps!.onApply();
    newer.resolve(response("2026-10-02"));
    await settle();
    if (olderOutcome === "success") older.resolve(response("2026-10-01"));
    else older.reject(new Error("Obsolete request failed"));
    const html = await settle();
    expect(html).not.toContain('role="alert"');
    expect(harness.reportProps!.result.from).toBe("2026-10-02");
    expect(printed().get("from")).toBe("2026-10-02");
    expect(printed().get("doctorId")).toBe("22");
    expect(saved().get("doctorId")).toBe("22");
  });

  it("does not end the current loading state when an obsolete request completes", async () => {
    const older = deferred<Response>();
    const newer = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render();
    harness.filterProps!.onApply();
    edit({ from: "2026-10-01", to: "2026-10-02" });
    harness.filterProps!.onApply();
    older.resolve(response("2026-09-01", "2026-09-30"));
    expect(await settle()).toContain("جارٍ إعداد");
    expect(harness.reportProps).toBeNull();
    newer.resolve(response("2026-10-01", "2026-10-02"));
    expect(await settle()).not.toContain("جارٍ إعداد");
    expect(printed().get("from")).toBe("2026-10-01");
  });

  it("does not resurrect an obsolete response after the latest Apply fails", async () => {
    const older = deferred<Response>();
    const newer = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render();
    edit({ from: "2026-10-01", to: "2026-10-01" });
    harness.filterProps!.onApply();
    edit({ from: "2026-10-02", to: "2026-10-02" });
    harness.filterProps!.onApply();
    newer.reject(new Error("Latest request failed"));
    await settle();
    older.resolve(response("2026-10-01"));
    const html = await settle();
    expect(html).toContain("Latest request failed");
    expect(harness.reportProps!.result).toBe(result);
    expect(printed().get("from")).toBe("2026-09-01");
  });

  it("does not commit a response after unmount cleanup", async () => {
    const pending = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    render();
    harness.filterProps!.onApply();
    const cleanup = harness.effects[0]();
    expect(typeof cleanup).toBe("function");
    if (typeof cleanup === "function") cleanup();
    pending.resolve(response("2026-10-01"));
    await settle();
    expect(harness.states[3]).toMatchObject({ result });
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });

  it.each([
    { preset: "today", from: "2026-12-31", to: "2026-12-31" },
    { preset: "this_week", from: "2026-12-26", to: "2026-12-31" },
    { preset: "this_month", from: "2026-12-01", to: "2026-12-31" },
  ] as const)("pins $preset print dates across Asia/Aden midnight while saved views remain relative", ({ preset, from, to }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-31T20:59:00Z"));
    harness.states[3] = { result: { ...result, from, to }, filters: { ...applied, preset }, sectionId: "operational" };
    harness.states[8] = { ...applied, preset };
    render();
    const before = harness.reportProps!.printHref;
    vi.setSystemTime(new Date("2026-12-31T21:01:00Z"));
    render();
    expect(harness.reportProps!.printHref).toBe(before);
    expect(printed().get("preset")).toBe("custom");
    expect(printed().get("from")).toBe(from);
    expect(printed().get("to")).toBe(to);
    expect(saved().get("preset")).toBe(preset);
    expect(saved().has("from")).toBe(false);
    expect(saved().has("to")).toBe(false);
  });

  it("uses the response's normalized custom dates for official print", () => {
    harness.states[3] = { result, filters: { ...applied, from: applied.to, to: applied.from }, sectionId: "operational" };
    render();
    expect(printed().get("from")).toBe("2026-09-01");
    expect(printed().get("to")).toBe("2026-09-30");
  });

  it("changing columns retains the displayed report's applied query instead of applying draft dates", () => {
    render();
    edit({ from: "2026-10-01", to: "2026-10-02", currency: "USD" });
    harness.reportProps!.onViewChange({ ...EMPTY_REPORT_VIEW, columns: ["patientName"] });
    const url = vi.mocked(window.history.replaceState).mock.calls[0][2] as string;
    const params = new URL(url, "https://synthetic.invalid").searchParams;
    expect(params.get("from")).toBe("2026-09-01");
    expect(params.get("currency")).toBeNull();
    expect(params.get("columns")).toBe("patientName");
  });

  it("drills into and returns from the displayed report without applying draft edits", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(applied.from, applied.to, { report: "patient-statement" }))
      .mockResolvedValueOnce(response(applied.from, applied.to));
    render();
    edit({ from: "2026-10-01", to: "2026-10-02", currency: "USD" });
    harness.reportProps!.onPatientClick(17);
    await settle();
    expect(printed().get("patientId")).toBe("17");
    expect(printed().get("currency")).toBeNull();
    harness.reportProps!.onBack!();
    await settle();
    const requests = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url), "https://synthetic.invalid").searchParams);
    expect(requests.map((params) => params.get("from"))).toEqual(["2026-09-01", "2026-09-01"]);
    expect(requests.map((params) => params.get("patientId"))).toEqual(["17", null]);
    expect(harness.reportProps!.result.report).toBe("daily");
    expect(printed().get("currency")).toBeNull();
    expect(harness.savedProps!.sectionId).toBe("operational");
  });

  it("retains filters and the summary after a failed drill", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Synthetic drill failure"));
    render();
    harness.reportProps!.onPatientClick(17);
    await settle();
    expect(harness.reportProps!.result).toBe(result);
    expect(harness.reportProps!.onBack).toBeUndefined();
    expect(harness.filterProps).not.toBeNull();
    expect(printed().has("patientId")).toBe(false);
  });

  it("updates copied URLs only after successful drill and restores the parent URL after column changes and Back", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(applied.from, applied.to, { report: "patient-statement" }))
      .mockResolvedValueOnce(response(applied.from, applied.to));
    const lastUrl = () => new URL(String(vi.mocked(window.history.replaceState).mock.lastCall![2]), "https://synthetic.invalid").searchParams;
    render();
    harness.reportProps!.onPatientClick(17);
    expect(window.history.replaceState).not.toHaveBeenCalled();
    await settle();
    expect(lastUrl().get("report")).toBe("patient-statement");
    expect(lastUrl().get("patientId")).toBe("17");
    harness.reportProps!.onViewChange({ ...EMPTY_REPORT_VIEW, columns: ["patientName"] });
    render();
    expect(lastUrl().get("report")).toBe("patient-statement");
    harness.reportProps!.onBack!();
    expect(lastUrl().get("report")).toBe("patient-statement");
    await settle();
    expect(lastUrl().get("report")).toBe("daily");
    expect(lastUrl().has("patientId")).toBe(false);
    expect(lastUrl().get("columns")).toBe("patientName");
    expect(lastUrl().get("from")).toBe("2026-09-01");
  });

  it("retains the statement and back context after failed back, then retries the original summary", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(applied.from, applied.to, { report: "patient-statement" }))
      .mockRejectedValueOnce(new Error("Synthetic back failure"))
      .mockResolvedValueOnce(response(applied.from, applied.to));
    render();
    edit({ from: "2026-10-01", to: "2026-10-02" });
    harness.reportProps!.onPatientClick(17);
    await settle();
    harness.reportProps!.onBack!();
    await settle();
    expect(harness.reportProps!.result.report).toBe("patient-statement");
    expect(harness.reportProps!.onBack).toBeTypeOf("function");
    expect(harness.filterProps).toBeNull();
    expect(printed().get("patientId")).toBe("17");
    harness.reportProps!.onBack!();
    await settle();
    expect(harness.reportProps!.result.report).toBe("daily");
    expect(printed().get("from")).toBe("2026-09-01");
    expect(printed().has("patientId")).toBe(false);
  });

  it("pins drill/back to the displayed date after clinic midnight without freezing the saved relative preset", async () => {
    const from = "2026-12-31";
    harness.states[3] = {
      result: { ...result, from, to: from }, filters: { ...applied, preset: "today" }, sectionId: "operational",
    };
    harness.states[8] = { ...applied, preset: "today" };
    vi.mocked(fetch).mockResolvedValueOnce(response(from, from, { report: "patient-statement" }))
      .mockResolvedValueOnce(response(from));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-31T20:59:00Z"));
    render();
    vi.setSystemTime(new Date("2026-12-31T21:01:00Z"));
    harness.reportProps!.onPatientClick(17);
    await settle();
    expect(saved().get("preset")).toBe("today");
    harness.reportProps!.onBack!();
    await settle();
    const requests = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url), "https://synthetic.invalid").searchParams);
    expect(requests.map((params) => params.get("preset"))).toEqual(["custom", "custom"]);
    expect(requests.map((params) => params.get("from"))).toEqual([from, from]);
    expect(requests.map((params) => params.get("to"))).toEqual([from, from]);
    expect(saved().get("preset")).toBe("today");
    expect(saved().has("from")).toBe(false);
    expect(printed().get("from")).toBe(from);
  });

  it("hydrates a copied statement URL and returns to the existing allowed section default", async () => {
    window.location.search = "?section=operational&report=patient-statement&patientId=17&preset=custom&from=2026-09-01&to=2026-09-30";
    vi.mocked(fetch).mockResolvedValueOnce(response(applied.from, applied.to, { report: "patient-statement" }))
      .mockResolvedValueOnce(response(applied.from, applied.to, { report: "visits" }));
    render();
    harness.effects[2]();
    await settle();
    expect(harness.reportProps!.result.report).toBe("patient-statement");
    expect(harness.reportProps!.onBack).toBeTypeOf("function");
    expect(harness.filterProps).toBeNull();
    expect(printed().get("patientId")).toBe("17");
    harness.reportProps!.onBack!();
    await settle();
    expect(harness.reportProps!.result.report).toBe("visits");
    expect(printed().has("patientId")).toBe(false);
    expect(harness.filterProps).not.toBeNull();
  });

  it.each(["", "0", "-1", "1.5", "1e1", "9007199254740992", "invalid"])(
    "does not hydrate a patient statement with invalid patientId %j", async (patientId) => {
      window.location.search = `?section=operational&report=patient-statement&patientId=${patientId}`;
      vi.mocked(fetch).mockResolvedValueOnce(response(applied.from, applied.to, { report: "visits" }));
      render();
      harness.effects[2]();
      await settle();
      const params = new URL(String(vi.mocked(fetch).mock.calls[0][0]), "https://synthetic.invalid").searchParams;
      expect(params.get("report")).toBe("visits");
      expect(params.has("patientId")).toBe(false);
      expect(harness.reportProps!.onBack).toBeUndefined();
    },
  );

  it("does not request a copied statement URL for an unauthorized role", () => {
    window.location.search = "?section=operational&report=patient-statement&patientId=17";
    harness.session = { role: "doctor", username: "synthetic doctor" };
    render();
    harness.effects[2]();
    render();
    expect(fetch).not.toHaveBeenCalled();
    expect(harness.reportProps).toBeNull();
  });
});
