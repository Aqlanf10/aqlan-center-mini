"use client";

import { useEffect, useId, useState } from "react";
import { CEPH_READ_PHASES, type CanonicalCephSummary } from "@/lib/canonical-ceph-projection";
import { isCanonicalCephComparison, isCanonicalCephSuperimposition, type CanonicalCephComparison as Comparison, type CanonicalCephSuperimposition as Geometry, type CephPairStudy } from "@/lib/canonical-ceph-pair-projection";

type RequestPair = { first: number; second: number; mode: "compare" | "superimpose"; revision: number };
export function CanonicalCephComparison({ patientId, studies }: { patientId: string; studies: CanonicalCephSummary[] }) {
  const regionId = useId();
  const [open, setOpen] = useState(false), [first, setFirst] = useState(""), [second, setSecond] = useState("");
  const [request, setRequest] = useState<RequestPair | null>(null), [feed, setFeed] = useState<Comparison | Geometry | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!request || !open) return;
    let alive = true, sequence = 0;
    let controller: AbortController | undefined;
    const clear = () => { sequence++; controller?.abort(); setFeed(null); setError(null); };
    const load = async () => {
      clear(); if (document.visibilityState === "hidden") return;
      const currentSequence = sequence, current = new AbortController(); controller = current;
      const timer = setTimeout(() => current.abort(), 8000);
      try {
        const response = await fetch(`/api/ceph/${request.mode}?first=${request.first}&second=${request.second}`, { cache: "no-store", signal: current.signal });
        const payload = await response.json().catch(() => null);
        if (!alive || currentSequence !== sequence) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل المقارنة.");
        const valid = request.mode === "compare" ? isCanonicalCephComparison(payload, Number(patientId), request.first, request.second) : isCanonicalCephSuperimposition(payload, Number(patientId), request.first, request.second);
        if (!valid) throw new Error("تعذّر التحقق من المقارنة. أعد تحميلها.");
        setFeed(payload);
      } catch (failure) {
        if (alive && currentSequence === sequence) setError(failure instanceof Error && failure.name === "Error" ? failure.message : "تعذّر الاتصال بالخادم. أعد تحميل المقارنة.");
      } finally { clearTimeout(timer); }
    };
    const visible = () => { if (document.visibilityState === "hidden") clear(); else void load(); }, focus = () => { void load(); };
    void load(); const interval = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 30_000);
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visible);
    return () => { alive = false; sequence++; controller?.abort(); clearInterval(interval); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [request, open, patientId]);
  const clear = () => { setFeed(null); setError(null); setRequest(null); };
  const choose = (mode: RequestPair["mode"]) => { setFeed(null); setError(null); setRequest(prior => ({ first: Number(first), second: Number(second), mode, revision: (prior?.revision ?? 0) + 1 })); };
  const allowed = !!first && !!second && first !== second;
  const describe = (study: CephPairStudy) => `${CEPH_READ_PHASES[study.phase]} · ${study.xrayDate ?? study.createdAt.slice(0, 10)} · ${study.status === "completed" ? "معتمدة" : "مسودة"}`;

  return <section className="rounded-xl border border-slate-200 p-3 [overflow-wrap:anywhere]">
    <button type="button" aria-expanded={open} aria-controls={regionId} className="min-h-11 rounded-xl border border-slate-300 px-3 text-sm font-bold text-navy-800" onClick={() => { clear(); setOpen(value => !value); }}>
      {open ? "إغلاق مقارنة الدراسات" : "مقارنة دراستين محفوظتين"}
    </button>
    {open ? <div id={regionId} data-testid="canonical-ceph-comparison" className="mt-3 space-y-3">
      <p className="text-xs text-slate-600">اختر دراستين من القائمة المعروضة؛ يرتبهما الخادم بتاريخ التصوير، ثم التسجيل والمعرّف عند التعادل. لا تعدّل المقارنة أي دراسة.</p>
      <div className="grid gap-3 sm:grid-cols-2">{(["first", "second"] as const).map(which => <div key={which} className="min-w-0 text-xs font-bold">
        <label htmlFor={`${regionId}-${which}`}>{which === "first" ? "الدراسة الأولى" : "الدراسة الثانية"}</label>
        <select id={`${regionId}-${which}`} className="mt-1 min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white p-2" value={which === "first" ? first : second} onChange={event => { clear(); (which === "first" ? setFirst : setSecond)(event.target.value); }}>
          <option value="">اختر دراسة</option>{studies.map(study => <option key={study.id} value={study.id}>{describe({ ...study, measurementsState: study.status === "completed" ? "saved-approved" : "saved-unapproved" })} · #{study.id}</option>)}
        </select>
      </div>)}</div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!allowed} onClick={() => choose("compare")} className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold disabled:opacity-50">مقارنة القيم المحفوظة</button>
        <button type="button" disabled={!allowed} onClick={() => choose("superimpose")} className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold disabled:opacity-50">تراكب المعالم المحفوظة</button>
      </div>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : request && !feed ? <p role="status">جارٍ تحميل المقارنة…</p> : feed ? <div data-testid="canonical-ceph-pair-result" className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2"><p className="text-xs"><strong>الأقدم:</strong> {describe(feed.before)}{feed.before.xrayDate === null ? " · تاريخ التصوير غير مسجل؛ استُخدم تاريخ التسجيل" : ""}</p><p className="text-xs"><strong>الأحدث:</strong> {describe(feed.after)}{feed.after.xrayDate === null ? " · تاريخ التصوير غير مسجل؛ استُخدم تاريخ التسجيل" : ""}</p></div>
        {feed.before.status === "draft" || feed.after.status === "draft" ? <p className="text-sm text-amber-800">تتضمن المقارنة مسودة غير معتمدة؛ ليست كل القيم المعروضة نتائج معتمدة.</p> : null}
        {feed.projection === "ceph-saved-comparison" ? <>
          <p className="text-xs text-slate-600">القيم المحفوظة برموزها الأصلية، والفرق هو الأحدث ناقص الأقدم. متوسط المرجع ووحدة القياس التاريخية غير محفوظين مع القيم؛ لا يصدر هذا العرض حكم تحسّن أو تراجع ولا يستبدلهما بمرجع حالي.</p>
          {feed.rows.length ? <table className="w-full table-fixed text-left text-xs" dir="ltr"><thead><tr><th scope="col" className="py-2">الرمز</th><th scope="col">الأقدم</th><th scope="col">الأحدث</th><th scope="col">الفرق</th></tr></thead><tbody>{feed.rows.map(row => <tr key={row.code}><th scope="row" className="border-t py-2 font-normal">{row.code}</th><td className="border-t">{row.before}</td><td className="border-t">{row.after}</td><td className="border-t">{row.delta}</td></tr>)}</tbody></table> : <p>لا توجد قياسات محفوظة مشتركة بين الدراستين.</p>}
          {feed.onlyBefore.length ? <p className="text-xs">مسجلة في الأقدم فقط، ولا فرق محسوب لها: <bdi>{feed.onlyBefore.join("، ")}</bdi></p> : null}
          {feed.onlyAfter.length ? <p className="text-xs">مسجلة في الأحدث فقط، ولا فرق محسوب لها: <bdi>{feed.onlyAfter.join("، ")}</bdi></p> : null}
        </> : <>
          <p className="text-xs text-slate-600">رسم مشتق من المعالم والمعايرة المحفوظة على SN. الخطوط المتاحة فقط، دون صورة الأشعة أو إعادة حساب القياسات. الإحداثيات ببكسل صورة الأقدم؛ ليست أبعادًا فعلية على الشاشة.</p>
          <p className="text-xs"><span className="font-bold text-blue-800">الأقدم: أزرق متصل</span> · <span className="font-bold text-rose-800">الأحدث: أحمر متقطع</span></p>
          <svg role="img" aria-label="تراكب الخطوط المرجعية المحفوظة دون صورة الأشعة" viewBox={`${feed.viewBox.x} ${feed.viewBox.y} ${feed.viewBox.width} ${feed.viewBox.height}`} className="h-64 w-full rounded-xl border border-slate-200 bg-white">
            <title>تراكب الخطوط المرجعية المحفوظة دون صورة الأشعة</title>
            {[feed.before, feed.after].map((study, index) => <g key={study.id} stroke={index === 0 ? "#1e40af" : "#be123c"} strokeWidth={Math.max(feed.viewBox.width, feed.viewBox.height) / 250} fill="none" strokeDasharray={index === 1 ? `${Math.max(feed.viewBox.width, feed.viewBox.height) / 50}` : undefined}>
              {study.lines.map((line, position) => <line key={position} x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y}><title>{line.label}</title></line>)}
            </g>)}
          </svg>
          <dl className="grid gap-2 text-xs sm:grid-cols-3"><div><dt>طول SN الأقدم (mm)</dt><dd dir="ltr">{feed.cranialBaseBefore}</dd></div><div><dt>طول SN الأحدث (mm)</dt><dd dir="ltr">{feed.cranialBaseAfter}</dd></div><div><dt>دوران التراكب (°)</dt><dd dir="ltr">{feed.rotationDegrees}</dd></div></dl>
        </>}
      </div> : null}
    </div> : null}
  </section>;
}
