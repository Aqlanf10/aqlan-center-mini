import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CephViewport } from "../components/CephViewport";
import { CephTracer } from "../components/CephTracer";

// Synthetic hook scheduling, element rectangles and pointer propagation execute
// the actual viewport handlers. This is not browser/device acceptance.
const context = vi.hoisted(() => {
  const make = () => ({ values: [] as unknown[], cursor: 0, changed: false,
    effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
    memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(), pending: [] as Array<() => void>,
  });
  return { make, current: make() };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const hooks = context.current; const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return i; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const hooks = context.current; const index = slot(undefined), before = hooks.memos.get(index); if (before && same(before.deps, deps)) return before.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const hooks = context.current; const index = slot(undefined), previous = hooks.effects.get(index); if (previous && same(previous.deps, deps)) return;
    hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = run(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const hooks = context.current; const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => { const hooks = context.current; const index = slot({ current: initial }); return hooks.values[index]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect, useLayoutEffect: effect,
  };
});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
let props: ComponentProps<typeof CephViewport>;
let captured: Set<number>;
let viewportHooks: ReturnType<typeof context.make>, tracerHooks: ReturnType<typeof context.make>;
let tracerProps: ComponentProps<typeof CephTracer> | null;
let tracerTree: ReactNode;
function renderTracer() {
  const hooks = context.current = tracerHooks;
  for (let round = 0; round < 20; round++) {
    hooks.cursor = 0; hooks.changed = false; hooks.pending = [];
    tracerTree = CephTracer(tracerProps!);
    if (hooks.changed) continue;
    hooks.pending.splice(0).forEach(run => run());
    if (!hooks.changed) {
      const viewport = nodes(tracerTree).find(n => n.type === CephViewport);
      if (viewport) props = { ...viewport.props as ComponentProps<typeof CephViewport>, showLoupe: false };
      return !!viewport;
    }
  }
  throw new Error("Tracer render did not settle");
}
let resizeObserved: (() => void) | undefined;
let rawLeft = 0, rawTop = 0;
const scale = () => Math.min(viewportHost.clientWidth / 1200, viewportHost.clientHeight / 800, 1) * props.zoom;
const viewportHost = { clientWidth: 600, clientHeight: 400, get scrollLeft() { return Math.max(0, Math.min(rawLeft, 1200*scale()-this.clientWidth)); },
  set scrollLeft(value: number) { rawLeft = Math.max(0, Math.min(value, 1200*scale()-this.clientWidth)); },
  get scrollTop() { return Math.max(0, Math.min(rawTop, 800*scale()-this.clientHeight)); },
  set scrollTop(value: number) { rawTop = Math.max(0, Math.min(value, 800*scale()-this.clientHeight)); },
  getBoundingClientRect: () => ({ left: 40, top: 70, width: viewportHost.clientWidth, height: viewportHost.clientHeight }) };
const surfaceHost = {
  getBoundingClientRect: () => ({ left: 40 + Math.max(0,(viewportHost.clientWidth-1200*scale())/2) - viewportHost.scrollLeft, top: 70-viewportHost.scrollTop, width: 1200*scale(), height: 800*scale() }),
  setPointerCapture: (id: number) => captured.add(id), hasPointerCapture: (id: number) => captured.has(id),
  releasePointerCapture: (id: number) => captured.delete(id),
};
function render(): Element {
  if (tracerProps && !renderTracer()) return nodes(tracerTree)[0];
  const hooks = context.current = viewportHooks;
  for (let round = 0; round < 20; round++) {
    hooks.cursor = 0; hooks.changed = false; hooks.pending = [];
    const tree = CephViewport(props);
    const elements = nodes(tree);
    for (const [id, host] of [["ceph-viewport", viewportHost], ["ceph-surface", surfaceHost]] as const) {
      const element = elements.find(n => n.props["data-testid"] === id)!;
      (element.props.ref as { current: unknown }).current = host;
    }
    if (hooks.changed) continue;
    hooks.pending.splice(0).forEach(run => run());
    if (!hooks.changed) return elements.find(n => n.props["data-testid"] === "ceph-surface")!;
  }
  throw new Error("Viewport render did not settle");
}
const event = (pointerId: number, clientX: number, pointerType = "touch") => ({
  pointerId, clientX, clientY: 100, pointerType, button: 0, currentTarget: surfaceHost,
  preventDefault: vi.fn(), stopPropagation: vi.fn(),
});
const dispatch = (handler: string, pointerId: number, clientX: number, pointerType = "touch") => {
  const e = event(pointerId, clientX, pointerType);
  const surface = render();
  (surface.props[handler] as (event: unknown) => void)(e);
  const bubble = surface.props[handler.replace("Capture", "")];
  if (handler.endsWith("Capture") && !e.stopPropagation.mock.calls.length && typeof bubble === "function") bubble(e);
  render(); return e;
};
const move = (id: number, x: number) => dispatch("onPointerMoveCapture", id, x);
const up = (id: number, x: number) => dispatch("onPointerUpCapture", id, x);
const clickSurface = (id = 1, x = 300) => {
  const e = { ...event(id, x), detail: 1 };
  const surface = render();
  (surface.props.onClickCapture as ((event: unknown) => void) | undefined)?.(e);
  if (!e.stopPropagation.mock.calls.length) (surface.props.onClick as (event: unknown) => void)(e);
  render(); return e;
};
beforeEach(() => {
  viewportHooks = context.make(); tracerHooks = context.make(); tracerProps = null; tracerTree = null;
  captured = new Set(); rawLeft = 0; rawTop = 0; viewportHost.clientWidth=600; viewportHost.clientHeight=400; resizeObserved=undefined;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resizeObserved=callback; } observe() {} disconnect() {} });
  props = { src: "/synthetic-image.png", natural: { w: 1200, h: 800 }, onNaturalSize: vi.fn(), zoom: 1,
    onZoomChange: vi.fn(zoom => { props.zoom = zoom; }), panMode: false, filter: "none", showLoupe: false,
    cursor: null, onCursor: vi.fn(), onClick: vi.fn(), onPointerStart: vi.fn(), onPointerMove: vi.fn(),
    onPointerUp: vi.fn(), onPointerCancel: vi.fn(), onGestureTakeover: vi.fn(), renderOverlay: () => null };
});
afterEach(() => { for (const hooks of [viewportHooks, tracerHooks]) hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });

const fetchMock = vi.fn();
const edits = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH").map(([, init]) => JSON.parse(init.body));
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); render(); }
function openTracer(overrides: Partial<ComponentProps<typeof CephTracer>> = {}) {
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url, init) => {
    const calibration = init?.body ? JSON.parse(init.body).calibration : undefined;
    return { ok: true, status: 200, json: async () => ({ ok: true, calibration,
      mmPerPixel: calibration ? calibration.mm / Math.hypot(calibration.x2 - calibration.x1, calibration.y2 - calibration.y1) : 0.1 }) };
  });
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, location: { href: "/ceph/71" } });
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
  tracerProps = {
    patientName: "Synthetic gesture fixture", patientBirthYear: null,
    analysis: { id: 71, patientId: 11, documentId: 51, status: "draft", orthoCaseId: null, phase: "pretreatment", xrayDate: null,
      device: null, refSet: "builtin_default", calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, mmPerPixel: 0.1, note: null,
      createdBy: "synthetic", createdAt: "2026-01-01", completedBy: null, completedAt: null, findings: null },
    initialLandmarks: [],
    stamped: null, refValues: null, refSetName: null, diagnosis: null, ...overrides,
  };
  render(); props.onNaturalSize({ w: 1200, h: 800 }); render();
}


function resize(w:number,h:number) { viewportHost.clientWidth=w; viewportHost.clientHeight=h; resizeObserved!(); render(); }
function nativeCenter() { const rect=surfaceHost.getBoundingClientRect(); return {x:(40+viewportHost.clientWidth/2-rect.left)/scale(),y:(70+viewportHost.clientHeight/2-rect.top)/scale()}; }
function clickNative(x:number,y:number) {
  const surface=render(), rect=surfaceHost.getBoundingClientRect();
  const e={...event(20,rect.left+x*scale(),"mouse"),clientY:rect.top+y*scale(),detail:1};
  (surface.props.onPointerDownCapture as (e:unknown)=>void)(e);
  (surface.props.onPointerUpCapture as (e:unknown)=>void)(e);
  (surface.props.onClick as (e:unknown)=>void)(e); render();
}
describe("native mapping through synthetic layout transitions",()=>{
  it("preserves feasible native center through same-scale width resize then toolbar zoom",()=>{
    props.zoom=2; render(); viewportHost.scrollLeft=100; viewportHost.scrollTop=80;
    expect(nativeCenter()).toEqual({x:400,y:280});
    resize(800,400); expect(nativeCenter()).toEqual({x:400,y:280});
    props.zoom=3; render(); expect(nativeCenter()).toEqual({x:400,y:280});
  });
  it("preserves center through portrait-like container reshape when scrolling permits",()=>{
    props.zoom=4; render(); viewportHost.scrollLeft=600; viewportHost.scrollTop=400;
    expect(nativeCenter()).toEqual({x:450,y:300});
    resize(400,600); expect(nativeCenter().x).toBeCloseTo(450,10); expect(nativeCenter().y).toBeCloseTo(300,10);
  });
  it("keeps actual tracer placement in native pixels after zoom, pan and reshape",async()=>{
    openTracer(); props.onZoomChange(2); render();
    const before=viewportHost.scrollLeft;
    // Middle-button panning exercises real viewport capture handlers.
    const surface=render(), start={...event(8,300,"mouse"),button:1};
    (surface.props.onPointerDownCapture as (e:unknown)=>void)(start);
    move(8,250); up(8,250); clickSurface();
    expect(viewportHost.scrollLeft).toBe(before+50);
    resize(400,600); expect(edits()).toEqual([]);
    clickNative(240,160); await flush();
    expect(edits()).toEqual([{landmarks:[{code:"S",x:240,y:160,source:"manual"}],expectedLandmarks:[]}]);
  });
  it("clamps a synthetic out-of-surface placement to native image bounds",async()=>{
    openTracer(); clickNative(-10,900); await flush();
    expect(edits()).toEqual([{landmarks:[{code:"S",x:0,y:800,source:"manual"}],expectedLandmarks:[]}]);
  });
  it("clamps scroll to achievable image extent on zoom out",()=>{
    props.zoom=4; render(); viewportHost.scrollLeft=1800; viewportHost.scrollTop=1200;
    props.zoom=1; render(); expect(viewportHost.scrollLeft).toBe(0); expect(viewportHost.scrollTop).toBe(0);
  });
});
