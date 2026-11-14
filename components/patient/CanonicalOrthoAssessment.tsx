"use client";
import { useEffect, useId, useLayoutEffect, useState } from "react";
import type { AssessmentOwnerV2 } from "@/lib/ortho-assessment-owner-v2";
import { OrthoCaseAssessmentV2, type AssessmentLifetimeV2 } from "@/components/OrthoCaseAssessmentV2";

/** Reuse the version-pinned record and, only when supplied, the existing clinical
 * editor owner. Refresh unmounts payloads without discarding parent-owned drafts. */
export function CanonicalOrthoAssessment({ patientId, caseId, clinicTimeZone, ownerFor }: { patientId: number; caseId: number; clinicTimeZone: string; ownerFor?: (caseId: number) => AssessmentOwnerV2 }) {
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
      onClick={() => { setVisible(document.visibilityState !== "hidden"); setOpen(value => !value); }}>{open ? "إغلاق التقييم والقياسات" : "عرض التقييم والقياسات"}</button>
    {open && visible ? <div id={region} data-testid="canonical-ortho-assessment">
      {ownerFor ? <OwnedAssessment key={`${patientId}:${caseId}:${epoch}`} patientId={patientId} caseId={caseId} clinicTimeZone={clinicTimeZone} ownerFor={ownerFor} />
        : <OrthoCaseAssessmentV2 key={`${patientId}:${caseId}:${epoch}`} patientId={patientId} orthoCaseId={caseId} clinicTimeZone={clinicTimeZone} readOnly />}
    </div> : null}
  </div>;
}

/** View subscriptions may unmount during refresh. The patient/case owner above
 * keeps the exact draft and receipt until settlement or explicit retirement. */
function OwnedAssessment({ patientId, caseId, clinicTimeZone, ownerFor }: { patientId: number; caseId: number; clinicTimeZone: string; ownerFor: (caseId: number) => AssessmentOwnerV2 }) {
  const [owner] = useState(() => ownerFor(caseId));
  const [, redraw] = useState(0);
  useLayoutEffect(() => {
    owner.activate(); const unsubscribe = owner.subscribe(() => redraw(value => value + 1));
    // Detail refresh/close also retires this view, independently of list polls.
    // Preserve pending request bytes, but never settle them from its late reply.
    return () => { unsubscribe(); owner.invalidateRead(); };
  }, [owner]);
  const lifetime: AssessmentLifetimeV2 = {
    identity: owner, active: owner.active, editable: owner.editable, denied: owner.denied,
    busy: owner.busy, uncertain: owner.uncertain, dirty: owner.dirty, readVersion: owner.readVersion,
    values: { document: owner.document }, change: (_field, value) => owner.change(value),
    settle: (_field, value) => owner.settle(value), refresh: owner.refresh,
    begin: owner.begin, beginRetry: owner.beginRetry,
  };
  return <OrthoCaseAssessmentV2 patientId={patientId} orthoCaseId={caseId} clinicTimeZone={clinicTimeZone} lifetime={lifetime} />;
}
