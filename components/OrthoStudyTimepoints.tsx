"use client";
import { useState } from "react";
import type { StudyDraftContent } from "@/lib/ortho-case-study";
import { STUDY_TIMEPOINTS, clearStudySourceTimepoint, isStudyTimepoint, readStudyTimepoints, setStudyTimepoint } from "@/lib/ortho-case-study-timepoints";
import { studySourceName, type StudyDisplayLocale } from "@/lib/ortho-case-presentation-i18n";
import type { OccurrenceEvidence } from "@/lib/ortho-case-occurrence";
const unknownOccurrence: OccurrenceEvidence = { occurredOn: null, dateProvenance: "unknown", sourceNote: "" };
const control = "min-h-11 rounded border px-3 py-2 disabled:opacity-50";
export function OrthoStudyTimepoints({ content, editable, onChange, locale = "ar" }: {
  content: StudyDraftContent; editable: boolean; onChange(content: StudyDraftContent): boolean; locale?: StudyDisplayLocale;
}) {
  const [error, setError] = useState<string | null>(null);
  const english = locale === "en";
  let points: ReturnType<typeof readStudyTimepoints>;
  try { points = readStudyTimepoints(content); }
  catch { return <p role="alert">{english ? "Saved timepoint assignments conflict. The study has not been changed." : "تعارض في ربط المراحل المحفوظة. لم تُغيّر الدراسة."}</p>; }
  const update = (compute: () => StudyDraftContent) => {
    if (!editable) return;
    try { if (onChange(compute())) setError(null); }
    catch { setError(english ? "Invalid timepoint, date, or conflicting source assignment. Previous values retained." : "مرحلة أو تاريخ غير صالح أو مرجع مرتبط بمرحلة أخرى. بقيت القيم السابقة."); }
  };
  return <section aria-label="T1–T4" className="space-y-3 rounded border p-3">
    <h3>{english ? "Saved timepoints T1–T4" : "المراحل الزمنية المحفوظة T1–T4"}</h3>
    <p className="text-sm">{english ? "Assign each selected record explicitly. Dates stay unknown unless entered. Stage order is not a measurement comparison or proof of clinical progress." : "اربط كل سجل مختار بمرحلته صراحة. يبقى التاريخ غير معروف حتى إدخاله. ترتيب المراحل لا يُعد مقارنة قياسات أو إثباتًا للتقدم السريري."}</p>
    {error && <p role="alert">{error}</p>}
    {content.sources.map(source => {
      const assigned = points.find(point => point.sources.some(item => item.key === source.key));
      return <label key={source.key} className="flex flex-wrap items-center gap-2"><span>{studySourceName(source.kind, locale)} #{source.id}</span>
        <select aria-label={`${source.key} timepoint`} className={control} disabled={!editable} value={assigned?.stage ?? ""}
          onChange={event => { const next = event.currentTarget.value; update(() => {
            const cleared = clearStudySourceTimepoint(content, source.key);
            if (!isStudyTimepoint(next)) return cleared;
            const prior = readStudyTimepoints(cleared).find(point => point.stage === next);
            return setStudyTimepoint(cleared, next, { occurrence: prior?.occurrence ?? unknownOccurrence, sourceKeys: [...(prior?.sources.map(item => item.key) ?? []), source.key] });
          }); }}><option value="">{english ? "Not assigned" : "غير مرتبط بمرحلة"}</option>{STUDY_TIMEPOINTS.map(stage => <option key={stage} value={stage}>{stage}</option>)}</select>
      </label>;
    })}
    {points.map(point => <fieldset key={point.stage} className="space-y-2 rounded border p-2"><legend>{point.stage}</legend>
      <label className="block">{english ? "Date from a historical source (optional)" : "تاريخ المرحلة وفق المصدر التاريخي (اختياري)"}
        <input aria-label={`${point.stage} date`} className={`${control} block`} type="date" disabled={!editable} value={point.occurrence.occurredOn ?? ""}
          onChange={event => { const date = event.currentTarget.value; update(() => setStudyTimepoint(content, point.stage, { sourceKeys: point.sources.map(source => source.key),
            occurrence: { ...point.occurrence, occurredOn: date || null, dateProvenance: date ? point.occurrence.dateProvenance === "unknown" ? "historical_source" : point.occurrence.dateProvenance : "unknown" } })); }} />
      </label>
      {point.occurrence.occurredOn && <label className="block">{english ? "Date evidence" : "نوع توثيق التاريخ"}<select aria-label={`${point.stage} date evidence`} className={control} disabled={!editable} value={point.occurrence.dateProvenance}
        onChange={event => { const value = event.currentTarget.value as OccurrenceEvidence["dateProvenance"]; update(() => setStudyTimepoint(content, point.stage, { sourceKeys: point.sources.map(source => source.key), occurrence: { ...point.occurrence, dateProvenance: value } })); }}>
        <option value="historical_source">{english ? "Historical source" : "مصدر تاريخي"}</option><option value="contemporaneous_record">{english ? "Contemporaneous record" : "سجل معاصر للحدث"}</option><option value="retrospective_record">{english ? "Retrospective report" : "توثيق بأثر رجعي"}</option>
      </select></label>}
      <label className="block">{english ? "Date source / uncertainty" : "مصدر التاريخ وحدود اليقين"}<input aria-label={`${point.stage} date source`} className={`${control} block w-full`} maxLength={1000} disabled={!editable} value={point.occurrence.sourceNote}
        onChange={event => { const sourceNote = event.currentTarget.value; update(() => setStudyTimepoint(content, point.stage, { sourceKeys: point.sources.map(source => source.key), occurrence: { ...point.occurrence, sourceNote } })); }} /></label>
    </fieldset>)}
  </section>;
}
