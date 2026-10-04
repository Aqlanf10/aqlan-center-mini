/** Actual finance page and actual lab reader hook, synthetic React/GET boundaries.
 * No DOM, real HTTP, DB or writer is invoked. */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FinancePage from "../app/finance/page";
import { FinanceKpis } from "../components/finance/FinanceKpis";
import { ReceivablesLabsTab } from "../components/finance/ReceivablesLabsTab";
import type { SessionInfo } from "../components/SessionProvider";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../lib/doctor-permissions";
import { projectLabBalanceOverview, type LabBalanceReadState } from "../lib/lab-balance-overview";

type Hooks = { values: unknown[]; cursor: number; changed: boolean; mounted: boolean; lateUpdates: number;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void; layout: boolean }>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>; pending: Array<() => void>; layout: Array<() => void> };
const runtime = vi.hoisted(() => ({ current: null as Hooks | null, session: null as SessionInfo | null }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const current = () => { if (!runtime.current) throw new Error("Missing synthetic owner"); return runtime.current; };
  const slot = (hooks: Hooks, initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => { const hooks = current(); const index = slot(hooks, undefined); const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = compute(); hooks.memos.set(index, { deps, value }); return value; };
  const effect = (layout: boolean) => (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const hooks = current(); const index = slot(hooks, undefined); const previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    (layout ? hooks.layout : hooks.pending).push(() => { previous?.cleanup?.(); if (previous) previous.cleanup = undefined;
      const cleanup = run(); hooks.effects.set(index, { deps, layout, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => { const hooks = current(); const index = slot(hooks, typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => { if (!hooks.mounted) hooks.lateUpdates++;
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next; }]; },
    useRef: (initial: unknown) => { const hooks = current(); return hooks.values[slot(hooks, { current: initial })]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect(false), useLayoutEffect: effect(true),
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => runtime.session }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic", useSetting: () => "" }));
vi.mock("../components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("../components/financeLinks", () => ({ financeLinks: () => [] }));
vi.mock("../components/FinanceNavigation", () => ({ FinanceNavigation: () => null }));
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("../components/LabReconciliationModal", () => ({ LabReconciliationModal: () => null }));
vi.mock("../components/CaseProfitabilityModal", () => ({ CaseProfitabilityModal: () => null }));
vi.mock("../components/finance/QuickCollectModal", () => ({ QuickCollectModal: () => null }));
vi.mock("../components/finance/CashShiftTab", () => ({ CashShiftTab: () => null }));
vi.mock("../components/finance/CommissionsProfitabilityTab", () => ({ CommissionsProfitabilityTab: () => null }));
vi.mock("../components/finance/AccountingReportsTab", () => ({ AccountingReportsTab: () => null }));
vi.mock("../lib/reminders", () => ({ friendlyDateLong: (date: string) => date, toWhatsAppNumber: () => "" }));
vi.mock("../lib/schedule", () => ({ clinicDateString: () => "2026-10-03" }));

type Element = ReactElement<Record<string, unknown>>;
let hooks: Hooks;
function unmount() { hooks.effects.forEach((effect) => { effect.cleanup?.(); effect.cleanup = undefined; }); hooks.mounted = false; }
function resetOwner() { hooks = { values: [], cursor: 0, changed: false, mounted: true, lateUpdates: 0, effects: new Map(), memos: new Map(), pending: [], layout: [] }; }
function render(flushPassive = true): ReactNode {
  let tree: ReactNode; let rounds = 0;
  do {
    if (++rounds > 25) throw new Error("Synthetic page did not settle");
    hooks.cursor = 0; hooks.changed = false; runtime.current = hooks;
    tree = FinancePage(); runtime.current = null;
    hooks.layout.splice(0).forEach((effect) => effect());
    if (flushPassive) hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const node = tree as Element; return [node, ...nodes(node.props.children as ReactNode)];
}
function kpis() { const node = nodes(render()).find((item) => item.type === FinanceKpis); if (!node) throw new Error("Missing actual KPI props"); return node.props; }
function labs() {
  (kpis().onTabChange as (tab: string) => void)("receivables");
  const node = nodes(render()).find((item) => item.type === ReceivablesLabsTab); if (!node) throw new Error("Missing actual lab props"); return node.props;
}
const state = () => kpis().labBalanceState as LabBalanceReadState;
const refresh = () => (labs().onReloadLabBalances as () => void)();
const response = (payload: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const overview = (minor = -525) => projectLabBalanceOverview([
  { id: 1, name: "Canonical lab", kind: "lab", currency: "YER", phone: null },
], [{ partyId: 1, kind: "lab", currency: "USD", dueMinor: minor }], "2026-10-03T12:00:00.000Z");
const balanceUrl = "/api/finance/lab-reconciliation?view=lab-balances-v1";
const fetchMock = vi.fn(); let getBalances: () => unknown;
const balances = () => fetchMock.mock.calls.filter(([url]) => url === balanceUrl);
async function settle() { for (let i = 0; i < 70; i++) await Promise.resolve(); }
async function ready() { render(); await settle(); render(); await settle(); render(); }
beforeEach(() => {
  resetOwner(); runtime.session = { username: "admin-A", role: "admin" };
  fetchMock.mockReset(); getBalances = () => response(overview());
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") throw new Error("Unexpected mutation");
    if (url === balanceUrl) return Promise.resolve(getBalances());
    if (url === "/api/shifts") return Promise.resolve(response({ open: null, totals: { byCurrency: { YER: 0, SAR: 0, USD: 0 }, baseTotalMinor: 0, paymentCount: 0 },
      expenseTotals: { byCurrency: { YER: 0, SAR: 0, USD: 0 }, byCategory: {}, baseTotalMinor: 0, count: 0 }, payments: [], expenses: [], recent: [] }));
    if (url === "/api/parties") return Promise.resolve(response([]));
    if (url === "/api/finance/debts") return Promise.resolve(response({ rows: [] }));
    if (url === "/api/plans") return Promise.resolve(response({ plans: [] }));
    if (url === "/api/finance/lab-reconciliation") return Promise.resolve(response({ labs: [
      { partyId: 1, partyName: "Clinical lab", currency: "YER", phone: null, activeOrdersCount: 13, unsettledOrdersCount: 28, unsettledCostMinor: 999999999 },
    ], risks: [], totalRisksCount: 0 }));
    if (url === "/api/finance/commissions") return Promise.resolve(response({ rows: [], totals: {} }));
    if (url === "/api/accounting") return Promise.resolve(response({ balances: [], cumulativeBalances: [], to: "2026-10-03", entryCount: 0 }));
    throw new Error(`Unexpected read ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => { unmount(); await settle(); expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true); vi.unstubAllGlobals(); });

describe("actual finance page canonical lab read lifecycle", () => {
  it("passes the independent canonical ready state atomically to KPI and tab, ignoring legacy cost scalars", async () => {
    await ready(); expect(state()).toEqual({ phase: "ready", data: overview() });
    expect(labs().labBalanceState).toEqual(state()); expect(kpis()).not.toHaveProperty("totalLabPayablesMinor");
    expect(kpis()).not.toHaveProperty("unsettledLabOrdersCount");
    expect(balances()).toHaveLength(1);
    expect(balances()[0][1]).toMatchObject({ cache: "no-store", signal: expect.any(AbortSignal) });
  });
  it.each([401, 403, 500, 503])("treats HTTP %s as unavailable, then recovers from explicit refresh", async (status) => {
    getBalances = () => response({}, status); await ready(); expect(state()).toEqual({ phase: "error", data: null });
    getBalances = () => response(overview(10)); refresh(); expect(state()).toEqual({ phase: "loading", data: null });
    await ready(); expect(state()).toEqual({ phase: "ready", data: overview(10) });
  });
  it.each(["network", "json", "shape", "missing-buckets"])("does not invent zero for %s failure", async (failure) => {
    getBalances = () => failure === "network" ? Promise.reject(new Error("Synthetic network"))
      : failure === "json" ? { ok: true, json: async () => { throw new Error("Synthetic JSON"); } }
      : failure === "shape" ? response({ labs: [] })
      : response({ ...overview(), labs: [{ ...overview().labs[0], partyNetBalance: undefined }] });
    await ready(); expect(state()).toEqual({ phase: "error", data: null });
    expect(labs().labBalanceState).toEqual({ phase: "error", data: null });
  });
  it("withdraws a ready snapshot immediately when a fresh read fails", async () => {
    await ready(); getBalances = () => response({}, 503); refresh();
    expect(state()).toEqual({ phase: "loading", data: null });
    await ready(); expect(state()).toEqual({ phase: "error", data: null });
  });
  it("ignores stale response and delayed JSON from superseded refresh generations", async () => {
    await ready(); const delayed = deferred<ReturnType<typeof response>>(); getBalances = () => delayed.promise;
    refresh(); const oldSignal = balances().at(-1)![1].signal as AbortSignal;
    getBalances = () => response(overview(111)); refresh(); await ready();
    expect(oldSignal.aborted).toBe(true); delayed.resolve(response(overview(999))); await ready();
    expect(state()).toEqual({ phase: "ready", data: overview(111) });
    const delayedJson = deferred<unknown>(); getBalances = () => ({ ok: true, json: () => delayedJson.promise });
    refresh(); await settle(); getBalances = () => response(overview(222)); refresh(); await ready();
    delayedJson.resolve(overview(888)); await ready(); expect(state()).toEqual({ phase: "ready", data: overview(222) });
  });
  it("retires principal A → B → A instead of reusing an earlier A request or money", async () => {
    const oldA = deferred<ReturnType<typeof response>>(); getBalances = () => oldA.promise; await ready();
    const firstSignal = balances()[0][1].signal as AbortSignal;
    runtime.session = { username: "admin-B", role: "admin" }; getBalances = () => response(overview(50)); await ready();
    expect(state()).toEqual({ phase: "ready", data: overview(50) }); expect(firstSignal.aborted).toBe(true);
    const newA = deferred<ReturnType<typeof response>>(); getBalances = () => newA.promise;
    runtime.session = { username: "admin-A", role: "admin" }; render(); expect(state()).toEqual({ phase: "loading", data: null });
    oldA.resolve(response(overview(999))); await ready(); expect(state()).toEqual({ phase: "loading", data: null });
    newA.resolve(response(overview(75))); await ready(); expect(state()).toEqual({ phase: "ready", data: overview(75) });
  });
  it("invalidates ready money on a same-user permission change before new passive effects", async () => {
    await ready(); const pending = deferred<ReturnType<typeof response>>(); getBalances = () => pending.promise;
    runtime.session = { username: "admin-A", role: "admin", permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewCostPrices: false } };
    const immediate = nodes(render(false)).find((node) => node.type === FinanceKpis)!.props.labBalanceState;
    expect(immediate).toEqual({ phase: "loading", data: null });
    // Commit the already queued passive effects before another synthetic render.
    hooks.pending.splice(0).forEach((effect) => effect());
    await ready(); expect(balances()).toHaveLength(2); pending.resolve(response(overview(35))); await ready(); expect(state()).toEqual({ phase: "ready", data: overview(35) });
  });
  it.each(["doctor", "reception", "accountant", "cashier", "assistant", "logout"])("does not fetch privileged lab balances for %s, or retain them after downgrade", async (role) => {
    await ready(); runtime.session = role === "logout" ? null : { username: "restricted", role, permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewCostPrices: true } };
    render(); await ready(); expect(state()).toEqual({ phase: "unavailable", data: null }); expect(balances()).toHaveLength(1);
    expect(labs().labBalanceState).toEqual({ phase: "unavailable", data: null });
  });
  it("aborts and ignores a late canonical completion after page unmount", async () => {
    const late = deferred<ReturnType<typeof response>>(); getBalances = () => late.promise; await ready();
    const signal = balances()[0][1].signal as AbortSignal; unmount(); const previous = hooks.lateUpdates;
    late.resolve(response(overview(999))); await settle(); expect(signal.aborted).toBe(true); expect(hooks.lateUpdates).toBe(previous);
  });
  it("admits explicit verified zero without treating absence as zero", async () => {
    const zero = { ...overview(), labs: [{ ...overview().labs[0], partyNetBalance: { state: "ready", scope: "whole_party", byCurrency: [] } }] };
    getBalances = () => response(zero); await ready(); expect(state()).toEqual({ phase: "ready", data: zero });
  });
});
