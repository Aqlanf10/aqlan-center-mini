/** Characterizes a pre-existing financial intent bug using the actual Settings Users page.
 * Synthetic GET projection + React scheduling only; writes are captured, not executed.
 * Passing tests document the BUG and do not claim PostgreSQL/browser/live-site proof. */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UsersAndDoctorsPage from "../app/settings/users/page";
import { parseDoctorCommissionConfig, type DoctorCommissionConfig } from "../lib/doctor-permissions";
import { resolvePolicyForShare } from "../lib/commission";
type Hooks = { values: unknown[]; cursor: number; changed: boolean; mounted: boolean; lateUpdates: number;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void; layout: boolean }>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>; pending: Array<() => void>; layout: Array<() => void> };
const runtime = vi.hoisted(() => ({ current: null as Hooks | null }));
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
type Element = ReactElement<Record<string, unknown>>;
let hooks: Hooks;
function render(): ReactNode {
  let tree: ReactNode; let rounds = 0;
  do {
    if (++rounds > 25) throw new Error("Actual page did not settle");
    hooks.cursor = 0; hooks.changed = false; runtime.current = hooks;
    tree = UsersAndDoctorsPage(); runtime.current = null;
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const node = tree as Element; return [node, ...nodes(node.props.children as ReactNode)];
}
function text(tree: ReactNode): string {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object" && "props" in tree) return text((tree as Element).props.children as ReactNode);
  return tree == null || typeof tree === "boolean" ? "" : String(tree);
}
function button(label: string) {
  const item = nodes(render()).find((node) => node.type === "button" && text(node) === label);
  if (!item) throw new Error(`Missing actual button ${label}`);
  return item;
}
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function ready() { render(); await settle(); render(); await settle(); render(); }
const response = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
const fetchMock = vi.fn();
const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
let rawConfig: DoctorCommissionConfig | null;
const accountId = 71;
const partyPercent = 20;
const at = "2026-10-04T12:00:00.000Z";
const share = { category: "rct" };
beforeEach(() => {
  hooks = { values: [], cursor: 0, changed: false, mounted: true, lateUpdates: 0,
    effects: new Map(), memos: new Map(), pending: [], layout: [] };
  rawConfig = null; writes.splice(0); fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      writes.push({ url, body: JSON.parse(String(init.body)) });
      // Do not emulate the writer; this response only allows actual handler completion/reload.
      return response({ ok: true });
    }
    if (init?.method && init.method !== "GET") throw new Error(`Unexpected mutation ${init.method}`);
    if (url === "/api/users") return response([{ id: accountId, username: "null-policy-doctor", displayName: "طبيب سياسة اصطناعي",
      role: "doctor", isActive: true, partyId: 81, partyName: "جهة سياسة اصطناعية", createdAt: at,
      // Actual listUsers contracts parse SQL NULL, losing raw absence at the UI boundary.
      commissionConfig: parseDoctorCommissionConfig(rawConfig) }]);
    if (url === "/api/services?all=1") return response([]);
    if (url === "/api/parties?kind=doctor") return response([{ id: 81, name: "جهة سياسة اصطناعية", commissionPercent: partyPercent }]);
    throw new Error(`Unexpected read ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  hooks.effects.forEach((effect) => effect.cleanup?.()); hooks.mounted = false;
  vi.unstubAllGlobals();
});

describe("characterization: Basic-only actual doctor save incorrectly materializes absent advanced policy", () => {
  it("captures default30 in the actual name-only save despite ordinary20 raw NULL policy", async () => {
    expect(resolvePolicyForShare({ percent: partyPercent, config: rawConfig }, at, share).percent).toBe(20);
    expect(parseDoctorCommissionConfig(rawConfig).defaultPercent).toBe(30);
    await ready();
    (button("تعديل الملف").props.onClick as () => void)();
    const input = nodes(render()).find((node) => node.type === "input" && node.props.value === "طبيب سياسة اصطناعي");
    if (!input) throw new Error("Missing actual Basic display name input");
    (input.props.onChange as (event: unknown) => void)({ target: { value: "اسم طبيب محدّث فقط" } });
    await (button("حفظ التغييرات والصلاحيات").props.onClick as () => Promise<void>)();
    await ready();
    expect(writes).toHaveLength(1);
    expect(writes[0].url).toBe(`/api/users/${accountId}`);
    expect(writes[0].body.displayName).toBe("اسم طبيب محدّث فقط");
    const sentConfig = writes[0].body.commissionConfig as DoctorCommissionConfig;
    expect(sentConfig).toMatchObject({ calculationMode: "percentage", defaultPercent: 30 });
    expect(resolvePolicyForShare({ percent: partyPercent, config: sentConfig }, at, share).percent).toBe(30);
    // No synthetic mutation is performed; persisted effects need the independent real HTTP/PG proof.
    expect(rawConfig).toBeNull();
  });
  it("control: an already explicit advanced17 remains explicit17 on the same actual Basic handler", async () => {
    rawConfig = { ...parseDoctorCommissionConfig(null), defaultPercent: 17 };
    await ready(); (button("تعديل الملف").props.onClick as () => void)(); render();
    await (button("حفظ التغييرات والصلاحيات").props.onClick as () => Promise<void>)(); await ready();
    expect(writes).toHaveLength(1);
    expect(writes[0].body.commissionConfig).toMatchObject({ defaultPercent: 17 });
    expect(resolvePolicyForShare({ percent: partyPercent, config: rawConfig }, at, share).percent).toBe(17);
  });
});
