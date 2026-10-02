import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FinancePage from "../app/finance/page";
import { FinanceKpis } from "../components/finance/FinanceKpis";
import { AccountingReportsTab } from "../components/finance/AccountingReportsTab";
import type { Role } from "../lib/roles";

// Real FinancePage loading/state/props with mocked hooks and GET responses.
// No browser, server, database, financial write, or live request is invoked.
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
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
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
vi.mock("../components/finance/FinanceKpis", () => ({ FinanceKpis: () => null }));
vi.mock("../components/finance/CashShiftTab", () => ({ CashShiftTab: () => null }));
vi.mock("../components/finance/ReceivablesLabsTab", () => ({ ReceivablesLabsTab: () => null }));
vi.mock("../components/finance/CommissionsProfitabilityTab", () => ({ CommissionsProfitabilityTab: () => null }));
vi.mock("../components/finance/AccountingReportsTab", () => ({ AccountingReportsTab: () => null }));
vi.mock("../components/finance/ShiftCloseStatus", () => ({ ShiftCloseStatus: () => null }));
vi.mock("../lib/reminders", () => ({ friendlyDateLong: (date: string) => date }));
vi.mock("../lib/schedule", () => ({ clinicDateString: () => "2030-01-01" }));


type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function render() {
  let tree: ReactNode = null;
  let rounds = 0;
  do {
    if (++rounds > 10) throw new Error("Hook render did not settle");
    hooks.cursor = 0; hooks.changed = false;
    tree = FinancePage();
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return elements(tree);
}
const period = [{ code: "1101", currency: "YER", kind: "asset", debitMinor: 0, creditMinor: 2000 }];
const cumulative = [{ code: "1101", currency: "YER", kind: "asset", debitMinor: 10000, creditMinor: 2000 },
  { code: "1102", currency: "SAR", kind: "asset", debitMinor: 50000, creditMinor: 0 }];
const fetchMock = vi.fn();
const accountingPayload = () => ({ balances: period, cumulativeBalances: cumulative, to: "2026-10-02", entryCount: 1 });
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
let accountingReply: () => Promise<ReturnType<typeof response>>;
let shiftReply: () => Promise<ReturnType<typeof response>>;
const cashPayload = (openedBy = "Synthetic cashier") => ({
  open: { id: 91001, status: "open", openedBy, opening: { YER: 0, SAR: 0, USD: 0 } },
  totals: { byCurrency: { YER: 0, SAR: 0, USD: 0 }, baseTotalMinor: 0, paymentCount: 0 },
  expenseTotals: { byCurrency: { YER: 0, SAR: 0, USD: 0 }, baseTotalMinor: 0, count: 0 },
  drawer: { expected: { YER: 12500, SAR: 1200, USD: -125 } }, expenses: [], payments: [], recent: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
function accountingProps() {
  const nodes = render();
  const kpis = nodes.find((element) => element.type === FinanceKpis)!;
  (kpis.props.onTabChange as (value: string) => void)("accounting");
  return render().find((element) => element.type === AccountingReportsTab)!.props;
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.memo.clear(); hooks.effects.clear(); hooks.pending = [];
  fetchMock.mockReset();
  hooks.session = { username: "synthetic-admin", role: "admin", permissions: { financeAccess: {} } };
  shiftReply = async () => response(cashPayload());
  accountingReply = async () => response(accountingPayload());
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") throw new Error(`Forbidden test write: ${init.method} ${url}`);
    if (url === "/api/accounting") return accountingReply();
    if (url === "/api/shifts") return shiftReply();
    const payloads: Record<string, unknown> = {
      "/api/shifts": { open: null, totals: { byCurrency: { YER: 0, SAR: 0, USD: 0 } }, expenses: [], payments: [], recent: [] },
      "/api/parties": [], "/api/finance/debts": { rows: [] }, "/api/plans": { plans: [] },
      "/api/finance/lab-reconciliation": { labs: [], risks: [], totalRisksCount: 0 },
      "/api/finance/commissions": { rows: [], totals: {} },
    };
    if (!(url in payloads)) throw new Error(`Unexpected test GET: ${url}`);
    return { ok: true, status: 200, json: async () => payloads[url] };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  vi.unstubAllGlobals();
});

describe("finance page accounting projection plumbing", () => {
  it("retains and passes distinct period and cumulative balances plus the as-of date", async () => {
    render();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const kpis = render().find((element) => element.type === FinanceKpis)!;
    (kpis.props.onTabChange as (value: string) => void)("accounting");
    const reports = render().find((element) => element.type === AccountingReportsTab)!;
    expect(reports).toBeDefined();
    expect(reports.props.readState).toBe("ready");
    expect(reports.props.error).toBeNull();
    expect(reports.props.balances).toBe(period);
    expect(reports.props.cumulativeBalances).toBe(cumulative);
    expect(reports.props.throughDate).toBe("2026-10-02");
    expect(reports.props.entryCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/accounting", { cache: "no-store" });
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
});


describe("finance accounting read failure and recovery", () => {
  it.each([409, 500])("reports HTTP %s failure instead of successful empty history", async (status) => {
    accountingReply = async () => response({ message: "Synthetic accounting unavailable" }, status);
    render(); await settle();
    const props = accountingProps();
    expect(props.readState).toBe("error");
    expect(props.error).toBe("Synthetic accounting unavailable");
    expect(props.cumulativeBalances).toEqual([]);
    expect(props.entryCount).toBe(0);
  });

  it("reports rejected reads and malformed responses without presenting zero balances", async () => {
    accountingReply = async () => { throw new Error("Synthetic network failure"); };
    render(); await settle();
    expect(accountingProps().readState).toBe("error");
    accountingReply = async () => response({ balances: [], entryCount: 0 });
    (accountingProps().onRetry as () => void)(); await settle();
    expect(accountingProps().readState).toBe("error");
  });

  it("clears previous balances during refresh and failure, then recovers through read-only reload", async () => {
    render(); await settle();
    expect(accountingProps().readState).toBe("ready");
    const pending = deferred<ReturnType<typeof response>>();
    accountingReply = () => pending.promise;
    (accountingProps().onRetry as () => void)();
    let props = accountingProps();
    expect(props.readState).toBe("loading");
    expect(props.balances).toEqual([]);
    expect(props.cumulativeBalances).toEqual([]);
    pending.resolve(response({ message: "Synthetic integrity conflict" }, 409)); await settle();
    props = accountingProps();
    expect(props.readState).toBe("error");
    expect(props.error).toBe("Synthetic integrity conflict");
    expect(props.cumulativeBalances).toEqual([]);
    accountingReply = async () => response(accountingPayload());
    (props.onRetry as () => void)(); await settle();
    props = accountingProps();
    expect(props.readState).toBe("ready");
    expect(props.error).toBeNull();
    expect(props.cumulativeBalances).toBe(cumulative);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("treats only a successful complete empty response as empty history", async () => {
    accountingReply = async () => response({ balances: [], cumulativeBalances: [], to: "2026-10-02", entryCount: 0 });
    render(); await settle();
    expect(accountingProps()).toMatchObject({ readState: "ready", balances: [], cumulativeBalances: [], error: null, entryCount: 0 });
  });

  it("ignores an older failed accounting response after a newer successful read", async () => {
    render(); await settle();
    const older = deferred<ReturnType<typeof response>>();
    accountingReply = () => older.promise;
    (accountingProps().onRetry as () => void)();
    const newer = deferred<ReturnType<typeof response>>();
    accountingReply = () => newer.promise;
    (accountingProps().onRetry as () => void)();
    newer.resolve(response(accountingPayload())); await settle();
    expect(accountingProps().readState).toBe("ready");
    older.resolve(response({ message: "Stale failure" }, 409)); await settle();
    expect(accountingProps()).toMatchObject({ readState: "ready", error: null, cumulativeBalances: cumulative });
  });
});


function cashProps() {
  return render().find((element) => element.type === FinanceKpis)!.props;
}

describe("cash and accounting share a generation without sharing read status", () => {
  it("keeps both domains non-actionable while an unrelated fetch response is still pending", async () => {
    const pendingParties = deferred<ReturnType<typeof response>>();
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      url === "/api/parties" ? pendingParties.promise : originalFetch(url, init));
    render(); await settle();
    expect(cashProps().shiftReadState).toBe("loading");
    expect(accountingProps()).toMatchObject({ readState: "loading", balances: [], cumulativeBalances: [] });
    pendingParties.resolve(response([])); await settle();
    expect(cashProps().shiftReadState).toBe("ready");
    expect(accountingProps()).toMatchObject({ readState: "ready", cumulativeBalances: cumulative });
  });

  it("lets cash error recovery supersede a generation with a still-pending accounting body", async () => {
    const oldAccounting = deferred<unknown>();
    accountingReply = async () => ({ ...response(null), json: () => oldAccounting.promise });
    shiftReply = async () => response({ message: "Synthetic cash failure" }, 503);
    render(); await settle();
    expect(cashProps().shiftReadState).toBe("error");
    const retry = render().find((node) => node.type === "button" && node.props.children === "إعادة المحاولة");
    expect(retry).toBeDefined();
    expect(retry?.props.disabled).toBe(false);
    const newest = [{ ...cumulative[0], debitMinor: 97531 }];
    accountingReply = async () => response({ ...accountingPayload(), cumulativeBalances: newest });
    shiftReply = async () => response(cashPayload("Recovered cashier"));
    (retry?.props.onClick as () => void)(); await settle();
    expect(cashProps()).toMatchObject({ shiftReadState: "ready", openedBy: "Recovered cashier" });
    expect(accountingProps()).toMatchObject({ readState: "ready", cumulativeBalances: newest });
    oldAccounting.resolve(accountingPayload()); await settle();
    expect(accountingProps()).toMatchObject({ readState: "ready", cumulativeBalances: newest });
  });

  it.each(["loading", "ready", "error"] as const)("renders first-load accounting %s independently of a pending cash body", async (state) => {
    const cashBody = deferred<unknown>();
    const accountingBody = deferred<unknown>();
    shiftReply = async () => ({ ...response(null), json: () => cashBody.promise });
    if (state === "loading") accountingReply = async () => ({ ...response(null), json: () => accountingBody.promise });
    else if (state === "error") accountingReply = async () => response({ message: "Synthetic first accounting failure" }, 409);
    render(); await settle();
    const props = accountingProps();
    expect(props.readState).toBe(state);
    expect(props.cumulativeBalances).toEqual(state === "ready" ? cumulative : []);
    if (state === "error") expect(props.error).toBe("Synthetic first accounting failure");
    expect(cashProps().shiftReadState).toBe("loading");
    cashBody.resolve(cashPayload());
    accountingBody.resolve(accountingPayload());
    await settle();
  });

  it.each([
    ["cash", "http"], ["cash", "network"], ["cash", "malformed"],
    ["accounting", "http"], ["accounting", "network"], ["accounting", "malformed"],
  ] as const)("keeps the other read ready when %s has a %s failure", async (domain, failure) => {
    const failed = async () => {
      if (failure === "network") throw new Error("Synthetic domain unavailable");
      return failure === "http" ? response({ message: "Synthetic domain unavailable" }, 409) : response({});
    };
    if (domain === "cash") shiftReply = failed;
    else accountingReply = failed;
    render(); await settle();
    expect(cashProps().shiftReadState).toBe(domain === "cash" ? "error" : "ready");
    const reports = accountingProps();
    expect(reports.readState).toBe(domain === "accounting" ? "error" : "ready");
    expect(reports.cumulativeBalances).toEqual(domain === "accounting" ? [] : cumulative);
  });

  it.each(["cash", "accounting"] as const)("does not let a pending %s JSON body block the other current read", async (domain) => {
    render(); await settle();
    const body = deferred<unknown>();
    const pendingBody = async () => ({ ...response(null), json: () => body.promise });
    if (domain === "cash") shiftReply = pendingBody;
    else accountingReply = pendingBody;
    (accountingProps().onRetry as () => void)(); await settle();
    expect(cashProps().shiftReadState).toBe(domain === "cash" ? "loading" : "ready");
    expect(accountingProps().readState).toBe(domain === "accounting" ? "loading" : "ready");
    if (domain === "accounting") expect(accountingProps().cumulativeBalances).toEqual([]);
    body.reject(new Error("Synthetic JSON body failure")); await settle();
    expect(cashProps().shiftReadState).toBe(domain === "cash" ? "error" : "ready");
    expect(accountingProps().readState).toBe(domain === "accounting" ? "error" : "ready");
  });

  it.each([
    ["cash", false], ["cash", true], ["accounting", false], ["accounting", true],
  ] as const)("ignores an old %s JSON completion after a newer ready result, failure=%s", async (domain, failure) => {
    render(); await settle();
    const oldBody = deferred<unknown>();
    const pendingBody = async () => ({ ...response(null), json: () => oldBody.promise });
    if (domain === "cash") shiftReply = pendingBody;
    else accountingReply = pendingBody;
    (accountingProps().onRetry as () => void)(); await settle();
    const newestCumulative = [{ ...cumulative[0], debitMinor: 97531 }];
    shiftReply = async () => response(cashPayload("Newest cashier"));
    accountingReply = async () => response({ ...accountingPayload(), cumulativeBalances: newestCumulative });
    (accountingProps().onRetry as () => void)(); await settle();
    expect(cashProps()).toMatchObject({ shiftReadState: "ready", openedBy: "Newest cashier" });
    expect(accountingProps()).toMatchObject({ readState: "ready", error: null, cumulativeBalances: newestCumulative });
    if (failure) oldBody.reject(new Error("Obsolete body failure"));
    else oldBody.resolve(domain === "cash" ? cashPayload("Obsolete cashier") : accountingPayload());
    await settle();
    expect(cashProps()).toMatchObject({ shiftReadState: "ready", openedBy: "Newest cashier" });
    expect(accountingProps()).toMatchObject({ readState: "ready", error: null, cumulativeBalances: newestCumulative });
  });

  it("withholds both domains on principal change and ignores old-principal accounting body completion", async () => {
    render(); await settle();
    const oldBody = deferred<unknown>();
    accountingReply = async () => ({ ...response(null), json: () => oldBody.promise });
    (accountingProps().onRetry as () => void)(); await settle();
    const nextAccounting = deferred<ReturnType<typeof response>>();
    const nextShift = deferred<ReturnType<typeof response>>();
    accountingReply = () => nextAccounting.promise;
    shiftReply = () => nextShift.promise;
    hooks.session.username = "synthetic-next-admin";
    expect(cashProps().shiftReadState).toBe("loading");
    expect(accountingProps()).toMatchObject({ readState: "loading", balances: [], cumulativeBalances: [] });
    nextAccounting.resolve(response({ ...accountingPayload(), cumulativeBalances: [] }));
    nextShift.resolve(response(cashPayload("New principal cashier"))); await settle();
    oldBody.resolve(accountingPayload()); await settle();
    expect(cashProps()).toMatchObject({ shiftReadState: "ready", openedBy: "New principal cashier" });
    expect(accountingProps()).toMatchObject({ readState: "ready", error: null, cumulativeBalances: [] });
  });
});

describe("accounting access revocation", () => {
  it("ignores a late accounting body when the same accountant loses report access", async () => {
    hooks.session = { username: "synthetic-accountant", role: "accountant", permissions: { financeAccess: { viewReports: true } } };
    render(); await settle();
    expect(accountingProps().readState).toBe("ready");
    const oldBody = deferred<unknown>();
    accountingReply = async () => ({ ...response(null), json: () => oldBody.promise });
    (accountingProps().onRetry as () => void)(); await settle();
    const readsBefore = fetchMock.mock.calls.filter(([url]) => url === "/api/accounting").length;
    hooks.session.permissions.financeAccess.viewReports = false;
    expect(accountingProps()).toMatchObject({ isAdmin: false, readState: "loading", balances: [], cumulativeBalances: [] });
    oldBody.resolve(accountingPayload()); await settle();
    expect(accountingProps()).toMatchObject({ isAdmin: false, readState: "loading", balances: [], cumulativeBalances: [] });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/accounting")).toHaveLength(readsBefore);
  });

  it("clears retained figures and makes no accounting GET when existing viewReports access is removed", async () => {
    render(); await settle();
    expect(accountingProps()).toMatchObject({ readState: "ready", cumulativeBalances: cumulative, isAdmin: true });
    const readsBefore = fetchMock.mock.calls.filter(([url]) => url === "/api/accounting").length;
    hooks.session = { username: "synthetic-admin", role: "accountant", permissions: { financeAccess: { viewReports: false } } };
    let props = accountingProps();
    expect(props.isAdmin).toBe(false);
    expect(props.readState).not.toBe("ready");
    expect(props.cumulativeBalances).toEqual([]);
    await settle();
    props = accountingProps();
    expect(props.isAdmin).toBe(false);
    expect(props.balances).toEqual([]);
    expect(props.cumulativeBalances).toEqual([]);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/accounting")).toHaveLength(readsBefore);
  });
});


// Disabled optional features use empty204 placeholders rather than fetched
// JSON. No real request, financial handler, or database is invoked.
describe("optional finance feeds omitted by existing permissions", () => {
  it.each(["accountant", "cashier"] as const)("does not show a JSON parse failure when %s optional feeds are skipped", async (role) => {
    hooks.session = {
      username: `synthetic-${role}`, role,
      permissions: { financeAccess: { viewReports: role === "accountant", viewCommissions: false } },
    };
    render(); await settle();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/finance/lab-reconciliation")).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/finance/commissions")).toHaveLength(0);
    expect(cashProps().shiftReadState).toBe("ready");
    if (role === "accountant") expect(accountingProps().readState).toBe("ready");
    const alerts = render().filter((node) => node.props.role === "alert");
    const messages = alerts.map((alert) => {
      const child = alert.props.children as Element | string;
      return typeof child === "string" ? child : child?.props.children;
    });
    expect(messages).toEqual([]);
  });
});
