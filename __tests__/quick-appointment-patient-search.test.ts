import type { DependencyList, EffectCallback, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAppointmentModal } from "../components/QuickAppointmentModal";

// Tests only. Run the real component's state, effects, cleanup and rendered event
// handlers with manually committed React hooks. No DOM/window, app, API route,
// database, bootstrap, or live fetch is imported/executed.
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
// Modal's native dialog/window effects are outside this isolated hook audit.
vi.mock("../components/Modal", () => ({ Modal: () => null }));

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
const onClose = vi.fn();
const onSuccess = vi.fn();
const alice = { id: 91001, patientNumber: "AUDIT-A", fullName: "Alice Existing", phone: null };
const bob = { id: 91002, patientNumber: "AUDIT-B", fullName: "Bob Existing", phone: null };
let open = true;
function render() {
  let tree: ReturnType<typeof QuickAppointmentModal>;
  let commits = 0;
  do {
    if (commits++ > 10) throw new Error("Unexpected render loop in hook harness");
    hooks.dirty = false;
    hooks.cursor = 0;
    hooks.effectCursor = 0;
    hooks.pending = [];
    tree = QuickAppointmentModal({ isOpen: open, onClose, onSuccess });
    for (const { index, deps, run } of hooks.pending) {
      const oldCleanup = hooks.effects[index]?.cleanup;
      if (typeof oldCleanup === "function") oldCleanup();
      hooks.effects[index] = { deps, cleanup: run() };
    }
  } while (hooks.dirty);
  const all = elements(tree);
  return {
    tree, all,
    find: (predicate: (element: Element) => boolean) => {
      const found = all.find(predicate);
      if (!found) throw new Error("Missing rendered control");
      return found;
    },
    results: () => all.filter((element) => element.type === "li")
      .map((li) => elements(li).find((element) => element.type === "button")!),
    submit: () => (all.find((element) => element.type === "form")!.props.onSubmit as
      (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: vi.fn() }),
  };
}
function changeQuery(value: string) {
  const input = render().find((element) => element.props.id === "patient-search-audit-patient");
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  return render();
}
function click(element: Element) { (element.props.onClick as () => void)(); }
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children as ReactNode);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
const resultNames = () => render().results().map((element) => text(element));
const patientCreates = () => fetchMock.mock.calls.filter(([url, init]) => url === "/api/patients" && init?.method === "POST");
const bookings = () => fetchMock.mock.calls.filter(([url, init]) => url === "/api/appointments" && init?.method === "POST");
const searches = new Map<string, ReturnType<typeof deferred<ReturnType<typeof response>>>>();
async function resolveSearch(query: string, body: unknown) {
  const request = searches.get(query);
  if (!request) throw new Error(`Search not started: ${query}`);
  request.resolve(response(200, body));
  await vi.advanceTimersByTimeAsync(0);
  return render();
}
async function startSearch(query: string) {
  changeQuery(query);
  await vi.advanceTimersByTimeAsync(300);
  expect(searches.has(query)).toBe(true);
}

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effectCursor = 0;
  hooks.effects = []; hooks.pending = []; hooks.dirty = false;
  open = true; searches.clear(); vi.clearAllMocks(); vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/patients?q=")) {
      const query = decodeURIComponent(url.split("?q=")[1]);
      const request = deferred<ReturnType<typeof response>>();
      searches.set(query, request);
      return request.promise;
    }
    if (url === "/api/parties?kind=doctor") return Promise.resolve(response(200, []));
    if (url === "/api/settings/appointment-services") return Promise.resolve(response(200, { services: [], chairs: 0 }));
    if (url === "/api/patients" && init?.method === "POST") return Promise.resolve(response(201, { id: 91999 }));
    if (url === "/api/appointments" && init?.method === "POST") return Promise.resolve(response(201, { id: 92999 }));
    throw new Error(`Unexpected mocked fetch: ${url}`);
  });
  render();
});
afterEach(() => {
  for (const effect of hooks.effects) if (typeof effect.cleanup === "function") effect.cleanup();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("quick appointment patient search lifecycle audit", () => {
  it("starts only after 300 ms for an open, eligible trimmed query", async () => {
    changeQuery(" A ");
    await vi.advanceTimersByTimeAsync(400);
    expect(searches.size).toBe(0);
    changeQuery("  Bob Existing  ");
    await vi.advanceTimersByTimeAsync(299);
    expect(searches.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect([...searches.keys()]).toEqual(["Bob Existing"]);
    open = false; render();
    await vi.advanceTimersByTimeAsync(500);
    expect(searches.size).toBe(1);
  });

  it("keeps current-query matches when an older empty search resolves last", async () => {
    await startSearch("Bob typo");
    await startSearch("Bob Existing");
    await resolveSearch("Bob Existing", [bob]);
    expect(resultNames()).toEqual([expect.stringContaining("Bob Existing")]);
    await resolveSearch("Bob typo", []);
    // Desired invariant. Fails on the audited source: the old request erases Bob.
    expect(resultNames()).toEqual([expect.stringContaining("Bob Existing")]);
  });

  it("preserves the existing-patient choice and books that selection after an older empty response", async () => {
    await startSearch("Bob typo");
    await startSearch("Bob Existing");
    await resolveSearch("Bob Existing", [bob]);
    await resolveSearch("Bob typo", []);
    expect(render().find((element) => element.props.id === "patient-search-audit-patient").props.value).toBe("Bob Existing");
    const choices = render().results();
    expect.soft(choices).toHaveLength(1);
    // After a fix, explicitly choose the preserved existing patient. On the
    // audited source there is no choice: continue the normal empty-results
    // submit path to expose its synthetic patient-create + new-ID booking.
    // This does NOT require auto-selection or globally forbid new patients.
    if (choices.length === 1) click(choices[0]);
    await render().submit();
    expect.soft(patientCreates()).toHaveLength(0);
    expect(bookings()).toHaveLength(1);
    expect(JSON.parse(bookings()[0][1].body)).toMatchObject({ patientId: bob.id, isNewPatient: false });
  });

  it("removes previous-query choices immediately while the newer search is pending", async () => {
    await startSearch("Alice");
    await resolveSearch("Alice", [alice]);
    expect(resultNames()).toEqual([expect.stringContaining("Alice Existing")]);
    changeQuery("Bob Existing");
    expect(resultNames()).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    await resolveSearch("Bob Existing", [bob]);
    expect(resultNames()).toEqual([expect.stringContaining("Bob Existing")]);
  });

  it("does not repopulate selectable results after the query is cleared", async () => {
    await startSearch("Alice");
    changeQuery("");
    expect(resultNames()).toEqual([]);
    await resolveSearch("Alice", [alice]);
    // Desired invariant. Fails: Alice becomes selectable under a blank input.
    expect(resultNames()).toEqual([]);
  });

  it("retains the explicitly selected patient despite an older request completing", async () => {
    await startSearch("Alice");
    await startSearch("Bob Existing");
    await resolveSearch("Bob Existing", [bob]);
    click(render().results()[0]); render();
    await resolveSearch("Alice", [alice]);
    expect(resultNames()).toEqual([]); // Selected-patient UI hides matches.
    await render().submit();
    expect(patientCreates()).toHaveLength(0);
    expect(JSON.parse(bookings()[0][1].body)).toMatchObject({ patientId: bob.id, isNewPatient: false });
  });

  it("cancels a superseded debounce before its fetch starts", async () => {
    changeQuery("Alice");
    await vi.advanceTimersByTimeAsync(200);
    changeQuery("Bob Existing");
    await vi.advanceTimersByTimeAsync(300);
    expect([...searches.keys()]).toEqual(["Bob Existing"]);
  });

  it("ignores a closed-session response and refreshes the retained query on reopen", async () => {
    await startSearch("Alice");
    const oldRequest = searches.get("Alice");
    click(render().find((element) => element.props["aria-label"] === "إغلاق"));
    open = false; expect(render().tree).toBeNull();
    await resolveSearch("Alice", [alice]);
    open = true; render();
    // Do not require results to stay empty: only reject the previous session's
    // response before the fresh search is allowed to resolve.
    expect.soft(resultNames()).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect.soft(searches.get("Alice")).not.toBe(oldRequest);
    await resolveSearch("Alice", [alice]);
    expect(resultNames()).toEqual([expect.stringContaining("Alice Existing")]);
  });

  it("does not replace a reopened dialog's newer query with a pre-close response", async () => {
    await startSearch("Alice");
    click(render().find((element) => element.props["aria-label"] === "إغلاق"));
    expect(onClose).toHaveBeenCalledTimes(1);
    open = false; expect(render().tree).toBeNull();
    open = true; render();
    await startSearch("Bob Existing");
    await resolveSearch("Bob Existing", [bob]);
    expect(resultNames()).toEqual([expect.stringContaining("Bob Existing")]);
    await resolveSearch("Alice", [alice]);
    // Same current-query invariant across a real parent close/reopen cycle.
    expect(resultNames()).toEqual([expect.stringContaining("Bob Existing")]);
  });

  it("ignores an older body that finishes parsing after the newer results", async () => {
    await startSearch("Alice");
    const body = deferred<unknown>();
    const parse = vi.fn(() => body.promise);
    searches.get("Alice")!.resolve({ ok: true, status: 200, json: parse });
    await vi.advanceTimersByTimeAsync(0);
    expect(parse).toHaveBeenCalledTimes(1);
    await startSearch("Bob Existing");
    await resolveSearch("Bob Existing", [bob]);
    body.resolve([alice]);
    await vi.advanceTimersByTimeAsync(0);
    expect(resultNames()).toEqual([expect.stringContaining("Bob Existing")]);
  });

  it.each(["clear", "close", "select", "unmount"])(
    "invalidates a parsing response on %s even if the fetch mock ignores abort",
    async (interruption) => {
      await startSearch("Alice");
      const signal = fetchMock.mock.calls.find(([url]) => url === "/api/patients?q=Alice")![1].signal as AbortSignal;
      const body = deferred<unknown>();
      const parse = vi.fn(() => body.promise);
      searches.get("Alice")!.resolve({ ok: true, status: 200, json: parse });
      await vi.advanceTimersByTimeAsync(0);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(signal.aborted).toBe(false);

      if (interruption === "clear") changeQuery("");
      if (interruption === "close") { open = false; render(); }
      if (interruption === "select") {
        await startSearch("Bob Existing");
        await resolveSearch("Bob Existing", [bob]);
        click(render().results()[0]); render();
      }
      if (interruption === "unmount") {
        for (const effect of hooks.effects) if (typeof effect.cleanup === "function") effect.cleanup();
      }
      expect(signal.aborted).toBe(true);
      hooks.dirty = false;
      body.resolve([alice]);
      await vi.advanceTimersByTimeAsync(0);
      // No state setter runs after cleanup, including after a full unmount.
      expect(hooks.dirty).toBe(false);
      if (interruption !== "unmount") expect(resultNames()).toEqual([]);
      if (interruption === "select") {
        await render().submit();
        expect(patientCreates()).toHaveLength(0);
        expect(JSON.parse(bookings()[0][1].body)).toMatchObject({ patientId: bob.id, isNewPatient: false });
      }
    },
  );

  it("cancels the debounce when closed before any patient request starts", async () => {
    changeQuery("Alice");
    await vi.advanceTimersByTimeAsync(200);
    open = false; render();
    await vi.advanceTimersByTimeAsync(500);
    expect(searches.size).toBe(0);
    open = true; render();
    await vi.advanceTimersByTimeAsync(300);
    expect([...searches.keys()]).toEqual(["Alice"]);
  });

  it("allows editing and a successful fresh lookup after a response or parsing failure", async () => {
    await startSearch("Alice");
    searches.get("Alice")!.resolve(response(500, [alice]));
    await vi.advanceTimersByTimeAsync(0);
    expect(resultNames()).toEqual([]);
    await startSearch("Alice malformed");
    searches.get("Alice malformed")!.resolve({ ok: true, status: 200, json: async () => { throw new Error("invalid JSON"); } });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultNames()).toEqual([]);
    await startSearch("Bob Existing");
    await resolveSearch("Bob Existing", [bob]);
    expect(resultNames()).toEqual([expect.stringContaining("Bob Existing")]);
  });
});
