"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";
import { BILLING_RULE_LABEL } from "@/lib/workflow";
import {
  defaultStepService, stepServiceOptions,
  type CatalogServiceForTemplate, type SpecialtyTemplate,
} from "@/lib/specialty-templates";
import { ToothPicker } from "./ToothPicker";

/**
 * (SPEC-T1) «خطة من قالب التخصص» — الطبيب بعد الفحص يختار القالب (علاج عصب، تقويم، تيجان…)
 * والأسنان والخدمة الدقيقة لكل خطوة، فتُبنى الخطة بجلساتها وزياراتها المخطَّطة دفعةً واحدة.
 * السعر المعروض هنا تقديرٌ من الدليل؛ والخادم يسعّر بنفسه عند الإنشاء.
 */

interface Doctor { id: number; name: string }

export function TemplatePlanForm({ patientId, base, onSaved, onError, onBusyChange, onUncertain, onAccessDenied, canViewCatalogPrices = true }: {
  patientId: number;
  base: Currency;
  onSaved: () => void;
  onError: (message: string | null) => void;
  onBusyChange?: (pending: boolean) => boolean | void;
  onUncertain?: () => void;
  onAccessDenied?: (status: number) => void;
  canViewCatalogPrices?: boolean;
}) {
  const [templates, setTemplates] = useState<SpecialtyTemplate[]>([]);
  /* خدمات الدليل للاختيار من مسار القوالب نفسه — بلا أسعار لمن لا يرى لائحة الأسعار. */
  const [services, setServices] = useState<CatalogServiceForTemplate[]>([]);
  const [showPrices, setShowPrices] = useState(false);
  const visiblePrices = canViewCatalogPrices && showPrices;
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [templateId, setTemplateId] = useState<string>("");
  const [teeth, setTeeth] = useState<number[]>([]);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [serviceFor, setServiceFor] = useState<Record<string, number | null>>({});
  const [currency, setCurrency] = useState<Currency>(base);
  const [doctorId, setDoctorId] = useState("");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const pendingRef = useRef(false);
  const uncertainRef = useRef(false);
  const mountedRef = useRef(false);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    void (async () => {
      const [templateResponse, doctorResponse] = await Promise.all([
        fetch("/api/plan-templates", { cache: "no-store" }),
        fetch("/api/parties?kind=doctor", { cache: "no-store" }),
      ]);
      if (templateResponse.ok) {
        const payload = await templateResponse.json();
        if (!mountedRef.current) return;
        setTemplates((payload.templates ?? []) as SpecialtyTemplate[]);
        setCanEdit(Boolean(payload.canEdit));
        setShowPrices(Boolean(payload.showPrices));
        setServices(((payload.services ?? []) as (Omit<CatalogServiceForTemplate, "priceMinor" | "priceSarMinor" | "priceUsdMinor"> & { priceMinor: number | null })[])
          .map((service) => ({ ...service, priceMinor: service.priceMinor ?? 0, priceSarMinor: null, priceUsdMinor: null })));
      }
      if (doctorResponse.ok) {
        const payload = await doctorResponse.json();
        if (!mountedRef.current) return;
        setDoctors(Array.isArray(payload) ? payload : payload.balances ?? []);
      }
    })();
  }, []);

  const template = templates.find((item) => item.id === templateId) ?? null;
  const needsTeeth = Boolean(template?.steps.some((step) => step.perTooth && (!step.optional || included[step.key])));
  const canEditDraft = () => mountedRef.current && !pendingRef.current && !uncertainRef.current;

  const choose = (next: SpecialtyTemplate) => {
    if (!canEditDraft()) return;
    setTemplateId(next.id);
    setIncluded(Object.fromEntries(next.steps.map((step) => [step.key, !step.optional])));
    setServiceFor({});
    setTitle(next.name);
    onError(null);
  };

  /* تقديرٌ بعملة الأساس فقط — سعر الدليل. بعملةٍ أخرى يسعّر الخادم (سعرها الخاص أو المحوَّل). */
  const estimate = useMemo(() => {
    if (!template || currency !== base || !visiblePrices) return null;
    let total = 0;
    for (const step of template.steps) {
      if (!included[step.key]) continue;
      const chosen = serviceFor[step.key];
      const service = chosen ? services.find((item) => item.id === chosen) : defaultStepService(step, services);
      if (!service) return null;
      total += service.priceMinor * (step.perTooth ? Math.max(teeth.length, 1) : 1);
    }
    return total;
  }, [template, included, serviceFor, services, teeth, currency, base, visiblePrices]);
  /* خطوةٌ مضمَّنة بلا خدمةٍ في الدليل تمنع الإنشاء هنا (والخادم يرفضها أيضًا). */
  const missingService = Boolean(template?.steps.some((step) =>
    Boolean(included[step.key]) && stepServiceOptions(step, services).length === 0));

  const markUncertain = () => {
    uncertainRef.current = true;
    if (mountedRef.current) setUncertain(true);
    // The parent must retain this attempt even if its form was removed.
    onUncertain?.();
  };

  const submit = async () => {
    if (!mountedRef.current || pendingRef.current || uncertainRef.current || !template || saving || missingService || (needsTeeth && teeth.length === 0)) return;
    pendingRef.current = true;
    if (onBusyChange?.(true) === false) {
      pendingRef.current = false;
      return;
    }
    setSaving(true);
    try {
      onError(null);
      let saved = false;
      let rejection: string | null = null;
      try {
        const response = await fetch("/api/plans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "template", patientId, templateId: template.id, title: title.trim() || template.name,
            currency, teeth, primaryDoctorId: doctorId ? Number(doctorId) : null,
            steps: template.steps.map((step) => ({ key: step.key, include: Boolean(included[step.key]), serviceId: serviceFor[step.key] ?? null })),
          }),
        });
        if (!response.ok && response.status >= 400 && response.status < 500 && ![408, 499].includes(response.status)) {
          rejection = "تعذّر إنشاء الخطة من القالب.";
          if ([401, 403, 404].includes(response.status)) onAccessDenied?.(response.status);
        }
        const payload = await response.json().catch(() => null);
        saved = response.ok && response.status >= 200 && response.status < 300
          && Number.isSafeInteger(payload?.id) && payload.id > 0;
        if (!response.ok && response.status >= 400 && response.status < 500 && ![408, 499].includes(response.status)) {
          rejection = typeof payload?.message === "string" ? payload.message : "تعذّر إنشاء الخطة من القالب.";
        }
      } catch {
        // A lost response does not prove that the server rejected the write.
      }
      if (!saved && rejection === null) markUncertain();
      else if (mountedRef.current) {
        if (saved) onSaved();
        else onError(rejection);
      }
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setSaving(false);
      // A removed form still owns its dispatched request until it settles.
      onBusyChange?.(false);
    }
  };

  return (
    <section className="mb-4 rounded-2xl border border-navy-800 bg-white p-4" aria-label="خطة من قالب التخصص">
      <fieldset disabled={saving || uncertain} className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">خطة من قالب التخصص</h3>
        {canEdit ? <a href="/settings/plan-templates" aria-disabled={saving || uncertain}
          onClick={(event) => { if (!canEditDraft()) event.preventDefault(); }}
          className="text-xs font-bold text-navy-800 underline">تعديل القوالب</a> : null}
      </div>

      {uncertain ? (
        <p role="alert" className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
          قد تكون الخطة قد أُنشئت رغم عدم وصول تأكيد. لا تُعِد الإرسال قبل مراجعة خطط المريض والتحقق من المحاولة السابقة.
        </p>
      ) : null}

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {templates.map((item) => (
          <button key={item.id} type="button" onClick={() => choose(item)}
            className={`rounded-xl border px-3 py-2 text-right text-sm font-bold ${
              item.id === templateId ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-navy-900"}`}>
            {item.name}
            <span className={`block text-[11px] font-normal ${item.id === templateId ? "text-white/70" : "text-slate-500"}`}>{item.specialty}</span>
          </button>
        ))}
      </div>

      {template ? (
        <>
          <p className="mb-3 text-xs text-slate-600">{template.description}</p>

          {needsTeeth ? (
            <div className="mb-3">
              <span className="mb-1 block text-[11px] font-bold text-slate-500">الأسنان — انقر لاختيارها</span>
              <ToothPicker value={teeth} onChange={(next) => { if (canEditDraft()) setTeeth(next); }} />
            </div>
          ) : null}

          <ol className="mb-3 space-y-2">
            {template.steps.map((step) => {
              const options = stepServiceOptions(step, services);
              const selected = serviceFor[step.key] ?? defaultStepService(step, services)?.id ?? null;
              const on = Boolean(included[step.key]);
              return (
                <li key={step.key} className={`rounded-xl border p-2.5 ${on ? "border-slate-200 bg-slate-50/60" : "border-slate-100 bg-white opacity-60"}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    {step.optional ? (
                      <input type="checkbox" checked={on} aria-label={`تضمين ${step.title}`}
                        onChange={(event) => { if (canEditDraft()) setIncluded((current) => ({ ...current, [step.key]: event.target.checked })); }} />
                    ) : null}
                    <span className="text-sm font-bold">{step.title}</span>
                    {step.perTooth ? <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-bold text-sky-700">لكل سن</span> : null}
                    {step.labWork ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-800">مختبر</span> : null}
                    <span className="text-[11px] text-slate-500">{BILLING_RULE_LABEL[step.billingRule]}</span>
                  </div>
                  {on ? (
                    <>
                      {options.length === 0 ? (
                        <p className="mt-1 text-xs font-bold text-red-700">لا خدمة في الدليل من هذه الفئة — أضفها أولًا.</p>
                      ) : (
                        <select value={selected ?? ""} aria-label={`خدمة ${step.title}`}
                          onChange={(event) => { if (canEditDraft()) setServiceFor((current) => ({ ...current, [step.key]: Number(event.target.value) || null })); }}
                          className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
                          {options.map((option) => (
                            <option key={option.id} value={option.id}>{visiblePrices ? `${option.name} — ${formatMoney(option.priceMinor, base)}` : option.name}</option>
                          ))}
                        </select>
                      )}
                      <p className="mt-1.5 text-[11px] leading-5 text-slate-600">
                        {step.sessions.map((item, index) => (
                          <span key={index}>
                            {index > 0 ? ` ← ${item.afterDays ? `بعد ${item.afterDays} يومًا: ` : ""}` : ""}{item.title} ({item.minutes} د)
                          </span>
                        ))}
                      </p>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ol>

          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            <label>
              <span className="mb-1 block text-[11px] font-bold text-slate-500">اسم الخطة</span>
              <input value={title} onChange={(event) => { if (canEditDraft()) setTitle(event.target.value); }} aria-label="اسم الخطة" maxLength={120}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
            </label>
            <label>
              <span className="mb-1 block text-[11px] font-bold text-slate-500">عملة الاتفاق</span>
              <select value={currency} onChange={(event) => { if (canEditDraft()) setCurrency(event.target.value as Currency); }} aria-label="عملة الاتفاق"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                {CURRENCIES.map((option) => <option key={option} value={option}>{CURRENCY_LABEL[option]}</option>)}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-[11px] font-bold text-slate-500">الطبيب</span>
              <select value={doctorId} onChange={(event) => { if (canEditDraft()) setDoctorId(event.target.value); }} aria-label="طبيب الخطة"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                <option value="">— بلا تحديد —</option>
                {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
              </select>
            </label>
          </div>

          <p className="mb-3 text-sm font-extrabold">
            {estimate !== null ? `الإجمالي التقديري: ${formatMoney(estimate, currency)}` : "يُسعَّر من الدليل عند الإنشاء."}
          </p>
          <button type="button" onClick={submit} disabled={saving || uncertain || missingService || (needsTeeth && teeth.length === 0)}
            className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
            أنشئ الخطة من القالب
          </button>
        </>
      ) : (
        <p className="text-xs text-slate-500">اختر القالب المناسب لما قرّره الفحص.</p>
      )}
      </fieldset>
    </section>
  );
}
