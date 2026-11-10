'use client';
import { useEffect, useRef, useState } from 'react';
import { fullStudyPrintFits } from '@/lib/ortho-study-print-readiness';

export function OrthoFullStudyPrintReadiness() {
  const marker = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const root = marker.current?.closest<HTMLElement>('[data-full-study-print]');
    if (!root) return;
    let cancelled = false;
    const apply = (value: boolean) => { root.dataset.printReady = value ? 'true' : 'false'; if (!cancelled) setReady(value); };
    const check = () => apply(fullStudyPrintFits(root));
    const observer = new ResizeObserver(() => check());
    root.querySelectorAll('[data-print-region], [data-print-content]').forEach(node => observer.observe(node));
    const loading = () => apply(false);
    document.fonts.addEventListener('loading', loading);
    document.fonts.addEventListener('loadingdone', check);
    const images = [...root.querySelectorAll<HTMLImageElement>('[data-print-sheet] img')];
    images.forEach(image => { image.addEventListener('load', check); image.addEventListener('error', loading); });
    // Direct Ctrl+P must recheck the actual print-media layout, not merely trust
    // a previous screen measurement or the enabled state of our button.
    window.addEventListener('beforeprint', check);
    const media = window.matchMedia('print'); media.addEventListener('change', check);
    void Promise.all([document.fonts.ready, ...images.map(image => image.decode())]).then(() => {
      if (!cancelled) requestAnimationFrame(check);
    }).catch(() => { if (!cancelled) apply(false); });
    return () => { cancelled = true; observer.disconnect(); document.fonts.removeEventListener('loading', loading);
      document.fonts.removeEventListener('loadingdone', check); images.forEach(image => { image.removeEventListener('load', check); image.removeEventListener('error', loading); });
      window.removeEventListener('beforeprint', check); media.removeEventListener('change', check); root.dataset.printReady = 'false'; };
  }, []);
  return <div ref={marker}>
    <div className="study-print-controls"><button type="button" disabled={!ready} onClick={() => {
      const root = marker.current?.closest<HTMLElement>('[data-full-study-print]');
      if (!root || !fullStudyPrintFits(root)) { if (root) root.dataset.printReady = 'false'; setReady(false); return; }
      window.print();
    }}>طباعة / حفظ PDF</button></div>
    <p className="study-print-not-ready" role="status">لم تصبح الدراسة جاهزة للطباعة. انتظر تحميل الخطوط والصور. إذا استمرت الرسالة، فالترويسة أو المحتوى لا يتسعان ضمن حدود الورقة؛ لم تُجهز نسخة سريرية جزئية أو مقصوصة.</p>
  </div>;
}
