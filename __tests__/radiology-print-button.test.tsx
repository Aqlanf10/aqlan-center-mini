/** Actual component handlers under synthetic hooks; not browser or database proof. */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RadiologyPrintButton } from "../components/RadiologyPrintButton";
const state = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, mounted: true, lateUpdates: 0, effects: [] as Array<() => void>, cleanup: [] as Array<() => void>, session: { username: "synthetic", role: "doctor", permissions: { canPrintRadiologyRequests: true } } }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => state.session }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = initial;
    return [state.slots[index], (value: unknown) => { if (!state.mounted) state.lateUpdates++; state.slots[index] = typeof value === "function" ? value(state.slots[index]) : value; }]; },
  useRef: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = { current: initial }; return state.slots[index]; },
  useLayoutEffect: (run: () => void | (() => void)) => { const index = state.cursor++; if (!(index in state.slots)) { state.slots[index] = true; state.effects.push(() => { const cleanup = run(); if (cleanup) state.cleanup.push(cleanup); }); } },
}));
type Element = ReactElement<Record<string, unknown>>;
const KEY = "11111111-1111-4111-8111-111111111111";
let fetchMock: ReturnType<typeof vi.fn>;
function render() {
  state.cursor = 0;
  const panel = RadiologyPrintButton({ patientId: 7, requestId: KEY });
  const rendered = (panel.type as (props: unknown) => ReactNode)(panel.props);
  state.effects.splice(0).forEach(effect => effect());
  return rendered;
}
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...nodes(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
}
function button(label: string) { const node = nodes(render()).find(node => node.type === "button" && text(node.props.children as ReactNode) === label); if (!node) throw new Error(label); return node; }
function click(label: string) { (button(label).props.onClick as () => void)(); }
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
beforeEach(() => {
  state.slots = []; state.cursor = 0; state.effects = []; state.cleanup = []; state.mounted = true; state.lateUpdates = 0;
  state.session = { username: "synthetic", role: "doctor", permissions: { canPrintRadiologyRequests: true } };
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", { print: vi.fn() });
});
afterEach(() => { state.cleanup.forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
it("prints only after a matching explicit authorized response", async () => {
  fetchMock.mockResolvedValue(response({ allowed: true, id: KEY, patientId: 7 }));
  expect(window.print).not.toHaveBeenCalled(); click("طباعة طلب الأشعة"); await flush();
  expect(fetchMock).toHaveBeenCalledWith(`/api/radiology-requests/${KEY}/print`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: 7 }) });
  expect(window.print).toHaveBeenCalledOnce();
});
it.each([
  [403, { message: "grant revoked" }], [500, { message: "audit failed" }],
  [200, { allowed: true, id: KEY, patientId: 8 }], [200, { allowed: true, id: "wrong", patientId: 7 }],
  [200, { allowed: "true", id: KEY, patientId: 7 }], [200, {}], [200, null],
])("does not print an unauthorized/malformed result (%s, %j)", async (status, body) => {
  fetchMock.mockResolvedValue(response(body, status as number)); click("طباعة طلب الأشعة"); await flush();
  expect(window.print).not.toHaveBeenCalled(); expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
});
it("does not print on network or unreadable JSON failure", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error("invalid JSON"); } }); click("طباعة طلب الأشعة"); await flush();
  expect(window.print).not.toHaveBeenCalled();
});
it("deduplicates synchronous clicks and ignores authorization response after unmount", async () => {
  let finish!: (value: unknown) => void; fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const handler = button("طباعة طلب الأشعة").props.onClick as () => void; handler(); handler();
  expect(fetchMock).toHaveBeenCalledOnce(); expect(button("التحقق من صلاحية الطباعة…").props.disabled).toBe(true);
  state.cleanup.forEach(cleanup => cleanup()); state.mounted = false;
  finish(response({ allowed: true, id: KEY, patientId: 7 })); await flush();
  expect(window.print).not.toHaveBeenCalled(); expect(state.lateUpdates).toBe(0);
});

it.each(["principal", "permission", "patient"])("retires old print authority during a %s scope switch before deferred response", async scope => {
  const oldWrapper = RadiologyPrintButton({ patientId: 7, requestId: KEY });
  let finish!: (value: unknown) => void; fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const oldHandler = button("طباعة طلب الأشعة").props.onClick as () => void; oldHandler();
  if (scope === "principal") state.session = { ...state.session, username: "other" };
  if (scope === "permission") state.session = { ...state.session, permissions: { canPrintRadiologyRequests: false } };
  const changed = RadiologyPrintButton({ patientId: scope === "patient" ? 8 : 7, requestId: KEY });
  expect(changed.key).not.toBe(oldWrapper.key);
  // React runs layout cleanup for the retired keyed subtree synchronously.
  state.cleanup.forEach(cleanup => cleanup()); state.mounted = false;
  finish(response({ allowed: true, id: KEY, patientId: 7 })); await flush();
  expect(window.print).not.toHaveBeenCalled(); expect(state.lateUpdates).toBe(0);
  fetchMock.mockClear(); oldHandler(); await flush(); expect(fetchMock).not.toHaveBeenCalled(); expect(window.print).not.toHaveBeenCalled();
});
