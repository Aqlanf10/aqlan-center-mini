"use client";
import { observationInputHintV2 } from "@/lib/ortho-assessment-input-hints-v2";
import { useState } from "react";
import { measurementSourcePreview } from "@/lib/ortho-measurement-source-preview";
import { UPPER_MEASUREMENT_TEETH, LOWER_MEASUREMENT_TEETH, measurementReadinessV2, toggleMeasurementAnalysisV2,
  changeMeasurementDecimalV2, applyMeasurementSessionV2, addMeasurementSetV2, linkMeasurementInputV2, matchesMeasurementInputV2,
  type MeasurementEditorDraftV2, type MeasurementValueDraftV2, type MissingEditorInputV2 } from "@/lib/ortho-assessment-measurement-editor-v2";
import type { AssessmentSourceV2 } from "@/lib/ortho-assessment-v2";
import type { DraftAnalysisSelectionV2 } from "@/lib/ortho-assessment-measurement-set-v2";
export interface MeasurementEditorOwnerV2 {
  /** Presentation follows this render's grant. Event callbacks still recheck the
   * committed owner/draft; a layout-effect ref from the prior render cannot
   * decide whether the new render's inputs are disabled. */
  readonly renderEditable: boolean;
  active(): boolean; editable(): boolean;
}
export interface MeasurementSourceChoiceV2 extends AssessmentSourceV2 { label: string }
const control = "min-h-11 min-w-11 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm disabled:opacity-40";
const keyOf = (s: AssessmentSourceV2) => `${s.kind}:${s.id}:${s.version}`;
// Presentation-only rounding; the stored calculation retains full precision.
const mm = (value: number) => <bdi dir="ltr" className="inline-block whitespace-nowrap tabular-nums">{Number(value.toFixed(3))} mm</bdi>;
const states: Record<MeasurementValueDraftV2["state"], string> = { not_recorded: "غير مسجل", measured: "مقاس", recorded: "موثق", unknown: "غير معلوم", not_measured: "لم يُقَس", unavailable: "غير متاح", not_applicable: "لا ينطبق", tooth_absent: "السن مفقود", not_erupted: "لم يبزغ" };
export function OrthoAssessmentMeasurementsV2({ draft, onChange, owner, sources }: {
  draft: MeasurementEditorDraftV2; onChange(draft: MeasurementEditorDraftV2): void;
  owner?: MeasurementEditorOwnerV2; sources: readonly MeasurementSourceChoiceV2[];
}) {
  const [selected, setSelected] = useState(draft.payload.measurementSets[0]?.id ?? "");
  const [metadataId, setMetadataId] = useState<string | null>(null), [targets, setTargets] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const editable = owner?.renderEditable === true, rows = draft.payload.observations.observations;
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
    { title: "Tanaka–Johnston — مسافة الفك العلوي المختلط", selection: { state: "draft", id: "", measurementSetId: set.id, method: "tanaka_johnston_1974", arch: "upper" } },
    { title: "Tanaka–Johnston — مسافة الفك السفلي المختلط", selection: { state: "draft", id: "", measurementSetId: set.id, method: "tanaka_johnston_1974", arch: "lower" } },
  ] : [];
  const assigned = new Set(draft.payload.analyses.map(a => a.id));
  for (const option of selections) {
    const existing = draft.payload.analyses.find(a => a.measurementSetId === option.selection.measurementSetId && a.method === option.selection.method
      && (!("arch" in a) || "arch" in option.selection && a.arch === option.selection.arch));
    if (existing) option.selection = existing;
    else { let suffix = 1; while (assigned.has(`analysis_${suffix}`)) suffix++; option.selection = { ...option.selection, id: `analysis_${suffix}` }; assigned.add(option.selection.id); }
  }
  const readiness = measurementReadinessV2(draft);
  const sourcePreview = metadataId && targets.length ? measurementSourcePreview(draft, metadataId, targets) : null;
  return <section dir="rtl" aria-label="القياسات المشتركة وتحليلات المسودة" className="space-y-3">
    <p className="text-sm">أدخل كل قياس مرة واحدة. تشترك التحليلات في مراجع المجموعة؛ الحساب ليس تشخيصًا أو اعتمادًا سريريًا.</p>
    <details className="space-y-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm" open>
      <summary className="min-h-11 cursor-pointer font-bold">حدود قياس الأسنان الدائمة وإشارة النتيجة · Permanent dentition protocol</summary>
      <p><bdi>Arch length discrepancy</bdi>: المساحة المتاحة هي طول القوس بين السطحين الأنسيين للرحى الأولى الدائمة، على مسار القوس المحدد، وليست المسافة المستقيمة بينهما.
        المطلوب مجموع عروض 10 أسنان: <bdi dir="ltr">15–25 / 45–35</bdi> من الضاحك الثاني إلى نظيره؛ لا تُضف عرض الرحى الأولى إلى هذا المجموع.</p>
      <p>المتاح ناقص المطلوب: السالب عجز مسافة والموجب فائض مسافة. القياس وحده لا يحدد خطة علاج.</p>
      <p><bdi>Bolton anterior</bdi>: 6 أسنان أمامية في كل فك <bdi dir="ltr">13–23 / 43–33</bdi>.
        <bdi> Bolton overall</bdi>: 12 سناً في كل فك <bdi dir="ltr">16–26 / 46–36</bdi>، وتشمل الرحى الأولى يميناً ويساراً.</p>
      <p>نسبة السفلي إلى العلوي = مجموع العروض السفلية ÷ العلوية × 100. فرق كل فك محسوب مع تثبيت الفك المقابل؛ الفروقان ليسا مقداراً واحداً للبرد أو الإضافة.</p>
      <p>سجّل العرض الأنسي الوحشي الفعلي لكل سن بالملليمتر ومصدره وتاريخه. لا تستبدل السن الغائب أو غير المقاس بصفر، ولا تستخدم أطوال الصورة بالملليمتر دون معايرة صالحة.</p>
      <p>مرجعا Bolton الأمامي <bdi dir="ltr">77.2%</bdi> والكلي <bdi dir="ltr">91.3%</bdi> نسب من عينة مرجعية؛ ليست حدوداً طبيعية لكل عمر أو جنس أو مجتمع. ملاءمة المرجع للحالة وتفسير الفروق مسؤولية الطبيب.</p>
    </details>
    {!editable && <p role="status">القياسات للقراءة فقط في السياق الحالي.</p>}
    <div className="grid gap-2 sm:grid-cols-2"><label>مجموعة القياسات<select className={control} value={selected} onChange={event => {
      if ((!owner || owner.active()) && event.target.value !== selected) {
        setSelected(event.target.value); setMetadataId(null); setTargets([]); setMessage(null);
        setSelectionNotice(targets.length ? "أُلغي اختيار المدخلات عند تغيير مجموعة القياسات. بقيت القيم ومصادرها في المسودة دون تغيير." : null);
      }
    }}>{draft.payload.measurementSets.map(s => <option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
      <label>الفاصل العشري<select className={control} disabled={!editable} value={draft.decimal} onChange={event => publish(changeMeasurementDecimalV2(draft, event.target.value as MeasurementEditorDraftV2["decimal"]))}>
        <option value=".">نقطة .</option><option value="٫">فاصل عربي ٫</option><option value=",">فاصلة ,</option></select></label></div>
    {selectionNotice && <p role="status" className="text-sm">{selectionNotice}</p>}
    <button type="button" className={control} disabled={!editable || draft.payload.measurementSets.length >= 12} onClick={() => {
      const next = addMeasurementSetV2(draft); if (next && owner?.active() && owner.editable()) {
        publish(next); setSelected(next.payload.measurementSets.at(-1)!.id); setMetadataId(null); setTargets([]); setMessage(null);
        setSelectionNotice(targets.length ? "أُلغي اختيار المدخلات عند تغيير مجموعة القياسات. بقيت القيم ومصادرها في المسودة دون تغيير." : null);
      }
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
      <label>حالة تاريخ الفحص<select aria-label="حالة تاريخ الفحص" className={control} disabled={!editable} value={metadata.dateState} onChange={e => patch(metadataId, { dateState: e.target.value as MeasurementValueDraftV2["dateState"] })}>
        <option value="">اختر الحالة…</option><option value="known">معلوم</option><option value="unknown">غير معلوم</option></select></label>
      {metadata.dateState === "known" ? <label>تاريخ الفحص المعلوم<input type="date" className={control} value={metadata.date} disabled={!editable} onChange={e => patch(metadataId, { date: e.target.value })} /></label>
        : metadata.dateState === "unknown" ? <label>سبب غياب تاريخ الفحص<input className={control} value={metadata.dateReason} disabled={!editable} onChange={e => patch(metadataId, { dateReason: e.target.value })} /></label> : null}
      <label>طريقة القياس<select aria-label="طريقة القياس" className={control} value={metadata.method} disabled={!editable} onChange={e => patch(metadataId, { method: e.target.value as MeasurementValueDraftV2["method"] })}>
        <option value="">اختر الطريقة…</option><option value="direct_examination">فحص مباشر</option><option value="manual_record_measurement">قياس سجل</option><option value="external_report">تقرير خارجي</option>
        {metadata.copiedFrom && <option value="legacy_revision">نسخة تاريخية</option>}</select></label>
      <label>وصف طريقة القياس<input className={control} value={metadata.methodDescription} disabled={!editable} onChange={e => patch(metadataId, { methodDescription: e.target.value })} /></label>
      <label>حالة منفذ الفحص<select aria-label="حالة منفذ الفحص" className={control} value={metadata.performer} disabled={!editable} onChange={e => patch(metadataId, { performer: e.target.value as MeasurementValueDraftV2["performer"] })}>
        <option value="unknown">غير معلوم</option><option value="documented">إسناد موثق</option></select></label>
      {metadata.performer === "documented" && <label>إسناد منفذ الفحص<input className={control} value={metadata.performerAttribution} disabled={!editable} onChange={e => patch(metadataId, { performerAttribution: e.target.value })} /></label>}
      <fieldset><legend>المصادر المصرح بها وإصداراتها</legend>{sources.map(s => <label className="flex min-h-11 items-center gap-2 break-all text-xs" key={keyOf(s)}>
        <input type="checkbox" disabled={!editable} checked={metadata.sources.some(o => keyOf(o) === keyOf(s))} onChange={() => patch(metadataId, {
          sources: metadata.sources.some(o => keyOf(o) === keyOf(s)) ? metadata.sources.filter(o => keyOf(o) !== keyOf(s)) : [...metadata.sources, { kind: s.kind, id: s.id, version: s.version }] })} />{s.label} · {s.version}</label>)}</fieldset>
      {metadata.sources.filter(s => !sources.some(o => keyOf(o) === keyOf(s))).map(s => <p className="break-all text-xs" key={keyOf(s)}>مرجع محفوظ يحتاج تحققًا: {s.kind} #{s.id} · {s.version}</p>)}
      {metadata.copiedFrom && <p className="break-all text-xs">نسخة أصلية #{metadata.copiedFrom.revisionId} · {metadata.copiedFrom.contentHash}</p>}
      {sourcePreview?.ok && <section aria-label="مراجعة تطبيق مصدر الجلسة" className="space-y-3 rounded-lg border border-amber-300 bg-white p-3">
        <h5 className="font-bold">راجع التغييرات قبل التطبيق</h5>
        <p className="text-sm">ستُستبدل الحقول المعروضة فقط في القياسات المختارة. راجع ملاءمة وصف الطريقة لكل قياس؛ أرقام القياسات لا تتغير.</p>
        {sourcePreview.targets.map(target => <div key={target.id} className="space-y-2 rounded-lg border p-2">
          <label className="flex min-h-11 items-center gap-2 font-semibold"><input type="checkbox" checked disabled={!editable}
            onChange={() => { if (owner?.active() && owner.editable()) setTargets(current => current.filter(id => id !== target.id)); }} />إبقاء {target.label} ضمن التطبيق</label>
          {target.changes.length ? <dl className="space-y-2 text-sm">{target.changes.map(change => <div key={change.field}>
            <dt className="font-semibold">{change.label}</dt>
            <dd className="grid gap-1 sm:grid-cols-2"><span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">السابق: <bdi>{change.before}</bdi></span>
              <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">الجديد: <bdi>{change.after}</bdi></span></dd>
          </div>)}</dl> : <p className="text-sm">المصدر والتاريخ والطريقة مطابقة؛ لا تغيير لهذا القياس.</p>}
        </div>)}
        <p className="text-xs">يمكنك استبعاد أي قياس أعلاه. إلغاء رسالة التأكيد يحافظ على المدخلات والاختيار.</p>
      </section>}
      <button type="button" className={control} disabled={!editable || !targets.length} onClick={() => {
        if (!owner?.active() || !owner.editable() || !window.confirm(`هل تخص المدخلات المختارة (${targets.length}) جلسة القياس نفسها؟ هل راجعت استبدال التاريخ والطريقة ووصفها والمنفذ والمصادر كما في المعاينة؟ أرقام القياسات لا تتغير.`)) return;
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
    <details className="rounded-lg border p-3 text-sm"><summary className="min-h-11 cursor-pointer font-bold">مدخلات وحدود Tanaka–Johnston</summary>
      <p>النسخة المتاحة للأسنان المختلطة: قياسات القواطع الدائمة السفلية الأربع، وقياسات قواطع الفك المطلوب الفعلية، والمسافة المتاحة لذلك الفك. راجع بزوغ القواطع وصحة القياس ومصدره. يجب توثيق الناب والضاحكين في كل جهة من الفك المطلوب كغير بازغة؛ لا تستبدل قياساً معروفاً بتنبؤ.</p>
      <p>المطلوب هنا يجمع القواطع والنابين والضواحك في الفك. قارنه بالمسافة المتاحة بين أنسي الرحى الأولى في الجهتين، عبر مسار القوس الذي وثّقته في طريقة القياس.</p>
      <p>التقدير للناب والضاحكين معاً في كل جهة، ولا يحدد عرض كل سن منفرداً. مجال الدعم الحالي لمجموع القواطع السفلية20.5–27مم سياسة للمنتج توافق مجال جداول الورقة، وليس مدى طبيعياً أو ضماناً لدقة التنبؤ لهذا المريض.</p>
      <a className="underline" href="https://uwcscholar.uwc.ac.za/bitstreams/f992423a-c0f1-44d8-86d1-128545c59ccd/download" target="_blank" rel="noreferrer">المرجع الأصلي1974؛ راجع ملاءمته للحالة</a>
    </details>
    {!!readiness.errors.length && <ul role="status" className="text-xs text-amber-900">{readiness.errors.map((e, index) => <li key={index}>{rows.find(o => o.id === e.observationId)?.label ?? "بنية المجموعة"}: {observationInputHintV2(e.code)}</li>)}</ul>}
    {readiness.analyses.map(({ selection, readiness: checked }) => <div key={selection.id} data-testid={`analysis-${selection.id}`} className="space-y-1 rounded-lg border p-3">
      <p className="font-bold">{selection.method === "tanaka_johnston_1974" ? "Tanaka–Johnston: تقدير المسافة المختلطة" : selection.method}{"arch" in selection ? ` · ${selection.arch === "upper" ? "الفك العلوي" : "الفك السفلي"}` : ""}</p>
      {!checked.ok ? <p role="alert">تعذّر التحقق من مراجع التحليل: {checked.code}</p> : checked.value.state === "incomplete" ? <ul>{checked.value.missing.map((m, i) => <li key={i}>
        {m.kind === "tooth_width" ? `قياس السن ${m.tooth} غير مكتمل` : m.kind === "available_space" ? `المساحة المتاحة ${m.arch} غير مكتملة` : m.kind === "unerupted_segment_status" ? `حالة بزوغ السن ${m.tooth} غير موثقة كغير بازغ` : "نوع الأسنان غير موثق"}</li>)}</ul>
        : checked.value.state === "unsupported_dentition" ? <p>{selection.method === "tanaka_johnston_1974" ? "هذه النسخة من التنبؤ تتطلب أسناناً مختلطة موثقة." : "لا تطبق طرق الأسنان الدائمة على الأسنان اللبنية أو المختلطة."}</p>
          : checked.value.state === "inapplicable" ? <p>التحليل غير منطبق: السن {checked.value.tooth} {({ tooth_absent: "مفقود؛ لا يُستبدل بصفر", not_erupted: "لم يبزغ؛ القياس الفعلي مطلوب", segment_width_already_measured: "له قياس محفوظ؛ لا تستبدله بتنبؤ هذه النسخة", target_not_applicable: "مسجل كغير منطبق" })[checked.value.reason]}.</p>
            : checked.value.state === "outside_supported_predictor_domain" ? <p>مجموع القواطع السفلية {checked.value.predictorSumMm} mm خارج مجال الدعم {checked.value.minimumMm}–{checked.value.maximumMm} mm. لا تُستنتج نتيجة خارج هذا المجال في النسخة الحالية؛ المجال ليس معياراً تشخيصياً.</p>
            : <><p className="text-amber-900">حساب مسودة غير معتمد سريريًا؛ لا يوصي بقلع أو برد.</p>
              {checked.value.witness.result.state === "unavailable" ? <p>الحساب غير متاح: {checked.value.witness.result.reason}</p>
                : checked.value.witness.result.method === "arch_space" ? <p>المتاح {checked.value.witness.result.availableMm} mm − المطلوب {checked.value.witness.result.requiredMm} mm = {checked.value.witness.result.availableMinusRequiredMm} mm</p>
                  : checked.value.witness.result.method === "tanaka_johnston_1974_approximation_v1" ? <>
                    <div className="grid gap-1 py-2 sm:grid-cols-2">
                      <p>القواطع السفلية المقاسة: {mm(checked.value.witness.result.measuredLowerIncisorSumMm)}</p>
                      <p>قواطع الفك المطلوب المقاسة: {mm(checked.value.witness.result.measuredTargetIncisorSumMm)}</p>
                      <p>تقدير الناب والضاحكين لكل جهة: {mm(checked.value.witness.result.predictedCaninePremolarPerQuadrantMm)}</p>
                      <p>تقدير الجهتين: {mm(checked.value.witness.result.predictedBothQuadrantsMm)}</p>
                      <p>المتاح المقاس {mm(checked.value.witness.result.measuredAvailableMm)}</p>
                      <p>المطلوب المقدّر {mm(checked.value.witness.result.estimatedRequiredMm)}</p>
                      <p className="font-semibold sm:col-span-2">الفرق — المتاح ناقص المطلوب المقدّر: {mm(checked.value.witness.result.availableMinusEstimatedRequiredMm)}</p>
                    </div>
                    <p>هذه نتيجة تقديرية؛ ملاءمة مرجعها لهذا المريض لم تعتمد بعد.</p>
                  </>
                  : <><p>مجموع العلوي {checked.value.witness.result.upperMm} mm · السفلي {checked.value.witness.result.lowerMm} mm · النسبة {checked.value.witness.result.ratioPercent}%</p>
                    <p>فرق السفلي بمرجع علوي: {checked.value.witness.result.upperReference.lowerMinusExpectedMm} mm · فرق العلوي بمرجع سفلي: {checked.value.witness.result.lowerReference.upperMinusExpectedMm} mm</p></>}
              {selection.method === "tanaka_johnston_1974" ? <details className="text-xs">
                <summary className="min-h-11 cursor-pointer py-3">مرجع التقدير وإصدار الحساب</summary>
                <p>المصدر: Tanaka وJohnston، 1974. المعادلة متحققة من المصدر الأصلي؛ الملاءمة للحالة تحتاج مراجعة الطبيب.</p>
                <p dir="ltr" className="break-all">{checked.value.witness.reference?.source}</p>
                <p dir="ltr" className="break-all">{checked.value.witness.formula.engineVersion} · {checked.value.witness.formula.formulaVersion}</p>
              </details> : <>
                <p className="break-all text-xs">{checked.value.witness.formula.engineVersion} · {checked.value.witness.formula.formulaVersion}</p>
                {checked.value.witness.reference && <p className="break-all text-xs">المرجع {checked.value.witness.reference.id} · النسخة {checked.value.witness.reference.version} · {"percent" in checked.value.witness.reference ? `${checked.value.witness.reference.percent}% · ` : "مرجع تنبؤ · "}{checked.value.witness.reference.source} · {checked.value.witness.reference.sourceVerification} · {checked.value.witness.reference.review}</p>}
              </>}
            </>}
    </div>)}
  </section>;
}
