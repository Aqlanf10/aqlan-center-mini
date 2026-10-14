import type { ReactElement, ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { ToothSelectionDialog } from "../components/dental/ToothSelectionDialog";
import { Odontogram } from "../components/dental/Odontogram";
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react, useEffect: vi.fn(), useId: () => "synthetic-chart-id", useMemo: (factory: () => unknown) => factory(),
    useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [typeof value === "function" ? value() : value, vi.fn()] };
});
type Node = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Node[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" && "props" in node
  ? [node as Node, ...nodes((node as Node).props.children as ReactNode)] : [];
it("shared chart has explicit native horizontal navigation without duplicating tooth controls", () => {
  const all = nodes(ToothSelectionDialog({ patientId: 11, mode: "per_tooth_episode", serviceName: "Synthetic template",
    initial: { teeth: [36], scope: null, surfaces: "" }, onConfirm: vi.fn(), onCancel: vi.fn() }));
  expect(all.filter(node => node.type === Odontogram)).toHaveLength(1);
  const viewport = all.find(node => node.props["data-testid"] === "tooth-dialog-chart")!;
  const scrollBy = vi.fn(); (viewport.props.ref as { current: unknown }).current = { clientWidth: 300, scrollBy };
  const left = all.find(node => node.props["aria-label"] === "تمرير مخطط الأسنان نحو اليسار")!;
  const right = all.find(node => node.props["aria-label"] === "تمرير مخطط الأسنان نحو اليمين")!;
  expect(left.props["aria-controls"]).toBe(viewport.props.id); expect(right.props["aria-controls"]).toBe(viewport.props.id);
  (left.props.onClick as () => void)(); (right.props.onClick as () => void)();
  expect(scrollBy.mock.calls).toEqual([[{ left: -180, behavior: "smooth" }], [{ left: 180, behavior: "smooth" }]]);
  expect(viewport.props.tabIndex).toBe(0);
  expect(all.some(node => node.props["data-testid"] === "tooth-chart-navigation")).toBe(true);
});
