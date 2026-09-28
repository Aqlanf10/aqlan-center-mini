"use client";

import { useEffect, useMemo, useState } from "react";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";
import { BILLING_RULE_LABEL } from "@/lib/workflow";
import {
  defaultStepService, stepServiceOptions,
  type CatalogServiceForTemplate, type SpecialtyTemplate,
} from "@/lib/specialty-templates";

/**
 * (SPEC-T1) «خطة من قالب التخصص» — الطبيب بعد الفحص يختار القالب (علاج عصب، تقويم، تيجان…)
 * والأسنان والخدمة الدقيقة لكل خطوة، فتُبنى الخطة بجلساتها وزياراتها المخطَّطة دفعةً واحدة.
 * السعر المعروض هنا تقديرٌ من الدليل؛ والخادم يسعّر بنفسه عند الإنشاء.
 */

interface Doctor { id: number; name: string }

export function TemplatePlanForm({ patientId, base, onSaved, onError }: {
  patientId: number;
  base: Currency;
  onSaved: () => void;
  onError: (message: string | null) => void;
}) {
  const [templates, setTemplates] = useState<SpecialtyTemplate[]>([]);
  const [services, setServices] = useState<CatalogServiceForTemplate[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [templateId, setTemplateId] = useState<string>("");
  const [teethText, setTeethText] = useState("");
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [serviceFor, setServiceFor] = useState<Record<string, number | null>>({});
  const [currency, setCurrency] = useState<Currency>(base);
  const [doctorId, setDoctorId] = useState("");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const [templateResponse, serviceResponse, doctorResponse] = await Promise.all([
        fetch("/api/plan-templates", { cache: "no-store" }),
        fetch("/api/services", { cache: "no-store" }),
        fetch("/api/parties?kind=doctor", { cache: "no-store" }),
      ]);
      if (templateResponse.ok) setTemplates(((await templateResponse.json()).templates ?? []) as SpecialtyTemplate[]);
      if (serviceResponse.ok) {
        const payload = await serviceResponse.json();
        setServices((payload.services ?? payload) as CatalogServiceForTemplate[]);
      }
      if (doctorResponse.ok) {
        const payload = await doctorResponse.json();
        setDoctors(Array.isArray(payload) ? payload : payload.balances ?? []);
      }
    })();
  }, []);

  const template = templates.find((item) => item.id === templateId) ?? null;
  const teeth = useMemo(() => [...new Set(teethText.split(/[\s,،]+/).map(Number).filter((tooth) => Number.isInteger(tooth) && tooth > 0))], [teethText]);
  const needsTeeth = Boolean(template?.steps.some((step) => step.perTooth && (!step.optional || included[step.key])));

  const choose = (next: SpecialtyTemplate) => {
    setTemplateId(next.id);
    setIncluded(Object.fromEntries(next.steps.map((step) => [step.key, !step.optional])));
    setServiceFor({});
    setTitle(next.name);
    onError(null);
  };

  /* تقديرٌ بعملة الأساس فقط — سعر الدليل. بعملةٍ أخرى يسعّر الخادم (سعرها الخاص أو المحوَّل). */
  const estimate = useMemo(() => {
    if (!template || currency !== base) return null;
    let total = 0;
    for (const step of template.steps) {
      if (!included[step.key]) continue;
      const chosen = serviceFor[step.key];
      const service = chosen ? services.find((item) => item.id === chosen) : defaultStepService(step, services);
      if (!service) return null;
      total += service.priceMinor * (step.perTooth ? Math.max(teeth.length, 1) : 1);
    }
    return total;
  }, [template, included, serviceFor, services, teeth, currency, base]);

  const submit = async () => {
    if (!template || saving) return;
    setSaving(true);
    onError(null);
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
      const payload = await response.json().catch(() => null);
      if (!response.ok) { onError(payload?.message ?? "تعذّر إنشاء الخطة من القالب."); return; }
      onSaved();
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-4 rounded-2xl border border-navy-800 bg-white p-4" aria-label="خطة من قالب التخصص">
      <h3 className="mb-3 text-sm font-bold">خطة من قالب التخصص</h3>

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
            <label className="mb-3 block">
              <span className="mb-1 block text-[11px] font-bold text-slate-500">الأسنان (الترقيم الدولي، مثل: 16، 26)</span>
              <input value={teethText} onChange={(event) => setTeethText(event.target.value)} aria-label="الأسنان"
                dir="ltr" inputMode="numeric" placeholder="16, 26"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
            </label>
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
                        onChange={(event) => setIncluded((current) => ({ ...current, [step.key]: event.target.checked }))} />
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
                          onChange={(event) => setServiceFor((current) => ({ ...current, [step.key]: Number(event.target.value) || null }))}
                          className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
                          {options.map((option) => (
                            <option key={option.id} value={option.id}>{option.name} — {formatMoney(option.priceMinor, base)}</option>
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
              <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="اسم الخطة" maxLength={120}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
            </label>
            <label>
              <span className="mb-1 block text-[11px] font-bold text-slate-500">عملة الاتفاق</span>
              <select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} aria-label="عملة الاتفاق"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                {CURRENCIES.map((option) => <option key={option} value={option}>{CURRENCY_LABEL[option]}</option>)}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-[11px] font-bold text-slate-500">الطبيب</span>
              <select value={doctorId} onChange={(event) => setDoctorId(event.target.value)} aria-label="طبيب الخطة"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                <option value="">— بلا تحديد —</option>
                {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
              </select>
            </label>
          </div>

          <p className="mb-3 text-sm font-extrabold">
            {estimate !== null ? `الإجمالي التقديري: ${formatMoney(estimate, currency)}` : "يُسعَّر من الدليل عند الإنشاء."}
          </p>
          <button type="button" onClick={submit} disabled={saving || (needsTeeth && teeth.length === 0)}
            className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
            أنشئ الخطة من القالب
          </button>
        </>
      ) : (
        <p className="text-xs text-slate-500">اختر القالب المناسب لما قرّره الفحص.</p>
      )}
    </section>
  );
}
