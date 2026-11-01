"use client";

import { useEffect, useId, useState } from "react";
import { isCanonicalClinicalPlans, type CanonicalClinicalPlans as PlanFeed } from "@/lib/canonical-plan-projection";
import { PLAN_ITEM_STATUS_LABEL, PLAN_STATUS_LABEL } from "@/lib/plans";
import { CanonicalPlanTemplateCatalog } from "./CanonicalPlanTemplateCatalog";

export function CanonicalClinicalPlans({ patientId }: { patientId: string }) {
  const regionId = useId();
  const [open, setOpen] = useState(false), [refresh, setRefresh] = useState(0);
  const [feed, setFeed] = useState<PlanFeed | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true, sequence = 0;
    let controller: AbortController | undefined;
    const clear = () => { sequence++; controller?.abort(); setFeed(null); setError(null); };
    const load = async () => {
      clear();
      if (document.visibilityState === "hidden") return;
      const request = sequence, current = new AbortController(); controller = current;
      const timeout = setTimeout(() => current.abort(), 8000);
      try {
        const response = await fetch(`/api/patients/${patientId}/plans`, { cache: "no-store", signal: current.signal });
        const payload = await response.json().catch(() => null);
        if (!alive || request !== sequence) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل الخطط السريرية.");
        if (!isCanonicalClinicalPlans(payload, Number(patientId))) throw new Error("تعذّر التحقق من الخطط السريرية. أعد تحميلها.");
        setFeed(payload);
      } catch (failure) {
        if (alive && request === sequence) setError(failure instanceof Error && failure.name === "Error" ? failure.message : "تعذّر الاتصال بالخادم. أعد تحميل الخطط.");
      } finally { clearTimeout(timeout); }
    };
    const visible = () => { if (document.visibilityState === "hidden") clear(); else void load(); };
    const focus = () => { void load(); };
    void load();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 30_000);
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visible);
    return () => { alive = false; sequence++; controller?.abort(); clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [open, patientId, refresh]);

  return <section aria-label="الخطط السريرية" className="max-w-full rounded-2xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-bold text-navy-900">الخطط السريرية</h2>
      <button type="button" aria-expanded={open} aria-controls={regionId} onClick={() => { setFeed(null); setError(null); setOpen(value => !value); }}
        className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">{open ? "إغلاق الخطط السريرية" : "عرض الخطط السريرية"}</button>
    </div>
    {open ? <div id={regionId} data-testid="canonical-clinical-plans" className="mt-3 space-y-3 [overflow-wrap:anywhere]">
      <CanonicalPlanTemplateCatalog />
      <p className="text-xs text-slate-600">الخطة وبنود العلاج كما سُجلت. هذا العرض السريري لا يتضمن الأسعار أو الأقساط أو التحصيل.</p>
      <button type="button" onClick={() => { setFeed(null); setError(null); setRefresh(value => value + 1); }}
        className="min-h-11 rounded-xl border border-slate-200 px-3 text-xs font-bold text-navy-800">تحديث الخطط السريرية</button>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !feed ? <p role="status">جارٍ تحميل الخطط…</p>
        : feed.plans.length === 0 ? <p>لا توجد خطط مسجلة لهذا المريض.</p>
          : <div className="space-y-3">{feed.plans.map(plan => <article key={plan.id} data-testid="canonical-clinical-plan" className="min-w-0 rounded-xl border border-slate-200 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold text-navy-900">{plan.title}</h3><span>{PLAN_STATUS_LABEL[plan.status]}</span></div>
            <dl className="mt-2 grid gap-2 sm:grid-cols-2">
              <div><dt className="text-xs text-slate-500">تاريخ البداية</dt><dd dir="ltr">{plan.startDate}</dd></div>
              <div><dt className="text-xs text-slate-500">تاريخ التسجيل</dt><dd dir="ltr">{plan.createdAt.slice(0, 10)}</dd></div>
            </dl>
            {plan.note ? <p className="mt-2 whitespace-pre-wrap">{plan.note}</p> : null}
            {plan.consentAt ? <div className="mt-2 rounded-lg bg-slate-50 p-2 text-xs"><p>موافقة مسجلة بتاريخ <bdi>{plan.consentAt.slice(0, 10)}</bdi>{plan.consentBy ? ` — ${plan.consentBy}` : ""}</p>
              {plan.consentNote ? <p className="mt-1 whitespace-pre-wrap">{plan.consentNote}</p> : null}</div> : <p className="mt-2 text-xs text-amber-800">لم تُسجّل موافقة على الخطة.</p>}
            {plan.items.length === 0 ? <p className="mt-3 text-xs">لا توجد بنود علاج مسجلة في هذه الخطة.</p>
              : <ul className="mt-3 space-y-2">{plan.items.map(item => <li key={item.id} data-testid="canonical-clinical-plan-item" className="rounded-lg bg-slate-50 p-3">
                <div className="flex flex-wrap justify-between gap-2"><h4 className="font-bold">{item.serviceName}</h4><span className="text-xs">{PLAN_ITEM_STATUS_LABEL[item.status]}</span></div>
                <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  <div><dt className="text-slate-500">السن والأسطح</dt><dd>{item.toothCode ?? "غير مسجل"}{item.surfaces ? ` · ${item.surfaces}` : ""}</dd></div>
                  <div><dt className="text-slate-500">الكمية المسجلة</dt><dd>{item.quantity}</dd></div>
                  <div><dt className="text-slate-500">الجلسات المنجزة</dt><dd>{item.sessionsCompleted}</dd></div>
                  <div><dt className="text-slate-500">الجلسات المطلوبة المسجلة</dt><dd>{item.sessionCount ?? "غير مسجلة"}</dd></div>
                  <div><dt className="text-slate-500">رقم الزيارة المخططة</dt><dd>{item.plannedVisitNumber ?? "غير مسجل"}</dd></div>
                  {item.doctorName ? <div><dt className="text-slate-500">طبيب البند</dt><dd>{item.doctorName}</dd></div> : null}
                  {item.category ? <div><dt className="text-slate-500">التصنيف المسجل</dt><dd>{item.category}</dd></div> : null}
                  {item.caseSite ? <div><dt className="text-slate-500">موضع الحالة</dt><dd>{item.caseSite}</dd></div> : null}
                  {item.doneAt ? <div><dt className="text-slate-500">تاريخ الإنجاز المسجل</dt><dd dir="ltr">{item.doneAt.slice(0, 10)}</dd></div> : null}
                </dl>
                {item.note ? <p className="mt-2 whitespace-pre-wrap text-xs">{item.note}</p> : null}
              </li>)}</ul>}
          </article>)}</div>}
      {feed?.hasMore ? <p role="status" className="text-sm text-amber-800">تظهر أحدث 100 خطة فقط؛ هذه ليست القائمة الكاملة.</p> : null}
    </div> : null}
  </section>;
}
