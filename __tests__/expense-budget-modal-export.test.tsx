import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expenseCategoriesFixture as fixture } from "./fixtures/expense-categories";
const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.values)) state.values[index] = initial;
    return [state.values[index], (value: unknown) => { state.values[index] = value; }];
  },
  useMemo: (compute: () => unknown) => compute(), useRef: () => ({ current: null }), useEffect: () => {},
}));
vi.mock("../components/SettingsProvider", () => ({ useSetting: () => "Synthetic clinic" }));
vi.mock("../components/Icon", () => ({ Icon: () => null, Logo: () => null }));
vi.mock("../components/ReportPrintHeader", () => ({ ReportPrintHeader: () => null, ReportPrintFooter: () => null }));
vi.mock("../lib/expenseBudgetExport", () => ({ exportExpenseBudgetToExcel: vi.fn() }));
import { ExpenseBudgetReportModal } from "../components/ExpenseBudgetReportModal";
import { exportExpenseBudgetToExcel } from "../lib/expenseBudgetExport";
type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...nodes(element.props.children as ReactNode)];
}
const categories = [
  { ...fixture.categories[0], id: 1, categoryGroup: "Selected", isOverBudget: false },
  { ...fixture.categories[0], id: 2, categoryGroup: "Other", isOverBudget: true },
];
function render() {
  state.cursor = 0;
  return nodes(ExpenseBudgetReportModal({ categories, summary: fixture.summary, month: "2026-10", baseCurrency: "SAR", onClose: () => {} }));
}
beforeEach(() => { state.values = []; state.cursor = 0; vi.clearAllMocks(); });
describe("expense modal export selection", () => {
  it.each(["all", "group", "over", "within", "empty"])("passes the %s selection without a global summary", (filter) => {
    const change = (index: number, value: string) => {
      const field = render().filter((node) => node.type === "select")[index];
      (field.props.onChange as (e: unknown) => void)({ target: { value } });
    };
    if (filter === "group" || filter === "empty") change(0, "Selected");
    if (filter === "over" || filter === "empty") change(1, "over");
    if (filter === "within") change(1, "within");
    const button = render().find((node) => node.type === "button" && renderToStaticMarkup(node).includes("Excel"))!;
    (button.props.onClick as () => void)();
    expect(exportExpenseBudgetToExcel).toHaveBeenCalledOnce();
    const params = vi.mocked(exportExpenseBudgetToExcel).mock.calls[0][0];
    expect(params.categories.map((row) => row.id)).toEqual(filter === "all" ? [1, 2] : filter === "empty" ? [] : filter === "over" ? [2] : [1]);
    expect(params).not.toHaveProperty("summary");
    expect(params.baseCurrency).toBe("SAR");
    expect(params.month).toBe("2026-10");
  });
});
