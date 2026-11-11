"use client";

import { ORTHO_WORKUP_GROUPS, ORTHO_WORKUP_STEPS, type OrthoWorkupPillar } from "@/lib/ortho-workup-navigation";

/** The normal case view and the workup share an order and readable labels,
 * including narrow screens. The parent still owns navigation admission. */
export function OrthoCaseNavigation({ pillar, onSelect }: {
  pillar: OrthoWorkupPillar; onSelect(pillar: OrthoWorkupPillar): void;
}) {
  return <nav aria-label="أقسام حالة التقويم" className="grid grid-cols-2 border-b border-slate-200 bg-white sm:grid-cols-5">
    {ORTHO_WORKUP_GROUPS.map(item => <button key={item.id} type="button" aria-label={item.title} aria-pressed={pillar === item.id}
      onClick={() => onSelect(item.id)}
      className={`flex min-h-11 items-center justify-center gap-1.5 border-b-2 px-2 py-2.5 text-xs font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${pillar === item.id ? "border-navy-800 bg-navy-50/40 text-navy-900" : "border-transparent text-slate-600 hover:bg-slate-50"}`}>
      <span aria-hidden="true">{item.icon}</span><span>{item.title}</span>
    </button>)}
  </nav>;
}

/** Direct navigation, not a completion wizard. The parent owns all admission
 * checks and drafts; selecting a destination never submits a clinical command. */
export function OrthoWorkupNavigation({ step, legacy, onSelect, onClose }: {
  step: number; legacy: boolean; onSelect(step: number): void; onClose(): void;
}) {
  const selected = ORTHO_WORKUP_STEPS[step];
  const group = ORTHO_WORKUP_GROUPS.find(item => item.steps.some(index => index === step));
  if (!selected || !group) return null;
  return <section aria-label="مساحة عمل ملف التقويم" className="m-3 min-w-0 space-y-3 rounded-xl border border-navy-200 bg-navy-50 p-3 sm:m-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="font-bold text-navy-900">{legacy ? "متابعة ملف التقويم" : "ملف التقويم"}</h3>
        <p className="mt-1 text-xs text-slate-600">اختر القسم المطلوب مباشرة. لا يلزم المرور على الأقسام بالترتيب.</p></div>
      <button type="button" className="min-h-11 rounded-lg border bg-white px-3 text-sm" onClick={onClose}>العودة لأقسام الحالة</button>
    </div>
    <nav aria-label="مجموعات ملف التقويم" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {ORTHO_WORKUP_GROUPS.map(item => <button key={item.id} type="button" aria-pressed={item.id === group.id}
        className={`min-h-11 rounded-lg border px-3 py-2 text-sm font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${item.id === group.id ? "border-navy-800 bg-navy-800 text-white" : "border-navy-200 bg-white text-navy-900"}`}
        onClick={() => onSelect(item.id === group.id ? step : item.entry)}>{item.title}</button>)}
    </nav>
    <nav aria-label={`أقسام ${group.title}`} className="flex flex-wrap gap-2">
      {group.steps.map(index => <button key={ORTHO_WORKUP_STEPS[index].id} type="button" aria-current={index === step ? "page" : undefined}
        className={`min-h-11 rounded-lg border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${index === step ? "border-navy-600 bg-white font-bold text-navy-900" : "border-transparent text-slate-700 hover:bg-white"}`}
        onClick={() => onSelect(index)}>{ORTHO_WORKUP_STEPS[index].title}</button>)}
    </nav>
    <div className="rounded-lg border border-navy-100 bg-white p-3">
      <p className="text-sm font-bold text-navy-900" role="status">{selected.title}</p>
      <p className="mt-1 text-sm text-slate-700">{selected.hint}</p>
    </div>
    <p className="text-xs text-slate-600">التنقل لا يحفظ التعديلات. احفظ من القسم المفتوح؛ فتح الأقسام لا يعني اكتمالها أو اعتماد الحالة سريريًا.</p>
  </section>;
}
