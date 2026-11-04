"use client";
import { formatClinicDate } from "@/lib/clinic-clock";
import { CanonicalCephComparison } from "./CanonicalCephComparison";
import { CanonicalCephStudy } from "./CanonicalCephStudy";
import { CanonicalCephReferences } from "./CanonicalCephReferences";
import { CanonicalCephCreate } from "./CanonicalCephCreate";
import { CanonicalCephDiscard } from "./CanonicalCephDiscard";

import { useEffect, useId, useState } from "react";
import { CEPH_READ_PHASES,isCanonicalCephList,type CanonicalCephList } from "@/lib/canonical-ceph-projection";

/** Read-only summary. Opening this section never mounts legacy editors or requests
 * their plan, image, assessment or financial endpoints. */
export function CanonicalCephStudies({ patientId,ownerKey,canAnalyze,canCreate = false }: { patientId: string;ownerKey:string;canAnalyze:boolean;canCreate?:boolean }) {
  const regionId = useId();
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [feed, setFeed] = useState<CanonicalCephList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
        const response = await fetch(`/api/patients/${encodeURIComponent(patientId)}/ceph`, { cache: "no-store", signal: current.signal });
        const payload = await response.json().catch(() => null);
        if (!alive || request !== sequence) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل دراسات السيفالومتري.");
        if (!isCanonicalCephList(payload,Number(patientId))) {
          throw new Error("تعذّر التحقق من قائمة الدراسات. أعد تحميلها.");
        }
        setFeed(payload);
      } catch (failure) {
        if (alive && request === sequence) setError(failure instanceof Error && failure.name === "Error" ? failure.message : "تعذّر الاتصال بالخادم. أعد تحميل الدراسات.");
      } finally { clearTimeout(timeout); }
    };
    const visible = () => { if (document.visibilityState === "hidden") clear(); else void load(); };
    const focus = () => { void load(); };
    void load();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 30_000);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; sequence++; controller?.abort(); clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [open, patientId, refresh]);

  return <section aria-label="دراسات السيفالومتري" className="max-w-full rounded-2xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-bold text-navy-900">دراسات السيفالومتري</h2>
      <button type="button" aria-expanded={open} aria-controls={regionId} onClick={() => {setFeed(null);setError(null);setOpen(value=>!value);}}
        className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">{open?"إغلاق الدراسات":"عرض دراسات السيفالومتري"}</button>
    </div>
    {open?<div id={regionId} className="mt-3 space-y-3" data-testid="canonical-ceph-studies">
      <p className="text-xs text-slate-600">نتائج محفوظة كما سُجلت؛ لم يُعَد حسابها، ولا تُعرض صور هنا.</p>
      {notice ? <p role="status">{notice}</p> : null}
      {feed && !error ? <CanonicalCephReferences /> : null}
      {feed && !error && feed.analyses.length > 1 ? <CanonicalCephComparison patientId={patientId} studies={feed.analyses} clinicTimeZone={feed.clinicTimeZone} /> : null}
      <button type="button" onClick={()=>{setFeed(null);setError(null);setRefresh(value=>value+1);}}
        className="min-h-11 rounded-xl border border-slate-200 px-3 text-xs font-bold text-navy-800">تحديث الدراسات</button>
      {error?<p role="alert" className="text-sm text-red-700">{error}</p>:!feed?<p role="status">جارٍ تحميل الدراسات…</p>:feed.analyses.length===0?<p>لا توجد دراسات مسجلة لهذا المريض.</p>:
        <ul className="space-y-3">{feed.analyses.map(row=><li key={row.id} className="min-w-0 rounded-xl border border-slate-200 p-3 text-sm [overflow-wrap:anywhere]">
          <h3 className="font-bold text-navy-900">{row.status==="completed"?"دراسة معتمدة":"مسودة غير معتمدة"} — {CEPH_READ_PHASES[row.phase]}</h3>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            <div><dt className="text-xs text-slate-500">تاريخ الشععة</dt><dd dir="ltr">{row.xrayDate??"غير مسجل"}</dd></div>
            <div><dt className="text-xs text-slate-500">تاريخ التسجيل</dt><dd dir="ltr">{formatClinicDate(row.createdAt, feed.clinicTimeZone)}</dd></div>
            {row.completedAt?<div><dt className="text-xs text-slate-500">تاريخ الاعتماد</dt><dd dir="ltr">{formatClinicDate(row.completedAt, feed.clinicTimeZone)}</dd></div>:null}
          </dl>
          {row.status==="draft"?<p className="mt-2 text-xs text-amber-800">المسودة ليست نتيجة معتمدة.</p>:row.findings?<dl className="mt-2 grid grid-cols-3 gap-2" dir="ltr">
            <div><dt>ANB (°)</dt><dd>{row.findings.anb??"—"}</dd></div><div><dt>FMA (°)</dt><dd>{row.findings.fma??"—"}</dd></div><div><dt>WITS (mm)</dt><dd>{row.findings.wits??"—"}</dd></div>
          </dl>:<p className="mt-2 text-xs text-slate-600">لا توجد قيم ملخص محفوظة؛ لم تُحسب قيم بديلة.</p>}
          {row.imageState==="unavailable"?<p className="mt-2 text-xs text-amber-800">مرجع الصورة غير متاح؛ تبقى بيانات الدراسة المحفوظة دون عرض الصورة.</p>:null}
          <CanonicalCephStudy patientId={patientId} studyId={row.id} ownerKey={ownerKey} canAnalyze={canAnalyze} onCompleted={() => { setNotice("اعتُمدت الدراسة وسُجّلت القياسات وأثر الاعتماد. راجع السجل المحفوظ."); setFeed(null); setRefresh(value => value + 1); }} onCopied={() => { setNotice("أُنشئت مسودة التصحيح وسُجّل أثرها. المسودة غير معتمدة."); setFeed(null); setRefresh(value => value + 1); }} />
        </li>)}</ul>}
      {feed?.hasMore?<p role="status" className="text-sm text-amber-800">تظهر 300 دراسة فقط؛ هذه ليست القائمة الكاملة. المسودة أولًا ثم الأحدث.</p>:null}
      {feed && !error && canAnalyze ? <CanonicalCephDiscard patientId={patientId} ownerKey={ownerKey} draftId={feed.analyses.find(row => row.status === "draft")?.id ?? null}
        refresh={() => { setFeed(null); setRefresh(value => value + 1); }} onDiscarded={() => { setNotice("رُفضت المسودة وسُجّل أثرها؛ بقيت بياناتها محفوظة."); setFeed(null); setRefresh(value => value + 1); }} /> : null}
    </div>:null}
    {canCreate ? <CanonicalCephCreate patientId={patientId} ownerKey={ownerKey} visible={open && !!feed && !error} list={feed}
      refreshStudies={() => { setFeed(null); setRefresh(value => value + 1); }}
      onCreated={() => { setNotice("فُتحت مسودة جديدة وسُجّل أثرها. لا تحتوي نتائج معتمدة."); setFeed(null); setRefresh(value => value + 1); }} /> : null}
  </section>;
}
