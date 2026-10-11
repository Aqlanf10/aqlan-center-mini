"use client";
import { useEffect, useLayoutEffect, useState } from "react";
import OrthoCaseStudy from "./OrthoCaseStudy";
import type { StudyMountOwner } from "@/lib/ortho-case-study-mount-owner";

/** Real saved-study entry. The parent retains this binding and its command
 * ledger across temporary sections; only this read is cancelled on detach. */
export function OrthoCaseStudyMount({ owner, patientName, confirmDiscard }: {
  owner: StudyMountOwner; patientName: string; confirmDiscard(): boolean;
}) {
  const [, redraw] = useState(0), [retry, setRetry] = useState(0);
  const [failure, setFailure] = useState<{ generation: number; message: string } | null>(null);
  const generation = owner.generation;
  useLayoutEffect(() => owner.subscribe(() => redraw(value => value + 1)), [owner]);
  useEffect(() => {
    const read = owner.beginRead(); if (!read) return;
    if (owner.study) return;
    let attached = true; const controller = new AbortController();
    const current = () => attached && !controller.signal.aborted && read.current();
    const timer = setTimeout(() => { controller.abort(); if (attached && read.current()) setFailure({ generation, message: "تعذّر إكمال قراءة الدراسة. أعد القراءة؛ لم تُعتبر الدراسة فارغة." }); }, 20_000);
    setFailure(null);
    void (async () => {
      try {
        const response = await fetch(`/api/ortho/${owner.orthoCaseId}/case-study/editor?patientId=${owner.patientId}`,
          { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!current()) return;
        if (response.status === 401 || response.status === 403) { read.denied(); return; }
        if (!response.ok || !response.headers.get("cache-control")?.includes("no-store")) throw new Error("study_binding_unavailable");
        const text = await response.text();
        if (!current()) return;
        if (new TextEncoder().encode(text).byteLength > 8 * 1024 * 1024) throw new Error("study_binding_limit");
        if (!await read.accept(JSON.parse(text)) && current()) throw new Error("study_binding_changed");
      } catch {
        if (current()) setFailure({ generation, message: "تعذّر التحقق من دراسة هذه الحالة أو رابطها السريري. لم يُخمن رابط بديل ولم تُستبدل مسودة محفوظة." });
      } finally { clearTimeout(timer); }
    })();
    return () => { attached = false; clearTimeout(timer); controller.abort(); };
  }, [owner, generation, retry]);
  const study = owner.study, clinicalCaseId = owner.clinicalCaseId;
  if (owner.bridgeChanged) return <div role="alert" className="rounded-xl border border-slate-200 p-3 text-sm space-y-2">
    <p>تغيّر الرابط السريري للدراسة. احتُفظ بالتعديلات المحلية تحت الرابط والحساب الأصليين، ولا يمكن حفظها في الرابط الجديد. راجع الرابط لاستعادة نفس السياق.</p>
    <p>استعادة المسودة مؤقتة في هذه الجلسة؛ إغلاق المتصفح أو إعادة تحميله قد يفقدها.</p>
    <button type="button" className="min-h-11 rounded-lg border border-slate-300 px-3 py-2" disabled={owner.busy || owner.uncertain}
      onClick={() => owner.discardQuarantinedDraft(confirmDiscard)}>تجاهل التعديلات المحلية للرابط السابق بعد التأكيد</button>
    <p>الطلب المرسل غير المحسوم لا يُحذف بهذا الإجراء. أعد فتح الحالة بعد حسم الرابط أو تجاهل التعديلات.</p>
  </div>;
  if (!owner.current()) return <p role="status" className="rounded-xl border border-slate-200 p-3 text-sm">تعذّر التحقق من الصلاحية الحالية للدراسة.</p>;
  if (study && clinicalCaseId !== null) return <OrthoCaseStudy patientId={owner.patientId} orthoCaseId={owner.orthoCaseId}
    clinicalCaseId={clinicalCaseId} patientName={patientName} ownerKey={owner.ownerKey} owner={study} confirmDiscard={confirmDiscard} />;
  const problem = failure?.generation === generation ? failure.message : null;
  return <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
    <p role={problem ? "alert" : "status"}>{problem ?? "جارٍ التحقق من رابط الحالة وقراءة الدراسة المحفوظة…"}</p>
    {problem ? <button type="button" className="mt-2 min-h-11 rounded-lg border border-slate-300 px-3 py-2"
      onClick={() => { if (owner.current() && owner.generation === generation) setRetry(value => value + 1); }}>إعادة قراءة الدراسة</button> : null}
  </div>;
}
