import type { ComponentProps, ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToothSelectionDialog } from "../components/dental/ToothSelectionDialog";
import { Odontogram } from "../components/dental/Odontogram";
import { SurfaceSelector } from "../components/dental/SurfaceSelector";
import type { ToothSelection } from "../components/dental/invoice-tooth-selection";

// Same DOM-free hook approach as tooth-dialog-navigation and invoice-grouped-editor.
// Exercise the real dialog and surface-button callbacks; chart networking, focus
// containment and native keyboard/layout acceptance belong to browser tests.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return index;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(initial);
      return [hooks.values[index], (value: unknown) => {
        hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value;
      }];
    },
    useId: () => `synthetic-surfaces-${slot("id")}`,
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useMemo: (factory: () => unknown) => factory(),
    useEffect: vi.fn(),
  };
});

type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node
    ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const confirmed = vi.fn<(selection: ToothSelection) => void>();
const cancelled = vi.fn();
let props: ComponentProps<typeof ToothSelectionDialog>;

function render() {
  hooks.cursor = 0;
  return ToothSelectionDialog(props);
}
function find(predicate: (node: Element) => boolean, root: ReactNode = render()): Element {
  const found = nodes(root).find(predicate);
  expect(found, "expected rendered dialog control").toBeDefined();
  return found!;
}
const byId = (id: string) => find(node => node.props["data-testid"] === id);
const click = (node: Element) => { (node.props.onClick as () => void)(); render(); };
const pick = (tooth: number) => {
  const chart = find(node => node.type === Odontogram);
  (chart.props.onPick as (code: number) => void)(tooth);
  render();
};
const selected = () => find(node => node.type === Odontogram).props.selected;
function surfaces(tooth: number) {
  const selector = find(node => node.type === SurfaceSelector, byId(`tooth-surfaces-${tooth}`));
  return SurfaceSelector(selector.props as ComponentProps<typeof SurfaceSelector>);
}
const surfaceButton = (tooth: number, surface: string) => find(node => node.props["data-testid"] === `surface-${surface}`, surfaces(tooth));
const activeSurfaces = (tooth: number) => nodes(surfaces(tooth))
  .filter(node => node.type === "button" && node.props["aria-pressed"] === true)
  .map(node => String(node.props["data-testid"]).replace("surface-", ""));
const confirm = () => click(byId("tooth-dialog-confirm"));

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0;
  confirmed.mockClear(); cancelled.mockClear();
  props = { patientId: 901, mode: "tooth_surfaces", serviceName: "Synthetic filling", groupedInvoice: true,
    initial: { teeth: [], surfaces: "", scope: null }, onConfirm: confirmed, onCancel: cancelled };
});

describe("filling tooth dialog keeps surfaces owned by each selected tooth", () => {
  it("selects several teeth and confirms distinct editable surface sets", () => {
    pick(36); pick(26); pick(46);
    click(surfaceButton(26, "M")); click(surfaceButton(26, "O"));
    click(surfaceButton(36, "D")); click(surfaceButton(36, "B"));
    click(surfaceButton(36, "D"));
    expect(selected()).toEqual([26, 36, 46]);
    expect(activeSurfaces(26)).toEqual(["M", "O"]);
    expect(activeSurfaces(36)).toEqual(["B"]);
    expect(activeSurfaces(46)).toEqual([]);
    expect(confirmed).not.toHaveBeenCalled();
    expect(byId("tooth-dialog-confirm").props.disabled).toBe(false);
    confirm();
    expect(confirmed).toHaveBeenCalledExactlyOnceWith({ teeth: [26, 36, 46], surfaces: "", scope: null,
      surfacesByTooth: { 26: "MO", 36: "B", 46: "" } });
    expect(cancelled).not.toHaveBeenCalled();
  });

  it.each(["cancel", "close", "backdrop"])("%s discards edits without confirming or mutating the initial selection", action => {
    props = { ...props, initial: { teeth: [26, 36], surfaces: "", scope: null, surfacesByTooth: { 26: "MO", 36: "B" } } };
    const original = structuredClone(props.initial);
    click(surfaceButton(26, "D")); pick(36); pick(46);
    const target = action === "backdrop" ? byId("tooth-dialog-backdrop")
      : find(node => node.type === "button" && (action === "close" ? node.props["aria-label"] === "إغلاق" : node.props.children === "إلغاء"));
    click(target);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(confirmed).not.toHaveBeenCalled();
    expect(props.initial).toEqual(original);
  });

  it("deselecting and reselecting a tooth clears only that tooth's previous surfaces", () => {
    props = { ...props, initial: { teeth: [26, 36], surfaces: "", scope: null, surfacesByTooth: { 26: "MO", 36: "BL" } } };
    pick(26);
    expect(selected()).toEqual([36]);
    expect(nodes(render()).some(node => node.props["data-testid"] === "tooth-surfaces-26")).toBe(false);
    expect(activeSurfaces(36)).toEqual(["B", "L"]);
    pick(26);
    expect(activeSurfaces(26)).toEqual([]);
    expect(activeSurfaces(36)).toEqual(["B", "L"]);
    confirm();
    expect(confirmed).toHaveBeenCalledExactlyOnceWith({ teeth: [26, 36], surfaces: "", scope: null,
      surfacesByTooth: { 26: "", 36: "BL" } });
  });

  it("clear removes every surface and prevents confirmation until a tooth is chosen again", () => {
    props = { ...props, initial: { teeth: [26, 36], surfaces: "", scope: null, surfacesByTooth: { 26: "MO", 36: "BL" } } };
    click(find(node => node.type === "button" && node.props.children === "مسح"));
    expect(selected()).toEqual([]);
    expect(nodes(render()).filter(node => node.type === "fieldset")).toEqual([]);
    expect(byId("tooth-dialog-confirm").props.disabled).toBe(true);
    confirm();
    expect(confirmed).not.toHaveBeenCalled();
    pick(36);
    expect(activeSurfaces(36)).toEqual([]);
    confirm();
    expect(confirmed).toHaveBeenCalledExactlyOnceWith({ teeth: [36], surfaces: "", scope: null, surfacesByTooth: { 36: "" } });
  });

  it("keeps historical filling agreements single-tooth and never transfers the former tooth's surfaces", () => {
    props = { ...props, purpose: "legacy_agreement", groupedInvoice: false,
      initial: { teeth: [26], surfaces: "MO", scope: null } };
    expect(activeSurfaces(26)).toEqual(["M", "O"]);
    pick(36);
    expect(selected()).toEqual([36]);
    expect(activeSurfaces(36)).toEqual([]);
    click(surfaceButton(36, "L"));
    confirm();
    expect(confirmed).toHaveBeenCalledExactlyOnceWith({ teeth: [36], surfaces: "L", scope: null, surfacesByTooth: { 36: "L" } });
  });

  it("reopens a confirmed surface map for independent review and amendment", () => {
    pick(26); pick(36);
    click(surfaceButton(26, "M")); click(surfaceButton(26, "O")); click(surfaceButton(36, "L"));
    confirm();
    const saved = structuredClone(confirmed.mock.calls[0][0]);
    hooks.values = []; hooks.cursor = 0;
    props = { ...props, initial: saved };
    confirmed.mockClear();
    expect(selected()).toEqual([26, 36]);
    expect(activeSurfaces(26)).toEqual(["M", "O"]);
    expect(activeSurfaces(36)).toEqual(["L"]);
    click(surfaceButton(26, "O")); click(surfaceButton(36, "B"));
    confirm();
    expect(confirmed).toHaveBeenCalledExactlyOnceWith({ teeth: [26, 36], surfaces: "", scope: null,
      surfacesByTooth: { 26: "M", 36: "LB" } });
    expect(saved.surfacesByTooth).toEqual({ 26: "MO", 36: "L" });
  });
});
