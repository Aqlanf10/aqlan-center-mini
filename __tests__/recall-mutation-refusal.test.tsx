import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecallPage from "../app/recall/page";

// Source-only candidate. Runs the actual page handlers/effects in the existing
// repository's lightweight hook-harness style. All requests are synthetic.
// These checks do not claim real React scheduling or built-browser acceptance.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  pending: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined);
    const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory();
    hooks.memos.set(index, { deps, value });
    return value;
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => {
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ username: "synthetic-reception", role: "reception" }),
}));
vi.mock("../components/SettingsProvider", () => ({
  useClinicName: () => "Synthetic clinic",
  useSetting: () => "Synthetic clinic contact",
}));
vi.mock("../components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("../components/ProposalFollowUp", () => ({ ProposalFollowUp: () => null }));
vi.mock("../components/QuickAppointmentModal", () => ({ QuickAppointmentModal: () => null }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function contents(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(contents).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return contents((node as Element).props.children as ReactNode);
}
function render() {
  let tree: ReturnType<typeof RecallPage> | null = null;
  let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("Recall refusal harness did not settle");
    hooks.cursor = 0;
    hooks.changed = false;
    tree = RecallPage();
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
async function flush() {
  for (let pass = 0; pass < 8; pass += 1) {
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    render();
  }
}
function find(predicate: (node: Element) => boolean) {
  const node = elements(render()).find(predicate);
  if (!node) throw new Error("Missing recall control");
  return node;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (status: number, payload: unknown) => ({
  status, ok: status >= 200 && status < 300, json: async () => payload,
}) as Response;

const initialFeed = {
  weeks: 6,
  openPast: [{
    id: 81001, patientId: 82001, patientName: "Synthetic pending patient", patientPhone: null,
    scheduledDate: "2026-10-01", scheduledTime: "09:00", doctorName: null, note: null, daysLate: 1,
  }],
  missed: [{
    kind: "missed" as const, id: 81002, patientId: 82002,
    patientName: "Synthetic missed patient", patientPhone: null, referenceDate: "2026-10-01", note: null,
  }],
  lapsed: [{
    kind: "lapsed" as const, id: 82003, patientId: 82003,
    patientName: "Synthetic lapsed patient", patientPhone: null, referenceDate: "2026-01-01", note: null,
  }],
};
const emptyFeed = { weeks: 6, openPast: [], missed: [], lapsed: [] };
const actions = [
  { name: "close_done", label: "تمّت", url: "/api/appointments/81001", method: "PATCH", body: { action: "close_done" }, fallback: "تعذّر إغلاق الموعد." },
  { name: "close_no_show", label: "لم يحضر", url: "/api/appointments/81001", method: "PATCH", body: { action: "close_no_show" }, fallback: "تعذّر إغلاق الموعد." },
  { name: "missed", kind: "missed", url: "/api/recall", method: "POST", body: { kind: "missed", id: 81002 }, fallback: "تعذّر التسجيل." },
  { name: "lapsed", kind: "lapsed", url: "/api/recall", method: "POST", body: { kind: "lapsed", id: 82003 }, fallback: "تعذّر التسجيل." },
] as const;
type Action = (typeof actions)[number];
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let read: () => Promise<Response>;
let write: () => Promise<Response>;
function invoke(action: Action) {
  if ("label" in action) {
    const button = find((node) => node.type === "button" && contents(node).trim() === action.label);
    (button.props.onClick as () => void)();
    return;
  }
  const card = find((node) => {
    const row = node.props.row as { kind?: string } | undefined;
    return row?.kind === action.kind && typeof node.props.onDone === "function";
  });
  void (card.props.onDone as (row: unknown) => Promise<void>)(card.props.row);
}
const reads = () => fetchMock.mock.calls.filter(([, init]) => !init?.method);
const writes = () => fetchMock.mock.calls.filter(([, init]) => !!init?.method);
const alerts = () => elements(render()).filter((node) => node.props.role === "alert").map(contents);
function assertUnlocked() {
  const tree = render();
  for (const node of elements(tree)) {
    if (node.type === "button" && ["تمّت", "لم يحضر"].includes(contents(node).trim())) {
      expect(node.props.disabled).toBe(false);
    }
    if (typeof node.props.onDone === "function") expect(node.props.busy).toBe(false);
  }
}
function assertOriginalRows() {
  const tree = render();
  expect(contents(tree)).toContain("Synthetic pending patient");
  const rows = elements(tree).filter((node) => typeof node.props.onDone === "function")
    .map((node) => (node.props.row as { patientName: string }).patientName);
  expect(rows).toEqual(["Synthetic missed patient", "Synthetic lapsed patient"]);
  expect(contents(tree)).not.toContain("✓ تم التواصل مع جميع المرضى");
}
function assertWrite(action: Action, index = 0) {
  const [url, init] = writes()[index];
  expect(url).toBe(action.url);
  expect(init?.method).toBe(action.method);
  expect(JSON.parse(String(init?.body))).toEqual(action.body);
}

beforeEach(async () => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.changed = false;
  hooks.effects.clear();
  hooks.memos.clear();
  hooks.pending = [];
  vi.clearAllMocks();
  read = async () => response(200, structuredClone(initialFeed));
  write = async () => response(200, { ok: true });
  fetchMock.mockImplementation((url, init) => {
    if (init?.method) return write();
    if (url === "/api/recall?weeks=6" || url === "/api/recall?weeks=12") return read();
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render();
  await flush();
  expect(reads()).toHaveLength(1);
});
afterEach(() => {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

describe.each(actions)("recall mutation refusal: $name", (action) => {
  it.each([401, 403, 409, 500])("retains the server's %s refusal without issuing a success refresh", async (status) => {
    write = async () => response(status, { message: `Synthetic refusal ${status}` });
    invoke(action);
    await flush();
    expect(alerts()).toEqual([`Synthetic refusal ${status}`]);
    expect(writes()).toHaveLength(1);
    assertWrite(action);
    expect(reads()).toHaveLength(1);
    assertOriginalRows();
    assertUnlocked();
  });

  it("retains the fallback when a refusal body cannot be decoded", async () => {
    write = async () => ({ ...response(409, null), json: async () => { throw new Error("Synthetic unreadable body"); } }) as Response;
    invoke(action);
    await flush();
    expect(alerts()).toEqual([action.fallback]);
    expect(reads()).toHaveLength(1);
    assertOriginalRows();
    assertUnlocked();
  });

  it.each([
    ["refusal", 200], ["refusal", 500], ["network", 200], ["network", 500],
  ] as const)("keeps the %s failure when an unrelated delayed GET finishes with %s", async (outcome, status) => {
    const command = deferred<Response>();
    const refresh = deferred<Response>();
    write = () => command.promise;
    invoke(action);
    read = () => refresh.promise;
    const filter = find((node) => node.type === "button" && contents(node).trim() === "أكثر من ٣ أشهر");
    (filter.props.onClick as () => void)();
    render();
    expect(reads()).toHaveLength(2);
    const message = outcome === "network" ? "تعذّر الاتصال بالخادم." : "Synthetic command refused";
    if (outcome === "network") command.reject(new Error("Synthetic disconnected command"));
    else command.resolve(response(409, { message }));
    await flush();
    expect(alerts()).toEqual([message]);
    refresh.resolve(status === 200
      ? response(200, { ...initialFeed, weeks: 12 })
      : response(500, { message: "Synthetic unrelated read failed" }));
    await flush();
    expect(alerts()).toEqual([message]);
    expect(reads()).toHaveLength(2);
    expect(writes()).toHaveLength(1);
    assertOriginalRows();
    assertUnlocked();
  });

  it("an explicit retry clears only the command error until its canonical read succeeds", async () => {
    const command = deferred<Response>();
    const refresh = deferred<Response>();
    write = () => command.promise;
    invoke(action);
    read = () => refresh.promise;
    const filter = find((node) => node.type === "button" && contents(node).trim() === "أكثر من ٣ أشهر");
    (filter.props.onClick as () => void)();
    render();
    refresh.resolve(response(500, { message: "Synthetic current read error" }));
    command.resolve(response(409, { message: "Synthetic command refusal" }));
    await flush();
    expect(alerts()).toEqual(["Synthetic command refusal"]);
    const retry = deferred<Response>();
    write = () => retry.promise;
    read = async () => response(200, emptyFeed);
    invoke(action);
    render();
    expect(alerts()).toEqual(["Synthetic current read error"]);
    expect(reads()).toHaveLength(2);
    retry.resolve(response(200, { ok: true }));
    await flush();
    expect(alerts()).toEqual([]);
    expect(writes()).toHaveLength(2);
    expect(reads()).toHaveLength(3);
    expect(contents(render())).toContain("✓ تم التواصل مع جميع المرضى");
  });

  it("retains a network failure without refreshing or retrying the mutation", async () => {
    write = async () => { throw new Error("Synthetic disconnected"); };
    invoke(action);
    await flush();
    expect(alerts()).toEqual(["تعذّر الاتصال بالخادم."]);
    expect(writes()).toHaveLength(1);
    expect(reads()).toHaveLength(1);
    assertOriginalRows();
    assertUnlocked();
  });

  it("refreshes only after a successful write and shows the canonical returned list", async () => {
    read = async () => response(200, emptyFeed);
    invoke(action);
    await flush();
    expect(writes()).toHaveLength(1);
    assertWrite(action);
    expect(reads()).toHaveLength(2);
    expect(alerts()).toEqual([]);
    expect(contents(render())).toContain("✓ تم التواصل مع جميع المرضى");
    expect(contents(render())).not.toContain("Synthetic pending patient");
  });

  it("allows an explicit retry after refusal and clears the old error on successful refresh", async () => {
    write = async () => response(409, { message: "Synthetic changed state" });
    invoke(action);
    await flush();
    expect(alerts()).toEqual(["Synthetic changed state"]);
    assertUnlocked();
    write = async () => response(200, { ok: true });
    read = async () => response(200, emptyFeed);
    invoke(action);
    await flush();
    expect(writes()).toHaveLength(2);
    assertWrite(action, 1);
    expect(reads()).toHaveLength(2);
    expect(alerts()).toEqual([]);
    expect(contents(render())).toContain("✓ تم التواصل مع جميع المرضى");
  });

  it("keeps the synchronous duplicate-submit lock through refusal and releases it for a retry", async () => {
    const pending = deferred<Response>();
    write = () => pending.promise;
    invoke(action);
    invoke(action);
    invoke(actions.find((other) => other.name !== action.name)!);
    expect(writes()).toHaveLength(1);
    pending.resolve(response(409, { message: "Synthetic refusal" }));
    await flush();
    assertUnlocked();
    expect(alerts()).toEqual(["Synthetic refusal"]);
    write = async () => response(409, { message: "Synthetic second refusal" });
    invoke(action);
    await flush();
    expect(writes()).toHaveLength(2);
    expect(reads()).toHaveLength(1);
    expect(alerts()).toEqual(["Synthetic second refusal"]);
    assertUnlocked();
  });

  it("reports a failed refresh after success without inventing an empty list or repeating the write", async () => {
    read = async () => response(500, { message: "Synthetic refresh failed" });
    invoke(action);
    await flush();
    expect(writes()).toHaveLength(1);
    expect(reads()).toHaveLength(2);
    expect(alerts()).toEqual(["Synthetic refresh failed"]);
    assertOriginalRows();
    assertUnlocked();
  });

  it("keeps duplicate commands blocked while the successful write's canonical refresh is pending", async () => {
    const refresh = deferred<Response>();
    read = () => refresh.promise;
    invoke(action);
    await flush();
    expect(writes()).toHaveLength(1);
    expect(reads()).toHaveLength(2);
    invoke(action);
    invoke(actions.find((other) => other.name !== action.name)!);
    expect(writes()).toHaveLength(1);
    refresh.resolve(response(200, structuredClone(initialFeed)));
    await flush();
    expect(alerts()).toEqual([]);
    assertOriginalRows();
    assertUnlocked();
  });

  it("preserves the existing successful-status refresh behavior with an unreadable response body", async () => {
    write = async () => ({ ...response(200, null), json: async () => { throw new Error("Synthetic unreadable success"); } }) as Response;
    read = async () => response(200, emptyFeed);
    invoke(action);
    await flush();
    expect(writes()).toHaveLength(1);
    expect(reads()).toHaveLength(2);
    expect(alerts()).toEqual([]);
    expect(contents(render())).toContain("✓ تم التواصل مع جميع المرضى");
  });
});
