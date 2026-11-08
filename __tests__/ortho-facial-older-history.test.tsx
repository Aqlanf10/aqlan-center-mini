import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoFacialOlderHistory } from "../components/OrthoFacialOlderHistory";
import { OrthoFacialSavedRevision } from "../components/OrthoFacialSavedRevision";
import { fetchFacialHistoryPage } from "../lib/ortho-facial-history-client";
import { facialHistoryFixture } from "./fixtures/ortho-facial-history";
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: new Map<number, { deps?: unknown[]; cleanup?: () => void }>(), pending: [] as Array<() => void> }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = initial; return i; };
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  return { ...actual,
    useState: (initial: unknown) => { const i = slot(initial); return [hooks.slots[i], (v: unknown) => { hooks.slots[i] = typeof v === "function" ? v(hooks.slots[i]) : v; }]; },
    useRef: (initial: unknown) => hooks.slots[slot({ current: initial })],
    useMemo: (make: () => unknown, deps: unknown[]) => { const i = slot(null), old = hooks.slots[i] as { deps: unknown[]; value: unknown } | null; if (old && same(old.deps, deps)) return old.value; const value = make(); hooks.slots[i] = { deps, value }; return value; },
    useLayoutEffect: (fn: () => void | (() => void), deps?: unknown[]) => { const i = slot(null), old = hooks.effects.get(i); if (same(old?.deps, deps)) return; hooks.pending.push(() => { old?.cleanup?.(); const cleanup = fn(); hooks.effects.set(i, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
  };
});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (n: ReactNode): Element[] => Array.isArray(n) ? n.flatMap(nodes) : n && typeof n === "object" && "props" in n ? [n as Element, ...nodes((n as Element).props.children as ReactNode)] : [];
const text = (n: ReactNode): string => typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(text).join("") : n && typeof n === "object" && "props" in n ? text((n as Element).props.children as ReactNode) : "";
let fixture: ReturnType<typeof facialHistoryFixture>, props: Parameters<typeof OrthoFacialOlderHistory>[0];
const fetchMock = vi.fn(), denied = vi.fn();
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };
function render() { hooks.cursor = 0; const tree = OrthoFacialOlderHistory(props); hooks.pending.splice(0).forEach(run => run()); return tree; }
function button(label: string) { const control = nodes(render()).find(n => n.type === "button" && text(n) === label); if (!control) throw Error(`Missing ${label}`); return control; }
function click(control: Element) { (control.props.onClick as () => void)(); render(); }
const revisions = () => nodes(render()).filter(n => n.type === OrthoFacialSavedRevision).map(n => n.props.revision as { id: number; version: number });
async function settle() { for (let i = 0; i < 200; i++) { await new Promise<void>(r => setTimeout(r, 5)); const tree = render(); if (i > 1 && !text(tree).includes("جارٍ التحقق")) return; } throw Error("Synthetic history read did not settle"); }
function unmount() { hooks.effects.forEach(e => e.cleanup?.()); hooks.effects.clear(); }
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects.clear(); hooks.pending = []; fixture = facialHistoryFixture();
  props = { data: fixture.data, readIdentity: {}, active: () => true, onDenied: denied }; denied.mockReset(); fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => { const id = Number(new URL(url, 'http://synthetic.invalid').searchParams.get('beforeRevisionId')); return reply(fixture.page(fixture.history.find(r => r.id === id)!)); });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('bounded read-only older facial page lifecycle', () => {
  it('loads only on explicit opening, uses exact tail, retains one page, and stops at version one', async () => {
    const before = structuredClone(props.data); render(); expect(fetchMock).not.toHaveBeenCalled();
    const open = button('عرض المراجعات الأقدم'); click(open); click(open); expect(fetchMock).toHaveBeenCalledOnce(); await settle();
    expect(fetchMock.mock.calls[0][0]).toContain('beforeRevisionId=136'); expect(fetchMock.mock.calls[0][0]).toContain(`beforeContentHash=${fixture.history[29].contentHash}`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(revisions()).toHaveLength(30); expect(revisions()[0].version).toBe(35); expect(revisions().at(-1)?.version).toBe(6);
    click(button('عرض الصفحة الأقدم التالية')); expect(revisions()).toHaveLength(0); await settle();
    expect(revisions().map(r => r.version)).toEqual([5,4,3,2,1]); expect(fetchMock).toHaveBeenCalledTimes(2); expect(text(render())).toContain('أول نسخة');
    expect(nodes(render()).filter(n => n.type === 'button').map(n => text(n))).toEqual(['إغلاق المراجعات الأقدم']); expect(props.data).toEqual(before);
  });
  it('closes/aborts, ignores old callbacks and late responses, and explicitly reopens from initial tail', async () => {
    const pending = deferred<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
    const oldOpen = button('عرض المراجعات الأقدم'); click(oldOpen); const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    const close = button('إغلاق المراجعات الأقدم'); click(close); expect(signal.aborted).toBe(true); click(oldOpen); expect(fetchMock).toHaveBeenCalledOnce();
    pending.resolve(reply(fixture.page(fixture.history[29]))); await settle(); expect(revisions()).toHaveLength(0);
    click(button('عرض المراجعات الأقدم')); await settle(); expect(revisions()[0].version).toBe(35); click(close); expect(revisions()).toHaveLength(30);
  });
  it.each(['actor','patient','case','document','image','read'] as const)('retires held pages and callbacks across %s ABA', async kind => {
    const pending = deferred<Response>(); fetchMock.mockReturnValueOnce(pending.promise); const original = props;
    const old = button('عرض المراجعات الأقدم'); click(old);
    const changed = { ...props.data };
    if(kind==='actor') changed.actorId=5;
    if(kind==='patient') changed.patientId=2;
    if(kind==='case') changed.orthoCaseId=3;
    if(kind==='document') changed.selectedDocumentId=92;
    if(kind==='image') changed.image={...changed.image!,sha256:'c'.repeat(64)};
    props={...props,data:changed,readIdentity:kind==='read'?{}:props.readIdentity}; render(); props=original; render();
    click(old); expect(fetchMock).toHaveBeenCalledOnce(); pending.resolve(reply(fixture.page(fixture.history[29]))); await settle(); expect(revisions()).toHaveLength(0);
  });
  it.each([401,403])('retires parent authority on %s without reading a body', async status => {
    fetchMock.mockResolvedValueOnce(reply({},status)); click(button('عرض المراجعات الأقدم')); await settle(); expect(denied).toHaveBeenCalledOnce(); expect(revisions()).toHaveLength(0);
  });
  it('hides the prior page after a next-page409 and retries only by explicit action', async () => {
    click(button('عرض المراجعات الأقدم')); await settle(); fetchMock.mockResolvedValueOnce(reply({},409));
    const oldNext=button('عرض الصفحة الأقدم التالية');click(oldNext);await settle();expect(revisions()).toHaveLength(0);expect(fetchMock).toHaveBeenCalledTimes(2);
    click(oldNext);expect(fetchMock).toHaveBeenCalledTimes(2);click(button('إعادة قراءة هذه الصفحة'));await settle();expect(revisions()).toHaveLength(5);
  });
  it.each(['fetch','body'])('times out a stalled %s without retry or stale publication',async phase=>{
    vi.useFakeTimers();const held=deferred<Response>();
    fetchMock.mockReturnValueOnce(phase==='fetch'?held.promise:Promise.resolve(new Response(new ReadableStream(),{headers:{'content-type':'application/json','cache-control':'private, no-store'}})));
    click(button('عرض المراجعات الأقدم'));await vi.advanceTimersByTimeAsync(15000);render();expect(text(render())).toContain('تعذّر التحقق');expect(revisions()).toHaveLength(0);expect(fetchMock).toHaveBeenCalledOnce();
    held.resolve(reply(fixture.page(fixture.history[29])));await vi.advanceTimersByTimeAsync(1);render();expect(revisions()).toHaveLength(0);
  });
  it('rejects a wrong-actor page and does not expose saved rows',async()=>{
    fetchMock.mockResolvedValueOnce(reply({...fixture.page(fixture.history[29]),actorId:5}));click(button('عرض المراجعات الأقدم'));await settle();expect(revisions()).toHaveLength(0);expect(text(render())).toContain('تعذّر التحقق');
  });
  it('retires pending reads on unmount',async()=>{const held=deferred<Response>();fetchMock.mockReturnValueOnce(held.promise);click(button('عرض المراجعات الأقدم'));unmount();expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);held.resolve(reply(fixture.page(fixture.history[29])));await Promise.resolve();});
});
describe('facial history transport bounds',()=>{
  const expected=()=>({...fixture.data,documentId:91,anchor:fixture.history[29]});
  it('rejects an oversized stream without content-length and cancels it',async()=>{
    const cancel=vi.fn();fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1024*1024));c.enqueue(new Uint8Array(1024*1024+1));},cancel}),{headers:{'content-type':'application/json','cache-control':'private, no-store'}}));
    await expect(fetchFacialHistoryPage(expected(),new AbortController().signal,denied)).rejects.toThrow('too_large');expect(cancel).toHaveBeenCalled();
  });
  it.each(['cache','type','length','redirect'])('rejects invalid %s response metadata',async kind=>{
    const response=reply(fixture.page(fixture.history[29]));
    if(kind==='cache')response.headers.set('cache-control','public');if(kind==='type')response.headers.set('content-type','text/html');if(kind==='length')response.headers.set('content-length','2097153');if(kind==='redirect')Object.defineProperty(response,'redirected',{value:true});fetchMock.mockResolvedValueOnce(response);
    await expect(fetchFacialHistoryPage(expected(),new AbortController().signal,denied)).rejects.toThrow();
  });
});
