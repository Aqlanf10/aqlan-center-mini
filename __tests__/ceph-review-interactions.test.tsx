import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { CephTracer } from "../components/CephTracer";
import { CEPH_ENGINE_VERSION, CEPH_ENGINE_SOURCE_SHA256 } from "../lib/ceph-engine-identity";
import { REQUIRED_LANDMARKS, computeAll, type LandmarkMap } from "../lib/ceph";

vi.mock("../lib/ceph", async original => { const actual = await original<typeof import("../lib/ceph")>(); return { ...actual, computeAll: vi.fn(actual.computeAll) }; });

// Execute real component handlers; only hook scheduling and transport are
// synthetic. Browser rendering remains covered by the separate Chromium suite.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void; replay?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(), pending: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return i; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined), before = hooks.memos.get(index); if (before && same(before.deps, deps)) return before.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => { const index = slot({ current: initial }); return hooks.values[index]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useLayoutEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index); if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = run(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined, replay: () => { const next = run(); hooks.effects.get(index)!.cleanup = typeof next === "function" ? next : undefined; } }); });
    },
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index); if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = run(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
    },
  };
});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
let props: ComponentProps<typeof CephTracer>;
const fetchMock = vi.fn(), confirmation = vi.fn();
let keydown: ((e: unknown) => void) | undefined;
let beforeUnload: ((e: unknown) => void) | undefined;
function render(): ReactNode {
  for (let round = 0; round < 20; round++) {
    hooks.cursor = 0; hooks.changed = false; hooks.pending = [];
    const tree = CephTracer(props); if (hooks.changed) continue;
    hooks.pending.splice(0).forEach((run) => run()); if (!hooks.changed) return tree;
  }
  throw new Error("Ceph render did not settle");
}
const viewport = () => nodes(render()).find((node) => typeof node.props.renderOverlay === "function")!;
const button = (name: string) => { const value = nodes(render()).find((node) => node.type === "button" && text(node).trim() === name); if (!value) throw new Error("Missing button: " + name); return value; };
const click = (name: string) => (button(name).props.onClick as () => void)();
const key = (name: string) => { keydown?.({ key: name, target: { tagName: "BODY" }, preventDefault() {}, ctrlKey: false, metaKey: false, shiftKey: false }); render(); };
const edits = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH").map(([, init]) => JSON.parse(init.body));
const loaded = () => { (viewport().props.onNaturalSize as (size: unknown) => void)({ w: 1200, h: 800 }); render(); };
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); render(); }
const event = () => ({ button: 0, pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 200,
  preventDefault() {}, stopPropagation() {}, currentTarget: { setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }) } });
const startCircle = () => {
  const overlay = (viewport().props.renderOverlay as (scale: number, interactive: boolean) => ReactNode)(1, true);
  const circle = nodes(overlay).find((node) => node.type === "circle" && node.props.cx === props.initialLandmarks[0].x && typeof node.props.onPointerDown === "function")!;
  (circle.props.onPointerDown as (e: unknown) => void)(event()); render();
};
const selectCircle = () => { startCircle(); (viewport().props.onPointerUp as (e: unknown) => void)(event()); render(); };
// Nondegenerate synthetic required-point fixture; S keeps the original interaction coordinates.
const validPoints:LandmarkMap={S:{x:100,y:200},N:{x:169,y:192},A:{x:167.57,y:251.98},B:{x:163.84,y:279.85},Pog:{x:164.03,y:286.87},Me:{x:160,y:305},Go:{x:82.97,y:269.08},Or:{x:160,y:225},Po:{x:100,y:225},U1A:{x:160,y:234},U1:{x:174.08,y:271.44},L1A:{x:149,y:299.2},L1:{x:168,y:264},OcclA:{x:170,y:248},OcclP:{x:100,y:235.3},Gn:{x:161.5,y:295.5}};
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = []; keydown = undefined; beforeUnload = undefined;
  vi.mocked(computeAll).mockClear();
  fetchMock.mockReset(); confirmation.mockReset(); confirmation.mockReturnValue(true);
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, mmPerPixel: 0.1 }) });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { location: { href: "/ceph/71" }, confirm: confirmation,
    addEventListener: (name: string, fn: (e: unknown) => void) => { if (name === "keydown") keydown = fn; if (name === "beforeunload") beforeUnload = fn; },
    removeEventListener: (name: string, fn: unknown) => { if (name === "keydown" && keydown === fn) keydown = undefined; if (name === "beforeunload" && beforeUnload === fn) beforeUnload = undefined; },
  });
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
  props = { patientName: "Synthetic review only", patientBirthYear: null,
    analysis: { id: 71, patientId: 11, documentId: 51, status: "draft", orthoCaseId: null, phase: "pretreatment", xrayDate: null,
      device: null, refSet: "builtin_default", calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, mmPerPixel: 0.1, note: null,
      createdBy: "synthetic", createdAt: "2026-01-01", completedBy: null, completedAt: null, findings: null },
    initialLandmarks: REQUIRED_LANDMARKS.map(code => ({ code, ...validPoints[code]!, source: code === "S" ? "suggested" : "manual" })),
    stamped: null, refValues: null, refSetName: null, diagnosis: null,
    correctionSource: { state: "available", token: { schemaVersion: 1, analysisId: 71, patientId: 11, orthoCaseId: null, documentId: 51, sourceSha256: "c".repeat(64) },
      origin: { schemaVersion: 1, parentAnalysisId: 71, recordedPatientId: 11, orthoCaseId: null, documentId: 51,
        parentCompletion: { state: "unversioned", reason: "historical_completion_without_witness" }, sourceSnapshotSha256: "c".repeat(64) } },
    completionSources: {state:"available",identity:{schemaVersion:1,documentId:51,imageSha256:"a".repeat(64),referenceSetKey:"builtin_default",
      referenceSetSha256:"b".repeat(64),engineVersion:CEPH_ENGINE_VERSION,engineSourceSha256:CEPH_ENGINE_SOURCE_SHA256},
      referenceSet:{key:"builtin_default",name:"Viewed reference",population:null,ageMin:null,ageMax:null,sex:null,version:"v1",active:true,values:[]}},
  };
  if (props.correctionSource?.state === "available") {
    // Match the server contract: token seals the origin envelope, while its
    // sourceSnapshotSha256 separately seals the observed source.
    props.correctionSource.token.sourceSha256 = journeyContentHash(props.correctionSource.origin);
  }
});
afterEach(() => { hooks.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });
describe("explicit per-point review in the real ceph component", () => {
  it("blocks completion for existing suggestions and does not save/review a zero-motion selection", async () => {
    loaded(); selectCircle(); await flush(); expect(edits()).toEqual([]); expect(button("تراجع").props.disabled).toBe(true);
    expect(button("S ✦")).toBeDefined(); expect(button("اعتماد التحليل").props.disabled).toBe(true);
  });
  it("requires explicit confirmation and saved single-point review, preserving unchanged coordinates and expected source", async () => {
    loaded(); click("S ✦"); render(); confirmation.mockReturnValue(false);
    click("راجعت موضع S على الأشعة"); await flush(); expect(edits()).toEqual([]); expect(button("S ✦")).toBeDefined();
    confirmation.mockReturnValue(true); click("راجعت موضع S على الأشعة");
    expect(button("اعتماد التحليل").props.disabled).toBe(true); await flush();
    expect(confirmation).toHaveBeenLastCalledWith(expect.stringContaining("S"));
    expect(edits()).toEqual([{ landmarks: [{ code: "S", x: 100, y: 200, source: "manual" }],
      expectedLandmarks: [{ code: "S", x: 100, y: 200, source: "suggested" }] }]);
    expect(button("S ✓")).toBeDefined(); expect(button("اعتماد التحليل").props.disabled).toBe(false);
  });
  it("Undo/Redo restores review provenance as well as coordinates", async () => {
    loaded(); click("S ✦"); click("راجعت موضع S على الأشعة"); await flush();
    click("تراجع"); await flush(); expect(button("S ✦")).toBeDefined(); expect(button("اعتماد التحليل").props.disabled).toBe(true);
    expect(edits().at(-1)).toMatchObject({ landmarks: [{ code: "S", x: 100, y: 200, source: "suggested" }], expectedLandmarks: [{ code: "S", source: "manual" }] });
    click("إعادة"); await flush(); expect(button("S ✓")).toBeDefined(); expect(button("اعتماد التحليل").props.disabled).toBe(false);
    expect(edits().at(-1)).toMatchObject({ landmarks: [{ code: "S", source: "manual" }], expectedLandmarks: [{ code: "S", source: "suggested" }] });
  });
  it("does not review a clamped no-op nudge; actual correction and Undo preserve provenance", async () => {
    props.initialLandmarks[0].x = 0; loaded(); click("S ✦"); render(); key("ArrowLeft"); await flush();
    expect(edits()).toEqual([]); expect(button("S ✦")).toBeDefined();
    key("ArrowRight"); await flush(); expect(edits()[0]).toMatchObject({ landmarks: [{ code: "S", x: 1, source: "manual" }] });
    click("تراجع"); await flush(); expect(edits().at(-1)).toMatchObject({ landmarks: [{ code: "S", x: 0, source: "suggested" }] });
    expect(button("اعتماد التحليل").props.disabled).toBe(true);
  });
  it("cancels an interrupted drag without persisting or implicitly reviewing the suggestion", async () => {
    loaded(); startCircle();
    (viewport().props.onPointerMove as (e: unknown) => void)({ ...event(), clientX: 150, clientY: 250 }); render();
    (viewport().props.onPointerCancel as () => void)(); await flush();
    expect(edits()).toEqual([]); expect(button("S ✦")).toBeDefined(); expect(button("تراجع").props.disabled).toBe(true);
  });
  it("records an actual manual correction but restores suggested provenance when that correction is undone", async () => {
    loaded(); startCircle();
    (viewport().props.onPointerMove as (e: unknown) => void)({ ...event(), clientX: 150, clientY: 250 }); render();
    (viewport().props.onPointerUp as (e: unknown) => void)({ ...event(), clientX: 150, clientY: 250 }); await flush();
    expect(edits()[0]).toMatchObject({ landmarks: [{ code: "S", x: 150, y: 250, source: "manual" }] });
    click("تراجع"); await flush();
    expect(edits().at(-1)).toMatchObject({ landmarks: [{ code: "S", x: 100, y: 200, source: "suggested" }] });
    expect(button("S ✦")).toBeDefined(); expect(button("اعتماد التحليل").props.disabled).toBe(true);
  });
  it("keeps completion disabled on a stale review response instead of pretending review was saved", async () => {
    loaded(); click("S ✦"); fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: "Synthetic stale point" }) });
    click("راجعت موضع S على الأشعة"); await flush();
    expect(button("اعتماد التحليل").props.disabled).toBe(true); expect(text(render())).toContain("Synthetic stale point");
    expect(edits()).toHaveLength(1);
  });
  it("blocks optional suggestions too and cannot review before the image is loaded", () => {
    props.initialLandmarks = props.initialLandmarks.map((p) => ({ ...p, source: "manual" }));
    props.initialLandmarks.push({ code: "Co", x: 700, y: 600, source: "suggested" });
    render(); click("Co ✦"); render(); expect(button("راجعت موضع Co على الأشعة").props.disabled).toBe(true);
    expect(button("اعتماد التحليل").props.disabled).toBe(true);
    click("راجعت موضع Co على الأشعة"); expect(edits()).toEqual([]);
    loaded(); expect(button("راجعت موضع Co على الأشعة").props.disabled).toBe(false);
  });
});

describe('read-only ceph workspace', () => {
  it('does not optimistically move, review or persist points through real handlers', async () => {
    props.readOnly = true;
    loaded();
    const before = (viewport().props.renderOverlay as (scale: number, interactive: boolean) => ReactNode)(1, true);
    const original = nodes(before).filter(n => n.type === 'circle').map(n => [n.props.cx, n.props.cy]);
    selectCircle();
    (viewport().props.onPointerMove as (e: unknown) => void)({ ...event(), clientX: 150, clientY: 250 });
    (viewport().props.onPointerUp as (e: unknown) => void)({ ...event(), clientX: 150, clientY: 250 });
    const handler = viewport().props.onClick as ((e: unknown) => void) | undefined;
    handler?.({ ...event(), detail: 1 });
    key('ArrowRight'); key('z');
    await flush();
    const after = (viewport().props.renderOverlay as (scale: number, interactive: boolean) => ReactNode)(1, true);
    expect(nodes(after).filter(n => n.type === 'circle').map(n => [n.props.cx, n.props.cy])).toEqual(original);
    expect(viewport().props.cursor).toEqual({ x: 150, y: 250 });
    expect(fetchMock).not.toHaveBeenCalled(); expect(confirmation).not.toHaveBeenCalled();
  });
  it('ignores a retained viewing handler after its view owner unmounts', () => {
    props.readOnly = true; loaded();
    const move = viewport().props.onPointerMove as (e: unknown) => void;
    hooks.effects.forEach(effect => effect.cleanup?.());
    hooks.changed = false;
    move({ ...event(), clientX: 150, clientY: 250 });
    expect(hooks.changed).toBe(false); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('shows a draft as a read-only draft, keeps viewing tools, and exposes no clinical editors', () => {
    props.readOnly = true; loaded(); const tree = render();
    expect(text(tree)).toContain('عرض فقط'); expect(text(tree)).toContain('مسودة');
    expect(text(tree)).not.toContain('معتمد —');
    const buttons = nodes(tree).filter(n => n.type === 'button').map(text);
    for (const label of ['اعتماد التحليل','راجعت موضع S على الأشعة','حفظ التشخيص','تعبئة قراءة وصفية','تعبئة أساسية','تراجع','إعادة']) expect(buttons).not.toContain(label);
    expect(nodes(tree).filter(n => n.type === 'textarea')).toHaveLength(0);
    expect(buttons).toContain('رفض المسودة');
    expect(viewport()).toBeDefined(); expect(buttons.some(label => label.includes('تحريك'))).toBe(true);
  });
});

describe('completion signs the displayed clinical snapshot', () => {
  const ready = () => { props.initialLandmarks = props.initialLandmarks.map(p => ({ ...p, source: 'manual' })); loaded(); };
  const analysisMode = () => { const node = nodes(render()).find(n => n.type === 'button' && text(n).includes('2. التحليل والمدارس السبع'))!; (node.props.onClick as () => void)(); render(); };
  const area = (index: number) => nodes(render()).filter(n => n.type === 'textarea')[index];
  const edit = (index: number, value: string) => { (area(index).props.onChange as (e: unknown) => void)({ target: { value } }); render(); };
  const posted = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
  const normalized = (finalDx: string) => ({ skeletal: null, dental: null, softTissue: null, note: null, finalDx });
  it('blocks completion while any displayed diagnosis text is unsaved', async () => {
    ready(); analysisMode(); edit(3, 'Synthetic unsaved diagnosis');
    expect(button('اعتماد التحليل').props.disabled).toBe(true); click('اعتماد التحليل'); await flush();
    expect(posted()).toHaveLength(0); expect(confirmation).not.toHaveBeenCalled();
  });
  it('protects dirty diagnosis on departure and offers explicit local discard without a request', async () => {
    ready(); analysisMode(); edit(3, 'Unsaved local text'); expect(beforeUnload).toBeDefined();
    const departure = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    beforeUnload?.(departure); expect(departure.preventDefault).toHaveBeenCalled();
    confirmation.mockReturnValue(false); click('إلغاء تعديلات التشخيص'); render(); expect(area(3).props.value).toBe('Unsaved local text');
    confirmation.mockReturnValue(true); click('إلغاء تعديلات التشخيص'); await flush(); expect(area(3).props.value).toBe('');
    expect(button('اعتماد التحليل').props.disabled).toBe(false); expect(fetchMock).not.toHaveBeenCalled(); expect(beforeUnload).toBeUndefined();
  });
  it('blocks signing while a new ruler is being selected, until that selection is saved or cancelled', async () => {
    ready(); click('تصحيح المعايرة'); render(); expect(button('اعتماد التحليل').props.disabled).toBe(true);
    click('اعتماد التحليل'); await flush(); expect(posted()).toHaveLength(0);
    click('إلغاء المعايرة'); render(); expect(button('اعتماد التحليل').props.disabled).toBe(false);
  });
  it('blocks signing during a point drag, even before a save request exists', () => {
    ready(); startCircle(); expect(button('اعتماد التحليل').props.disabled).toBe(true);
    (viewport().props.onPointerUp as (e: unknown) => void)(event()); render(); expect(button('اعتماد التحليل').props.disabled).toBe(false);
  });
  it('sends the displayed acknowledged identity, calibration, full source map and null diagnosis without a refresh', async () => {
    ready(); click('اعتماد التحليل'); await flush(); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posted()).toHaveLength(1); const body = JSON.parse(posted()[0][1].body);
    expect(body.expectedSnapshot).toEqual({ patientId: 11, documentId: 51, refSet: 'builtin_default', calibration: props.analysis.calibration,
      mmPerPixel: 0.1, landmarks: props.initialLandmarks, diagnosis: null });
  });
  it('uses successful authoritative normalized diagnosis in both editor and signing snapshot', async () => {
    ready(); analysisMode(); edit(3, '  Synthetic saved diagnosis  ');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, diagnosis: normalized('Synthetic saved diagnosis') }) });
    click('حفظ التشخيص'); await flush(); expect(area(3).props.value).toBe('Synthetic saved diagnosis');
    expect(button('اعتماد التحليل').props.disabled).toBe(false); click('اعتماد التحليل'); await flush();
    expect(JSON.parse(posted()[0][1].body).expectedSnapshot.diagnosis).toEqual(normalized('Synthetic saved diagnosis'));
  });
  it.each([0, 1, 2, 3, 4])('keeps oversized authored field %s local instead of silently submitting a truncated diagnosis', async index => {
    ready(); analysisMode(); edit(3, 'Synthetic diagnosis'); edit(index, 'x'.repeat(2001));
    click('حفظ التشخيص'); await flush(); expect(fetchMock).not.toHaveBeenCalled(); expect(area(index).props.value).toHaveLength(2001);
    expect(button('اعتماد التحليل').props.disabled).toBe(true);
  });
  it('sends absence then the last acknowledged diagnosis as save preconditions', async () => {
    ready(); analysisMode(); edit(3, 'First saved diagnosis');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, diagnosis: normalized('First saved diagnosis') }) });
    click('حفظ التشخيص'); await flush(); expect(edits()[0].expectedDiagnosis).toBeNull();
    edit(3, 'Second diagnosis'); fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, diagnosis: normalized('Second diagnosis') }) });
    click('حفظ التشخيص'); await flush(); expect(edits()[1].expectedDiagnosis).toEqual(normalized('First saved diagnosis'));
  });
  it('does not adopt unexpected server text as the acknowledged submitted diagnosis', async () => {
    ready(); analysisMode(); edit(3, 'Authored intended diagnosis');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, diagnosis: normalized('Different unexpected text') }) });
    click('حفظ التشخيص'); await flush(); expect(area(3).props.value).toBe('Authored intended diagnosis');
    expect(button('حفظ التشخيص').props.disabled).toBe(false); expect(button('اعتماد التحليل').props.disabled).toBe(true);
  });
  it('retries a lost diagnosis acknowledgment with unchanged expected state and text', async () => {
    ready(); analysisMode(); edit(3, 'Lost reply diagnosis');
    fetchMock.mockRejectedValueOnce(new Error('Synthetic reply lost after commit')); click('حفظ التشخيص'); await flush();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, diagnosis: normalized('Lost reply diagnosis') }) });
    click('حفظ التشخيص'); await flush(); expect(edits()).toHaveLength(2);
    expect(edits()[0]).toEqual(edits()[1]); expect(edits()[1].expectedDiagnosis).toBeNull();
  });
  it('does not overwrite or mark newer edits saved when an earlier save response arrives', async () => {
    ready(); analysisMode(); edit(3, 'Earlier submitted diagnosis');
    let resolve!: (response: unknown) => void; fetchMock.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    click('حفظ التشخيص'); render(); edit(3, 'Newer unsaved diagnosis');
    resolve({ ok: true, json: async () => ({ ok: true, diagnosis: normalized('Earlier submitted diagnosis') }) }); await flush();
    expect(area(3).props.value).toBe('Newer unsaved diagnosis'); expect(button('حفظ التشخيص').props.disabled).toBe(false);
    expect(button('اعتماد التحليل').props.disabled).toBe(true); click('اعتماد التحليل'); await flush(); expect(posted()).toHaveLength(0);
  });
  it.each([false, true])('keeps diagnosis dirty when save fails or omits authoritative fields (%s)', async incomplete => {
    ready(); analysisMode(); edit(3, 'Unsaved diagnosis');
    fetchMock.mockResolvedValueOnce({ ok: incomplete, json: async () => ({ ok: incomplete, message: 'Synthetic failure' }) });
    click('حفظ التشخيص'); await flush(); expect(button('حفظ التشخيص').props.disabled).toBe(false);
    expect(button('اعتماد التحليل').props.disabled).toBe(true); expect(area(3).props.value).toBe('Unsaved diagnosis');
  });
  it('freezes clinical editing during signing and restores it after a rejected snapshot', async () => {
    ready(); analysisMode(); let resolve!: (response: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    click('اعتماد التحليل'); render();
    expect(beforeUnload).toBeDefined();
    expect(nodes(render()).filter(n => n.type === 'textarea')).toHaveLength(0);
    expect(nodes(render()).filter(n => n.type === 'button').map(text)).not.toContain('اعتماد التحليل');
    selectCircle(); key('ArrowRight'); await flush(); expect(edits()).toHaveLength(0); expect(posted()).toHaveLength(1);
    resolve({ ok: false, status: 409, json: async () => ({ message: 'Synthetic snapshot changed' }) }); await flush();
    expect(nodes(render()).filter(n => n.type === 'textarea')).toHaveLength(5); expect(button('اعتماد التحليل').props.disabled).toBe(false);
  });
  it('does not replace a rejected snapshot with unseen latest state for a retry', async () => {
    ready(); fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: 'Synthetic snapshot changed' }) });
    click('اعتماد التحليل'); await flush(); click('اعتماد التحليل'); await flush();
    expect(posted()).toHaveLength(2); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posted()[0][1].body).toBe(posted()[1][1].body); expect(JSON.parse(posted()[0][1].body).expectedSnapshot.landmarks).toEqual(props.initialLandmarks);
    expect(text(render())).toContain('Synthetic snapshot changed');
  });
});

describe("viewed source identity is retained through signing", () => {
  const manual = () => { props.initialLandmarks=props.initialLandmarks.map(point=>({...point,source:"manual"})); };
  const posts = () => fetchMock.mock.calls.filter(([,init])=>init?.method==="POST");
  it("does not sign until the bound image loaded, and blocks again on image failure", async () => {
    manual(); render(); expect(button("اعتماد التحليل").props.disabled).toBe(true);
    click("اعتماد التحليل"); await flush(); expect(posts()).toHaveLength(0);
    loaded(); expect(button("اعتماد التحليل").props.disabled).toBe(false);
    (viewport().props.onNaturalSize as (value:unknown)=>void)(null); render();
    expect(button("اعتماد التحليل").props.disabled).toBe(true);
    click("اعتماد التحليل"); await flush(); expect(posts()).toHaveLength(0);
  });
  it.each(["absent","unavailable","engineVersion","engineSourceSha256","documentId","referenceSetKey"])("refuses %s source evidence without fetching replacement sources", async kind => {
    manual();
    if(kind==="absent") props.completionSources=undefined;
    else if(kind==="unavailable") props.completionSources={state:"unavailable",reason:"synthetic"};
    else if(props.completionSources?.state==="available") props.completionSources={...props.completionSources,
      identity:{...props.completionSources.identity,[kind]:kind==="documentId"?99:kind==="engineSourceSha256"?"f".repeat(64):"different"}};
    loaded(); expect(button("اعتماد التحليل").props.disabled).toBe(true);
    click("اعتماد التحليل"); await flush(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("submits the displayed identity and binds image URL to its record metadata without a fresh GET", async () => {
    manual(); loaded();
    const sources=props.completionSources; expect(sources?.state).toBe("available");
    expect(viewport().props.src).toBe(`/api/documents/51?cephSource=${"a".repeat(64)}`);
    click("اعتماد التحليل"); await flush(); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(posts()[0][1].body).expectedSources).toEqual(sources?.state==="available"?sources.identity:null);
  });
  it("cannot replace the viewed identity during a mounted review", async () => {
    manual(); loaded();
    if(props.completionSources?.state!=="available") throw new Error("Missing fixture");
    props.completionSources={...props.completionSources,identity:{...props.completionSources.identity,imageSha256:"d".repeat(64)}};
    render(); expect(button("اعتماد التحليل").props.disabled).toBe(true);
    expect(viewport().props.src).toContain("a".repeat(64));
    click("اعتماد التحليل"); await flush(); expect(fetchMock).not.toHaveBeenCalled();
  });
});

it("retries a source conflict using original reviewed identity, never response metadata or a refetch", async () => {
  props.initialLandmarks=props.initialLandmarks.map(point=>({...point,source:"manual"})); loaded();
  const viewed=props.completionSources?.state==="available"?props.completionSources.identity:null;
  fetchMock.mockResolvedValue({ok:false,status:409,json:async()=>({message:"Synthetic sources changed; reopen",completionSources:{state:"available",identity:{...viewed,imageSha256:"f".repeat(64)}}})});
  click("اعتماد التحليل"); await flush(); click("اعتماد التحليل"); await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for(const [url,init] of fetchMock.mock.calls) {
    expect(url).toBe("/api/ceph/71/complete"); expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).expectedSources).toEqual(viewed);
  }
  expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
  expect(text(render())).toContain("Synthetic sources changed; reopen");
});

describe('ceph queued edit retirement boundary',()=>{
 it.each(['unmount','readOnly'] as const)('does not start a queued write after %s while a previous request settles',async boundary=>{
  let respond!: (value:unknown)=>void;
  fetchMock.mockImplementationOnce(()=>new Promise(resolve=>{respond=resolve;}));
  loaded();selectCircle();key('ArrowRight');key('ArrowRight');
  expect(edits()).toHaveLength(1);
  if(boundary==='unmount'){hooks.effects.forEach(effect=>effect.cleanup?.());hooks.effects.clear();}
  else {props={...props,readOnly:true};render();}
  respond({ok:true,status:200,json:async()=>({ok:true})});
  // Do not remount the synthetic component after running all cleanup callbacks.
  for(let i=0;i<40;i++)await Promise.resolve();
  expect(edits()).toHaveLength(1);
 });
});

it('supports initial StrictMode layout replay but refuses reconnect after a user edit',async()=>{
 loaded();
 const replay=()=>{const lifecycles=[...hooks.effects.values()].filter(e=>e.replay);lifecycles.forEach(e=>e.cleanup?.());lifecycles.forEach(e=>e.replay?.());render();};
 replay();selectCircle();key('ArrowRight');await flush();expect(edits()).toHaveLength(1);
 replay();key('ArrowRight');await flush();expect(edits()).toHaveLength(1);expect(text(render())).toContain('أعد فتح الدراسة');
});
it.each(['actor','source','analysis'] as const)('rejects retained queue callbacks and ABA after %s identity changes',async kind=>{
 let respond!:(v:unknown)=>void;fetchMock.mockImplementationOnce(()=>new Promise(r=>{respond=r;}));
 props={...props,actorId:1};loaded();selectCircle();key('ArrowRight');key('ArrowRight');const original=props;
 if(kind==='actor')props={...props,actorId:2};
 if(kind==='analysis')props={...props,analysis:{...props.analysis,id:72}};
 if(kind==='source'&&props.completionSources?.state==='available')props={...props,completionSources:{...props.completionSources,identity:{...props.completionSources.identity,imageSha256:'c'.repeat(64)}}};
 render();props=original;render();respond({ok:true,status:200,json:async()=>({ok:true})});await flush();key('ArrowRight');await flush();expect(edits()).toHaveLength(1);
});

it('does not apply a late calibration acknowledgement or its finally state after retirement',async()=>{
 let respond!:(v:unknown)=>void;fetchMock.mockImplementationOnce(()=>new Promise(r=>{respond=r;}));
 loaded();click('تصحيح المعايرة');render();(viewport().props.onPointerStart as ()=>void)();
 (viewport().props.onClick as (e:unknown)=>void)({...event(),detail:0,clientX:0,clientY:0});render();
 (viewport().props.onClick as (e:unknown)=>void)({...event(),detail:0,clientX:200,clientY:0});render();click('حفظ المعايرة');
 const calibration=edits()[0].calibration;expect(calibration).toEqual({x1:0,y1:0,x2:200,y2:0,mm:10});
 props={...props,readOnly:true};render();hooks.changed=false;
 respond({ok:true,status:200,json:async()=>({ok:true,calibration,mmPerPixel:.05})});
 for(let i=0;i<40;i++)await Promise.resolve();expect(hooks.changed).toBe(false);expect(text(render())).not.toContain('المعايرة محفوظة.');
});
it('does not retire the live queue for equivalent newly allocated initial props',async()=>{
 loaded();selectCircle();key('ArrowRight');await flush();props={...props,initialLandmarks:props.initialLandmarks.map(p=>({...p})),analysis:{...props.analysis,calibration:{...props.analysis.calibration!}}};render();key('ArrowRight');await flush();expect(edits()).toHaveLength(2);
});

it('blocks completion when present manually reviewed points cannot produce required calculations',async()=>{
 props.initialLandmarks=props.initialLandmarks.map(p=>({...p,x:100,y:200,source:'manual'}));loaded();
 expect(button('اعتماد التحليل').props.disabled).toBe(true);
 click('اعتماد التحليل');await flush();expect(fetchMock).not.toHaveBeenCalled();
 expect(text(render())).toContain('SNA');
});

describe('draft calculation readiness without clinical inference',()=>{
 const manual=()=>{props.initialLandmarks=props.initialLandmarks.map(p=>({...p,source:'manual'}));};
 it('admits a valid required-point fixture with absent and partially supplied optional inputs',()=>{
  manual();props.initialLandmarks.push({code:'ANS',x:170,y:240,source:'manual'});loaded();expect(button('اعتماد التحليل').props.disabled).toBe(false);
  const panel=nodes(render()).find(n=>n.props['aria-label']==='جاهزية الحسابات قبل الاعتماد')!;
  expect(text(panel)).toContain('غيابها وحده لا يمنع الاعتماد');expect(text(panel)).toContain('PALATAL_ANS_PNS');expect(text(panel)).toContain('PNS');expect(text(panel)).not.toContain('رغم وجود');
 });
 it('blocks a fully supplied degenerate optional calculation with its exact code',()=>{
  manual();props.initialLandmarks.push({code:'ANS',x:170,y:240,source:'manual'},{code:'PNS',x:170,y:240,source:'manual'});loaded();expect(button('اعتماد التحليل').props.disabled).toBe(true);
  const alert=nodes(render()).find(n=>n.props.role==='alert'&&text(n).includes('رغم وجود'))!;expect(text(alert)).toContain('PALATAL_ANS_PNS');click('اعتماد التحليل');expect(fetchMock).not.toHaveBeenCalled();
 });
 it('does not reject valid zero-valued distance as unavailable',()=>{
  manual();props.initialLandmarks=props.initialLandmarks.map(p=>p.code==='U1'?{...p,...validPoints.A!}:p);loaded();expect(computeAll(Object.fromEntries(props.initialLandmarks.map(p=>[p.code,{x:p.x,y:p.y}])),.1).find(r=>r.code==='U1NA_D')?.value).toBe(0);expect(button('اعتماد التحليل').props.disabled).toBe(false);
 });
 it('updates readiness for an invalid point edit then Undo using the same draft calculation',async()=>{
  manual();loaded();expect(button('اعتماد التحليل').props.disabled).toBe(false);startCircle();
  (viewport().props.onPointerMove as(e:unknown)=>void)({...event(),clientX:169,clientY:192});render();
  (viewport().props.onPointerUp as(e:unknown)=>void)({...event(),clientX:169,clientY:192});await flush();expect(button('اعتماد التحليل').props.disabled).toBe(true);expect(text(render())).toContain('حسابات غير متاحة رغم');
  click('تراجع');await flush();expect(button('اعتماد التحليل').props.disabled).toBe(false);expect(text(render())).not.toContain('حسابات غير متاحة رغم');
 });
 it('keeps valid angles visible without scale but requires saved calibration before completion',async()=>{
  manual();props.analysis={...props.analysis,mmPerPixel:null,calibration:null};loaded();expect(button('اعتماد التحليل').props.disabled).toBe(true);expect(text(render())).toContain('إمكان حساب بعض الزوايا لا يعفي منها');
  expect(vi.mocked(computeAll).mock.results.at(-1)?.value.find((r:{code:string})=>r.code==='SNA')?.value).not.toBeNull();
  click('معايرة الشععة');render();(viewport().props.onPointerStart as()=>void)();
  (viewport().props.onClick as(e:unknown)=>void)({...event(),detail:0,clientX:0,clientY:0});render();
  (viewport().props.onClick as(e:unknown)=>void)({...event(),detail:0,clientX:100,clientY:0});render();
  fetchMock.mockResolvedValueOnce({ok:true,status:200,json:async()=>({ok:true,mmPerPixel:.1,calibration:{x1:0,y1:0,x2:100,y2:0,mm:10}})});click('حفظ المعايرة');await flush();expect(button('اعتماد التحليل').props.disabled).toBe(false);
 });
 it('does not run current calculations or show draft readiness for completed history',()=>{
  props={...props,analysis:{...props.analysis,status:'completed'},stamped:[{code:'SNA',value:77.7}]};render();expect(computeAll).not.toHaveBeenCalled();expect(nodes(render()).some(n=>n.props['aria-label']==='جاهزية الحسابات قبل الاعتماد')).toBe(false);
 });
});

it('rejects a retained enabled completion handler after newer invalid draft geometry commits',async()=>{
 props.initialLandmarks=props.initialLandmarks.map(p=>({...p,source:'manual'}));loaded();const old=button('اعتماد التحليل').props.onClick as()=>void;
 startCircle();(viewport().props.onPointerMove as(e:unknown)=>void)({...event(),clientX:169,clientY:192});render();(viewport().props.onPointerUp as(e:unknown)=>void)({...event(),clientX:169,clientY:192});await flush();
 old();await flush();expect(fetchMock.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);expect(confirmation).not.toHaveBeenCalled();
});

describe('direct ceph response retirement boundaries',()=>{
 it.each(['complete','duplicate','discard'] as const)('does not navigate a retired workspace after late %s success',async action=>{
  let respond!:(value:unknown)=>void;fetchMock.mockImplementationOnce(()=>new Promise(r=>{respond=r;}));
  props.initialLandmarks=props.initialLandmarks.map(p=>({...p,source:'manual'}));
  if(action==='duplicate')props={...props,analysis:{...props.analysis,status:'completed'},stamped:[]};
  Object.assign(window,{prompt:()=> 'Synthetic discard reason'});loaded();
  click(action==='complete'?'اعتماد التحليل':action==='duplicate'?'نسخة تصحيح جديدة':'رفض المسودة');render();expect(fetchMock).toHaveBeenCalledTimes(1);
  hooks.effects.forEach(e=>e.cleanup?.());hooks.effects.clear();window.location.href='/patients/999';hooks.changed=false;
  respond({ok:true,status:200,json:async()=>({ok:true,id:88})});for(let i=0;i<40;i++)await Promise.resolve();
  expect(window.location.href).toBe('/patients/999');expect(hooks.changed).toBe(false);
 });
 it('does not acknowledge old diagnosis text or mutate state after actor retirement',async()=>{
  let respond!:(value:unknown)=>void;fetchMock.mockImplementationOnce(()=>new Promise(r=>{respond=r;}));props={...props,actorId:1};loaded();
  const mode=nodes(render()).find(n=>n.type==='button'&&text(n).includes('2. التحليل والمدارس السبع'))!;(mode.props.onClick as()=>void)();render();
  const area=nodes(render()).filter(n=>n.type==='textarea')[3];(area.props.onChange as(e:unknown)=>void)({target:{value:'Synthetic actor A diagnosis'}});render();click('حفظ التشخيص');render();
  props={...props,actorId:2};render();hooks.changed=false;
  respond({ok:true,status:200,json:async()=>({diagnosis:{skeletal:null,dental:null,softTissue:null,note:null,finalDx:'Synthetic actor A diagnosis'}})});for(let i=0;i<40;i++)await Promise.resolve();
  expect(hooks.changed).toBe(false);expect(text(render())).not.toContain('التشخيص محفوظ');
 });
 it('does not issue a fresh correction POST through a retained handler after unmount',async()=>{
  props={...props,analysis:{...props.analysis,status:'completed'},stamped:[]};loaded();const old=button('نسخة تصحيح جديدة').props.onClick as()=>void;
  hooks.effects.forEach(e=>e.cleanup?.());hooks.effects.clear();old();for(let i=0;i<40;i++)await Promise.resolve();expect(fetchMock).not.toHaveBeenCalled();
 });
});

it.each(['complete','duplicate','discard'] as const)('single-flights repeated same-turn %s handlers',action=>{
 fetchMock.mockImplementation(()=>new Promise(()=>{}));props.initialLandmarks=props.initialLandmarks.map(p=>({...p,source:'manual'}));
 if(action==='duplicate')props={...props,analysis:{...props.analysis,status:'completed'},stamped:[]};
 Object.assign(window,{prompt:()=> 'Synthetic reason'});loaded();const handler=button(action==='complete'?'اعتماد التحليل':action==='duplicate'?'نسخة تصحيح جديدة':'رفض المسودة').props.onClick as()=>void;
 handler();handler();expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('ignores a duplicate response body that resolves only after committed retirement',async()=>{
 let body!:(value:unknown)=>void;fetchMock.mockResolvedValue({ok:true,status:200,json:()=>new Promise(r=>{body=r;})});
 props={...props,analysis:{...props.analysis,status:'completed'},stamped:[]};loaded();click('نسخة تصحيح جديدة');for(let i=0;i<10;i++)await Promise.resolve();
 hooks.effects.forEach(e=>e.cleanup?.());hooks.effects.clear();window.location.href='/patients/999';body({id:88});for(let i=0;i<30;i++)await Promise.resolve();expect(window.location.href).toBe('/patients/999');
});
it('ignores failed complete response and finally setters after retirement',async()=>{
 let reject!:(value:unknown)=>void;fetchMock.mockImplementation(()=>new Promise((_r,j)=>{reject=j;}));props.initialLandmarks=props.initialLandmarks.map(p=>({...p,source:'manual'}));loaded();click('اعتماد التحليل');render();
 hooks.effects.forEach(e=>e.cleanup?.());hooks.effects.clear();hooks.changed=false;reject(new Error('Synthetic lost reply'));for(let i=0;i<30;i++)await Promise.resolve();expect(hooks.changed).toBe(false);
});

it.each(['complete','duplicate','discard'] as const)('keeps valid same-owner %s success and failure behavior',async action=>{
 props.initialLandmarks=props.initialLandmarks.map(p=>({...p,source:'manual'}));if(action==='duplicate')props={...props,analysis:{...props.analysis,status:'completed'},stamped:[]};Object.assign(window,{prompt:()=> 'Synthetic reason'});loaded();
 const label=action==='complete'?'اعتماد التحليل':action==='duplicate'?'نسخة تصحيح جديدة':'رفض المسودة';fetchMock.mockResolvedValueOnce({ok:false,status:403,json:async()=>({message:'Synthetic denied'})});click(label);await flush();expect(text(render())).toContain('Synthetic denied');
 fetchMock.mockResolvedValueOnce({ok:true,status:200,json:async()=>({id:88})});click(label);await flush();expect(window.location.href).toBe(action==='complete'?'/ceph/71':action==='duplicate'?'/ceph/88':'/patients/11?tab=ceph');expect(fetchMock).toHaveBeenCalledTimes(2);
});
it.each(['complete','duplicate','discard'] as const)('rechecks scope after the %s confirmation dialog',async action=>{
 props={...props,actorId:1,initialLandmarks:props.initialLandmarks.map(p=>({...p,source:'manual'}))};if(action==='duplicate')props={...props,analysis:{...props.analysis,status:'completed'},stamped:[]};loaded();
 const retire=()=>{props={...props,actorId:2};render();};confirmation.mockImplementation(()=>{retire();return true;});Object.assign(window,{prompt:()=>{retire();return 'Synthetic reason';}});
 click(action==='complete'?'اعتماد التحليل':action==='duplicate'?'نسخة تصحيح جديدة':'رفض المسودة');await flush();expect(fetchMock).not.toHaveBeenCalled();
});
it('does not revive a pending completed correction on actor ABA or readonly change',async()=>{
 let respond!:(v:unknown)=>void;fetchMock.mockImplementationOnce(()=>new Promise(r=>{respond=r;}));props={...props,actorId:1,analysis:{...props.analysis,status:'completed'},stamped:[]};loaded();const old=button('نسخة تصحيح جديدة').props.onClick as()=>void;old();render();const original=props;
 props={...props,actorId:2,readOnly:true};render();props=original;render();window.location.href='/patients/999';respond({ok:true,status:200,json:async()=>({id:88})});await flush();old();await flush();expect(window.location.href).toBe('/patients/999');expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('single-flights diagnosis save while retaining original submitted text and later edits',async()=>{
 let respond!:(v:unknown)=>void;fetchMock.mockImplementationOnce(()=>new Promise(r=>{respond=r;}));loaded();const mode=nodes(render()).find(n=>n.type==='button'&&text(n).includes('2. التحليل والمدارس السبع'))!;(mode.props.onClick as()=>void)();render();
 const edit=(value:string)=>{const area=nodes(render()).filter(n=>n.type==='textarea')[3];(area.props.onChange as(e:unknown)=>void)({target:{value}});render();};edit('First synthetic diagnosis');const handler=button('حفظ التشخيص').props.onClick as()=>void;handler();handler();expect(fetchMock).toHaveBeenCalledTimes(1);render();edit('Later local diagnosis');respond({ok:true,status:200,json:async()=>({diagnosis:{skeletal:null,dental:null,softTissue:null,note:null,finalDx:'First synthetic diagnosis'}})});await flush();expect(nodes(render()).filter(n=>n.type==='textarea')[3].props.value).toBe('Later local diagnosis');expect(text(render())).toContain('توجد تعديلات أحدث');
});
it('releases cancelled confirmation tickets without sending and preserves completed readonly correction eligibility',async()=>{
 props={...props,analysis:{...props.analysis,status:'completed'},stamped:[],readOnly:true};loaded();confirmation.mockReturnValueOnce(false);click('نسخة تصحيح جديدة');await flush();expect(fetchMock).not.toHaveBeenCalled();fetchMock.mockResolvedValueOnce({ok:true,status:200,json:async()=>({id:88})});click('نسخة تصحيح جديدة');await flush();expect(window.location.href).toBe('/ceph/88');
});

it('supports initial completed-view layout replay but refuses reconnect after a sent lifecycle request',async()=>{
 let respond!:(v:unknown)=>void;fetchMock.mockImplementationOnce(()=>new Promise(r=>{respond=r;}));props={...props,analysis:{...props.analysis,status:'completed'},stamped:[]};loaded();
 const replay=()=>{const effects=[...hooks.effects.values()].filter(e=>e.replay);effects.forEach(e=>e.cleanup?.());effects.forEach(e=>e.replay?.());render();};
 replay();click('نسخة تصحيح جديدة');render();expect(fetchMock).toHaveBeenCalledTimes(1);replay();click('نسخة تصحيح جديدة');expect(fetchMock).toHaveBeenCalledTimes(1);window.location.href='/patients/999';respond({ok:true,status:200,json:async()=>({id:88})});await flush();expect(window.location.href).toBe('/patients/999');expect(text(render())).toContain('أعد فتح الدراسة');
});
it.each([undefined,0,'88',Number.MAX_SAFE_INTEGER+1])('does not navigate to an unverified correction ID %s',async id=>{
 props={...props,analysis:{...props.analysis,status:'completed'},stamped:[]};fetchMock.mockResolvedValueOnce({ok:true,status:200,json:async()=>({id})});loaded();click('نسخة تصحيح جديدة');await flush();expect(window.location.href).toBe('/ceph/71');expect(text(render())).toContain('قد تكون حُفظت');expect(fetchMock).toHaveBeenCalledTimes(1);
});

describe('same-turn drawing history and calibration intent',()=>{
 it('applies two Undo actions to two distinct current history entries',async()=>{
  loaded();selectCircle();key('ArrowRight');await flush();key('ArrowRight');await flush();
  const undo=button('تراجع').props.onClick as()=>void;undo();undo();await flush();
  expect(edits().map(e=>e.landmarks?.[0]?.x)).toEqual([101,102,101,100]);
  expect(button('تراجع').props.disabled).toBe(true);
 });
 it('applies two Redo actions to two distinct current future entries',async()=>{
  loaded();selectCircle();key('ArrowRight');await flush();key('ArrowRight');await flush();click('تراجع');await flush();click('تراجع');await flush();
  const redo=button('إعادة').props.onClick as()=>void;redo();redo();await flush();
  expect(edits().map(e=>e.landmarks?.[0]?.x)).toEqual([101,102,101,100,101,102]);
  expect(button('إعادة').props.disabled).toBe(true);
 });
 it.each([false,true])('does not submit a retained calibration save after length changes (committed=%s)',async committed=>{
  loaded();click('تصحيح المعايرة');render();(viewport().props.onPointerStart as()=>void)();
  (viewport().props.onClick as(e:unknown)=>void)({...event(),detail:0,clientX:0,clientY:0});render();
  (viewport().props.onClick as(e:unknown)=>void)({...event(),detail:0,clientX:100,clientY:0});render();const old=button('حفظ المعايرة').props.onClick as()=>void;
  const input=nodes(render()).find(n=>n.type==='input'&&n.props.type==='number'&&n.props.value==='10')!;(input.props.onChange as(e:unknown)=>void)({target:{value:'20'}});if(committed)render();
  old();await flush();expect(fetchMock).not.toHaveBeenCalled();
 });
});

it('single-flights same-turn calibration save without appending a duplicate queued write',async()=>{
 let respond!:(v:unknown)=>void;fetchMock.mockImplementationOnce(()=>new Promise(r=>{respond=r;}));loaded();click('تصحيح المعايرة');render();(viewport().props.onPointerStart as()=>void)();
 (viewport().props.onClick as(e:unknown)=>void)({...event(),detail:0,clientX:0,clientY:0});render();(viewport().props.onClick as(e:unknown)=>void)({...event(),detail:0,clientX:100,clientY:0});render();
 const save=button('حفظ المعايرة').props.onClick as()=>void;save();save();const calibration={x1:0,y1:0,x2:100,y2:0,mm:10};respond({ok:true,status:200,json:async()=>({ok:true,calibration,mmPerPixel:.1})});await flush();expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('intentionally applies retained Undo to latest history and rejects Redo after a new branch',async()=>{
 loaded();selectCircle();key('ArrowRight');await flush();const undo=button('تراجع').props.onClick as()=>void;key('ArrowRight');await flush();undo();await flush();expect(edits().map(e=>e.landmarks?.[0]?.x)).toEqual([101,102,101]);
 const redo=button('إعادة').props.onClick as()=>void;key('ArrowRight');await flush();const count=edits().length;redo();await flush();expect(edits()).toHaveLength(count);expect(button('إعادة').props.disabled).toBe(true);
});
it('preserves the40-entry undo bound during repeated same-turn actions',async()=>{
 loaded();selectCircle();for(let i=0;i<42;i++)key('ArrowRight');for(let i=0;i<1000;i++)await Promise.resolve();render();const undo=button('تراجع').props.onClick as()=>void;for(let i=0;i<42;i++)undo();for(let i=0;i<1000;i++)await Promise.resolve();render();expect(edits().at(-1)?.landmarks?.[0]?.x).toBe(102);expect(button('تراجع').props.disabled).toBe(true);
});
describe('frozen pending ruler intent and explicit retry',()=>{
 const ruler=()=>{loaded();click('تصحيح المعايرة');render();(viewport().props.onPointerStart as()=>void)();(viewport().props.onClick as(e:unknown)=>void)({...event(),detail:0,clientX:0,clientY:0});render();(viewport().props.onClick as(e:unknown)=>void)({...event(),detail:0,clientX:100,clientY:0});render();};
 const lengthInput=()=>nodes(render()).find(n=>n.type==='input'&&n.props.type==='number'&&n.props.value==='10')!;
 it('does not accept newer ruler controls while a calibration flight is pending',async()=>{
  let respond!:(v:unknown)=>void;fetchMock.mockImplementationOnce(()=>new Promise(r=>{respond=r;}));ruler();const input=lengthInput().props.onChange as(e:unknown)=>void;const cancel=button('إلغاء المعايرة').props.onClick as()=>void;const surface=viewport().props.onClick as(e:unknown)=>void;
  click('حفظ المعايرة');input({target:{value:'20'}});cancel();surface({...event(),detail:0,clientX:300,clientY:0});render();expect(lengthInput().props.value).toBe('10');
  const calibration={x1:0,y1:0,x2:100,y2:0,mm:10};respond({ok:true,status:200,json:async()=>({ok:true,calibration,mmPerPixel:.1})});await flush();expect(edits()).toHaveLength(1);expect(text(render())).toContain('المعايرة محفوظة.');
 });
 it('retries only the frozen calibration after a lost reply, without admitting a second ruler save',async()=>{
  fetchMock.mockRejectedValueOnce(new Error('Synthetic lost acknowledgement'));ruler();const save=button('حفظ المعايرة').props.onClick as()=>void;save();await flush();const first=edits()[0];
  (lengthInput().props.onChange as(e:unknown)=>void)({target:{value:'20'}});save();render();expect(edits()).toHaveLength(1);expect(lengthInput().props.value).toBe('10');
  fetchMock.mockResolvedValueOnce({ok:true,status:200,json:async()=>({ok:true,calibration:first.calibration,mmPerPixel:.1})});click('إعادة محاولة الحفظ');await flush();expect(edits()).toEqual([first,first]);expect(text(render())).toContain('المعايرة محفوظة.');
 });
 it('rejects old calibration save after cancel and accepts corrected positive length with zero-coordinate endpoints',async()=>{
  ruler();const old=button('حفظ المعايرة').props.onClick as()=>void;click('إلغاء المعايرة');render();old();await flush();expect(fetchMock).not.toHaveBeenCalled();
  ruler();(lengthInput().props.onChange as(e:unknown)=>void)({target:{value:'0'}});render();click('حفظ المعايرة');await flush();expect(fetchMock).not.toHaveBeenCalled();
  const input=nodes(render()).find(n=>n.type==='input'&&n.props.type==='number'&&n.props.value==='0')!;(input.props.onChange as(e:unknown)=>void)({target:{value:'20'}});render();const calibration={x1:0,y1:0,x2:100,y2:0,mm:20};fetchMock.mockResolvedValueOnce({ok:true,status:200,json:async()=>({ok:true,calibration,mmPerPixel:.2})});click('حفظ المعايرة');await flush();expect(edits()[0].calibration).toEqual(calibration);expect(text(render())).toContain('المعايرة محفوظة.');
 });
});

describe('drawing failure recovery ownership',()=>{
 const fail=async()=>{fetchMock.mockRejectedValueOnce(new Error('Synthetic committed request, lost reply'));loaded();selectCircle();key('ArrowRight');await flush();};
 const reloadSpy=()=>{const reload=vi.fn();Object.assign(window.location,{reload});return reload;};
 it('rejects a retained reload control after immutable actor retirement',async()=>{
  props.actorId=1;await fail();const reload=reloadSpy();const old=button('إعادة تحميل أحدث نسخة').props.onClick as()=>void;
  props={...props,actorId:2};render();props={...props,actorId:1};render();confirmation.mockClear();old();
  expect(confirmation).not.toHaveBeenCalled();expect(reload).not.toHaveBeenCalled();
 });
 it('rechecks recovery ownership after confirmation changes the workspace',async()=>{
  props.actorId=1;await fail();const reload=reloadSpy();const old=button('إعادة تحميل أحدث نسخة').props.onClick as()=>void;
  confirmation.mockImplementationOnce(()=>{props={...props,actorId:2};render();return true;});old();expect(reload).not.toHaveBeenCalled();
 });
 it('rejects retained reload after retry already acknowledged the pending write',async()=>{
  await fail();const reload=reloadSpy();const old=button('إعادة تحميل أحدث نسخة').props.onClick as()=>void;
  click('إعادة محاولة الحفظ');await flush();confirmation.mockClear();old();expect(confirmation).not.toHaveBeenCalled();expect(reload).not.toHaveBeenCalled();
 });
 it('rejects retained failure reload once an explicit retry is in flight',async()=>{
  await fail();const reload=reloadSpy();const old=button('إعادة تحميل أحدث نسخة').props.onClick as()=>void;
  key('ArrowRight');let respond!:(v:unknown)=>void;fetchMock.mockImplementationOnce(()=>new Promise(r=>{respond=r;}));
  click('إعادة محاولة الحفظ');old();expect(reload).not.toHaveBeenCalled();
  respond({ok:true,status:200,json:async()=>({ok:true})});await flush();
 });
 it('does not call an unacknowledged potentially committed write definitely unsaved',async()=>{
  await fail();expect(text(render())).not.toContain('التعديلات غير المحفوظة:');
 });
 it('keeps a canceled reload ticket usable for a current retry and consumes retry synchronously',async()=>{
  await fail();const reload=reloadSpy();const reloadAction=button('إعادة تحميل أحدث نسخة').props.onClick as()=>void;
  confirmation.mockReturnValueOnce(false);reloadAction();expect(reload).not.toHaveBeenCalled();
  const retry=button('إعادة محاولة الحفظ').props.onClick as()=>void;retry();retry();await flush();expect(edits()).toHaveLength(2);expect(text(render())).not.toContain('إعادة محاولة الحفظ');
 });
 it('retains a new same-owner failure while rejecting controls from the previous failure',async()=>{
  await fail();const reload=reloadSpy();const oldReload=button('إعادة تحميل أحدث نسخة').props.onClick as()=>void;const oldRetry=button('إعادة محاولة الحفظ').props.onClick as()=>void;
  fetchMock.mockRejectedValueOnce(new Error('Second uncertain reply'));oldRetry();await flush();confirmation.mockClear();oldReload();oldRetry();expect(reload).not.toHaveBeenCalled();expect(confirmation).not.toHaveBeenCalled();expect(edits()).toHaveLength(2);
  click('إعادة محاولة الحفظ');await flush();expect(edits()).toHaveLength(3);
 });
 it.each([false,true])('retires edits before reload even if reload throws=%s',async throws=>{
  await fail();key('ArrowRight');const reload=reloadSpy();if(throws)reload.mockImplementation(()=>{throw new Error('Synthetic blocked navigation');});
  const oldRetry=button('إعادة محاولة الحفظ').props.onClick as()=>void;const reloadAction=button('إعادة تحميل أحدث نسخة').props.onClick as()=>void;
  const count=edits().length;reloadAction();reloadAction();oldRetry();key('ArrowRight');await flush();expect(reload).toHaveBeenCalledTimes(1);expect(edits()).toHaveLength(count);expect(text(render())).toContain('انتهت جلسة الرسم');
  if(throws)expect(text(render())).toContain('تعذّر إعادة تحميل الدراسة');
 });

});

describe('explicit selected landmark clear',()=>{
 it.each(['manual','suggested'] as const)('can clear a reopened saved %s point with no Undo history',async source=>{
  props.initialLandmarks=props.initialLandmarks.map(p=>({...p,source:p.code==='S'?source:'manual'}));loaded();click(source==='manual'?'S ✓':'S ✦');
  expect(button('تراجع').props.disabled).toBe(true);click('إزالة موضع S من المسودة');await flush();
  expect(edits()).toEqual([{removeLandmarks:['S'],expectedLandmarks:[{code:'S',x:100,y:200,source}]}]);
  expect(button('اعتماد التحليل').props.disabled).toBe(true);expect(button('S')).toBeDefined();
  click('تراجع');await flush();expect(edits()[1].landmarks).toEqual([{code:'S',x:100,y:200,source}]);
 });
 it('clears an optional input without making required readiness incomplete',async()=>{
  props.initialLandmarks=props.initialLandmarks.map(p=>({...p,source:'manual'}));props.initialLandmarks.push({code:'D',x:120,y:220,source:'manual'});loaded();click('D ✓');click('إزالة موضع D من المسودة');await flush();expect(button('D')).toBeDefined();expect(button('اعتماد التحليل').props.disabled).toBe(false);
 });
 it('cancels without mutation and consumes a confirmed clear only once',async()=>{
  loaded();click('S ✦');const clear=button('إزالة موضع S من المسودة').props.onClick as()=>void;confirmation.mockReturnValueOnce(false);clear();expect(edits()).toEqual([]);expect(button('تراجع').props.disabled).toBe(true);clear();clear();await flush();expect(edits()).toHaveLength(1);
 });
 it.each(['selection','actor','calibration','pan','drag'] as const)('rejects old clear after %s changes, including inside confirmation',async kind=>{
  props.actorId=1;loaded();click('S ✦');const clear=button('إزالة موضع S من المسودة').props.onClick as()=>void;
  const change=()=>{if(kind==='selection')click('N ✓');else if(kind==='actor'){props={...props,actorId:2};render();props={...props,actorId:1};render();}else if(kind==='calibration')click('تصحيح المعايرة');else if(kind==='drag')startCircle();else {const pan=nodes(render()).find(n=>n.type==='button'&&n.props['aria-pressed']===false&&text(n).includes('تحريك الصورة'))!;(pan.props.onClick as()=>void)();}};
  confirmation.mockImplementationOnce(()=>{change();return true;});clear();await flush();expect(edits()).toEqual([]);
  clear();await flush();expect(edits()).toEqual([]);
 });
 it('preserves suggested coordinates through failed clear retry and queued Undo',async()=>{
  loaded();click('S ✦');fetchMock.mockRejectedValueOnce(new Error('Lost clear acknowledgement'));click('إزالة موضع S من المسودة');await flush();click('تراجع');await flush();expect(edits()).toHaveLength(1);click('إعادة محاولة الحفظ');await flush();expect(edits()[1]).toEqual(edits()[0]);expect(edits()[2]).toEqual({landmarks:[{code:'S',x:100,y:200,source:'suggested'}],removeLandmarks:[],expectedLandmarks:[]});expect(button('S ✦')).toBeDefined();
 });
 it.each(['readonly','completed'] as const)('never exposes clear in %s view',mode=>{
  if(mode==='readonly')props.readOnly=true;else props.analysis={...props.analysis,status:'completed'};loaded();expect(text(render())).not.toContain('إزالة موضع');expect(fetchMock).not.toHaveBeenCalled();
 });

});

describe('current drawing placement intent',()=>{
 it('advances actual required-point placement without losing the preceding point before a rerender',async()=>{
  props.initialLandmarks=[];loaded();const place=viewport().props.onClick as(e:unknown)=>void;
  place({...event(),detail:0,clientX:100,clientY:200});place({...event(),detail:0,clientX:169,clientY:192});await flush();
  expect(edits().map(e=>e.landmarks)).toEqual([[{code:'S',x:100,y:200,source:'manual'}],[{code:'N',x:169,y:192,source:'manual'}]]);
  expect(button('S ✓')).toBeDefined();expect(button('N ✓')).toBeDefined();click('تراجع');await flush();expect(button('S ✓')).toBeDefined();expect(button('N')).toBeDefined();
 });
 it('does not let a retained surface callback erase a point placed in a newer committed render',async()=>{
  props.initialLandmarks=[];loaded();const old=viewport().props.onClick as(e:unknown)=>void;
  old({...event(),detail:0,clientX:100,clientY:200});await flush();
  (viewport().props.onClick as(e:unknown)=>void)({...event(),detail:0,clientX:169,clientY:192});await flush();
  old({...event(),detail:0,clientX:110,clientY:210});await flush();expect(button('N ✓')).toBeDefined();
 });
 it('uses a newly selected landmark and latest point map even before selection rerenders',async()=>{
  props.initialLandmarks=[];loaded();const old=viewport().props.onClick as(e:unknown)=>void;old({...event(),detail:0,clientX:100,clientY:200});await flush();click('N');old({...event(),detail:0,clientX:169,clientY:192});await flush();expect(edits()[1]).toEqual({landmarks:[{code:'N',x:169,y:192,source:'manual'}],expectedLandmarks:[]});expect(button('S ✓')).toBeDefined();expect(button('N ✓')).toBeDefined();
  click('تراجع');await flush();expect(edits()[2].removeLandmarks).toEqual(['N']);expect(button('S ✓')).toBeDefined();click('تراجع');await flush();expect(button('S')).toBeDefined();
 });
 it.each(['pan','calibration','drag','actor','readonly'] as const)('rejects an old surface after %s transition',async mode=>{
  props.actorId=1;loaded();const old=viewport().props.onClick as(e:unknown)=>void;
  if(mode==='pan'){const pan=nodes(render()).find(n=>n.type==='button'&&n.props['aria-pressed']===false&&text(n).includes('تحريك الصورة'))!;(pan.props.onClick as()=>void)();}
  else if(mode==='calibration')click('تصحيح المعايرة');else if(mode==='drag')startCircle();else if(mode==='readonly'){props={...props,readOnly:true};render();}else{props={...props,actorId:2};render();props={...props,actorId:1};render();}
  old({...event(),detail:0,clientX:300,clientY:300});await flush();expect(edits()).toEqual([]);
 });
 it('collects two current ruler endpoints without replacing the first before rerender',async()=>{
  loaded();click('تصحيح المعايرة');render();(viewport().props.onPointerStart as()=>void)();const place=viewport().props.onClick as(e:unknown)=>void;
  place({...event(),detail:0,clientX:0,clientY:0});place({...event(),detail:0,clientX:100,clientY:0});render();click('حفظ المعايرة');await flush();expect(edits()[0].calibration).toEqual({x1:0,y1:0,x2:100,y2:0,mm:10});
 });

});

describe('landmark drag pointer ownership',()=>{
 it('ignores another pointer moving while the first owns a landmark drag',async()=>{
  loaded();startCircle();(viewport().props.onPointerMove as(e:unknown)=>void)({...event(),pointerId:2,pointerType:'pen',clientX:300,clientY:350});
  (viewport().props.onPointerUp as(e:unknown)=>void)(event());await flush();expect(edits()).toEqual([]);
 });
 it('does not commit or terminate a held landmark drag on another pointer up',async()=>{
  loaded();startCircle();(viewport().props.onPointerMove as(e:unknown)=>void)({...event(),clientX:120,clientY:220});
  (viewport().props.onPointerUp as(e:unknown)=>void)({...event(),pointerId:2,pointerType:'pen'});await flush();expect(edits()).toEqual([]);
  (viewport().props.onPointerUp as(e:unknown)=>void)({...event(),clientX:120,clientY:220});await flush();expect(edits()[0].landmarks).toEqual([{code:'S',x:120,y:220,source:'manual'}]);
 });
 it('ignores foreign cancel but owning cancel rolls back without a write',async()=>{
  loaded();startCircle();(viewport().props.onPointerMove as(e:unknown)=>void)({...event(),clientX:120,clientY:220});
  (viewport().props.onPointerCancel as(e:unknown)=>void)({...event(),pointerId:2});
  (viewport().props.onPointerUp as(e:unknown)=>void)({...event(),clientX:120,clientY:220});await flush();expect(edits()).toHaveLength(1);
  const overlay=(viewport().props.renderOverlay as(s:number,i:boolean)=>ReactNode)(1,true);const current=nodes(overlay).find(n=>n.type==='circle'&&n.props.cx===120&&typeof n.props.onPointerDown==='function')!;(current.props.onPointerDown as(e:unknown)=>void)({...event(),clientX:120,clientY:220});render();(viewport().props.onPointerMove as(e:unknown)=>void)({...event(),clientX:130,clientY:230});(viewport().props.onPointerCancel as(e:unknown)=>void)(event());await flush();expect(edits()).toHaveLength(1);
 });
 it('explicit gesture takeover rolls back a held preview and consumes its trailing click',async()=>{
  loaded();startCircle();(viewport().props.onPointerMove as(e:unknown)=>void)({...event(),clientX:120,clientY:220});
  (viewport().props.onGestureTakeover as()=>void)();(viewport().props.onPointerUp as(e:unknown)=>void)(event());
  (viewport().props.onClick as(e:unknown)=>void)({...event(),detail:1});await flush();expect(edits()).toEqual([]);expect(button('تراجع').props.disabled).toBe(true);
 });
 it('cancels owning capture loss but ignores a late loss from an older captured element',async()=>{
  loaded();const overlay=()=> (viewport().props.renderOverlay as(s:number,i:boolean)=>ReactNode)(1,true);
  const circle=()=>nodes(overlay()).find(n=>n.type==='circle'&&n.props.cx===100&&typeof n.props.onPointerDown==='function')!;
  const target={setPointerCapture(){},hasPointerCapture:()=>false};const old=circle();(old.props.onPointerDown as(e:unknown)=>void)({...event(),currentTarget:target});render();
  (viewport().props.onPointerMove as(e:unknown)=>void)({...event(),clientX:120,clientY:220});
  (old.props.onLostPointerCapture as(e:unknown)=>void)({...event(),currentTarget:target});await flush();expect(edits()).toEqual([]);
  const next=circle();const nextTarget={setPointerCapture(){},hasPointerCapture:()=>true};(next.props.onPointerDown as(e:unknown)=>void)({...event(),currentTarget:nextTarget});render();
  (old.props.onLostPointerCapture as(e:unknown)=>void)({...event(),currentTarget:target});
  (viewport().props.onPointerMove as(e:unknown)=>void)({...event(),clientX:125,clientY:225});(viewport().props.onPointerUp as(e:unknown)=>void)({...event(),clientX:125,clientY:225});await flush();expect(edits()[0].landmarks[0].x).toBe(125);
 });

});

describe('manual review exact current landmark intent',()=>{
 it('rejects a retained S review callback after selection changed to N',async()=>{
  loaded();click('S ✦');const review=button('راجعت موضع S على الأشعة').props.onClick as()=>void;click('N ✓');review();await flush();expect(edits()).toEqual([]);expect(confirmation).not.toHaveBeenCalled();
 });
 it('does not overwrite newer coordinates if a confirmed review returns after a point change',async()=>{
  loaded();click('S ✦');const review=button('راجعت موضع S على الأشعة').props.onClick as()=>void;
  confirmation.mockImplementationOnce(()=>{key('ArrowRight');return true;});review();await flush();
  expect(edits()).toHaveLength(1);expect(edits()[0].landmarks).toEqual([{code:'S',x:101,y:200,source:'manual'}]);
 });
 it('consumes a current review once and preserves exact suggested-source Undo',async()=>{
  loaded();click('S ✦');const review=button('راجعت موضع S على الأشعة').props.onClick as()=>void;review();review();await flush();expect(edits()).toHaveLength(1);expect(confirmation).toHaveBeenCalledTimes(1);click('تراجع');await flush();expect(edits()[1].landmarks).toEqual([{code:'S',x:100,y:200,source:'suggested'}]);
 });
 it('rejects an old review across selection ABA without disabling the newly selected review',async()=>{
  loaded();click('S ✦');const old=button('راجعت موضع S على الأشعة').props.onClick as()=>void;click('N ✓');render();click('S ✦');render();old();await flush();expect(edits()).toEqual([]);click('راجعت موضع S على الأشعة');await flush();expect(edits()).toHaveLength(1);
 });
 it.each(['actor','image','calibration','pan'] as const)('rejects confirmation continuation after %s changes',async mode=>{
  props.actorId=1;loaded();click('S ✦');const review=button('راجعت موضع S على الأشعة').props.onClick as()=>void;
  confirmation.mockImplementationOnce(()=>{if(mode==='actor'){props={...props,actorId:2};render();props={...props,actorId:1};render();}else if(mode==='image'){(viewport().props.onNaturalSize as(s:unknown)=>void)(null);render();}else if(mode==='calibration')click('تصحيح المعايرة');else{const pan=nodes(render()).find(n=>n.type==='button'&&n.props['aria-pressed']===false&&text(n).includes('تحريك الصورة'))!;(pan.props.onClick as()=>void)();}return true;});review();await flush();expect(edits()).toEqual([]);
 });

});

describe('landmark final release coordinate',()=>{
 it('persists the owning pointer release position rather than the last move position',async()=>{
  loaded();startCircle();(viewport().props.onPointerMove as(e:unknown)=>void)({...event(),clientX:120,clientY:220});
  (viewport().props.onPointerUp as(e:unknown)=>void)({...event(),clientX:125,clientY:225});await flush();expect(edits()[0].landmarks).toEqual([{code:'S',x:125,y:225,source:'manual'}]);
 });
 it('saves a changed release point even when no intermediate move was delivered',async()=>{
  loaded();startCircle();(viewport().props.onPointerUp as(e:unknown)=>void)({...event(),clientX:125,clientY:225});await flush();expect(edits()).toHaveLength(1);expect(edits()[0].landmarks[0]).toMatchObject({code:'S',x:125,y:225});
 });
 it('does not save a gesture released back at its original coordinate',async()=>{
  loaded();startCircle();(viewport().props.onPointerMove as(e:unknown)=>void)({...event(),clientX:120,clientY:220});
  (viewport().props.onPointerUp as(e:unknown)=>void)(event());await flush();expect(edits()).toEqual([]);expect(button('تراجع').props.disabled).toBe(true);
 });
 it('uses native fractional release coordinates, clamps edges and restores the exact original through Undo',async()=>{
  loaded();startCircle();(viewport().props.onPointerUp as(e:unknown)=>void)({...event(),clientX:62.625,clientY:112.625,currentTarget:{getBoundingClientRect:()=>({left:0,top:0,width:600,height:400})}});await flush();expect(edits()[0].landmarks[0]).toMatchObject({x:125.3,y:225.3});click('تراجع');await flush();expect(edits()[1].landmarks[0]).toEqual({code:'S',x:100,y:200,source:'suggested'});
  startCircle();(viewport().props.onPointerUp as(e:unknown)=>void)({...event(),clientX:-30,clientY:900});await flush();expect(edits()[2].landmarks[0]).toMatchObject({x:0,y:800});
 });
 it.each(['empty','nonfinite'] as const)('restores an unsaved preview on invalid %s release geometry',async mode=>{
  loaded();startCircle();(viewport().props.onPointerMove as(e:unknown)=>void)({...event(),clientX:120,clientY:220});
  (viewport().props.onPointerUp as(e:unknown)=>void)({...event(),clientX:mode==='nonfinite'?NaN:120,currentTarget:{getBoundingClientRect:()=>({left:0,top:0,width:mode==='empty'?0:1200,height:800})}});await flush();expect(edits()).toEqual([]);expect(button('S ✦')).toBeDefined();expect(button('تراجع').props.disabled).toBe(true);
 });

 it('does not move or review a point when clicked off-center inside its hit circle without pointer travel',async()=>{
  loaded();const overlay=(viewport().props.renderOverlay as(s:number,i:boolean)=>ReactNode)(1,true);const point=nodes(overlay).find(n=>n.type==='circle'&&n.props.cx===100&&typeof n.props.onPointerDown==='function')!;
  (point.props.onPointerDown as(e:unknown)=>void)({...event(),clientX:103,clientY:202});render();(viewport().props.onPointerUp as(e:unknown)=>void)({...event(),clientX:103,clientY:202});await flush();expect(edits()).toEqual([]);expect(button('S ✦')).toBeDefined();
 });

});

describe('committed tracer authority survives abandoned render', () => {
  it.each(['actor', 'source', 'calibration'] as const)('does not replace the committed drawing owner for an abandoned %s render', async change => {
    props.actorId = 1; loaded(); click('S ✦');
    const review = button('راجعت موضع S على الأشعة').props.onClick as () => void;
    const previousProps = props, previousMemos = new Map(hooks.memos), previousValues = [...hooks.values];
    props = change === 'actor' ? { ...props, actorId: 2 }
      : change === 'source' ? { ...props, analysis: { ...props.analysis, documentId: 99 } }
      : { ...props, analysis: { ...props.analysis, mmPerPixel: 0.2 } };
    hooks.cursor = 0; hooks.pending = []; CephTracer(props);
    hooks.pending = []; hooks.memos = previousMemos; hooks.values = previousValues; props = previousProps;
    review(); await flush();
    expect(edits()).toHaveLength(1);
    expect(edits()[0]).toEqual({ landmarks: [{ code: 'S', x: 100, y: 200, source: 'manual' }], expectedLandmarks: [{ code: 'S', x: 100, y: 200, source: 'suggested' }] });
  });
});


describe("correction command uses the opened source", () => {
  it("sends the exact reviewed token once without rewriting the completed study", async () => {
    props = { ...props, analysis: { ...props.analysis, status: "completed" }, stamped: [] };
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 88 }) });
    if (props.correctionSource?.state !== "available") throw Error("fixture");
    expect(props.correctionSource.token.sourceSha256).not.toBe(props.correctionSource.origin.sourceSnapshotSha256);
    loaded(); expect(button("نسخة تصحيح جديدة").props.disabled).toBe(false); click("نسخة تصحيح جديدة"); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ceph/71/duplicate");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ schemaVersion: 1,
      expectedCorrectionSource: props.correctionSource?.state === "available" ? props.correctionSource.token : null });
    expect(window.location.href).toBe("/ceph/88");
  });
  it.each(["missing", "unavailable", "wrong-case", "wrong-image", "invalid-hash", "wrong-origin"])("blocks %s correction identity even through a direct handler", async kind => {
    props = { ...props, analysis: { ...props.analysis, status: "completed" }, stamped: [] };
    if (kind === "missing") props.correctionSource = undefined;
    else if (kind === "unavailable") props.correctionSource = { state: "unavailable", reason: "source_unavailable" };
    else if (props.correctionSource?.state === "available") {
      if (kind === "wrong-case") props.correctionSource.token.orthoCaseId = 99;
      if (kind === "wrong-image") props.correctionSource.token.documentId = 99;
      if (kind === "invalid-hash") props.correctionSource.token.sourceSha256 = "invalid";
      if (kind === "wrong-origin") props.correctionSource.origin.parentAnalysisId = 99;
    }
    loaded(); expect(button("نسخة تصحيح جديدة").props.disabled).toBe(true); click("نسخة تصحيح جديدة"); await flush();
    expect(fetchMock).not.toHaveBeenCalled(); expect(confirmation).not.toHaveBeenCalled();
    expect(text(render())).toContain("أعد فتح الدراسة للتحقق");
  });
  it("retires an earlier enabled handler when the current source changes", async () => {
    props = { ...props, analysis: { ...props.analysis, status: "completed" }, stamped: [] };
    loaded(); const old = button("نسخة تصحيح جديدة").props.onClick as () => void;
    if (props.correctionSource?.state !== "available") throw Error("fixture");
    props = { ...props, correctionSource: { ...props.correctionSource, token: { ...props.correctionSource.token, sourceSha256: "d".repeat(64) } } };
    render(); old(); click("نسخة تصحيح جديدة"); await flush(); expect(fetchMock).not.toHaveBeenCalled();
  });
});

it("shows explicit correction ancestry without upgrading legacy approval", () => {
  if (props.correctionSource?.state !== "available") throw Error("fixture");
  props = { ...props, analysis: { ...props.analysis, id: 88, correctionOrigin: props.correctionSource.origin } };
  expect(text(render())).toContain("نسخة تصحيح مرتبطة");
  expect(text(render())).toContain("لا يعيد اعتماده");
  expect(nodes(render()).some(node => node.props.href === "/ceph/71")).toBe(true);
});

it.each(["network", "server", "invalid-id"])("retires an uncertain %s correction instead of sending another child command", async kind => {
  props = { ...props, analysis: { ...props.analysis, status: "completed" }, stamped: [] };
  if (kind === "network") fetchMock.mockRejectedValueOnce(new Error("lost reply"));
  else fetchMock.mockResolvedValueOnce({ ok: kind === "invalid-id", status: kind === "server" ? 500 : 200,
    json: async () => ({ id: null }) });
  loaded(); const handler = button("نسخة تصحيح جديدة").props.onClick as () => void;
  handler(); await flush(); expect(button("نسخة تصحيح جديدة").props.disabled).toBe(true);
  handler(); click("نسخة تصحيح جديدة"); await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(window.location.href).toBe("/ceph/71");
  expect(text(render())).toContain("أعد فتح سجل الدراسات للتحقق");
});
