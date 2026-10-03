import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientCockpit } from "../components/patient/PatientCockpit";

// Actual hook/reload transitions with synthetic responses, no browser or database.
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
    const index = slot(undefined); const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => {
        hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value;
      }];
    },
    useMemo: memo,
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined); const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.(); const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});
vi.mock("../components/SettingsProvider", () => ({ useChairCount: () => 4 }));

const oldAlert = "تنبيه قديم قابل للتعديل";
const savedAlert = "حساسية جديدة محفوظة";
const historyAlert = "على مميّعات دم";
const response = (status: number, body: unknown) => ({ ok: status < 300, json: async () => body });
type MockResponse = ReturnType<typeof response>;
const visit = (split = true) => ({
  visitId: 21, patientId: 91, status: "in_chair", signedAt: null, chair: 1,
  arrivedAt: "2026-10-03T00:00:00Z", seatedAt: "2026-10-03T00:00:00Z",
  alerts: [oldAlert, historyAlert], ...(split ? { historyAlerts: [historyAlert], editableAlert: oldAlert } : {}),
  balances: [], cleared: true, checklist: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let props: Parameters<typeof PatientCockpit>[0];
let nextReadiness: MockResponse | Promise<MockResponse>;
const fetchMock = vi.fn();
function render() {
  hooks.cursor = 0;
  const html = renderToStaticMarkup(PatientCockpit(props));
  hooks.pending.splice(0).forEach((effect) => effect());
  return html;
}
function confirmSave(value: string | null, updatePage = true) {
  props.confirmedAlert = { revision: (props.confirmedAlert?.revision ?? 0) + 1, value };
  if (updatePage) props.fallbackAlert = value;
}
async function settleInitial(split = true) {
  nextReadiness = response(200, { visit: visit(split) });
  render(); await vi.advanceTimersByTimeAsync(0);
  expect(render()).toContain(oldAlert);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  hooks.values = []; hooks.cursor = 0; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  props = { patientId: 91, patientName: "مريض تجريبي", patientPhone: null, fallbackAlert: oldAlert,
    summary: null, compact: true, onOpenTab: () => {}, onChanged: () => {} };
  nextReadiness = response(200, { visit: visit() });
  fetchMock.mockImplementation((url: string) => url.includes("/readiness?") ? nextReadiness : response(200, []));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("saved patient alert freshness in the visible cockpit", () => {
  it("shows an addition with a settled empty alert snapshot before another request resolves", async () => {
    props.fallbackAlert = null;
    nextReadiness = response(200, { visit: { ...visit(), alerts: [], historyAlerts: [], editableAlert: null } });
    render(); await vi.advanceTimersByTimeAsync(0); render();
    const pending = deferred<MockResponse>(); nextReadiness = pending.promise;
    confirmSave(savedAlert);
    expect(render()).toContain(savedAlert);
    await vi.advanceTimersByTimeAsync(0);
    expect(render()).toContain(savedAlert);
    pending.resolve(response(503, {})); await vi.advanceTimersByTimeAsync(0);
    expect(render()).toContain(savedAlert);
  });

  it("replaces a saved warning immediately and retains history through deferred and failed refreshes", async () => {
    await settleInitial();
    const pending = deferred<MockResponse>(); nextReadiness = pending.promise;
    confirmSave(savedAlert);
    let html = render();
    expect(html).toContain(savedAlert); expect(html).toContain(historyAlert); expect(html).not.toContain(oldAlert);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/readiness?"))).toHaveLength(2);
    pending.resolve(response(503, {})); await vi.advanceTimersByTimeAsync(0);
    html = render();
    expect(html).toContain(savedAlert); expect(html).toContain(historyAlert); expect(html).not.toContain(oldAlert);
  });

  it("keeps a successful removal removed when a request started before the save returns late", async () => {
    await settleInitial();
    const pending = deferred<MockResponse>(); nextReadiness = pending.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    confirmSave(null);
    expect(render()).not.toContain(oldAlert);
    nextReadiness = response(503, {});
    await vi.advanceTimersByTimeAsync(0);
    pending.resolve(response(200, { visit: visit() })); await vi.advanceTimersByTimeAsync(0);
    const html = render();
    expect(html).not.toContain(oldAlert); expect(html).toContain(historyAlert);
  });

  it("conservatively retains old-server warnings until an explicit split response arrives", async () => {
    await settleInitial(false);
    nextReadiness = response(503, {}); confirmSave(savedAlert);
    let html = render();
    for (const label of [savedAlert, oldAlert, historyAlert]) expect(html).toContain(label);
    await vi.advanceTimersByTimeAsync(0);
    html = render(); for (const label of [savedAlert, oldAlert, historyAlert]) expect(html).toContain(label);
    nextReadiness = response(200, { visit: { ...visit(), alerts: [savedAlert, historyAlert], editableAlert: savedAlert } });
    await vi.advanceTimersByTimeAsync(30_000);
    html = render();
    expect(html).toContain(savedAlert); expect(html).toContain(historyAlert); expect(html).not.toContain(oldAlert);
  });

  it("adopts a warning newer than the initial patient fetch and later cross-tab changes", async () => {
    nextReadiness = response(200, { visit: { ...visit(), alerts: [savedAlert, historyAlert], editableAlert: savedAlert } });
    render(); await vi.advanceTimersByTimeAsync(0);
    let html = render();
    expect(props.fallbackAlert).toBe(oldAlert);
    expect(html).toContain(savedAlert); expect(html).not.toContain(oldAlert);
    nextReadiness = response(200, { visit: { ...visit(), alerts: ["تحذير موظف آخر", historyAlert], editableAlert: "تحذير موظف آخر" } });
    await vi.advanceTimersByTimeAsync(30_000);
    html = render();
    expect(html).toContain("تحذير موظف آخر"); expect(html).not.toContain(savedAlert); expect(html).toContain(historyAlert);
  });

  it("keeps a confirmed save when parent reload fails, then accepts a subsequent authoritative edit or removal", async () => {
    await settleInitial();
    nextReadiness = response(503, {});
    confirmSave(savedAlert, false); // The patient-page GET still holds its old value.
    expect(render()).toContain(savedAlert);
    await vi.advanceTimersByTimeAsync(0);
    expect(render()).toContain(savedAlert); expect(props.fallbackAlert).toBe(oldAlert);
    nextReadiness = response(200, { visit: { ...visit(), alerts: ["تحذير أحدث", historyAlert], editableAlert: "تحذير أحدث" } });
    await vi.advanceTimersByTimeAsync(30_000);
    let html = render();
    expect(html).toContain("تحذير أحدث"); expect(html).not.toContain(savedAlert); expect(html).not.toContain(oldAlert);
    nextReadiness = response(200, { visit: { ...visit(), alerts: [historyAlert], editableAlert: null } });
    await vi.advanceTimersByTimeAsync(30_000);
    html = render();
    expect(html).toContain(historyAlert); expect(html).not.toContain("تحذير أحدث"); expect(html).not.toContain(savedAlert);
  });

  it("does not let an older concurrent poll overwrite a newer explicit response", async () => {
    await settleInitial();
    const earlier = deferred<MockResponse>(); nextReadiness = earlier.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    nextReadiness = response(200, { visit: { ...visit(), alerts: [savedAlert, historyAlert], editableAlert: savedAlert } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(render()).toContain(savedAlert);
    earlier.resolve(response(200, { visit: visit() })); await vi.advanceTimersByTimeAsync(0);
    const html = render();
    expect(html).toContain(savedAlert); expect(html).not.toContain(oldAlert);
  });
});
