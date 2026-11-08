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
const viewportHost = { clientWidth: 600, clientHeight: 400, scrollLeft: 0, scrollTop: 0,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }) };
const surfaceHost = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 600 * props.zoom, height: 400 * props.zoom }),
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
const down = (id: number, x: number) => dispatch("onPointerDownCapture", id, x);
const move = (id: number, x: number) => dispatch("onPointerMoveCapture", id, x);
const up = (id: number, x: number) => dispatch("onPointerUpCapture", id, x);
const cancel = (id: number, x: number) => dispatch("onPointerCancelCapture", id, x);
const lose = (id: number, x: number) => { captured.delete(id); return dispatch("onLostPointerCapture", id, x); };
const clickSurface = (id = 1, x = 300) => {
  const e = { ...event(id, x), detail: 1 };
  const surface = render();
  (surface.props.onClickCapture as ((event: unknown) => void) | undefined)?.(e);
  if (!e.stopPropagation.mock.calls.length) (surface.props.onClick as (event: unknown) => void)(e);
  render(); return e;
};
const tap = (id = 10, x = 300) => { down(id, x); up(id, x); clickSurface(id, x); };
beforeEach(() => {
  viewportHooks = context.make(); tracerHooks = context.make(); tracerProps = null; tracerTree = null;
  captured = new Set(); viewportHost.scrollLeft = 0; viewportHost.scrollTop = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  props = { src: "/synthetic-image.png", natural: { w: 1200, h: 800 }, onNaturalSize: vi.fn(), zoom: 1,
    onZoomChange: vi.fn(zoom => { props.zoom = zoom; }), panMode: false, filter: "none", showLoupe: false,
    cursor: null, onCursor: vi.fn(), onClick: vi.fn(), onPointerStart: vi.fn(), onPointerMove: vi.fn(),
    onPointerUp: vi.fn(), onPointerCancel: vi.fn(), onGestureTakeover: vi.fn(), renderOverlay: () => null };
});
afterEach(() => { for (const hooks of [viewportHooks, tracerHooks]) hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("ceph multi-touch gesture ownership (synthetic actual handlers)", () => {
  it("consumes a third contact instead of letting it begin a landmark drag", () => {
    down(1, 100); down(2, 200);
    const third = down(3, 500);
    expect(third.stopPropagation).toHaveBeenCalled();
    expect(third.preventDefault).toHaveBeenCalled();
    expect(props.onPointerStart).toHaveBeenCalledTimes(1);
    expect(props.onGestureTakeover).toHaveBeenCalledTimes(1);
    expect(props.onPointerCancel).not.toHaveBeenCalled();
  });

  it("does not zoom when an original pinch contact is replaced without movement", () => {
    down(1, 100); down(2, 200); down(3, 500); up(1, 100);
    move(2, 200);
    expect(props.zoom).toBe(1);
  });
});

describe("ceph gesture continuation and interruption", () => {
  it.each([0, 0.5])("does not change zoom for unchanged contacts %s CSS pixels apart", distance => {
    props.zoom = 2;
    down(1, 100); down(2, 100 + distance); move(2, 100 + distance);
    expect(props.zoom).toBe(2);
    down(3, 100 + distance + 0.25); up(1, 100); move(2, 100 + distance);
    expect(props.zoom).toBe(2);
  });

  it.each([1, 2])("rebases after original pair member %s lifts and continues proportional zoom", lifted => {
    down(1, 100); down(2, 200); move(2, 300); expect(props.zoom).toBe(2);
    down(3, 500); up(lifted, lifted === 1 ? 100 : 300);
    const remaining = lifted === 1 ? 2 : 1;
    move(remaining, lifted === 1 ? 300 : 100); expect(props.zoom).toBe(2);
    move(3, lifted === 1 ? 600 : 700); expect(props.zoom).toBe(3);
    up(remaining, lifted === 1 ? 300 : 100); up(3, lifted === 1 ? 600 : 700);
    clickSurface(); expect(props.onClick).not.toHaveBeenCalled();
    tap(); expect(props.onClick).toHaveBeenCalledTimes(1);
  });

  it("ignores an extra contact's motion/removal without changing the active pair", () => {
    down(1, 100); down(2, 200); down(3, 500); move(3, 550);
    expect(props.onZoomChange).not.toHaveBeenCalled();
    up(3, 550); move(2, 250); expect(props.zoom).toBe(1.5);
    up(1, 100); up(2, 250); tap(); expect(props.onClick).toHaveBeenCalledTimes(1);
  });

  it.each(["up", "cancel", "lost capture"])("consumes a remaining single touch after %s and accepts only the next intentional gesture", ended => {
    down(1, 100); down(2, 200);
    const end = ended === "up" ? up : ended === "cancel" ? cancel : lose;
    end(1, 100);
    vi.mocked(props.onPointerMove).mockClear();
    const moving = move(2, 300); expect(moving.stopPropagation).toHaveBeenCalled();
    expect(props.onPointerMove).not.toHaveBeenCalled(); expect(props.onZoomChange).not.toHaveBeenCalled();
    end(2, 300); clickSurface(); expect(props.onClick).not.toHaveBeenCalled();
    tap(); expect(props.onClick).toHaveBeenCalledTimes(1); expect(captured.size).toBe(0);
  });

  it.each([1, 2])("rebases a three-contact gesture if original contact %s is cancelled", cancelled => {
    down(1, 100); down(2, 200); down(3, 500); cancel(cancelled, cancelled === 1 ? 100 : 200);
    move(3, 500); expect(props.zoom).toBe(1);
    up(cancelled === 1 ? 2 : 1, cancelled === 1 ? 200 : 100); up(3, 500);
    tap(); expect(props.onClick).toHaveBeenCalledTimes(1);
  });

  it("rebases when a new contact joins the single remaining touch", () => {
    down(1, 100); down(2, 200); move(2, 300); expect(props.zoom).toBe(2);
    up(1, 100); move(2, 350); down(3, 550); move(3, 550); expect(props.zoom).toBe(2);
    move(3, 650); expect(props.zoom).toBe(3);
    up(2, 350); up(3, 650); tap(); expect(props.onClick).toHaveBeenCalledTimes(1);
  });

  it("preserves normal two-touch zoom bounds across repeated independent gestures", () => {
    for (let round = 0; round < 3; round++) {
      down(1, 100); down(2, 200); move(2, 1000); expect(props.zoom).toBe(4);
      move(2, 101); expect(props.zoom).toBe(1);
      up(1, 100); up(2, 101); tap();
    }
    expect(props.onClick).toHaveBeenCalledTimes(3);
  });

  it.each(["mouse", "pen"])("keeps consumed %s contacts owned even after every touch ends", pointerType => {
    down(1, 100); down(2, 200);
    const foreign = dispatch("onPointerDownCapture", 9, 300, pointerType);
    expect(foreign.stopPropagation).toHaveBeenCalled(); expect(props.onPointerStart).toHaveBeenCalledTimes(1);
    clickSurface(9); up(1, 100); up(2, 200);
    expect(dispatch("onPointerMoveCapture", 9, 320, pointerType).stopPropagation).toHaveBeenCalled();
    expect(dispatch("onPointerUpCapture", 9, 320, pointerType).stopPropagation).toHaveBeenCalled();
    clickSurface(9); expect(props.onClick).not.toHaveBeenCalled(); expect(props.onPointerUp).not.toHaveBeenCalled();
    tap(); expect(props.onClick).toHaveBeenCalledTimes(1);
  });

  it("takes capture of both pinch contacts and ignores transfer/late-release notifications", () => {
    down(1, 100); down(2, 200); expect([...captured].sort()).toEqual([1, 2]);
    dispatch("onLostPointerCapture", 1, 100); // descendant-to-surface transfer: the surface still owns capture
    move(2, 300); expect(props.zoom).toBe(2);
    up(1, 100); up(2, 300);
    dispatch("onLostPointerCapture", 1, 100); dispatch("onLostPointerCapture", 2, 300);
    tap(); expect(props.onClick).toHaveBeenCalledTimes(1);
  });

  it("rebases from the most recently requested zoom before React commits another render", () => {
    const surface = render();
    const send = (handler: string, id: number, x: number) => (surface.props[handler] as (e: unknown) => void)(event(id, x));
    send("onPointerDownCapture", 1, 100); send("onPointerDownCapture", 2, 200);
    send("onPointerMoveCapture", 2, 300); expect(props.zoom).toBe(2);
    send("onPointerDownCapture", 3, 500); send("onPointerUpCapture", 1, 100);
    send("onPointerMoveCapture", 2, 300); expect(props.zoom).toBe(2);
    send("onPointerMoveCapture", 3, 600); expect(props.zoom).toBe(3);
  });

  it.each([false, true])("preserves single-contact placement/pan behavior (pan=%s)", panMode => {
    props.panMode = panMode; render();
    const originalScroll = viewportHost.scrollLeft;
    down(1, 100); move(1, 80); up(1, 80); clickSurface(1, 80);
    expect(props.onClick).toHaveBeenCalledTimes(panMode ? 0 : 1);
    expect(viewportHost.scrollLeft - originalScroll).toBe(panMode ? 20 : 0);
    props.panMode = false; tap(); expect(props.onClick).toHaveBeenCalledTimes(panMode ? 1 : 2);
  });
});

const fetchMock = vi.fn();
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
const button = (name: string) => { render(); return nodes(tracerTree).find(n => n.type === "button" && text(n).trim() === name); };
const clickButton = (name: string) => { const found = button(name); if (!found) throw new Error("Missing button: " + name); (found.props.onClick as () => void)(); render(); };
const edits = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH").map(([, init]) => JSON.parse(init.body));
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); render(); }
const circles = () => { render(); return nodes(props.renderOverlay(props.zoom / 2, true)).filter(n => n.type === "circle" && typeof n.props.onPointerDown === "function"); };
const downOnLandmark = (id: number, x: number) => {
  const circle = circles()[0];
  const e = down(id, x);
  if (!e.stopPropagation.mock.calls.length) (circle.props.onPointerDown as (e: unknown) => void)(e);
  render(); return e;
};
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
    initialLandmarks: [{ code: "S", x: 200, y: 200, source: "suggested" }],
    stamped: null, refValues: null, refSetName: null, diagnosis: null, ...overrides,
  };
  render(); props.onNaturalSize({ w: 1200, h: 800 }); render();
}

describe("real tracer and viewport handlers with synthetic scheduling/layout/transport", () => {
  it("stops an active-gesture click before a landmark child can clear tracer suppression", async () => {
    openTracer(); down(1, 100); down(2, 200); down(3, 500);
    const childClick = vi.fn(circles()[0].props.onClick as (e: unknown) => void);
    const e = { ...event(3, 100), detail: 1 };
    const surface = render();
    (surface.props.onClickCapture as (e: unknown) => void)(e);
    if (!e.stopPropagation.mock.calls.length) childClick(e);
    expect(childClick).not.toHaveBeenCalled();
    up(1, 100); up(2, 200); up(3, 500); clickSurface(); await flush();
    expect(edits()).toEqual([]); expect(button("S ✦")).toBeDefined();
    tap(); await flush(); expect(edits()).toHaveLength(1);
  });

  it("cancels the original drag and does not let a third touch begin/persist another landmark drag", async () => {
    openTracer(); downOnLandmark(1, 100); move(1, 125);
    expect(circles()[0].props.cx).toBe(250);
    down(2, 200); expect(circles()[0].props.cx).toBe(200);
    const third = downOnLandmark(3, 100); expect(third.stopPropagation).toHaveBeenCalled();
    move(3, 180); up(1, 125); move(2, 200); up(2, 200); up(3, 180); clickSurface(1, 125);
    await flush(); expect(edits()).toEqual([]); expect(circles()[0].props.cx).toBe(200);
    expect(button("S ✦")).toBeDefined(); expect(button("تراجع")?.props.disabled).toBe(true);
    tap(10, 300); await flush();
    expect(edits()).toEqual([{ landmarks: [{ code: "N", x: 600, y: 200, source: "manual" }], expectedLandmarks: [] }]);
  });

  it.each(["up", "cancel", "lost capture"])("keeps the chosen ruler endpoint through a three-contact gesture ending by %s", async ended => {
    openTracer(); clickButton("تصحيح المعايرة"); tap(10, 50);
    expect(button("حفظ المعايرة")).toBeUndefined();
    down(1, 100); down(2, 200); down(3, 500); clickSurface(9, 250);
    const end = ended === "up" ? up : ended === "cancel" ? cancel : lose;
    end(1, 100); move(2, 200); end(2, 200); end(3, 500); clickSurface(1, 100);
    await flush(); expect(button("حفظ المعايرة")).toBeUndefined(); expect(edits()).toEqual([]);
    tap(11, 100); expect(button("حفظ المعايرة")).toBeDefined();
    clickButton("حفظ المعايرة"); await flush();
    expect(edits()).toEqual([{ calibration: { x1: 100, y1: 200, x2: 200, y2: 200, mm: 10 },
      expectedCalibration: { calibration: tracerProps!.analysis.calibration, mmPerPixel: 0.1 } }]);
    expect(button("S ✦")).toBeDefined();
  });
});

// Model capture -> actual SVG landmark target -> surface bubble. A landmark's
// tiny bounds deliberately differ from the image surface: forwarding the click
// directly to the tracer with the target's currentTarget must fail these tests.
const landmarkHost = { ...surfaceHost,
  getBoundingClientRect: () => ({ left: 90, top: 90, width: 20, height: 20 }) };
function routeLandmark(handler: string, id: number, x: number, pointerType = "touch", index = 0, y = 100) {
  const surface = render();
  const target = nodes(surface).filter(n => n.type === "circle" && typeof n.props.onPointerDown === "function")[index];
  if (!target) throw new Error("No interactive landmark in the rendered surface");
  const e = { ...event(id, x, pointerType), clientY: y, detail: 1, target: landmarkHost };
  const invoke = (node: Element, name: string, host: typeof surfaceHost) => {
    const listener = node.props[name];
    if (typeof listener === "function") { e.currentTarget = host; listener(e); }
  };
  invoke(surface, handler + "Capture", surfaceHost);
  if (!e.stopPropagation.mock.calls.length) invoke(target, handler, landmarkHost);
  if (!e.stopPropagation.mock.calls.length) invoke(surface, handler, surfaceHost);
  render(); return e;
}
function tapLandmark(id: number, x: number, pointerType = "touch", index = 0, y = 100) {
  routeLandmark("onPointerDown", id, x, pointerType, index, y);
  routeLandmark("onPointerUp", id, x, pointerType, index, y);
  // Browser compatibility clicks can lose PointerEvent subpixel precision.
  return routeLandmark("onClick", id, Math.round(x), pointerType, index, Math.round(y));
}
function clickStep(label: string) {
  render();
  const step = nodes(tracerTree).find(n => n.type === "button" && text(n).includes(label));
  if (!step) throw new Error("Missing step: " + label);
  (step.props.onClick as () => void)(); render();
}
function ruler() {
  render();
  return nodes(props.renderOverlay(props.zoom / 2, true)).find(n => n.type === "line" && n.props.stroke === "#b45309");
}
function firstRulerPoint() {
  render();
  return nodes(props.renderOverlay(props.zoom / 2, true)).find(n => n.type === "circle" && n.props.fill === "#b45309");
}
const expectCoordinates = (node: Element | undefined, coordinates: Record<string, number>) => {
  expect(node).toBeDefined();
  // Native conversion divides by CSS bounds; compare subpixel values without
  // treating ordinary IEEE-754 roundoff as a clinical coordinate change.
  for (const [key, value] of Object.entries(coordinates)) expect(node!.props[key]).toBeCloseTo(value, 9);
};
const untouchedSuggestion = () => {
  expect(circles()[0].props.cx).toBe(200);
  expect(circles()[0].props.cy).toBe(200);
  expect(button("S ✦")).toBeDefined();
  expect(button("تراجع")?.props.disabled).toBe(true);
  expect(button("إعادة")?.props.disabled).toBe(true);
};

describe("calibration owns drawing entry and landmark target clicks (synthetic event path)", () => {
  it("leaves pan mode when calibration starts and accepts fresh endpoints", async () => {
    openTracer(); clickButton("تحريك الصورة"); expect(props.panMode).toBe(true);
    clickButton("تصحيح المعايرة"); expect(props.panMode).toBe(false);
    tap(10, 50); tap(11, 100);
    expect(button("حفظ المعايرة")).toBeDefined(); untouchedSuggestion();
    await flush(); expect(edits()).toEqual([]);
  });

  it.each(["Ceph Analysis & Diagnosis", "Superimposition & Report"])("opens digitization when started from %s", async previousStep => {
    openTracer(); clickStep(previousStep);
    if (previousStep.includes("Report")) expect(nodes(tracerTree).some(n => n.type === CephViewport)).toBe(false);
    clickButton("تصحيح المعايرة");
    expect(nodes(tracerTree).some(n => n.type === CephViewport)).toBe(true);
    const digitization = nodes(tracerTree).find(n => n.type === "button" && text(n).includes("Digitization & Tracing"))!;
    expect(digitization.props.className).toContain("border-purple-600");
    expect(props.panMode).toBe(false);
    tap(10, 50); tap(11, 100); expect(button("حفظ المعايرة")).toBeDefined();
    await flush(); expect(edits()).toEqual([]); untouchedSuggestion();
  });

  it.each(["mouse", "touch"].flatMap(pointerType => [1, 2, 4].map(zoom => ({ pointerType, zoom }))))(
    "uses native coordinates for first, second and replacement landmark endpoints ($pointerType, zoom=$zoom)", async ({ pointerType, zoom }) => {
      openTracer({ initialLandmarks: [
        { code: "S", x: 200, y: 200, source: "suggested" },
        { code: "N", x: 400, y: 200, source: "suggested" },
        { code: "A", x: 600, y: 200, source: "suggested" },
      ] });
      clickButton(`${zoom}×`); clickButton("تصحيح المعايرة");
      const first = tapLandmark(10, 100.125 * zoom, pointerType, 0, 100.3125 * zoom);
      expect(first.stopPropagation).not.toHaveBeenCalled();
      expectCoordinates(firstRulerPoint(), { cx: 200.25, cy: 200.625 });
      expect(button("حفظ المعايرة")).toBeUndefined();
      tapLandmark(11, 200.125 * zoom, pointerType, 1, 100.3125 * zoom);
      expectCoordinates(ruler(), { x1: 200.25, y1: 200.625, x2: 400.25, y2: 200.625 });
      tapLandmark(12, 300.25 * zoom, pointerType, 2, 100.3125 * zoom);
      expectCoordinates(ruler(), { x1: 200.25, y1: 200.625, x2: 600.5, y2: 200.625 });
      await flush(); expect(edits()).toEqual([]); untouchedSuggestion();
      expect(button("N ✦")).toBeDefined(); expect(button("A ✦")).toBeDefined();
      expect(button("راجعت موضع S على الأشعة")).toBeUndefined();
      clickButton("حفظ المعايرة"); await flush();
      expect(edits()).toEqual([{ calibration: { x1: 200.3, y1: 200.6, x2: 600.5, y2: 200.6, mm: 10 },
        expectedCalibration: { calibration: tracerProps!.analysis.calibration, mmPerPixel: 0.1 } }]);
      untouchedSuggestion(); expect(button("N ✦")).toBeDefined(); expect(button("A ✦")).toBeDefined();
    });

  it.each(["mouse", "touch"])("cancels an in-progress %s drag on entry without writing/reviewing it or using its release as an endpoint", async pointerType => {
    openTracer(); routeLandmark("onPointerDown", 1, 100, pointerType);
    routeLandmark("onPointerMove", 1, 140, pointerType); expect(circles()[0].props.cx).toBe(280);
    clickButton("تصحيح المعايرة"); untouchedSuggestion();
    routeLandmark("onPointerUp", 1, 140, pointerType); routeLandmark("onClick", 1, 140, pointerType);
    expect(firstRulerPoint()).toBeUndefined(); expect(button("حفظ المعايرة")).toBeUndefined();
    await flush(); expect(edits()).toEqual([]); untouchedSuggestion();
    tapLandmark(10, 100, pointerType); expect(firstRulerPoint()?.props.cx).toBe(200);
  });

  it("finishes an already-owned pan without leaking its release into the new calibration", async () => {
    openTracer(); clickButton("تحريك الصورة"); down(1, 100); move(1, 80);
    clickButton("تصحيح المعايرة"); expect(props.panMode).toBe(false);
    move(1, 60); up(1, 60); clickSurface(1, 60);
    expect(firstRulerPoint()).toBeUndefined();
    tapLandmark(10, 100); expect(firstRulerPoint()?.props.cx).toBe(200);
    await flush(); expect(edits()).toEqual([]); untouchedSuggestion();
  });

  it("retains active pinch ownership across calibration entry until the contacts end", async () => {
    openTracer(); down(1, 100); down(2, 200); clickButton("تصحيح المعايرة");
    const swallowed = routeLandmark("onClick", 2, 100);
    expect(swallowed.stopPropagation).toHaveBeenCalled(); expect(firstRulerPoint()).toBeUndefined();
    up(1, 100); move(2, 220); up(2, 220); routeLandmark("onClick", 2, 100);
    expect(firstRulerPoint()).toBeUndefined();
    tapLandmark(10, 100); expect(firstRulerPoint()?.props.cx).toBe(200);
    await flush(); expect(edits()).toEqual([]); untouchedSuggestion();
  });

  it.each(["mouse", "touch"])("cancel/restart clears endpoints and ignores the cancelled %s contact's trailing click", async pointerType => {
    openTracer(); clickButton("تصحيح المعايرة"); tap(10, 50); tap(11, 100);
    expect(button("حفظ المعايرة")).toBeDefined();
    routeLandmark("onPointerDown", 12, 100, pointerType); clickButton("إلغاء المعايرة");
    dispatch("onPointerUpCapture", 12, 150, pointerType); clickSurface(12, 150);
    await flush(); expect(edits()).toEqual([]); untouchedSuggestion();
    clickButton("تصحيح المعايرة"); expect(firstRulerPoint()).toBeUndefined(); expect(ruler()).toBeUndefined();
    tapLandmark(13, 100, pointerType); expect(firstRulerPoint()?.props.cx).toBe(200);
    expect(button("حفظ المعايرة")).toBeUndefined();
    clickButton("إلغاء المعايرة"); tap(14, 300); await flush();
    expect(edits()).toEqual([{ landmarks: [{ code: "N", x: 600, y: 200, source: "manual" }], expectedLandmarks: [] }]);
  });

  it("keeps pending calibration save disabled and does not replace endpoints during its request", async () => {
    openTracer(); clickButton("تصحيح المعايرة"); tap(10, 50); tap(11, 100);
    let finish!: (response: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    clickButton("حفظ المعايرة"); await flush();
    expect(button("إلغاء المعايرة")?.props.disabled).toBe(true);
    expect(button("حفظ المعايرة")?.props.disabled).toBe(true);
    tapLandmark(12, 110);
    expect(ruler()?.props).toMatchObject({ x1: 100, y1: 200, x2: 200, y2: 200 });
    expect(edits()).toHaveLength(1); untouchedSuggestion();
    finish({ ok: true, status: 200, json: async () => ({ ok: true, mmPerPixel: 0.1, calibration: edits()[0].calibration }) }); await flush();
    expect(button("إلغاء المعايرة")).toBeUndefined(); expect(edits()).toHaveLength(1); untouchedSuggestion();
  });

  it.each(["mouse", "touch"])("preserves ordinary %s landmark selection and real drag save", async pointerType => {
    openTracer(); const selected = tapLandmark(1, 100, pointerType);
    expect(selected.stopPropagation).toHaveBeenCalled(); await flush(); expect(edits()).toEqual([]); untouchedSuggestion();
    routeLandmark("onPointerDown", 2, 100, pointerType); routeLandmark("onPointerMove", 2, 125, pointerType);
    routeLandmark("onPointerUp", 2, 125, pointerType); routeLandmark("onClick", 2, 125, pointerType); await flush();
    expect(edits()).toEqual([{ landmarks: [{ code: "S", x: 250, y: 200, source: "manual" }],
      expectedLandmarks: [{ code: "S", x: 200, y: 200, source: "suggested" }] }]);
    expect(button("S ✓")).toBeDefined(); expect(button("تراجع")?.props.disabled).toBe(false);
  });

  it.each(["read-only", "completed"])("keeps %s views non-writing and without calibration entry", async state => {
    openTracer();
    if (state === "read-only") tracerProps!.readOnly = true;
    else tracerProps!.analysis = { ...tracerProps!.analysis, status: "completed" };
    render(); expect(button("تصحيح المعايرة")).toBeUndefined(); expect(button("معايرة الشععة")).toBeUndefined();
    tapLandmark(10, 100, "mouse"); routeLandmark("onPointerDown", 11, 100);
    routeLandmark("onPointerMove", 11, 150); routeLandmark("onPointerUp", 11, 150); routeLandmark("onClick", 11, 150);
    tap(12, 300); await flush(); expect(edits()).toEqual([]);
    expect(circles()[0].props.cx).toBe(200); expect(button("حفظ المعايرة")).toBeUndefined();
  });
});
