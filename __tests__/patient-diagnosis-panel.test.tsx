import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientDiagnosis } from "../components/PatientDiagnosis";

// Real component handlers/effects, synthetic hooks and transport. This is not a
// browser/DOM test or an authorization substitute for the API/PG regressions.
const hooks = vi.hoisted(() => ({
  permissions: { canViewAllPatients: true } as Record<string, boolean>, loggedOut: false,
  values: [] as unknown[], cursor: 0, changed: false, username: "synthetic-doctor", role: "doctor",
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void; phase: "layout" | "passive" }>(),
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
    useCallback: (callback: unknown, deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.memos.get(index);
      if (previous && same(previous.deps, deps)) return previous.value;
      hooks.memos.set(index, { deps, value: callback });
      return callback;
    },
    useMemo: (compute: () => unknown, deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.memos.get(index);
      if (previous && same(previous.deps, deps)) return previous.value;
      const value = compute(); hooks.memos.set(index, { deps, value }); return value;
    },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, phase: "layout", cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, phase: "passive", cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});

vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.loggedOut ? null : ({ role: hooks.role, username: hooks.username, permissions: hooks.permissions }) }));
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const version = (extra: Record<string, unknown> = {}) => ({ id: 51, version: 7, orthoCaseId: 21,
  content: { note: "Synthetic case A diagnosis" }, label: null, createdBy: "Synthetic doctor", createdAt: "2026-10-04T01:00:00Z", ...extra });
const fetchMock = vi.fn(), onError = vi.fn();
let props: Parameters<typeof PatientDiagnosis>[0];
let read: (url: string) => unknown;
let write: () => unknown;
function render(effects = true) {
  let tree: ReturnType<typeof PatientDiagnosis> | null = null;
  let round = 0;
  do {
    if (++round > 20) throw new Error("Diagnosis component did not settle");
    hooks.cursor = 0; hooks.changed = false; tree = PatientDiagnosis(props);
    if (effects) hooks.pending.splice(0).forEach(effect => effect());
  } while (hooks.changed && effects);
  return tree;
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function ready() { render(); await settle(); render(); await settle(); render(); }
const find = (predicate: (node: Element) => boolean) => {
  const found = nodes(render()).find(predicate); if (!found) throw new Error("Missing diagnosis control"); return found;
};
const button = (label: string) => find(n => n.type === "button" && text(n).includes(label));
const invoke = (node: Element) => (node.props.onClick as () => unknown)();
const form = () => find(n => typeof n.props.onSave === "function");
const save = (node = form()) => (node.props.onSave as (content: Record<string, string>, label: string) => Promise<void>)({ note: "Synthetic update" }, "Synthetic label");
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === "POST");
const canOpen = () => nodes(render()).some(n => n.type === "button" && text(n).startsWith("+"));
function unmount() { hooks.effects.forEach(effect => effect.cleanup?.()); hooks.effects.clear(); }
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  hooks.role = "doctor"; hooks.username = "synthetic-doctor"; hooks.permissions = { canViewAllPatients: true }; hooks.loggedOut = false; fetchMock.mockReset(); onError.mockReset();
  props = { patientId: 11, orthoCaseId: 21, onError };
  read = () => response({ diagnoses: [version()] }); write = () => response({ id: 52, version: 8 }, 201);
  fetchMock.mockImplementation((url: string, init?: RequestInit) => Promise.resolve(init?.method === "POST" ? write() : read(url)));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("case diagnosis read integrity", () => {
  it("requests only the explicit case and labels global version numbers without inventing case version 1", async () => {
    await ready(); expect(fetchMock).toHaveBeenCalledWith("/api/patients/11/diagnoses?orthoCaseId=21",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
    expect(text(render())).toContain("Synthetic case A diagnosis"); expect(text(render())).toContain("نسخة 7");
    expect(text(render())).toContain("أول تشخيص مسجل لهذه الحالة"); expect(text(render())).toContain("سجل المريض الكامل");
    expect(writes()).toHaveLength(0);
  });
  it.each([401, 403, 500])("keeps HTTP %s distinct from absence, and retries read-only", async (status) => {
    read = () => response({}, status); await ready();
    expect(text(render())).toContain("هذا لا يعني عدم وجود تشخيص"); expect(text(render())).not.toContain("لا تشخيص سريري مسجل لهذه الحالة بعد");
    expect(canOpen()).toBe(false); read = () => response({ diagnoses: [] }); invoke(button("إعادة تحميل")); await ready();
    expect(text(render())).toContain("لا تشخيص سريري مسجل لهذه الحالة بعد"); expect(canOpen()).toBe(true); expect(writes()).toHaveLength(0);
  });
  it.each(["network", "json", "shape", "other-case", "standalone", "duplicate", "content"])("fails closed on %s", async (kind) => {
    read = () => kind === "network" ? Promise.reject(new Error("Synthetic network")) : kind === "json"
      ? { ok: true, json: async () => { throw new Error("Synthetic JSON"); } } : response(kind === "shape" ? {} : { diagnoses:
        kind === "other-case" ? [version({ orthoCaseId: 22 })] : kind === "standalone" ? [version({ orthoCaseId: null })]
          : kind === "duplicate" ? [version(), version()] : [version({ content: { note: {} } })] });
    await ready(); expect(text(render())).toContain("هذا لا يعني عدم وجود تشخيص"); expect(canOpen()).toBe(false);
    expect(text(render())).not.toContain("Synthetic case A diagnosis"); expect(writes()).toHaveLength(0);
  });
  it("masks old case immediately and ignores a late body across A → B → A", async () => {
    const old = deferred<unknown>(); read = () => ({ ok: true, json: () => old.promise }); await ready();
    const oldSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    props = { ...props, orthoCaseId: 22 }; read = () => response({ diagnoses: [version({ id: 52, orthoCaseId: 22, content: { note: "Synthetic B" } })] });
    expect(text(render(false))).not.toContain("Synthetic case A"); await ready(); expect(oldSignal.aborted).toBe(true);
    props = { ...props, orthoCaseId: 21 }; read = () => response({ diagnoses: [version({ id: 53, content: { note: "New A" } })] }); await ready();
    old.resolve({ diagnoses: [version()] }); await ready(); expect(text(render())).toContain("New A"); expect(text(render())).not.toContain("Synthetic case A diagnosis");
  });
  it("retires already-ready records and form callbacks when this principal loses patient scope", async () => {
    await ready(); invoke(button("+ تحديث")); const oldForm = form();
    hooks.permissions = { canViewAllPatients: false }; read = () => response({}, 403);
    expect(text(render(false))).not.toContain("Synthetic case A diagnosis"); await ready();
    expect(canOpen()).toBe(false); await save(oldForm); expect(writes()).toHaveLength(0);
    expect(text(render())).toContain("هذا لا يعني عدم وجود تشخيص");
    hooks.permissions = { canViewAllPatients: true }; read = () => response({ diagnoses: [version({ content: { note: "Revalidated A" } })] });
    await ready(); expect(text(render())).toContain("Revalidated A"); await save(oldForm); expect(writes()).toHaveLength(0);
  });
  it("masks ready records and disables retained writes on logout without another fetch", async () => {
    await ready(); invoke(button("+ تحديث")); const oldForm = form(), calls = fetchMock.mock.calls.length;
    hooks.loggedOut = true; expect(text(render(false))).not.toContain("Synthetic case A diagnosis"); await ready();
    await save(oldForm); expect(writes()).toHaveLength(0); expect(fetchMock).toHaveBeenCalledTimes(calls); expect(canOpen()).toBe(false);
  });
  it.each(["fetch", "body"])("bounds a stalled %s, permits retry, and ignores the late original result", async (phase) => {
    vi.useFakeTimers(); const stalled = deferred<unknown>();
    read = () => phase === "fetch" ? stalled.promise : { ok: true, json: () => stalled.promise };
    await ready(); expect(text(render())).toContain("جارٍ التحميل"); await vi.advanceTimersByTimeAsync(15_000); render();
    expect(text(render())).toContain("هذا لا يعني عدم وجود تشخيص"); expect(canOpen()).toBe(false);
    expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    read = () => response({ diagnoses: [version({ content: { note: "Recovered case" } })] }); invoke(button("إعادة تحميل")); await ready();
    stalled.resolve(phase === "fetch" ? response({ diagnoses: [version()] }) : { diagnoses: [version()] }); await ready();
    expect(text(render())).toContain("Recovered case"); expect(text(render())).not.toContain("Synthetic case A diagnosis"); expect(writes()).toHaveLength(0);
  });
  it("retires a pending read on patient or session change and on unmount", async () => {
    const old = deferred<unknown>(); read = () => ({ ok: true, json: () => old.promise }); await ready();
    props = { ...props, patientId: 12 }; hooks.username = "replacement-doctor"; read = () => response({ diagnoses: [] }); await ready();
    old.resolve({ diagnoses: [version()] }); await ready(); expect(text(render())).not.toContain("Synthetic case A diagnosis");
    unmount(); expect((fetchMock.mock.calls.at(-1)?.[1].signal as AbortSignal).aborted).toBe(true);
  });
});

describe("case diagnosis authoring containment", () => {
  it.each(["reception", "assistant", "cashier", "accountant"])("does not offer authoring for %s", async (role) => {
    hooks.role = role; await ready(); expect(canOpen()).toBe(false); expect(writes()).toHaveLength(0);
  });
  it("posts exact patient/case once under repeated submission and refreshes its case", async () => {
    await ready(); invoke(button("+ تحديث")); const draft = form(), pending = deferred<unknown>(); write = () => pending.promise;
    const a = save(draft); const b = save(draft); expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe("/api/patients/11/diagnoses");
    expect(JSON.parse(writes()[0][1].body)).toEqual({ content: { note: "Synthetic update" }, label: "Synthetic label", orthoCaseId: 21 });
    pending.resolve(response({ id: 52, version: 8 }, 201)); await Promise.all([a, b]); await ready();
    expect(canOpen()).toBe(true); await save(draft); expect(writes()).toHaveLength(1);
  });
  it("cancel retires the old form callback across reopening", async () => {
    await ready(); invoke(button("+ تحديث")); const old = form(); (old.props.onCancel as () => void)();
    invoke(button("+ تحديث")); await save(old); expect(writes()).toHaveLength(0); await save(); expect(writes()).toHaveLength(1);
  });
  it("rejects retained old-case callbacks and ignores an old write completion", async () => {
    await ready(); invoke(button("+ تحديث")); const old = form(), pending = deferred<unknown>(); write = () => pending.promise; const writing = save(old);
    props = { ...props, patientId: 12, orthoCaseId: 22 }; read = () => response({ diagnoses: [] }); await ready();
    await save(old); expect(writes()).toHaveLength(1); onError.mockClear();
    pending.resolve(response({ message: "Old case refusal" }, 403)); await writing; await ready(); expect(onError).not.toHaveBeenCalled();
    expect(canOpen()).toBe(true); expect(fetchMock.mock.calls.filter(([url]) => url === "/api/patients/12/diagnoses?orthoCaseId=22")).toHaveLength(1);
  });
  it("does not turn successful write plus failed refresh into an empty history or automatic retry", async () => {
    await ready(); invoke(button("+ تحديث")); read = () => response({}, 503); await save(); await ready();
    expect(text(render())).toContain("هذا لا يعني عدم وجود تشخيص"); expect(canOpen()).toBe(false); expect(writes()).toHaveLength(1);
  });
  it.each(["fetch", "body"])("releases the save latch after success even when its refresh %s stalls", async (phase) => {
    vi.useFakeTimers(); await ready(); invoke(button("+ تحديث"));
    const stalled = deferred<unknown>(); read = () => phase === "fetch" ? stalled.promise : { ok: true, json: () => stalled.promise };
    await save(); await ready(); expect(writes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000); render(); expect(canOpen()).toBe(false);
    read = () => response({ diagnoses: [version({ content: { note: "Refreshed after timeout" } })] });
    invoke(button("إعادة تحميل")); await ready(); invoke(button("+ تحديث")); expect(form()).toBeDefined();
    expect(writes()).toHaveLength(1); // a read recovery never resubmits the diagnosis
    stalled.resolve(phase === "fetch" ? response({ diagnoses: [version()] }) : { diagnoses: [version()] }); await ready();
    expect(text(render())).toContain("Refreshed after timeout"); expect(form()).toBeDefined();
  });
  it("keeps refused writes reviewable without automatic retry", async () => {
    await ready(); invoke(button("+ تحديث")); write = () => response({ message: "Synthetic refusal" }, 400); await save(); await ready();
    expect(onError).toHaveBeenLastCalledWith("Synthetic refusal"); expect(form()).toBeDefined(); expect(writes()).toHaveLength(1);
  });
});
