"use client";
import { CLINICAL_FIELDS_V2, clinicalFieldIdV2 } from "@/lib/ortho-assessment-findings-v2";
import { measurementReadinessV2, type MeasurementEditorDraftV2 } from "@/lib/ortho-assessment-measurement-editor-v2";
import { observationInputHintV2 } from "@/lib/ortho-assessment-input-hints-v2";

/** Counts describe recorded evidence, never clinical normality or case completion. */
export function OrthoAssessmentProgressV2({ draft, savedVersion }: { draft: MeasurementEditorDraftV2; savedVersion?: number }) {
  const readiness = measurementReadinessV2(draft);
  const observations = draft.payload.observations.observations;
  const namedIds = new Set(CLINICAL_FIELDS_V2.map(([field]) => clinicalFieldIdV2(field)));
  const groups = (["history", "facial", "intraoral", "measurements"] as const).map(group => {
    const ids = group === "measurements" ? observations.filter(row => !namedIds.has(row.id)).map(row => row.id)
      : CLINICAL_FIELDS_V2.filter(row => row[2] === group).map(([field]) => clinicalFieldIdV2(field));
    const values = ids.map(id => draft.values[id]);
    return { group, documented: values.filter(row => row && ["recorded", "measured"].includes(row.state)).length,
      other: values.filter(row => row && !["recorded", "measured", "not_recorded"].includes(row.state)).length,
      empty: values.filter(row => !row || row.state === "not_recorded").length,
      errors: readiness.errors.filter(error => ids.includes(error.observationId)).length };
  });
  return <section aria-label="حالة توثيق التقييم" className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
    <p className="text-sm font-bold">{savedVersion === undefined ? "مسودة تقييم غير محفوظة" : `ملخص التقييم المحفوظ — نسخة ${savedVersion}`}</p>
    <p className="text-xs">العدّ يوضح وجود التوثيق، ولا يعني اكتمال الفحص أو أن النتيجة طبيعية. غير المعلوم أو غير المتاح يبقى منفصلاً.</p>
    <ul className="grid gap-2 text-xs sm:grid-cols-2">{groups.map(row => <li key={row.group} className="rounded border bg-white p-2">
      <strong>{{ history: "المقابلة والتاريخ", facial: "فحص الوجه", intraoral: "فحص الفم والإطباق", measurements: "القياسات" }[row.group]}</strong>
      <p>{row.documented} قيم مدونة · {row.other} حالات أخرى موثقة · {row.empty} غير مسجل</p>
      {row.errors > 0 && <p className="text-amber-800">{row.errors} مدخلات تحتاج استكمالاً قبل الحفظ</p>}
    </li>)}</ul>
    {!!readiness.errors.length && <div role="status" className="text-sm text-amber-900"><p className="font-bold">لا يمكن حفظ المدخلات التالية بعد:</p>
      <ul>{readiness.errors.map((error, index) => <li key={`${error.observationId}:${index}`}>
        {observations.find(row => row.id === error.observationId)?.label ?? "بنية التقييم"}: {observationInputHintV2(error.code)}
      </li>)}</ul>
    </div>}
  </section>;
}
