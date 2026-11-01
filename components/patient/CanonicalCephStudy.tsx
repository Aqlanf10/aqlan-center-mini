"use client";

import { useEffect, useId, useState } from "react";
import { isCanonicalCephStudy,type CanonicalCephStudy as SavedCephStudy } from "@/lib/canonical-ceph-projection";
import { CanonicalCephCopy } from "./CanonicalCephCopy";

/** Saved study reference only. Opening this section never mounts legacy editors or requests
 * their plan, image, assessment or financial endpoints. */
export function CanonicalCephStudy({ patientId,studyId,ownerKey,canAnalyze,onCopied }: { patientId: string;studyId:number;ownerKey:string;canAnalyze:boolean;onCopied:()=>void }) {
  const regionId = useId();
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [feed, setFeed] = useState<SavedCephStudy | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true, sequence = 0;
    let controller: AbortController | undefined;
    const clear = () => { sequence++; controller?.abort(); setFeed(null); setError(null); };
    const load = async () => {
      clear();
      if (document.visibilityState === "hidden") return;
      const request = sequence;
      controller = new AbortController();
      const current = controller;
      const timeout = setTimeout(() => current.abort(), 8000);
      try {
        const response = await fetch(`/api/ceph/${studyId}`, { cache: "no-store", signal: current.signal });
        const payload = await response.json().catch(() => null);
        if (!alive || request !== sequence) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل الدراسة المحفوظة.");
        if (!isCanonicalCephStudy(payload,Number(patientId),studyId)) {
          throw new Error("تعذّر التحقق من الدراسة المحفوظة. أعد تحميلها.");
        }
        setFeed(payload);
      } catch (failure) {
        if (alive && request === sequence) setError(failure instanceof Error && failure.name === "Error" ? failure.message : "تعذّر الاتصال بالخادم. أعد تحميل الدراسة.");
      } finally { clearTimeout(timeout); }
    };
    const visible = () => { if (document.visibilityState === "hidden") clear(); else void load(); };
    const focus = () => { void load(); };
    void load();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 30_000);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; sequence++; controller?.abort(); clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [open, patientId,studyId, refresh]);

  return <div className="mt-3 border-t border-slate-200 pt-3">
    <button type="button" aria-expanded={open} aria-controls={regionId} onClick={()=>{setFeed(null);setError(null);setOpen(value=>!value);}}
      className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">{open?"إغلاق الدراسة المحفوظة":"عرض الدراسة المحفوظة"}</button>
    {open?<section id={regionId} data-testid="canonical-ceph-study" aria-label="الدراسة المحفوظة" className="mt-3 space-y-3 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-bold text-navy-900">السجل المحفوظ للسيفالومتري</h4>
        <button type="button" onClick={()=>{setFeed(null);setError(null);setRefresh(value=>value+1);}} className="min-h-11 rounded-xl border border-slate-200 px-3 text-xs font-bold text-navy-800">تحديث الدراسة</button></div>
      <p className="text-xs text-slate-600">عرض البيانات المسجلة كما حُفظت؛ يبقى الأصل المعتمد دون تغيير.</p>
      {error?<p role="alert" className="text-sm text-red-700">{error}</p>:!feed?<p role="status">جارٍ تحميل الدراسة…</p>:<div data-testid="canonical-ceph-saved" className="space-y-3">
        {feed.analysis.status==="draft"?<p className="text-amber-800">مسودة غير معتمدة؛ القياسات والملاحظات المحفوظة هنا ليست نتائج معتمدة.</p>:<p className="text-navy-800">حالة السجل: دراسة معتمدة</p>}
        {canAnalyze && feed.analysis.status === "completed" ? <CanonicalCephCopy key={`${ownerKey}:${patientId}:${studyId}`} patientId={patientId} studyId={studyId} ownerKey={ownerKey} onCopied={onCopied} refreshStudy={() => { setFeed(null); setRefresh(value => value + 1); }} /> : null}
        <dl className="grid gap-2 sm:grid-cols-2">
          <div><dt className="text-xs text-slate-500">الجهاز المسجل</dt><dd>{feed.analysis.device??"غير مسجل"}</dd></div>
          <div><dt className="text-xs text-slate-500">المجموعة المرجعية المسجلة</dt><dd dir="ltr">{feed.analysis.refSet}</dd></div>
          <div><dt className="text-xs text-slate-500">سجلها</dt><dd>{feed.analysis.createdBy}</dd></div>
          <div><dt className="text-xs text-slate-500">اعتمدها</dt><dd>{feed.analysis.completedBy??"غير مسجل"}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-slate-500">ملاحظة الدراسة</dt><dd className="whitespace-pre-wrap">{feed.analysis.note??"لا توجد ملاحظة"}</dd></div>
        </dl>
        {feed.analysis.imageState==="unavailable"?<p className="text-xs text-amber-800">مرجع الصورة غير متاح؛ هذه بيانات الدراسة المسجلة فقط.</p>:null}
        <h5 className="font-bold">المعايرة المسجلة</h5>
        {feed.analysis.calibration?<dl className="grid grid-cols-2 gap-2 text-xs" dir="ltr">
          <div><dt>X1 / Y1 (px)</dt><dd>{feed.analysis.calibration.x1} / {feed.analysis.calibration.y1}</dd></div>
          <div><dt>X2 / Y2 (px)</dt><dd>{feed.analysis.calibration.x2} / {feed.analysis.calibration.y2}</dd></div>
          <div><dt>mm</dt><dd>{feed.analysis.calibration.mm}</dd></div><div><dt>mm / px</dt><dd>{feed.analysis.mmPerPixel??"—"}</dd></div>
        </dl>:<p className="text-xs text-slate-600">لا توجد معايرة مكتملة محفوظة؛ لم تُحسب معايرة بديلة.</p>}
        <h5 className="font-bold">القياسات المحفوظة برموزها الأصلية</h5>
        {feed.measurements.length?<table className="w-full table-fixed text-left text-xs" dir="ltr"><thead><tr><th scope="col" className="py-2">الرمز</th><th scope="col">القيمة المحفوظة</th></tr></thead><tbody>{feed.measurements.map(m=><tr key={m.code}><td className="border-t py-2">{m.code}</td><td className="border-t">{m.value}</td></tr>)}</tbody></table>:<p className="text-xs">لا توجد قياسات محفوظة؛ لم تُحسب نتائج بديلة.</p>}
        <h5 className="font-bold">المعالم المسجلة</h5>
        {feed.landmarks.length?<ul className="space-y-2 text-xs">{feed.landmarks.map(p=><li key={p.code} className="rounded-lg bg-slate-50 p-2"><p dir="ltr">{p.code}: X {p.x} / Y {p.y} (px)</p><p>{p.source==="manual"?"يدوي":"مقترح"} · {p.confirmedBy}</p></li>)}</ul>:<p className="text-xs">لا توجد معالم محفوظة.</p>}
        <h5 className="font-bold">التشخيص المسجل</h5>
        {feed.diagnosis?<dl className="space-y-2 text-xs">
          <div><dt className="text-slate-500">هيكلي</dt><dd className="whitespace-pre-wrap">{feed.diagnosis.skeletal??"غير مسجل"}</dd></div>
          <div><dt className="text-slate-500">سني</dt><dd className="whitespace-pre-wrap">{feed.diagnosis.dental??"غير مسجل"}</dd></div>
          <div><dt className="text-slate-500">الأنسجة الرخوة</dt><dd className="whitespace-pre-wrap">{feed.diagnosis.softTissue??"غير مسجل"}</dd></div>
          <div><dt className="text-slate-500">ملاحظة التشخيص</dt><dd className="whitespace-pre-wrap">{feed.diagnosis.note??"لا توجد ملاحظة"}</dd></div>
          <div><dt className="text-slate-500">الاستنتاج المحفوظ</dt><dd className="whitespace-pre-wrap font-bold">{feed.diagnosis.finalDx}</dd></div>
          <div><dt className="text-slate-500">سجله</dt><dd>{feed.diagnosis.createdBy} — {feed.diagnosis.updatedAt.slice(0,10)}</dd></div>
        </dl>:<p className="text-xs">لا يوجد تشخيص محفوظ؛ لم يُولّد تشخيص بديل.</p>}
      </div>}
    </section>:null}
  </div>;
}
