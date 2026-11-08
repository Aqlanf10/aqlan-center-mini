import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionInfo } from "../components/SessionProvider";

const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0,
  effects: [] as (() => void)[], cleanups: [] as (() => void)[],
  session: null as SessionInfo | null,
}));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const slot = (value: unknown) => {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = value;
    return i;
  };
  const effect = (fn: () => void | (() => void), deps: unknown[]) => {
    const i = slot(undefined);
    const old = h.slots[i] as unknown[] | undefined;
    if (old && old.length === deps.length && old.every((v, j) => Object.is(v, deps[j]))) return;
    h.slots[i] = deps;
    h.effects.push(() => { const cleanup = fn(); if (cleanup) h.cleanups.push(cleanup); });
  };
  return {
    ...actual,
    useState(value: unknown) {
      const i = slot(value), slots = h.slots;
      return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }];
    },
    useRef(value: unknown) { return h.slots[slot({ current: value })]; },
    useCallback(fn: unknown, deps: unknown[]) {
      const i = slot(undefined), old = h.slots[i] as { fn: unknown; deps: unknown[] } | undefined;
      if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) h.slots[i] = { fn, deps };
      return (h.slots[i] as { fn: unknown }).fn;
    },
    useEffect: effect, useLayoutEffect: effect,
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => h.session }));
import { OrthoPendingDecisions } from "../components/OrthoPendingDecisions";

type Element = ReactElement<Record<string, unknown>>;
const nodes = (n: ReactNode): Element[] => Array.isArray(n) ? n.flatMap(nodes)
  : n && typeof n === "object" && "props" in n ? [n as Element, ...nodes((n as Element).props.children as ReactNode)] : [];
const text = (n: ReactNode): string => Array.isArray(n) ? n.map(text).join("")
  : n && typeof n === "object" && "props" in n ? text((n as Element).props.children as ReactNode)
  : typeof n === "string" || typeof n === "number" ? String(n) : "";
let key: string | null | undefined;
function unmount() {
  for (const cleanup of h.cleanups.splice(0)) cleanup();
  h.slots = []; h.effects = []; key = undefined;
}
// Emulate keyed reconciliation and layout cleanup, as used by the other ownership suites.
function render() {
  const boundary = OrthoPendingDecisions();
  if (!boundary) { unmount(); return null; }
  if (key !== boundary.key) { unmount(); key = boundary.key; }
  h.cursor = 0;
  const tree = (boundary.type as (props: Record<string, unknown>) => ReactNode)(boundary.props);
  for (const effect of h.effects.splice(0)) effect();
  return tree;
}
const actorA: SessionInfo = { userId: 7, username: "synthetic_a", role: "admin" };
const actorB: SessionInfo = { userId: 8, username: "synthetic_b", role: "doctor" };
const row = (name = "SYNTHETIC_PATIENT_A") => ({
  adjustmentId: 51, patientId: 19, patientName: name, visitId: 61,
  doneOn: "2026-11-01", doctorName: "SYNTHETIC_DOCTOR_A", legacy: false,
});
const reply = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
const read = (name?: string) => reply({ pending: [row(name)] });
const fetchMock = vi.fn();
const prompt = vi.fn(() => "synthetic reason");
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
const button = (label = "بلا رسوم") => nodes(render()).find(n => n.type === "button" && text(n).includes(label))!;
const click = (n: Element) => (n.props.onClick as () => void)();
const posts = () => fetchMock.mock.calls.filter(call => call[1]?.method === "POST");
async function start() { fetchMock.mockResolvedValueOnce(read()); render(); await settle(); expect(text(render())).toContain("SYNTHETIC_PATIENT_A"); }
function concealed() {
  const tree = render();
  expect(text(tree)).not.toMatch(/SYNTHETIC_PATIENT_A|SYNTHETIC_DOCTOR_A|2026-11-01/);
  expect(nodes(tree).filter(n => n.type === "button" || n.type === "a")).toHaveLength(0);
}
beforeEach(() => {
  unmount(); h.session = { ...actorA }; fetchMock.mockReset(); prompt.mockReset().mockReturnValue("synthetic reason");
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", { prompt });
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

it.each([
  ["actor", actorB], ["role", { ...actorA, role: "doctor" }],
  ["permissions", { ...actorA, permissions: { canViewAllPatients: false } as SessionInfo["permissions"] }],
  ["unsupported role", { ...actorA, role: "accountant" }], ["session loss", null],
] as const)("conceals immediately on %s change and retires old clicks", async (_, next) => {
  await start(); const old = button(); fetchMock.mockImplementation(() => new Promise(() => {}));
  h.session = next; concealed(); click(old);
  expect(prompt).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
});
it("does not revive A handlers after A → B → A", async () => {
  await start(); const old = button(); fetchMock.mockResolvedValueOnce(read("PATIENT_B"));
  h.session = actorB; render(); await settle();
  fetchMock.mockResolvedValueOnce(read("PATIENT_A_NEW"));
  h.session = actorA; render(); await settle(); click(old);
  expect(posts()).toHaveLength(0); expect(prompt).not.toHaveBeenCalled();
  expect(text(render())).toContain("PATIENT_A_NEW");
});
it("rejects deferred reads belonging to a prior non-null actor", async () => {
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  render(); fetchMock.mockResolvedValueOnce(read("PATIENT_B")); h.session = actorB; render(); await settle();
  finish(read()); await settle();
  expect(text(render())).toContain("PATIENT_B"); expect(text(render())).not.toContain("SYNTHETIC_PATIENT_A");
});
it("checks ownership after deferred read body parsing", async () => {
  let finish!: (payload: unknown) => void;
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => new Promise(resolve => { finish = resolve; }) });
  render(); await settle(); h.session = actorB;
  fetchMock.mockResolvedValueOnce(read("PATIENT_B")); render(); await settle();
  finish({ pending: [row()] }); await settle(); expect(text(render())).toContain("PATIENT_B");
  expect(text(render())).not.toContain("SYNTHETIC_PATIENT_A");
});
it.each([401, 403])("conceals immediately on POST %s without parsing the body, then rejects retained clicks", async status => {
  await start(); const old = button(); const json = vi.fn(() => new Promise(() => {}));
  fetchMock.mockResolvedValueOnce({ status, ok: false, json }); click(old); await settle();
  concealed(); expect(json).not.toHaveBeenCalled(); click(old); expect(posts()).toHaveLength(1);
  expect(text(render())).toContain("تغيّرت الصلاحيات");
});
it.each([401, 403])("conceals when the post-success refresh GET returns %s", async status => {
  await start(); const old = button();
  fetchMock.mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply({}, status));
  click(old); await settle(); concealed(); click(old); expect(posts()).toHaveLength(1);
});
it("does not mutate after authority changes during a prompt", async () => {
  await start(); const old = button();
  prompt.mockImplementation(() => { h.session = actorB; render(); return "synthetic reason"; });
  click(old); await settle(); expect(posts()).toHaveLength(0);
});
it("ignores an old mutation response instead of refreshing the new actor", async () => {
  await start(); let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  click(button()); fetchMock.mockResolvedValueOnce(read("PATIENT_B"));
  h.session = actorB; render(); await settle(); const count = fetchMock.mock.calls.length;
  finish(reply({})); await settle();
  expect(fetchMock).toHaveBeenCalledTimes(count); expect(text(render())).toContain("PATIENT_B");
  expect(text(render())).not.toContain("حُفظ القرار.");
});
it("guards repeated clicks and retires callbacks from the previous successful read", async () => {
  await start(); const old = button();
  fetchMock.mockResolvedValueOnce(reply({})).mockResolvedValueOnce(read("PATIENT_REFRESH"));
  click(old); click(old); await settle(); expect(posts()).toHaveLength(1);
  expect(text(render())).toContain("PATIENT_REFRESH"); click(old); expect(posts()).toHaveLength(1);
});
it.each(["admin", "doctor", "reception"])("preserves valid %s decision capabilities", async role => {
  h.session = { ...actorA, role }; await start();
  const labels = nodes(render()).filter(n => n.type === "button").map(text).join(" ");
  expect(labels.includes("بلا رسوم")).toBe(role !== "reception");
  expect(labels.includes("فوتِرت")).toBe(role !== "doctor");
  fetchMock.mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply({ pending: [] }));
  click(button(role === "reception" ? "فوتِرت" : "بلا رسوم")); await settle();
  expect(posts()).toHaveLength(1); expect(text(render())).toContain("حُفظ القرار.");
});
it("does not re-fetch for an equivalent session refresh", async () => {
  await start(); h.session = { ...actorA, displayName: "new display" }; render();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("handles network failure without an unhandled rejection", async () => {
  await start(); fetchMock.mockRejectedValueOnce(new Error("offline")); click(button()); await settle();
  expect(text(render())).toContain("تعذّر الاتصال"); expect(button().props.disabled).toBe(false);
});
it("ignores an old mutation body that finishes parsing under another actor", async () => {
  await start(); let finish!: (payload: unknown) => void;
  fetchMock.mockResolvedValueOnce({ status: 200, ok: true, json: () => new Promise(resolve => { finish = resolve; }) });
  click(button()); await settle(); fetchMock.mockResolvedValueOnce(read("PATIENT_B"));
  h.session = actorB; render(); await settle(); const count = fetchMock.mock.calls.length;
  finish({}); await settle(); expect(fetchMock).toHaveBeenCalledTimes(count);
  expect(text(render())).toContain("PATIENT_B"); expect(text(render())).not.toContain("حُفظ القرار.");
});
it.each([401, 403])("does not display clinical data from a denied initial GET %s", async status => {
  fetchMock.mockResolvedValueOnce(reply({ pending: [row()] }, status));
  render(); await settle(); concealed(); expect(text(render())).toContain("تغيّرت الصلاحيات");
});
it("does not read without an eligible session", () => {
  for (const session of [null, { ...actorA, role: "accountant" }]) {
    h.session = session; concealed();
  }
  expect(fetchMock).not.toHaveBeenCalled();
});
it("retires pending read and callbacks on actual workspace teardown", async () => {
  await start(); const old = button(); let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  click(old); unmount(); finish(reply({})); await settle(); click(old);
  expect(posts()).toHaveLength(1); expect(fetchMock).toHaveBeenCalledTimes(2);
});
