import type { DependencyList, EffectCallback, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DoctorDailyScheduleCard } from "../components/DoctorDailyScheduleCard";
const identity = vi.hoisted(() => ({ session: { username: "synthetic", role: "doctor" } as { username: string; role: string } | null }));
vi.mock("@/components/SessionProvider", () => ({ useSession: () => identity.session }));
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, effectCursor: 0, dirty: false,
  effects: [] as { deps?: DependencyList; cleanup?: ReturnType<EffectCallback> }[],
  pending: [] as { index: number; deps?: DependencyList; run: EffectCallback }[],
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  function slot(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  }
  return {
    ...react,
    useId: () => "patient-search-audit",
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => {
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.dirty = true;
        hooks.values[index] = next;
      }];
    },
    useMemo: (factory: () => unknown, deps: DependencyList) => {
      const index = slot(undefined);
      const previous = hooks.values[index] as { deps: DependencyList; value: unknown } | undefined;
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) hooks.values[index] = { deps, value: factory() };
      return (hooks.values[index] as { value: unknown }).value;
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useEffect: (run: EffectCallback, deps?: DependencyList) => {
      const index = hooks.effectCursor++;
      const previous = hooks.effects[index];
      if (!previous || !deps || !previous.deps || deps.length !== previous.deps.length ||
        deps.some((value, position) => !Object.is(value, previous.deps![position]))) {
        hooks.pending.push({ index, deps, run });
      }
    },
  };
});
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});

const fetchMock = vi.fn();
const requests: ReturnType<typeof deferred<ReturnType<typeof response>>>[] = [];
function render() {
  let tree: ReturnType<typeof DoctorDailyScheduleCard>;
  do {
    hooks.dirty = false; hooks.cursor = 0; hooks.effectCursor = 0; hooks.pending = [];
    tree = DoctorDailyScheduleCard();
    for (const { index, deps, run } of hooks.pending) {
      const cleanup = hooks.effects[index]?.cleanup;
      if (typeof cleanup === "function") cleanup();
      hooks.effects[index] = { deps, cleanup: run() };
    }
  } while (hooks.dirty);
  return tree;
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children as ReactNode);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function click(label: string) {
  const button = elements(render()).find((e) => e.type === "button" && text(e) === label)!;
  (button.props.onClick as () => void)();
  return render();
}
const payload = (requestDate: string, name: string) => ({
  requestDate, date: requestDate === "today" ? "2026-10-21" : "2026-10-22", today: "2026-10-21", tomorrow: "2026-10-22",
  generatedAt: "2026-10-21T12:00:00Z", timeZone: "Asia/Aden",
  counts: { total: 1, scheduled: 0, cancelled: 1 },
  appointments: [{ appointmentId: 1, patientId: 2, patientName: name, time: "09:30", durationMinutes: 30, status: "cancelled", hasReferral: true, patientHref: null }],
});
async function resolve(index: number, body: unknown, status = 200) {
  requests[index].resolve(response(status, body));
  await vi.advanceTimersByTimeAsync(0);
  return render();
}
beforeEach(() => {
  identity.session = { username: "synthetic", role: "doctor" };
  hooks.values = []; hooks.effects = []; hooks.pending = []; hooks.dirty = false;
  hooks.cursor = 0; hooks.effectCursor = 0; requests.length = 0;
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() => { const pending = deferred<ReturnType<typeof response>>(); requests.push(pending); return pending.promise; });
});
afterEach(() => {
  for (const effect of hooks.effects) if (typeof effect.cleanup === "function") effect.cleanup();
  vi.useRealTimers(); vi.unstubAllGlobals();
});
describe("personal schedule rendered lifecycle", () => {
  it("uses server relative dates, hides the previous day immediately and ignores delayed old responses", async () => {
    render();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/appointments/mine?date=today");
    click("غدًا");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/appointments/mine?date=tomorrow");
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await resolve(1, payload("tomorrow", "Tomorrow patient"));
    expect(text(render())).toContain("Tomorrow patient");
    await resolve(0, payload("today", "Old patient"));
    expect(text(render())).not.toContain("Old patient");
    expect(text(render())).toContain("Tomorrow patient");
    const tree = click("اليوم");
    expect(text(tree)).not.toContain("Tomorrow patient");
    expect(text(tree)).toContain("جارٍ تحميل");
  });
  it("hides prior rows on refresh failure and allows retry", async () => {
    render(); await resolve(0, payload("today", "Old patient"));
    expect(text(click("تحديث"))).not.toContain("Old patient");
    await resolve(1, { message: "Synthetic failure" }, 500);
    expect(text(render())).toContain("Synthetic failure");
    expect(text(render())).not.toContain("Old patient");
    click("تحديث"); await resolve(2, payload("today", "Fresh patient"));
    expect(text(render())).toContain("Fresh patient");
  });
  it("rejects mismatched date context and makes no unauthorized patient link", async () => {
    render(); await resolve(0, payload("tomorrow", "Wrong patient"));
    expect(text(render())).not.toContain("Wrong patient");
    expect(elements(render()).some((e) => e.props.role === "alert")).toBe(true);
    click("تحديث"); await resolve(1, payload("today", "Assigned patient"));
    expect(text(render())).toContain("أُلغي");
    expect(text(render())).toContain("ملغاة: 1");
    expect(elements(render()).filter((e) => e.type === "a")).toHaveLength(0);
  });
  it("refreshes on focus and clinic midnight while fencing stale rows", async () => {
    render(); await resolve(0, payload("today", "Before focus"));
    window.dispatchEvent(new Event("focus")); render();
    expect(text(render())).not.toContain("Before focus");
    await resolve(1, payload("today", "Before midnight"));
    vi.setSystemTime(new Date("2026-10-21T21:00:01Z"));
    await vi.advanceTimersByTimeAsync(30_000); render();
    expect(requests).toHaveLength(3);
    expect(text(render())).not.toContain("Before midnight");
    await resolve(2, { ...payload("today", "After midnight"), date: "2026-10-22", today: "2026-10-22", tomorrow: "2026-10-23" });
    expect(text(render())).toContain("After midnight");
    document.dispatchEvent(new Event("visibilitychange")); render();
    expect(requests).toHaveLength(4);
  });
  it("fences responses across account switches and logout", async () => {
    render();
    identity.session = { username: "other", role: "doctor" }; render();
    await resolve(0, payload("today", "Previous account patient"));
    expect(text(render())).not.toContain("Previous account patient");
    await resolve(1, payload("today", "Current account patient"));
    expect(text(render())).toContain("Current account patient");
    identity.session = null;
    expect(render()).toBeNull();
  });
  it("never revives cached identities after logout and same-account login or session replacement", async () => {
    const sameAccount = identity.session;
    render(); await resolve(0, payload("today", "Previous session patient"));
    identity.session = null; expect(render()).toBeNull();
    identity.session = sameAccount; render();
    expect(text(render())).not.toContain("Previous session patient");
    await resolve(1, payload("today", "Refreshed patient"));
    identity.session = { username: "synthetic", role: "doctor" }; render();
    expect(text(render())).not.toContain("Refreshed patient");
    await resolve(2, payload("today", "New mapping patient"));
    expect(text(render())).toContain("New mapping patient");
  });
  it.each([
    { date: "2026-10-20" }, { timeZone: "Not/AZone" }, { generatedAt: "bad" }, { counts: { total: 0 } },
  ])("rejects malformed payload metadata %s", async (invalid) => {
    render(); await resolve(0, { ...payload("today", "Invalid patient"), ...invalid });
    expect(text(render())).not.toContain("Invalid patient");
    expect(elements(render()).some(e => e.props.role === "alert")).toBe(true);
  });
  it("custom date requests are explicit and permitted links alone render", async () => {
    render();
    const input = elements(render()).find((e) => e.type === "input")!;
    (input.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "2026-11-05" } }); render();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/appointments/mine?date=2026-11-05");
    const body = payload("2026-11-05", "Allowed patient");
    await resolve(1, { ...body, date: "2026-11-05", appointments: [{ ...body.appointments[0], patientHref: "/patients/2" }] });
    expect(elements(render()).find((e) => e.type === "a")?.props.href).toBe("/patients/2");
  });
});
