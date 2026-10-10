import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientPlans } from "../components/PatientPlans";
import { LegacyOrthoPlanContext } from "../components/LegacyOrthoPlanContext";
import type { SessionInfo } from "../components/SessionProvider";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../lib/doctor-permissions";

// Execute the actual wrapper, keyed content and read/write handlers with the
// repository's lightweight hook driver. Transport/session alone are synthetic;
// no browser, database or source-text stand-in is used for these regressions.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  pending: [] as Array<() => void>, session: null as SessionInfo | null,
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
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
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial); const values = hooks.values;
      return [values[index], (value: unknown) => {
        const next = typeof value === "function" ? value(values[index]) : value;
        if (values === hooks.values && !Object.is(next, values[index])) hooks.changed = true;
        values[index] = next;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useMemo: memo, useEffect: effect, useLayoutEffect: effect,
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
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
type MockResponse = ReturnType<typeof response>;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const plan = (id = 301) => ({ id, title: `Synthetic plan ${id}`, totalMinor: 30000, baseCurrency: "SAR", status: "active",
  startDate: "2026-10-04", note: null, items: [], itemsProgress: { count: 0, doneCount: 0, totalMinor: 0, doneMinor: 0, remainingMinor: 0 },
  totalFromItems: false, consentAt: null, consentBy: null, consentNote: null,
  installments: [{ id: 401, number: 1, dueDate: "2026-11-04", amountMinor: 30000 }], paidMinor: 16000,
  progress: { totalMinor: 30000, dueToDateMinor: 30000, paidMinor: 16000, remainingMinor: 14000, overdueMinor: 0,
    nextDueDate: "2026-11-04", nextDueAmountMinor: 14000, paidCount: 0, count: 1 } });
const payload = (financial = true, id = 301) => ({ plans: [{ ...plan(id), ...(financial ? {} : { installments: [], paidMinor: null, progress: null }) }],
  plannedVisits: [], canSeeFinancial: financial, baseCurrency: "SAR" });
let patientId = 201;
let key: string | null = null;
let events: Map<string, Set<() => void>>;
let read: () => Promise<MockResponse>;
let write: () => Promise<MockResponse>;
const fetchMock = vi.fn();
function retire() { hooks.effects.forEach((effect) => effect.cleanup?.()); hooks.effects.clear(); }
function resetOwner() { retire(); hooks.values = []; hooks.memos.clear(); hooks.pending = []; }
function render(): ReactNode {
  let tree: ReactNode;
  let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("Plan lifecycle did not settle");
    hooks.cursor = 0; hooks.changed = false;
    const wrapper = PatientPlans({ patientId }) as Element;
    if (typeof wrapper.type !== "function") { if (key !== null) resetOwner(); key = null; return wrapper; }
    if (wrapper.key !== key) { resetOwner(); key = wrapper.key; }
    hooks.cursor = 0;
    tree = (wrapper.type as (props: Record<string, unknown>) => ReactNode)(wrapper.props);
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
const find = (predicate: (node: Element) => boolean) => elements(render()).find(predicate);
const button = (label: string) => find((node) => node.type === "button" && text(node).trim() === label);
function click(node: Element | undefined) { expect(node).toBeDefined(); return (node!.props.onClick as () => void | Promise<void>)(); }
function focus() { events.get("focus")?.forEach((handler) => handler()); }
async function flush() { for (let pass = 0; pass < 5; pass += 1) { for (let i = 0; i < 15; i += 1) await Promise.resolve(); render(); } }
async function mount() { render(); await flush(); }
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === "POST");

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  hooks.session = { username: "synthetic-a", role: "doctor", permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPatientPayments: true } };
  patientId = 201; key = null; events = new Map(); vi.clearAllMocks();
  const add = (name: string, handler: () => void) => { if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(handler); };
  const remove = (name: string, handler: () => void) => events.get(name)?.delete(handler);
  vi.stubGlobal("window", { addEventListener: add, removeEventListener: remove });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: add, removeEventListener: remove });
  read = async () => response(payload()); write = async () => response({ paymentId: 601 });
  fetchMock.mockImplementation((_url: string, options?: RequestInit) => options?.method === "POST" ? write() : read());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { retire(); vi.unstubAllGlobals(); });

describe("actual PatientPlans financial-read lifetime", () => {
  it("starts hidden and preserves the authorized server values only after a current read", async () => {
    expect(text(render())).not.toContain("المدفوع"); await flush();
    expect(text(render())).toContain("المدفوع"); expect(button("تحصيل قسط")).toBeDefined(); expect(writes()).toEqual([]);
  });
  it.each([401, 403, 503])("a refresh %i retires visible money before a stalled error body", async (status) => {
    await mount(); const body = deferred<unknown>(); const json = vi.fn(() => body.promise);
    read = async () => ({ ...response(null, status), json }); focus();
    expect(text(render())).not.toContain("المدفوع"); expect(button("تحصيل قسط")).toBeUndefined();
    await flush(); expect(json).not.toHaveBeenCalled();
    if (status !== 503) expect(text(render())).not.toContain("Synthetic plan");
    else expect(text(render())).toContain("Synthetic plan 301");
    expect(text(render())).not.toContain("لا توجد خطط علاج");
    expect(writes()).toEqual([]);
  });
  it("unknown refresh preserves an open authoring draft but cannot claim empty or open another create flow", async () => {
    await mount(); await click(button("⚡ خطة سريعة"));
    expect(button("إغلاق الخطة السريعة")).toBeDefined();
    const pending = deferred<MockResponse>(); read = () => pending.promise; focus();
    const tree = render();
    expect(text(tree)).toContain("جارٍ تحديث الخطط"); expect(text(tree)).not.toContain("لا توجد خطط علاج");
    expect(button("إغلاق الخطة السريعة")?.props.disabled).toBe(false);
    expect(button("🦷 تقويم / مبلغ متفق")?.props.disabled).toBe(true);
    pending.resolve(response({}, 503)); await flush();
    expect(button("إغلاق الخطة السريعة")).toBeDefined(); expect(text(render())).not.toContain("لا توجد خطط علاج");
    read = async () => response({}, 403); focus(); await flush();
    expect(button("إغلاق الخطة السريعة")).toBeUndefined();
    expect(button("⚡ خطة سريعة")?.props.disabled).toBe(true);
  });
  it("a parent masked false flag becomes unknown throughout pending and unavailable refresh", async () => {
    const body = payload(false); (body.plans[0] as Record<string, unknown>).hasInstallments = false;
    read = async () => response(body); await mount();
    await click(button("سجّل موافقة المريض — ويُقفل الاتفاق"));
    const consent = () => find((node) => !!node.props.plan && typeof node.props.onDone === "function");
    expect(consent()?.props.scheduleExists).toBe(false);
    const pending = deferred<MockResponse>(); read = () => pending.promise; focus(); render();
    expect(consent()?.props.scheduleExists).toBeNull();
    pending.resolve(response({}, 503)); await flush();
    expect(consent()?.props.scheduleExists).toBeNull();
    read = async () => response(body); focus(); await flush();
    expect(consent()?.props.scheduleExists).toBe(false);
  });
  it.each([401, 403])("a current %i retires the independently cached legacy clinical child through retry", async (status) => {
    await mount(); expect(find((node) => node.type === LegacyOrthoPlanContext)).toBeDefined();
    read = async () => response({}, status); focus(); await flush();
    expect(find((node) => node.type === LegacyOrthoPlanContext)).toBeUndefined();
    const pending = deferred<MockResponse>(); read = () => pending.promise; focus(); render();
    expect(find((node) => node.type === LegacyOrthoPlanContext)).toBeUndefined();
    pending.resolve(response(payload(false))); await flush();
    expect(find((node) => node.type === LegacyOrthoPlanContext)).toBeDefined();
  });
  it("a current-owner collection draft survives an authorized refresh but is retired by masking", async () => {
    await mount(); await click(button("تحصيل قسط"));
    const amount = () => find((node) => node.type === "input" && node.props["aria-label"] === "مبلغ القسط");
    (amount()!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "55" } });
    const pending = deferred<MockResponse>(); read = () => pending.promise; focus(); render();
    expect(amount()).toBeUndefined();
    pending.resolve(response(payload())); await flush();
    expect(amount()?.props.value).toBe("55");
    read = async () => response(payload(false)); focus(); await flush(); expect(amount()).toBeUndefined();
    read = async () => response(payload()); focus(); await flush();
    expect(amount()).toBeUndefined(); expect(button("تحصيل قسط")).toBeDefined(); expect(writes()).toEqual([]);
  });
  it("a successful current-owner collection keeps its receipt after the authorized reload", async () => {
    await mount(); await click(button("تحصيل قسط"));
    const amount = find((node) => node.type === "input" && node.props["aria-label"] === "مبلغ القسط")!;
    (amount.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "140" } });
    await click(button("سجّل القسط واطبع السند")); await flush();
    expect(writes()).toHaveLength(1);
    expect(text(render())).toContain("سُجّل القسط.");
    expect(find((node) => node.type === "a" && node.props.href === "/print/receipt/601")).toBeDefined();
    const pending = deferred<MockResponse>(); read = () => pending.promise; focus(); render();
    expect(find((node) => node.type === "a" && node.props.href === "/print/receipt/601")).toBeUndefined();
    pending.resolve(response(payload())); await flush();
    expect(find((node) => node.type === "a" && node.props.href === "/print/receipt/601")).toBeDefined();
    read = async () => response(payload(false)); focus(); await flush();
    expect(find((node) => node.type === "a" && node.props.href === "/print/receipt/601")).toBeUndefined();
    read = async () => response(payload()); focus(); await flush();
    expect(find((node) => node.type === "a" && node.props.href === "/print/receipt/601")).toBeUndefined();
  });
  it("a delayed older JSON body cannot revive money after a newer masked read", async () => {
    await mount(); const old = deferred<unknown>();
    read = async () => ({ ...response(null), json: () => old.promise }); focus(); await flush();
    read = async () => response(payload(false, 302)); focus(); await flush();
    old.resolve(payload(true, 301)); await flush();
    expect(text(render())).toContain("Synthetic plan 302"); expect(text(render())).not.toContain("المدفوع");
    expect(text(render())).not.toContain("Synthetic plan 301");
  });
  it("an older denial cannot overwrite a newer successful refresh", async () => {
    await mount(); const old = deferred<MockResponse>(); read = () => old.promise; focus();
    read = async () => response(payload(true, 302)); focus(); await flush();
    old.resolve(response({}, 403)); await flush();
    expect(text(render())).toContain("Synthetic plan 302"); expect(text(render())).toContain("المدفوع");
    expect(text(render())).not.toContain("غير مصرّح");
  });
  it.each(["patient", "principal", "role", "payment-permission", "plan-permission", "logout"])("keys and retires the actual content immediately on %s change", async (change) => {
    await mount(); const old = deferred<MockResponse>(); read = () => old.promise; focus();
    if (change === "patient") patientId = 202;
    if (change === "principal") hooks.session = { ...hooks.session!, username: "synthetic-b" };
    if (change === "role") hooks.session = { ...hooks.session!, role: "reception" };
    if (change === "payment-permission") hooks.session = { ...hooks.session!, permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPatientPayments: false } };
    if (change === "plan-permission") hooks.session = { ...hooks.session!, permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPlans: false } };
    if (change === "logout") hooks.session = null;
    read = async () => response({}, 403);
    expect(text(render())).not.toContain("المدفوع"); expect(text(render())).not.toContain("Synthetic plan 301");
    old.resolve(response(payload())); await flush();
    expect(text(render())).not.toContain("المدفوع"); expect(button("تحصيل قسط")).toBeUndefined(); expect(writes()).toEqual([]);
  });
  it("A to B to A cannot restore A's accepted or pending financial snapshot", async () => {
    await mount(); const old = deferred<MockResponse>(); read = () => old.promise; focus();
    const original = hooks.session; read = async () => response({}, 403);
    hooks.session = { ...original!, username: "synthetic-b" }; render();
    hooks.session = original; expect(text(render())).not.toContain("المدفوع");
    old.resolve(response(payload())); await flush(); expect(text(render())).not.toContain("المدفوع");
  });
  it("unmount aborts the old read and removes refresh listeners", async () => {
    const old = deferred<MockResponse>(); read = () => old.promise; render();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    retire(); expect(signal.aborted).toBe(true); expect(events.get("focus")?.size).toBe(0);
    old.resolve(response(payload())); for (let i = 0; i < 30; i += 1) await Promise.resolve();
    expect(JSON.stringify(hooks.values)).not.toContain("Synthetic plan"); expect(writes()).toEqual([]);
  });
  it("a sent original-owner collection cannot refresh or publish into a later principal", async () => {
    await mount(); await click(button("تحصيل قسط"));
    const amount = find((node) => node.type === "input" && node.props["aria-label"] === "مبلغ القسط")!;
    (amount.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "140" } });
    const pending = deferred<MockResponse>(); write = () => pending.promise;
    void click(button("سجّل القسط واطبع السند"));
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe("/api/plans/301");
    expect(writes()[0][1].headers["Idempotency-Key"]).toBeTruthy();
    hooks.session = { ...hooks.session!, username: "synthetic-b" }; read = async () => response({}, 403); render(); await flush();
    const readsBefore = fetchMock.mock.calls.filter(([, options]) => !options?.method).length;
    pending.resolve(response({ paymentId: 601 })); await flush();
    expect(fetchMock.mock.calls.filter(([, options]) => !options?.method)).toHaveLength(readsBefore);
    expect(text(render())).not.toContain("سُجّل القسط."); expect(text(render())).not.toContain("المدفوع");
    expect(writes()).toHaveLength(1);
  });
});


describe("actual consent schedule visibility", () => {
  it.each([
    [false, true, false, true], [false, false, false, false],
    [false, undefined, false, null], [false, null, false, null], [false, "false", false, null],
    [true, undefined, false, true], [true, undefined, true, false],
  ])("financial=%s flag=%s empty=%s gives schedule=%s", async (financial, flag, empty, expected) => {
    const body = payload(financial as boolean);
    const row = body.plans[0] as Record<string, unknown>;
    row.hasInstallments = flag;
    if (empty) row.installments = [];
    read = async () => response(body); await mount();
    await click(button("سجّل موافقة المريض — ويُقفل الاتفاق"));
    const node = find((entry) => !!entry.props.plan && typeof entry.props.onDone === "function")!;
    expect(node.props.scheduleExists).toBe(expected);
    const Component = node.type as (props: Record<string, unknown>) => ReactNode;
    const props = { ...node.props, onError: vi.fn(), onDone: vi.fn() };
    resetOwner(); hooks.cursor = 0;
    const tree = Component(props);
    const checkboxes = elements(tree).filter((entry) => entry.type === "input" && entry.props.type === "checkbox");
    expect(checkboxes).toHaveLength(expected === false ? 1 : 0);
    if (expected === true) expect(text(tree)).toContain("جدول أقساط قائم");
    if (expected === null) expect(text(tree)).toContain("غير متحقق");
    expect(writes()).toEqual([]);
  });
  it("a retained split draft cannot submit schedule creation after its existence becomes unknown", async () => {
    const body = payload(false); (body.plans[0] as Record<string, unknown>).hasInstallments = false;
    read = async () => response(body); await mount();
    await click(button("سجّل موافقة المريض — ويُقفل الاتفاق"));
    const node = find((entry) => !!entry.props.plan && typeof entry.props.onDone === "function")!;
    const Component = node.type as (props: Record<string, unknown>) => ReactNode;
    const props = { ...node.props, onError: vi.fn(), onDone: vi.fn(), scheduleExists: false as boolean | null };
    resetOwner(); hooks.cursor = 0;
    const checkbox = elements(Component(props)).find((entry) => entry.type === "input" && entry.props.type === "checkbox")!;
    (checkbox.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    props.scheduleExists = null; hooks.cursor = 0;
    const tree = Component(props);
    const submit = elements(tree).find((entry) => entry.type === "button" && text(entry) === "سجّل الموافقة")!;
    expect(submit.props.disabled).toBe(true);
    (submit.props.onClick as () => void)();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(writes()).toEqual([]);
  });
});
