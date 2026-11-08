import { EI_KIM_1996_CODE, MEASUREMENTS } from "@/lib/ceph";

/** Published population statistics stay separate from patient-specific grading. */
export function CephScientificContext() {
  const definition = MEASUREMENTS.find((row) => row.code === EI_KIM_1996_CODE);
  const reference = definition?.populationReference;
  if (!definition || !reference) return null;
  return <div data-testid="ceph-scientific-context" className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
    <p><b>EI_KIM_1996: مؤشر وصفي محسوب، وليس قرارًا علاجيًا.</b> لا يُصنَّف طبيعيًا أو غير طبيعي، ولا يوصي بالقلع أو عدمه.</p>
    <p>إحصاءات العينة المنشورة فقط: <span dir="ltr">{reference.mean} ± {reference.sd}</span>، عددها {reference.sampleSize} من الأطفال الكوريين ذوي الإطباق الطبيعي المختار؛ الأعمار <span dir="ltr">{reference.ageMin}–{reference.ageMax}</span> سنة (المتوسط {reference.meanAge})، {reference.boys} ولدًا و{reference.girls} بنتًا. هذه عينة محددة، وليست معيارًا شخصيًا لهذا المريض.</p>
    <p>المصدر: <a href={definition.sourceUrl} target="_blank" rel="noreferrer" className="underline">{definition.source}</a> · إصدار الحساب: <span dir="ltr">{definition.calculationVersion}</span>.</p>
    <p>{definition.note}</p>
  </div>;
}
