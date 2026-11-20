import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalTodayQueue } from "../components/today/CanonicalTodayQueue";
import type { Visit } from "../lib/flow";

const fixture = vi.hoisted(() => ({
  chairs: 4, cursor: 0, states: [] as unknown[],
  effects: new Map<number, { deps: readonly unknown[]; cleanup?: () => void }>(),
  pending: [] as Array<() => void>,
}));
// Real queue rendering and event handlers with controlled hooks and transport.
// This is a component test, not a native React/browser or HTTP authorization proof.
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = fixture.cursor++;
    if (!(index in fixture.states)) fixture.states[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.states[index], (value: unknown) => {
      fixture.states[index] = typeof value === "function" ? value(fixture.states[index]) : value;
    }];
  },
  useCallback: (callback: unknown) => callback,
  useEffect(callback: () => void | (() => void), deps: readonly unknown[]) {
    const index = fixture.cursor++, old = fixture.effects.get(index);
    if (old && deps.length === old.deps.length && deps.every((value, i) => Object.is(value, old.deps[i]))) return;
    fixture.pending.push(() => {
      old?.cleanup?.();
      const cleanup = callback();
      fixture.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    });
  },
}));
vi.mock("@/components/SettingsProvider", () => ({
  useChairCount: () => fixture.chairs, useNumberSetting: (key: string) => key.includes("warning") ? 15 : 30,
}));
vi.mock("@/components/SessionProvider", () => ({ useSession: () => ({ isOwner: true }) }));
vi.mock("@/components/today/CanonicalDisplayNotice", () => ({ CanonicalDisplayNotice: () => null }));
vi.mock("@/components/patient/CanonicalNextSession", () => ({ CanonicalNextSession: () => null }));
vi.mock("@/components/today/useChairReadiness", () => ({ sendGatedMove: vi.fn() }));

type Node = ReactElement<{ children?: ReactNode; "data-testid"?: string; onClick?: () => void }>;
function elements(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Node;
  return [element, ...elements(element.props.children)];
}
function content(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(content).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object" && "props" in node ? content((node as Node).props.children) : "";
}
function buttons(node: ReactNode) { return elements(node).filter(element => element.type === "button"); }
function byTestId(node: ReactNode, id: string) { return elements(node).find(element => element.props["data-testid"] === id); }
function render() {
  fixture.cursor = 0;
  const tree = CanonicalTodayQueue();
  fixture.pending.splice(0).forEach(effect => effect());
  return tree;
}
const settle = () => vi.advanceTimersByTimeAsync(0);
async function mounted() { render(); await settle(); return render(); }
function visit(id: number, status: Visit["status"], chair: number | null): Visit {
  return { id, status, chair, patientId: id, patientPhone: null, note: null, patientName: `SYN-QUEUE-${id}`,
    arrivedAt: "2031-01-15T10:00:00Z", calledAt: null, seatedAt: null, finishedAt: null };
}

let visits: Visit[], canManage: boolean, rejectMove: boolean;
const transport = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  fixture.chairs = 4; fixture.states = []; fixture.effects.clear();
  visits = [visit(1, "in_chair", 1), visit(2, "waiting", null), visit(3, "in_chair", 3), visit(4, "called", 4), visit(5, "done", 5)];
  canManage = true; rejectMove = false;
  vi.stubGlobal("window", { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval });
  transport.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/visits") return Response.json({ visits, projection: { note: false }, canManage });
    if (url === "/api/visits/readiness") return Response.json({ items: [], requireClearance: false });
    if (url.startsWith("/api/visits/") && init?.method === "PATCH") {
      if (rejectMove) return Response.json({ message: "تغيّرت حالة الزيارة." }, { status: 409 });
      const id = Number(url.split("/").at(-1)), { action } = JSON.parse(String(init.body));
      visits = visits.map(row => row.id === id ? { ...row, status: action === "return" ? "waiting" : "done", chair: action === "return" ? null : row.chair } : row);
      return Response.json({ ok: true });
    }
    throw new Error("Unexpected request in synthetic queue test");
  });
  vi.stubGlobal("fetch", transport);
});
afterEach(() => {
  fixture.effects.forEach(effect => effect.cleanup?.());
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it("keeps historically assigned active visits visible after a chair reduction without offering retired chairs", async () => {
  let tree = await mounted();
  expect(byTestId(tree, "retired-chair-visits")).toBeUndefined();
  expect(content(byTestId(tree, "chair-3"))).toContain("SYN-QUEUE-3");
  expect(content(byTestId(tree, "chair-4"))).toContain("SYN-QUEUE-4");
  fixture.chairs = 2;
  tree = render();
  const retired = byTestId(tree, "retired-chair-visits");
  expect(retired).toBeDefined();
  expect(content(retired)).toContain("SYN-QUEUE-3");
  expect(content(retired)).toContain("SYN-QUEUE-4");
  expect(content(retired)).not.toContain("SYN-QUEUE-5");
  expect(buttons(retired).map(content).sort()).toEqual(["إعادة إلى الانتظار", "إنهاء الزيارة"].sort());
  expect(byTestId(tree, "chair-3")).toBeUndefined();
  expect(byTestId(tree, "chair-4")).toBeUndefined();
  expect(content(byTestId(tree, "queue-summary"))).toContain("كراسي فارغة1");
  expect(content(byTestId(tree, "waiting-list"))).toContain("نداء إلى كرسي 2");
  expect(content(byTestId(tree, "waiting-list"))).not.toContain("كرسي 3");
  expect(content(tree)).toContain("الجلسة القادمة بعد الزيارة");
  fixture.chairs = 4;
  expect(byTestId(render(), "retired-chair-visits")).toBeUndefined();
});

it("sends only the existing chairless return and finish actions and keeps refused moves visible", async () => {
  fixture.chairs = 2;
  let tree = await mounted();
  const click = async (label: string) => {
    const action = buttons(byTestId(tree, "retired-chair-visits")).find(button => content(button) === label);
    expect(action).toBeDefined();
    action!.props.onClick!();
    await settle(); render(); await settle(); tree = render();
  };
  rejectMove = true;
  await click("إعادة إلى الانتظار");
  expect(content(byTestId(tree, "retired-chair-visits"))).toContain("SYN-QUEUE-4");
  expect(content(byTestId(tree, "move-message"))).toContain("تغيّرت حالة الزيارة.");
  rejectMove = false;
  await click("إعادة إلى الانتظار");
  expect(content(byTestId(tree, "waiting-list"))).toContain("SYN-QUEUE-4");
  expect(content(byTestId(tree, "retired-chair-visits"))).not.toContain("SYN-QUEUE-4");
  await click("إنهاء الزيارة");
  expect(byTestId(tree, "retired-chair-visits")).toBeUndefined();
  expect(content(tree)).toContain("SYN-QUEUE-3");
  expect(transport.mock.calls.filter(([, init]) => init?.method === "PATCH").map(([url, init]) => [url, JSON.parse(init.body)])).toEqual([
    ["/api/visits/4", { action: "return" }], ["/api/visits/4", { action: "return" }], ["/api/visits/3", { action: "finish" }],
  ]);
});

it("shows scoped retired visits to a staff viewer without exposing recovery actions", async () => {
  fixture.chairs = 2; canManage = false;
  const tree = await mounted(), retired = byTestId(tree, "retired-chair-visits");
  expect(content(retired)).toContain("SYN-QUEUE-3");
  expect(content(retired)).toContain("SYN-QUEUE-4");
  expect(buttons(retired)).toEqual([]);
  expect(byTestId(tree, "arrival-form")).toBeUndefined();
  expect(transport.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
    ["/api/visits", undefined], ["/api/visits/readiness", undefined],
  ]);
});
