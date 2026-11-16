"use client";

import { useEffect, useId, useState } from "react";
import { isCanonicalCephReferenceCatalog, type CanonicalCephReferenceCatalog } from "@/lib/canonical-ceph-reference-projection";

/** Current reference facts only. Never applies a reference to a historical study. */
export function CanonicalCephReferences() {
  const regionId = useId();
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [feed, setFeed] = useState<CanonicalCephReferenceCatalog | null>(null);
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
      const current = new AbortController();
      controller = current;
      const timeout = setTimeout(() => current.abort(), 8000);
      try {
        const response = await fetch("/api/ceph-reference-sets", { cache: "no-store", signal: current.signal });
        const payload = await response.json().catch(() => null);
        if (!alive || request !== sequence) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل المراجع.");
        if (!isCanonicalCephReferenceCatalog(payload)) throw new Error("تعذّر التحقق من المراجع. أعد تحميلها.");
        setFeed(payload);
      } catch (failure) {
        if (alive && request === sequence) setError(failure instanceof Error && failure.name === "Error" ? failure.message : "تعذّر الاتصال بالخادم. أعد تحميل المراجع.");
      } finally { clearTimeout(timeout); }
    };
    const visible = () => { if (document.visibilityState === "hidden") clear(); else void load(); };
    const focus = () => { void load(); };
    void load();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 30_000);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; sequence++; controller?.abort(); clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [open, refresh]);

  return <div className="rounded-xl border border-slate-200 p-3">
    <button type="button" aria-expanded={open} aria-controls={regionId} onClick={() => { setFeed(null); setError(null); setOpen(value => !value); }}
      className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">{open ? "إغلاق المراجع الحالية" : "عرض المراجع الحالية"}</button>
    {open ? <section id={regionId} data-testid="canonical-ceph-references" className="mt-3 space-y-3 [overflow-wrap:anywhere]" aria-label="المراجع الحالية للسيفالومتري">
      <p className="text-xs text-slate-600">هذه المجموعات المرجعية المفعلة حاليًا. عرضها لا يغيّر القياسات أو التشخيص المحفوظ، ولا يثبت أنها المرجع المستخدم عند اعتماد دراسة سابقة.</p>
      <button type="button" onClick={() => { setFeed(null); setError(null); setRefresh(value => value + 1); }} className="min-h-11 rounded-xl border border-slate-200 px-3 text-xs font-bold text-navy-800">تحديث المراجع</button>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !feed ? <p role="status">جارٍ تحميل المراجع…</p>
        : feed.sets.length === 0 ? <p className="text-sm">لا توجد مجموعات مرجعية مفعلة.</p>
          : <div className="space-y-3">{feed.sets.map(set => <article key={set.key} className="rounded-xl bg-slate-50 p-3" data-testid="canonical-ceph-reference-set">
            <h3 className="text-sm font-bold text-navy-900">{set.name}</h3>
            <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
              <div><dt className="text-slate-500">المفتاح والإصدار المسجلان</dt><dd dir="ltr">{set.key} · {set.version}</dd></div>
              <div><dt className="text-slate-500">المجموعة السكانية</dt><dd>{set.population ?? "غير محددة"}</dd></div>
              <div><dt className="text-slate-500">العمر الأدنى</dt><dd>{set.ageMin ?? "غير محدد"}</dd></div>
              <div><dt className="text-slate-500">العمر الأعلى</dt><dd>{set.ageMax ?? "غير محدد"}</dd></div>
              <div><dt className="text-slate-500">الجنس</dt><dd>{set.sex === "female" ? "إناث" : set.sex === "male" ? "ذكور" : "غير محدد"}</dd></div>
            </dl>
            {Object.keys(set.values).length ? <table className="mt-3 w-full table-fixed text-center text-xs" dir="ltr"><thead><tr><th scope="col" className="py-2">الرمز</th><th scope="col">المتوسط</th><th scope="col">الانحراف المعياري</th></tr></thead>
              <tbody>{Object.entries(set.values).map(([code, value]) => <tr key={code}><td className="border-t py-2">{code}</td><td className="border-t">{value.mean}</td><td className="border-t">{value.sd}</td></tr>)}</tbody></table>
              : <p className="mt-2 text-xs">لا توجد قيم محفوظة لهذه المجموعة.</p>}
          </article>)}</div>}
    </section> : null}
  </div>;
}
