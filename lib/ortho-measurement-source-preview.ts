import { applyMeasurementSessionV2, type MeasurementEditorDraftV2, type MeasurementValueDraftV2 } from "./ortho-assessment-measurement-editor-v2";

const fields = [
  ["dateState", "حالة تاريخ الفحص"], ["date", "تاريخ الفحص"], ["dateReason", "سبب غياب التاريخ"],
  ["method", "طريقة القياس"], ["methodDescription", "وصف الطريقة"],
  ["performer", "حالة منفذ الفحص"], ["performerAttribution", "إسناد منفذ الفحص"], ["sources", "المصادر وإصداراتها"],
] as const;
type Field = (typeof fields)[number][0];
const labels: Partial<Record<Field, Record<string, string>>> = {
  dateState: { "": "غير مسجل", known: "معلوم", unknown: "غير معلوم" },
  method: { "": "غير مسجل", direct_examination: "فحص مباشر", manual_record_measurement: "قياس سجل", external_report: "تقرير خارجي", legacy_revision: "نسخة تاريخية" },
  performer: { unknown: "غير معلوم", documented: "إسناد موثق" },
};
const sourceNames = { document: "مستند", ceph_study: "دراسة سيفالومتري", patient_history: "تاريخ المريض", clinical_visit: "زيارة سريرية", assessment_revision: "مراجعة تقييم" };
function display(value: MeasurementValueDraftV2, field: Field): string {
  if (field === "sources") return value.sources.length
    ? value.sources.map(source => `${sourceNames[source.kind]} #${source.id} · ${source.version}`).join("\n") : "لا مصادر مرتبطة";
  return labels[field]?.[value[field]] ?? (value[field] || "غير مسجل");
}
/** Preview the existing mutation's exact result; never update a draft or infer
 * that two measurements share a protocol merely because they share a session. */
export function measurementSourcePreview(draft: MeasurementEditorDraftV2, sourceId: string, targets: readonly string[]) {
  const applied = applyMeasurementSessionV2(draft, sourceId, targets, true);
  if (!applied.ok) return applied;
  return { ok: true as const, targets: targets.map(id => ({
    id, label: draft.payload.observations.observations.find(row => row.id === id)?.label ?? id,
    changes: fields.flatMap(([field, label]) => JSON.stringify(draft.values[id][field]) === JSON.stringify(applied.draft.values[id][field]) ? []
      : [{ field, label, before: display(draft.values[id], field), after: display(applied.draft.values[id], field) }]),
  })) };
}
