import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeriodonticsWorkspace } from "../components/periodontics/PeriodonticsWorkspace";
import { createPatientNavigation } from "../lib/patient-navigation";
import { examFixture } from "./periodontics-workspace-fixtures";

// Actual keyed component, controller, API validation and navigation guard run here.
// Only React scheduling and fetch transport are synthetic; this is not DOM/browser proof.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(), pending: [] as Array<() => void> }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined); const previous = hooks.memos.get(index); if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useId: () => hooks.values[slot("perio-acceptance")],
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => { slot(undefined); return getSnapshot(); },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined); const previous = hooks.effects.get(index); if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
    },
  };
});
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(node, (child) => { if (isValidElement<Record<string, unknown>>(child)) { found.push(child); found.push(...elements(child.props.children as ReactNode)); } });
  return found;
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  const parts: string[] = [];
  Children.forEach(node, (child) => { if (typeof child === "string" || typeof child === "number") parts.push(String(child)); else if (isValidElement<{ children?: ReactNode }>(child)) parts.push(text(child.props.children)); });
  return parts.join(" ");
}
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const initialExam = () => examFixture({ caseTitle: "Stored periodontal context" });
let props: ComponentProps<typeof PeriodonticsWorkspace>; let mountedKey: string | null; let active: boolean;
let guard: (() => boolean) | null; let url: URL; let navigation: ReturnType<typeof createPatientNavigation>;
let listResponse: ReturnType<typeof response> | Promise<ReturnType<typeof response>>;
let writeResponse: ReturnType<typeof response> | Promise<ReturnType<typeof response>>;
const fetchMock = vi.fn(); const confirm = vi.fn(); const alert = vi.fn(); const replaceState = vi.fn(); const pushState = vi.fn();
const onDraft = vi.fn(); const onBusy = vi.fn(); const onPersisted = vi.fn();
const listeners = new Map<string, (event: BeforeUnloadEvent) => void>();
function resetHooks() { hooks.values = []; hooks.cursor = 0; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = []; }
function unmount() { hooks.effects.forEach((effect) => effect.cleanup?.()); resetHooks(); mountedKey = null; active = false; }
function render() {
  if (!active) return { nodes: [] as Element[], text: "" };
  const wrapper = PeriodonticsWorkspace(props);
  if (mountedKey !== wrapper.key) { if (mountedKey !== null) unmount(); resetHooks(); active = true; mountedKey = wrapper.key; }
  hooks.cursor = 0;
  const tree = (wrapper.type as (input: ComponentProps<typeof PeriodonticsWorkspace>) => ReactNode)(wrapper.props);
  hooks.pending.splice(0).forEach((effect) => effect());
  return { nodes: elements(tree), text: text(tree) };
}
async function settle() { for (let index = 0; index < 40; index += 1) await Promise.resolve(); }
async function loaded() { render(); await settle(); return render(); }
const control = (label: string) => render().nodes.find((node) => node.props["aria-label"] === label);
function change(label: string, value: string) { const node = control(label); expect(node, label).toBeDefined(); (node!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); render(); }
function button(label: string) { const node = render().nodes.find((one) => one.type === "button" && text(one).includes(label)); expect(node, label).toBeDefined(); return node!; }
const click = (node: Element) => (node.props.onClick as () => void)();
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
const depthLabel = "عمق الجيب السن 11 MB";
beforeEach(() => {
  resetHooks(); mountedKey = null; active = true; guard = null; listeners.clear();
  confirm.mockReset().mockReturnValue(false); alert.mockReset(); replaceState.mockReset(); pushState.mockReset(); onDraft.mockReset(); onBusy.mockReset(); onPersisted.mockReset();
  props = { patientId: 1, patientName: "Synthetic patient", authorityKey: "doctor-a", editable: true, contextStatus: "ready",
    currentVisit: { id: 11, patientId: 1, date: "2026-10-03", signedAt: null, caseId: null }, doctors: [{ id: 7, name: "Actual doctor" }], cases: [], visibleToothCodes: [11],
    onDraftChange: onDraft, onBusyChange: onBusy, onPersisted, onNavigationGuardChange: (next) => { guard = next; } };
  listResponse = response({ exams: [initialExam()] }); writeResponse = response({ message: "Synthetic write refused" }, 400);
  fetchMock.mockReset().mockImplementation(async (_target: string, init?: RequestInit) => init?.method === "PUT" || init?.method === "POST" ? writeResponse : listResponse);
  url = new URL("https://synthetic.invalid/patients/1?tab=treatment&sub=perio&keep=unchanged");
  replaceState.mockImplementation((_state, _title, href: string) => { url = new URL(href, url); });
  const host = { get location() { return url; }, history: { replaceState, pushState, length: 4 } } as unknown as Window;
  navigation = createPatientNavigation(host, { canLeave: () => guard?.() ?? true, onChange: (location) => { if (location.tab !== "treatment" || location.sub !== "perio") unmount(); } });
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", { confirm, alert,
    addEventListener: (name: string, handler: (event: BeforeUnloadEvent) => void) => listeners.set(name, handler),
    removeEventListener: (name: string, handler: (event: BeforeUnloadEvent) => void) => { if (listeners.get(name) === handler) listeners.delete(name); } });
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe("patient rebuild acceptance: actual periodontal workspace lifecycle", () => {
  it("opens exact persisted zero and false values without a write or invented provider", async () => {
    await loaded(); expect(control(depthLabel)?.props.value, render().text).toBe("0"); expect(control("النزف السن 11 MB")?.props.value).toBe("no");
    expect(control("الطبيب المعالج الفعلي")?.props.value).toBe(7); expect(writes()).toHaveLength(0); expect(onPersisted).not.toHaveBeenCalled();
  });
  it("repeated dirty cancellation preserves actual depth, URL and unload warning", async () => {
    await loaded(); change(depthLabel, "4.25"); const original = url.href;
    expect(navigation.navigate({ tab: "identity", sub: "perio" })).toBe(false); expect(navigation.navigate({ tab: "identity", sub: "perio" })).toBe(false);
    expect(url.href).toBe(original); expect(control(depthLabel)?.props.value).toBe("4.25"); expect(confirm).toHaveBeenCalledTimes(2); expect(replaceState).not.toHaveBeenCalled();
    const event = { preventDefault: vi.fn(), returnValue: undefined } as unknown as BeforeUnloadEvent;
    listeners.get("beforeunload")!(event); expect(event.preventDefault).toHaveBeenCalled(); expect(event.returnValue).toBe(""); expect(writes()).toHaveLength(0);
  });
  it("accepted leave unmounts and cleans up the registered guard, then reopening uses saved data", async () => {
    await loaded(); change(depthLabel, "4.25"); confirm.mockReturnValue(true);
    expect(navigation.navigate({ tab: "identity", sub: "perio" })).toBe(true); expect(guard).toBeNull(); expect(onDraft).toHaveBeenLastCalledWith(false); expect(onBusy).toHaveBeenLastCalledWith(false);
    expect(listeners.has("beforeunload")).toBe(false); expect(replaceState).toHaveBeenCalledTimes(1); expect(pushState).not.toHaveBeenCalled();
    active = true; await loaded(); expect(control(depthLabel)?.props.value, render().text).toBe("0"); expect(writes()).toHaveLength(0);
  });
  it("pending real PUT blocks repeated submit and navigation and only confirmed save publishes", async () => {
    await loaded(); change(depthLabel, "4.25"); const pending = deferred<ReturnType<typeof response>>(); writeResponse = pending.promise;
    const save = button("حفظ"); click(save); click(save);
    expect(writes()).toHaveLength(1); expect(onPersisted).not.toHaveBeenCalled();
    expect(navigation.navigate({ tab: "identity", sub: "perio" })).toBe(false); expect(navigation.navigate({ tab: "identity", sub: "perio" })).toBe(false);
    expect(alert).toHaveBeenCalledTimes(2); expect(confirm).not.toHaveBeenCalled(); expect(replaceState).not.toHaveBeenCalled();
    const body = JSON.parse(writes()[0][1].body as string) as { sites: ReturnType<typeof initialExam>["sites"] };
    expect(writes()[0][0]).toBe("/api/patients/1/perio/visits/11"); expect(body.sites).toContainEqual(initialExam().sites[1]);
    pending.resolve(response({ exam: examFixture({ revision: 4, sites: body.sites }) })); await settle(); render();
    expect(onPersisted).toHaveBeenCalledTimes(1); expect(control(depthLabel)?.props.value).toBe("4.25"); expect(onDraft).toHaveBeenLastCalledWith(false);
  });
  it("a changed visit preserves the original pending draft and blocks save until explicit context adoption", async () => {
    await loaded(); change(depthLabel, "4.25"); props.currentVisit = { ...props.currentVisit!, id: 12 }; render();
    expect(render().text).toContain("تغيّر سياق الزيارة"); expect(render().text).toContain("4.25"); expect(control(depthLabel)).toBeUndefined();
    click(button("حفظ")); expect(writes()).toHaveLength(0);
    click(button("ترك المسودة وفتح السياق الحالي")); expect(confirm).toHaveBeenCalledTimes(1); expect(render().text).toContain("تغيّر سياق الزيارة");
  });
  it.each([401, 403, 404])("own GET %s removes cached clinical content and stale handlers cannot write", async (status) => {
    await loaded(); change(depthLabel, "4.25"); const staleSave = button("حفظ");
    listResponse = response({ message: "Synthetic access revoked" }, status); click(button("تحديث السجل")); await settle();
    expect(render().text).not.toContain("Stored periodontal context"); expect(render().text).not.toContain("Actual doctor"); expect(render().text).not.toContain("4.25");
    expect(control(depthLabel)).toBeUndefined(); click(staleSave); expect(writes()).toHaveLength(0); expect(onPersisted).not.toHaveBeenCalled();
  });
  it("transient GET failure keeps the draft visible but read-only until a successful retry", async () => {
    await loaded(); change(depthLabel, "4.25"); const staleSave = button("حفظ");
    listResponse = response({ message: "Synthetic temporary read failure" }, 503); click(button("تحديث السجل")); await settle();
    expect(render().text).toContain("4.25"); expect(control(depthLabel)).toBeUndefined(); click(staleSave); expect(writes()).toHaveLength(0);
    listResponse = response({ exams: [initialExam()] }); click(button("تحديث السجل")); await settle();
    expect(control(depthLabel)?.props.value).toBe("4.25"); expect(writes()).toHaveLength(0);
  });
  it("authority remount aborts old requests and late completion cannot publish or restore clinical state", async () => {
    await loaded(); change(depthLabel, "4.25"); const pending = deferred<ReturnType<typeof response>>(); writeResponse = pending.promise; click(button("حفظ"));
    const oldSignal = writes()[0][1].signal as AbortSignal; props.authorityKey = "doctor-b"; listResponse = response({ exams: [] }); await loaded();
    expect(oldSignal.aborted).toBe(true); expect(control(depthLabel)?.props.value).toBe("");
    pending.resolve(response({ exam: examFixture({ revision: 4 }) })); await settle(); render();
    expect(onPersisted).not.toHaveBeenCalled(); expect(control(depthLabel)?.props.value).toBe(""); expect(render().text).not.toContain("Stored periodontal context");
  });
});
