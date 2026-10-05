import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChairReadiness, type VisitReadiness } from "../components/today/useChairReadiness";
import { ReadinessChip } from "../components/today/ReadinessChip";
import type { SessionInfo } from "../components/SessionProvider";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../lib/doctor-permissions";
import { balanceLines } from "../lib/chair-readiness";
import { readFileSync } from "node:fs";

// The real Today hook/chip with controlled React state/effects and synthetic
// transport. Built-page/real-React acceptance remains a separate release gate.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  pending: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  const effect = (callback: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = callback();
      hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => {
        hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect, useLayoutEffect: effect,
  };
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
}
function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
type MockResponse = ReturnType<typeof response>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const row = (changes: Partial<VisitReadiness> = {}): VisitReadiness => ({
  visitId: 301, patientId: 91, status: "waiting", chair: null,
  arrivedAt: "2026-10-05T06:00:00Z", seatedAt: null, signedAt: null, cleared: null,
  checklist: [{ key: "alerts", state: "attention", label: "تنبيه طبي: تحذير محفوظ" }],
  attention: 1, alerts: ["تحذير محفوظ"], historyAlerts: ["تحذير تاريخ مستقل"], editableAlert: "تحذير قابل للتعديل",
  balances: [{ currency: "SAR", dueMinor: 500, warn: false }], ...changes,
});
const payload = (item = row(), requireClearance = false) => ({ items: [item], requireClearance });
const boardRow = () => ({ id: 301, patientId: 91 as number | null, status: "waiting", chair: null as number | null });
let session: SessionInfo | null;
let visits: ReturnType<typeof boardRow>[];
let transport: MockResponse | Promise<MockResponse>;
let visibility: string;
let events: Map<string, Set<() => void>>;
const fetchMock = vi.fn();
const clear = vi.fn();
// Explicit test probe: the controlled renderer invokes this component to drive
// the actual hook, following React's hook-call naming convention.
function ReadinessProbe() {
  return useChairReadiness(30_000, session, visits);
}
function render() {
  hooks.cursor = 0;
  const value = ReadinessProbe();
  hooks.pending.splice(0).forEach((effect) => effect());
  return value;
}
function chip(value = render(), visit = visits[0]) {
  return ReadinessChip({ item: value.byVisit.get(visit.id), visit, state: value.state,
    canClear: value.canClear, busy: false, onClear: clear, onRetry: value.reload });
}
function button(label: string, tree = chip()) {
  return elements(tree).find((node) => node.type === "button" && text(node).includes(label));
}
const settle = () => vi.advanceTimersByTimeAsync(0);
async function mounted() { render(); await settle(); return render(); }
const fire = (name: string) => events.get(name)?.forEach((handler) => handler());
function retire() { hooks.effects.forEach((effect) => effect.cleanup?.()); hooks.effects.clear(); }

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  hooks.values = []; hooks.cursor = 0; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  session = { username: "synthetic", role: "doctor",
    permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPatientPayments: true } };
  visits = [boardRow()]; transport = response(payload()); visibility = "visible"; events = new Map();
  const add = (name: string, handler: () => void) => {
    if (!events.has(name)) events.set(name, new Set());
    events.get(name)!.add(handler);
  };
  const remove = (name: string, handler: () => void) => events.get(name)?.delete(handler);
  vi.stubGlobal("window", { addEventListener: add, removeEventListener: remove });
  vi.stubGlobal("document", { get visibilityState() { return visibility; }, addEventListener: add, removeEventListener: remove });
  fetchMock.mockImplementation(() => Promise.resolve(transport));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  retire();
  expect(fetchMock.mock.calls.every(([url, init]) => url === "/api/visits/readiness" && !init?.method)).toBe(true);
  expect(clear).not.toHaveBeenCalled();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("Today readiness read ownership", () => {
  it("starts explicitly unknown and does not show clearance or money before success", async () => {
    const waiting = deferred<MockResponse>(); transport = waiting.promise;
    let view = render(); expect(view.state).toBe("loading");
    expect(text(chip(view))).toContain("قيد التحقق");
    expect(text(chip(view))).not.toContain("جاهز ✓"); expect(text(chip(view))).not.toContain("عليه");
    await settle(); expect(fetchMock).toHaveBeenCalledOnce();
    waiting.resolve(response(payload())); await settle(); view = render();
    expect(view.state).toBe("ready"); expect(button("أقِرّ الجاهزية", chip(view))).toBeDefined();
  });
  it.each(["headers", "body"])("a newer success retires an older delayed %s response", async phase => {
    await mounted();
    const oldHeaders = deferred<MockResponse>(), oldBody = deferred<unknown>();
    transport = phase === "headers" ? oldHeaders.promise : { ...response(null), json: () => oldBody.promise };
    const earlier = render().reload(); await settle();
    const oldSignal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
    transport = response(payload(row({ alerts: ["تنبيه أحدث"], editableAlert: "تنبيه أحدث", cleared: { at: "2026-10-05T06:00:01Z", by: "synthetic" } }), true));
    await render().reload(); expect(oldSignal.aborted).toBe(true);
    oldHeaders.resolve(response(payload())); oldBody.resolve(payload());
    await earlier; await settle();
    const view = render();
    expect(view.byVisit.get(301)?.alerts).toEqual(["تنبيه أحدث"]); expect(view.requireClearance).toBe(true);
    expect(text(chip(view))).toContain("جاهز ✓");
  });
  it.each([401, 403, 404])("a %i revokes cached clinical/financial data without reading its body", async status => {
    await mounted(); const json = vi.fn(() => new Promise<unknown>(() => undefined));
    transport = { ...response(null, status), json };
    await render().reload();
    const view = render(); expect(json).not.toHaveBeenCalled(); expect(view.byVisit.size).toBe(0);
    expect(view.state).toBe("unavailable");
    expect(text(chip(view))).not.toContain("تحذير محفوظ"); expect(text(chip(view))).not.toContain("عليه");
    transport = response({}, 503); await view.reload();
    expect(render().byVisit.size).toBe(0);
  });
  it.each(["username", "role", "permission", "logout"])("retires the old %s owner before a new read can succeed", async change => {
    await mounted(); const old = deferred<unknown>();
    transport = { ...response(null), json: () => old.promise };
    const pending = render().reload(); await settle(); const savedReload = render().reload;
    if (change === "username") session = { ...session!, username: "other-principal" };
    if (change === "role") session = { ...session!, role: "assistant" };
    if (change === "permission") session = { ...session!, permissions: { ...session!.permissions!, canViewPatientPayments: false } };
    if (change === "logout") session = null;
    expect(render().byVisit.size).toBe(0);
    transport = response({}, 503);
    const calls = fetchMock.mock.calls.length; await savedReload();
    expect(fetchMock.mock.calls).toHaveLength(calls);
    await settle(); old.resolve(payload()); await pending; await settle();
    expect(render().byVisit.size).toBe(0); expect(text(chip())).not.toContain("تحذير محفوظ");
  });
  it.each(["principal", "patient"])("does not resurrect accepted data during a fast %s A→B→A transition", async kind => {
    await mounted();
    const original = session;
    if (kind === "principal") session = { ...session!, username: "other-principal" };
    else visits = [{ ...boardRow(), patientId: 92 }];
    expect(render().byVisit.size).toBe(0);
    session = original; visits = [boardRow()];
    expect(render().byVisit.size).toBe(0);
    transport = response({}, 503); await settle();
    expect(render().byVisit.size).toBe(0);
  });
  it.each([
    ["principal", "reload"], ["principal", "onRetry"],
    ["patient", "reload"], ["patient", "onRetry"],
  ])("retained %s A callback (%s) cannot start a read or abort current work after A→B→A", async (kind, callback) => {
    await mounted(); transport = response({}, 503); await render().reload();
    const oldView = render();
    const oldCallback = callback === "reload" ? oldView.reload
      : button("أعد التحقق", chip(oldView))!.props.onClick as () => void;
    const original = session;
    if (kind === "principal") session = { ...session!, username: "other-principal" };
    else visits = [{ ...boardRow(), patientId: 92 }];
    render(); session = original; visits = [boardRow()]; render();
    const latest = deferred<MockResponse>(); transport = latest.promise; await settle();
    const signal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
    const calls = fetchMock.mock.calls.length;
    void oldCallback(); await settle();
    expect(fetchMock.mock.calls).toHaveLength(calls);
    expect(signal.aborted).toBe(false);
    expect(render().state).toBe("loading");
    latest.resolve(response(payload(row({ alerts: ["تنبيه المالك الحالي"] })))); await settle();
    expect(render().byVisit.get(301)?.alerts).toEqual(["تنبيه المالك الحالي"]);
  });
  it.each(["reload", "onRetry"])("a retained %s cannot revive when its hidden owner returns to foreground", async callback => {
    await mounted(); transport = response({}, 503); await render().reload();
    const oldView = render();
    const oldCallback = callback === "reload" ? oldView.reload
      : button("أعد التحقق", chip(oldView))!.props.onClick as () => void;
    visibility = "hidden"; fire("visibilitychange"); render();
    const callsWhenHidden = fetchMock.mock.calls.length;
    void oldCallback(); await settle(); expect(fetchMock.mock.calls).toHaveLength(callsWhenHidden);
    const latest = deferred<MockResponse>(); transport = latest.promise;
    visibility = "visible"; fire("visibilitychange");
    // Old callbacks stay retired even before the foreground commit.
    void oldCallback(); expect(fetchMock.mock.calls).toHaveLength(callsWhenHidden);
    render(); await settle();
    const signal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
    const calls = fetchMock.mock.calls.length;
    void oldCallback(); await settle();
    expect(fetchMock.mock.calls).toHaveLength(calls); expect(signal.aborted).toBe(false);
    latest.resolve(response(payload())); await settle(); expect(render().state).toBe("ready");
  });
  it("a relinked board row immediately hides the prior patient's warning and balance", async () => {
    const view = await mounted();
    const moved = { ...boardRow(), patientId: 92 };
    expect(text(chip(view, moved))).not.toContain("تحذير محفوظ");
    expect(text(chip(view, moved))).not.toContain("عليه");
    expect(button("أقِرّ الجاهزية", chip(view, moved))).toBeUndefined();
    visits = [moved]; expect(render().byVisit.size).toBe(0);
    transport = response(payload(row({ patientId: 92, alerts: ["تحذير المريض الجديد"] })));
    await settle(); expect(render().byVisit.get(301)?.patientId).toBe(92);
  });
  it("an owner installed while hidden cannot start work before or after the foreground owner commits", async () => {
    await mounted(); visibility = "hidden"; fire("visibilitychange"); render();
    session = { ...session!, username: "hidden-principal" };
    const hiddenReload = render().reload; await settle();
    const calls = fetchMock.mock.calls.length;
    visibility = "visible"; fire("visibilitychange");
    void hiddenReload(); expect(fetchMock.mock.calls).toHaveLength(calls);
    render(); await settle(); const currentCalls = fetchMock.mock.calls.length;
    void hiddenReload(); await settle(); expect(fetchMock.mock.calls).toHaveLength(currentCalls);
    expect(render().state).toBe("ready");
  });
  it("display-only row reordering does not replace the read owner", async () => {
    visits = [boardRow(), { ...boardRow(), id: 302, patientId: 92 }];
    await mounted(); const calls = fetchMock.mock.calls.length;
    visits = [...visits].reverse(); expect(render().state).toBe("ready");
    await settle(); expect(fetchMock.mock.calls).toHaveLength(calls);
  });
  it("backgrounding retires a delayed body and foregrounding obtains a fresh grant", async () => {
    await mounted(); const old = deferred<unknown>();
    transport = { ...response(null), json: () => old.promise };
    const pending = render().reload(); await settle();
    visibility = "hidden"; fire("visibilitychange");
    expect(render().byVisit.size).toBe(0);
    old.resolve(payload()); await pending; await settle(); expect(render().byVisit.size).toBe(0);
    const count = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000); expect(fetchMock.mock.calls).toHaveLength(count);
    transport = response(payload()); visibility = "visible"; fire("visibilitychange"); render(); await settle();
    expect(render().state).toBe("ready");
  });
  it("unmount aborts and settles a read even when fetch ignores AbortSignal", async () => {
    const never = deferred<MockResponse>(); transport = never.promise;
    await mounted(); const pending = render().reload();
    const signal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
    retire(); await pending; expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    never.resolve(response(payload())); await settle();
    expect((hooks.values.filter((value) => value && typeof value === "object" && "state" in value) as unknown[])).toEqual([]);
  });
});

describe("Today freshness, retry and response contracts", () => {
  it("pending/failing refresh preserves only labelled same-owner warnings, without current clearance, money or clear", async () => {
    transport = response(payload(row({ cleared: { at: "2026-10-05T06:00:01Z", by: "synthetic" } })));
    await mounted(); expect(text(chip())).toContain("جاهز ✓"); expect(text(chip())).toContain("عليه");
    const waiting = deferred<MockResponse>(); transport = waiting.promise;
    const pending = render().reload();
    for (const forbidden of ["جاهز ✓", "عليه", "أقِرّ الجاهزية"]) expect(text(chip())).not.toContain(forbidden);
    expect(text(chip())).toContain("آخر تنبيه محفوظ: تحذير محفوظ");
    waiting.resolve(response({}, 503)); await pending;
    expect(render().state).toBe("unavailable"); expect(button("أعد التحقق")).toBeDefined();
    expect(render().requireClearance).toBeNull();
    transport = response(payload());
    (button("أعد التحقق")!.props.onClick as () => void)(); await settle();
    expect(render().state).toBe("ready"); expect(button("أقِرّ الجاهزية")).toBeDefined();
  });
  it.each(["headers", "body"])("a never-settling %s expires after 15s and a retry can recover", async phase => {
    await mounted();
    const headers = deferred<MockResponse>(), body = deferred<unknown>();
    transport = phase === "headers" ? headers.promise : { ...response(null), json: () => body.promise };
    const pending = render().reload(); await settle();
    const signal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(14_999); expect(render().state).toBe("loading");
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(render().state).toBe("unavailable"); expect(signal.aborted).toBe(true);
    transport = response(payload(row({ alerts: ["تنبيه بعد المحاولة"] }))); await render().reload();
    headers.resolve(response(payload())); body.resolve(payload()); await settle();
    expect(render().byVisit.get(301)?.alerts).toEqual(["تنبيه بعد المحاولة"]);
  });
  it("redacted success replaces cached clinical and financial fields and survives later failure", async () => {
    await mounted();
    transport = response(payload(row({ checklist: null, attention: null, alerts: null, historyAlerts: null,
      editableAlert: null, balances: null })));
    await render().reload();
    expect(render().byVisit.get(301)?.alerts).toBeNull();
    expect(text(chip())).not.toContain("تحذير محفوظ"); expect(text(chip())).not.toContain("عليه");
    expect(button("أقِرّ الجاهزية")).toBeUndefined();
    transport = response({}, 503); await render().reload();
    expect(text(chip())).not.toContain("تحذير محفوظ");
  });
  it.each([
    null, {}, { items: [] }, { items: [], requireClearance: "false" },
    { items: [null], requireClearance: false },
    { items: [row(), row()], requireClearance: false },
    payload({ ...row(), checklist: {} } as unknown as VisitReadiness),
    payload({ ...row(), balances: {} } as unknown as VisitReadiness),
    payload({ ...row(), status: ["waiting"] } as unknown as VisitReadiness),
    payload({ ...row(), historyAlerts: [1] } as unknown as VisitReadiness),
    payload({ ...row(), editableAlert: {} } as unknown as VisitReadiness),
    payload(row({ checklist: null })),
  ])("malformed readiness is unavailable rather than a successful grant %#", async invalid => {
    transport = response(invalid); await mounted();
    expect(render().state).toBe("unavailable"); expect(render().byVisit.size).toBe(0);
    expect(button("أقِرّ الجاهزية")).toBeUndefined(); expect(render().requireClearance).toBeNull();
  });
  it("accepts PR242 split fields and an older server without split fields", async () => {
    const split = await mounted();
    expect(split.byVisit.get(301)?.historyAlerts).toEqual(["تحذير تاريخ مستقل"]);
    expect(split.byVisit.get(301)?.editableAlert).toBe("تحذير قابل للتعديل");
    const legacy = row(); delete legacy.historyAlerts; delete legacy.editableAlert;
    transport = response(payload(legacy)); await split.reload(); expect(render().state).toBe("ready");
  });
  it("accepts richer producer rows and chair IDs beyond the current visible chair count", async () => {
    visits = [{ ...boardRow(), status: "called", chair: 400 }];
    const rich = { ...row({ status: "called", chair: 400 }), stepper: { current: "arrived", steps: [] },
      doctorId: 77, futureDisplayField: { informational: true } };
    transport = response(payload(rich)); await mounted();
    expect(render().state).toBe("ready");
    expect(render().byVisit.get(301)?.chair).toBe(400);
  });
  it.each(["waiting", "called", "in_chair", "done"])("accepts the existing %s visit status", async status => {
    transport = response(payload(row({ status }))); await mounted();
    expect(render().state).toBe("ready");
  });
  it("accepts a walk-in and a cleared redacted row without requiring medical or financial access", async () => {
    visits = [{ ...boardRow(), patientId: null }];
    transport = response(payload(row({ patientId: null, checklist: [{ key: "file", state: "attention", label: "بلا ملف" }],
      attention: 1, alerts: [], historyAlerts: [], editableAlert: null, balances: null })));
    await mounted(); expect(render().state).toBe("ready");
    visits = [boardRow()]; render();
    transport = response(payload(row({ checklist: null, attention: null, alerts: null, historyAlerts: null,
      editableAlert: null, balances: null, cleared: { at: "2026-10-05T06:00:01Z", by: null } })));
    await settle(); expect(render().state).toBe("ready");
    expect(text(chip())).toContain("جاهز ✓"); expect(text(chip())).not.toContain("عليه");
  });
  it("uses the producer's positive-debt projection; zero and credit are valid empty balances", async () => {
    const balances = balanceLines([
      { currency: "SAR", dueMinor: -500 }, { currency: "YER", dueMinor: 0 },
      { currency: "USD", dueMinor: 1250 },
    ], { USD: 1000 });
    expect(balances).toEqual([{ currency: "USD", dueMinor: 1250, warn: true }]);
    transport = response(payload(row({ balances }))); await mounted(); expect(render().state).toBe("ready");
    transport = response(payload(row({ balances: balanceLines([{ currency: "SAR", dueMinor: -500 }], {}) })));
    await render().reload(); expect(render().state).toBe("ready"); expect(text(chip())).not.toContain("عليه");
  });
  it("retry offers a 44px minimum target without changing the clearance/debt policy", async () => {
    transport = response({}, 503); await mounted();
    const classes = button("أعد التحقق")?.props.className as string;
    expect(classes).toContain("min-h-[44px]"); expect(classes).toContain("min-w-[44px]");
  });
  it("a successful empty list replaces all prior rows instead of retaining departed patients", async () => {
    await mounted(); transport = response({ items: [], requireClearance: true }); await render().reload();
    expect(render().state).toBe("ready"); expect(render().byVisit.size).toBe(0);
    expect(text(chip())).not.toContain("تحذير محفوظ");
  });
  it("clearance is not offered from mismatched movement state", async () => {
    const view = await mounted();
    for (const moved of [{ ...boardRow(), status: "called", chair: 1 }, { ...boardRow(), chair: 2 }]) {
      expect(button("أقِرّ الجاهزية", chip(view, moved))).toBeUndefined();
      expect(text(chip(view, moved))).not.toContain("عليه");
    }
  });
  it.each(["assistant", "accountant", "cashier"])("%s receives no Today clearance command", async role => {
    session = { ...session!, role }; await mounted();
    expect(render().canClear).toBe(false); expect(button("أقِرّ الجاهزية")).toBeUndefined();
    if (role !== "assistant") expect(fetchMock).not.toHaveBeenCalled();
  });
  it("debt remains informational and never disables an authorized clearance button", async () => {
    transport = response(payload(row({ balances: [{ currency: "SAR", dueMinor: 9_999_900, warn: true }] })));
    await mounted();
    expect(button("أقِرّ الجاهزية")?.props.disabled).toBe(false);
    expect(text(chip())).toContain("عليه");
  });
  it("both actual Today chip call sites pass the board identity and read state", () => {
    const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
    expect(page).toContain("useChairReadiness(REFRESH_MS, session, visits)");
    for (const visit of ["visit", "row.visit"]) {
      expect(page).toContain("visit={" + visit + "}");
    }
    expect(page.match(/state=\{readiness.state\}/g)).toHaveLength(2);
    expect(page.match(/onRetry=\{reloadReadiness\}/g)).toHaveLength(2);
  });
});
