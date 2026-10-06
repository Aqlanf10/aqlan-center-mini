import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DentalChart } from "../components/DentalChart";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../lib/doctor-permissions";
import type { SessionInfo } from "../components/SessionProvider";
import { CONDITION_LABEL, STAGE_LABEL, toothName, type ToothRecord } from "../lib/dental";

// Deterministic source-level lifetime regressions: real components and handlers
// execute, but hooks are simulated. The separate browser fixture exercises real
// React development StrictMode; these tests are not browser/DOM evidence.
type Scope = {
  values: unknown[]; cursor: number; live: boolean;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>;
};
const hooks = vi.hoisted(() => ({
  current: null as Scope | null, changed: false, retiredWrites: 0,
  layout: [] as Array<() => void>, passive: [] as Array<() => void>,
  session: null as SessionInfo | null, contexts: new Map<unknown, unknown>(),
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const scope = () => { if (!hooks.current) throw new Error("Hook outside a component scope"); return hooks.current; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b
    && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const owner = scope(); const index = owner.cursor++; const prior = owner.memos.get(index);
    if (prior && same(prior.deps, deps)) return prior.value;
    const value = factory(); owner.memos.set(index, { deps, value }); return value;
  };
  const effect = (callback: () => void | (() => void), deps: readonly unknown[] | undefined, layout: boolean) => {
    const owner = scope(); const index = owner.cursor++; const prior = owner.effects.get(index);
    if (prior && same(prior.deps, deps)) return;
    const entry = { deps, cleanup: undefined as (() => void) | undefined }; owner.effects.set(index, entry);
    (layout ? hooks.layout : hooks.passive).push(() => {
      if (!owner.live) return; prior?.cleanup?.(); entry.cleanup = callback() || undefined;
    });
  };
  return { ...react,
    createContext: (initial: unknown) => { const context = { initial }; return Object.assign(context, { Provider: context }); },
    useContext: (context: { initial: unknown }) => hooks.contexts.has(context) ? hooks.contexts.get(context) : context.initial,
    useState: (initial: unknown) => {
      const owner = scope(); const index = owner.cursor++;
      if (!(index in owner.values)) owner.values[index] = typeof initial === "function" ? initial() : initial;
      return [owner.values[index], (update: unknown) => {
        if (!owner.live) { hooks.retiredWrites++; return; }
        const value = typeof update === "function" ? update(owner.values[index]) : update;
        if (!Object.is(value, owner.values[index])) hooks.changed = true;
        owner.values[index] = value;
      }];
    },
    useRef: (initial: unknown) => {
      const owner = scope(); const index = owner.cursor++;
      if (!(index in owner.values)) owner.values[index] = { current: initial }; return owner.values[index];
    },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(callback, deps, false),
    useLayoutEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(callback, deps, true),
  };
});

type Element = ReactElement<Record<string, unknown>>;
type Component = (props: Record<string, unknown>) => ReactNode;
type ResponseLike = { ok: boolean; status: number; json: () => Promise<unknown> };
type Pending = { url: string; method: string; init?: RequestInit; json: ReturnType<typeof vi.fn>;
  headers: (status?: number) => void; body: (value: unknown) => void; fail: () => void; badJSON: () => void };
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const A: SessionInfo = { username: "synthetic-chart-a", role: "doctor" };
const B: SessionInfo = { username: "synthetic-chart-b", role: "doctor" };
const record = (marker = "accepted-chart-a", toothCode = 11): ToothRecord => ({
  id: 401, toothCode, condition: "filling", stage: "existing", surfaces: "MO", note: marker,
  recordedBy: "synthetic-clinician", recordedAt: "2026-10-05T12:00:00Z", visitId: null,
});
let patientId: number; let requests: Pending[]; let unexpected: string[];
let scopes = new Map<string, Scope>(); let componentIds = new Map<unknown, number>(); let seen = new Set<string>();
let executed = new Set<string>();
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<ResponseLike>>();
function retire(scope: Scope) {
  scope.live = false; scope.effects.forEach((entry) => entry.cleanup?.()); scope.effects.clear();
}
function unmount() {
  scopes.forEach(retire); scopes.clear(); hooks.layout = []; hooks.passive = []; hooks.current = null; hooks.contexts.clear();
}
function execute(component: Component, props: Record<string, unknown>, path: string): ReactNode {
  seen.add(path); let owner = scopes.get(path);
  if (!owner) { owner = { values: [], cursor: 0, live: true, effects: new Map(), memos: new Map() }; scopes.set(path, owner); }
  owner.cursor = 0; const prior = hooks.current; hooks.current = owner;
  executed.add(component.name);
  try { return component(props); } finally { hooks.current = prior; }
}
function expand(node: ReactNode, path: string): ReactNode {
  if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${index}`));
  if (!node || typeof node !== "object" || !("props" in node)) return node;
  const element = node as Element; const identity = `${path}:${String(element.key ?? "")}`;
  if (element.type && typeof element.type === "object" && "initial" in element.type) {
    const had = hooks.contexts.has(element.type); const prior = hooks.contexts.get(element.type);
    hooks.contexts.set(element.type, element.props.value);
    try { return expand(element.props.children as ReactNode, `${identity}/provider`); }
    finally { if (had) hooks.contexts.set(element.type, prior); else hooks.contexts.delete(element.type); }
  }
  // Execute every local function, including forms nested below host elements.
  // Peripheral modules above are explicit null stubs. No parent/form callback,
  // ownership condition, read function, or mutation function is replaced.
  if (typeof element.type === "function") {
    if (!componentIds.has(element.type)) componentIds.set(element.type, componentIds.size);
    const ownerPath = `${identity}/component-${componentIds.get(element.type)}`;
    return expand(execute(element.type as Component, element.props, ownerPath), `${ownerPath}/result`);
  }
  return { ...element, props: { ...element.props, children: expand(element.props.children as ReactNode, `${identity}/children`) } };
}
function render(): ReactNode {
  let tree: ReactNode = null; let rounds = 0;
  do {
    if (++rounds > 30) throw new Error("Dental chart composition did not settle");
    hooks.changed = false; seen = new Set();
    tree = expand(execute(() => DentalChart({ patientId }), {}, "dental-chart"), "dental-chart/result");
    for (const [key, scope] of scopes) if (!seen.has(key)) { retire(scope); scopes.delete(key); }
    hooks.layout.splice(0).forEach((effect) => effect()); hooks.passive.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
}
function one(predicate: (element: Element) => boolean, tree: ReactNode = render()) {
  const matches = elements(tree).filter(predicate); expect(matches).toHaveLength(1); return matches[0];
}

const button = (label: string) => one((node) => node.type === "button" && text(node).trim() === label);
const saveButton = () => button("تثبيت الحالة على المخطط السني");
const note = () => one((node) => node.type === "input" && node.props["aria-label"] === "ملاحظة");
function click(node: Element) { expect(node.props.disabled).not.toBe(true); void (node.props.onClick as () => unknown)(); render(); }
function pick(toothCode = 11) { click(one((node) => node.type === "button" && node.props["aria-label"] === toothName(toothCode))); }
function edit(value: string) { (note().props.onChange as (event: unknown) => void)({ target: { value } }); render(); }
function callback(node: Element) { return node.props.onClick as () => Promise<unknown>; }
async function flush() { for (let n = 0; n < 8; n++) { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); } }
const reads = () => requests.filter((row) => row.method === "GET");
const writes = () => requests.filter((row) => row.method === "POST");
function respond(request: Pending, value: unknown, status = 200) { request.headers(status); request.body(value); }
async function grant(marker = "accepted-chart-a") { respond(reads().at(-1)!, { records: [record(marker)] }); await flush(); }
async function mount() { render(); await grant(); pick(); }
function hidden() {
  const view = render();
  expect(elements(view).filter((node) => node.type === "input" && node.props["aria-label"] === "ملاحظة")).toEqual([]);
  expect(text(view)).not.toMatch(/accepted-chart|private-draft|synthetic-clinician/);
  expect(elements(view).filter((node) => node.type === "section")).toEqual([]);
}
function retireOwner(kind: "patient" | "principal" | "permission" | "unmount") {
  if (kind === "patient") patientId = 20;
  else if (kind === "principal") hooks.session = B;
  else if (kind === "permission") hooks.session = { ...A, permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewAllPatients: false } };
  else { unmount(); return; }
  render();
}
beforeEach(() => {
  unmount(); scopes = new Map(); componentIds = new Map(); executed = new Set(); hooks.changed = false; hooks.retiredWrites = 0;
  patientId = 19; hooks.session = A; requests = []; unexpected = []; fetchMock.mockReset();
  fetchMock.mockImplementation((url, init) => {
    const method = init?.method ?? "GET";
    if (!/^\/api\/patients\/(19|20)\/chart$/.test(url) || !["GET", "POST"].includes(method)) {
      unexpected.push(method + " " + url); return Promise.reject(new Error("Unallowlisted request"));
    }
    const header = deferred<ResponseLike>(), body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    requests.push({ url, method, init, json, headers: (status = 200) => header.resolve({ status, ok: status >= 200 && status < 300, json }),
      body: body.resolve, fail: () => header.reject(new Error("Synthetic offline")),
      badJSON: () => body.reject(new SyntaxError("Synthetic malformed JSON")) });
    // Ignoring AbortSignal is deliberate: ownership must also guard completions.
    return header.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { unmount(); expect(unexpected).toEqual([]); expect(hooks.retiredWrites).toBe(0); vi.unstubAllGlobals(); });

describe("DentalChart patient, tooth and request ownership", () => {
  it("shows accepted current chart and saves to its canonical patient endpoint", async () => {
    await mount(); edit("private-draft current"); click(saveButton());
    expect(writes()).toHaveLength(1);
    expect(writes()[0].url).toBe("/api/patients/19/chart");
    expect(JSON.parse(String(writes()[0].init?.body))).toMatchObject({ toothCode: 11, note: "private-draft current" });
    respond(writes()[0], { id: 402 }, 201); await flush();
    hidden(); expect(reads()).toHaveLength(2); await grant("accepted-chart-refreshed");
    expect(text(render())).toContain("accepted-chart-refreshed");
  });

  it.each(["patient", "principal", "permission"] as const)("clears prior patient data and tooth draft synchronously on %s change", async (kind) => {
    await mount(); edit("private-draft old"); const submit = callback(saveButton());
    retireOwner(kind); hidden();
    await submit(); await flush(); expect(writes()).toHaveLength(0);
    await grant("accepted-chart-b"); pick(); expect(note().props.value).toBe("");
    expect(text(render())).not.toContain("accepted-chart-a");
  });

  it("resets condition, stage, surfaces and note when another tooth is selected", async () => {
    await mount(); click(button(CONDITION_LABEL.filling)); click(button(STAGE_LABEL.planned + "يضاف لخطة العلاج المقترحة"));
    click(button("Mإنسي (Mesial)")); edit("private-draft tooth11");
    const oldSubmit = callback(saveButton()); pick(12);
    expect(note().props.value).toBe("");
    await oldSubmit(); await flush(); expect(writes()).toHaveLength(0);
    click(saveButton());
    expect(JSON.parse(String(writes()[0].init?.body))).toEqual({ toothCode: 12, condition: "caries", stage: "existing", surfaces: null, note: null });
    respond(writes()[0], { message: "Synthetic rejected" }, 409); await flush();
  });

  it("never revives a captured editor callback after tooth A B A", async () => {
    await mount(); edit("private-draft prior tooth"); const old = callback(saveButton());
    pick(12); pick(11); await old(); await flush(); expect(writes()).toHaveLength(0); expect(note().props.value).toBe("");
  });

  it.each(["headers", "body"] as const)("ignores late prior-patient chart %s even if abort is ignored", async (boundary) => {
    render(); const old = reads()[0];
    if (boundary === "body") { old.headers(); await flush(); expect(old.json).toHaveBeenCalledTimes(1); }
    patientId = 20; render(); expect(old.init?.signal?.aborted).toBe(true); await grant("accepted-chart-b"); pick();
    if (boundary === "headers") old.headers(); old.body({ records: [record("accepted-chart-a")] }); await flush();
    expect(text(render())).toContain("accepted-chart-b"); expect(text(render())).not.toContain("accepted-chart-a");
    if (boundary === "headers") expect(old.json).not.toHaveBeenCalled();
  });

  it("retires old patient read errors without hiding the current chart", async () => {
    render(); const old = reads()[0]; patientId = 20; render(); await grant("accepted-chart-b"); pick();
    old.fail(); await flush(); expect(text(render())).toContain("accepted-chart-b"); expect(text(render())).not.toContain("Synthetic offline");
  });

  it("does not revive earlier patient A responses after A B A navigation", async () => {
    render(); const old = reads()[0]; patientId = 20; render(); patientId = 19; render();
    await grant("accepted-chart-new-a"); pick(); respond(old, { records: [record("accepted-chart-old-a")] }); await flush();
    expect(text(render())).toContain("accepted-chart-new-a"); expect(text(render())).not.toContain("accepted-chart-old-a");
  });

  it.each([401, 403, 503])("shows no chart or editor after current read status %i and supports fresh retry", async (status) => {
    render(); respond(reads()[0], { message: "Synthetic read refused" }, status); await flush(); hidden();
    click(button("إعادة تحميل مخطط الأسنان")); await grant(); pick(); expect(text(render())).toContain("accepted-chart-a");
  });

  it("fails closed on a malformed records envelope", async () => {
    render(); respond(reads()[0], { records: null }); await flush(); hidden(); expect(text(render())).toContain("تعذّر قراءة مخطط الأسنان");
  });

  it("keeps a failed-save draft and prevents duplicate dispatch before rerender", async () => {
    await mount(); edit("private-draft retained"); const submit = callback(saveButton());
    const first = submit(), repeated = submit(); expect(writes()).toHaveLength(1);
    respond(writes()[0], { message: "Synthetic rejected" }, 409); await first; await repeated; await flush();
    expect(note().props.value).toBe("private-draft retained"); expect(reads()).toHaveLength(1);
    click(saveButton()); expect(writes()).toHaveLength(2);
    expect(JSON.parse(String(writes()[1].init?.body)).note).toBe("private-draft retained");
    respond(writes()[1], { message: "Synthetic rejected again" }, 409); await flush();
  });

  for (const boundary of ["headers", "body"] as const) {
    it.each(["patient", "principal", "permission"] as const)("never reloads or displays an old save after %s change awaiting " + boundary, async (kind) => {
      await mount(); edit("private-draft old save"); click(saveButton()); const old = writes()[0];
      if (boundary === "body") { old.headers(201); await flush(); }
      retireOwner(kind); await grant("accepted-chart-b"); pick(); edit("private-draft new"); const count = reads().length;
      if (boundary === "headers") old.headers(201); old.body({ id: 999 }); await flush();
      expect(reads()).toHaveLength(count); expect(note().props.value).toBe("private-draft new");
      expect(text(render())).toContain("accepted-chart-b");
      if (boundary === "headers") expect(old.json).not.toHaveBeenCalled();
    });
  }

  it("keeps a newer save busy when an older patient save settles", async () => {
    await mount(); click(saveButton()); const old = writes()[0];
    patientId = 20; render(); await grant("accepted-chart-b"); pick(); click(saveButton());
    respond(old, { message: "Synthetic old rejection" }, 409); await flush();
    expect(button("جارٍ الحفظ...").props.disabled).toBe(true); expect(text(render())).not.toContain("Synthetic old rejection");
    respond(writes()[1], { message: "Synthetic current rejection" }, 409); await flush();
    expect(saveButton().props.disabled).toBe(false);
  });

  it("prevents another tooth draft while a save is in flight but allows closing", async () => {
    await mount(); const other = one((node) => node.type === "button" && node.props["aria-label"] === toothName(12));
    const capturedPick = callback(other); edit("private-draft current"); click(saveButton());
    expect(one((node) => node.type === "button" && node.props["aria-label"] === toothName(12)).props.disabled).toBe(true);
    await capturedPick(); render(); expect(note().props.value).toBe("private-draft current");
    click(one((node) => node.type === "button" && node.props["aria-label"] === "إغلاق"));
    expect(elements(render()).filter((node) => node.type === "section")).toEqual([]);
    respond(writes()[0], { id: 402 }, 201); await flush(); await grant(); pick(12); expect(note().props.value).toBe("");
  });

  it.each(["network", "body", "server", "unauthenticated", "forbidden"] as const)("requires chart reconciliation after %s save uncertainty or lost authorization", async (failure) => {
    await mount(); edit("private-draft uncertain"); const submit = callback(saveButton()); const pending = submit();
    const request = writes()[0];
    if (failure === "network") request.fail();
    else if (failure === "body") { request.headers(201); await flush(); request.badJSON(); }
    else respond(request, { message: "Synthetic failure" }, failure === "server" ? 500 : failure === "forbidden" ? 403 : 401);
    await pending; await flush(); hidden(); expect(text(render())).toContain("تحقّق من السجل قبل إعادة المحاولة");
    await submit(); await flush(); expect(writes()).toHaveLength(1); expect(reads()).toHaveLength(1);
    click(button("إعادة تحميل مخطط الأسنان")); await grant("accepted-chart-reconciled"); pick();
    await submit(); await flush(); expect(writes()).toHaveLength(1);
    expect(text(render())).toContain("accepted-chart-reconciled");
  });

  it.each(["read", "save"] as const)("does not parse or write state for a retired %s after unmount", async (kind) => {
    render();
    if (kind === "save") { await grant(); pick(); click(saveButton()); }
    const old = kind === "read" ? reads().at(-1)! : writes()[0];
    const count = requests.length; unmount(); respond(old, kind === "read" ? { records: [record()] } : { id: 402 }, kind === "read" ? 200 : 201);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(old.json).not.toHaveBeenCalled(); expect(requests).toHaveLength(count); expect(hooks.retiredWrites).toBe(0);
  });

  it("keeps periodontal recording unavailable after clinical chart identity changes", async () => {
    await mount(); click(button("مخطط اللثة (Perio Chart)")); expect(text(render())).toContain("إدخال قياسات اللثة غير متاح");
    expect(elements(render()).filter((node) => node.type === "select")).toEqual([]);
    patientId = 20; render(); await grant("accepted-chart-b");
    click(button("مخطط اللثة (Perio Chart)")); expect(text(render())).toContain("إدخال قياسات اللثة غير متاح");
    expect(writes()).toHaveLength(0);
  });
});
