import { createElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientCockpit } from "../components/patient/PatientCockpit";
import type { SessionInfo } from "../components/SessionProvider";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../lib/doctor-permissions";

// Actual cockpit, hook and canonical sendGatedMove handlers; only React's small
// state/effect driver, session/settings and transport are synthetic. No browser,
// database, route handler, Production data or authorization substitute is used.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(), pending: [] as Array<() => void>,
  session: null as SessionInfo | null,
  visible: "visible",
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("../components/SettingsProvider", () => ({ useChairCount: () => 2 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined); const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  const effect = (callback: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined); const previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = callback(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial); return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useMemo: memo,
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
  return { ok: status >= 200 && status < 300, status, json: async () => body, clone: () => response(body, status) };
}
type MockResponse = ReturnType<typeof response>;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const visit = (changes: Record<string, unknown> = {}) => ({ visitId: 301, patientId: 91, status: "waiting", chair: null,
  arrivedAt: "2026-10-04T06:00:00Z", seatedAt: null, signedAt: null, cleared: null,
  checklist: [{ key: "alerts", state: "attention", label: "راجع التحذير" }], attention: 1,
  alerts: ["تحذير محفوظ"], balances: [{ currency: "SAR", dueMinor: 500, warn: false }], ...changes });
const chair = (changes: Record<string, unknown> = {}) => ({ id: 301, patientId: 91, status: "waiting", chair: null, ...changes });
let props: Parameters<typeof PatientCockpit>[0];
let ready: MockResponse | Promise<MockResponse>;
let chairs: MockResponse | Promise<MockResponse>;
let mutation: ((url: string, options: RequestInit) => MockResponse | Promise<MockResponse>) | null;
let events: Map<string, Set<() => void>>;
const fetchMock = vi.fn();
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method);
function render() { hooks.cursor = 0; const tree = PatientCockpit(props); hooks.pending.splice(0).forEach((effect) => effect()); return tree; }
function button(label: string, tree: ReactNode = render()) { return elements(tree).find((node) => node.type === "button" && text(node).includes(label)); }
const entry = () => button("إدخال إلى الكرسي");
function click(node: Element | undefined) { expect(node).toBeDefined(); (node!.props.onClick as () => void)(); }
const settle = () => vi.advanceTimersByTimeAsync(0);
async function mounted() { render(); await settle(); return render(); }
function fire(name: string) { events.get(name)?.forEach((handler) => handler()); }
function retire() { hooks.effects.forEach((effect) => effect.cleanup?.()); hooks.effects.clear(); }
function remount() { retire(); hooks.values = []; hooks.memos.clear(); hooks.pending = []; return render(); }

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); hooks.values = []; hooks.cursor = 0; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  hooks.session = { username: "synthetic", role: "doctor", permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPatientPayments: true } }; hooks.visible = "visible"; events = new Map();
  const add = (name: string, handler: () => void) => { if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(handler); };
  const remove = (name: string, handler: () => void) => events.get(name)?.delete(handler);
  vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: add, removeEventListener: remove, prompt: vi.fn(() => null) });
  vi.stubGlobal("document", { get visibilityState() { return hooks.visible; }, addEventListener: add, removeEventListener: remove });
  ready = response({ visit: visit() }); chairs = response([chair()]); mutation = null;
  props = { compact: true, patientId: 91, patientName: "مريض اختبار", patientPhone: null, fallbackAlert: "تنبيه الملف", onChanged: vi.fn(), onOpenTab: vi.fn(),
    summary: { openVisit: { id: 301, status: "waiting", chair: null, arrivedAt: "2026-10-04T06:00:00Z", plannedTitle: null },
      lastVisit: null, nextAppointment: null, activePlans: [], plannedVisits: [], counts: { visits: 1, openLabOrders: 0, documents: 0, orthoCase: false }, financial: null, alerts: [], canSeeFinancial: true } };
  fetchMock.mockImplementation((url: string, options?: RequestInit) => {
    if (!options?.method) return Promise.resolve(url.includes("readiness") ? ready : chairs);
    if (mutation) return Promise.resolve(mutation(url, options));
    const body = JSON.parse(String(options.body));
    if (body.action === "clear") {
      ready = response({ visit: visit({ cleared: { at: "2026-10-04T06:00:01Z", by: "synthetic" } }) });
      return Promise.resolve(response({ ok: true, clearedAt: "2026-10-04T06:00:01Z", clearedBy: "synthetic" }));
    }
    ready = response({ visit: visit({ status: "in_chair", chair: 1, seatedAt: "2026-10-04T06:00:01Z" }) });
    chairs = response([chair({ status: "in_chair", chair: 1 })]);
    return Promise.resolve(response({ id: 301, patientId: 91, status: "in_chair", chair: 1 }));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { retire(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("cockpit only commands from known current readiness", () => {
  it("starts visibly unknown, with no entry/clear command and no write on mount", async () => {
    const pending = deferred<MockResponse>(); ready = pending.promise;
    const tree = render(); expect(text(tree)).toContain("قيد التحقق"); expect(entry()).toBeUndefined(); expect(button("أقِرّ الجاهزية")).toBeUndefined();
    await settle(); expect(writes()).toHaveLength(0); expect(text(render())).not.toContain("لا زيارة اليوم");
    pending.resolve(response({ visit: visit() })); await settle(); expect(entry()?.props.disabled).toBe(false);
  });
  it.each([401, 403, 404, 503])("a readiness %i never becomes no-visit or chair permission", async (status) => {
    ready = response({ message: "unavailable" }, status); await mounted();
    expect(text(render())).toContain("غير متاحة"); expect(entry()).toBeUndefined(); expect(button("أقِرّ الجاهزية")).toBeUndefined(); expect(writes()).toHaveLength(0);
  });
  it.each([undefined, {}, { visit: undefined }, { visit: visit({ patientId: 92 }) }, { visit: visit({ signedAt: undefined }) }])("rejects missing/malformed/foreign readiness %#", async (payload) => {
    ready = response(payload); await mounted(); expect(entry()).toBeUndefined(); expect(text(render())).toContain("غير متاحة"); expect(writes()).toHaveLength(0);
  });
  it.each([403, 404, 503])("keeps chair availability unknown on a list %i", async (status) => {
    chairs = response({}, status); await mounted(); expect(entry()).toBeUndefined(); expect(text(render())).toContain(status === 503 ? "إتاحة الكراسي غير معروفة" : "غير متاحة"); expect(writes()).toHaveLength(0);
  });
  it("does not guess chair availability from delayed or duplicate/foreign-shaped rows", async () => {
    const pending = deferred<MockResponse>(); chairs = pending.promise; await mounted(); expect(entry()).toBeUndefined();
    pending.resolve(response([chair(), chair()])); await settle(); expect(entry()).toBeUndefined(); expect(writes()).toHaveLength(0);
  });
  it("allows confirmed no-visit despite a historical summary but never from unknown reads", async () => {
    ready = response({ visit: null }); chairs = response([]); await mounted(); expect(entry()?.props.disabled).toBe(false);
    props = { ...props, summary: { ...props.summary!, openVisit: null } }; render(); await settle(); expect(entry()?.props.disabled).toBe(false); expect(writes()).toHaveLength(0);
    chairs = response([chair()]); fire("focus"); await settle(); expect(entry()).toBeUndefined();
  });
  it("allows a current externally created visit when the parent summary has not polled", async () => {
    props.summary = { ...props.summary!, openVisit: null }; await mounted(); expect(entry()?.props.disabled).toBe(false);
    click(entry()); await settle(); expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe("/api/visits/301");
  });
  it("rejects enum-shaped arrays rather than treating occupied chairs as free", async () => {
    chairs = response([chair(), chair({ id: 302, patientId: 92, chair: 1, status: ["in_chair"] })]);
    await mounted(); expect(entry()).toBeUndefined(); expect(writes()).toHaveLength(0);
  });
  it("does not treat an active patient row absent from readiness as permission to create", async () => {
    props.summary = { ...props.summary!, openVisit: null }; ready = response({ visit: null });
    await mounted(); expect(entry()).toBeUndefined(); expect(text(render())).toContain("غير متطابقة"); expect(writes()).toHaveLength(0);
  });
  it("does not re-offer a called chair occupied by a different patient", async () => {
    props.summary = { ...props.summary!, openVisit: { ...props.summary!.openVisit!, status: "called", chair: 1 } };
    ready = response({ visit: visit({ status: "called", chair: 1 }) }); chairs = response([chair({ status: "called", chair: 1 }), chair({ id: 302, patientId: 92, status: "in_chair", chair: 1 })]);
    await mounted(); expect(entry()?.props.disabled ?? true).toBe(true); expect(writes()).toHaveLength(0);
  });
  it("refresh immediately hides stale clearance/balances while keeping same-scope medical warnings", async () => {
    ready = response({ visit: visit({ cleared: { at: "2026-10-04T06:00:00Z", by: "doctor" } }) }); await mounted(); expect(text(render())).toContain("جاهز ✓");
    const pending = deferred<MockResponse>(); ready = pending.promise; fire("focus");
    const tree = render(); expect(text(tree)).not.toContain("جاهز ✓"); expect(text(tree)).not.toContain("عليه"); expect(text(tree)).toContain("تحذير محفوظ"); expect(entry()).toBeUndefined();
    pending.resolve(response({}, 503)); await settle(); expect(entry()).toBeUndefined();
  });
  it("hard denial revokes cached warnings before a stuck body or peer settles", async () => {
    await mounted(); const peer = deferred<MockResponse>(); const body = deferred<unknown>();
    ready = { ...response(null, 403), json: () => body.promise }; chairs = peer.promise; fire("focus"); await settle();
    expect(text(render())).not.toContain("تحذير محفوظ"); expect(text(render())).not.toContain("تنبيه الملف"); expect(entry()).toBeUndefined();
    peer.resolve(response([chair()])); await settle(); expect(entry()).toBeUndefined();
    const retry = deferred<MockResponse>(); ready = retry.promise; fire("focus"); await settle();
    expect(text(render())).not.toContain("تنبيه الملف"); expect(text(render())).not.toContain("تحذير محفوظ");
    retry.resolve(response({ visit: visit() })); await settle(); expect(text(render())).toContain("تنبيه الملف");
  });
  it.each([401, 403, 404])("chair-list %i revokes alerts before a stalled successful readiness peer", async (status) => {
    await mounted(); const pending = deferred<MockResponse>(); ready = pending.promise; chairs = response({}, status); fire("focus"); await settle();
    expect(text(render())).not.toContain("تحذير محفوظ"); expect(text(render())).not.toContain("تنبيه الملف"); expect(entry()).toBeUndefined();
    pending.resolve(response({ visit: visit() })); await settle(); expect(entry()).toBeUndefined(); expect(text(render())).not.toContain("تحذير محفوظ");
    const retry = deferred<MockResponse>(); ready = retry.promise; chairs = response([chair()]); fire("focus"); await settle(); expect(text(render())).not.toContain("تنبيه الملف");
    retry.resolve(response({ visit: visit() })); await settle(); expect(entry()?.props.disabled).toBe(false);
  });
  it("retires slower older responses including delayed JSON", async () => {
    await mounted(); const oldBody = deferred<unknown>(); ready = { ...response(null), json: () => oldBody.promise }; fire("focus"); await settle();
    ready = response({ visit: visit({ signedAt: "2026-10-04T07:00:00Z", alerts: ["تحذير أحدث"] }) }); fire("focus"); await settle();
    oldBody.resolve({ visit: visit() }); await settle(); expect(text(render())).toContain("وُقّعت الزيارة"); expect(text(render())).toContain("تحذير أحدث"); expect(text(render())).not.toContain("تحذير محفوظ"); expect(entry()).toBeUndefined();
  });
  it.each(["patient", "authority", "logout"])("fences a delayed read after %s changes and immediately hides old values", async (change) => {
    await mounted(); const old = deferred<MockResponse>(); ready = old.promise; fire("focus"); await settle();
    if (change === "patient") props = { ...props, patientId: 92, patientName: "مريض آخر", fallbackAlert: null, summary: { ...props.summary!, openVisit: null } };
    else if (change === "authority") hooks.session = { username: "other", role: "doctor", permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPatientPayments: false } };
    else hooks.session = null;
    const tree = render(); expect(text(tree)).not.toContain("تحذير محفوظ"); expect(text(tree)).not.toContain("تنبيه الملف"); expect(text(tree)).not.toContain("عليه"); expect(entry()).toBeUndefined();
    ready = response({}, 403); await settle(); old.resolve(response({ visit: visit() })); await settle(); expect(entry()).toBeUndefined(); expect(text(render())).not.toContain("تحذير محفوظ");
  });
  it("blocks a captured former-context action and handles an A→B→A read without revival", async () => {
    await mounted(); const oldEntry = entry(); const old = deferred<MockResponse>(); ready = old.promise; fire("focus"); await settle();
    const original = props; props = { ...props, patientId: 92, fallbackAlert: null }; render(); ready = response({}, 403); await settle(); click(oldEntry);
    props = original; render(); await settle(); old.resolve(response({ visit: visit() })); await settle();
    expect(entry()).toBeUndefined(); expect(writes()).toHaveLength(0);
  });
  it("does not revive an accepted A snapshot during rapid A→B→A commits before timers", async () => {
    ready = response({ visit: visit({ cleared: { at: "2026-10-04T06:00:00Z", by: "synthetic" } }) });
    await mounted(); expect(text(render())).toContain("جاهز ✓"); expect(text(render())).toContain("عليه");
    const original = hooks.session; hooks.session = { username: "other", role: "doctor", permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPatientPayments: true } }; render();
    hooks.session = original; const tree = render();
    expect(text(tree)).not.toContain("جاهز ✓"); expect(text(tree)).not.toContain("عليه"); expect(text(tree)).not.toContain("تحذير محفوظ"); expect(text(tree)).not.toContain("تنبيه الملف"); expect(entry()).toBeUndefined();
    await settle(); expect(entry()?.props.disabled).toBe(false); expect(writes()).toHaveLength(0);
  });
  it.each(["visit", "chair", "signed"])("fresh command reads stop a stale %s before mutation", async (change) => {
    await mounted(); const target = entry();
    if (change === "visit") { ready = response({ visit: visit({ visitId: 302 }) }); chairs = response([chair({ id: 302 })]); }
    if (change === "chair") chairs = response([chair(), chair({ id: 302, patientId: 92, chair: 1, status: "in_chair" })]);
    if (change === "signed") ready = response({ visit: visit({ signedAt: "2026-10-04T07:00:00Z" }) });
    click(target); await settle(); expect(writes()).toHaveLength(0);
  });
  it("fresh-read failure stops clearance and seat commands", async () => {
    await mounted(); const clear = button("أقِرّ الجاهزية"); ready = response({}, 503); click(clear); await settle(); expect(writes()).toHaveLength(0);
    ready = response({ visit: visit() }); fire("focus"); await settle(); const seat = entry(); chairs = response({}, 503); click(seat); await settle(); expect(writes()).toHaveLength(0);
  });
  it("a ready valid visit uses the existing seat PATCH exactly once for synchronous double clicks", async () => {
    await mounted(); const target = entry(); click(target); click(target); await settle();
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe("/api/visits/301"); expect(JSON.parse(String(writes()[0][1].body))).toEqual({ action: "seat", chair: 1 }); expect(props.onChanged).toHaveBeenCalledTimes(1);
  });
  it("valid clearance still uses the existing clear PATCH", async () => {
    await mounted(); click(button("أقِرّ الجاهزية")); await settle(); expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1].body))).toEqual({ action: "clear" }); expect(text(render())).toContain("جاهز ✓");
  });
  it("confirmed no visit creates once, verifies the created identity, then seats the verified visit", async () => {
    props.summary = { ...props.summary!, openVisit: null }; ready = response({ visit: null }); chairs = response([]);
    mutation = (url) => {
      if (url === "/api/visits") { ready = response({ visit: visit() }); chairs = response([chair()]); return response({ id: 301, patientId: 91 }, 201); }
      return response({ id: 301, patientId: 91, chair: 1 });
    };
    await mounted(); const target = entry(); click(target); click(target); await settle();
    expect(writes().map(([url, options]) => [url, options.method])).toEqual([["/api/visits", "POST"], ["/api/visits/301", "PATCH"]]);
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });
  it.each(["foreign", "conflict", "unverified"])("never follows %s creation with blind seating", async (failure) => {
    props.summary = { ...props.summary!, openVisit: null }; ready = response({ visit: null }); chairs = response([]);
    mutation = () => response(failure === "foreign" ? { id: 302, patientId: 92 } : failure === "conflict" ? { visitId: 302 } : { id: 301, patientId: 91 }, failure === "conflict" ? 409 : 201);
    await mounted(); click(entry()); await settle(); expect(writes()).toHaveLength(1); expect(writes()[0][1].method).toBe("POST");
    expect(props.onChanged).toHaveBeenCalledTimes(1);
    if (failure === "unverified") { expect(text(render())).toContain("سُجّل الوصول"); remount(); await settle(); expect(text(render())).toContain("سُجّل الوصول"); }
  });
  it("keeps a sent request latched through remount and retires its result", async () => {
    const sent = deferred<MockResponse>(); mutation = () => sent.promise; await mounted(); click(entry()); await settle(); expect(writes()).toHaveLength(1);
    remount(); await settle(); expect(entry()?.props.disabled ?? true).toBe(true); expect(writes()).toHaveLength(1);
    sent.resolve(response({ id: 301, patientId: 91, chair: 1 })); await settle(); expect(props.onChanged).not.toHaveBeenCalled(); expect(text(render())).not.toContain("على الكرسي 1");
  });
  it("a patient change after arrival creation prevents seating another context", async () => {
    props.summary = { ...props.summary!, openVisit: null }; ready = response({ visit: null }); chairs = response([]);
    const sent = deferred<MockResponse>(); mutation = () => sent.promise; await mounted(); click(entry()); await settle();
    props = { ...props, patientId: 92, patientName: "مريض آخر", fallbackAlert: null }; ready = response({}, 403); render(); await settle();
    sent.resolve(response({ id: 301, patientId: 91 }, 201)); await settle(); expect(writes()).toHaveLength(1); expect(props.onChanged).not.toHaveBeenCalled();
  });
  it("hide/show retires a precommand read without sending a write", async () => {
    await mounted(); const pending = deferred<MockResponse>(); ready = pending.promise; click(entry()); await settle();
    hooks.visible = "hidden"; fire("visibilitychange"); render(); hooks.visible = "visible"; fire("visibilitychange");
    pending.resolve(response({ visit: visit() })); ready = response({ visit: visit() }); await settle(); expect(writes()).toHaveLength(0);
  });
  it("hide/show cannot repeat a sent write and cannot publish its retired result", async () => {
    const sent = deferred<MockResponse>(); mutation = () => sent.promise; await mounted(); click(entry()); await settle(); expect(writes()).toHaveLength(1);
    hooks.visible = "hidden"; fire("visibilitychange"); render(); hooks.visible = "visible"; fire("visibilitychange"); await settle();
    expect(entry()?.props.disabled ?? true).toBe(true); expect(writes()).toHaveLength(1);
    sent.resolve(response({ id: 301, patientId: 91, chair: 1 })); await settle(); expect(props.onChanged).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
  });
  it("times out a stuck precommand read without creating a patient visit", async () => {
    await mounted(); const pending = deferred<MockResponse>(); ready = pending.promise; click(entry()); await settle();
    await vi.advanceTimersByTimeAsync(15_000); expect(writes()).toHaveLength(0);
    const retry = button("إعادة التحقق"); expect(retry).toBeDefined(); expect(retry?.props.disabled).toBe(false);
    ready = response({ visit: visit() }); click(retry); await settle(); expect(entry()?.props.disabled).toBe(false);
    pending.resolve(response({ visit: visit() })); await settle(); expect(writes()).toHaveLength(0);
    click(entry()); await settle(); expect(writes()).toHaveLength(1);
  });
  it("an action denial retires sensitive context without waiting for its body", async () => {
    await mounted(); const body = deferred<unknown>();
    mutation = () => { ready = response({}, 403); return { ...response({}, 403), json: () => body.promise }; };
    click(entry()); await settle(); expect(writes()).toHaveLength(1); expect(text(render())).not.toContain("تحذير محفوظ"); expect(text(render())).not.toContain("تنبيه الملف");
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });
  it("a new session principal is not held by another principal's denied scope", async () => {
    ready = response({}, 403); await mounted(); expect(text(render())).not.toContain("تنبيه الملف");
    hooks.session = { username: "new-doctor", role: "doctor", permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPatientPayments: true } }; ready = response({ visit: visit() }); render(); await settle();
    expect(entry()?.props.disabled).toBe(false); expect(text(render())).toContain("تحذير محفوظ");
  });
  it("keeps the authorized emergency reason path on the canonical gate", async () => {
    let attempt = 0;
    mutation = () => ++attempt === 1 ? response({ code: "clearance_required", message: "راجع الجاهزية" }, 409) : response({ id: 301, patientId: 91, chair: 1 });
    vi.mocked(window.prompt).mockReturnValue("سبب اختبار"); await mounted(); click(entry()); await settle();
    expect(writes()).toHaveLength(2); expect(JSON.parse(String(writes()[1][1].body))).toEqual({ action: "seat", chair: 1, emergency: true, emergencyReason: "سبب اختبار" });
  });
  it("preserves the canonical emergency gate and does not retry after authority retirement", async () => {
    const gate = deferred<MockResponse>(); mutation = () => gate.promise; await mounted(); click(entry()); await settle();
    hooks.session = { username: "other", role: "doctor", permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPatientPayments: true } }; ready = response({}, 403); render(); await settle();
    gate.resolve(response({ code: "clearance_required", message: "راجع الجاهزية" }, 409)); await settle();
    expect(window.prompt).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
  });
  it("assistant/read-only and missing sessions never gain entry or clearance controls", async () => {
    hooks.session = { username: "assistant", role: "assistant" }; await mounted(); expect(entry()).toBeUndefined(); expect(button("أقِرّ الجاهزية")).toBeUndefined();
    hooks.session = null; render(); await settle(); expect(entry()).toBeUndefined(); expect(writes()).toHaveLength(0);
  });
});


describe("compact patient context presentation with the actual readiness hook", () => {
  it("shows complete medical warnings outside the disclosure and reuses each presentation slot once", async () => {
    const warnings = ["حساسية دواء اصطناعية", "تحذير ثان مستقل", "التحذير الثالث كامل " + "تحذيرطويل".repeat(25)];
    ready = response({ visit: visit({ alerts: warnings }) });
    props = { ...props,
      identity: createElement("h1", { "data-testid": "identity-slot" }, "هوية المريض ورقمه"),
      primaryAction: createElement("button", { "data-testid": "primary-slot" }, "الإجراء الرئيسي"),
      secondaryActions: createElement("button", { "data-testid": "secondary-slot" }, "بيانات المريض والإجراءات"),
      safety: createElement("span", { "data-testid": "safety-slot" }, "ضغط مرتفع وعلم المريض"),
    };
    const tree = await mounted();
    for (const warning of warnings) expect(text(tree)).toContain(warning);
    expect(text(tree)).not.toContain(" …");
    for (const id of ["identity-slot", "primary-slot", "secondary-slot", "safety-slot"])
      expect(elements(tree).filter(node => node.props["data-testid"] === id)).toHaveLength(1);
    const disclosure = elements(tree).find(node => node.props["data-testid"] === "patient-visit-details");
    expect(disclosure?.type).toBe("details");
    expect(disclosure?.props.open).toBeUndefined();
    for (const warning of warnings) expect(text(disclosure)).not.toContain(warning);
    expect(writes()).toHaveLength(0);
  });

  it("keeps retry and command feedback visible outside the visit-details disclosure", async () => {
    ready = response({}, 503); const tree = await mounted();
    const disclosure = elements(tree).find(node => node.props["data-testid"] === "patient-visit-details");
    expect(button("إعادة التحقق", tree)).toBeDefined();
    expect(text(disclosure)).not.toContain("إعادة التحقق");
    ready = response({ visit: visit() }); click(button("إعادة التحقق", tree)); await settle();
    mutation = () => response({ message: "رفض اصطناعي مرئي" }, 409);
    click(entry()); await settle();
    const changed = render();
    expect(elements(changed).find(node => node.props.role === "alert" && text(node).includes("رفض اصطناعي مرئي"))).toBeDefined();
    expect(text(elements(changed).find(node => node.props["data-testid"] === "patient-visit-details"))).not.toContain("رفض اصطناعي مرئي");
  });

  it.each([true, false])("keeps %s compact context nonsticky and the original controls guarded", async compact => {
    props = { ...props, compact }; const tree = await mounted();
    expect(tree.props["data-compact"]).toBe(String(compact));
    expect(tree.props.className).not.toMatch(/(?:^|\s)(?:sticky|fixed|top-0)(?:\s|$)/);
    expect(entry()?.props.disabled).toBe(false);
    expect(writes()).toHaveLength(0);
  });
});
