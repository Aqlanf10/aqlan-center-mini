import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebCephRecordsGrid } from "../components/WebCephRecordsGrid";

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
const document = (extra: Record<string, unknown> = {}) => ({ id: 51, patientId: 11, orthoCaseId: 21,
  title: "Synthetic case A image", isImage: true, photoView: "lateral_ceph", photoStage: "initial",
  takenOn: null, uploadedAt: "2026-10-04T01:00:00Z", removedAt: null, ...extra });
const study = (extra: Record<string, unknown> = {}) => ({ id: 61, patientId: 11, orthoCaseId: 21,
  documentId: 51, phase: "pretreatment", status: "draft", ...extra });
const fetchMock = vi.fn();
let props: Parameters<typeof WebCephRecordsGrid>[0];
let read: (url: string) => unknown;
let write: (url: string) => unknown;
let location: { href: string };
function render(effects = true) {
  let tree: ReturnType<typeof WebCephRecordsGrid> | null = null;
  let round = 0;
  do {
    if (++round > 20) throw new Error("Records component did not settle");
    hooks.cursor = 0; hooks.changed = false; tree = WebCephRecordsGrid(props);
    if (effects) hooks.pending.splice(0).forEach(effect => effect());
  } while (hooks.changed && effects);
  return tree;
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function ready() { render(); await settle(); render(); await settle(); render(); }
const find = (predicate: (node: Element) => boolean) => {
  const found = nodes(render()).find(predicate); if (!found) throw new Error("Missing records control"); return found;
};
const button = (label: string) => find(n => n.type === "button" && text(n).includes(label));
const invoke = (node: Element) => (node.props.onClick as () => unknown)();
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === "POST");
const imageSources = (tree = render()) => nodes(tree).filter(node => node.type === "img").map(node => node.props.src);
const picker = () => find(n => n.type === "input" && n.props.type === "file");
function selectFile(input = picker()) {
  return (input.props.onChange as (event: unknown) => unknown)({ target: { files: [new File(["synthetic"], "synthetic.png", { type: "image/png" })] } });
}
function unmount() { hooks.effects.forEach(effect => effect.cleanup?.()); hooks.effects.clear(); }
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  hooks.role = "doctor"; hooks.username = "synthetic-doctor";
  hooks.permissions = { canViewAllPatients: true, canViewXrays: true, canUploadXrays: true }; hooks.loggedOut = false;
  fetchMock.mockReset(); props = { patientId: 11, orthoCaseId: 21 };
  read = (url) => response(url.endsWith("/documents") ? { documents: [document()] } : { analyses: [study()] });
  write = () => response({ id: 71 }, 201);
  fetchMock.mockImplementation((url: string, init?: RequestInit) => Promise.resolve(init?.method === "POST" ? write(url) : read(url)));
  location = { href: "" }; vi.stubGlobal("window", { location }); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("case record slot ownership", () => {
  it("fills slots only from the current case and keeps other/unassigned images as explicit references", async () => {
    read = url => response(url.endsWith("/documents") ? { documents: [
      document({ id: 52, orthoCaseId: 20, title: "Historical image" }),
      document({ id: 53, orthoCaseId: null, title: "Unassigned image", photoView: "profile" }), document(),
    ] } : { analyses: [study({ id: 62, orthoCaseId: 20 }), study({ id: 63, orthoCaseId: null, documentId: 53 }), study()] });
    await ready(); expect(imageSources()).toEqual(["/api/documents/51"]);
    expect(text(render())).toContain("Historical image"); expect(text(render())).toContain("Unassigned image");
    expect(nodes(render()).some(n => n.type === "a" && n.props.href === "/api/documents/53")).toBe(true);
    expect(nodes(render()).some(n => n.type === "a" && n.props.href === "/ceph/63" && text(n).includes("بلا ربط بحالة"))).toBe(true);
    invoke(button("فتح التحليل (#61)")); expect(location.href).toBe("/ceph/61"); expect(writes()).toHaveLength(0);
  });
  it.each([null, 20])("never automatically opens or replaces an analysis with case link %s", async orthoCaseId => {
    read = url => response(url.endsWith("/documents") ? { documents: [document()] } : { analyses: [study({ orthoCaseId })] });
    await ready(); expect(text(render())).toContain("راجع التحليل المرجعي أدناه");
    invoke(button("راجع التحليل المرجعي أدناه")); expect(location.href).toBe(""); expect(writes()).toHaveLength(0);
    expect(nodes(render()).some(n => n.type === "a" && n.props.href === "/ceph/61")).toBe(true);
  });
  it("does not display removed images returned to an admin", async () => {
    hooks.role = "admin"; read = url => response(url.endsWith("/documents") ? { documents: [document({ removedAt: "2026-10-04" })] } : { analyses: [] });
    await ready(); expect(imageSources()).toEqual([]); expect(text(render())).not.toContain("Synthetic case A image");
  });
  it("filters the same case by stage without assigning a stage to untagged images", async () => {
    read = url => response(url.endsWith("/documents") ? { documents: [document({ id: 52, photoStage: "progress" }), document()] } : { analyses: [] });
    await ready(); expect(imageSources()).toEqual(["/api/documents/52"]); invoke(button("صور البداية"));
    expect(imageSources()).toEqual(["/api/documents/51"]); expect(writes()).toHaveLength(0);
  });
});

describe("record reads fail closed and retire old owners", () => {
  it.each([401, 403, 500])("keeps failed HTTP %s distinct from empty and retries without mutations", async status => {
    read = () => response({}, status); await ready(); expect(text(render())).toContain("هذا لا يعني عدم وجود صور");
    expect(imageSources()).toEqual([]); expect(nodes(render()).filter(n => n.props["data-testid"]?.toString().startsWith("ortho-record-slot"))).toHaveLength(0);
    read = url => response(url.endsWith("/documents") ? { documents: [] } : { analyses: [] });
    invoke(button("إعادة تحميل")); await ready(); expect(button("+ رفع السيفالو")).toBeDefined(); expect(writes()).toHaveLength(0);
  });
  it.each(["network", "json", "shape", "foreign-patient", "missing-link"])("hides all controls on %s failure", async kind => {
    read = () => kind === "network" ? Promise.reject(new Error("Synthetic")) : kind === "json"
      ? { ok: true, json: async () => { throw new Error("Synthetic"); } }
      : response(kind === "shape" ? {} : { documents: [document(kind === "foreign-patient" ? { patientId: 99 } : { orthoCaseId: undefined })], analyses: [] });
    await ready(); expect(text(render())).toContain("هذا لا يعني عدم وجود صور"); expect(imageSources()).toEqual([]); expect(writes()).toHaveLength(0);
  });
  it("does not infer empty analysis history when just the analysis read fails", async () => {
    read = url => url.endsWith("/documents") ? response({ documents: [document()] }) : response({}, 500);
    await ready(); expect(imageSources()).toEqual([]); expect(text(render())).toContain("هذا لا يعني عدم وجود صور"); expect(writes()).toHaveLength(0);
  });
  it.each(["fetch", "body"])("bounds a stalled %s and ignores its late result after retry", async phase => {
    vi.useFakeTimers(); const pending = deferred<unknown>();
    read = () => phase === "fetch" ? pending.promise : { ok: true, json: () => pending.promise };
    await ready(); await vi.advanceTimersByTimeAsync(15_000); render(); expect(text(render())).toContain("هذا لا يعني عدم وجود صور");
    expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    read = url => response(url.endsWith("/documents") ? { documents: [document({ id: 55 })] } : { analyses: [] });
    invoke(button("إعادة تحميل")); await ready(); pending.resolve(phase === "fetch" ? response({ documents: [document()], analyses: [] }) : { documents: [document()], analyses: [] });
    await ready(); expect(imageSources()).toEqual(["/api/documents/55"]); expect(writes()).toHaveLength(0);
  });
  it("masks ready images synchronously and retires retained navigation across case A → B → A", async () => {
    await ready(); const oldButton = button("فتح التحليل (#61)"); props = { ...props, orthoCaseId: 22 };
    read = url => response(url.endsWith("/documents") ? { documents: [document({ id: 52, orthoCaseId: 22 })] } : { analyses: [] });
    expect(imageSources(render(false))).toEqual([]); await ready(); invoke(oldButton); expect(location.href).toBe("");
    props = { ...props, orthoCaseId: 21 }; read = url => response(url.endsWith("/documents") ? { documents: [document({ id: 55 })] } : { analyses: [] });
    await ready(); invoke(oldButton); expect(location.href).toBe(""); expect(imageSources()).toEqual(["/api/documents/55"]);
  });
  it("ignores a late old-patient body and aborts pending reads on unmount", async () => {
    const old = deferred<unknown>(); read = () => ({ ok: true, json: () => old.promise }); await ready();
    props = { patientId: 12, orthoCaseId: 22 }; read = url => response(url.endsWith("/documents") ? { documents: [] } : { analyses: [] });
    await ready(); old.resolve({ documents: [document()], analyses: [study()] }); await ready(); expect(imageSources()).toEqual([]);
    unmount(); expect((fetchMock.mock.calls.at(-1)?.[1].signal as AbortSignal).aborted).toBe(true);
  });
  it.each(["logout", "permission", "principal"])("retires ready images and old navigation on %s change", async mode => {
    await ready(); const oldButton = button("فتح التحليل (#61)");
    if (mode === "logout") hooks.loggedOut = true;
    if (mode === "permission") hooks.permissions = { ...hooks.permissions, canViewXrays: false };
    if (mode === "principal") { hooks.username = "another-doctor"; read = () => response({}, 403); }
    expect(imageSources(render(false))).toEqual([]); await ready(); invoke(oldButton);
    expect(location.href).toBe(""); expect(writes()).toHaveLength(0); expect(imageSources()).toEqual([]);
  });
});

describe("record action ownership", () => {
  it("opens existing and created canonical PostgreSQL string IDs", async () => {
    read = url => response(url.endsWith("/documents") ? { documents: [document()] } : { analyses: [study({ id: "61" })] });
    await ready(); invoke(button("فتح التحليل (#61)")); expect(location.href).toBe("/ceph/61");
    props = { ...props, orthoCaseId: 22 }; read = url => response(url.endsWith("/documents") ? { documents: [document({ orthoCaseId: 22 })] } : { analyses: [] });
    write = () => response({ id: "71" }, 201); await ready(); invoke(button("بدء التتبع والتحليل")); await ready();
    expect(location.href).toBe("/ceph/71"); expect(writes()).toHaveLength(1);
  });
  it("permits an existing exact-case analysis for a read-only doctor but not upload or creation", async () => {
    hooks.permissions.canUploadXrays = false; await ready();
    expect(picker().props.disabled).toBe(true); invoke(button("فتح التحليل (#61)")); expect(location.href).toBe("/ceph/61");
    invoke(button("استبدال")); await selectFile(); await settle(); expect(writes()).toHaveLength(0);
  });
  it("creates only one analysis on repeated clicks, with the current case, and ignores late foreign-owner navigation", async () => {
    const pending = deferred<unknown>(); read = url => response(url.endsWith("/documents") ? { documents: [document()] } : { analyses: [] });
    write = () => pending.promise; await ready(); const launch = button("بدء التتبع والتحليل"); invoke(launch); invoke(launch);
    expect(writes()).toHaveLength(1); expect(JSON.parse(writes()[0][1].body).orthoCaseId).toBe(21);
    props = { patientId: 12, orthoCaseId: 22 }; read = url => response(url.endsWith("/documents") ? { documents: [] } : { analyses: [] }); await ready();
    pending.resolve(response({ id: 71 }, 201)); await ready(); expect(location.href).toBe("");
  });
  it("does not accept a file picker retained from a previous case", async () => {
    await ready(); invoke(button("استبدال")); const oldInput = picker();
    props = { ...props, orthoCaseId: 22 }; await ready(); await selectFile(oldInput); await settle(); expect(writes()).toHaveLength(0);
  });
  it("uploads once and treats failed post-save refresh as unknown, without duplicate upload or auto-created analysis", async () => {
    await ready(); invoke(button("استبدال")); const input = picker(); const pending = deferred<unknown>(); write = () => pending.promise;
    selectFile(input); selectFile(input); expect(writes()).toHaveLength(1);
    expect((writes()[0][1].body as FormData).get("orthoCaseId")).toBe("21");
    read = () => response({}, 500); pending.resolve(response({ id: 71 }, 201)); await ready();
    expect(text(render())).toContain("هذا لا يعني عدم وجود صور"); expect(writes()).toHaveLength(1); expect(location.href).toBe("");
  });
});
