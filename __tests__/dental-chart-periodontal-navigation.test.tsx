import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DentalChart } from "../components/DentalChart";
import { CONDITION_LABEL, STAGE_LABEL } from "../lib/dental";

// Actual chart and tooth-panel handlers with isolated hook storage per component.
// This exercises source handlers, not React DOM reconciliation or browser history.
const hooks = vi.hoisted(() => ({ active: "chart", scopes: new Map<string, {
  values: unknown[]; cursor: number;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>;
  pending: Array<() => void>;
}>() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const scope = () => hooks.scopes.get(hooks.active)!;
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const state = scope(); const index = state.cursor++; const previous = state.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); state.memos.set(index, { deps, value }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const state = scope(); const index = state.cursor++;
      if (!(index in state.values)) state.values[index] = typeof initial === "function" ? initial() : initial;
      return [state.values[index], (value: unknown) => { state.values[index] = typeof value === "function" ? value(state.values[index]) : value; }];
    },
    useRef: (initial: unknown) => { const state = scope(); const index = state.cursor++; if (!(index in state.values)) state.values[index] = { current: initial }; return state.values[index]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const state = scope(); const index = state.cursor++; const previous = state.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      state.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); state.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
    },
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ role: "doctor", username: "synthetic" }) }));
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  return node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
}
function unmount(key: string) { hooks.scopes.get(key)?.effects.forEach((effect) => effect.cleanup?.()); hooks.scopes.delete(key); }
function renderScope(key: string, run: () => ReactNode) {
  if (!hooks.scopes.has(key)) hooks.scopes.set(key, { values: [], cursor: 0, effects: new Map(), memos: new Map(), pending: [] });
  const scope = hooks.scopes.get(key)!; hooks.active = key; scope.cursor = 0;
  const tree = run(); scope.pending.splice(0).forEach((effect) => effect()); return tree;
}
function component(node: ReactNode, name: string) { return elements(node).find((element) => typeof element.type === "function" && element.type.name === name); }
function button(node: ReactNode, label: string) {
  const found = elements(node).filter((element) => element.type === "button" && text(element).trim() === label);
  expect(found, label).toHaveLength(1); return found[0];
}
const click = (node: Element) => (node.props.onClick as () => void)();
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const fetchMock = vi.fn(); const onOpen = vi.fn();
let props: ComponentProps<typeof DentalChart>;
function render() {
  const chart = renderScope("chart", () => DentalChart(props));
  const panel = component(chart, "ToothPanel");
  const tooth = panel ? renderScope("tooth", () => (panel.type as (input: Record<string, unknown>) => ReactNode)(panel.props)) : null;
  if (!panel) unmount("tooth");
  return { chart, panel, tooth };
}
async function settle() { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }
async function loaded() { render(); await settle(); return render(); }
function selectTooth(code: number) { (component(render().chart, "Row")!.props.onPick as (value: number) => void)(code); return render(); }
function setNote(value: string) {
  const input = elements(render().tooth).find((node) => node.props["aria-label"] === "ملاحظة")!;
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
const note = () => elements(render().tooth).find((node) => node.props["aria-label"] === "ملاحظة")?.props.value;
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method && !["GET", "HEAD", "OPTIONS"].includes(init.method));
const topLabel = "افتح مساحة اللثة (Periodontics)";
const toothLabel = "افتح مساحة اللثة الكاملة";
beforeEach(() => {
  hooks.scopes.clear(); hooks.active = "chart"; onOpen.mockReset();
  props = { patientId: 91, onOpenPeriodontics: onOpen };
  fetchMock.mockReset().mockImplementation(async (_target: string, init?: RequestInit) => init?.method === "POST" ? response({ message: "Synthetic save refused" }, 400) : response({ records: [] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { [...hooks.scopes.keys()].forEach(unmount); vi.unstubAllGlobals(); });

describe("chart links to the full periodontal workspace", () => {
  it.each(["header", "tooth"])("calls the supplied callback once from %s with no write, tooth focus claim or legacy mode switch", async (entry) => {
    await loaded(); selectTooth(11); setNote("Unsaved chart note");
    click(button(render().tooth, CONDITION_LABEL.filling));
    const before = render(); const toothScope = hooks.scopes.get("tooth");
    click(entry === "header" ? button(before.chart, topLabel) : button(before.tooth, toothLabel));
    const after = render();
    expect(onOpen).toHaveBeenCalledTimes(1); expect(onOpen).toHaveBeenCalledWith();
    expect(component(after.chart, "PerioChartView")).toBeUndefined();
    expect(after.panel?.props.toothCode).toBe(11); expect(after.panel?.type).toBe(before.panel?.type); expect(after.panel?.key).toBe(before.panel?.key);
    expect(hooks.scopes.get("tooth")).toBe(toothScope); expect(note()).toBe("Unsaved chart note");
    expect(button(after.tooth, CONDITION_LABEL.filling).props.className).toContain("bg-navy-900");
    expect(text(after.tooth)).not.toContain("Perio Probe");
    expect(fetchMock.mock.calls.map(([target]) => target)).toEqual(["/api/patients/91/chart"]); expect(writes()).toHaveLength(0);
  });

  it("preserves tooth input when the parent refuses navigation and when the retained chart is shown again", async () => {
    await loaded(); selectTooth(11); setNote("Keep through refused and accepted navigation");
    let allowed = false; let active = "chart";
    onOpen.mockImplementation(() => { if (allowed) active = "perio"; });
    const originalScope = hooks.scopes.get("tooth");
    click(button(render().tooth, toothLabel)); expect(active).toBe("chart");
    expect(note()).toBe("Keep through refused and accepted navigation");
    allowed = true; click(button(render().chart, topLabel)); expect(active).toBe("perio");
    // The shell's hidden-section retention is separately exercised in its handler test.
    render(); active = "chart"; const reopened = render();
    expect(reopened.panel?.props.toothCode).toBe(11); expect(hooks.scopes.get("tooth")).toBe(originalScope);
    expect(note()).toBe("Keep through refused and accepted navigation"); expect(writes()).toHaveLength(0);
  });

  it.each(["request", "json"])("blocks both actions, including captured handlers, while save %s is pending", async (phase) => {
    await loaded(); selectTooth(11); const before = render();
    const staleTop = button(before.chart, topLabel); const staleTooth = button(before.tooth, toothLabel);
    const pending = deferred<ReturnType<typeof response>>(); const pendingJson = deferred<{ message: string }>();
    fetchMock.mockImplementation(async (_target: string, init?: RequestInit) => init?.method === "POST"
      ? phase === "request" ? pending.promise : { ok: false, status: 400, json: () => pendingJson.promise }
      : response({ records: [] }));
    const saving = (before.panel!.props.onSave as (body: Record<string, unknown>) => Promise<void>)({ toothCode: 11, condition: "caries", stage: "existing" });
    click(staleTop); click(staleTooth); expect(onOpen).not.toHaveBeenCalled();
    await settle(); const savingTree = render();
    expect(button(savingTree.chart, topLabel).props.disabled).toBe(true); expect(button(savingTree.tooth, toothLabel).props.disabled).toBe(true);
    click(button(savingTree.chart, topLabel)); click(button(savingTree.tooth, toothLabel));
    expect(onOpen).not.toHaveBeenCalled(); expect(component(render().chart, "PerioChartView")).toBeUndefined(); expect(writes()).toHaveLength(1);
    if (phase === "request") pending.resolve(response({ message: "Synthetic save refused" }, 400)); else pendingJson.resolve({ message: "Synthetic save refused" });
    await saving; const settled = render();
    expect(button(settled.chart, topLabel).props.disabled).toBe(false); expect(button(settled.tooth, toothLabel).props.disabled).toBe(false);
    click(button(settled.chart, topLabel)); expect(onOpen).toHaveBeenCalledTimes(1); expect(writes()).toHaveLength(1);
  });

  it("keeps navigation blocked through the chart refresh after a successful save", async () => {
    await loaded(); selectTooth(11); const before = render();
    const staleTop = button(before.chart, topLabel); const staleTooth = button(before.tooth, toothLabel);
    const refresh = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementation(async (_target: string, init?: RequestInit) => init?.method === "POST" ? response({}) : refresh.promise);
    const saving = (before.panel!.props.onSave as (body: Record<string, unknown>) => Promise<void>)({ toothCode: 11, condition: "caries", stage: "existing" });
    await settle(); expect(button(render().chart, topLabel).props.disabled).toBe(true);
    click(staleTop); click(staleTooth); expect(onOpen).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
    refresh.resolve(response({ records: [] })); await saving;
    expect(button(render().chart, topLabel).props.disabled).toBe(false);
    click(button(render().chart, topLabel)); expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it.each(["header", "tooth"])("keeps the standalone %s entry unavailable without enabling the legacy recorder", async (entry) => {
    props = { patientId: 91 }; await loaded(); selectTooth(11);
    click(entry === "header" ? button(render().chart, "مخطط اللثة (Perio Chart)") : button(render().tooth, "عرض شاشة اللثة القديمة"));
    const legacy = component(render().chart, "PerioChartView")!;
    expect(legacy.props.canEdit).toBe(false); expect(legacy.props.recordingAvailable).toBe(false);
    expect(legacy.props.initialTooth).toBe(entry === "tooth" ? 11 : null);
    const notice = renderScope("legacy", () => (legacy.type as (input: Record<string, unknown>) => ReactNode)(legacy.props));
    expect(text(notice)).toContain("هذه الشاشة القديمة لا تحفظ أو تعرض"); expect(text(notice)).toContain("مساحة فحص اللثة في ملف المريض");
    expect(elements(notice).filter((node) => ["input", "select", "button"].includes(String(node.type)))).toHaveLength(0);
    expect(text(notice)).not.toMatch(/2 mm|سليم|ملاحظات الزيارة السريرية/); expect(writes()).toHaveLength(0);
  });

  it("keeps primary teeth and ordinary condition, stage, surface and note save inputs intact", async () => {
    await loaded(); const primary = elements(render().chart).find((node) => node.type === "input" && node.props.type === "checkbox")!;
    (primary.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    expect(elements(render().chart).filter((node) => typeof node.type === "function" && node.type.name === "Row")).toHaveLength(4);
    selectTooth(51); click(button(render().tooth, CONDITION_LABEL.filling));
    const planned = elements(render().tooth).find((node) => node.type === "button" && text(node).includes(STAGE_LABEL.planned) && text(node).includes("يضاف لخطة"))!;
    click(planned); click(button(render().tooth, "M إنسي (Mesial)")); setNote("  Synthetic primary note  ");
    click(button(render().tooth, "تثبيت الحالة على المخطط السني"));
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe("/api/patients/91/chart");
    expect(JSON.parse(writes()[0][1].body as string)).toEqual({ toothCode: 51, condition: "filling", stage: "planned", surfaces: "M", note: "Synthetic primary note" });
    expect(onOpen).not.toHaveBeenCalled(); await settle();
  });
});
