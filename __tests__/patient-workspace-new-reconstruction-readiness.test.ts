/** Tests for NEW RECONSTRUCTION; no historical pass is asserted. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { availablePatientChairs, usePatientReadiness, validPatientReadiness } from "../components/patient-workspace/usePatientReadiness";

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
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = slot(undefined); const previous = state.effects.get(index); if (previous && same(previous.deps, deps)) return; state.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); state.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = slot(undefined); const previous = state.effects.get(index); if (previous && same(previous.deps, deps)) return; state.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); state.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
  };
});
const visit = (changes: Record<string, unknown> = {}) => ({ visitId: 301, patientId: 91, status: "waiting", chair: null, arrivedAt: "2026-10-03T06:00:00Z", seatedAt: null, signedAt: null, cleared: null,
  checklist: [{ key: "medical_history", state: "attention", label: "راجع التاريخ الطبي" }], attention: 1, alerts: ["old", "history warning"], historyAlerts: ["history warning"], editableAlert: "old", balances: null, ...changes });
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
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

describe("new reconstruction readiness contracts", () => {
  it("distinguishes explicit no visit from missing, malformed and foreign payloads", () => {
    expect(validPatientReadiness(null, 91)).toBe(true);
    for (const bad of [undefined, {}, visit({ patientId: 92 }), visit({ signedAt: undefined }), visit({ alerts: "none" }), visit({ checklist: [{}] })]) expect(validPatientReadiness(bad, 91)).toBe(false);
    expect(validPatientReadiness(visit(), 91)).toBe(true);
  });
  it("does not suggest a called chair occupied by another visit", () => {
    const called = visit({ chair: 1, status: "called" });
    expect(availablePatientChairs([{ id: 400, status: "in_chair", chair: 1 }], called as never, 2)).toEqual([]);
    expect(availablePatientChairs([{ id: 301, status: "called", chair: 1 }], called as never, 2)).toEqual([1]);
  });
  it("reads canonical endpoints without mutating on mount", async () => {
    render(); await settle(); expect(render().readinessKnown).toBe(true); expect(render().selectedChair).toBe(1); expect(writes()).toHaveLength(0);
    expect(render().alerts).toEqual(["old", "history warning"]);
  });
  it("treats visit:null as a successful no-visit read only when summary agrees", async () => {
    readyResponse = response({ visit: null }); render(); await settle(); expect(render().readinessKnown).toBe(true); expect(render().canEnterChair).toBe(false);
    props = { ...props, summary: { ...props.summary!, openVisit: null } }; render(); await settle(); expect(render().canEnterChair).toBe(true);
  });
  it("never turns a missing visit field into permission to create one", async () => {
    readyResponse = response({}); render(); await settle(); await render().enterChair(); expect(render().readinessKnown).toBe(false); expect(writes()).toHaveLength(0);
  });
  it("withholds chair actions on a failed availability read", async () => {
    chairsResponse = response({ message: "unavailable" }, 503); render(); await settle(); expect(render().readinessKnown).toBe(true); expect(render().chairsKnown).toBe(false); await render().enterChair(); expect(writes()).toHaveLength(0);
  });
  it("retains known history warnings on transient failure without retaining clearance", async () => {
    render(); await settle(); readyResponse = response({ message: "temporary" }, 503); await render().reload();
    expect(render().readinessKnown).toBe(false); expect(render().visit).toBeNull(); expect(render().alerts).toContain("history warning");
  });
  it("keeps a newer patient GET warning when there is no prior local alert revision", async () => {
    render(); await settle(); props = { ...props, fallbackAlert: "fresh remote warning" }; readyResponse = response({ message: "temporary" }, 503);
    render(); await settle(); expect(render().alerts).toEqual(["fresh remote warning", "history warning"]);
  });
  it("removes sensitive snapshot warnings on hard access denial", async () => {
    render(); await settle(); readyResponse = response({ message: "denied" }, 403); await render().reload(); expect(render().alerts).not.toContain("history warning");
  });
  it("does not clear a visit replaced during its fresh pre-action read", async () => {
    render(); await settle(); readyResponse = response({ visit: visit({ visitId: 302 }) }); await render().clear(); expect(writes()).toHaveLength(0);
  });
  it("does not seat a chair that became occupied after display", async () => {
    render(); await settle(); chairsResponse = response([{ id: 500, status: "in_chair", chair: 1 }]); await render().enterChair(); expect(writes()).toHaveLength(0); expect(render().message?.tone).toBe("warn");
  });
  it("uses the canonical clear PATCH only after current checklist confirmation", async () => {
    render(); await settle(); await render().clear(); expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe("/api/visits/301"); expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ action: "clear" });
  });
  it("serializes repeated clicks before any state rerender", async () => {
    render(); await settle(); const pending = deferred<ReturnType<typeof response>>(); readyResponse = pending.promise;
    const ready = render(); const first = ready.clear(); const second = ready.clear(); expect(writes()).toHaveLength(0);
    pending.resolve(response({ visit: visit() })); await Promise.all([first, second]); expect(writes()).toHaveLength(1);
  });
  it("cancelling review sends no write and creates no history change", async () => {
    render(); await settle(); vi.mocked(window.confirm).mockReturnValue(false); await render().clear(); expect(writes()).toHaveLength(0);
  });
  it("rejects old readiness responses after confirmed alert revision changes", async () => {
    render(); await settle(); const stale = deferred<ReturnType<typeof response>>(); readyResponse = stale.promise; const pending = render().reload();
    props = { ...props, confirmedAlert: { revision: 1, value: "newly saved" }, fallbackAlert: "newly saved" }; readyResponse = response({ visit: visit({ editableAlert: "newly saved" }) }); render(); await settle();
    stale.resolve(response({ visit: visit() })); await pending; expect(render().alerts).toEqual(["newly saved", "history warning"]);
  });
  it("does not execute hidden-tab or restricted-role commands", async () => {
    render(); await settle(); state.visible = "hidden"; await render().clear(); expect(writes()).toHaveLength(0);
    state.visible = "visible"; state.session = { ...state.session, role: "assistant" }; render(); await settle(); await render().enterChair(); expect(writes()).toHaveLength(0);
  });
  it("revokes history warnings before a denied response body finishes parsing", async () => {
    render(); await settle(); const body = deferred<unknown>();
    readyResponse = { ok: false, status: 403, json: () => body.promise };
    const pending = render().reload(); await settle(); expect(render().alerts).not.toContain("history warning"); expect(render().readinessKnown).toBe(false);
    body.resolve({ message: "denied" }); await pending;
  });
  it("does not issue a stale clear after authority changes during the fresh read", async () => {
    render(); await settle(); const delayed = deferred<ReturnType<typeof response>>(); readyResponse = delayed.promise;
    const clearing = render().clear(); state.session = { username: "replacement", role: "doctor", permissions: {} }; render();
    delayed.resolve(response({ visit: visit() })); await clearing; expect(writes()).toHaveLength(0); expect(props.onChanged).not.toHaveBeenCalled();
  });
  it("does not publish a completed old-owner clear into a replacement patient", async () => {
    render(); await settle(); const saved = deferred<ReturnType<typeof response>>();
    vi.mocked(fetch).mockImplementation(((url: string, options?: RequestInit) => options?.method ? saved.promise : String(url).includes("readiness") ? Promise.resolve(readyResponse) : Promise.resolve(chairsResponse)) as typeof fetch);
    const clearing = render().clear(); await settle(); expect(writes()).toHaveLength(1);
    props = { ...props, patientId: 92, patientName: "هوية أخرى", summary: { ...props.summary!, openVisit: null } }; render();
    saved.resolve(response({ id: 301 })); await clearing; expect(props.onChanged).not.toHaveBeenCalled(); expect(render().visit).toBeNull();
  });
  it("suppresses follow-on seating when ownership ends during visit creation", async () => {
    props = { ...props, summary: { ...props.summary!, openVisit: null } }; readyResponse = response({ visit: null }); render(); await settle();
    const created = deferred<ReturnType<typeof response>>(); vi.mocked(fetch).mockImplementation(((url: string, options?: RequestInit) => options?.method === "POST" ? created.promise : String(url).includes("readiness") ? Promise.resolve(readyResponse) : Promise.resolve(chairsResponse)) as typeof fetch);
    const operation = render().enterChair(); await settle(); expect(writes()).toHaveLength(1); state.effects.forEach((effect) => effect.cleanup?.());
    created.resolve(response({ id: 301, patientId: 91 })); await operation; expect(writes()).toHaveLength(1); expect(props.onChanged).not.toHaveBeenCalled();
  });
});
