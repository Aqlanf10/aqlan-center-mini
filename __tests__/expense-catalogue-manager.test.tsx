import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDoctorPermissions } from "../lib/doctor-permissions";
import { projectExpenseCategories } from "../lib/expense-catalogue-visibility";
import { expenseCategoriesFixture as input } from "./fixtures/expense-categories";
import type { SessionInfo } from "../components/SessionProvider";

// Execute the real component's state, effects, reloads and JSX, without a browser,
// database or writes. Only hooks, visual children and synthetic GETs are mocked.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  memo: new Map<number, { value: unknown; deps?: readonly unknown[] }>(),
  effects: new Map<number, { cleanup?: () => void; deps?: readonly unknown[] }>(),
  pending: [] as Array<() => void>, session: null as SessionInfo | null,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a && b
    && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.memo.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = compute(); hooks.memo.set(index, { value, deps }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("../components/SettingsProvider", () => ({ useSetting: () => "Synthetic clinic" }));
vi.mock("../components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("../components/Icon", () => ({ Icon: () => null }));
vi.mock("../components/financeLinks", () => ({ financeLinks: () => [] }));
vi.mock("../components/ExpenseBudgetReportModal", () => ({ ExpenseBudgetReportModal: () => createElement("div", { "data-testid": "budget-report-modal" }) }));
vi.mock("../lib/expenseBudgetExport", () => ({ exportExpenseBudgetToExcel: vi.fn() }));
import { ExpenseCategoriesManager } from "../components/ExpenseCategoriesManager";

const full = projectExpenseCategories(input, "full")!;
const catalogue = projectExpenseCategories(input, "catalogue")!;
const fetchMock = vi.fn();
type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...nodes(element.props.children as ReactNode)];
}
function render(mode: "finance" | "settings" = "finance") {
  let tree: ReactElement | null = null;
  let rounds = 0;
  do {
    if (++rounds > 10) throw new Error("Hook render did not settle");
    hooks.cursor = 0; hooks.changed = false;
    tree = ExpenseCategoriesManager({ headerMode: mode });
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return { tree, html: renderToStaticMarkup(tree), nodes: nodes(tree) };
}
function response(payload: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => payload } as Response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle(mode: "finance" | "settings" = "finance") {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return render(mode);
}
function noBudget(html: string) {
  expect(html).not.toContain('data-testid="expense-budget-manager"');
  expect(html).not.toContain('data-testid="budget-report-modal"');
  expect(html).not.toContain("تصدير Excel");
  expect(html).not.toContain("تقرير وتدقيق الميزانية (PDF)");
  expect(html).not.toContain("إضافة بند مصروف جديد");
  expect(html).not.toContain("شهر الميزانية:");
  expect(html).not.toContain("NaN");
}
function changeMonth(value: string) {
  const field = render().nodes.find((node) => node.type === "input" && node.props.type === "month")!;
  (field.props.onChange as (event: unknown) => void)({ target: { value } });
}
function clickReload() {
  const button = render().nodes.find((node) => node.type === "button" && node.props.children === "إعادة التحميل")!;
  (button.props.onClick as () => void)();
}
function unmount() {
  hooks.effects.forEach((effect) => effect.cleanup?.());
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.memo.clear(); hooks.effects.clear(); hooks.pending = [];
  hooks.session = { username: "synthetic", role: "doctor", permissions: parseDoctorPermissions({ canViewExpenses: true }) };
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe("expense manager catalogue-only response handling", () => {
  it.each(["finance", "settings"] as const)("renders safe catalogue metadata without money or budget actions in %s mode", async (mode) => {
    fetchMock.mockResolvedValueOnce(response(catalogue));
    noBudget(render(mode).html);
    const view = await settle(mode);
    noBudget(view.html);
    expect(view.html).toContain('data-testid="expense-catalogue-only"');
    expect(view.html).toContain("Synthetic lab category");
    expect(view.html).toContain("5101");
    expect(view.html).not.toContain("Synthetic confidential budget note");
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("keeps the authorized report table and export contract", async () => {
    fetchMock.mockResolvedValueOnce(response(full)); render();
    const view = await settle();
    expect(view.html).toContain('data-testid="expense-budget-manager"');
    expect(view.html).toContain("Synthetic lab category");
    expect(view.html).toContain("تصدير Excel");
    expect(view.html).not.toContain("NaN");
  });

  it.each([401, 403])("clears a loaded financial report during a reload and on %s", async (status) => {
    fetchMock.mockResolvedValueOnce(response(full)); render(); await settle();
    const pending = deferred<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
    changeMonth("2026-08");
    noBudget(render().html);
    pending.resolve(response({ message: "Synthetic access denied" }, status));
    const view = await settle();
    noBudget(view.html); expect(view.html).toContain("Synthetic access denied");
    fetchMock.mockResolvedValueOnce(response(catalogue)); clickReload();
    expect((await settle()).html).toContain('data-testid="expense-catalogue-only"');
  });

  it("closes a previously open report during reload and does not reopen it after recovery", async () => {
    fetchMock.mockResolvedValueOnce(response(full)); render(); await settle();
    const report = render().nodes.find((node) => node.type === "button" && renderToStaticMarkup(node).includes("تقرير وتدقيق الميزانية"))!;
    (report.props.onClick as () => void)();
    expect(render().html).toContain('data-testid="budget-report-modal"');
    fetchMock.mockResolvedValueOnce(response(catalogue));
    changeMonth("2026-08"); render();
    noBudget((await settle()).html);
    fetchMock.mockResolvedValueOnce(response(full)); clickReload();
    const recovered = await settle();
    expect(recovered.html).toContain('data-testid="expense-budget-manager"');
    expect(recovered.html).not.toContain('data-testid="budget-report-modal"');
  });

  it("deliberately discards unsaved budget edits when reloading rather than carrying them through permission changes", async () => {
    fetchMock.mockResolvedValueOnce(response(full)); render(); await settle();
    const budget = render().nodes.find((node) => node.type === "input" && node.props.type === "number" && node.props.value === 123400)!;
    (budget.props.onChange as (event: unknown) => void)({ target: { value: "321000" } });
    expect(render().html).toContain("حفظ التعديلات الآن");
    fetchMock.mockResolvedValueOnce(response(catalogue)); changeMonth("2026-08"); render();
    noBudget((await settle()).html);
    fetchMock.mockResolvedValueOnce(response(full)); clickReload();
    const recovered = await settle();
    expect(recovered.html).not.toContain("حفظ التعديلات الآن");
    expect(recovered.nodes.find((node) => node.type === "input" && node.props.type === "number")!.props.value).toBe(123400);
  });

  it("keeps only the last repeated reload when both requests use the same session and period", async () => {
    fetchMock.mockResolvedValueOnce(response(catalogue)); render(); await settle();
    const reload = render().nodes.find((node) => node.type === "button" && node.props.children === "إعادة التحميل")!;
    const older = deferred<Response>(); const newer = deferred<Response>();
    fetchMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    (reload.props.onClick as () => void)();
    (reload.props.onClick as () => void)();
    newer.resolve(response(catalogue)); await settle();
    older.resolve(response(full));
    const view = await settle(); noBudget(view.html);
    expect(view.html).toContain('data-testid="expense-catalogue-only"');
  });

  it("invalidates visible data on session permission change before the replacement response", async () => {
    fetchMock.mockResolvedValueOnce(response(full)); render(); await settle();
    const pending = deferred<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
    hooks.session = { ...hooks.session!, permissions: parseDoctorPermissions({ canViewExpenses: false }) };
    noBudget(render().html);
    pending.resolve(response(catalogue));
    noBudget((await settle()).html);
  });

  it("prevents a stale full response from replacing newer catalogue-only data", async () => {
    const older = deferred<Response>(); fetchMock.mockReturnValueOnce(older.promise); render();
    const oldSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    hooks.session = { ...hooks.session!, permissions: parseDoctorPermissions({ canViewExpenses: false }) };
    fetchMock.mockResolvedValueOnce(response(catalogue)); render(); await settle();
    expect(oldSignal.aborted).toBe(true);
    older.resolve(response(full));
    const view = await settle();
    noBudget(view.html); expect(view.html).toContain('data-testid="expense-catalogue-only"');
  });

  it("also prevents stale JSON completion from restoring full data", async () => {
    const olderBody = deferred<unknown>();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => olderBody.promise }); render(); await settle();
    hooks.session = { ...hooks.session!, username: "another-synthetic-account" };
    fetchMock.mockResolvedValueOnce(response(catalogue)); render(); await settle();
    olderBody.resolve(full);
    noBudget((await settle()).html);
  });

  it("ignores obsolete errors and cannot stop a newer request's loading state", async () => {
    const older = deferred<Response>(); const newer = deferred<Response>();
    fetchMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise); render();
    hooks.session = { ...hooks.session!, username: "another-synthetic-account" }; render();
    older.reject(new Error("Obsolete error"));
    const waiting = await settle();
    noBudget(waiting.html); expect(waiting.html).toContain("جاري تحميل"); expect(waiting.html).not.toContain("Obsolete error");
    newer.resolve(response(catalogue)); expect((await settle()).html).toContain('data-testid="expense-catalogue-only"');
  });

  it("does not repopulate state after unmount", async () => {
    const pending = deferred<Response>(); fetchMock.mockReturnValueOnce(pending.promise); render();
    const before = [...hooks.values]; const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    unmount(); pending.resolve(response(full));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(hooks.values).toEqual(before);
  });

  it.each([null, { ...full, visibility: undefined }, { ...full, summary: undefined }])("fails closed on an invalid or old response shape", async (payload) => {
    fetchMock.mockResolvedValueOnce(response(payload)); render();
    const view = await settle(); noBudget(view.html); expect(view.html).toContain("تعذّر التحقق");
  });
});
