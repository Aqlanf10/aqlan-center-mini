import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FinancePage from "../app/finance/page";
import ReconciliationPage from "../app/finance/reconciliation/page";
import { FinanceKpis } from "../components/finance/FinanceKpis";
import { CashShiftTab } from "../components/finance/CashShiftTab";
import { CollectPaymentModal } from "../components/CollectPaymentModal";
import { QuickCollectModal } from "../components/finance/QuickCollectModal";
import { CURRENCIES, formatMoney } from "../lib/money";
import type { Role } from "../lib/roles";

// LOCAL UI contract audit: real page/KPI functions, synthetic data and mocked
// hooks only. All network calls are replaced, non-GET methods fail the test,
// and no API route, database, runtime bootstrap, browser or financial handler
// is imported or invoked. Child components unrelated to these states are inert.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  memo: new Map<number, { value: unknown; deps?: readonly unknown[] }>(),
  effects: new Map<number, { effect: () => void; deps?: readonly unknown[] }>(),
  pending: [] as Array<() => void>,
  session: { username: "synthetic-admin", role: "admin" as Role, permissions: { financeAccess: {} as Record<string, boolean> } },
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a && b
    && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.memo.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = compute();
    hooks.memo.set(index, { value, deps });
    return value;
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => memo(() => ({ current: initial }), []),
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void, deps?: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.effects.set(index, { effect, deps });
      hooks.pending.push(effect);
    },
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic", useSetting: () => "" }));
vi.mock("../components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("../components/financeLinks", () => ({ financeLinks: () => [] }));
vi.mock("../components/FinanceNavigation", () => ({ FinanceNavigation: () => null }));
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("../components/LabReconciliationModal", () => ({ LabReconciliationModal: () => null }));
vi.mock("../components/CaseProfitabilityModal", () => ({ CaseProfitabilityModal: () => null }));
vi.mock("../components/finance/QuickCollectModal", () => ({ QuickCollectModal: () => null }));
vi.mock("../components/finance/CashShiftTab", () => ({ CashShiftTab: () => null }));
vi.mock("../components/finance/ReceivablesLabsTab", () => ({ ReceivablesLabsTab: () => null }));
vi.mock("../components/finance/CommissionsProfitabilityTab", () => ({ CommissionsProfitabilityTab: () => null }));
vi.mock("../components/finance/AccountingReportsTab", () => ({ AccountingReportsTab: () => null }));
vi.mock("../components/finance/ShiftCloseStatus", () => ({ ShiftCloseStatus: () => null }));
vi.mock("../lib/reminders", () => ({ friendlyDateLong: (date: string) => date }));
vi.mock("../lib/schedule", () => ({ clinicDateString: () => "2030-01-01" }));

type Element = ReactElement<Record<string, unknown>>;
type Page = typeof FinancePage | typeof ReconciliationPage;
function children(node: ReactNode): ReactNode {
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const element = node as Element;
  if (element.props.hidden || element.props.inert) return null;
  // This leaf is pure and has no hooks, so its real UI is inspected with its
  // actual props from FinancePage. Other mocked child boundaries stay inert.
  if (element.type === FinanceKpis) return FinanceKpis(element.props as unknown as Parameters<typeof FinanceKpis>[0]);
  return element.props.children as ReactNode;
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  return [node as Element, ...elements(children(node))];
}
function contents(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(contents).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return contents(children(node));
}
function render(page: Page) {
  let tree: ReactNode = null;
  let rounds = 0;
  do {
    if (++rounds > 10) throw new Error("Hook render did not settle");
    hooks.cursor = 0;
    hooks.changed = false;
    tree = page();
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return {
    tree, text: contents(tree),
    nodes: elements(tree),
    enabledShiftButtons: elements(tree).filter((node) => node.type === "button"
      && /فتح وردية جديدة|جرد وإقفال الوردية|إغلاق وجرد الوردية/.test(contents(node))
      && !node.props.disabled),
  };
}
const zero = () => ({ YER: 0, SAR: 0, USD: 0 });
const expected = { YER: 72_500, SAR: 1_234, USD: -125 };
const shift = {
  id: 91001, openedBy: "Synthetic cashier", openedAt: "2030-01-01T09:00:00.000Z",
  opening: { YER: 50_000, SAR: 1_000, USD: 200 },
  closedBy: null, closedAt: null, counted: null, note: null, status: "open" as const,
};
const feed = (open: boolean) => ({
  open: open ? shift : null,
  totals: { byCurrency: zero(), baseTotalMinor: 90_000, paymentCount: 2 },
  expenseTotals: { byCategory: {}, byCurrency: zero(), baseTotalMinor: 500, count: 1 },
  payments: [], expenses: [], recent: [], drawer: open ? { expected } : null,
});
const reconciliation = (open: boolean) => ({
  openShift: open ? { shift, paymentsCount: 2, expensesCount: 1, income: zero(),
    refunds: zero(), expenses: zero(), expected } : null,
  shifts: [], baseCurrency: "YER",
});
const reply = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => data });
type Reply = ReturnType<typeof reply>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const fetchMock = vi.fn();
let request: ReturnType<typeof deferred<Reply>>;
const modes = [
  { name: "finance", page: FinancePage, url: "/api/shifts", payload: feed },
  { name: "reconciliation", page: ReconciliationPage, url: "/api/finance/reconciliation", payload: reconciliation },
];
async function settle() {
  // Only mocked async response/JSON microtasks are flushed. No timer, server,
  // filesystem bootstrap, live fetch, transaction or money action is involved.
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
function beginRefresh() {
  request = deferred<Reply>();
  // Re-run the captured data-loading effect directly, without invoking any
  // collection, opening, closing, expense or reconciliation action.
  const first = hooks.effects.values().next().value;
  if (!first) throw new Error("Missing page data-loading effect");
  first.effect();
}
function expectUnknown(view: ReturnType<typeof render>) {
  expect(view.text).not.toContain("الصندوق مغلق");
  expect(view.text).not.toContain("لا توجد وردية مفتوحة");
  expect(view.nodes.some((node) => node.type === "span" && contents(node) === "مغلقة")).toBe(false);
  expect(view.enabledShiftButtons).toHaveLength(0);
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.memo.clear(); hooks.effects.clear(); hooks.pending = [];
  hooks.session = { username: "synthetic-admin", role: "admin", permissions: { financeAccess: {} } };
  request = deferred<Reply>();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") throw new Error(`Forbidden test write: ${init.method} ${url}`);
    if (url === "/api/shifts" || url === "/api/finance/reconciliation") return request.promise;
    if (url === "/api/parties") return Promise.resolve(reply([]));
    if (url === "/api/finance/debts") return Promise.resolve(reply({ rows: [] }));
    if (url === "/api/plans") return Promise.resolve(reply({ plans: [] }));
    if (url === "/api/finance/lab-reconciliation") return Promise.resolve(reply({ labs: [], risks: [], totalRisksCount: 0 }));
    if (url === "/api/finance/commissions") return Promise.resolve(reply({ rows: [], totals: {} }));
    if (url === "/api/accounting") return Promise.resolve(reply({ balances: [], cumulativeBalances: [], to: "2030-01-01", entryCount: 0 }));
    throw new Error(`Unexpected test request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  vi.unstubAllGlobals();
});

for (const mode of modes) {
  describe(`${mode.name}: distinguish unknown shift from confirmed closed`, () => {
    it("does not assert closed or offer a shift mutation while the first request is unresolved", () => {
      const view = render(mode.page);
      expect(fetchMock).toHaveBeenCalledWith(mode.url, { cache: "no-store" });
      expectUnknown(view);
    });

    it("shows confirmed closed and the role-authorized opening control after successful null", async () => {
      render(mode.page);
      request.resolve(reply(mode.payload(false)));
      await settle();
      const view = render(mode.page);
      expect(view.text).toContain("لا توجد وردية مفتوحة");
      expect(view.enabledShiftButtons.map(contents)).toEqual([expect.stringContaining("فتح وردية جديدة")]);
    });

    it("shows the confirmed open shift and preserves expected cash in all currencies", async () => {
      render(mode.page);
      request.resolve(reply(mode.payload(true)));
      await settle();
      const view = render(mode.page);
      expect(view.text).toContain(shift.openedBy);
      expect(view.text).not.toContain("لا توجد وردية مفتوحة");
      expect(view.enabledShiftButtons).toHaveLength(1);
      expect(contents(view.enabledShiftButtons[0])).toMatch(/جرد وإقفال الوردية|إغلاق وجرد الوردية/);
      for (const currency of CURRENCIES) expect(view.text).toContain(formatMoney(expected[currency], currency));
      if (mode.page === FinancePage) {
        expect(view.nodes.find((node) => node.type === CashShiftTab)?.props.expectedInBox).toEqual(expected);
      }
    });

    it.each(["http", "network"] as const)("keeps unknown after initial %s failure", async (failure) => {
      render(mode.page);
      if (failure === "http") request.resolve(reply({ message: "Synthetic unavailable" }, false));
      else request.reject(new Error("Synthetic unavailable"));
      await settle();
      const view = render(mode.page);
      expect.soft(view.text).toContain("Synthetic unavailable");
      expectUnknown(view);
    });

    it.each([false, true])("does not enable shift actions while refreshing previous open=%s", async (open) => {
      render(mode.page);
      request.resolve(reply(mode.payload(open)));
      await settle();
      const ready = render(mode.page);
      expect(ready.enabledShiftButtons).toHaveLength(1);
      request = deferred<Reply>();
      clickButton(ready, "تحديث بيانات الصندوق");
      const pending = render(mode.page);
      expect(pending.enabledShiftButtons).toHaveLength(0);
      expect(pending.nodes.find((node) => node.type === "button" && contents(node) === "تحديث بيانات الصندوق")?.props.disabled).toBe(true);
    });

    it.each([
      [false, "http"], [true, "http"], [false, "network"], [true, "network"],
    ] as const)("does not treat a previous open=%s snapshot as actionable after refresh %s failure", async (open, failure) => {
      render(mode.page);
      request.resolve(reply(mode.payload(open)));
      await settle();
      render(mode.page);
      beginRefresh();
      if (failure === "http") request.resolve(reply({ message: "Synthetic refresh unavailable" }, false));
      else request.reject(new Error("Synthetic refresh unavailable"));
      await settle();
      const view = render(mode.page);
      expect.soft(view.text).toContain("Synthetic refresh unavailable");
      expect(view.enabledShiftButtons).toHaveLength(0);
    });

    it("recovers from an initial failed read with the next successful open snapshot", async () => {
      render(mode.page);
      request.reject(new Error("Synthetic unavailable"));
      await settle();
      render(mode.page);
      beginRefresh();
      request.resolve(reply(mode.payload(true)));
      await settle();
      const view = render(mode.page);
      expect(view.text).not.toContain("Synthetic unavailable");
      expect(view.text).toContain(shift.openedBy);
      expect(view.enabledShiftButtons).toHaveLength(1);
      for (const currency of CURRENCIES) expect(view.text).toContain(formatMoney(expected[currency], currency));
    });

    it("replaces previous open data with a later confirmed closed snapshot", async () => {
      render(mode.page);
      request.resolve(reply(mode.payload(true)));
      await settle();
      render(mode.page);
      beginRefresh();
      request.resolve(reply(mode.payload(false)));
      await settle();
      const view = render(mode.page);
      expect(view.text).toContain("لا توجد وردية مفتوحة");
      expect(view.text).not.toContain(shift.openedBy);
      expect(view.enabledShiftButtons.map(contents)).toEqual([expect.stringContaining("فتح وردية جديدة")]);
      for (const currency of CURRENCIES) expect(view.text).not.toContain(formatMoney(expected[currency], currency));
    });


    it.each(["source", "body"] as const)("ignores an older successful %s completion after a newer failed read", async (phase) => {
      render(mode.page);
      const older = request;
      const olderBody = deferred<unknown>();
      if (phase === "body") {
        older.resolve({ ...reply(null), json: () => olderBody.promise });
        await settle();
      }
      beginRefresh();
      request.reject(new Error("Latest read unavailable"));
      await settle();
      expectUnknown(render(mode.page));
      if (phase === "body") olderBody.resolve(mode.payload(true));
      else older.resolve(reply(mode.payload(true)));
      await settle();
      const view = render(mode.page);
      expectUnknown(view);
      expect(view.text).toContain("Latest read unavailable");
      expect(view.text).not.toContain(shift.openedBy);
      for (const currency of CURRENCIES) expect(view.text).not.toContain(formatMoney(expected[currency], currency));
    });

    it.each(["source", "body"] as const)("ignores an older successful %s completion while the newest read is pending", async (phase) => {
      render(mode.page);
      const older = request;
      const olderBody = deferred<unknown>();
      if (phase === "body") {
        older.resolve({ ...reply(null), json: () => olderBody.promise });
        await settle();
      }
      beginRefresh();
      if (phase === "body") olderBody.resolve(mode.payload(true));
      else older.resolve(reply(mode.payload(true)));
      await settle();
      expectUnknown(render(mode.page));
      request.resolve(reply(mode.payload(false)));
      await settle();
      const view = render(mode.page);
      expect(view.text).toContain("لا توجد وردية مفتوحة");
      expect(view.text).not.toContain(shift.openedBy);
      expect(view.enabledShiftButtons).toHaveLength(1);
    });

    it.each(["source", "body"] as const)("ignores an older failed %s completion after the newest confirmed closed result", async (phase) => {
      render(mode.page);
      const older = request;
      const olderBody = deferred<unknown>();
      if (phase === "body") {
        older.resolve({ ...reply(null), json: () => olderBody.promise });
        await settle();
      }
      beginRefresh();
      request.resolve(reply(mode.payload(false)));
      await settle();
      if (phase === "body") olderBody.reject(new Error("Obsolete error"));
      else older.reject(new Error("Obsolete error"));
      await settle();
      const view = render(mode.page);
      expect(view.text).not.toContain("Obsolete error");
      expect(view.text).toContain("لا توجد وردية مفتوحة");
      expect(view.enabledShiftButtons).toHaveLength(1);
    });

    it.each([null, {}, { open: undefined, openShift: undefined }])("does not treat an incomplete successful response as closed: %j", async (payload) => {
      render(mode.page);
      request.resolve(reply(payload));
      await settle();
      const view = render(mode.page);
      expectUnknown(view);
      expect(view.text).toContain("تعذّر التحقق من حالة الوردية");
      expect(view.nodes.some((node) => node.type === "button" && contents(node) === "إعادة المحاولة" && !node.props.disabled)).toBe(true);
    });

    it("recovers from invalid JSON using the visible read-only retry control", async () => {
      render(mode.page);
      request.resolve({ ...reply(null), json: async () => { throw new Error("Synthetic invalid JSON"); } });
      await settle();
      const failed = render(mode.page);
      expectUnknown(failed);
      expect(failed.text).toContain("Synthetic invalid JSON");
      request = deferred<Reply>();
      const retry = failed.nodes.find((node) => node.type === "button" && contents(node) === "إعادة المحاولة");
      expect(retry?.props.disabled).toBe(false);
      (retry?.props.onClick as () => void)();
      expectUnknown(render(mode.page));
      request.resolve(reply(mode.payload(true)));
      await settle();
      const recovered = render(mode.page);
      expect(recovered.text).not.toContain("Synthetic invalid JSON");
      expect(recovered.text).toContain(shift.openedBy);
      expect(recovered.enabledShiftButtons).toHaveLength(1);
    });

    it.each([false, true])("preserves accountant read-only controls after confirmed open=%s", async (open) => {
      hooks.session.role = "accountant";
      render(mode.page);
      request.resolve(reply(mode.payload(open)));
      await settle();
      expect(render(mode.page).enabledShiftButtons).toHaveLength(0);
    });
  });
}

describe("finance cash tab loading boundary", () => {
  it("does not pass null as a confirmed-closed shift to the cash tab after a failed first read", async () => {
    render(FinancePage);
    request.resolve(reply({ message: "Synthetic unavailable" }, false));
    await settle();
    expect(render(FinancePage).nodes.some((node) => node.type === CashShiftTab)).toBe(false);
  });

  it("preserves cashier operateShift denial even with a confirmed closed shift", async () => {
    hooks.session = { username: "synthetic-admin", role: "cashier", permissions: { financeAccess: { operateShift: false } } };
    render(FinancePage);
    request.resolve(reply(feed(false)));
    await settle();
    const view = render(FinancePage);
    expect(view.enabledShiftButtons).toHaveLength(0);
    expect(view.nodes.find((node) => node.type === CashShiftTab)?.props.canShift).toBe(false);
  });
});


describe("finance stale read presentation and mutation boundaries", () => {
  it.each(["pending", "http", "network"] as const)("withholds visible cash controls and shortcuts after a stale %s read", async (failure) => {
    render(FinancePage);
    request.resolve(reply(feed(true)));
    await settle();
    render(FinancePage);
    beginRefresh();
    if (failure === "http") request.resolve(reply({ message: "Synthetic unavailable" }, false));
    if (failure === "network") request.reject(new Error("Synthetic unavailable"));
    await settle();
    const view = render(FinancePage);
    expect(view.nodes.some((node) => node.type === CashShiftTab)).toBe(false);
    expect(view.nodes.filter((node) => node.type === "button"
      && /سند قبض سريع|سند صرف نثري|تسوية معمل أسنان/.test(contents(node))
      && !node.props.disabled)).toHaveLength(0);
    const cashKpis = view.nodes.find((node) => node.type === "section" && node.props["aria-label"] === "مؤشرات النبض المالي الحي");
    const cashCards = (cashKpis?.props.children as ReactNode[]).filter((child) => child && typeof child === "object").slice(0, 3);
    const cashText = contents(cashCards);
    expect(cashText).not.toContain(formatMoney(feed(true).totals.baseTotalMinor, "YER"));
    expect(cashText).not.toContain(formatMoney(feed(true).expenseTotals.baseTotalMinor, "YER"));
    for (const currency of CURRENCIES) {
      expect(cashText).not.toContain(formatMoney(expected[currency], currency));
      expect(cashText).not.toContain(formatMoney(0, currency));
    }
  });
});


// This walk deliberately includes hidden nodes only for the React lifetime
// contract. Visible-state assertions above omit hidden/inert descendants.
function mountedElements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(mountedElements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  return [node as Element, ...mountedElements((node as Element).props.children as ReactNode)];
}
function cashBoundary(view: ReturnType<typeof render>) {
  return mountedElements(view.tree).find((node) => node.type === "div"
    && (node.props.children as Element | undefined)?.type === CashShiftTab);
}
function cashChild(view: ReturnType<typeof render>) {
  return cashBoundary(view)?.props.children as Element | undefined;
}
function clickButton(view: ReturnType<typeof render>, label: string) {
  const button = view.nodes.find((node) => node.type === "button" && contents(node) === label);
  expect(button).toBeDefined();
  expect(button?.props.disabled).not.toBe(true);
  (button?.props.onClick as () => void)();
}

describe("same-shift draft lifetime and changed-context containment", () => {
  it.each([false, true])("keeps the same mounted cash form identity through refresh/error/retry for open=%s", async (open) => {
    render(FinancePage);
    request.resolve(reply(feed(open)));
    await settle();
    const ready = render(FinancePage);
    const original = cashChild(ready);
    expect(original).toBeDefined();
    expect(cashBoundary(ready)?.props).toMatchObject({ hidden: false, inert: false });
    beginRefresh();
    const pending = render(FinancePage);
    expect(cashChild(pending)?.type).toBe(original?.type);
    expect(cashChild(pending)?.key).toBe(original?.key);
    expect(cashBoundary(pending)?.props).toMatchObject({ hidden: true, inert: true });
    request.reject(new Error("Synthetic retry needed"));
    await settle();
    const failed = render(FinancePage);
    expect(cashChild(failed)?.key).toBe(original?.key);
    expect(cashBoundary(failed)?.props).toMatchObject({ hidden: true, inert: true });
    request = deferred<Reply>();
    clickButton(failed, "إعادة المحاولة");
    request.resolve(reply(feed(open)));
    await settle();
    const recovered = render(FinancePage);
    expect(cashChild(recovered)?.key).toBe(original?.key);
    expect(cashBoundary(recovered)?.props).toMatchObject({ hidden: false, inert: false });
  });

  it("preserves the expense form lifetime when a separate collection success triggers the read", async () => {
    render(FinancePage);
    request.resolve(reply(feed(true)));
    await settle();
    const initial = render(FinancePage);
    const kpis = initial.nodes.find((node) => node.type === FinanceKpis);
    (kpis?.props.onOpenNewExpense as () => void)();
    const spending = render(FinancePage);
    const original = cashChild(spending);
    expect(original?.props.spending).toBe(true);
    const quickCollect = spending.nodes.find((node) => node.type === QuickCollectModal);
    (quickCollect?.props.onSelectPatient as (patient: { id: number; name: string }) => void)({ id: 91, name: "Synthetic patient" });
    const collection = render(FinancePage).nodes.find((node) => node.type === CollectPaymentModal);
    expect(collection).toBeDefined();
    request = deferred<Reply>();
    // Invoke only a mocked success notification; no payment handler or write.
    (collection?.props.onSuccess as (id: number) => void)(91002);
    const pending = render(FinancePage);
    expect(cashChild(pending)?.key).toBe(original?.key);
    expect(cashChild(pending)?.props.spending).toBe(true);
    expect(cashBoundary(pending)?.props).toMatchObject({ hidden: true, inert: true });
    request.resolve(reply(feed(true)));
    await settle();
    const recovered = render(FinancePage);
    expect(cashChild(recovered)?.key).toBe(original?.key);
    expect(cashChild(recovered)?.props.spending).toBe(true);
    expect(cashBoundary(recovered)?.props.hidden).toBe(false);
  });

  it.each(["shift", "principal"] as const)("starts a fresh cash form after a changed %s", async (change) => {
    render(FinancePage);
    request.resolve(reply(feed(true)));
    await settle();
    const initial = render(FinancePage);
    const kpis = initial.nodes.find((node) => node.type === FinanceKpis);
    (kpis?.props.onOpenNewExpense as () => void)();
    (kpis?.props.onOpenCloseShift as () => void)();
    const original = cashChild(render(FinancePage));
    expect(original?.props).toMatchObject({ spending: true, closing: true });
    if (change === "principal") {
      request = deferred<Reply>();
      hooks.session.username = "synthetic-next-admin";
      const pending = render(FinancePage);
      expect(cashChild(pending)).toBeUndefined();
      expectUnknown(pending);
    } else beginRefresh();
    const nextFeed = feed(true);
    if (change === "shift") nextFeed.open = { ...shift, id: shift.id + 1 };
    request.resolve(reply(nextFeed));
    await settle();
    const next = cashChild(render(FinancePage));
    expect(next?.key).not.toBe(original?.key);
    expect(next?.props).toMatchObject({ spending: false, closing: false });
  });

  it("keeps a reconciliation count draft hidden during read failure and restores it only for the same shift", async () => {
    render(ReconciliationPage);
    request.resolve(reply(reconciliation(true)));
    await settle();
    clickButton(render(ReconciliationPage), "جرد وإقفال الوردية");
    const editing = render(ReconciliationPage);
    const input = editing.nodes.find((node) => node.type === "input" && node.props["aria-label"] === "المعدود YER");
    expect(input).toBeDefined();
    (input?.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "12345" } });
    beginRefresh();
    request.reject(new Error("Synthetic read unavailable"));
    await settle();
    const failed = render(ReconciliationPage);
    expect(failed.nodes.some((node) => node.type === "input")).toBe(false);
    request = deferred<Reply>();
    clickButton(failed, "إعادة المحاولة");
    request.resolve(reply(reconciliation(true)));
    await settle();
    const recovered = render(ReconciliationPage);
    expect(recovered.nodes.find((node) => node.type === "input" && node.props["aria-label"] === "المعدود YER")?.props.value).toBe("12345");
  });

  it.each(["shift", "principal"] as const)("dismisses the previous reconciliation draft after a changed %s", async (change) => {
    render(ReconciliationPage);
    request.resolve(reply(reconciliation(true)));
    await settle();
    clickButton(render(ReconciliationPage), "جرد وإقفال الوردية");
    const input = render(ReconciliationPage).nodes.find((node) => node.type === "input" && node.props["aria-label"] === "المعدود YER");
    (input?.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "12345" } });
    if (change === "principal") {
      request = deferred<Reply>();
      hooks.session.username = "synthetic-next-admin";
      expectUnknown(render(ReconciliationPage));
    } else beginRefresh();
    const next = reconciliation(true);
    if (change === "shift" && next.openShift) next.openShift.shift = { ...shift, id: shift.id + 1 };
    request.resolve(reply(next));
    await settle();
    const recovered = render(ReconciliationPage);
    expect(recovered.nodes.some((node) => node.type === "form")).toBe(false);
    expect(recovered.text).not.toContain("12345");
  });
});
