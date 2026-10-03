/** Source-authored synthetic lifecycle tests. Actual component/read hook/handlers;
 * mocked scheduling and transport, not DOM/browser, database, or HTTP acceptance. */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientLabOrders } from "../components/PatientLabOrders";
import { LabPrescriptionModal } from "../components/LabPrescriptionModal";
import { LabDeliveryAppointmentModal } from "../components/LabDeliveryAppointmentModal";
import { decodePatientLabSnapshot } from "../lib/patient-lab-read";
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
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic", useSetting: () => "" }));
vi.mock("../components/LabDentalChart", () => ({ LabDentalChart: () => null }));
vi.mock("../components/LabPrescriptionModal", () => ({ LabPrescriptionModal: () => null }));
vi.mock("../components/LabDeliveryAppointmentModal", () => ({ LabDeliveryAppointmentModal: () => null }));
vi.mock("../lib/schedule", () => ({ clinicDateString: () => "2026-10-03" }));

type Element = ReactElement<Record<string, unknown>>;
type Props = Parameters<typeof PatientLabOrders>[0];
let hooks: Hooks; let props: Props;
function unmount() { hooks.effects.forEach((effect) => { effect.cleanup?.(); effect.cleanup = undefined; }); hooks.mounted = false; }
function render(change: Partial<Props> = {}, flushPassive = true): ReactNode {
  props = { ...props, ...change }; let tree: ReactNode; let rounds = 0;
  do { if (++rounds > 15) throw new Error("Synthetic component did not settle"); hooks.cursor = 0; hooks.changed = false; runtime.current = hooks;
    tree = PatientLabOrders(props); runtime.current = null; hooks.layout.splice(0).forEach((effect) => effect());
    if (flushPassive) hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const node = tree as Element; return [node, ...nodes(node.props.children as ReactNode)];
}
function contents(tree: ReactNode): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(contents).join("");
  return tree && typeof tree === "object" && "props" in tree ? contents((tree as Element).props.children as ReactNode) : "";
}
const response = (payload: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fetchMock = vi.fn(); const confirmMock = vi.fn();
const order = (extra: Record<string, unknown> = {}) => ({ id: 301, patientId: 101, patientName: "Synthetic A", patientNumber: null, patientPhone: null,
  labName: "Synthetic lab", labPhone: null, workType: "Synthetic crown", sentDate: "2026-10-03", dueDate: "2026-10-10", status: "sent",
  details: null, toothNumbers: null, shade: null, note: null, priority: "normal", baseAmountMinor: null, costMinor: null, ...extra });
const snapshot = (orders = [order()]) => ({ orders, labs: [{ labName: "Synthetic lab", labPhone: null }] });
let getOrders: () => unknown; let getCatalog: () => unknown; let mutate: () => unknown;
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method);
const reads = () => fetchMock.mock.calls.filter(([, init]) => !init?.method);
function control(predicate: (node: Element) => boolean) { const found = nodes(render()).find(predicate); if (!found) throw new Error("Missing real component control"); return found; }
function button(label: string) { return control((node) => node.type === "button" && contents(node) === label); }
function click(label: string) { return (button(label).props.onClick as () => unknown)(); }
function field(placeholder: string) { return control((node) => node.props.placeholder === placeholder); }
function change(placeholder: string, value: string) { (field(placeholder).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); }
function submitHandler() { return control((node) => node.type === "form").props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>; }
const event = { preventDefault() {} };
const modal = (type: unknown) => nodes(render()).find((node) => node.type === type);
const noEmpty = () => expect(contents(render())).not.toContain("لا توجد طلبات لهذا المريض");
async function settle() { for (let index = 0; index < 40; index++) await Promise.resolve(); }
async function ready() { render(); await settle(); render(); }
function draft() { click("+ طلب معمل جديد"); change("مثال: مختبر السعادة للأسنان", "Synthetic lab"); change("تعليمات إضافية للفني...", "Synthetic unsaved note"); }
const retry = () => click("إعادة محاولة تحميل طلبات المعمل");
const refresh = () => click("تحديث طلبات المعمل");
beforeEach(() => {
  hooks = { values: [], cursor: 0, changed: false, mounted: true, lateUpdates: 0, effects: new Map(), memos: new Map(), pending: [], layout: [] };
  props = { patientId: 101, patientName: "Synthetic A", base: "YER" };
  runtime.session = { username: "synthetic-admin", role: "admin" };
  fetchMock.mockReset(); confirmMock.mockReset(); confirmMock.mockReturnValue(true);
  getOrders = () => response(snapshot()); getCatalog = () => response({ laboratories: [{ id: 401, name: "Synthetic lab", isActive: true }] });
  mutate = () => response(order(), 200);
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method) return Promise.resolve(mutate());
    if (url === "/api/laboratories") return Promise.resolve(getCatalog());
    if (url.startsWith("/api/lab?patientId=")) return Promise.resolve(getOrders());
    throw new Error(`Unexpected broad/unscoped read: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", { confirm: confirmMock });
});
afterEach(async () => { unmount(); await settle(); vi.unstubAllGlobals(); });

describe("canonical patient lab read decoding", () => {
  it("accepts canonical empty and populated envelopes without changing values", () => {
    const payload = snapshot(); expect(decodePatientLabSnapshot(payload, 101)).toBe(payload);
    expect(decodePatientLabSnapshot({ orders: [], labs: [] }, 101)).toEqual({ orders: [], labs: [] });
  });
  it.each([null, [], {}, { orders: [], labs: null }, snapshot([order({ patientId: 102 })]), snapshot([order(), order()]),
    snapshot([order({ id: -1 })]), snapshot([order({ status: "unknown" })]), snapshot([order({ toothNumbers: {} })])])("rejects incomplete/unscoped data %j", (payload) => {
    expect(decodePatientLabSnapshot(payload, 101)).toBeNull();
  });
});

describe("actual patient lab read lifecycle", () => {
  it("does not show empty/count/create actions before verification; valid empty is explicitly bounded", async () => {
    const pending = deferred<ReturnType<typeof response>>(); getOrders = () => pending.promise;
    render(); noEmpty(); expect(contents(render())).not.toContain("المعمل (0)"); expect(button("+ طلب معمل جديد").props.disabled).toBe(true);
    pending.resolve(response({ orders: [], labs: [] })); await settle();
    expect(contents(render())).toContain("لا توجد طلبات لهذا المريض ضمن قائمة المعمل المتاحة"); expect(button("+ طلب معمل جديد").props.disabled).toBe(false);
  });
  it.each([401, 403, 404, 500])("keeps HTTP %s visible with retry and never requests the broad lab list", async (status) => {
    getOrders = () => response({ message: "Synthetic denial" }, status); await ready();
    expect(nodes(render()).some((node) => node.props.role === "alert")).toBe(true); noEmpty();
    expect(button("+ طلب معمل جديد").props.disabled).toBe(true); retry(); await settle();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/lab?patientId=101")).toHaveLength(2);
    expect(reads().some(([url]) => url === "/api/lab")).toBe(false); expect(writes()).toHaveLength(0);
  });
  it.each(["network", "json", "shape", "wrong-patient"])("fails closed on %s without empty-success or stale actions", async (kind) => {
    await ready(); const retained = button("✓ استلام من المختبر").props.onClick as () => void;
    getOrders = () => kind === "network" ? Promise.reject(new Error("Synthetic network failure"))
      : kind === "json" ? { ok: true, status: 200, json: async () => { throw new Error("Synthetic invalid JSON"); } }
      : response(kind === "shape" ? [] : snapshot([order({ patientId: 102 })]));
    refresh(); retained(); await settle(); noEmpty();
    expect(contents(render())).not.toContain("Synthetic crown"); expect(modal(LabDeliveryAppointmentModal)).toBeUndefined();
    expect(writes()).toHaveLength(0); expect(button("إعادة محاولة تحميل طلبات المعمل")).toBeDefined();
  });
  it("retires retained row/print/cancel callbacks immediately on refresh and after recovery", async () => {
    await ready(); const receive = button("✓ استلام من المختبر").props.onClick as () => void;
    const print = button("📋 استمارة المختبر").props.onClick as () => void;
    const cancel = button("✕ إلغاء الإرسالية").props.onClick as () => void;
    print(); expect(modal(LabPrescriptionModal)).toBeDefined();
    const pending = deferred<ReturnType<typeof response>>(); getOrders = () => pending.promise;
    refresh(); receive(); print(); cancel();
    expect(modal(LabPrescriptionModal)).toBeUndefined(); expect(confirmMock).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
    pending.resolve(response(snapshot())); await settle(); receive(); print(); cancel();
    expect(writes()).toHaveLength(0); expect(modal(LabPrescriptionModal)).toBeUndefined();
    click("📋 استمارة المختبر"); expect(modal(LabPrescriptionModal)).toBeDefined();
  });
  it.each(["success", "failure"])("ignores an older %s after a newer read settles", async (outcome) => {
    const old = deferred<ReturnType<typeof response>>(); getOrders = () => old.promise; render();
    getOrders = () => response(snapshot([order({ workType: "New verified work" })])); refresh(); await settle();
    old.resolve(outcome === "success" ? response(snapshot()) : response({}, 500)); await settle();
    expect(contents(render())).toContain("New verified work"); expect(contents(render())).not.toContain("Synthetic crown");
    expect(nodes(render()).some((node) => node.props.role === "alert")).toBe(false);
  });
  it("retires A → B → A reads and retained callbacks, including before passive effects", async () => {
    await ready(); const oldHandler = button("✓ استلام من المختبر").props.onClick as () => void;
    const old = deferred<ReturnType<typeof response>>(); getOrders = () => old.promise; refresh(); render();
    const hidden = render({ patientId: 102, patientName: "Synthetic B" }, false); expect(contents(hidden)).not.toContain("Synthetic crown"); oldHandler();
    getOrders = () => response(snapshot([order({ patientId: 102, workType: "B verified" })])); render(); await settle();
    getOrders = () => response(snapshot([order({ workType: "A new incarnation" })])); render({ patientId: 101 }); await settle();
    old.resolve(response(snapshot())); await settle(); oldHandler();
    expect(contents(render())).toContain("A new incarnation"); expect(contents(render())).not.toContain("B verified"); expect(writes()).toHaveLength(0);
  });
  it.each(["username", "role", "permissions", "logout"])("revokes visible reads and retained actions for %s changes", async (kind) => {
    await ready(); const oldHandler = button("✓ استلام من المختبر").props.onClick as () => void;
    const previous = runtime.session!;
    runtime.session = kind === "logout" ? null : kind === "username" ? { ...previous, username: "another-user" }
      : kind === "role" ? { ...previous, role: "doctor" } : { ...previous, permissions: { canViewCostPrices: false } as SessionInfo["permissions"] };
    const tree = render({}, false); expect(contents(tree)).not.toContain("Synthetic crown"); oldHandler(); expect(writes()).toHaveLength(0);
    getOrders = () => response({}, 403); render(); await settle(); noEmpty(); expect(modal(LabPrescriptionModal)).toBeUndefined();
  });
  it("keeps the unsaved form through failed read and retry; retained submission cannot bypass verification", async () => {
    await ready(); draft(); const submit = submitHandler();
    getOrders = () => response({}, 500); refresh(); await settle();
    expect(field("تعليمات إضافية للفني...").props.value).toBe("Synthetic unsaved note");
    expect(control((node) => node.type === "fieldset").props.disabled).toBe(true);
    await submit(event); await submitHandler()(event); expect(writes()).toHaveLength(0);
    getOrders = () => response(snapshot()); retry(); await settle();
    expect(field("تعليمات إضافية للفني...").props.value).toBe("Synthetic unsaved note");
    await submit(event); expect(writes()).toHaveLength(0);
    change("المبلغ المحتسب من المعمل", "123"); await submitHandler()(event); await settle();
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe("/api/lab");
    expect(JSON.parse(writes()[0][1].body)).toMatchObject({ patientId: 101, labName: "Synthetic lab", cost: "123", costCurrency: "YER", partyId: 401, note: "Synthetic unsaved note" });
    expect(JSON.parse(writes()[0][1].body)).not.toHaveProperty("visitId");
  });
  it.each([401, 403, 404])("hides but retains a draft after denial %s, through unsuccessful retries", async (status) => {
    await ready(); draft(); const retained = submitHandler();
    getOrders = () => response({}, status); refresh(); await settle();
    expect(nodes(render()).some((node) => node.type === "form")).toBe(false);
    expect(contents(render())).toContain("المسودة المحلية محفوظة ومخفية");
    expect(contents(render())).not.toContain("Synthetic unsaved note"); await retained(event); expect(writes()).toHaveLength(0);
    const pending = deferred<ReturnType<typeof response>>(); getOrders = () => pending.promise; retry();
    expect(nodes(render()).some((node) => node.type === "form")).toBe(false);
    pending.resolve(response({}, 500)); await settle();
    expect(nodes(render()).some((node) => node.type === "form")).toBe(false);
    getOrders = () => response(snapshot()); retry(); await settle();
    expect(field("تعليمات إضافية للفني...").props.value).toBe("Synthetic unsaved note");
    await retained(event); expect(writes()).toHaveLength(0);
  });
  it("hides an incompatible draft without transferring or clearing it", async () => {
    await ready(); draft(); const submit = submitHandler();
    getOrders = () => response(snapshot([order({ patientId: 102 })])); render({ patientId: 102 }); await settle();
    expect(nodes(render()).some((node) => node.type === "form")).toBe(false); expect(contents(render())).toContain("المسودة المحلية تخص مريضًا أو جلسة أخرى");
    await submit(event); expect(writes()).toHaveLength(0);
    getOrders = () => response(snapshot());
    expect(nodes(render({ patientId: 101 })).some((node) => node.type === "form")).toBe(false);
    await settle();
    expect(field("تعليمات إضافية للفني...").props.value).toBe("Synthetic unsaved note"); await submit(event); expect(writes()).toHaveLength(0);
  });
  it("does not let a late previous-authority catalogue establish a cost party", async () => {
    const catalog = deferred<ReturnType<typeof response>>(); getCatalog = () => catalog.promise; await ready();
    runtime.session = { username: "synthetic-new-user", role: "admin" }; getCatalog = () => response({}, 403); render(); await settle();
    catalog.resolve(response({ laboratories: [{ id: 999, name: "Synthetic lab" }] })); await settle();
    draft(); change("المبلغ المحتسب من المعمل", "123"); await submitHandler()(event);
    expect(writes()).toHaveLength(0); expect(contents(render())).toContain("تسجيل التكلفة يتطلب اختيار مختبر مسجّل");
    expect(field("المبلغ المحتسب من المعمل").props.value).toBe("123");
  });
  it.each(["failed", "delivered", "received"])("opens delivery only for a verified refreshed received record (%s)", async (result) => {
    await ready();
    getOrders = () => result === "failed" ? response({}, 500) : response(snapshot([order({ status: result, note: "Fresh server note" })]));
    const handler = button("✓ استلام من المختبر").props.onClick as () => void; handler(); handler(); await settle();
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe("/api/lab/301"); expect(JSON.parse(writes()[0][1].body)).toEqual({ status: "received" });
    if (result === "received") expect(modal(LabDeliveryAppointmentModal)?.props.order).toMatchObject({ status: "received", note: "Fresh server note" });
    else expect(modal(LabDeliveryAppointmentModal)).toBeUndefined();
  });
  it("does not refresh or open delivery after a status response outlives its authority", async () => {
    await ready(); const pending = deferred<ReturnType<typeof response>>(); mutate = () => pending.promise;
    click("✓ استلام من المختبر"); runtime.session = { username: "replacement", role: "admin" }; getOrders = () => response({ orders: [], labs: [] }); render(); await settle();
    const count = fetchMock.mock.calls.length; pending.resolve(response(order({ status: "received" }))); await settle();
    expect(fetchMock.mock.calls).toHaveLength(count); expect(modal(LabDeliveryAppointmentModal)).toBeUndefined();
  });
  it("preserves cancellation confirmation and does not send on Cancel", async () => {
    await ready(); confirmMock.mockReturnValue(false); click("✕ إلغاء الإرسالية"); await settle();
    expect(confirmMock).toHaveBeenCalledOnce(); expect(writes()).toHaveLength(0);
  });
  it("ignores late read/catalogue settlements and handlers after unmount", async () => {
    const pending = deferred<ReturnType<typeof response>>(); getOrders = () => pending.promise; getCatalog = () => pending.promise;
    render(); const refreshHandler = button("تحديث طلبات المعمل").props.onClick as () => void; unmount(); refreshHandler();
    pending.resolve(response(snapshot())); await settle(); expect(hooks.lateUpdates).toBe(0); expect(writes()).toHaveLength(0);
  });
});
