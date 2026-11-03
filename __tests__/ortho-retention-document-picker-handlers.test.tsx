import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoRetentionDocumentPicker, type OrthoRetentionDocumentPickerProps, type RetentionDocumentEdit } from "../components/OrthoRetentionDocumentPicker";

// Actual component callbacks and real strict parser/body reader, with a
// synthetic hook clock. This is not React reconciliation or native UI proof.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  pending: [] as Array<{ index: number; deps?: readonly unknown[]; callback: () => void | (() => void) }> }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[i], (value: unknown) => { const next = typeof value === "function" ? value(hooks.values[i]) : value;
        if (!Object.is(next, hooks.values[i])) hooks.changed = true; hooks.values[i] = next; }]; },
    useLayoutEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hooks.cursor++, old = hooks.effects.get(index);
      if (old?.deps && deps && old.deps.length === deps.length && old.deps.every((value, i) => Object.is(value, deps[i]))) return;
      hooks.pending.push({ index, deps, callback });
    },
  };
});
type Node = ReactElement<Record<string, unknown>>;
const nodes = (value: ReactNode): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === "object" && "props" in value
  ? [value as Node, ...nodes((value as Node).props.children as ReactNode)] : [];
const text = (value: ReactNode): string => typeof value === "string" || typeof value === "number" ? String(value)
  : Array.isArray(value) ? value.map(text).join("") : value && typeof value === "object" && "props" in value ? text((value as Node).props.children as ReactNode) : "";
const scope = { patientId: 71, orthoCaseId: 81, clinicalCaseId: 91 };
const available = (id: number) => ({ id, version: null, kind: "document", state: "available", unavailableReason: null,
  selection: { key: `document_${id}`, kind: "document", id, version: null, contentHash: "a".repeat(64) } });
const unavailable = (id: number) => ({ id, version: null, kind: "document", state: "unavailable", unavailableReason: "document_removed", selection: null });
const inventory = (choices: unknown[] = [available(101), unavailable(102)], nextAfterId: number | null = null) =>
  ({ ok: true, ...scope, kind: "document", state: "available", choices, nextAfterId });
const response = (raw: unknown = inventory(), headers: Record<string, string> = { "cache-control": "private, no-store" }) => new Response(JSON.stringify(raw), { headers });
const transport = vi.fn(), changed = vi.fn<(request: RetentionDocumentEdit) => boolean>(), denied = vi.fn(), restricted = vi.fn();
let props: Omit<OrthoRetentionDocumentPickerProps, "documentIds" | "onChange">, selected: number[], allowed: boolean, draftVersion: number;
function unmount() {
  hooks.effects.forEach(effect => effect.cleanup?.()); hooks.effects.clear(); hooks.values.length = 0; hooks.pending.length = 0;
}
function render(commit = true): ReactNode {
  for (let n = 0; n < 20; n++) {
    hooks.cursor = 0; hooks.changed = false; hooks.pending.length = 0;
    const capturedDraftVersion = draftVersion;
    const tree = OrthoRetentionDocumentPicker({ ...props, documentIds: selected,
      onChange: request => capturedDraftVersion === draftVersion && changed(request) });
    if (!commit) { hooks.pending.length = 0; return tree; }
    const pending = hooks.pending.splice(0);
    pending.forEach(effect => hooks.effects.get(effect.index)?.cleanup?.());
    pending.forEach(effect => { const cleanup = effect.callback(); hooks.effects.set(effect.index, { deps: effect.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
    if (!hooks.changed) return tree;
  }
  throw new Error("Document picker hook clock did not settle");
}
async function flush() { for (let n = 0; n < 20; n++) await Promise.resolve(); render(); }
function button(name: string, tree = render()): Node {
  const node = nodes(tree).find(node => node.type === "button" && (node.props["aria-label"] === name || text(node) === name));
  if (!node) throw new Error(`Missing ${name}`); return node;
}
const click = (node: Node) => (node.props.onClick as () => void)();
const load = () => click(button("قراءة مستندات الحالة"));
async function ready(raw: unknown = inventory()) { transport.mockResolvedValueOnce(response(raw)); load(); await flush(); return render(); }

beforeEach(() => {
  unmount(); selected = [9]; allowed = true; draftVersion = 0;
  props = { ...scope, ownerIdentity: {}, ownerKey: "actor17:case81:bridge91", generation: 1, readVersion: 1, writable: true,
    isCurrent: () => allowed, onDenied: denied, onRestricted: restricted };
  changed.mockReset(); changed.mockImplementation(request => {
    if (!allowed || request.ownerKey !== props.ownerKey || JSON.stringify(request.expectedDocumentIds) !== JSON.stringify(selected)) return false;
    selected = [...request.documentIds]; draftVersion++; return true;
  });
  denied.mockReset(); restricted.mockReset(); transport.mockReset(); transport.mockResolvedValue(response()); vi.stubGlobal("fetch", transport);
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("actual retention document picker handlers", () => {
  it("does no implicit read or POST; one explicit click issues exactly one bounded same-origin page GET", async () => {
    const initial = render(); expect(transport).not.toHaveBeenCalled(); expect(text(initial)).not.toContain("#9");
    expect(nodes(initial).some(node => node.props["aria-label"] === "إزالة مرجع المستند #9")).toBe(false);
    const capturedLoad = button("قراءة مستندات الحالة", initial); click(capturedLoad); click(capturedLoad); await flush();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe("/api/ortho/81/case-study/sources?patientId=71&kind=document");
    expect(transport.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store", redirect: "error", credentials: "same-origin" });
    expect(transport.mock.calls.every(call => call[1].method === "GET" && call[1].body === undefined)).toBe(true);
    expect(selected).toEqual([9]); expect(changed).not.toHaveBeenCalled();
    expect(text(render())).toContain("#9"); expect(text(render())).toContain("لم تُتحقق إتاحته");
  });
  it("adds only an exact available choice, preserves known historical correction IDs and explicitly removes only the requested ID", async () => {
    selected = [9, 102]; const tree = await ready();
    const unavailableButton = button("إضافة المستند #102", tree); expect(unavailableButton.props.disabled).toBe(true);
    click(unavailableButton); expect(changed).not.toHaveBeenCalled();
    click(button("إضافة المستند #101", tree)); expect(selected).toEqual([9, 102, 101]);
    expect(changed.mock.calls[0][0]).toEqual({ ownerKey: props.ownerKey, expectedDocumentIds: [9, 102], documentIds: [9, 102, 101] });
    click(button("إزالة مرجع المستند #9")); expect(selected).toEqual([102, 101]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(nodes(render()).some(node => node.type === "img" || node.type === "a")).toBe(false);
  });
  it("requires separate explicit pagination and preserves selections across pages", async () => {
    selected = [9, 101]; await ready(inventory(Array.from({ length: 25 }, (_, i) => available(101 + i)), 125));
    transport.mockResolvedValueOnce(response(inventory([available(126)])));
    click(button("الصفحة التالية من المستندات")); await flush();
    expect(transport.mock.calls[1][0]).toBe("/api/ortho/81/case-study/sources?patientId=71&kind=document&afterId=125");
    expect(selected).toEqual([9, 101]); expect(text(render())).toContain("#101");
    click(button("إضافة المستند #126")); expect(selected).toEqual([9, 101, 126]);
    expect(button("الصفحة التالية من المستندات").props.disabled).toBe(true);
  });
  it("retains correction references through empty, restricted, unavailable and failed reads", async () => {
    selected = [9, 102];
    await ready(inventory([])); expect(selected).toEqual([9, 102]); expect(text(render())).toContain("المراجع السابقة لم تُحذف");
    await ready({ ...inventory([]), state: "restricted" }); expect(selected).toEqual([9, 102]);
    expect(text(render())).not.toContain("#9"); expect(text(render())).toContain("مقيّدة");
    await ready(inventory()); expect(text(render())).toContain("غير متاح للاختيار الحالي");
    transport.mockRejectedValueOnce(new Error("synthetic connection loss")); load(); await flush();
    expect(text(render())).toContain("لم تُعتبر القائمة فارغة"); expect(selected).toEqual([9, 102]); expect(changed).not.toHaveBeenCalled();
    expect(text(render())).not.toContain("#9"); expect(text(render())).not.toContain("#102");
  });
  it("does not clear a restricted privacy latch during retry or failed retry", async () => {
    selected = [9, 102]; await ready({ ...inventory([]), state: "restricted" });
    let reject!: (reason: Error) => void;
    transport.mockImplementationOnce(() => new Promise<Response>((_resolve, fail) => { reject = fail; })); load();
    expect(text(render())).not.toContain("#9"); expect(text(render())).not.toContain("#102");
    reject(new Error("synthetic restricted retry failed")); await flush();
    expect(text(render())).not.toContain("#9"); expect(text(render())).not.toContain("#102"); expect(selected).toEqual([9, 102]);
    await ready(inventory([])); expect(text(render())).toContain("#9"); expect(selected).toEqual([9, 102]); expect(changed).not.toHaveBeenCalled();
  });
  it.each(["detach/remount", "writable false/true"] as const)("requires fresh available admission after a restricted same-case %s", async transition => {
    selected = [9, 102]; const admitted = await ready(), oldRemove = button("إزالة مرجع المستند #9", admitted);
    await ready({ ...inventory([]), state: "restricted" });
    expect(text(render())).not.toContain("#9"); expect(text(render())).not.toContain("#102");
    if (transition === "detach/remount") { unmount(); render(); }
    else { props = { ...props, writable: false }; render(); props = { ...props, writable: true }; render(); }
    const unopened = render();
    expect(text(unopened)).not.toContain("#9"); expect(text(unopened)).not.toContain("#102");
    expect(nodes(unopened).some(node => node.props["aria-label"] === "مراجع المستندات المحتفظ بها")).toBe(false);
    click(oldRemove); expect(selected).toEqual([9, 102]); expect(changed).not.toHaveBeenCalled();
    let release!: (response: Response) => void;
    transport.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; })); load();
    expect(text(render())).not.toContain("#9"); expect(text(render())).not.toContain("#102");
    release(response(inventory([]))); await flush();
    expect(text(render())).toContain("#9"); expect(text(render())).toContain("#102");
    expect(text(render())).toContain("لم تُتحقق إتاحته"); expect(selected).toEqual([9, 102]);
    click(button("إزالة مرجع المستند #9")); expect(selected).toEqual([102]);
  });
  it("revokes retained-reference visibility/removal during reread and its error before restoring only through an available page", async () => {
    const admitted = await ready(), remove = button("إزالة مرجع المستند #9", admitted), reload = button("قراءة مستندات الحالة", admitted);
    let reject!: (reason: Error) => void;
    transport.mockImplementationOnce(() => new Promise<Response>((_resolve, fail) => { reject = fail; }));
    click(reload); click(remove); expect(selected).toEqual([9]); expect(changed).not.toHaveBeenCalled();
    expect(text(render())).not.toContain("#9");
    reject(new Error("synthetic fresh read failed")); await flush();
    expect(text(render())).not.toContain("#9"); expect(selected).toEqual([9]);
    await ready(inventory([])); expect(text(render())).toContain("#9"); expect(changed).not.toHaveBeenCalled();
  });
  it("reports a strictly current restricted read once after closing local editing, without treating it as denial", async () => {
    const admitted = await ready(), oldRemove = button("إزالة مرجع المستند #9", admitted), reload = button("قراءة مستندات الحالة", admitted);
    restricted.mockImplementation(() => click(oldRemove));
    transport.mockResolvedValueOnce(response({ ...inventory([]), state: "restricted" }));
    click(reload); click(reload); await flush();
    expect(restricted).toHaveBeenCalledTimes(1); expect(denied).not.toHaveBeenCalled();
    expect(text(render())).not.toContain("#9"); expect(selected).toEqual([9]); expect(changed).not.toHaveBeenCalled();
  });
  it.each(["detach", "read generation", "same-key owner"] as const)("does not report a held restricted read after %s retirement", async transition => {
    let release!: (response: Response) => void;
    transport.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; })); load();
    if (transition === "detach") { unmount(); render(); }
    else if (transition === "read generation") { props = { ...props, readVersion: props.readVersion + 1 }; render(); }
    else { props = { ...props, ownerIdentity: {} }; render(); }
    release(response({ ...inventory([]), state: "restricted" })); await flush();
    expect(restricted).not.toHaveBeenCalled(); expect(denied).not.toHaveBeenCalled(); expect(selected).toEqual([9]);
    expect(text(render())).not.toContain("#9");
  });
  it("does not report malformed or foreign restricted inventory as a current restriction", async () => {
    for (const raw of [{ ...inventory(), state: "restricted" }, { ...inventory([]), state: "restricted", clinicalCaseId: 92 }]) {
      await ready(raw); expect(text(render())).toContain("لم تُعتبر القائمة فارغة");
      expect(restricted).not.toHaveBeenCalled(); expect(denied).not.toHaveBeenCalled(); expect(selected).toEqual([9]);
    }
  });
  it("rejects retained add/remove/read callbacks after same-binding commit, detach and exact owner identity replacement", async () => {
    let tree: ReactNode = await ready();
    let add = button("إضافة المستند #101", tree), remove = button("إزالة مرجع المستند #9", tree), read = button("قراءة مستندات الحالة", tree);
    render(); click(add); click(remove); click(read); expect(changed).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
    tree = render(); add = button("إضافة المستند #101", tree); remove = button("إزالة مرجع المستند #9", tree); read = button("قراءة مستندات الحالة", tree);
    unmount(); click(add); click(remove); click(read); expect(selected).toEqual([9]); expect(transport).toHaveBeenCalledTimes(1);
    tree = await ready(); add = button("إضافة المستند #101", tree); remove = button("إزالة مرجع المستند #9", tree);
    props = { ...props, ownerIdentity: {} }; expect(text(render())).not.toContain("#101"); click(add); click(remove); expect(selected).toEqual([9]);
  });
  it("keeps prior committed handlers valid during an abandoned render but honors whole-draft CAS before the next commit", async () => {
    const tree = await ready(), oldAdd = button("إضافة المستند #101", tree);
    render(false); click(oldAdd); expect(selected).toEqual([9, 101]);
    // A non-document field changed outside this picker. The integration's
    // whole-document CAS still refuses an old picker draft projection.
    const remove = button("إزالة مرجع المستند #9"); draftVersion++;
    click(remove); expect(selected).toEqual([9, 101]);
  });
  it("enforces one-shot edits before repaint and refuses more than 30 selected IDs", async () => {
    const tree = await ready(), add = button("إضافة المستند #101", tree), remove = button("إزالة مرجع المستند #9", tree);
    click(add); click(add); click(remove); expect(selected).toEqual([9, 101]); expect(changed).toHaveBeenCalledTimes(1);
    selected = Array.from({ length: 30 }, (_, i) => i + 1); draftVersion++;
    const capped = button("إضافة المستند #101"); expect(capped.props.disabled).toBe(true); click(capped); expect(selected).toHaveLength(30);
  });
  it("hides private snapshots and retires callbacks on write loss, then requires a fresh explicit read", async () => {
    const tree = await ready(), add = button("إضافة المستند #101", tree), remove = button("إزالة مرجع المستند #9", tree);
    props = { ...props, writable: false }; const hidden = render(); expect(text(hidden)).not.toContain("#101"); expect(text(hidden)).not.toContain("#9");
    click(add); click(remove); expect(selected).toEqual([9]);
    props = { ...props, writable: true }; expect(text(render())).not.toContain("#101"); expect(text(render())).not.toContain("#9"); expect(transport).toHaveBeenCalledTimes(1);
    await ready(inventory([])); expect(text(render())).toContain("#9"); expect(selected).toEqual([9]); expect(changed).not.toHaveBeenCalled();
  });
  it("does not fetch or edit through a captured handler once the signed owner predicate fails", async () => {
    const tree = await ready(), add = button("إضافة المستند #101", tree), remove = button("إزالة مرجع المستند #9", tree), read = button("قراءة مستندات الحالة", tree);
    allowed = false; click(add); click(remove); click(read);
    expect(transport).toHaveBeenCalledTimes(1); expect(changed).not.toHaveBeenCalled(); expect(selected).toEqual([9]);
  });
  it("keeps malformed parent references intact and does not offer a read against an invalid exact scope", () => {
    selected = Array.from({ length: 31 }, (_, i) => i + 1);
    expect(text(render())).toContain("لم تُستبدل بقائمة فارغة"); expect(transport).not.toHaveBeenCalled();
    selected = [9]; props = { ...props, clinicalCaseId: 0 };
    expect(text(render())).toContain("لم تُستبدل بقائمة فارغة"); expect(text(render())).not.toContain("#9"); expect(selected).toEqual([9]);
  });
  it.each([401, 403])("current %s hides private data and reports denial once without changing parent IDs", async status => {
    await ready(); transport.mockResolvedValueOnce(new Response(null, { status })); load(); await flush();
    expect(denied).toHaveBeenCalledTimes(1); expect(text(render())).not.toContain("#101"); expect(text(render())).not.toContain("#9");
    expect(selected).toEqual([9]); expect(changed).not.toHaveBeenCalled();
  });
  it("retires held headers in layout cleanup and never admits them after detach/remount", async () => {
    let release!: (response: Response) => void;
    transport.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; })); load();
    const signal = transport.mock.calls[0][1].signal as AbortSignal;
    unmount(); expect(signal.aborted).toBe(true); render(); release(response()); await flush();
    expect(text(render())).not.toContain("#101"); expect(denied).not.toHaveBeenCalled(); expect(selected).toEqual([9]);
  });
  it("does not forward a held old-owner denial into the replacement same-key owner", async () => {
    let release!: (response: Response) => void;
    transport.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; })); load();
    props = { ...props, ownerIdentity: {} }; render(); release(new Response(null, { status: 403 })); await flush();
    expect(denied).not.toHaveBeenCalled(); expect(text(render())).not.toContain("#9"); expect(selected).toEqual([9]);
  });
  it.each(["patientId", "orthoCaseId", "clinicalCaseId", "generation", "readVersion"] as const)("rejects a held body and old actions when %s changes", async key => {
    await ready(); const oldRemove = button("إزالة مرجع المستند #9");
    let release!: () => void, cancelled = false;
    transport.mockImplementationOnce(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { release = () => { if (!cancelled) { controller.enqueue(new TextEncoder().encode(JSON.stringify(inventory()))); controller.close(); } }; },
      cancel() { cancelled = true; },
    }), { headers: { "cache-control": "no-store" } })));
    load(); await flush();
    props = { ...props, [key]: props[key] + 1 }; render(); expect(cancelled).toBe(true);
    release(); click(oldRemove); await flush(); expect(text(render())).not.toContain("#101"); expect(text(render())).not.toContain("#9"); expect(selected).toEqual([9]);
  });
  it("keeps the deadline through held body consumption, cancels it, and reports unknown rather than empty", async () => {
    vi.useFakeTimers(); let cancelled = false;
    transport.mockImplementationOnce(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); }, cancel() { cancelled = true; },
    }), { headers: { "cache-control": "no-store" } })));
    load(); await flush(); await vi.advanceTimersByTimeAsync(20_000); await flush();
    expect(cancelled).toBe(true); expect(text(render())).toContain("لم تُعتبر القائمة فارغة"); expect(selected).toEqual([9]);
    expect(button("قراءة مستندات الحالة").props.disabled).toBe(false);
  });
  it("rejects old headers even if transport ignores an expired deadline", async () => {
    vi.useFakeTimers(); let release!: (response: Response) => void;
    transport.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; })); load();
    await vi.advanceTimersByTimeAsync(20_000); render(); release(response()); await flush();
    expect(text(render())).toContain("لم تُعتبر القائمة فارغة"); expect(text(render())).not.toContain("#101"); expect(selected).toEqual([9]);
  });
  it("checks authority again after the actual strict parser returns", async () => {
    // Preflight, headers, decoded body, then the post-parser admission check.
    let checks = 0; props = { ...props, isCurrent: () => ++checks < 4 };
    await ready(); expect(checks).toBe(4); expect(text(render())).not.toContain("#101"); expect(selected).toEqual([9]);
    props = { ...props, writable: false, readVersion: props.readVersion + 1 };
    expect(text(render())).not.toContain("#9"); expect(changed).not.toHaveBeenCalled();
  });
  it("rejects malformed privacy headers, foreign scope, redirects, malformed cursors and oversized bytes without clearing selections", async () => {
    for (const value of [response(inventory(), { "cache-control": "x=no-store" }), response({ ...inventory(), clinicalCaseId: 92 }),
      response(inventory([available(101)], 101)), new Response(" ".repeat(65 * 1024), { headers: { "cache-control": "no-store" } })]) {
      transport.mockResolvedValueOnce(value); load(); await flush(); expect(text(render())).toContain("لم تُعتبر القائمة فارغة"); expect(selected).toEqual([9]);
    }
    transport.mockRejectedValueOnce(new TypeError("redirect:error rejected")); load(); await flush(); expect(text(render())).toContain("لم تُعتبر القائمة فارغة");
    expect(changed).not.toHaveBeenCalled();
  });
});
