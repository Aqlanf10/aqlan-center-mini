import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoCaseJourneyNavigation, type OrthoCaseJourneyNavigationProps } from "../components/OrthoCaseJourneyNavigation";
import { orthoJourneySelection, type OrthoJourneyNavigationRequest } from "../lib/ortho-case-journey-navigation";

// Actual component callbacks with synthetic hook storage. Real React/layout proof is separate.
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], pending: [] as Array<() => void>, cleanups: [] as Array<() => void> }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (value: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = value; return index; };
  return { ...react,
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useState: (initial: unknown) => { const index = slot(initial); return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }]; },
    useLayoutEffect: (effect: () => () => void) => { slot(undefined); hooks.pending.push(() => { hooks.cleanups.push(effect()); }); },
  };
});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const textOf = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" && "props" in node ? textOf((node as Element).props.children as ReactNode) : "";
let props: OrthoCaseJourneyNavigationProps;
const accept = vi.fn((_request: OrthoJourneyNavigationRequest) => true);
const navigate = vi.fn((_request: OrthoJourneyNavigationRequest): void | Promise<void> => undefined);
function retire() { hooks.cleanups.splice(0).forEach(cleanup => cleanup()); hooks.values.length = 0; hooks.pending.length = 0; }
function render(commit = true) {
  hooks.cursor = 0;
  const tree = OrthoCaseJourneyNavigation(props);
  if (commit) { hooks.cleanups.splice(0).forEach(cleanup => cleanup()); hooks.pending.splice(0).forEach(effect => effect()); }
  return tree;
}
function control(tree: ReactNode, label: string) {
  const found = nodes(tree).find(node => node.type === "button" && textOf(node) === label);
  if (!found) throw new Error(`Missing control ${label}`);
  return found;
}
const click = (tree: ReactNode, label: string) => (control(tree, label).props.onClick as () => void)();
beforeEach(() => {
  retire(); accept.mockReset().mockReturnValue(true); navigate.mockReset();
  props = { id: "synthetic-nav", panelId: "synthetic-panel", selection: orthoJourneySelection("visits"), navigationScope: {},
    isCurrent: () => true, canNavigate: accept, onNavigate: navigate };
});
afterEach(retire);
describe("controlled caller-guarded journey component", () => {
  it("does not change selection or status when requesting a section", () => {
    const tree = render(); click(tree, "عرض الحالة");
    expect(accept).toHaveBeenCalledTimes(1); expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0]).toMatchObject({ scope: props.navigationScope, from: { section: "summary", step: "visits" },
      to: { section: "presentation", step: "study" }, source: "section", route: { pillar: "diagnostics", subview: "study" } });
    expect(props.selection).toEqual({ section: "summary", step: "visits" });
    expect(textOf(render())).toContain("الحالة غير محددة");
    expect(textOf(render())).not.toContain("مكتملة المدخلات");
    expect(textOf(render())).not.toContain("معتمدة");
  });
  it("requires caller admission for section, substep, previous and next", () => {
    props = { ...props, selection: orthoJourneySelection("ceph") };
    accept.mockReturnValue(false);
    for (const label of ["عرض الحالة", "الخطوة السابقة", "الخطوة التالية"]) click(render(), label);
    const step = nodes(render()).find(node => node.type === "button" && textOf(node).startsWith("2. المقابلة"))!;
    (step.props.onClick as () => void)();
    expect(accept).toHaveBeenCalledTimes(4); expect(navigate).not.toHaveBeenCalled();
    expect(props.selection.step).toBe("ceph");
  });
  it("restores both controlled selects while an asynchronous decision is pending", () => {
    navigate.mockImplementation(() => new Promise<void>(() => {}));
    props = { ...props, selection: orthoJourneySelection("interview") };
    const selects = nodes(render()).filter(node => node.type === "select");
    const primary = { currentTarget: { value: "presentation" } };
    (selects[0].props.onChange as (event: typeof primary) => void)(primary);
    expect(primary.currentTarget.value).toBe("records");
    const step = { currentTarget: { value: "ceph" } };
    (selects[1].props.onChange as (event: typeof step) => void)(step);
    expect(step.currentTarget.value).toBe("interview");
    expect(props.selection.step).toBe("interview");
    expect(navigate).toHaveBeenCalledTimes(2);
  });
  it("does not reset a selected primary section or bypass a lock/retired owner", () => {
    props = { ...props, selection: orthoJourneySelection("ceph") };
    click(render(), "السجلات والتشخيص"); expect(navigate).not.toHaveBeenCalled();
    props = { ...props, blockedReason: "Synthetic pending command" };
    click(render(), "عرض الحالة"); expect(accept).not.toHaveBeenCalled();
    props = { ...props, blockedReason: null, isCurrent: () => false };
    click(render(), "عرض الحالة"); expect(accept).not.toHaveBeenCalled();
  });
  it("refuses old committed callbacks after a newer commit or unmount", () => {
    const old = control(render(), "عرض الحالة").props.onClick as () => void;
    props = { ...props, navigationScope: {} }; render(); old();
    expect(navigate).not.toHaveBeenCalled();
    const live = control(render(), "عرض الحالة").props.onClick as () => void;
    retire(); live(); expect(navigate).not.toHaveBeenCalled();
  });
  it("does not publish abandoned render props to a current handler", () => {
    const initial = props, old = control(render(), "عرض الحالة").props.onClick as () => void;
    props = { ...props, navigationScope: {}, isCurrent: () => false }; render(false); hooks.pending.length = 0;
    props = initial; old(); expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0].scope).toBe(initial.navigationScope);
  });
  it("rechecks the owner after the caller guard changes its scope", () => {
    const tree = render();
    accept.mockImplementation(() => { props = { ...props, navigationScope: {} }; render(); return true; });
    click(tree, "عرض الحالة"); expect(navigate).not.toHaveBeenCalled();
  });
  it("shows only explicit evidence, keeps unavailable notes navigable, and has no fake save/export actions", () => {
    props = { ...props, selection: orthoJourneySelection("interview"), evidence: {
      interview: { status: "inputs_complete" }, ceph: { note: "Synthetic unavailable image" },
    } };
    const tree = render();
    expect(textOf(tree)).toContain("مكتملة المدخلات"); expect(textOf(tree)).not.toContain("معتمدة");
    const ceph = nodes(tree).find(node => node.type === "button" && textOf(node).startsWith("7. السيفالو"))!;
    expect(ceph.props.disabled).toBe(false); (ceph.props.onClick as () => void)();
    expect(navigate.mock.calls[0][0].to.step).toBe("ceph");
    expect(nodes(tree).filter(node => node.type === "button").map(node => textOf(node)).join(" ")).not.toMatch(/حفظ|تصدير|اعتماد/);
  });
  it("moves keyboard focus without admission or navigation", () => {
    const tree = render(), focused = vi.fn();
    const records = control(tree, "السجلات والتشخيص");
    (records.props.ref as (node: unknown) => void)({ focus: focused });
    const event = { key: "ArrowLeft", preventDefault: vi.fn(), altKey: false, ctrlKey: false, metaKey: false };
    (control(tree, "ملخص الحالة والجلسة").props.onKeyDown as (event: unknown) => void)(event);
    expect(focused).toHaveBeenCalledOnce(); expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(accept).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });
  it("reflects caller-accepted backward/forward state without callbacks or evidence mutation", () => {
    const evidence = Object.freeze({ ceph: Object.freeze({ status: "needs_review" as const }) });
    props = { ...props, selection: orthoJourneySelection("ceph"), evidence };
    render();
    props = { ...props, selection: orthoJourneySelection("study") }; render();
    props = { ...props, selection: orthoJourneySelection("ceph") };
    expect(textOf(render())).toContain("تحتاج مراجعة");
    expect(props.evidence).toBe(evidence); expect(accept).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });
});
