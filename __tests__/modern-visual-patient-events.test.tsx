import type { DependencyList, EffectCallback, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CephTracer } from "../components/CephTracer";
import { ConsentModal } from "../components/ConsentModal";

// Invoke actual component event handlers with synthetic hooks and canvas only.
// Effects retain dependencies and run their cleanup before replacement/unmount.
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, pending: [] as (() => void)[], cleanups: new Map<number, () => void>() }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const memo = (fn: () => unknown, deps: DependencyList) => {
    const index = hooks.cursor++; const previous = hooks.slots[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.slots[index] = { value: fn(), deps };
    return hooks.slots[index].value;
  };
  return { ...react, useMemo: memo, useCallback: (fn: unknown, deps: DependencyList) => memo(() => fn, deps),
    useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value; }]; },
    useRef: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }; return hooks.slots[index]; },
    useEffect: (fn: EffectCallback, deps: DependencyList) => { const index = hooks.cursor++; const previous = hooks.slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) { hooks.slots[index] = deps; hooks.pending.push(() => { hooks.cleanups.get(index)?.(); const cleanup = fn(); if (cleanup) hooks.cleanups.set(index, cleanup); else hooks.cleanups.delete(index); }); }
    },
  };
});
type Element = ReactElement<Record<string, any>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children)] : [];
function render<T>(component: () => T): T { hooks.cursor = 0; const tree = component(); hooks.pending.splice(0).forEach(effect => effect()); return tree; }
const cleanup = () => { hooks.cleanups.forEach(fn => fn()); hooks.cleanups.clear(); };
beforeEach(() => { hooks.slots = []; hooks.cursor = 0; hooks.pending = []; hooks.cleanups.clear(); vi.useFakeTimers(); vi.stubGlobal("window", Object.assign(new EventTarget(), { open: vi.fn() })); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const analysis: Parameters<typeof CephTracer>[0]["analysis"] = {
  id: 71, patientId: 11, documentId: 21, status: "draft", orthoCaseId: null, phase: "pretreatment", xrayDate: null,
  device: null, refSet: "synthetic", calibration: null, mmPerPixel: null, note: null, createdBy: "synthetic", createdAt: "2026-10-31", completedBy: null, completedAt: null, findings: null,
};

describe("modern visual patient event ownership", () => {
  it("renders drag state without moving a landmark, resets on release, and saves the original coordinates", async () => {
    const fetch = vi.fn(async (_url: string, _request: RequestInit) => ({ ok: true, json: async () => ({}) })); vi.stubGlobal("fetch", fetch);
    const component = () => CephTracer({ patientName: "Synthetic", patientBirthYear: null, analysis, initialLandmarks: [{ code: "S", x: 10, y: 20, source: "manual" }], stamped: null, refValues: null, refSetName: null, diagnosis: null });
    let tree = render(component);
    nodes(tree).find(node => node.type === "img")!.props.onLoad({ currentTarget: { naturalWidth: 400, naturalHeight: 400 } });
    tree = render(component);
    const circle = () => nodes(tree).find(node => node.type === "circle" && node.props.onPointerDown)!;
    expect(circle().props.fill).toBe("#1e3a5f");
    const capture = vi.fn(); circle().props.onPointerDown({ pointerId: 3, currentTarget: { setPointerCapture: capture }, clientX: 10, clientY: 20 });
    tree = render(component); expect(circle().props.fill).toBe("#dc2626"); expect(capture).toHaveBeenCalledWith(3); expect(fetch).not.toHaveBeenCalled();
    nodes(tree).find(node => node.props.onPointerUp)!.props.onPointerUp();
    tree = render(component); expect(circle().props.fill).toBe("#1e3a5f");
    expect(fetch).toHaveBeenCalledTimes(1); expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toMatchObject({ landmarks: [{ code: "S", x: 10, y: 20 }] });
  });
  it("does not allow pointer dragging or saving approved landmarks", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const component = () => CephTracer({ patientName: "Synthetic", patientBirthYear: null, analysis: { ...analysis, status: "completed" }, initialLandmarks: [{ code: "S", x: 10, y: 20, source: "manual" }], stamped: [], refValues: null, refSetName: null, diagnosis: null });
    let tree = render(component); nodes(tree).find(node => node.type === "img")!.props.onLoad({ currentTarget: { naturalWidth: 400, naturalHeight: 400 } }); tree = render(component);
    const circle = nodes(tree).find(node => node.type === "circle" && node.props.onPointerDown)!;
    const capture = vi.fn(); circle.props.onPointerDown({ currentTarget: { setPointerCapture: capture } });
    expect(capture).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("cancels a pending consent-canvas reset when closed and resets only the new opening", async () => {
    const props = { isOpen: true, onClose: vi.fn(), patientId: 11, patientName: "Synthetic" };
    const component = () => ConsentModal(props);
    const clearRect = vi.fn(); const canvas = { getContext: () => ({ clearRect }), width: 300, height: 150 };
    let tree = render(component); nodes(tree).find(node => node.type === "canvas")!.props.ref.current = canvas;
    expect(vi.getTimerCount()).toBe(1); props.isOpen = false; expect(render(component)).toBeNull();
    await vi.advanceTimersByTimeAsync(100); expect(clearRect).not.toHaveBeenCalled();
    props.isOpen = true; tree = render(component); nodes(tree).find(node => node.type === "canvas")!.props.ref.current = canvas;
    await vi.advanceTimersByTimeAsync(100); expect(clearRect).toHaveBeenCalledExactlyOnceWith(0, 0, 300, 150);
    cleanup(); expect(vi.getTimerCount()).toBe(0);
  });
  it("only uploads signed consent on submit, with the event timestamp and unchanged patient identity", async () => {
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    const fetch = vi.fn().mockResolvedValueOnce({ blob: async () => new Blob(["synthetic signature"], { type: "image/png" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 81 }) });
    vi.stubGlobal("fetch", fetch);
    const props = { isOpen: true, onClose: vi.fn(), onSigned: vi.fn(), patientId: 11, patientName: "Synthetic" };
    const component = () => ConsentModal(props);
    let tree = render(component);
    const ctx = { clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };
    const canvas = { getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0 }), toDataURL: () => "data:image/png;base64,c3ludGhldGlj", width: 300, height: 150 };
    nodes(tree).find(node => node.type === "canvas")!.props.ref.current = canvas;
    await vi.advanceTimersByTimeAsync(100); tree = render(component);
    const submit = () => nodes(tree).find(node => node.type === "form")!.props.onSubmit({ preventDefault: vi.fn() });
    await submit(); expect(fetch).not.toHaveBeenCalled(); // Agreement is mandatory.
    nodes(tree).find(node => node.type === "input" && node.props.type === "checkbox")!.props.onChange({ target: { checked: true } });
    tree = render(component); await submit(); expect(fetch).not.toHaveBeenCalled(); // Signature is independently mandatory.
    const signature = nodes(tree).find(node => node.type === "canvas")!;
    signature.props.onMouseDown({ nativeEvent: { clientX: 1, clientY: 2 } });
    signature.props.onMouseMove({ nativeEvent: { clientX: 3, clientY: 4 } }); signature.props.onMouseUp();
    tree = render(component); expect(fetch).not.toHaveBeenCalled(); await submit();
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[1][0]).toBe("/api/patients/11/documents");
    const body = fetch.mock.calls[1][1].body as FormData;
    expect((body.get("file") as File).name).toBe(`consent_surgical_extraction_${Date.now()}.png`);
    expect(body.get("kind")).toBe("consent"); expect(JSON.parse(body.get("note") as string).signatoryName).toBe("Synthetic");
    expect(props.onSigned).toHaveBeenCalledExactlyOnceWith({ id: 81 }); expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith("/print/consent/11?docId=81", "_blank");
  });
});
