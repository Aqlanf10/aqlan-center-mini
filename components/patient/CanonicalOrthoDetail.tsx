"use client";
import { useEffect, useId, useState } from "react";
import { PHASE_LABEL, RETAINER_LABEL, type OrthoClinicalDetail } from "@/lib/ortho";

/** On-demand native clinical record. No old editors or independent image/finance APIs. */
export function CanonicalOrthoDetail({ patientId, caseId }: { patientId: string; caseId: number }) {
  const regionId = useId();
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [feed, setFeed] = useState<OrthoClinicalDetail | null>(null);
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
        const response = await fetch(`/api/ortho/${caseId}`, { cache: "no-store", signal: current.signal });
        const payload = await response.json().catch(() => null);
        if (!alive || request !== sequence) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل تفاصيل التقويم.");
        if (payload?.projection !== "case-clinical" || payload.case?.id !== caseId
          || payload.case?.patientId !== Number(patientId) || !Array.isArray(payload.adjustments)) {
          throw new Error("تعذّر التحقق من تفاصيل الحالة. أعد تحميلها.");
        }
        setFeed(payload);
      } catch (failure) {
        if (alive && request === sequence) setError(failure instanceof Error && failure.name === "Error" ? failure.message : "تعذّر الاتصال بالخادم. أعد تحميل التفاصيل.");
      } finally { clearTimeout(timeout); }
    };
    const visible = () => { if (document.visibilityState === "hidden") clear(); else void load(); };
    const focus = () => { void load(); };
    void load();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 30_000);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; sequence++; controller?.abort(); clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [open, patientId, caseId, refresh]);

  return <div className="mt-3 border-t border-slate-200 pt-3">
    <button type="button" aria-expanded={open} aria-controls={regionId}
      onClick={() => { setFeed(null); setError(null); setOpen(value => !value); }}
      className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">{open ? "إغلاق تفاصيل الحالة" : "عرض تفاصيل الحالة"}</button>
    {open ? <div id={regionId} data-testid="canonical-ortho-detail" className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-bold text-navy-900">السجل السريري للتقويم</h4>
        <button type="button" onClick={() => { setFeed(null); setError(null); setRefresh(value => value + 1); }}
          className="min-h-11 rounded-xl border border-slate-200 px-3 text-xs font-bold text-navy-800">تحديث التفاصيل</button>
      </div>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !feed ? <p role="status">جارٍ تحميل التفاصيل…</p> : <>
        <dl className="grid gap-2 sm:grid-cols-2">
          <div><dt className="text-xs text-slate-500">نظام الحاصرات</dt><dd>{feed.case.bracketSystem ?? "غير مسجل"}</dd></div>
          <div><dt className="text-xs text-slate-500">المثبت</dt><dd>{feed.case.retainer ? RETAINER_LABEL[feed.case.retainer] : "غير مسجل"}{feed.case.retainerOn ? ` — ${feed.case.retainerOn}` : ""}</dd></div>
          <div><dt className="text-xs text-slate-500">المطاطات المسجلة</dt><dd>{feed.case.elastics ?? "غير مسجلة"}</dd></div>
          <div><dt className="text-xs text-slate-500">عدد الشدّات المسجلة</dt><dd>{feed.progress.adjustments}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-slate-500">الأهداف المتبقية</dt><dd className="whitespace-pre-wrap">{feed.case.remainingObjectives ?? "غير مسجلة"}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-slate-500">ملاحظة الحالة</dt><dd className="whitespace-pre-wrap">{feed.case.note ?? "لا توجد ملاحظة"}</dd></div>
          {feed.case.closedAt ? <div className="sm:col-span-2"><dt className="text-xs text-slate-500">إقفال الحالة</dt><dd>{feed.case.closedAt.slice(0, 10)}</dd><dd className="whitespace-pre-wrap">{feed.case.closedNote}</dd></div> : null}
        </dl>
        <h5 className="font-bold text-navy-900">الشدّات المسجلة</h5>
        {!feed.adjustments.length ? <p>لا توجد شدّات مسجلة لهذه الحالة.</p> : <ol className="space-y-3">{feed.adjustments.map(a => <li key={a.id} className="rounded-xl bg-slate-50 p-3 [overflow-wrap:anywhere]">
          <p className="font-bold"><time>{a.doneOn}</time>{a.phase ? ` — ${PHASE_LABEL[a.phase]}` : ""}</p>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            <div><dt className="text-xs text-slate-500">السلك العلوي</dt><dd dir="ltr">{a.upperWire ?? "—"}</dd></div>
            <div><dt className="text-xs text-slate-500">السلك السفلي</dt><dd dir="ltr">{a.lowerWire ?? "—"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-slate-500">ما أُنجز</dt><dd className="whitespace-pre-wrap">{a.done ?? "غير مسجل"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-slate-500">ملاحظة الشدّة</dt><dd className="whitespace-pre-wrap">{a.note ?? "لا توجد ملاحظة"}</dd></div>
            <div><dt className="text-xs text-slate-500">المراجعة المقترحة</dt><dd>{a.nextWeeks} أسابيع</dd></div>
            <div><dt className="text-xs text-slate-500">سجّلها</dt><dd>{a.recordedBy}</dd></div>
          </dl>
        </li>)}</ol>}
        {feed.hasMore ? <p role="status" className="text-amber-800">تظهر أحدث 100 شدّة فقط؛ هذا ليس السجل الكامل. العدد أعلاه يشمل جميع الشدّات المسجلة.</p> : null}
      </>}
    </div> : null}
  </div>;
}
