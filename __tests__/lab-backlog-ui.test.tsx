import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { backlogItem, backlogSnapshot } from "./fixtures/lab-backlog";
type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
type Frame = { slots: Slot[]; cursor: number; effects: (() => void)[] };
const runtime = vi.hoisted(() => ({ frame: null as Frame | null, session: { username: "synthetic", role: "admin" } as { username: string; role: string } | null }));
vi.mock("react", async original => { const react = await original<typeof import("react")>(); const slot = () => { const f = runtime.frame!; const i = f.cursor++; return f.slots[i] ?? (f.slots[i] = {}); }; return { ...react,
  useState: (initial: unknown) => { const s = slot(); if (!("value" in s)) s.value = typeof initial === "function" ? initial() : initial; return [s.value, (next: unknown) => { s.value = typeof next === "function" ? next(s.value) : next; }]; },
  useRef: (initial: unknown) => { const s = slot(); if (!s.value) s.value = { current: initial }; return s.value; },
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => { const s = slot(); if (!s.deps || !deps || deps.some((v, i) => !Object.is(v, s.deps![i]))) { s.deps = deps; runtime.frame!.effects.push(() => { s.cleanup?.(); s.cleanup = fn() || undefined; }); } },
}; });
vi.mock("../components/SessionProvider", () => ({ useSession: () => runtime.session }));
import { LabBacklogOverview, LabBacklogPanel, LabBacklogOrder } from "../components/leadership/LabBacklogOverview";
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!node || typeof node !== "object" || !("props" in node)) return []; const e = node as Element; return [e, ...elements(e.props.children as ReactNode)]; }
function words(node: ReactNode): string { if (Array.isArray(node)) return node.map(words).join(" "); if (typeof node === "string" || typeof node === "number") return String(node); return node && typeof node === "object" && "props" in node ? words((node as Element).props.children as ReactNode) : ""; }
const turns = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const listeners = new Map<string, () => void>();
function mount() { const frame: Frame = { slots: [], cursor: 0, effects: [] }; const render = () => { runtime.frame = frame; frame.cursor = 0; const tree = LabBacklogPanel(); frame.effects.splice(0).forEach(fn => fn()); return tree; };
  const click = (label: string) => { const node = elements(render()).find(e => e.type === "button" && words(e.props.children as ReactNode) === label)!; (node.props.onClick as () => void)(); };
  render(); return { render, click, unmount: () => frame.slots.forEach(s => s.cleanup?.()) }; }
beforeEach(() => { vi.useFakeTimers(); listeners.clear(); runtime.session = { username: "synthetic", role: "admin" };
  vi.stubGlobal("window", { addEventListener: (k: string, fn: () => void) => listeners.set(k, fn), removeEventListener: (k: string) => listeners.delete(k) });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: (k: string, fn: () => void) => listeners.set(k, fn), removeEventListener: (k: string) => listeners.delete(k) }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each([null, "doctor", "reception", "accountant", "cashier", "assistant"])("does not mount the all-patient feed for %s", role => {
  runtime.session = role ? { username: "synthetic", role } : null; expect(LabBacklogOverview()).toBeNull();
});
it("keys snapshots by principal so changing accounts unmounts private patient data", () => {
  const a = LabBacklogOverview(); runtime.session = { username: "other", role: "admin" }; expect(LabBacklogOverview()?.key).not.toBe(a?.key);
});
it("drops old patient rows immediately on filter change and ignores the superseded reply", async () => {
  const pending: ((value: unknown) => void)[] = []; const fetch = vi.fn(() => new Promise(resolve => pending.push(resolve))); vi.stubGlobal("fetch", fetch);
  const f = mount(); f.click("وصل ولم يُركّب"); f.render();
  expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: expect.objectContaining({ aborted: true }) });
  pending[1](response(backlogSnapshot({ filter: "awaiting_fitting" }))); await turns();
  expect(elements(f.render()).filter(e => e.type === LabBacklogOrder)).toHaveLength(1);
  pending[0](response(backlogSnapshot({ items: [backlogItem({ patientName: "Old forbidden display" })] }))); await turns();
  expect(elements(f.render()).find(e => e.type === LabBacklogOrder)?.props.item).toMatchObject({ patientName: "Synthetic waiting patient" }); f.unmount();
});
it("clears rows on revoked session and unknown source failure instead of showing zero", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(backlogSnapshot())).mockResolvedValueOnce(response({}, 401)); vi.stubGlobal("fetch", fetch);
  const f = mount(); await turns(); f.click("تحديث متابعة المعمل"); f.render(); await turns();
  expect(words(f.render())).toContain("انتهت الجلسة"); expect(elements(f.render()).some(e => e.type === LabBacklogOrder)).toBe(false); f.unmount();
});
it("turns timeout into unknown and aborts reads on unmount", async () => {
  const fetch = vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))))); vi.stubGlobal("fetch", fetch);
  const f = mount(); await vi.advanceTimersByTimeAsync(20000); await turns(); expect(words(f.render())).toContain("الأعداد غير معروفة"); f.unmount(); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
});
it("renders source-exact responsibility separately from latest actor without inventing patient absence", () => {
  const html = renderToStaticMarkup(<LabBacklogOrder today="2026-10-25" timeZone="Asia/Aden" item={backlogItem({ receivedAt: null,
    latestAction: { action: "status_change", fromStatus: "sent", toStatus: "received", actor: "Receiving clerk", at: "2026-10-01T12:00:00Z" },
    visibleTaskCount: 1, tasks: [{ id: 41, title: "Check fitting appointment", status: "planned", assignee: "Follow-up staff", dueAt: null, updatedAt: "2026-10-02T12:00:00Z" }] })} />);
  expect(html).toContain("المدة غير معروفة"); expect(html).toContain("Receiving clerk"); expect(html).toContain("المسؤول المسند في المهمة: Follow-up staff");
  expect(html).toContain("عدم وجود هذا الربط لا يثبت غياب المريض"); expect(html).toContain("الوصول ليس اكتمال العلاج"); expect(html).toContain("/patients/21?tab=treatment&amp;sub=lab");
  expect(html).not.toMatch(/costMinor|payable|عمولة/);
});
it("keeps all-open scope explicit and marks focus return stale without automatic writes", async () => {
  const fetch = vi.fn().mockResolvedValue(response(backlogSnapshot())); vi.stubGlobal("fetch", fetch); const f = mount(); await turns(); listeners.get("focus")!();
  expect(words(f.render())).toContain("مهما كان تاريخها"); expect(words(f.render())).toContain("قد تكون السجلات تغيّرت");
  expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1]).not.toHaveProperty("method"); f.unmount();
});
