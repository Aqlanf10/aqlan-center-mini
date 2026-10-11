"use client";
import { useState } from "react";
import { UPPER_MEASUREMENT_TEETH, LOWER_MEASUREMENT_TEETH, measurementReadinessV2, toggleMeasurementAnalysisV2,
  changeMeasurementDecimalV2, applyMeasurementSessionV2, addMeasurementSetV2, linkMeasurementInputV2, matchesMeasurementInputV2,
  type MeasurementEditorDraftV2, type MeasurementValueDraftV2, type MissingEditorInputV2 } from "@/lib/ortho-assessment-measurement-editor-v2";
import type { AssessmentSourceV2 } from "@/lib/ortho-assessment-v2";
import type { DraftAnalysisSelectionV2 } from "@/lib/ortho-assessment-measurement-set-v2";
export interface MeasurementEditorOwnerV2 { active(): boolean; editable(): boolean }
export interface MeasurementSourceChoiceV2 extends AssessmentSourceV2 { label: string }
const control = "min-h-11 min-w-11 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm disabled:opacity-40";
const keyOf = (s: AssessmentSourceV2) => `${s.kind}:${s.id}:${s.version}`;
const states: Record<MeasurementValueDraftV2["state"], string> = { not_recorded: "غير مسجل", measured: "مقاس", recorded: "موثق", unknown: "غير معلوم", not_measured: "لم يُقَس", unavailable: "غير متاح", not_applicable: "لا ينطبق", tooth_absent: "السن مفقود", not_erupted: "لم يبزغ" };
export function OrthoAssessmentMeasurementsV2({ draft, onChange, owner, sources }: {
  draft: MeasurementEditorDraftV2; onChange(draft: MeasurementEditorDraftV2): void;
  owner?: MeasurementEditorOwnerV2; sources: readonly MeasurementSourceChoiceV2[];
}) {
  const [selected, setSelected] = useState(draft.payload.measurementSets[0]?.id ?? "");
  const [metadataId, setMetadataId] = useState<string | null>(null), [targets, setTargets] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const editable = !!owner?.active() && owner.editable(), rows = draft.payload.observations.observations;
  const set = draft.payload.measurementSets.find(s => s.id === selected), metadata = metadataId ? draft.values[metadataId] : null;
  const publish = (next: MeasurementEditorDraftV2) => { if (owner?.active() && owner.editable()) onChange(next); };
  const patch = (id: string, change: Partial<MeasurementValueDraftV2>) => {
    if (draft.values[id]) publish({ ...draft, values: { ...draft.values, [id]: { ...draft.values[id], ...change } } });
  };
  function missing(target: MissingEditorInputV2, title: string) {
    const candidates = rows.filter(row => matchesMeasurementInputV2(row, target));
    const link = (id?: string) => { if (set) { const next = linkMeasurementInputV2(draft, set.id, target, id); if (next) publish(next); } };
    return <div className="rounded-lg border border-dashed p-2" key={title}><p>{title}: لا قياس مرتبط</p>
      {!!candidates.length && <label className="block text-xs">ربط قياس محفوظ: {title}<select className={control} value="" disabled={!editable || !set}
        onChange={event => { if (event.target.value) link(event.target.value); }}><option value="">اختر القياس صراحة…</option>
        {candidates.map(row => <option key={row.id} value={row.id}>{row.label} · {row.id}</option>)}</select></label>}
      <button type="button" className={control} disabled={!editable || !set} onClick={() => link()}>إضافة قياس غير مسجل: {title}</button></div>;
  }
  function valueInput(id: string, title: string, tooth = false, dentition = false) {
    const value = draft.values[id]; if (!value) return <p role="alert" key={id}>مرجع قياس غير قابل للقراءة: {title}</p>;
    const allowed: MeasurementValueDraftV2["state"][] = ["not_recorded", dentition ? "recorded" : "measured", "unknown", "not_measured", "unavailable", "not_applicable", ...(tooth ? ["tooth_absent", "not_erupted"] as const : [])];
    return <div key={id} data-testid={`measurement-${id}`} className="min-w-0 space-y-2 rounded-lg border p-2">
      <p className="font-bold">{title}{dentition ? "" : " · mm"}</p>
      <label className="block text-xs">حالة {title}<select className={control} disabled={!editable} value={value.state}
        onChange={event => patch(id, { state: event.target.value as MeasurementValueDraftV2["state"] })}>{allowed.map(state => <option key={state} value={state}>{states[state]}</option>)}</select></label>
      {value.state === "measured" && <label className="block text-xs">قيمة {title} (mm)<input className={control} dir="ltr" inputMode="decimal" maxLength={80}
        disabled={!editable} value={value.numberText} onChange={event => patch(id, { numberText: event.target.value })} /></label>}
      {dentition && value.state === "recorded" && <label className="block text-xs">نوع الأسنان<select className={control} value={value.text} disabled={!editable}
        onChange={event => patch(id, { text: event.target.value })}><option value="">اختر النوع الموثق…</option><option value="primary">لبنية</option><option value="mixed">مختلطة</option><option value="permanent">دائمة</option></select></label>}
      {!["not_recorded", "measured", "recorded"].includes(value.state) && <label className="block text-xs">سبب {title}<input className={control} maxLength={500}
        value={value.reason} disabled={!editable} onChange={event => patch(id, { reason: event.target.value })} /></label>}
      {value.state !== "not_recorded" && <>
        {!value.copiedFrom && <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" disabled={!editable} checked={targets.includes(id)}
          onChange={() => { if (owner?.active() && owner.editable()) setTargets(current => current.includes(id) ? current.filter(one => one !== id) : [...current, id]); }} />اختيار {title} لجلسة القياس</label>}
        <button type="button" className={control} onClick={() => { if (!owner || owner.active()) setMetadataId(id); }}>المصدر والتاريخ: {title}</button>
      </>}
    </div>;
  }
  const selections: { title: string; selection: DraftAnalysisSelectionV2 }[] = set ? [
    { title: "مساحة الفك العلوي", selection: { state: "draft", id: "", measurementSetId: set.id, method: "arch_space", arch: "upper" } },
    { title: "مساحة الفك السفلي", selection: { state: "draft", id: "", measurementSetId: set.id, method: "arch_space", arch: "lower" } },
    { title: "Bolton أمامي", selection: { state: "draft", id: "", measurementSetId: set.id, method: "bolton_anterior" } },
    { title: "Bolton عام", selection: { state: "draft", id: "", measurementSetId: set.id, method: "bolton_overall" } },
  ] : [];
  const assigned = new Set(draft.payload.analyses.map(a => a.id));
  for (const option of selections) {
    const existing = draft.payload.analyses.find(a => a.measurementSetId === option.selection.measurementSetId && a.method === option.selection.method
      && (a.method !== "arch_space" || option.selection.method === "arch_space" && a.arch === option.selection.arch));
    if (existing) option.selection = existing;
    else { let suffix = 1; while (assigned.has(`analysis_${suffix}`)) suffix++; option.selection = { ...option.selection, id: `analysis_${suffix}` }; assigned.add(option.selection.id); }
  }
  const readiness = measurementReadinessV2(draft);
  return <section dir="rtl" aria-label="القياسات المشتركة وتحليلات المسودة" className="space-y-3">
    <p className="text-sm">أدخل كل قياس مرة واحدة. تشترك التحليلات في مراجع المجموعة؛ الحساب ليس تشخيصًا أو اعتمادًا سريريًا.</p>
    {!editable && <p role="status">القياسات للقراءة فقط في السياق الحالي.</p>}
    <div className="grid gap-2 sm:grid-cols-2"><label>مجموعة القياسات<select className={control} value={selected} onChange={event => {
      if (!owner || owner.active()) { setSelected(event.target.value); setMetadataId(null); }
    }}>{draft.payload.measurementSets.map(s => <option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
      <label>الفاصل العشري<select className={control} disabled={!editable} value={draft.decimal} onChange={event => publish(changeMeasurementDecimalV2(draft, event.target.value as MeasurementEditorDraftV2["decimal"]))}>
        <option value=".">نقطة .</option><option value="٫">فاصل عربي ٫</option><option value=",">فاصلة ,</option></select></label></div>
    <button type="button" className={control} disabled={!editable || draft.payload.measurementSets.length >= 12} onClick={() => {
      const next = addMeasurementSetV2(draft); if (next && owner?.active() && owner.editable()) { publish(next); setSelected(next.payload.measurementSets.at(-1)!.id); setMetadataId(null); }
    }}>إضافة مجموعة قياسات غير معبأة</button>
    {draft.payload.observations.dentitionObservationId ? valueInput(draft.payload.observations.dentitionObservationId, "الأسنان", false, true) : missing({ kind: "dentition" }, "نوع الأسنان")}
    {!set ? <p role="alert">اختر مجموعة قياسات صحيحة.</p> : (["upper", "lower"] as const).map(arch => <details key={arch} open={arch === "upper"} className="rounded-xl border p-3">
      <summary className="min-h-11 cursor-pointer font-bold">{arch === "upper" ? "قياسات الفك العلوي" : "قياسات الفك السفلي"}</summary>
      <div className="grid grid-cols-2 gap-2">{(arch === "upper" ? UPPER_MEASUREMENT_TEETH : LOWER_MEASUREMENT_TEETH).map(tooth => {
        const row = rows.find(o => set.toothWidthObservationIds.includes(o.id) && o.target.kind === "tooth" && o.target.tooth === tooth);
        return row ? valueInput(row.id, `السن ${tooth}`, true) : missing({ kind: "tooth", tooth }, `السن ${tooth}`);
      })}</div>
      {(() => { const id = arch === "upper" ? set.upperAvailableObservationId : set.lowerAvailableObservationId;
        return id ? valueInput(id, arch === "upper" ? "المساحة المتاحة العلوية" : "المساحة المتاحة السفلية") : missing({ kind: "available", arch }, `المساحة ${arch}`); })()}
    </details>)}
    {metadata && metadataId && <section aria-label="مصدر القياس وتاريخه" className="space-y-2 rounded-xl border bg-slate-50 p-3">
      <h4 className="font-bold">مصدر {rows.find(o => o.id === metadataId)?.label} وتاريخه</h4>
      <p className="text-xs">لا يُفترض تاريخ اليوم أو اسم المسجّل كمنفذ للفحص.</p>
      <label>حالة تاريخ الفحص<select className={control} disabled={!editable} value={metadata.dateState} onChange={e => patch(metadataId, { dateState: e.target.value as MeasurementValueDraftV2["dateState"] })}>
        <option value="">اختر الحالة…</option><option value="known">معلوم</option><option value="unknown">غير معلوم</option></select></label>
      {metadata.dateState === "known" ? <label>تاريخ الفحص المعلوم<input type="date" className={control} value={metadata.date} disabled={!editable} onChange={e => patch(metadataId, { date: e.target.value })} /></label>
        : metadata.dateState === "unknown" ? <label>سبب غياب تاريخ الفحص<input className={control} value={metadata.dateReason} disabled={!editable} onChange={e => patch(metadataId, { dateReason: e.target.value })} /></label> : null}
      <label>طريقة القياس<select className={control} value={metadata.method} disabled={!editable} onChange={e => patch(metadataId, { method: e.target.value as MeasurementValueDraftV2["method"] })}>
        <option value="">اختر الطريقة…</option><option value="direct_examination">فحص مباشر</option><option value="manual_record_measurement">قياس سجل</option><option value="external_report">تقرير خارجي</option>
        {metadata.copiedFrom && <option value="legacy_revision">نسخة تاريخية</option>}</select></label>
      <label>وصف طريقة القياس<input className={control} value={metadata.methodDescription} disabled={!editable} onChange={e => patch(metadataId, { methodDescription: e.target.value })} /></label>
      <label>حالة منفذ الفحص<select className={control} value={metadata.performer} disabled={!editable} onChange={e => patch(metadataId, { performer: e.target.value as MeasurementValueDraftV2["performer"] })}>
        <option value="unknown">غير معلوم</option><option value="documented">إسناد موثق</option></select></label>
      {metadata.performer === "documented" && <label>إسناد منفذ الفحص<input className={control} value={metadata.performerAttribution} disabled={!editable} onChange={e => patch(metadataId, { performerAttribution: e.target.value })} /></label>}
      <fieldset><legend>المصادر المصرح بها وإصداراتها</legend>{sources.map(s => <label className="flex min-h-11 items-center gap-2 break-all text-xs" key={keyOf(s)}>
        <input type="checkbox" disabled={!editable} checked={metadata.sources.some(o => keyOf(o) === keyOf(s))} onChange={() => patch(metadataId, {
          sources: metadata.sources.some(o => keyOf(o) === keyOf(s)) ? metadata.sources.filter(o => keyOf(o) !== keyOf(s)) : [...metadata.sources, { kind: s.kind, id: s.id, version: s.version }] })} />{s.label} · {s.version}</label>)}</fieldset>
      {metadata.sources.filter(s => !sources.some(o => keyOf(o) === keyOf(s))).map(s => <p className="break-all text-xs" key={keyOf(s)}>مرجع محفوظ يحتاج تحققًا: {s.kind} #{s.id} · {s.version}</p>)}
      {metadata.copiedFrom && <p className="break-all text-xs">نسخة أصلية #{metadata.copiedFrom.revisionId} · {metadata.copiedFrom.contentHash}</p>}
      <button type="button" className={control} disabled={!editable || !targets.length} onClick={() => {
        if (!owner?.active() || !owner.editable() || !window.confirm(`هل تخص المدخلات المختارة (${targets.length}) جلسة القياس نفسها؟ سيطبق المصدر والتاريخ والمنفذ عليها فقط.`)) return;
        if (!owner.active() || !owner.editable()) return;
        const applied = applyMeasurementSessionV2(draft, metadataId, targets, true);
        if (!applied.ok) { setMessage("أكمل المصدر واختر قياسات موثقة غير منقولة من سجل تاريخي."); return; }
        publish(applied.draft); setTargets([]); setMessage("طُبّق المصدر على المدخلات المختارة. راجع شاهد كل قيمة قبل الحفظ.");
      }}>تطبيق مصدر الجلسة على {targets.length} مدخلات مختارة</button>
      <button type="button" className={control} onClick={() => { if (!owner || owner.active()) setMetadataId(null); }}>إغلاق تفاصيل المصدر</button>
      {message && <p role="status">{message}</p>}
    </section>}
    <fieldset><legend className="font-bold">التحليلات من القياسات نفسها</legend>{selections.map(({ title, selection }) => <label key={selection.id} className="flex min-h-11 items-center gap-2">
      <input type="checkbox" disabled={!editable} checked={draft.payload.analyses.some(a => a.id === selection.id)} onChange={() => publish(toggleMeasurementAnalysisV2(draft, selection))} />{title}</label>)}</fieldset>
    {!!readiness.errors.length && <ul role="status" className="text-xs text-amber-900">{readiness.errors.map((e, index) => <li key={index}>{rows.find(o => o.id === e.observationId)?.label ?? "بنية المجموعة"}: مدخل أو مصدر غير مكتمل ({e.code})</li>)}</ul>}
    {readiness.analyses.map(({ selection, readiness: checked }) => <div key={selection.id} data-testid={`analysis-${selection.id}`} className="space-y-1 rounded-lg border p-3">
      <p className="font-bold">{selection.method}{selection.method === "arch_space" ? ` · ${selection.arch}` : ""}</p>
      {!checked.ok ? <p role="alert">تعذّر التحقق من مراجع التحليل: {checked.code}</p> : checked.value.state === "incomplete" ? <ul>{checked.value.missing.map((m, i) => <li key={i}>
        {m.kind === "tooth_width" ? `قياس السن ${m.tooth} غير مكتمل` : m.kind === "available_space" ? `المساحة المتاحة ${m.arch} غير مكتملة` : "نوع الأسنان غير موثق"}</li>)}</ul>
        : checked.value.state === "unsupported_dentition" ? <p>لا تطبق طرق الأسنان الدائمة على الأسنان اللبنية أو المختلطة.</p>
          : checked.value.state === "inapplicable" ? <p>التحليل غير منطبق: السن {checked.value.tooth} {checked.value.reason === "tooth_absent" ? "مفقود" : "لم يبزغ"}؛ لا يُستبدل بصفر.</p>
            : <><p className="text-amber-900">حساب مسودة غير معتمد سريريًا؛ لا يوصي بقلع أو برد.</p>
              {checked.value.witness.result.state === "unavailable" ? <p>الحساب غير متاح: {checked.value.witness.result.reason}</p>
                : checked.value.witness.result.method === "arch_space" ? <p>المتاح {checked.value.witness.result.availableMm} mm − المطلوب {checked.value.witness.result.requiredMm} mm = {checked.value.witness.result.availableMinusRequiredMm} mm</p>
                  : <><p>مجموع العلوي {checked.value.witness.result.upperMm} mm · السفلي {checked.value.witness.result.lowerMm} mm · النسبة {checked.value.witness.result.ratioPercent}%</p>
                    <p>فرق السفلي بمرجع علوي: {checked.value.witness.result.upperReference.lowerMinusExpectedMm} mm · فرق العلوي بمرجع سفلي: {checked.value.witness.result.lowerReference.upperMinusExpectedMm} mm</p></>}
              <p className="break-all text-xs">{checked.value.witness.formula.engineVersion} · {checked.value.witness.formula.formulaVersion}</p>
              {checked.value.witness.reference && <p className="break-all text-xs">المرجع {checked.value.witness.reference.id} · النسخة {checked.value.witness.reference.version} · {checked.value.witness.reference.percent}% · {checked.value.witness.reference.source} · {checked.value.witness.reference.sourceVerification} · {checked.value.witness.reference.review}</p>}
            </>}
    </div>)}
  </section>;
}
