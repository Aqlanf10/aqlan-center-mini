"use client";
import { useEffect, useId, useState } from "react";
import { OrthoTreatmentStrategy } from "@/components/OrthoTreatmentStrategy";

/** Reuse the saved clinical strategy reader, with no editor lifetime. Unmount old
 * verified payloads on visibility/focus refresh; in-flight decoders lose ownership. */
export function CanonicalOrthoStrategy({ patientId, caseId, clinicTimeZone }: { patientId: number; caseId: number; clinicTimeZone: string }) {
  const region = useId();
  const [open, setOpen] = useState(false), [visible, setVisible] = useState(true), [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!open) return;
    const refresh = () => { setVisible(document.visibilityState !== "hidden"); setEpoch(value => value + 1); };
    const tick = () => { if (document.visibilityState !== "hidden") refresh(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(tick, 30_000);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [open]);
  return <div className="space-y-3 border-t border-slate-200 pt-3">
    <button type="button" className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800" aria-expanded={open} aria-controls={region}
      onClick={() => { setVisible(document.visibilityState !== "hidden"); setOpen(value => !value); }}>{open ? "إغلاق الاستراتيجية المحفوظة" : "عرض الاستراتيجية المحفوظة"}</button>
    {open && visible ? <div id={region} data-testid="canonical-ortho-strategy">
      <OrthoTreatmentStrategy key={`${patientId}:${caseId}:${epoch}`} patientId={patientId} orthoCaseId={caseId} clinicTimeZone={clinicTimeZone} />
    </div> : null}
  </div>;
}
