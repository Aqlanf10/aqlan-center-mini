"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const PAPER_CANVASES = ".sheet-a4, .sheet-report, .hr-staff-sheet, .hr-tasks-sheet";
const CANVASES = `${PAPER_CANVASES}, .print-document, .print-document-on-print`;
const COMPACT = ".sheet-a5, .sheet-a6";
const MM = 96 / 25.4;

function associatedPrintAction(canvas: HTMLElement): HTMLButtonElement | null {
  const own = canvas.querySelectorAll<HTMLButtonElement>("button[data-print-document-action]");
  if (own.length === 1) return own[0];
  const root = canvas.closest(".print-root");
  if (!root) return null;
  // A sibling toolbar is safe only for a single, explicit paper document.
  const papers = root.querySelectorAll(PAPER_CANVASES);
  if (papers.length !== 1 || papers[0] !== canvas) return null;
  const actions = root.querySelectorAll<HTMLButtonElement>("button[data-print-document-action]");
  return actions.length === 1 ? actions[0] : null;
}

/** Screen decoration only. Browser pagination remains the authority for long
 * documents; never position a logo at the midpoint of a long scrolling table. */
function CanvasPreview({ canvas, src }: { canvas: HTMLElement; src: string }) {
  const [long, setLong] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hasAction, setHasAction] = useState(false);

  useEffect(() => {
    const landscape = canvas.matches(".sheet-report-landscape, .hr-staff-sheet")
      || Boolean(canvas.closest('[data-a4-orientation="landscape"]'));
    const paperCanvas = canvas.matches(PAPER_CANVASES);
    canvas.classList.add("a4-preview-canvas");
    canvas.setAttribute("data-a4-preview-orientation", landscape ? "landscape" : "portrait");
    canvas.setAttribute("data-a4-preview-paper", String(paperCanvas));
    const measure = () => {
      setHasAction(Boolean(associatedPrintAction(canvas)));
      const height = Math.max(canvas.scrollHeight, canvas.getBoundingClientRect().height);
      setLong(!paperCanvas || height > (landscape ? 210 : 297) * MM + 2);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    measure();
    return () => {
      observer.disconnect();
      canvas.classList.remove("a4-preview-canvas");
      canvas.removeAttribute("data-a4-preview-orientation");
      canvas.removeAttribute("data-a4-preview-paper");
    };
  }, [canvas]);

  const preview = () => {
    // Preserve existing print logging/permission workflows, when supplied.
    associatedPrintAction(canvas)?.click();
  };
  // Preview guidance is UI, never authoritative report text. Keep it outside
  // every nested report wrapper, including screen-first dashboard adapters.
  let reportBoundary = canvas;
  let ancestor = canvas.parentElement?.closest<HTMLElement>(CANVASES);
  while (ancestor) {
    reportBoundary = ancestor;
    ancestor = ancestor.parentElement?.closest<HTMLElement>(CANVASES);
  }
  const noticeOwner = reportBoundary.parentElement;
  return <>
    {createPortal(!long && !failed ? <div className="a4-preview-watermark" aria-hidden="true">
      <img src={src} alt="" draggable={false} onError={() => setFailed(true)} />
    </div> : null, canvas)}
    {long && noticeOwner && createPortal(<aside className="a4-preview-notice" role="note">
      <span>هذا عرض متصل للمستند، وليس تقسيم الصفحات النهائي. استخدم زر الطباعة الخاص بهذا المستند لمعاينة الصفحات الفعلية وشعارها الثابت.</span>
      {hasAction && <button type="button" onClick={preview}>معاينة صفحات الطباعة</button>}
    </aside>, noticeOwner)}
  </>;
}

/** Reuses the body-owned asset; no per-table logo and no changes to document
 * data or compact paper sizes. Portals attach only to existing A4 canvases. */
export function A4WatermarkPreview({ src }: { src: string }) {
  const [canvases, setCanvases] = useState<{ canvas: HTMLElement; id: number }[]>([]);
  const ids = useRef(new WeakMap<HTMLElement, number>());
  const nextId = useRef(0);
  useEffect(() => {
    const discover = () => {
      const candidates = [...document.querySelectorAll<HTMLElement>(CANVASES)]
        .filter(node => !node.closest(COMPACT) && node.querySelector(".print-brand-header"));
      // A physical paper canvas owns its nested wrappers. Otherwise use the
      // innermost report document, not an enclosing dashboard section.
      const next = candidates.filter(node => !candidates.some(other => other !== node && (
        (other.matches(PAPER_CANVASES) && other.contains(node))
        || (!node.matches(PAPER_CANVASES) && node.contains(other))
      )));
      for (const node of next) if (!ids.current.has(node)) ids.current.set(node, ++nextId.current);
      setCanvases(previous => previous.length === next.length && previous.every((entry, i) => entry.canvas === next[i]) ? previous : next.map(canvas => ({ canvas, id: ids.current.get(canvas)! })));
    };
    const observer = new MutationObserver(discover);
    observer.observe(document.body, { childList: true, subtree: true });
    discover();
    return () => observer.disconnect();
  }, []);
  return canvases.map(({ canvas, id }) => <CanvasPreview key={id} canvas={canvas} src={src} />);
}
