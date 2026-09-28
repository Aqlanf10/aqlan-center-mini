"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { CATEGORY_LABEL as SERVICE_CATEGORY_LABEL } from "@/lib/services-catalog";
import { BILLING_RULE_LABEL, BILLING_RULES, MAX_SESSION_COUNT, type BillingRule } from "@/lib/workflow";
import {
  parseSpecialtyTemplates,
  type SpecialtyTemplate, type TemplateSession, type TemplateStep,
} from "@/lib/specialty-templates";

/**
 * (SPEC-T2) قوالب الخطط حسب التخصص — يعدّلها المالك: القوالب وخطواتها وجلساتها وفواصلها.
 *
 * التخزين في مفتاح الإعدادات `plans.specialty_templates` عبر مسار الإعدادات المدقَّق نفسه
 * (حماية الكتابة الضائعة، وسجل التغييرات بقبل/بعد). والتحقق نفسه يجري هنا قبل الحفظ وعلى
 * الخادم عند الحفظ. «استعادة الجاهزة» تُفرغ المفتاح فتعود قوالب الشيفرة.
 */

const KEY = "plans.specialty_templates";

const blankSession = (): TemplateSession => ({ title: "جلسة", minutes: 30, afterDays: 0 });
const blankStep = (index: number): TemplateStep => ({
  key: `s${Date.now().toString(36)}${index}`, title: "خطوة جديدة", category: "consultation", preferredService: null,
  perTooth: false, optional: false, billingRule: "on_completion", labWork: false, sessions: [blankSession()],
});

export default function PlanTemplatesSettingsPage() {
  const [templates, setTemplates] = useState<SpecialtyTemplate[]>([]);
  const [customized, setCustomized] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [templateResponse, settingsResponse] = await Promise.all([
      fetch("/api/plan-templates", { cache: "no-store" }),
      fetch("/api/settings", { cache: "no-store" }),
    ]);
    const payload = await templateResponse.json().catch(() => null);
    if (!templateResponse.ok) { setError(payload?.message ?? "تعذّر تحميل القوالب."); return; }
    setTemplates(payload.templates as SpecialtyTemplate[]);
    setCustomized(Boolean(payload.customized));
    setCanEdit(Boolean(payload.canEdit));
    if (settingsResponse.ok) {
      const settings = await settingsResponse.json().catch(() => null);
      setVersion((settings?.__versions?.[KEY] as string | null | undefined) ?? null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const problem = useMemo(() => {
    const parsed = parseSpecialtyTemplates(JSON.stringify(templates));
    return parsed.ok ? null : parsed.message;
  }, [templates]);

  const updateTemplate = (id: string, patch: (template: SpecialtyTemplate) => SpecialtyTemplate) =>
    setTemplates((current) => current.map((template) => (template.id === id ? patch(template) : template)));
  const updateStep = (id: string, stepIndex: number, patch: Partial<TemplateStep>) =>
    updateTemplate(id, (template) => ({
      ...template, steps: template.steps.map((step, index) => (index === stepIndex ? { ...step, ...patch } : step)),
    }));
  const updateSession = (id: string, stepIndex: number, sessionIndex: number, patch: Partial<TemplateSession>) =>
    updateTemplate(id, (template) => ({
      ...template,
      steps: template.steps.map((step, index) => (index !== stepIndex ? step : {
        ...step, sessions: step.sessions.map((item, i) => (i === sessionIndex ? { ...item, ...patch } : item)),
      })),
    }));
  const moveStep = (id: string, stepIndex: number, delta: number) =>
    updateTemplate(id, (template) => {
      const steps = [...template.steps];
      const target = stepIndex + delta;
      if (target < 0 || target >= steps.length) return template;
      [steps[stepIndex], steps[target]] = [steps[target], steps[stepIndex]];
      return { ...template, steps };
    });

  const save = async (value: string, message: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [KEY]: value, __versions: { [KEY]: version }, __reason: reason.trim() || null }),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 409) {
        setError("عدّل أحدٌ القوالب بعد فتح هذه الشاشة — أُعيد تحميلها، راجعها ثم احفظ.");
        await load();
        return;
      }
      if (!response.ok) { setError(payload?.message ?? "تعذّر حفظ القوالب."); return; }
      setNotice(message);
      setReason("");
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const input = "rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm";

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <PageHeader title="قوالب الخطط حسب التخصص"
        subtitle="ما يبنيه زر «خطة من قالب التخصص» في ملف المريض: الخطوات وجلساتها ومددها والفاصل بينها."
        back={{ href: "/settings", label: "الإعدادات" }} />

      {error ? <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p> : null}
      {notice ? <p role="status" className="mb-3 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-800">{notice}</p> : null}
      <p className="mb-3 text-xs text-slate-600">
        {customized ? "تعمل القوالب المعدَّلة من المركز." : "تعمل القوالب الجاهزة — أي تعديلٍ تحفظه يصير قوالب المركز."}
        {" "}الأسعار لا تُكتب هنا: تُقرأ من دليل الخدمات عند إنشاء الخطة. والتعديل لا يمسّ الخطط المنشأة سابقًا.
      </p>

      <ul className="space-y-3">
        {templates.map((template) => {
          const expanded = open === template.id;
          return (
            <li key={template.id} className="rounded-2xl border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => setOpen(expanded ? null : template.id)} className="text-right">
                  <span className="text-sm font-extrabold">{template.name}</span>
                  <span className="mr-2 text-xs text-slate-500">{template.specialty} · {template.steps.length} خطوات</span>
                </button>
                {canEdit ? (
                  <button type="button" disabled={templates.length <= 1}
                    onClick={() => setTemplates((current) => current.filter((item) => item.id !== template.id))}
                    className="rounded-lg border border-red-200 px-2 py-1 text-xs font-bold text-red-700 disabled:opacity-40">حذف القالب</button>
                ) : null}
              </div>

              {expanded ? (
                <fieldset disabled={!canEdit} className="mt-3 space-y-3">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <input className={input} aria-label="اسم القالب" value={template.name}
                      onChange={(event) => updateTemplate(template.id, (item) => ({ ...item, name: event.target.value }))} />
                    <input className={input} aria-label="التخصص" value={template.specialty}
                      onChange={(event) => updateTemplate(template.id, (item) => ({ ...item, specialty: event.target.value }))} />
                    <input className={input} aria-label="وصف القالب" value={template.description}
                      onChange={(event) => updateTemplate(template.id, (item) => ({ ...item, description: event.target.value }))} />
                  </div>

                  {template.steps.map((step, stepIndex) => (
                    <div key={step.key} className="rounded-xl border border-slate-100 bg-slate-50/60 p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-bold text-slate-500">{stepIndex + 1}.</span>
                        <input className={`${input} min-w-[10rem] flex-1`} aria-label="عنوان الخطوة" value={step.title}
                          onChange={(event) => updateStep(template.id, stepIndex, { title: event.target.value })} />
                        <select className={input} aria-label="فئة الخدمة" value={step.category}
                          onChange={(event) => updateStep(template.id, stepIndex, { category: event.target.value })}>
                          {Object.entries(SERVICE_CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                        <select className={input} aria-label="قاعدة الفوترة" value={step.billingRule}
                          onChange={(event) => updateStep(template.id, stepIndex, { billingRule: event.target.value as BillingRule })}>
                          {BILLING_RULES.map((rule) => <option key={rule} value={rule}>{BILLING_RULE_LABEL[rule]}</option>)}
                        </select>
                        <button type="button" onClick={() => moveStep(template.id, stepIndex, -1)} className="px-1 text-sm" aria-label="أعلى">▲</button>
                        <button type="button" onClick={() => moveStep(template.id, stepIndex, 1)} className="px-1 text-sm" aria-label="أسفل">▼</button>
                        <button type="button" aria-label="حذف الخطوة"
                          onClick={() => updateTemplate(template.id, (item) => ({ ...item, steps: item.steps.filter((_, i) => i !== stepIndex) }))}
                          className="px-1 text-sm text-red-600">✕</button>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                        <input className={`${input} min-w-[12rem]`} aria-label="الخدمة المفضّلة" placeholder="الخدمة المفضّلة (اختياري)"
                          value={step.preferredService ?? ""}
                          onChange={(event) => updateStep(template.id, stepIndex, { preferredService: event.target.value || null })} />
                        <label><input type="checkbox" checked={step.perTooth} onChange={(event) => updateStep(template.id, stepIndex, { perTooth: event.target.checked })} /> لكل سن</label>
                        <label><input type="checkbox" checked={step.optional} onChange={(event) => updateStep(template.id, stepIndex, { optional: event.target.checked })} /> اختيارية</label>
                        <label><input type="checkbox" checked={step.labWork} onChange={(event) => updateStep(template.id, stepIndex, { labWork: event.target.checked })} /> عمل مختبر</label>
                      </div>
                      <table className="mt-2 w-full text-xs">
                        <thead><tr className="text-slate-500"><th className="text-right">الجلسة</th><th>الدقائق</th><th>بعد (يوم)</th><th /></tr></thead>
                        <tbody>
                          {step.sessions.map((item, sessionIndex) => (
                            <tr key={sessionIndex}>
                              <td><input className={`${input} w-full`} aria-label="عنوان الجلسة" value={item.title}
                                onChange={(event) => updateSession(template.id, stepIndex, sessionIndex, { title: event.target.value })} /></td>
                              <td><input className={`${input} w-20`} aria-label="مدة الجلسة" inputMode="numeric" dir="ltr" value={item.minutes}
                                onChange={(event) => updateSession(template.id, stepIndex, sessionIndex, { minutes: Math.round(Number(event.target.value) || 0) })} /></td>
                              <td><input className={`${input} w-20`} aria-label="الفاصل بالأيام" inputMode="numeric" dir="ltr" value={item.afterDays}
                                onChange={(event) => updateSession(template.id, stepIndex, sessionIndex, { afterDays: Math.round(Number(event.target.value) || 0) })} /></td>
                              <td><button type="button" aria-label="حذف الجلسة" className="px-1 text-red-600"
                                onClick={() => updateStep(template.id, stepIndex, { sessions: step.sessions.filter((_, i) => i !== sessionIndex) })}>✕</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <button type="button" disabled={step.sessions.length >= MAX_SESSION_COUNT}
                        onClick={() => updateStep(template.id, stepIndex, { sessions: [...step.sessions, blankSession()] })}
                        className="mt-1 rounded-lg border border-slate-300 px-2 py-1 text-xs font-bold disabled:opacity-40">+ جلسة</button>
                    </div>
                  ))}
                  <button type="button"
                    onClick={() => updateTemplate(template.id, (item) => ({ ...item, steps: [...item.steps, blankStep(item.steps.length)] }))}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold">+ خطوة</button>
                </fieldset>
              ) : null}
            </li>
          );
        })}
      </ul>

      {canEdit ? (
        <div className="mt-4 space-y-2 rounded-2xl border border-slate-200 bg-white p-3">
          <button type="button"
            onClick={() => {
              const id = `t${Date.now().toString(36)}`;
              setTemplates((current) => [...current, { id, specialty: "علاج عام", name: "قالب جديد", description: "", steps: [blankStep(0)] }]);
              setOpen(id);
            }}
            className="rounded-lg border border-navy-800 px-3 py-1.5 text-xs font-bold text-navy-800">+ قالب جديد</button>
          {problem ? <p role="alert" className="text-xs font-bold text-red-700">{problem}</p> : null}
          <input className={`${input} w-full`} aria-label="سبب التعديل" placeholder="سبب التعديل (يُحفظ في سجل التغييرات)"
            value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || Boolean(problem)}
              onClick={() => void save(JSON.stringify(templates), "حُفظت القوالب — تعمل للخطط الجديدة من الآن.")}
              className="flex-1 rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">احفظ القوالب</button>
            <button type="button" disabled={busy || !customized}
              onClick={() => { if (window.confirm("استعادة القوالب الجاهزة تحذف تعديلات المركز عليها. متابعة؟")) void save("", "استُعيدت القوالب الجاهزة."); }}
              className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 disabled:opacity-40">استعادة القوالب الجاهزة</button>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-xs text-slate-500">التعديل للمدير.</p>
      )}
    </div>
  );
}
