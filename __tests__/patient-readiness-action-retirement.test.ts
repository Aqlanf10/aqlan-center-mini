/** Synthetic actual readiness-hook lifecycle tests; no browser/database acceptance. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePatientReadiness } from "../components/patient-workspace/usePatientReadiness";

const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(), pending: [] as Array<() => void>,
  session: { username: "synthetic", role: "doctor", permissions: {} }, visible: "visible" }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => state.session }));
vi.mock("../components/SettingsProvider", () => ({ useChairCount: () => 2 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = state.cursor++; if (!(index in state.values)) state.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial); return [state.values[index], (value: unknown) => { state.values[index] = typeof value === "function" ? value(state.values[index]) : value; }]; },
    useRef: (initial: unknown) => state.values[slot({ current: initial })],
    useCallback: (callback: unknown, deps?: readonly unknown[]) => { const index = slot(undefined); const previous = state.memos.get(index); if (previous && same(previous.deps, deps)) return previous.value; state.memos.set(index, { deps, value: callback }); return callback; },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = slot(undefined); const previous = state.effects.get(index); if (previous && same(previous.deps, deps)) return; state.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); state.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
  };
});
const visit = (changes: Record<string, unknown> = {}) => ({ visitId: 301, patientId: 91, status: "waiting", chair: null, arrivedAt: "2026-10-03T06:00:00Z", seatedAt: null, signedAt: null, cleared: null,
  checklist: [{ key: "medical_history", state: "attention", label: "راجع التاريخ الطبي" }], attention: 1, alerts: ["old", "history warning"], historyAlerts: ["history warning"], editableAlert: "old", balances: null, ...changes });
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, clone() { return this; } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
let readyResponse: ReturnType<typeof response> | Promise<ReturnType<typeof response>>;
let chairsResponse: ReturnType<typeof response>;
let props: Parameters<typeof usePatientReadiness>[0];
function ReadinessProbe() { return usePatientReadiness(props); }
function render() { state.cursor = 0; const value = ReadinessProbe(); state.pending.splice(0).forEach((effect) => effect()); return value; }
async function settle() { await vi.advanceTimersByTimeAsync(0); }
const writes = () => vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method);
beforeEach(() => {
  vi.useFakeTimers(); state.values = []; state.effects.clear(); state.memos.clear(); state.pending = []; state.visible = "visible";
  state.session = { username: "synthetic", role: "doctor", permissions: {} };
  readyResponse = response({ visit: visit(), requireClearance: false }); chairsResponse = response([{ id: 301, status: "waiting", chair: null }]);
  props = { patientId: 91, patientName: "مريض اختبار", patientPhone: null, fallbackAlert: "old", onChanged: vi.fn(), summary: { planVisible: true, openVisit: { id: 301, status: "waiting", chair: null, arrivedAt: "2026-10-03T06:00:00Z", plannedTitle: null }, today: "2026-10-03", lastVisit: null, nextAppointment: null, activePlans: [], plannedVisits: [], counts: { visits: 1, openLabOrders: 0, documents: 0, orthoCase: false }, financial: null, alerts: [], canSeeFinancial: false } };
  vi.stubGlobal("window", { setInterval, clearInterval, addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: vi.fn(() => true), prompt: vi.fn(() => null) });
  vi.stubGlobal("document", { get visibilityState() { return state.visible; }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => options?.method ? Promise.resolve(response({ id: 301, patientId: 91 })) : String(url).includes("readiness") ? Promise.resolve(readyResponse) : Promise.resolve(chairsResponse)));
});
afterEach(() => { state.effects.forEach((effect) => effect.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });

function visibility(value: "visible" | "hidden") {
  state.visible = value;
  const callback = vi.mocked(document.addEventListener).mock.calls.filter(([event]) => event === "visibilitychange").at(-1)?.[1];
  if (typeof callback !== "function") throw new Error("Missing readiness visibility owner");
  callback.call(document, {} as Event);
}
function holdWrites() {
  const pending = deferred<ReturnType<typeof response>>();
  vi.mocked(fetch).mockImplementation(((url: string, options?: RequestInit) => options?.method ? pending.promise
    : String(url).includes("readiness") ? Promise.resolve(readyResponse) : Promise.resolve(chairsResponse)) as typeof fetch);
  return pending;
}

describe("readiness request latch retires independently from its visible action owner", () => {
  it("returns an explicit null chair when every configured chair is occupied", async () => {
    chairsResponse = response([{ id: 500, status: "in_chair", chair: 1 }, { id: 501, status: "called", chair: 2 }]);
    render(); await settle(); expect(render().selectedChair).toBeNull(); await render().enterChair(); expect(writes()).toHaveLength(0);
  });
  it.each(["clear", "enterChair"] as const)("releases %s busy after hidden completion and verifies current state on return", async (action) => {
    render(); await settle(); const pending = holdWrites(); const running = render()[action](); await settle();
    expect(writes()).toHaveLength(1); expect(render().busy).toBe(true); expect(writes()[0][1]).not.toHaveProperty("signal");
    visibility("hidden"); pending.resolve(response({ id: 301 })); await running;
    expect(render().busy).toBe(false); expect(render().readinessKnown).toBe(false); expect(props.onChanged).not.toHaveBeenCalled();
    readyResponse = response({ visit: visit({ status: action === "enterChair" ? "in_chair" : "waiting", chair: action === "enterChair" ? 1 : null }) });
    visibility("visible"); await settle(); expect(render().busy).toBe(false); expect(render().readinessKnown).toBe(true); expect(writes()).toHaveLength(1);
  });
  it.each(["clear", "enterChair"] as const)("does not revive %s after hide/show while its PATCH is still pending", async (action) => {
    render(); await settle(); const pending = holdWrites(); const ready = render(); const running = ready[action](); await settle();
    visibility("hidden"); visibility("visible"); await ready[action](); expect(writes()).toHaveLength(1); expect(render().busy).toBe(true);
    pending.resolve(response({ id: 301 })); await running; await settle();
    expect(render().busy).toBe(false); expect(props.onChanged).not.toHaveBeenCalled(); expect(render().message?.tone).not.toBe("ok"); expect(render().readinessKnown).toBe(true);
  });
  it.each(["alert", "summary-visit", "authority"])("releases the old request after a %s scope change without stale callbacks or a concurrent action", async (field) => {
    render(); await settle(); const pending = holdWrites(); const running = render().clear(); await settle();
    if (field === "alert") { props = { ...props, fallbackAlert: "new warning", confirmedAlert: { revision: 1, value: "new warning" } }; readyResponse = response({ visit: visit({ editableAlert: "new warning" }) }); }
    if (field === "summary-visit") { props = { ...props, summary: { ...props.summary!, openVisit: { ...props.summary!.openVisit!, id: 302 } } }; readyResponse = response({ visit: visit({ visitId: 302 }) }); }
    if (field === "authority") state.session = { username: "replacement", role: "doctor", permissions: {} };
    render(); await settle(); await render().clear(); expect(writes()).toHaveLength(1); expect(render().busy).toBe(true);
    pending.resolve(response({ id: 301 })); await running; await settle();
    expect(render().busy).toBe(false); expect(props.onChanged).not.toHaveBeenCalled(); expect(render().readinessKnown).toBe(true);
    if (field === "alert") expect(render().alerts).toContain("new warning");
    if (field === "summary-visit") expect(render().visit?.visitId).toBe(302);
  });
  it("never sends an emergency retry or asks for a reason after its action was retired", async () => {
    render(); await settle(); const pending = holdWrites(); const running = render().enterChair(); await settle();
    visibility("hidden"); visibility("visible"); vi.mocked(window.prompt).mockReturnValue("must not be requested");
    pending.resolve(response({ code: "clearance_required", message: "Synthetic gated reply" }, 409)); await running; await settle();
    expect(window.prompt).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1); expect(render().busy).toBe(false);
  });
  it("does not revive a pending action across authority A → B → A", async () => {
    render(); await settle(); const original = state.session; const pending = holdWrites(); const running = render().clear(); await settle();
    state.session = { ...original, username: "replacement" }; render(); state.session = original; render();
    pending.resolve(response({ id: 301 })); await running; await settle();
    expect(props.onChanged).not.toHaveBeenCalled(); expect(render().busy).toBe(false); expect(writes()).toHaveLength(1);
  });
  it("carries the in-flight latch through unmount/remount and refreshes the new owner on settlement", async () => {
    render(); await settle(); const pending = holdWrites(); const oldChanged = props.onChanged; const running = render().clear(); await settle();
    state.effects.forEach((effect) => effect.cleanup?.()); state.values = []; state.effects.clear(); state.memos.clear(); state.pending = [];
    props = { ...props, onChanged: vi.fn() }; render(); expect(render().busy).toBe(true); await render().clear(); expect(writes()).toHaveLength(1);
    pending.resolve(response({ id: 301 })); await running; await settle();
    expect(oldChanged).not.toHaveBeenCalled(); expect(props.onChanged).not.toHaveBeenCalled(); expect(render().busy).toBe(false); expect(render().readinessKnown).toBe(true);
  });
  it("retires the latch when a preflight read loses ownership without confirming or sending a write", async () => {
    render(); await settle(); const delayed = deferred<ReturnType<typeof response>>(); readyResponse = delayed.promise;
    const running = render().clear(); props = { ...props, fallbackAlert: "new warning" }; render();
    readyResponse = response({ visit: visit({ editableAlert: "new warning" }) }); delayed.resolve(response({ visit: visit() })); await running; await settle();
    expect(window.confirm).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0); expect(render().busy).toBe(false);
  });
  it("does not equate lost transport with rollback or issue an automatic second write", async () => {
    render(); await settle(); const pending = holdWrites(); const running = render().enterChair(); await settle(); visibility("hidden");
    pending.reject(new Error("Synthetic lost transport")); await running; expect(render().busy).toBe(false);
    readyResponse = response({ visit: visit({ status: "in_chair", chair: 1 }) }); visibility("visible"); await settle();
    expect(render().visit?.status).toBe("in_chair"); expect(render().canEnterChair).toBe(false); expect(writes()).toHaveLength(1); expect(props.onChanged).not.toHaveBeenCalled();
  });
});
