"use client";
import type { CanonicalCoverageDraft } from "@/lib/canonical-ortho-coverage-draft";
import { useEffect, useId, useMemo, useState } from "react";
import { OrthoFollowupCoveragePanel } from "../OrthoFollowupCoveragePanel";
import { formatClinicDate } from "@/lib/clinic-clock";
import { isCanonicalOrthoCoverage, type CanonicalOrthoCoverage as Coverage } from "@/lib/canonical-ortho-coverage-projection";

/** Independent agreement read; the clinical case never supplies this grant. */
export function CanonicalOrthoCoverage({ patientId, caseId, ownerFor }: { patientId: number; caseId: number; ownerFor?: (caseId: number) => CanonicalCoverageDraft }) {
  const regionId = useId();
  const draftOwner = useMemo(() => ownerFor?.(caseId), [ownerFor, caseId]);
  const [open, setOpen] = useState(false), [refresh, setRefresh] = useState(0);
  const [feed, setFeed] = useState<Coverage | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true, sequence = 0, controller: AbortController | undefined;
    const clear = () => { sequence++; controller?.abort(); setFeed(null); setError(null); };
    const load = async () => {
      clear();
      if (document.visibilityState === "hidden") return;
      const request = sequence, current = new AbortController(); controller = current;
      const timeout = setTimeout(() => current.abort(), 8000);
      try {
        const response = await fetch(`/api/ortho/${caseId}/followup-coverage?patientId=${patientId}`, { cache: "no-store", signal: current.signal });
        const value: unknown = await response.json().catch(() => null);
        if (!alive || request !== sequence) return;
        if (!response.ok || !isCanonicalOrthoCoverage(value, patientId, caseId)) throw new Error("تعذّر التحقق من نطاق المتابعات. لم يُعتبر مشمولًا أو خارج الاتفاق.");
        setFeed(value);
      } catch {
        if (alive && request === sequence) setError("تعذّر التحقق من نطاق المتابعات. أعد تحميل السجل قبل الاعتماد عليه.");
      } finally { clearTimeout(timeout); }
    };
    const visible = () => { if (document.visibilityState === "hidden") clear(); else void load(); };
    const focus = () => { void load(); };
    void load(); const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 30_000);
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visible);
    return () => { alive = false; sequence++; controller?.abort(); clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [open, patientId, caseId, refresh]);
  return <section className="mt-3 border-t border-slate-200 pt-3" aria-label="نطاق تغطية المتابعات">
    <button type="button" aria-expanded={open} aria-controls={regionId} onClick={() => { setFeed(null); setError(null); setOpen(value => !value); }}
      className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">{open ? "إغلاق نطاق المتابعات" : "عرض نطاق المتابعات المحفوظ"}</button>
    {open ? <div id={regionId} data-testid="canonical-ortho-coverage" className="mt-3 space-y-3 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-bold text-navy-900">نطاق تغطية المتابعات</h4>
        <button type="button" onClick={() => { setFeed(null); setError(null); setRefresh(value => value + 1); }} className="min-h-11 rounded-xl border border-slate-200 px-3 text-xs font-bold text-navy-800">تحديث نطاق المتابعات</button></div>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !feed ? <p role="status">جارٍ التحقق من السجل…</p> : <div data-testid="ortho-coverage-saved" className="space-y-3 text-sm">
        {!feed.enabled ? <p role="status" className="text-amber-800">سجل نطاق المتابعات غير جاهز للتحقق. لا يُفترض أنها مشمولة أو خارج الاتفاق.</p>
          : !feed.current ? <p>لا يوجد قرار تغطية محفوظ؛ لا يُفترض شمول المتابعات أو استثناؤها.</p> : <>
            <p className="font-bold">القرار المحفوظ: {feed.current.decision === "included" ? "المتابعات الروتينية مشمولة" : "المتابعات الروتينية خارج الاتفاق"}</p>
            {!feed.applicable ? <p role="status" className="text-amber-800">القرار المحفوظ لا يطابق مصدر الاتفاق الحالي. يلزم التحقق؛ لم يتغيّر القرار تلقائيًا.</p> : <p>القرار يطابق مصدر الاتفاق في هذه القراءة.</p>}
            <p className="whitespace-pre-wrap">سبب القرار: {feed.current.reason}</p>
            <p>النسخة {feed.current.version} — سجّلها {feed.current.createdBy} — <time dateTime={feed.current.createdAt}>{formatClinicDate(feed.current.createdAt, feed.clinicTimeZone)}</time></p>
          </>}
        {feed.invoiceSources.state === "restricted" ? <p className="text-slate-600">تفاصيل مصدر الفاتورة تحتاج صلاحية عرض الفواتير.</p>
          : feed.invoiceSources.items.length ? <><h5 className="font-bold">مصادر الفواتير المطابقة المتاحة</h5><ul className="space-y-2">{feed.invoiceSources.items.map((item, index) => <li key={`${item.invoiceId}:${index}`}>{item.invoiceNumber} — {item.serviceName}</li>)}</ul></> : null}
        <p className="text-xs text-slate-600">هذا عرض للقرار المحفوظ، ولا يغيّر الاتفاق أو الفواتير أو اعتماد الزيارات.</p>
      </div>}
    </div> : null}
    <OrthoFollowupCoveragePanel canonical draftOwner={draftOwner} patientId={patientId} orthoCaseId={caseId} onSaved={() => { setFeed(null); setRefresh(value => value + 1); }} />
  </section>;
}
