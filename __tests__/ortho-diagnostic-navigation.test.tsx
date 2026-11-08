import { createElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoDiagnosticNavigation } from "../components/OrthoDiagnosticNavigation";

// Synthetic hook and DOM-method harness, not browser focus/scroll acceptance.
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], cleanups: [] as Array<() => void> }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useRef: (initial: unknown) => { const i = hooks.cursor++; return hooks.slots[i] ??= { current: initial }; },
    useMemo: (make: () => unknown, deps: unknown[]) => {
      const i = hooks.cursor++, old = hooks.slots[i] as { deps: unknown[]; value: unknown } | undefined;
      if (old && deps.every((v, n) => Object.is(v, old.deps[n]))) return old.value;
      const value = make(); hooks.slots[i] = { deps, value }; return value;
    },
    useLayoutEffect: (effect: () => () => void, deps: unknown[]) => {
      const i = hooks.cursor++, old = hooks.slots[i] as { deps: unknown[]; cleanup: () => void } | undefined;
      if (old && deps.every((v, n) => Object.is(v, old.deps[n]))) return;
      old?.cleanup(); const cleanup = effect(); hooks.slots[i] = { deps, cleanup }; hooks.cleanups.push(cleanup);
    },
  };
});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
let props: Parameters<typeof OrthoDiagnosticNavigation>[0];
const target = () => ({ isConnected: true, focus: vi.fn(), scrollIntoView: vi.fn() });
let targets: ReturnType<typeof target>[];
let container: { isConnected: boolean; contains: ReturnType<typeof vi.fn>; querySelector: ReturnType<typeof vi.fn> };
function render() { hooks.cursor = 0; const tree = OrthoDiagnosticNavigation(props); (tree.props.ref as { current: unknown }).current = container; return tree; }
const buttons = () => nodes(render()).filter(n => n.type === "button");
const click = (button: Element) => (button.props.onClick as () => void)();
beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; hooks.cleanups = [];
  props = { ownerIdentity: {}, orthoCaseId: 21, readVersion: 1, active: () => true,
    children: [createElement("section", { key: "saved" }, "saved"), createElement("section", { key: "draft" }, "draft")] };
  targets = Array.from({ length: 4 }, target);
  container = { isConnected: true, contains: vi.fn(t => targets.includes(t)), querySelector: vi.fn(selector => targets[['records','ceph','comparison','assessment'].findIndex(key => selector.includes(`="${key}"`))]) };
});
afterEach(() => { hooks.cleanups.forEach(run => run()); vi.unstubAllGlobals(); });
describe("diagnostic focus-only navigation", () => {
  it("scopes four native buttons to its own root and focuses before scrolling, without changing children", () => {
    const tree = render(), children = tree.props.children[1];
    expect(children).toBe(props.children);
    const controls = buttons(); expect(controls).toHaveLength(4);
    for (const [i, control] of controls.entries()) {
      expect(control.props.type).toBe("button"); click(control);
      expect(targets[i].focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(targets[i].scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
      expect(targets[i].focus.mock.invocationCallOrder[0]).toBeLessThan(targets[i].scrollIntoView.mock.invocationCallOrder[0]);
    }
    expect(render().props.children[1]).toBe(children);
    expect(nodes(render()).some(n => n.props.hidden || n.type === "a" || n.type === "form")).toBe(false);
  });
  it.each(["owner", "case", "read"])("retires retained callbacks across %s ABA", kind => {
    const old = buttons()[0], first = props;
    props = { ...props, ...(kind === "owner" ? { ownerIdentity: {} } : kind === "case" ? { orthoCaseId: 22 } : { readVersion: 2 }) }; render();
    props = first; render(); click(old); expect(container.querySelector).not.toHaveBeenCalled();
    click(buttons()[0]); expect(targets[0].focus).toHaveBeenCalledOnce();
  });
  it.each(["denied", "detached-root", "detached-target", "foreign-target", "missing"])("does not focus or scroll a %s target", kind => {
    if (kind === 'denied') props.active = () => false;
    if (kind === 'detached-root') container.isConnected = false;
    if (kind === 'detached-target') targets[0].isConnected = false;
    if (kind === 'foreign-target') container.contains.mockReturnValue(false);
    if (kind === 'missing') container.querySelector.mockReturnValue(null);
    click(buttons()[0]); expect(targets[0].focus).not.toHaveBeenCalled(); expect(targets[0].scrollIntoView).not.toHaveBeenCalled();
  });
  it("rechecks authority after focus and ignores handlers after unmount", () => {
    let active = true; props.active = () => active;
    const old = buttons()[0]; targets[0].focus.mockImplementation(() => { active = false; }); click(old);
    expect(targets[0].scrollIntoView).not.toHaveBeenCalled();
    hooks.cleanups.forEach(run => run()); active = true; click(old); expect(targets[0].focus).toHaveBeenCalledOnce();
  });
});
