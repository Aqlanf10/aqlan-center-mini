/** Actual modal and callbacks with synthetic hooks/transport. Not a DOM, HTTP,
 * database or financial writer test. No runtime executed during authoring. */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LabReconciliationModal } from "../components/LabReconciliationModal";
import type { SessionInfo } from "../components/SessionProvider";

type Hooks = { values: unknown[]; cursor: number; changed: boolean; mounted: boolean; lateUpdates: number;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void; layout: boolean }>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>; pending: Array<() => void>; layout: Array<() => void> };
const runtime = vi.hoisted(() => ({ current: null as Hooks | null, session: null as SessionInfo | null }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const current = () => { if (!runtime.current) throw new Error("Missing synthetic owner"); return runtime.current; };
  const slot = (hooks: Hooks, initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => { const hooks = current(); const index = slot(hooks, undefined); const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = compute(); hooks.memos.set(index, { deps, value }); return value; };
  const effect = (layout: boolean) => (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const hooks = current(); const index = slot(hooks, undefined); const previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    (layout ? hooks.layout : hooks.pending).push(() => { previous?.cleanup?.(); if (previous) previous.cleanup = undefined;
      const cleanup = run(); hooks.effects.set(index, { deps, layout, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => { const hooks = current(); const index = slot(hooks, typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => { if (!hooks.mounted) hooks.lateUpdates++;
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next; }]; },
    useRef: (initial: unknown) => { const hooks = current(); return hooks.values[slot(hooks, { current: initial })]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect(false), useLayoutEffect: effect(true),
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => runtime.session }));

type Element = ReactElement<Record<string, unknown>>;
type Props = Parameters<typeof LabReconciliationModal>[0];
let hooks: Hooks; let props: Props;
function unmount() { hooks.effects.forEach((effect) => { effect.cleanup?.(); effect.cleanup = undefined; }); hooks.mounted = false; }
function resetOwner() { hooks = { values: [], cursor: 0, changed: false, mounted: true, lateUpdates: 0, effects: new Map(), memos: new Map(), pending: [], layout: [] }; }
function render(change: Partial<Props> = {}, flushPassive = true): ReactNode {
  props = { ...props, ...change }; let tree: ReactNode; let rounds = 0;
  do { if (++rounds > 20) throw new Error("Synthetic component did not settle"); hooks.cursor = 0; hooks.changed = false; runtime.current = hooks;
    tree = LabReconciliationModal(props); runtime.current = null; hooks.layout.splice(0).forEach((effect) => effect());
    if (flushPassive) hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const node = tree as Element; return [node, ...nodes(node.props.children as ReactNode)];
}
function text(tree: ReactNode): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  return tree && typeof tree === "object" && "props" in tree ? text((tree as Element).props.children as ReactNode) : "";
}
function control(predicate: (node: Element) => boolean) { const result = nodes(render()).find(predicate); if (!result) throw new Error("Missing actual modal control"); return result; }
const button = (label: string) => control((node) => node.type === "button" && text(node) === label);
const click = (label: string) => (button(label).props.onClick as () => void)();
const selector = () => control((node) => node.type === "select");
const choose = (id: number | "") => (selector().props.onChange as (event: { target: { value: string } }) => void)({ target: { value: String(id) } });
const checks = () => nodes(render()).filter((node) => node.props.type === "checkbox");
const links = () => nodes(render()).filter((node) => node.type === "a");
const response = (payload: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: vi.fn(async () => payload) });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const lab = (id: number) => ({ partyId: id, partyName: `Synthetic lab ${id}`, currency: "YER", unsettledCostMinor: 987654321, unsettledOrdersCount: 8000 });
const order = (extra: Record<string, unknown> = {}) => ({ orderId: 301, patientName: "Synthetic patient", workType: "Synthetic crown", teeth: "11,12",
  dueDate: "2026-10-10", status: "sent", financialStatus: "pending_delivery", systemCostMinor: 10000, currency: "USD", ...extra });
const snapshot = (id = 401, orders = [order()]) => ({ party: { id, name: `Resolved lab ${id}`, currency: "YER" }, orders, unsettledCount: orders.length });
const fetchMock = vi.fn(); const onSuccess = vi.fn(); const onClose = vi.fn();
let getCatalog: () => unknown; let getDetail: (id: number) => unknown;
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
async function settle() { for (let i = 0; i < 45; i++) await Promise.resolve(); }
async function ready() { render(); await settle(); render(); await settle(); render(); }
async function switchParty(id: number) { choose(id); await ready(); }
function linkEvent(link: Element, key = "onClick") { const event = { preventDefault: vi.fn() }; (link.props[key] as (event: { preventDefault: () => void }) => void)(event); return event; }
beforeEach(() => {
  resetOwner(); runtime.session = { username: "synthetic-admin", role: "admin" };
  props = { initialPartyId: 401, onClose, onSuccess }; fetchMock.mockReset(); onSuccess.mockReset(); onClose.mockReset();
  getCatalog = () => response({ labs: [lab(401), lab(402)] }); getDetail = (id) => response(snapshot(id));
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") throw new Error("Forbidden modal write");
    if (url === "/api/finance/lab-reconciliation") return Promise.resolve(getCatalog());
    const match = /^\/api\/finance\/lab-reconciliation\?partyId=(\d+)$/.exec(url);
    if (match) return Promise.resolve(getDetail(Number(match[1])));
    throw new Error(`Unexpected modal fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => { unmount(); await settle(); expect(writes()).toHaveLength(0); expect(onSuccess).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("actual lab reconciliation modal payment containment", () => {
  it("selects no orders or party by default; names never consume overview debt/count scalars", async () => {
    props.initialPartyId = null; await ready(); expect(selector().props.value).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(links()).toHaveLength(0);
    expect(text(render())).not.toContain("987654321"); expect(text(render())).not.toContain("8000");
    await switchParty(401); expect(checks().every((node) => node.props.checked === false)).toBe(true);
  });
  it("preserves explicit clinical comparison, while all mixed/partial/claim amounts are unavailable", async () => {
    getDetail = (id) => response(snapshot(id, [order({ systemCostMinor: 10000, currency: "USD", claimedCostMinor: 999999 }),
      order({ orderId: 302, workType: "Synthetic bridge", systemCostMinor: 20000, currency: "YER", financialStatus: "paid", remainingMinor: 5000 })]));
    await ready(); expect(checks().map((node) => node.props.checked)).toEqual([false, false]);
    click("تحديد الأوامر المحمّلة"); expect(checks().map((node) => node.props.checked)).toEqual([true, true]);
    (checks()[0].props.onChange as () => void)(); expect(checks().map((node) => node.props.checked)).toEqual([false, true]);
    const content = text(render()); expect(content).toContain("Synthetic crown"); expect(content).toContain("Synthetic bridge");
    expect(content).toContain("11,12"); expect(content).toContain("paid"); expect(content).toContain("pending_delivery");
    expect(content).toContain("المحدد للمقارنة فقط: 1"); expect(content).toContain("التكلفة الأصلية للأمر لا تمثل الدين المتبقي");
    for (const value of ["10000", "20000", "999999", "5000", "30000", "YER", "USD"]) expect(content).not.toContain(value);
    expect(nodes(render()).filter((node) => node.type === "input" && node.props.type !== "checkbox")).toHaveLength(0);
    expect(nodes(render()).filter((node) => node.type === "form")).toHaveLength(0);
    expect(content).not.toContain("سبب الدفعة المقدمة"); expect(content).not.toContain("سداد وتسوية مجمعة");
  });
  it("links only the currently response-verified lab to individual payable review with no amount or order prefill", async () => {
    await ready(); expect(links()).toHaveLength(1); expect(links()[0].props.href).toBe("/finance/parties/401");
    expect(text(links()[0])).toContain("Resolved lab 401"); expect(text(render())).toContain("صف الفاتورة ومعاينة الدفع");
    expect(linkEvent(links()[0]).preventDefault).not.toHaveBeenCalled(); expect(linkEvent(links()[0], "onAuxClick").preventDefault).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([, init]) => init.cache === "no-store" && init.signal instanceof AbortSignal)).toBe(true);
  });
  it.each([null, 0, -1, 401.5, Number.MAX_SAFE_INTEGER + 1, 999])("does not derive statement navigation from an unverified initial ID %j", async (id) => {
    props.initialPartyId = id; await ready(); expect(links()).toHaveLength(0); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["doctor", "reception", "accountant", "cashier", "assistant", "logout", "empty-admin"])("keeps the independent admin ceiling for %s", async (role) => {
    runtime.session = role === "logout" ? null : { username: role === "empty-admin" ? "  " : "synthetic-user", role: role === "empty-admin" ? "admin" : role as SessionInfo["role"], permissions: { canViewCostPrices: true } as SessionInfo["permissions"] };
    await ready(); expect(fetchMock).not.toHaveBeenCalled(); expect(links()).toHaveLength(0); expect(checks()).toHaveLength(0);
  });
  it("labels the global loaded window and empty sample without no-orders/no-debt certainty or month filtering", async () => {
    getDetail = (id) => response(snapshot(id, [])); await ready();
    expect(text(render())).toContain("300 أمر على مستوى المركز"); expect(text(render())).toContain("ليست كامل سجل المختبر أو كشفاً شهرياً");
    expect(text(render())).toContain("قد توجد أوامر خارجها"); expect(text(render())).toContain("لا يثبت ملكية فاتورته");
    expect(button("تحديد الأوامر المحمّلة").props.disabled).toBe(true); expect(text(render())).not.toContain("لا توجد ديون");
  });
  it.each([401, 403, 409, 503])("keeps failed detail HTTP %s unavailable, with no rows or statement link", async (status) => {
    getDetail = () => response({ message: "Synthetic refusal", code: "exceeds_party_balance" }, status); await ready();
    expect(links()).toHaveLength(0); expect(checks()).toHaveLength(0); expect(text(render())).toContain("لا يمكن استنتاج عدم وجود أوامر أو ديون");
    click("إعادة تحميل أوامر المختبر"); await ready(); expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(text(render())).not.toContain("سبب الدفعة المقدمة");
  });
  it.each(["network", "json", "shape", "wrong-party", "missing-party", "duplicate-row", "invalid-row"])("fails closed on detail %s then recovers without auto-selection", async (kind) => {
    getDetail = () => kind === "network" ? Promise.reject(new Error("Synthetic failure")) : kind === "json"
      ? { ok: true, status: 200, json: async () => { throw new Error("Synthetic JSON"); } }
      : response(kind === "shape" ? {} : kind === "wrong-party" ? snapshot(402) : kind === "missing-party" ? { orders: [] }
        : snapshot(401, kind === "duplicate-row" ? [order(), order()] : [order({ dueDate: {} })]));
    await ready(); expect(links()).toHaveLength(0); expect(checks()).toHaveLength(0); expect(button("إعادة تحميل أوامر المختبر")).toBeDefined();
    getDetail = (id) => response(snapshot(id)); click("إعادة تحميل أوامر المختبر"); await ready();
    expect(links()[0].props.href).toBe("/finance/parties/401"); expect(checks()[0].props.checked).toBe(false);
  });
  it.each(["denied", "malformed", "duplicate", "network"])("keeps catalog %s distinct from an empty catalog", async (kind) => {
    getCatalog = () => kind === "network" ? Promise.reject(new Error("Synthetic network")) : response(kind === "malformed" ? { labs: null }
      : { labs: kind === "duplicate" ? [lab(401), lab(401)] : [] }, kind === "denied" ? 403 : 200);
    await ready(); expect(text(render())).toContain("هذا لا يعني عدم وجود مختبرات"); expect(links()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); getCatalog = () => response({ labs: [lab(401)] }); click("إعادة تحميل قائمة المختبرات"); await ready();
    expect(links()[0].props.href).toBe("/finance/parties/401");
  });
});

describe("actual modal read ownership and retained callbacks", () => {
  it("does not refetch stable catalog/party or retire the same-party selection", async () => {
    await ready(); const count = fetchMock.mock.calls.length; choose(401); render(); render(); await settle();
    expect(fetchMock).toHaveBeenCalledTimes(count); expect(links()).toHaveLength(1);
  });
  it("retires old selector callbacks after one accepted transition, including before the next commit", async () => {
    await ready(); const oldSelect = selector().props.onChange as (event: { target: { value: string } }) => void;
    oldSelect({ target: { value: "402" } }); oldSelect({ target: { value: "401" } }); await ready();
    expect(selector().props.value).toBe(402); expect(links()[0].props.href).toBe("/finance/parties/402");
    oldSelect({ target: { value: "401" } }); await ready(); expect(selector().props.value).toBe(402);
    await switchParty(401); expect(links()[0].props.href).toBe("/finance/parties/401"); expect(checks()[0].props.checked).toBe(false);
  });
  it("hides/retire A immediately on selection, ignores late A JSON, and does not revive A callbacks after A → B → A", async () => {
    await ready(); const oldLink = links()[0]; const oldAll = button("تحديد الأوامر المحمّلة").props.onClick as () => void;
    const oldRow = checks()[0].props.onChange as () => void; const oldBody = deferred<unknown>();
    // Start a new A request by leaving/re-entering; delay body, not merely headers.
    await switchParty(402); getDetail = (id) => id === 401 ? { ok: true, status: 200, json: () => oldBody.promise } : response(snapshot(id));
    choose(401); await ready(); choose(402);
    expect(linkEvent(oldLink).preventDefault).toHaveBeenCalledOnce(); oldAll(); oldRow();
    expect(text(render({}, false))).not.toContain("Resolved lab 401"); await ready();
    getDetail = (id) => response(snapshot(id, [order({ workType: "New incarnation" })])); await switchParty(401);
    oldBody.resolve(snapshot(401, [order({ workType: "Late obsolete A" })])); await settle(); oldAll(); oldRow();
    expect(text(render())).toContain("New incarnation"); expect(text(render())).not.toContain("Late obsolete A");
    expect(checks()[0].props.checked).toBe(false); expect(linkEvent(oldLink, "onAuxClick").preventDefault).toHaveBeenCalledOnce();
  });
  it.each(["username", "role", "permissions", "logout"])("revokes current data/link before passive effects on %s transition", async (kind) => {
    await ready(); const oldLink = links()[0]; const oldSelect = selector().props.onChange as (event: { target: { value: string } }) => void;
    const oldAll = button("تحديد الأوامر المحمّلة").props.onClick as () => void; const previous = runtime.session!;
    runtime.session = kind === "username" ? { ...previous, username: "new-admin" } : kind === "role" ? { ...previous, role: "doctor" }
      : kind === "permissions" ? { ...previous, permissions: { canViewCostPrices: true } as SessionInfo["permissions"] } : null;
    const hidden = render({}, false); expect(text(hidden)).not.toContain("Synthetic crown"); expect(nodes(hidden).some((node) => node.type === "a")).toBe(false);
    oldSelect({ target: { value: "402" } }); oldAll(); expect(linkEvent(oldLink).preventDefault).toHaveBeenCalledOnce();
    runtime.session = previous; await ready(); expect(selector().props.value).toBe(401); expect(checks()[0].props.checked).toBe(false);
    expect(linkEvent(oldLink).preventDefault).toHaveBeenCalledOnce();
  });
  it("rejects late old catalog headers after admin A → B → A and never parses them", async () => {
    const old = deferred<ReturnType<typeof response>>(); getCatalog = () => old.promise; render();
    const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    runtime.session = { username: "B", role: "admin" }; getCatalog = () => response({ labs: [lab(402)] }); await ready();
    runtime.session = { username: "synthetic-admin", role: "admin" }; getCatalog = () => response({ labs: [lab(401)] }); await ready();
    const stale = response({ labs: [{ ...lab(401), partyName: "Obsolete catalog" }] }); old.resolve(stale); await settle();
    expect(firstSignal.aborted).toBe(true); expect(stale.json).not.toHaveBeenCalled(); expect(text(render())).not.toContain("Obsolete catalog");
  });
  it("treats changed initialPartyId as a fresh comparison with zero selections", async () => {
    await ready(); click("تحديد الأوامر المحمّلة"); const previous = links()[0];
    expect(text(render({ initialPartyId: 402 }, false))).not.toContain("Resolved lab 401"); await ready();
    expect(links()[0].props.href).toBe("/finance/parties/402"); expect(checks()[0].props.checked).toBe(false);
    expect(linkEvent(previous).preventDefault).toHaveBeenCalledOnce();
  });
  it("immediate close retires links/rows before parent unmount; reopen obtains new data", async () => {
    await ready(); const old = links()[0]; const all = button("تحديد الأوامر المحمّلة").props.onClick as () => void;
    (control((node) => node.props["aria-label"] === "إغلاق مقارنة المختبر").props.onClick as () => void)();
    all(); expect(linkEvent(old).preventDefault).toHaveBeenCalledOnce(); expect(render()).toBeNull(); expect(onClose).toHaveBeenCalledOnce();
    unmount(); resetOwner(); await ready(); expect(checks()[0].props.checked).toBe(false); expect(linkEvent(old).preventDefault).toHaveBeenCalledOnce();
  });
  it("aborts a pending detail on unmount and never commits late updates", async () => {
    const pending = deferred<ReturnType<typeof response>>(); getDetail = () => pending.promise; await ready();
    const signal = fetchMock.mock.calls[1][1].signal as AbortSignal; unmount(); pending.resolve(response(snapshot())); await settle();
    expect(signal.aborted).toBe(true); expect(hooks.lateUpdates).toBe(0);
  });
});
