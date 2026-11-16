"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useState } from "react";
import type { CanonicalStrategyOwner } from "@/lib/canonical-ortho-strategy-owner";
import { OrthoTreatmentStrategy } from "@/components/OrthoTreatmentStrategy";

/** Default reference reading stays separate from explicit editor admission.
 * The parent owns native draft bytes through polling; old responses lose ownership. */
export function CanonicalOrthoStrategy({ patientId, caseId, clinicTimeZone, ownerFor }: { patientId: number; caseId: number; clinicTimeZone: string; ownerFor?: (caseId: number) => CanonicalStrategyOwner }) {
  const region = useId();
  const [editing, setEditing] = useState(false);
  const owner = useMemo(() => ownerFor?.(caseId), [ownerFor, caseId]);
  const [open, setOpen] = useState(false), [visible, setVisible] = useState(true), [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!open) return;
    const refresh = () => { owner?.invalidateRead(); setVisible(document.visibilityState !== "hidden"); setEpoch(value => value + 1); };
    const tick = () => { if (document.visibilityState !== "hidden") refresh(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(tick, 30_000);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [open, owner]);
  return <div className="space-y-3 border-t border-slate-200 pt-3">
    <button type="button" className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800" aria-expanded={open} aria-controls={region}
      onClick={() => { owner?.invalidateRead(); setEditing(false); setVisible(document.visibilityState !== "hidden"); setOpen(value => !value); }}>{open ? "إغلاق الاستراتيجية المحفوظة" : "عرض الاستراتيجية المحفوظة"}</button>
    {owner ? <button type="button" className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800"
      onClick={() => { owner.invalidateRead(); setEditing(true); setOpen(true); setVisible(document.visibilityState !== "hidden"); }}>توثيق الاستراتيجية</button> : null}
    {open && visible ? <div id={region} data-testid="canonical-ortho-strategy">
      {editing && owner ? <StrategyEditor key={`${patientId}:${caseId}:${epoch}`} patientId={patientId} caseId={caseId} clinicTimeZone={clinicTimeZone} owner={owner} />
        : <OrthoTreatmentStrategy key={`${patientId}:${caseId}:${epoch}`} patientId={patientId} orthoCaseId={caseId} clinicTimeZone={clinicTimeZone} />}
    </div> : null}
  </div>;
}

function StrategyEditor({ patientId, caseId, clinicTimeZone, owner }: { patientId: number; caseId: number; clinicTimeZone: string; owner: CanonicalStrategyOwner }) {
  const [, redraw] = useState(0);
  useLayoutEffect(() => {
    const unsubscribe = owner.subscribe(() => redraw(value => value + 1));
    // Detail-only refresh/close can unmount this view without a list refresh.
    // Keep the draft, but no reply may acknowledge this retired view.
    return () => { unsubscribe(); owner.invalidateRead(); };
  }, [owner]);
  return <OrthoTreatmentStrategy patientId={patientId} orthoCaseId={caseId} clinicTimeZone={clinicTimeZone} lifetime={owner.lifetime} canonicalEdit />;
}
