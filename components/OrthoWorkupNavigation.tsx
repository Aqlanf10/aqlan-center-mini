"use client";

import { ORTHO_CASE_PILLARS, ORTHO_WORKUP_GROUPS, ORTHO_WORKUP_STEPS, type OrthoWorkupPillar } from "@/lib/ortho-workup-navigation";

/** Same destinations and parent-owned admission. Display changes never save,
 * unmount a record owner, approve a case or manufacture completion progress. */
export function OrthoCaseNavigation({ pillar, onSelect }: {
  pillar: OrthoWorkupPillar; onSelect(pillar: OrthoWorkupPillar): void;
}) {
  return <nav aria-label="أقسام حالة التقويم" className="grid grid-cols-5 border-b border-slate-200 bg-white">
    {ORTHO_CASE_PILLARS.map(item => <button key={item.id} type="button" aria-label={item.title} aria-pressed={pillar === item.id}
      onClick={() => onSelect(item.id)}
      className={`flex min-h-11 flex-col items-center justify-center gap-0.5 border-b-2 px-1 py-1.5 text-center text-[11px] font-bold leading-tight sm:flex-row sm:gap-1.5 sm:px-2 sm:py-2.5 sm:text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${pillar === item.id ? "border-sky-600 bg-sky-50 text-sky-900" : "border-transparent text-slate-600 hover:bg-slate-50"}`}>
      <span aria-hidden="true">{item.icon}</span><span>{item.title}</span>
    </button>)}
  </nav>;
}

/** A compact map, not a mandatory wizard. Original step indexes/bookmarks and
 * callbacks are retained; the parent may refuse navigation for unsaved work. */
export function OrthoWorkupNavigation({ step, legacy, onSelect, onClose }: {
  step: number; legacy: boolean; onSelect(step: number): void; onClose(): void;
}) {
  const selected = Number.isInteger(step) ? ORTHO_WORKUP_STEPS[step] : undefined;
  const group = ORTHO_WORKUP_GROUPS.find(item => item.steps.some(index => index === step));
  if (!selected || !group) return null;
  return <section aria-label="مساحة عمل ملف التقويم" data-testid="ortho-workup-navigation" className="m-3 min-w-0 rounded-xl border border-sky-200 bg-white sm:m-4">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-sky-100 px-3 py-2">
      <div><h3 className="text-sm font-bold text-sky-900">{legacy ? "متابعة ملف التقويم" : "ملف التقويم"}</h3>
        <p className="text-xs text-slate-600">{group.title} <span aria-hidden="true"> / </span> {selected.title}</p></div>
      <button type="button" className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold" onClick={onClose}>العودة لأقسام الحالة</button>
    </div>
    <nav aria-label="مجموعات ملف التقويم" className="flex gap-1 overflow-x-auto border-b border-sky-100 p-2">
      {ORTHO_WORKUP_GROUPS.map((item, index) => <button key={item.id} type="button" aria-pressed={item.id === group.id}
        className={`min-h-11 min-w-28 flex-1 rounded-lg border px-2 py-2 text-xs font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${item.id === group.id ? "border-sky-600 bg-sky-50 text-sky-900" : "border-transparent bg-white text-slate-600 hover:bg-slate-50"}`}
        onClick={() => onSelect(item.id === group.id ? step : item.entry)}>
        <span aria-hidden="true" className="ml-1 inline-block rounded-full bg-slate-100 px-1.5">{index + 1}</span>{item.title}
      </button>)}
    </nav>
    {group.steps.length > 1 && <nav aria-label={`أقسام ${group.title}`} className="flex flex-wrap gap-1 px-3 pt-2">
      {group.steps.map(index => <button key={ORTHO_WORKUP_STEPS[index].id} type="button" aria-current={index === step ? "page" : undefined}
        className={`min-h-11 rounded-lg border px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${index === step ? "border-sky-300 bg-sky-50 font-bold text-sky-900" : "border-transparent text-slate-700 hover:bg-slate-50"}`}
        onClick={() => onSelect(index)}>{ORTHO_WORKUP_STEPS[index].title}</button>)}
    </nav>}
    <div className="px-3 py-2">
      <p className="text-sm font-bold text-slate-800" role="status">{selected.title}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">{selected.hint}</p>
      <p className="mt-1 text-[11px] text-slate-500">انتقال مباشر؛ لا يلزم إكمال الأقسام بالترتيب. التنقل لا يحفظ ولا يعتمد البيانات.</p>
    </div>
  </section>;
}
