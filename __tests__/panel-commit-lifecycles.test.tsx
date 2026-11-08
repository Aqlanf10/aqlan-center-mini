import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsentModal } from "../components/ConsentModal";
import { HrContractsPanel } from "../components/hr/ContractsPanel";
import { HrTasksPanel } from "../components/hr/TasksPanel";

type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
type Frame = { slots: Slot[]; cursor: number; pending: (() => void)[]; dirty: boolean };
const runtime = vi.hoisted(() => ({ frame: null as Frame | null }));
// Hook-level commit/discard model, not ReactDOM concurrent-render proof. Ref
// objects are shared by committed/speculative frames; effects run only on commit.
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const next = () => { const f = runtime.frame!; const i = f.cursor++; return f.slots[i] ?? (f.slots[i] = {}); };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const effect = (fn: () => void | (() => void), deps?: readonly unknown[]) => {
    const s = next(); if (same(s.deps, deps)) return;
    runtime.frame!.pending.push(() => { s.cleanup?.(); s.cleanup = fn() || undefined; s.deps = deps; });
  };
  const memo = (fn: () => unknown, deps?: readonly unknown[]) => { const s = next(); if (!same(s.deps, deps)) { s.value = fn(); s.deps = deps; } return s.value; };
  return { ...react, useEffect: effect, useLayoutEffect: effect, useMemo: memo,
    useCallback: (fn: unknown, deps?: readonly unknown[]) => memo(() => fn, deps),
    useRef: (initial: unknown) => { const s = next(); if (!("value" in s)) s.value = { current: initial }; return s.value; },
    useState: (initial: unknown) => { const s = next(), f = runtime.frame!;
      if (!("value" in s)) s.value = typeof initial === "function" ? initial() : initial;
      return [s.value, (v: unknown) => { const value = typeof v === "function" ? v(s.value) : v; if (!Object.is(value, s.value)) { s.value = value; f.dirty = true; } }]; },
  };
});
vi.mock("../components/hr/HrNavigation", () => ({ useHrNavigation: () => null, useHrStaffSelection: () => ["", vi.fn()] }));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== "object" || !("props" in node)) return []; const e = node as Element; return [e, ...nodes(e.props.children)]; }
function words(node: ReactNode): string { if (Array.isArray(node)) return node.map(words).join(""); if (typeof node === "string" || typeof node === "number") return String(node); return node && typeof node === "object" && "props" in node ? words((node as Element).props.children) : ""; }
function driver(component: () => ReactNode) {
  const frame: Frame = { slots: [], cursor: 0, pending: [], dirty: false };
  const render = () => { let tree: ReactNode; let rounds = 0; do { if (++rounds > 20) throw Error("Unsettled"); runtime.frame = frame; frame.cursor = 0; frame.dirty = false; tree = component(); frame.pending.splice(0).forEach(fn => fn()); } while (frame.dirty); return tree; };
  return { frame, render, begin: () => { runtime.frame = frame; frame.cursor = 0; return component(); }, commit: () => frame.pending.splice(0).forEach(fn => fn()), unmount: () => frame.slots.forEach(s => s.cleanup?.()),
    abandon: (prepare?: () => void) => { const fork: Frame = { slots: frame.slots.map(s => ({ ...s })), cursor: 0, pending: [], dirty: false }; runtime.frame = fork; prepare?.(); component(); runtime.frame = frame; },
  };
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const response = (body: unknown) => ({ ok: true, json: async () => body });
let events: Map<string, Set<() => void>>;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-07T12:00:00Z")); events = new Map(); vi.stubGlobal("window", {
  setInterval, clearInterval, addEventListener: (event: string, fn: () => void) => { if (!events.has(event)) events.set(event, new Set()); events.get(event)!.add(fn); },
  removeEventListener: (event: string, fn: () => void) => events.get(event)?.delete(fn),
}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bounded panel lifecycle regressions", () => {
  it.each(["close", "template"])("cancels an obsolete consent canvas reset after %s", transition => {
    const props = { isOpen: true, onClose: vi.fn(), patientId: 7, patientName: "Synthetic" };
    const f = driver(() => ConsentModal(props)); const tree = f.render();
    const clearRect = vi.fn(); const canvas = { width: 100, height: 100, getContext: () => ({ clearRect }) };
    (nodes(tree).find(e => e.type === "canvas")!.props.ref as { current: unknown }).current = canvas;
    vi.advanceTimersByTime(50);
    if (transition === "close") { props.isOpen = false; expect(f.render()).toBeNull(); props.isOpen = true; f.render(); }
    else { const choice = nodes(tree).find(e => e.type === "button" && e.key !== null && e.key !== "surgical_extraction")!; choice.props.onClick(); f.render(); }
    vi.advanceTimersByTime(50); expect(clearRect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50); expect(clearRect).toHaveBeenCalledTimes(1);
    f.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans consent initialization on unmount", () => {
    const f = driver(() => ConsentModal({ isOpen: true, onClose: vi.fn(), patientId: 7, patientName: "Synthetic" })); f.render(); f.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it("refreshes idle contract expiry each minute and on focus, then cleans up", async () => {
    const endDate = new Date(Date.now() + 30 * 86400000 + 30_000).toISOString();
    const contract = { id: "1", staffId: "2", title: "Synthetic", contractNumber: "TEST", templateKind: "support_staff", status: "active", startDate: "2026-01-01", endDate, baseSalaryMinor: null, salaryCurrency: null, commissionRatePercent: null };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url.startsWith("/api/hr/contracts?") ? [contract] : [])));
    const f = driver(() => HrContractsPanel({ session: { username: "test", role: "admin" }, pendingSave: undefined, saveAdmission: {} as any, mountSaveAdmission: () => ({ detach: vi.fn() } as any), onReserveSave: () => false, onSettleSave: () => false }));
    f.render(); await flush(); expect(words(f.render())).not.toContain("يقترب الانتهاء");
    vi.advanceTimersByTime(60_000); expect(f.frame.dirty).toBe(true); expect(words(f.render())).toContain("يقترب الانتهاء");
    vi.setSystemTime(new Date(endDate)); events.get("focus")!.forEach(fn => fn()); expect(f.frame.dirty).toBe(true); expect(words(f.render())).not.toContain("يقترب الانتهاء");
    f.unmount(); expect(events.get("focus")!.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not revive saved task-detail callbacks after committed A to B to A queries", async () => {
    const payload = { tasks: [{ id: 1, title: "Saved detail task", status: "planned", priority: "normal", dueAt: null, plannedFor: null }], counts: { planned: 1, in_progress: 0, blocked: 0, completed: 0, cancelled: 0 }, overdueCount: 0 };
    const fetch = vi.fn(async (_url: string) => response(payload)); vi.stubGlobal("fetch", fetch);
    const wrapper = driver(() => HrTasksPanel({ session: { username: "test", role: "admin" } })); const child = wrapper.render() as Element;
    const f = driver(() => (child.type as (props: any) => ReactNode)(child.props)); f.render(); await flush();
    const saved = nodes(f.render()).find(e => e.type === "button" && words(e).includes("Saved detail task"))!;
    expect(saved).toBeDefined();
    f.frame.slots[5].value = "B"; f.render(); await flush(); f.render();
    f.frame.slots[5].value = ""; f.render(); await flush(); f.render();
    saved.props.onClick(); await flush();
    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith("/api/tasks/"))).toHaveLength(0);
    const current = nodes(f.render()).find(e => e.type === "button" && words(e).includes("Saved detail task"))!;
    current.props.onClick(); await flush();
    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith("/api/tasks/"))).toHaveLength(1);
    f.unmount(); wrapper.unmount();
  });
  it("samples the contract clock at commit after a delayed mount", async () => {
    const endDate = new Date(Date.now() + 30 * 86400000 + 30_000).toISOString();
    const contract = { id: "1", staffId: "2", title: "Synthetic", contractNumber: "TEST", templateKind: "support_staff", status: "active", startDate: "2026-01-01", endDate, baseSalaryMinor: null, salaryCurrency: null, commissionRatePercent: null };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url.startsWith("/api/hr/contracts?") ? [contract] : [])));
    const f = driver(() => HrContractsPanel({ session: { username: "test", role: "admin" }, pendingSave: undefined, saveAdmission: {} as any, mountSaveAdmission: () => ({ detach: vi.fn() } as any), onReserveSave: () => false, onSettleSave: () => false }));
    f.begin(); vi.setSystemTime(new Date(Date.now() + 60_000)); f.commit(); await flush();
    expect(words(f.render())).toContain("يقترب الانتهاء"); f.unmount();
  });
  it("a committed task query retires old responses while admitting its replacement", async () => {
    const resolves: Array<(value: unknown) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise(done => resolves.push(done))));
    const wrapper = driver(() => HrTasksPanel({ session: { username: "test", role: "admin" } })); const child = wrapper.render() as Element;
    const f = driver(() => (child.type as (props: any) => ReactNode)(child.props)); f.render();
    f.frame.slots[5].value = "replacement"; f.render();
    const payload = (title: string) => ({ tasks: [{ id: 1, title, status: "planned", priority: "normal", dueAt: null, plannedFor: null }], counts: { planned: 1, in_progress: 0, blocked: 0, completed: 0, cancelled: 0 }, overdueCount: 0 });
    resolves[0](response(payload("Retired task"))); await flush(); expect(words(f.render())).not.toContain("Retired task");
    resolves[1](response(payload("Replacement task"))); await flush(); expect(words(f.render())).toContain("Replacement task");
    f.unmount(); wrapper.unmount();
  });
  it("an abandoned task query does not invalidate the committed pending read", async () => {
    let resolve!: (value: unknown) => void; const fetch = vi.fn(() => new Promise(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
    const wrapper = driver(() => HrTasksPanel({ session: { username: "test", role: "admin" } })); const child = wrapper.render() as Element;
    const f = driver(() => (child.type as (props: any) => ReactNode)(child.props)); f.render();
    // search is the sixth state slot in OwnerTaskPanel; change only the work-in-progress state.
    f.abandon(() => { runtime.frame!.slots[5].value = "uncommitted"; });
    resolve(response({ tasks: [{ id: 1, title: "Committed task", status: "planned", priority: "normal", dueAt: null, plannedFor: null }], counts: { planned: 1, in_progress: 0, blocked: 0, completed: 0, cancelled: 0 }, overdueCount: 0 })); await flush();
    expect(words(f.render())).toContain("Committed task"); expect(fetch).toHaveBeenCalledTimes(1);
    f.unmount(); wrapper.unmount();
  });
});
