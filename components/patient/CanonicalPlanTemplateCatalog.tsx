"use client";
import { useEffect, useId, useState } from "react";
import { isCanonicalPlanTemplateCatalog, type CanonicalPlanTemplateCatalog as Catalog } from "@/lib/canonical-plan-template-projection";
import { BILLING_RULE_LABEL } from "@/lib/workflow";
import { formatMoney } from "@/lib/money";

export function CanonicalPlanTemplateCatalog() {
  const regionId = useId();
  const [open, setOpen] = useState(false), [refresh, setRefresh] = useState(0);
  const [feed, setFeed] = useState<Catalog | null>(null), [error, setError] = useState<string | null>(null);
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
        const response = await fetch("/api/plan-templates", { cache: "no-store", signal: current.signal });
        const payload = await response.json().catch(() => null);
        if (!alive || request !== sequence) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل القوالب.");
        if (!isCanonicalPlanTemplateCatalog(payload)) throw new Error("تعذّر التحقق من القوالب. أعد تحميلها.");
        setFeed(payload);
      } catch (failure) {
        if (alive && request === sequence) setError(failure instanceof Error && failure.name === "Error" ? failure.message : "تعذّر الاتصال بالخادم. أعد تحميل القوالب.");
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

  return <section className="rounded-xl border border-slate-200 bg-white p-3 [overflow-wrap:anywhere]">
    <button type="button" aria-expanded={open} aria-controls={regionId} className="min-h-11 rounded-xl border border-slate-300 px-3 text-sm font-bold text-navy-800"
      onClick={() => { setFeed(null); setError(null); setOpen(value => !value); }}>{open ? "إغلاق دليل القوالب" : "عرض دليل القوالب والخدمات"}</button>
    {open ? <div id={regionId} data-testid="canonical-plan-template-catalog" className="mt-3 space-y-3">
      <p className="text-xs text-slate-600">القوالب الحالية وخدمات الدليل النشطة للقراءة. إنشاء خطة للمريض وتعديل الإعدادات لهما صلاحيات وإجراءات مستقلة.</p>
      <button type="button" className="min-h-11 rounded-xl border border-slate-200 px-3 text-xs font-bold" onClick={() => { setFeed(null); setError(null); setRefresh(n => n + 1); }}>تحديث دليل القوالب</button>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !feed ? <p role="status">جارٍ تحميل الدليل…</p> : <>
        <p className="text-xs text-slate-600">{feed.source === "saved" ? "قوالب محفوظة في الإعدادات المركزية." : feed.source === "default" ? "القوالب الجاهزة الحالية." : "القيمة المحفوظة في الإعدادات غير صالحة؛ تظهر القوالب الجاهزة التي يستخدمها النظام حاليًا."}</p>
        <div className="space-y-2">{feed.templates.map(template => <details key={template.id} className="rounded-xl bg-slate-50 p-3" data-testid="canonical-plan-template">
          <summary className="min-h-11 cursor-pointer text-sm font-bold text-navy-900">{template.name} · {template.specialty}</summary>
          <p className="mt-2 text-xs">{template.description}</p>
          <ol className="mt-3 list-inside list-decimal space-y-3">{template.steps.map(step => <li key={step.key} className="text-sm">
            <span className="font-bold">{step.title}</span><p className="mt-1 text-xs text-slate-600">{step.optional ? "خطوة اختيارية" : "خطوة أساسية"} · {step.perTooth ? "لكل سن" : "للحالة"} · {BILLING_RULE_LABEL[step.billingRule]}{step.labWork ? " · عمل مختبر" : ""}</p>
            <p className="text-xs">فئة الخدمة: {step.category}{step.preferredService ? ` · الخدمة المفضلة: ${step.preferredService}` : ""}</p>
            <ul className="mt-2 space-y-1">{step.sessions.map((session, index) => <li key={index} className="text-xs">{session.title} · {session.minutes} دقيقة · فاصل {session.afterDays} يومًا</li>)}</ul>
          </li>)}</ol>
        </details>)}</div>
        <h3 className="text-sm font-bold text-navy-900">خدمات الدليل النشطة ({feed.services.length})</h3>
        <p className="text-xs text-slate-600">{feed.pricesVisible ? "السعر الأساسي في الدليل بالريال اليمني." : "تظهر أسماء الخدمات وتصنيفاتها وفق صلاحية الخطط."}</p>
        {feed.services.length ? <ul className="space-y-2">{feed.services.map(service => <li key={service.id} data-testid="canonical-template-service" className="rounded-lg border border-slate-100 p-2 text-sm">
          <p className="font-bold">{service.name}</p>{service.category ? <p className="text-xs text-slate-600">{service.category}</p> : null}
          {service.price ? <div data-testid="canonical-template-service-price" className="mt-1 text-xs"><p>{formatMoney(service.price.minor, service.price.currency)}</p>
            {!service.price.configured ? <p className="text-amber-800">السعر يحتاج إعدادًا.</p> : service.price.provisional ? <p className="text-amber-800">السعر موسوم بأنه تقديري.</p> : null}</div> : null}
        </li>)}</ul> : <p className="text-sm">لا توجد خدمات نشطة في الدليل.</p>}
      </>}
    </div> : null}
  </section>;
}
