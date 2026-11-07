"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Pt } from "@/lib/ceph";

export interface CephImageSize { w: number; h: number }

/** A single native-image scene is used by both the drawing surface and loupe. */
export function CephViewport({
  src, natural, onNaturalSize, zoom, onZoomChange, panMode, filter, showLoupe,
  cursor, onCursor, onClick, onPointerStart, onPointerMove, onPointerUp, onPointerCancel, onGestureTakeover, renderOverlay,
}: {
  src: string;
  natural: CephImageSize | null;
  onNaturalSize: (size: CephImageSize | null) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  panMode: boolean;
  filter: string;
  showLoupe: boolean;
  cursor: Pt | null;
  onCursor: (point: Pt | null) => void;
  onClick: (event: React.MouseEvent) => void;
  onPointerStart: () => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
  onGestureTakeover: () => void;
  renderOverlay: (displayScale: number, interactive: boolean) => ReactNode;
}) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loupePosition, setLoupePosition] = useState({ left: 0, top: 0, size: 180 });
  const pan = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const previousScale = useRef<{ scale: number; w: number; h: number } | null>(null);
  const touches = useRef(new Map<number, Pt>());
  const gesturePointers = useRef(new Set<number>());
  // A multi-touch gesture owns every contact until all have ended. Keep its
  // active pair explicit so adding/replacing a finger cannot jump the scale.
  const pinch = useRef<{ ids: [number, number] | null; distance: number; zoom: number; currentZoom: number } | null>(null);
  const suppressClick = useRef(false);

  const attempt = useMemo(() => ({ src, retry }), [src, retry]);
  const attempts = useRef(new WeakMap<object, { active: boolean; consumed: boolean; failed: boolean; node: HTMLImageElement | null }>());
  const committedAttempt = useRef<typeof attempt | null>(null);
  const loaded = useCallback((image: HTMLImageElement | null) => {
    const state = attempts.current.get(attempt);
    if (!state?.active || state.consumed || committedAttempt.current !== attempt || image !== state.node) return;
    if (image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      state.failed = false;
      onNaturalSize({ w: image.naturalWidth, h: image.naturalHeight }); setFailed(false);
    }
  }, [attempt, onNaturalSize]);
  const imageRef = useCallback((image: HTMLImageElement | null) => {
    let state = attempts.current.get(attempt);
    if (!state) { state = { active: false, consumed: false, failed: false, node: null }; attempts.current.set(attempt, state); }
    if (state.consumed) return;
    state.node = image; loaded(image);
  }, [attempt, loaded]);
  useLayoutEffect(() => {
    let state = attempts.current.get(attempt);
    if (!state) { state = { active: false, consumed: false, failed: false, node: null }; attempts.current.set(attempt, state); }
    committedAttempt.current = attempt; state.active = true;
    // Ref attachment precedes layout effects, including cached/SSR images.
    loaded(state.node);
    return () => { state.active = false; if (committedAttempt.current === attempt) committedAttempt.current = null; };
  }, [attempt, loaded]);
  const imageError = (image: HTMLImageElement) => {
    const state = attempts.current.get(attempt);
    if (!state?.active || state.consumed || committedAttempt.current !== attempt || state.node !== image) return;
    state.failed = true; setFailed(true); onNaturalSize(null); onCursor(null);
  };
  const retryImage = () => {
    const state = attempts.current.get(attempt);
    if (!state?.active || state.consumed || committedAttempt.current !== attempt || !state.failed) return;
    state.consumed = true; state.active = false; state.node = null;
    setFailed(false); setRetry(value => value + 1);
  };

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setViewportSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = natural && viewportSize.w && viewportSize.h
    ? Math.min(viewportSize.w / natural.w, viewportSize.h / natural.h, 1) : 1;
  const displayScale = fit * zoom;
  const width = natural ? natural.w * displayScale : "100%";
  const height = natural ? natural.h * displayScale : "100%";

  // Preserve the image point at the viewport centre on resize/toolbar zoom, or
  // at the pinch midpoint during a gesture. Scroll offsets are always LTR.
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el || !natural) return;
    const old = previousScale.current;
    if (old && (old.scale !== displayScale || old.w !== el.clientWidth || old.h !== el.clientHeight)) {
      const target = anchor.current;
      const inset = Math.max(0, (old.w - natural.w * old.scale) / 2);
      const x = target?.x ?? (el.scrollLeft + old.w / 2 - inset) / old.scale;
      const y = target?.y ?? Math.min(natural.h, (el.scrollTop + old.h / 2) / old.scale);
      const beforeLeft = el.scrollLeft, beforeTop = el.scrollTop;
      el.scrollLeft = x * displayScale - (target?.clientX ?? el.clientWidth / 2);
      el.scrollTop = y * displayScale - (target?.clientY ?? el.clientHeight / 2);
      if (pan.current) {
        pan.current.left += el.scrollLeft - beforeLeft;
        pan.current.top += el.scrollTop - beforeTop;
      }
    }
    previousScale.current = { scale: displayScale, w: el.clientWidth, h: el.clientHeight };
    anchor.current = null;
    onCursor(null);
  }, [displayScale, natural, onCursor, viewportSize.w, viewportSize.h]);

  useEffect(() => {
    if (!showLoupe || !cursor) return;
    const position = () => {
      const rect = viewport.current?.getBoundingClientRect();
      if (!rect) return;
      const visual = window.visualViewport;
      const screenW = visual?.width ?? window.innerWidth;
      const screenH = visual?.height ?? window.innerHeight;
      const x = visual?.offsetLeft ?? 0, y = visual?.offsetTop ?? 0;
      const size = Math.min(180, screenW - 24, screenH - 24);
      // Portalled outside transformed/filtered app ancestors, within the screen.
      setLoupePosition({ size, left: Math.max(x + 12, Math.min(rect.left + 12, x + screenW - size - 12)),
        top: Math.max(y + 12, Math.min(rect.top + 12, y + screenH - size - 12)) });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [showLoupe, cursor, viewportSize]);

  const pinchBaseline = () => {
    const [a, b] = [...touches.current.entries()];
    const currentZoom = pinch.current?.currentZoom ?? zoom;
    return a && b
      ? { ids: [a[0], b[0]] as [number, number], distance: Math.max(1, Math.hypot(a[1].x - b[1].x, a[1].y - b[1].y)), zoom: currentZoom, currentZoom }
      : { ids: null, distance: 1, zoom: currentZoom, currentZoom };
  };
  const captureDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinch.current || touches.current.size >= 2) {
      if (!pinch.current) onGestureTakeover();
      if (!pinch.current?.ids) pinch.current = pinchBaseline();
      suppressClick.current = true;
      pan.current = null;
      for (const id of touches.current.keys()) gesturePointers.current.add(id);
      gesturePointers.current.add(e.pointerId);
      e.stopPropagation();
      e.preventDefault();
      // The first contact may still be captured by a landmark. Own every touch
      // here so an unexpected capture loss can retire it from this gesture.
      for (const id of gesturePointers.current) e.currentTarget.setPointerCapture(id);
      onCursor(null);
      return;
    }
    onPointerStart();
    if (panMode || e.button === 1) {
      const el = viewport.current!;
      pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
      suppressClick.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
      onCursor(null);
    } else {
      suppressClick.current = false;
    }
  };
  const captureMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current) {
      const ids = pinch.current.ids;
      const a = ids ? touches.current.get(ids[0]) : null, b = ids ? touches.current.get(ids[1]) : null;
      const rect = surface.current?.getBoundingClientRect(), vr = viewport.current?.getBoundingClientRect();
      if (a && b && ids?.includes(e.pointerId) && rect && vr && natural) {
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const nextZoom = Math.max(1, Math.min(4, pinch.current.zoom * distance / pinch.current.distance));
        // An unchanged/clamped zoom schedules no scale layout. Do not leave a
        // gesture anchor waiting to hijack a later unrelated container resize.
        anchor.current = nextZoom === zoom ? null : { x: (cx - rect.left) / displayScale, y: (cy - rect.top) / displayScale,
          clientX: cx - vr.left, clientY: cy - vr.top };
        pinch.current.currentZoom = nextZoom;
        onZoomChange(nextZoom);
      }
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (pan.current?.id === e.pointerId) {
      viewport.current!.scrollLeft = pan.current.left - (e.clientX - pan.current.x);
      viewport.current!.scrollTop = pan.current.top - (e.clientY - pan.current.y);
      e.preventDefault(); e.stopPropagation();
    }
  };
  const captureEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    touches.current.delete(e.pointerId);
    gesturePointers.current.delete(e.pointerId);
    const handled = !!pinch.current || pan.current?.id === e.pointerId;
    if (gesturePointers.current.size === 0) pinch.current = null;
    else if (pinch.current?.ids?.includes(e.pointerId)) pinch.current = pinchBaseline();
    if (pan.current?.id === e.pointerId) pan.current = null;
    if (handled) { e.preventDefault(); e.stopPropagation(); onCursor(null); }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const loupeScale = Math.max(1, displayScale) * 2.5;
  const span = loupePosition.size / loupeScale;
  return <>
    <div ref={viewport} data-testid="ceph-viewport" dir="ltr"
      className="relative overflow-auto rounded-lg bg-slate-950"
      style={{ height: "clamp(320px, 68vh, 900px)", overscrollBehavior: "contain" }}
      onScroll={() => onCursor(null)}>
      <div ref={surface} data-testid="ceph-surface"
        className={`relative ${panMode ? "cursor-grab" : "cursor-crosshair"}`}
        style={{ width, height, marginInline: "auto", touchAction: "none" }}
        onPointerDownCapture={(e) => {
          captureDown(e);
          if (e.pointerType === "touch" && !panMode && !pinch.current && !failed) onPointerMove(e);
        }} onPointerMoveCapture={captureMove}
        onPointerUpCapture={captureEnd} onPointerCancelCapture={(e) => { captureEnd(e); onPointerCancel(e); }}
        onLostPointerCapture={(e) => {
          // Ignore a descendant's capture transfer to this surface, and normal
          // releases of contacts already retired by up/cancel.
          if (e.currentTarget.hasPointerCapture(e.pointerId)) return;
          if (touches.current.has(e.pointerId) || gesturePointers.current.has(e.pointerId) || pan.current?.id === e.pointerId) {
            captureEnd(e); onPointerCancel(e);
          }
        }}
        onClickCapture={(e) => {
          if (pinch.current || suppressClick.current) {
            e.preventDefault(); e.stopPropagation();
            if (!pinch.current) suppressClick.current = false;
          }
        }}
        onClick={(e) => {
          if (pinch.current) return;
          if (!panMode && !suppressClick.current && !failed && natural) onClick(e);
          suppressClick.current = false;
        }}
        onPointerMove={(e) => { if (!panMode && !failed) onPointerMove(e); }}
        onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
        onPointerLeave={() => { if (!pan.current) onCursor(null); }}>
        <img key={`${src}:${retry}`} ref={imageRef} data-testid="ceph-image" src={src}
          alt="الشععة السيفالومترية" draggable={false}
          className="absolute inset-0 h-full w-full select-none"
          style={{ filter, maxWidth: "none" }}
          onLoad={(e) => loaded(e.currentTarget)} onError={(e) => imageError(e.currentTarget)} />
        {!failed && natural && <svg data-testid="ceph-overlay" className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${natural.w} ${natural.h}`} preserveAspectRatio="none">
          {renderOverlay(displayScale, true)}
        </svg>}
      </div>
      {failed && <div role="alert" dir="rtl" className="absolute inset-x-0 top-8 rounded bg-white p-4 text-center text-rose-800">
        تعذّر تحميل صورة الأشعة. لا يمكن الرسم حتى تُحمّل الصورة.
        <button type="button" className="m-2 rounded border px-3 py-1" onClick={retryImage}>إعادة تحميل الصورة</button>
      </div>}
    </div>
    {showLoupe && cursor && natural && !failed && typeof document !== "undefined" && createPortal(
      <div data-testid="ceph-loupe" aria-hidden="true" dir="ltr" className="pointer-events-none fixed z-50 overflow-hidden rounded-full border-2 border-white bg-slate-950 shadow-2xl ring-2 ring-purple-500"
        style={{ left: loupePosition.left, top: loupePosition.top, width: loupePosition.size, height: loupePosition.size }}>
        <svg data-testid="ceph-loupe-scene" width="100%" height="100%"
          viewBox={`${cursor.x - span / 2} ${cursor.y - span / 2} ${span} ${span}`}>
          <image href={src} x="0" y="0" width={natural.w} height={natural.h} style={{ filter }} />
          {renderOverlay(loupeScale, false)}
        </svg>
        <div className="absolute inset-x-0 top-1/2 h-px bg-rose-500/80" />
        <div className="absolute inset-y-0 left-1/2 w-px bg-rose-500/80" />
        <div className="absolute bottom-3 inset-x-0 mx-auto w-max rounded bg-slate-900/90 px-2 py-0.5 font-mono text-[10px] text-white">
          X: {Math.round(cursor.x)} · Y: {Math.round(cursor.y)}
        </div>
      </div>, document.body)}
  </>;
}
