import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AccountSecondaryActions } from "../components/AccountSecondaryActions";

const state = vi.hoisted(() => ({ open: false, setOpen: vi.fn() }));
const menu = vi.hoisted(() => ({ ref: { current: null }, onSummaryClick: vi.fn(), onKeyDown: vi.fn(), onActionClick: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: () => [state.open, state.setOpen] }));
vi.mock("../components/useDismissibleDetails", () => ({ useDismissibleDetails: vi.fn(() => menu) }));
import { useDismissibleDetails } from "../components/useDismissibleDetails";
type Node = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Node[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Node, ...nodes((node as Node).props.children as ReactNode)] : [];

describe("Account secondary actions use the shared dismissal contract", () => {
  it.each([false, true])("keeps controlled state and all summary/key/action handlers when open=%s", open => {
    state.open = open;
    const tree = AccountSecondaryActions({ children: <button type="button">existing correction or opening action</button> });
    expect(useDismissibleDetails).toHaveBeenLastCalledWith(open, state.setOpen);
    const all = nodes(tree);
    const details = all.find(node => node.type === "details")!;
    const summary = all.find(node => node.type === "summary")!;
    expect(details.props.open).toBe(open); expect(details.props.onKeyDown).toBe(menu.onKeyDown);
    expect(summary.props["aria-expanded"]).toBe(open); expect(summary.props.onClick).toBe(menu.onSummaryClick);
    expect(all.some(node => node.type === "div" && node.props.onClick === menu.onActionClick)).toBe(true);
    expect(all.filter(node => node.type === "button")).toHaveLength(1);
  });
});
