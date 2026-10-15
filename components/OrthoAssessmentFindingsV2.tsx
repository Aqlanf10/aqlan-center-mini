"use client";
import { useId, useState } from "react";
import { CLINICAL_FIELDS_V2, CLINICAL_CHOICES_V2, clinicalFieldIdV2, addClinicalFieldV2, blankClinicalObservationV2 } from "@/lib/ortho-assessment-findings-v2";
import { sameAssessmentStructure } from "@/lib/ortho-assessment-read-v2";
import { applyMeasurementSessionV2, type MeasurementEditorDraftV2, type MeasurementValueDraftV2 } from "@/lib/ortho-assessment-measurement-editor-v2";
import type { MeasurementEditorOwnerV2, MeasurementSourceChoiceV2 } from "./OrthoAssessmentMeasurementsV2";
const control = "min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm disabled:opacity-40";
const sourceKey = (s: { kind: string; id: number; version: string }) => JSON.stringify([s.kind, s.id, s.version]);
const labels: Record<MeasurementValueDraftV2["state"], string> = { not_recorded: "غير مسجل", recorded: "موثق", measured: "مقاس",
  unknown: "غير معلوم", not_measured: "لم يُقَس / لم يُقيّم", unavailable: "غير متاح", not_applicable: "لا ينطبق", tooth_absent: "سن مفقود", not_erupted: "لم يبزغ" };
/** Named history/exam observations share the same payload, raw values, metadata and save command as measurements. */
export function OrthoAssessmentFindingsV2({ draft, owner, sources, onChange, focusGroup }: {
  draft: MeasurementEditorDraftV2; owner?: MeasurementEditorOwnerV2; sources: readonly MeasurementSourceChoiceV2[];
  onChange(draft: MeasurementEditorDraftV2): void; focusGroup?: "history" | "facial" | "intraoral";
}) {
  const instance = useId(), [metadataId, setMetadataId] = useState<string | null>(null), [targets, setTargets] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const editable = !!owner?.active() && owner.editable();
  const publish = (next: MeasurementEditorDraftV2) => { if (owner?.active() && owner.editable()) onChange(next); };
  const patch = (id: string, value: Partial<MeasurementValueDraftV2>) => {
    if (draft.values[id]) publish({ ...draft, values: { ...draft.values, [id]: { ...draft.values[id], ...value } } });
  };
  return <section dir="rtl" aria-label="مقابلة الحالة وفحصها" className="space-y-3">
    <p className="text-xs">تاريخ بداية هذه الحالة ونتائج الفحص. التاريخ الطبي الحالي يبقى في ملف المريض؛ اربط نسخته المحددة عند الاستناد إليه بدل نسخ الاستمارة كاملة.</p>
    {(["history", "facial", "intraoral"] as const).map(group => <details key={group} hidden={focusGroup !== undefined && focusGroup !== group} open={focusGroup === group || focusGroup === undefined && group === "history"} className="rounded-xl border p-3">
      <summary className="min-h-11 cursor-pointer font-bold">{{ history: "١. مقابلة بداية الحالة", facial: "٢. فحص الوجه", intraoral: "٣. فحص الفم والإطباق" }[group]}</summary>
      <div className="grid gap-3 md:grid-cols-2">{CLINICAL_FIELDS_V2.filter(field => field[2] === group).map(([field, title]) => {
        const id = clinicalFieldIdV2(field), row = draft.payload.observations.observations.find(o => o.id === id), value = draft.values[id];
        const shape = blankClinicalObservationV2(field), numeric = shape.unit === "mm";
        if (!row) return <div className="rounded-lg border p-2" key={field}><p>{title}: لا يوجد حقل مرتبط بعد.</p>
          <button type="button" className={control} disabled={!editable} onClick={() => { const next = addClinicalFieldV2(draft, field); if (next) publish(next); }}>إضافة حقل غير مسجل: {title}</button></div>;
        if (!value || row.definition !== shape.definition || row.unit !== shape.unit || !sameAssessmentStructure(row.target, shape.target))
          return <p key={field} role="alert">هوية حقل {title} تحتاج مراجعة؛ لم يُستبدل الحقل المحفوظ.</p>;
        const states = ["not_recorded", numeric ? "measured" : "recorded", "unknown", "not_measured", "unavailable", "not_applicable"] as MeasurementValueDraftV2["state"][];
        return <fieldset key={field} className="min-w-0 space-y-2 rounded-lg border p-2"><legend className="text-sm font-bold">{title}{numeric ? " (mm)" : ""}</legend>
          <label className="block text-xs">حالة {title}<select className={control} disabled={!editable} value={value.state}
            onChange={event => patch(id, { state: event.target.value as MeasurementValueDraftV2["state"] })}>
            {states.map(state => <option key={state} value={state}>{labels[state]}</option>)}</select></label>
          {value.state === "recorded" && !numeric && <><label className="block text-xs">{title} — اختيار قابل للبحث أو نص حر
            <input className={control} list={`${instance}-${field}`} maxLength={4000} value={value.text} disabled={!editable}
              onChange={event => patch(id, { text: event.target.value })} /></label><datalist id={`${instance}-${field}`}>
              {(CLINICAL_CHOICES_V2[field] ?? []).map(option => <option value={option} key={option} />)}</datalist></>}
          {value.state === "measured" && numeric && <label className="block text-xs">{title} بالملليمتر<input aria-label={`${title} بالملليمتر`} className={control} dir="ltr" inputMode="decimal"
            value={value.numberText} disabled={!editable} onChange={event => patch(id, { numberText: event.target.value })} />
            <span>الصفر أو القيمة السالبة قياس صريح؛ الفراغ لا يُحسب.</span></label>}
          {!["not_recorded", "measured", "recorded"].includes(value.state) && <label className="block text-xs">سبب حالة {title}
            <input className={control} value={value.reason} disabled={!editable} onChange={event => patch(id, { reason: event.target.value })} /></label>}
          {value.state !== "not_recorded" && <>
            {!value.copiedFrom && <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" disabled={!editable}
              checked={targets.includes(id)} onChange={() => { if (owner?.active() && owner.editable()) setTargets(previous => previous.includes(id) ? previous.filter(one => one !== id) : [...previous, id]); }} />
              اختيار لتطبيق مصدر جلسة الفحص</label>}
            <button type="button" className={control} onClick={() => { if (!owner || owner.active()) setMetadataId(metadataId === id ? null : id); }}>مصدر وتاريخ {title}</button>
          </>}
          {metadataId === id && <div className="space-y-2 rounded-lg bg-slate-50 p-2" aria-label={`مصدر ${title}`}>
            <p className="text-xs">المنفذ الموثق مستقل عن مسجّل المراجعة. لا يُفترض تاريخ اليوم أو اسم الطبيب.</p>
            <label className="block text-xs">حالة تاريخ {title}<select className={control} value={value.dateState} disabled={!editable}
              onChange={event => patch(id, { dateState: event.target.value as MeasurementValueDraftV2["dateState"] })}>
              <option value="">اختر حالة التاريخ…</option><option value="known">معلوم</option><option value="unknown">غير معلوم</option></select></label>
            {value.dateState === "known" ? <label className="block text-xs">تاريخ {title}<input className={control} type="date" value={value.date} disabled={!editable}
              onChange={event => patch(id, { date: event.target.value })} /></label> : value.dateState === "unknown" ? <label className="block text-xs">سبب غياب تاريخ {title}
              <input className={control} value={value.dateReason} disabled={!editable} onChange={event => patch(id, { dateReason: event.target.value })} /></label> : null}
            <label className="block text-xs">طريقة توثيق {title}<select className={control} value={value.method} disabled={!editable}
              onChange={event => patch(id, { method: event.target.value as MeasurementValueDraftV2["method"] })}>
              <option value="">اختر الطريقة…</option><option value="direct_examination">مقابلة / فحص مباشر</option><option value="manual_record_measurement">قياس سجل</option>
              <option value="external_report">تقرير خارجي</option>{value.copiedFrom && <option value="legacy_revision">نسخة تاريخية</option>}</select></label>
            <label className="block text-xs">وصف طريقة توثيق {title}<input className={control} value={value.methodDescription} disabled={!editable}
              onChange={event => patch(id, { methodDescription: event.target.value })} /></label>
            <label className="block text-xs">من أجرى فحص {title}<select className={control} value={value.performer} disabled={!editable}
              onChange={event => patch(id, { performer: event.target.value as MeasurementValueDraftV2["performer"] })}>
              <option value="unknown">غير معلوم</option><option value="documented">إسناد موثق</option></select></label>
            {value.performer === "documented" && <label className="block text-xs">إسناد منفذ {title}<input className={control} value={value.performerAttribution} disabled={!editable}
              onChange={event => patch(id, { performerAttribution: event.target.value })} /></label>}
            <fieldset><legend className="text-xs">المصادر المصرح بها وإصداراتها</legend>{sources.map(source => <label className="flex min-h-11 items-center gap-2 break-all text-xs" key={sourceKey(source)}>
              <input type="checkbox" disabled={!editable} checked={value.sources.some(s => sourceKey(s) === sourceKey(source))} onChange={() => patch(id, {
                sources: value.sources.some(s => sourceKey(s) === sourceKey(source)) ? value.sources.filter(s => sourceKey(s) !== sourceKey(source))
                  : [...value.sources, { kind: source.kind, id: source.id, version: source.version }] })} />{source.label} · {source.version}</label>)}</fieldset>
            {value.sources.filter(s => !sources.some(choice => sourceKey(choice) === sourceKey(s))).map(s => <p key={sourceKey(s)} className="break-all text-xs">مرجع محفوظ يحتاج تحققًا: {s.kind} #{s.id} · {s.version}</p>)}
            {value.copiedFrom && <p className="break-all text-xs">نسخة أصلية #{value.copiedFrom.revisionId} · {value.copiedFrom.contentHash}</p>}
            <button type="button" className={control} disabled={!editable || !targets.length} onClick={() => {
              if (!owner?.active() || !owner.editable() || !window.confirm(`هل تعود الحقول المختارة (${targets.length}) إلى جلسة الفحص نفسها؟ سيطبق المصدر والتاريخ والمنفذ المحدد عليها فقط.`)) return;
              if (!owner.active() || !owner.editable()) return;
              const applied = applyMeasurementSessionV2(draft, id, targets, true);
              if (!applied.ok) { setMessage("أكمل بيانات الحقل المصدر واختر حقولًا موثقة غير منقولة من سجل تاريخي."); return; }
              publish(applied.draft); setTargets([]); setMessage("طُبّق المصدر على الحقول المختارة في المسودة. راجع كل شاهد قبل الحفظ.");
            }}>تطبيق مصدر الجلسة على {targets.length} حقول مختارة</button>
          </div>}
        </fieldset>;
      })}</div>
    </details>)}
    {message && <p role="status">{message}</p>}
  </section>;
}
