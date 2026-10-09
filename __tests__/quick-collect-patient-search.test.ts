import type { DependencyList, EffectCallback, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickCollectModal } from "../components/finance/QuickCollectModal";

// Deterministic component lifecycle/retained-callback audit using the established
// manual-hook harness pattern. This is NOT browser or backend execution; the
// separate security-http suite exercises the built app with actual role cookies.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, effectCursor: 0, dirty: false,
  effects: [] as { deps?: DependencyList; cleanup?: ReturnType<EffectCallback> }[],
  pending: [] as { index: number; deps?: DependencyList; run: EffectCallback }[],
}));
const authority = vi.hoisted(() => ({
  current: null as { username: string; role: string; permissions?: Record<string, unknown> | null } | null,
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => authority.current }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  function slot(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  }
  function effect(run: EffectCallback, deps?: DependencyList) {
    const index = hooks.effectCursor++;
    const previous = hooks.effects[index];
    if (!previous || !deps || !previous.deps || deps.length !== previous.deps.length
      || deps.some((value, at) => !Object.is(value, previous.deps![at]))) {
      hooks.pending.push({ index, deps, run });
    }
  }
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => {
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.dirty = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useLayoutEffect: effect, useEffect: effect,
  };
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children as ReactNode);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
type ResponseLike = { ok: boolean; status: number; json: () => Promise<unknown> };
const response = (body: unknown, status = 200): ResponseLike => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const alice = { id: 98101, patientNumber: "QA-ALPHA", fullName: "Alice synthetic", phone: null };
const bob = { id: 98102, patientNumber: "QA-BETA", fullName: "Bob synthetic", phone: null };
const fetchMock = vi.fn();
const onClose = vi.fn();
const onSelectPatient = vi.fn();
const requests: { query: string; pending: ReturnType<typeof deferred<ResponseLike>> }[] = [];
let open = true;
let debtors: { patientId: number; patientName: string; phone: null; currency: "SAR"; dueMinor: number }[] = [];
function render() {
  let tree: ReturnType<typeof QuickCollectModal>;
  let commits = 0;
  do {
    if (commits++ > 12) throw new Error("Unexpected component render loop");
    hooks.dirty = false; hooks.cursor = 0; hooks.effectCursor = 0; hooks.pending = [];
    tree = QuickCollectModal({ isOpen: open, onClose, onSelectPatient, debtors, currency: "YER" });
    for (const { index, deps, run } of hooks.pending) {
      const cleanup = hooks.effects[index]?.cleanup;
      if (typeof cleanup === "function") cleanup();
      hooks.effects[index] = { deps, cleanup: run() };
    }
  } while (hooks.dirty);
  const all = elements(tree);
  return {
    tree, all,
    input: all.find((item) => item.type === "input")!,
    choices: all.filter((item) => item.type === "button" && /Alice synthetic|Bob synthetic/.test(text(item))),
    close: all.find((item) => item.type === "button" && text(item) === "إلغاء")!,
  };
}
function click(element: Element) { (element.props.onClick as () => void)(); }
function change(value: string, commit = true) {
  (render().input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  if (commit) render();
}
async function start(query: string) {
  const before = requests.length;
  change(query);
  await vi.advanceTimersByTimeAsync(200);
  expect(requests.length).toBe(before + 1);
  return requests.at(-1)!;
}
async function finish(request: typeof requests[number], rows: unknown, status = 200) {
  request.pending.resolve(response(rows, status));
  await vi.advanceTimersByTimeAsync(0);
  return render();
}
const names = () => render().choices.map((element) => text(element));

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effectCursor = 0; hooks.dirty = false; hooks.effects = []; hooks.pending = [];
  authority.current = { username: "cashier-a", role: "cashier", permissions: { financeAccess: { collectPayments: true } } };
  open = true; debtors = []; requests.length = 0;
  vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((url: string) => {
    if (!url.startsWith("/api/patients?q=")) throw new Error("Unexpected fetch in isolated search test");
    const pending = deferred<ResponseLike>();
    requests.push({ query: decodeURIComponent(url.split("?q=")[1]), pending });
    return pending.promise;
  });
  render();
});
afterEach(() => {
  for (const entry of hooks.effects) if (typeof entry.cleanup === "function") entry.cleanup();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("cash-desk patient choices belong to the current query and open principal", () => {
  it("preserves the 200ms debounce, trimming and minimum query length", async () => {
    change(" A "); await vi.advanceTimersByTimeAsync(300); expect(requests).toHaveLength(0);
    change(" Alice "); await vi.advanceTimersByTimeAsync(199); expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); expect(requests[0].query).toBe("Alice");
  });
  it("does not issue a superseded debounce or a closed-modal lookup", async () => {
    change("Alice"); await vi.advanceTimersByTimeAsync(100); change("Bob");
    await vi.advanceTimersByTimeAsync(200); expect(requests.map((item) => item.query)).toEqual(["Bob"]);
    open = false; render(); await vi.advanceTimersByTimeAsync(400); expect(requests).toHaveLength(1);
  });
  it("ignores older successful response headers after the latest result", async () => {
    const old = await start("Alice"); const latest = await start("Bob");
    await finish(latest, [bob]); await finish(old, [alice]);
    expect(names()).toEqual([expect.stringContaining("Bob synthetic")]);
  });
  it("checks ownership again after an already-started JSON body completes", async () => {
    const old = await start("Alice"); const body = deferred<unknown>();
    old.pending.resolve({ ok: true, status: 200, json: () => body.promise });
    await vi.advanceTimersByTimeAsync(0);
    const latest = await start("Bob"); await finish(latest, [bob]);
    body.resolve([alice]); await vi.advanceTimersByTimeAsync(0);
    expect(names()).toEqual([expect.stringContaining("Bob synthetic")]);
  });
  it("withdraws choices and rejects a retained result callback before the edit commits", async () => {
    await finish(await start("Alice"), [alice]); const stale = render().choices[0];
    change("Bob", false); click(stale);
    expect(onSelectPatient).not.toHaveBeenCalled(); expect(names()).toEqual([]);
  });
  it("retires default-debtor callbacks synchronously on query change", () => {
    debtors = [{ patientId: alice.id, patientName: alice.fullName, phone: null, currency: "SAR", dueMinor: 7500 }];
    const stale = render().choices[0]; change("Bob", false); click(stale);
    expect(onSelectPatient).not.toHaveBeenCalled(); expect(names()).toEqual([]);
  });
  it("preserves explicit current debtor currency/amount and permits selection only once", () => {
    debtors = [{ patientId: alice.id, patientName: alice.fullName, phone: null, currency: "SAR", dueMinor: 7500 }];
    const choice = render().choices[0]; click(choice); click(choice);
    expect(onSelectPatient).toHaveBeenCalledExactlyOnceWith({ id: alice.id, name: alice.fullName, currency: "SAR", dueMinor: 7500 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("clearing a query prevents its late result from repopulating choices", async () => {
    const old = await start("Alice"); change(""); await finish(old, [alice]);
    expect(names()).toEqual([]); expect(render().input.props.value).toBe("");
  });
  it("close retires a retained callback before the parent removes the modal", async () => {
    await finish(await start("Alice"), [alice]); const stale = render().choices[0];
    click(render().close); click(stale);
    expect(onClose).toHaveBeenCalledTimes(1); expect(onSelectPatient).not.toHaveBeenCalled();
  });
  it("same-query reopen accepts only the new lifetime's response", async () => {
    const old = await start("Alice"); click(render().close); open = false; render();
    open = true; render(); expect(render().input.props.value).toBe("");
    const latest = await start("Alice"); await finish(latest, [bob]); await finish(old, [alice]);
    expect(names()).toEqual([expect.stringContaining("Bob synthetic")]);
    click(render().choices[0]); expect(onSelectPatient.mock.calls[0][0].id).toBe(bob.id);
  });
  it.each(["username", "role", "permissions", "null"])("retires choices across a %s owner transition and its ABA return", async (kind) => {
    const initial = authority.current;
    await finish(await start("Alice"), [alice]); const stale = render().choices[0];
    const pending = await start("Pending");
    authority.current = kind === "null" ? null : { ...initial!,
      ...(kind === "username" ? { username: "cashier-b" } : {}),
      ...(kind === "role" ? { role: "reception" } : {}),
      ...(kind === "permissions" ? { permissions: { financeAccess: { collectPayments: false } } } : {}),
    };
    expect(render().tree).toBeNull(); authority.current = initial;
    expect(render().tree).toBeNull(); click(stale);
    await finish(pending, [alice]);
    expect(onSelectPatient).not.toHaveBeenCalled(); expect(names()).toEqual([]);
    open = false; render(); open = true; render();
    await finish(await start("Bob"), [bob]); expect(names()).toEqual([expect.stringContaining("Bob synthetic")]);
  });
  it("closes on principal change with nonempty parent debtor props and requires an explicit reopen", () => {
    debtors = [{ patientId: alice.id, patientName: alice.fullName, phone: null, currency: "SAR", dueMinor: 7500 }];
    const initial = authority.current;
    const stale = render().choices[0];
    authority.current = { username: "cashier-b", role: "cashier" };
    expect(render().tree).toBeNull(); click(stale);
    expect(onClose).toHaveBeenCalledTimes(1); expect(onSelectPatient).not.toHaveBeenCalled();
    authority.current = initial; expect(render().tree).toBeNull(); click(stale);
    expect(onSelectPatient).not.toHaveBeenCalled();
    open = false; render(); open = true;
    expect(render().choices).toHaveLength(1);
    // This only proves explicit modal re-entry. The parent owns freshness of
    // the permitted debtor projection; this test does not certify its balance.
  });
  it("withholds parent debtor figures when current cashier ledger visibility is denied", async () => {
    debtors = [{ patientId: alice.id, patientName: alice.fullName, phone: null, currency: "SAR", dueMinor: 7500 }];
    render();
    authority.current = { username: "cashier-a", role: "cashier", permissions: {
      financeAccess: { collectPayments: true, viewPatientLedger: false },
    } };
    expect(render().tree).toBeNull();
    open = false; render(); open = true;
    expect(render().choices).toEqual([]);
    expect(text(render().tree)).toContain("المديونيات مخفية بحسب صلاحيات الحساب");
    await finish(await start("Alice"), [alice]);
    const choice = render().choices[0];
    expect(text(choice)).not.toContain("مستحق:");
    click(choice);
    expect(onSelectPatient.mock.calls[0][0]).toEqual({ id: alice.id, name: alice.fullName,
      currency: undefined, dueMinor: undefined });
  });
  it("does not offer collection for an accountant even with inherited open props", () => {
    authority.current = { username: "accountant-a", role: "accountant" };
    debtors = [{ patientId: alice.id, patientName: alice.fullName, phone: null, currency: "SAR", dueMinor: 7500 }];
    expect(render().tree).toBeNull(); expect(requests).toHaveLength(0);
    expect(onSelectPatient).not.toHaveBeenCalled();
  });
  it("a stale failure cannot clear a newer successful choice or loading state", async () => {
    const old = await start("Alice"); const current = await start("Bob");
    await finish(current, [bob]); old.pending.reject(new Error("AbortError"));
    await vi.advanceTimersByTimeAsync(0); expect(names()).toEqual([expect.stringContaining("Bob synthetic")]);
  });
  it("an old rejection/finally cannot stop the newer request's loading indicator", async () => {
    const old = await start("Alice"); const current = await start("Bob");
    old.pending.reject(new Error("AbortError")); await vi.advanceTimersByTimeAsync(0);
    expect(render().all.some((item) => typeof item.props.className === "string"
      && item.props.className.includes("animate-spin"))).toBe(true);
    await finish(current, [bob]);
    expect(names()).toEqual([expect.stringContaining("Bob synthetic")]);
  });
  it("rejects a current failed or malformed response and permits a same-text fresh attempt", async () => {
    await finish(await start("Alice"), [alice], 403); expect(names()).toEqual([]);
    await finish(await start("Alice "), { wrong: [alice] }); expect(names()).toEqual([]);
    await finish(await start("Alice"), [alice]);
    const choice = render().choices[0]; click(choice); click(choice);
    expect(onSelectPatient).toHaveBeenCalledTimes(1); expect(onSelectPatient.mock.calls[0][0].id).toBe(alice.id);
  });
});
