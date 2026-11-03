/** Actual hooks/components with synthetic transport and a commit-aware hook scheduler.
 * Ref access during rendering is rejected: aborted renders cannot acquire/revoke a request. */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLabBalanceOverview } from "../components/finance/useLabBalanceOverview";
import { useLeadershipRead } from "../components/leadership/useLeadershipRead";
import { HrContractsPanel } from "../components/hr/ContractsPanel";
import { HrTasksPanel } from "../components/hr/TasksPanel";
import { projectLabBalanceOverview } from "../lib/lab-balance-overview";

type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
type Frame = { slots: Slot[]; cursor: number; layouts: (() => void)[]; effects: (() => void)[] };
const runtime = vi.hoisted(() => ({ frame: null as Frame | null, rendering: false }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = () => { const f = runtime.frame!; const n = f.cursor++; return f.slots[n] ?? (f.slots[n] = {}); };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, n) => Object.is(v, b[n]));
  const memo = (fn: () => unknown, deps?: readonly unknown[]) => { const s = slot(); if (!same(s.deps, deps)) { s.value = fn(); s.deps = deps; } return s.value; };
  const effect = (layout: boolean) => (fn: () => void | (() => void), deps?: readonly unknown[]) => {
    const s = slot(); if (same(s.deps, deps)) return;
    (layout ? runtime.frame!.layouts : runtime.frame!.effects).push(() => { s.cleanup?.(); s.deps = deps; s.cleanup = fn() || undefined; });
  };
  return { ...react, useContext: () => null,
    useState: (initial: unknown) => { const s = slot(); if (!("value" in s)) s.value = typeof initial === "function" ? initial() : initial;
      return [s.value, (value: unknown) => { s.value = typeof value === "function" ? value(s.value) : value; }]; },
    useRef: (initial: unknown) => { const s = slot(); if (!("value" in s)) s.value = new Proxy({ current: initial }, {
      get: (target, key) => { if (runtime.rendering && key === "current") throw new Error("Ref read during render"); return Reflect.get(target, key); },
      set: (target, key, value) => { if (runtime.rendering && key === "current") throw new Error("Ref write during render"); return Reflect.set(target, key, value); },
    }); return s.value; },
    useMemo: memo, useCallback: (fn: unknown, deps?: readonly unknown[]) => memo(() => fn, deps),
    useEffect: effect(false), useLayoutEffect: effect(true),
  };
});
function LabHarness({ authority }: { authority: string }) { return useLabBalanceOverview(authority); }
function LeadershipHarness({ decode }: { decode: (value: unknown) => string }) { return useLeadershipRead("/synthetic/read", decode); }
vi.mock("../components/hr/HrNavigation", () => ({ useHrNavigation: () => null, useHrStaffSelection: () => ["", () => {}] }));
const frames: Frame[] = [];
const frame = (): Frame => { const f = { slots: [], cursor: 0, layouts: [], effects: [] }; frames.push(f); return f; };
function render<T>(f: Frame, component: () => T): T {
  runtime.frame = f; runtime.rendering = true; f.cursor = 0;
  try { return component(); } finally { runtime.rendering = false; runtime.frame = null; }
}
function commit(f: Frame) { f.layouts.splice(0).forEach(fn => fn()); f.effects.splice(0).forEach(fn => fn()); }
function speculative(f: Frame): Frame { return { slots: f.slots.map(s => ({ ...s })), cursor: 0, layouts: [], effects: [] }; }
const settle = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const overview = () => projectLabBalanceOverview([{ id: 1, name: "Synthetic lab", kind: "lab", currency: "YER", phone: null }], [{ partyId: 1, kind: "lab", currency: "USD", dueMinor: -525 }], "2026-10-31T12:00:00.000Z");
let requests: { resolve: (value: unknown) => void; signal: AbortSignal }[];
beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise(resolve => requests.push({ resolve, signal: init.signal }))));
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { for (const f of frames.splice(0)) for (const s of f.slots) s.cleanup?.(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("an abandoned finance authority render neither reads mutable refs nor revokes the committed request", async () => {
  const f = frame(); const first = render(f, () => LabHarness({ authority: "admin-A" })); commit(f); void first.reload();
  const abandoned = speculative(f);
  expect(render(abandoned, () => LabHarness({ authority: "admin-B" })).state.data).toBeNull();
  expect(requests[0].signal.aborted).toBe(false);
  requests[0].resolve(response(overview())); await settle();
  expect(render(f, () => LabHarness({ authority: "admin-A" })).state.phase).toBe("ready");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("committed finance A → B → A rejects old completions and stale reload callbacks", async () => {
  const f = frame(); const oldA = render(f, () => LabHarness({ authority: "A" })); commit(f); void oldA.reload();
  const b = render(f, () => LabHarness({ authority: "B" })); expect(b.state.data).toBeNull(); commit(f); void b.reload();
  const nextA = render(f, () => LabHarness({ authority: "A" })); expect(nextA.state.data).toBeNull(); commit(f); void nextA.reload();
  await oldA.reload(); await b.reload(); expect(fetch).toHaveBeenCalledTimes(3);
  expect(requests.slice(0, 2).every(r => r.signal.aborted)).toBe(true);
  requests[0].resolve(response(overview())); requests[1].resolve(response(overview())); await settle();
  expect(render(f, () => LabHarness({ authority: "A" })).state.data).toBeNull();
  requests[2].resolve(response(overview())); await settle();
  expect(render(f, () => LabHarness({ authority: "A" })).state.phase).toBe("ready");
});

it("leadership response uses the latest committed decoder, never an abandoned render's decoder", async () => {
  const f = frame(); let decode = (value: unknown) => `A:${value}`;
  render(f, () => LeadershipHarness({ decode })); commit(f);
  render(speculative(f), () => LeadershipHarness({ decode: () => "abandoned" }));
  requests[0].resolve(response("first")); await settle();
  expect(render(f, () => LeadershipHarness({ decode })).data).toBe("A:first"); commit(f);
  const read = render(f, () => LeadershipHarness({ decode })); read.refresh();
  render(f, () => LeadershipHarness({ decode })); commit(f);
  decode = (value: unknown) => `B:${value}`;
  render(f, () => LeadershipHarness({ decode })); commit(f);
  expect(fetch).toHaveBeenCalledTimes(2);
  requests[1].resolve(response("second")); await settle();
  expect(render(f, () => LeadershipHarness({ decode })).data).toBe("B:second");
});

type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== "object" || !("props" in node)) return []; const e = node as Element; return [e, ...nodes(e.props.children as ReactNode)]; }
function text(node: ReactNode): string { return typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join(" ") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : ""; }
it("task reads bind to committed query identity and discard a superseded response", async () => {
  const outer = frame(); const element = render(outer, () => HrTasksPanel({ session: { username: "synthetic", role: "admin" } })); commit(outer);
  const owner = element.type as (props: typeof element.props) => ReactNode;
  const f = frame(); const draw = () => render(f, () => owner(element.props));
  draw(); commit(f); expect(fetch).toHaveBeenCalledTimes(1);
  const search = nodes(draw()).find(e => e.type === "input" && e.props.type === "search") ?? nodes(draw()).find(e => e.type === "input" && String(e.props.placeholder).includes("بحث"));
  expect(search).toBeDefined(); (search!.props.onChange as (e: unknown) => void)({ target: { value: "new" } });
  draw(); commit(f); expect(fetch).toHaveBeenCalledTimes(2);
  const payload = (title: string) => ({ counts: { planned: 1, in_progress: 0, blocked: 0, completed: 0, cancelled: 0 }, overdueCount: 0,
    tasks: [{ id: 1, title, status: "planned", priority: "normal", isPrivate: false, dueAt: null, plannedFor: null, overdue: false, assigneeLabel: "Synthetic", ownerDisplayName: "Synthetic" }] });
  requests[1].resolve(response(payload("Current synthetic task"))); await settle();
  expect(text(draw())).toContain("Current synthetic task");
  requests[0].resolve(response(payload("Superseded synthetic task"))); await settle();
  expect(text(draw())).not.toContain("Superseded synthetic task");
  expect(text(draw())).toContain("Current synthetic task");
});


it("contract expiry is a committed clock observation, stable during render and refreshed on timer/focus", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  const listeners = new Map<string, () => void>();
  vi.stubGlobal("window", { addEventListener: (event: string, fn: () => void) => listeners.set(event, fn), removeEventListener: (event: string) => listeners.delete(event) });
  const contract = { id: 1, contractNumber: "SYNTHETIC", title: "Synthetic contract", staffId: 1, staffName: "Synthetic staff", templateKind: "employment", status: "active", startDate: "2026-09-01", endDate: "2026-11-01", baseSalaryMinor: null, salaryCurrency: null, commissionRatePercent: null };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url.startsWith("/api/hr/contracts?") ? [contract] : [])));
  const admission = { owner: "synthetic", admin: true, contractsVisible: true };
  const props = { session: { username: "synthetic", role: "admin" } as const, pendingSave: undefined, saveAdmission: admission,
    mountSaveAdmission: () => ({ view: admission, canAdmit: () => true, detach: () => {} }), onReserveSave: () => false, onSettleSave: () => false };
  const f = frame(); const draw = () => render(f, () => HrContractsPanel(props));
  const now = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => { if (runtime.rendering) throw new Error("Impure render clock read"); return now(); });
  draw(); commit(f); await settle();
  expect(text(draw())).not.toContain("يقترب الانتهاء");
  vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
  expect(text(draw())).not.toContain("يقترب الانتهاء");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(text(draw())).toContain("يقترب الانتهاء");
  vi.setSystemTime(new Date("2026-11-02T00:00:00Z")); listeners.get("focus")!();
  expect(text(draw())).not.toContain("يقترب الانتهاء");
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(["/api/parties?kind=doctor", "/api/hr/contracts?", "/api/hr/staff"]);
  for (const slot of f.slots) { slot.cleanup?.(); slot.cleanup = undefined; }
  expect(listeners.has("focus")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
