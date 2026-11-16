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
      const value = Object.freeze(compute()); hooks.memos.set(index, { deps, value }); return value;
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

describe("modern patient panels immutable render identity", () => {
  it("loads and saves with frozen memo identities while keeping the duplicate-write latch", async () => {
    await ready(); invoke(button("+ تحديث"));
    const draft = form(), pending = deferred<unknown>(); write = () => pending.promise;
    const first = save(draft), duplicate = save(draft);
    expect(writes()).toHaveLength(1);
    pending.resolve(response({ id: 52, version: 8 }, 201));
    await Promise.all([first, duplicate]); await ready();
    expect(canOpen()).toBe(true);
    await save(draft); expect(writes()).toHaveLength(1);
  });
  it("retires a writer synchronously before another render commits", async () => {
    await ready(); invoke(button("+ تحديث")); const old = form();
    (old.props.onCancel as () => void)();
    await save(old); expect(writes()).toHaveLength(0);
    invoke(button("+ تحديث")); const next = form();
    await save(old); expect(writes()).toHaveLength(0);
    await save(next); expect(writes()).toHaveLength(1);
  });
  it("retired runtime cannot publish late results into a fresh instance of the same case", async () => {
    const pending = deferred<unknown>(); read = () => ({ ok: true, json: () => pending.promise });
    await ready(); const oldSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    props = { ...props, orthoCaseId: 22 }; read = () => response({ diagnoses: [] }); await ready();
    props = { ...props, orthoCaseId: 21 }; read = () => response({ diagnoses: [version({ content: { note: "Current runtime" } })] }); await ready();
    pending.resolve({ diagnoses: [version({ content: { note: "Retired runtime" } })] }); await ready();
    expect(oldSignal.aborted).toBe(true);
    expect(text(render())).toContain("Current runtime");
    expect(text(render())).not.toContain("Retired runtime"); expect(writes()).toHaveLength(0);
  });
});
