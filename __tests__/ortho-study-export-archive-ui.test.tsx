import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoStudyExportArchive } from "../components/OrthoStudyExportArchive";
import type { SessionInfo } from "../components/SessionProvider";
// Real component handlers with synthetic hooks/network; browser acceptance is separate.
const hooks = vi.hoisted(() => ({
  session: { username: "synthetic-doctor", role: "doctor", permissions: null } as SessionInfo | null,
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
    const index = slot(undefined), previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => { const index = slot({ current: initial }); return hooks.values[index]; },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.(); const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.(); const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});

vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const textOf = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" && "props" in node ? textOf((node as Element).props.children as ReactNode) : "";
let props = { patientId: 1, orthoCaseId: 2, revisionId: 3, revisionHash: "a".repeat(64) };
let outerKey: string | null = null;
const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const job = (patch: Record<string, unknown> = {}) => ({ id: 10, revisionId: 3, revisionHash: "a".repeat(64), format: "illustrated-pptx",
  state: "queued", generation: 0, creatorId: 7, createdAt: "2026-11-10T01:00:00.000Z", updatedAt: "2026-11-10T01:00:00.000Z", failureCode: null, artifact: null, ...patch });
function retire() {
  hooks.effects.forEach(effect => effect.cleanup?.()); hooks.values.length = 0; hooks.effects.clear(); hooks.memos.clear(); hooks.pending.length = 0; outerKey = null;
}
function render(): ReactNode {
  for (let round = 0; round < 20; round++) {
    hooks.cursor = 0; hooks.changed = false;
    const wrapper = OrthoStudyExportArchive(props);
    if (!wrapper) { retire(); return null; }
    if (outerKey !== wrapper.key) { retire(); outerKey = wrapper.key; }
    const tree = (wrapper.type as (input: unknown) => ReactNode)(wrapper.props);
    hooks.pending.splice(0).forEach(effect => effect());
    if (!hooks.changed) return tree;
  }
  throw Error("Archive did not settle");
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); render(); };
const open = async () => { const details = nodes(render()).find(node => node.type === "details")!;
  (details.props.onToggle as (event: unknown) => void)({ currentTarget: { open: true } }); render(); await flush(); };
const button = (label: string) => { const found = nodes(render()).find(node => node.type === "button" && textOf(node) === label);
  if (!found) throw Error(`Missing ${label}`); return found; };
const click = (label: string) => { const found = button(label); expect(found.props.disabled).not.toBe(true); (found.props.onClick as () => void)(); render(); };
const posts = () => fetchMock.mock.calls.filter(([, init]) => init.method === "POST");
beforeEach(() => {
  retire(); props = { patientId: 1, orthoCaseId: 2, revisionId: 3, revisionHash: "a".repeat(64) };
  hooks.session = { userId: 7, username: "Synthetic", role: "doctor", permissions: { canExportOrthoStudies: true } as SessionInfo["permissions"] };
  fetchMock.mockReset(); fetchMock.mockImplementation(async () => ok({ ok: true, jobs: [], next: null })); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { retire(); vi.unstubAllGlobals(); });

describe("saved study export archive", () => {
  it("stays collapsed without fetching and performs only a scoped GET on opening", async () => {
    expect(textOf(render())).toBe("ملفات التصدير المحفوظة"); expect(fetchMock).not.toHaveBeenCalled();
    await open(); expect(fetchMock).toHaveBeenCalledTimes(1); expect(posts()).toHaveLength(0);
    const [url, init] = fetchMock.mock.calls[0]; expect(url).toBe("/api/ortho/2/case-study/exports?patientId=1&revisionId=3");
    expect(init.credentials).toBe("same-origin"); expect(init.redirect).toBe("error");
    expect(textOf(render())).toContain("لا يوجد تشغيل تلقائي في الخلفية");
  });

  it("retains the exact reserve command after uncertain responses and blocks a synchronous double-click", async () => {
    await open(); let reject!: (error: Error) => void;
    fetchMock.mockImplementation((_url, init) => init.method === "POST" ? new Promise((_resolve, fail) => { reject = fail; }) : Promise.resolve(ok({ ok: true, jobs: [], next: null })));
    const handler = button("حفظ طلب تصدير جديد").props.onClick as () => void; handler(); handler(); render();
    expect(posts()).toHaveLength(1); const body = posts()[0][1].body;
    const command = JSON.parse(body).command; expect(command).toMatchObject({ revisionId: 3, revisionHash: props.revisionHash, format: "illustrated-pptx" });
    reject(Error("private/path/raw-secret")); await flush();
    expect(textOf(render())).not.toContain("raw-secret");
    expect(nodes(render()).find(node => node.type === "select")?.props.disabled).toBe(true);
    fetchMock.mockImplementation(async () => ok({ ok: true, job: job() }));
    click("التحقق بإعادة نفس طلب التصدير"); await flush(); expect(posts()).toHaveLength(2); expect(posts()[1][1].body).toBe(body);
    expect(textOf(render())).toContain("تجهيز الملف"); expect(posts().filter(([url]) => String(url).endsWith("/run"))).toHaveLength(0);
  });

  it("runs only the selected creator job with current generation, then exposes a private ready download", async () => {
    fetchMock.mockImplementation(async () => ok({ ok: true, jobs: [job({ generation: 2 })], next: null })); await open();
    expect(nodes(render()).filter(node => node.type === "a")).toHaveLength(0);
    fetchMock.mockImplementation(async () => ok({ ok: true, job: job({ generation: 3, state: "ready", artifact: { sha256: "b".repeat(64), sizeBytes: 123, pageCount: 2, createdAt: "2026-11-10T01:00:00.000Z" } }) }));
    const handler = button("تجهيز الملف").props.onClick as () => void; handler(); handler(); await flush();
    expect(posts()).toHaveLength(1); expect(posts()[0][0]).toBe("/api/ortho/2/case-study/exports/10/run");
    expect(JSON.parse(posts()[0][1].body)).toEqual({ patientId: 1, expectedGeneration: 2 });
    const link = nodes(render()).find(node => node.type === "a")!;
    expect(link.props.href).toBe("/api/ortho/2/case-study/exports/10/download?patientId=1");
    expect(textOf(render())).not.toContain("إعادة محاولة تجهيز");
  });

  it("does not run another creator's job even for an administrator", async () => {
    hooks.session = { userId: 8, username: "Other", role: "admin" };
    fetchMock.mockImplementation(async () => ok({ ok: true, jobs: [job()], next: null })); await open();
    expect(nodes(render()).filter(node => node.type === "button").map(textOf)).not.toContain("تجهيز الملف");
  });

  it("recovers a generation conflict through an explicit refresh without an automatic rerun", async () => {
    fetchMock.mockImplementation(async () => ok({ ok: true, jobs: [job({ generation: 2 })], next: null })); await open();
    fetchMock.mockImplementation(async () => ({ ok: false, status: 409, json: async () => ({ message: "raw/private-error" }) }));
    click("تجهيز الملف"); await flush(); expect(posts()).toHaveLength(1); expect(textOf(render())).not.toContain("private-error");
    fetchMock.mockImplementation(async () => ok({ ok: true, jobs: [job({ generation: 3, state: "failed", failureCode: "lease_expired" })], next: null }));
    click("تحديث حالة الملفات"); await flush(); expect(posts()).toHaveLength(1);
    fetchMock.mockImplementation(async () => ok({ ok: true, job: job({ generation: 4, state: "running" }) }));
    click("إعادة محاولة تجهيز الملف"); await flush();
    expect(JSON.parse(posts()[1][1].body).expectedGeneration).toBe(3);
  });

  it("ignores a delayed reserve acknowledgement after changing permission ownership", async () => {
    await open(); let resolve!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise(done => { resolve = done; }));
    click("حفظ طلب تصدير جديد"); const signal = posts()[0][1].signal as AbortSignal;
    hooks.session = { ...hooks.session!, permissions: { ...hooks.session!.permissions, canViewImaging: false } as SessionInfo["permissions"] };
    render(); expect(signal.aborted).toBe(true); resolve(ok({ ok: true, job: job() })); await flush();
    expect(textOf(render())).toBe("ملفات التصدير المحفوظة"); expect(posts()).toHaveLength(1);
  });

  it.each(["revision", "role", "grant", "unmount"])("ignores delayed responses after %s changes", async change => {
    let resolve!: (value: unknown) => void; fetchMock.mockImplementation(() => new Promise(done => { resolve = done; }));
    await open(); const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    if (change === "revision") props = { ...props, revisionId: 4, revisionHash: "b".repeat(64) };
    else if (change === "role") hooks.session = { ...hooks.session!, role: "admin" };
    else if (change === "grant") hooks.session = { ...hooks.session!, permissions: null };
    else { retire(); }
    if (change !== "unmount") render();
    expect(signal.aborted).toBe(true); resolve(ok({ ok: true, jobs: [job()], next: null })); await flush();
    expect(textOf(render())).not.toContain("طلب رقم");
  });

  it("withdraws existing receipts after server grant denial and never renders raw server messages", async () => {
    fetchMock.mockImplementation(async () => ok({ ok: true, jobs: [job()], next: null })); await open();
    fetchMock.mockImplementation(async () => ({ ok: false, status: 403, json: async () => ({ message: "/private/raw-secret" }) }));
    click("تحديث حالة الملفات"); await flush();
    expect(textOf(render())).toContain("لم تعد صلاحية التصدير"); expect(textOf(render())).not.toContain("raw-secret");
    expect(nodes(render()).filter(node => node.type === "button" || node.type === "a")).toHaveLength(0);
  });

  it("rejects receipts for another revision rather than showing their download or metadata", async () => {
    fetchMock.mockImplementation(async () => ok({ ok: true, jobs: [job({ revisionId: 99 })], next: null })); await open();
    expect(textOf(render())).toContain("لم يتأكد الطلب"); expect(textOf(render())).not.toContain("طلب رقم");
  });
});

