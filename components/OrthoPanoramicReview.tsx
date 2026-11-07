"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { addPanoramicFinding, readPanoramicFindingId } from "@/lib/ortho-panoramic-findings";
import type { MeasurementEditorDraftV2, MeasurementValueDraftV2 } from "@/lib/ortho-assessment-measurement-editor-v2";
import type { OrthoRecordDocument } from "@/lib/ortho-records";
import { isPhotoStage, PHOTO_STAGE_LABEL } from "@/lib/ortho-photos";
import type { MeasurementEditorOwnerV2, MeasurementSourceChoiceV2 } from "./OrthoAssessmentMeasurementsV2";
const control = "min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-60";
const teeth = [...Array.from({ length: 4 }, (_, q) => Array.from({ length: 8 }, (_, t) => (q + 1) * 10 + t + 1)).flat(),
  ...Array.from({ length: 4 }, (_, q) => Array.from({ length: 5 }, (_, t) => (q + 5) * 10 + t + 1)).flat()];
/** Shares assessment draft, revision and save ownership; no parallel diagnosis. */
export function OrthoPanoramicReview({ draft, documents, sources, owner, onChange }: {
  draft: MeasurementEditorDraftV2; documents: readonly OrthoRecordDocument[]; sources: readonly MeasurementSourceChoiceV2[];
  owner?: MeasurementEditorOwnerV2; onChange(draft: MeasurementEditorDraftV2): void;
}) {
  const [selected, setSelected] = useState(0), [target, setTarget] = useState(""), [failedImage, setFailedImage] = useState<number | null>(null);
  const document = documents.find(d => d.id === selected);
  const source = sources.find(s => s.kind === "document" && s.id === selected);
  const sourceDigest = source?.kind === "document" && /^sha256:[a-f0-9]{64}$/.test(source.version) ? source.version.slice(7) : null;
  const imageUrl = document && sourceDigest ? `/api/documents/${document.id}?cephSource=${sourceDigest}` : null;
  const [loadedImage, setLoadedImage] = useState<string | null>(null);
  // Retained handlers belong to this committed render, even when a selection
  // returns to the same document or tooth. They never regain authority later.
  const generation = {};
  const committed = useRef<object | null>(null);
  useLayoutEffect(() => { committed.current = generation; return () => { if (committed.current === generation) committed.current = null; }; });
  const current = () => committed.current === generation;
  const notes = draft.payload.observations.observations.flatMap(row => {
    const identity = readPanoramicFindingId(row.id); return identity ? [{ row, identity }] : [];
  });
  const ids = [...new Set([...documents.map(d => d.id), ...notes.map(n => n.identity.documentId)])];
  const editable = owner?.renderEditable === true && !!imageUrl && loadedImage === imageUrl && failedImage !== selected;
  const matchesSource = (value: MeasurementValueDraftV2) => !!source && (value.state === "not_recorded" || value.sources.some(s => s.kind === "document" && s.id === source.id && s.version === source.version));
  const publish = (next: MeasurementEditorDraftV2) => { if (current() && editable && owner?.active() && owner.editable() && document && source) onChange(next); };
  const patch = (id: string, update: Partial<MeasurementValueDraftV2>) => {
    if (draft.values[id] && matchesSource(draft.values[id])) publish({ ...draft, values: { ...draft.values, [id]: { ...draft.values[id], ...update,
      ...(draft.values[id].state === "not_recorded" && source ? { sources: [{ kind: source.kind, id: source.id, version: source.version }] } : {}) } } });
  };
  return <section aria-label="قراءة البانوراما وربطها بالأسنان" className="space-y-3">
    <h4 className="font-bold">قراءة الطبيب للبانوراما</h4>
    <p className="text-sm">اختر الصورة الأصلية، ثم وثّق القراءة العامة أو ملاحظة لسن محدد. هذه ملاحظات الطبيب وليست تحليلاً آلياً؛ غياب الملاحظة لا يعني أن الصورة طبيعية.</p>
    <label className="block">صورة البانوراما<select aria-label="صورة البانوراما" className={control} value={selected || ""} onChange={event => { if (current()) { setSelected(Number(event.target.value)); setTarget(""); setLoadedImage(null); setFailedImage(null); } }}>
      <option value="">اختر الصورة…</option>{ids.map(id => <option key={id} value={id}>{documents.find(d => d.id === id)?.title ?? `صورة مرجعية #${id} غير متاحة`} · #{id}</option>)}
    </select></label>
    {!ids.length && <p>لم تتوفر صورة بانوراما مرتبطة بهذه الحالة في القراءة الحالية. أضف الصورة الموجودة من السجلات أدناه؛ لا يلزم تصوير جديد لمجرد فتح الخطوة.</p>}
    {!!selected && (!document || !source) && <p role="alert">تعذّر التحقق من أصل الصورة ومصدرها الحالي. الملاحظات المحفوظة باقية، والتحرير متوقف حتى توفر المصدر المصرح به.</p>}
    {document && source && imageUrl && <>
      <p className="text-sm">تاريخ التصوير: {document.takenOn ?? "غير معلوم"} · المرحلة المسجلة: {isPhotoStage(document.photoStage) ? PHOTO_STAGE_LABEL[document.photoStage] : "غير معلومة"}</p>
      {document.note && <p className="whitespace-pre-wrap break-words text-xs">مصدر معلومات الصورة: {document.note}</p>}
      <a className="inline-flex min-h-11 items-center underline" href={imageUrl} target="_blank" rel="noopener noreferrer">فتح أصل الصورة</a>
      <img key={imageUrl} src={imageUrl} alt={`أصل البانوراما: ${document.title}`} className="max-h-96 w-full rounded-lg border object-contain"
        onError={() => { if (current()) { setFailedImage(document.id); setLoadedImage(null); } }} onLoad={() => { if (current()) { setFailedImage(null); setLoadedImage(imageUrl); } }} />
      {loadedImage !== imageUrl && failedImage !== document.id && <p role="status">جارٍ التحقق من عرض أصل الصورة؛ التحرير متوقف حتى اكتمال تحميلها.</p>}
      {failedImage === document.id && <p role="alert">تعذر عرض الصورة؛ لا تُفترض إمكانية قراءتها من وجود بياناتها.</p>}
      {owner && <div className="grid gap-2 sm:grid-cols-2"><label>نطاق الملاحظة<select aria-label="نطاق الملاحظة" className={control} value={target} disabled={!editable} onChange={event => { if (current() && editable) setTarget(event.target.value); }}>
        <option value="">اختر النطاق…</option><option value="case">قراءة عامة للصورة</option>{teeth.map(tooth => <option key={tooth} value={tooth}>السن FDI {tooth}</option>)}
      </select></label><button type="button" className={`${control} self-end`} disabled={!editable || !target || notes.some(n => n.identity.documentId === selected && n.identity.tooth === (target === "case" ? null : Number(target)))}
        onClick={() => { if (source && target) { const next = addPanoramicFinding(draft, { kind: source.kind, id: source.id, version: source.version }, target === "case" ? null : Number(target)); if (next) publish(next); } }}>إضافة ملاحظة غير معبأة</button></div>}
    </>}
    {notes.filter(n => n.identity.documentId === selected).map(({ row, identity }) => {
      const value = draft.values[row.id], title = identity.tooth === null ? "القراءة العامة" : `السن FDI ${identity.tooth}`;
      if (!value) return <p key={row.id} role="alert">تعذر قراءة الملاحظة المحفوظة.</p>;
      return <fieldset key={row.id} disabled={!editable || !matchesSource(value)} className="space-y-2 rounded-lg border p-3" aria-label={`قراءة ${title}`}><legend className="font-bold">{title}</legend>
        {!matchesSource(value) && value.state !== "not_recorded" && <p role="alert">هذه القراءة مرتبطة بنسخة مصدر مختلفة أو غير متاحة؛ لا تُنسب إلى الصورة المعروضة حالياً.</p>}
        <label className="block">حالة قراءة {title}<select aria-label={`حالة قراءة ${title}`} className={control} value={value.state} disabled={!editable} onChange={event => patch(row.id, { state: event.target.value as MeasurementValueDraftV2["state"] })}>
          <option value="not_recorded">غير مسجلة</option><option value="recorded">ملاحظة موثقة</option><option value="not_measured">لم تُقيّم</option><option value="unknown">غير معلومة</option><option value="unavailable">غير متاحة</option><option value="not_applicable">لا تنطبق</option>
          {identity.tooth !== null && <><option value="tooth_absent">غياب السن موثق</option><option value="not_erupted">عدم البزوغ موثق</option></>}
        </select></label>
        {value.state === "recorded" ? <label className="block">نتائج قراءة {title}<textarea className={control} maxLength={4000} rows={3} value={value.text} disabled={!editable} onChange={event => patch(row.id, { text: event.target.value })} /></label>
          : value.state !== "not_recorded" && <label className="block">سبب حالة قراءة {title}<input className={control} maxLength={500} value={value.reason} disabled={!editable} onChange={event => patch(row.id, { reason: event.target.value })} /></label>}
        {value.state !== "not_recorded" && <>
          <p className="text-xs">تاريخ القراءة ومنفذها مستقلان عن تاريخ التصوير ومسجّل النسخة. لا يُنسخ تاريخ اليوم أو اسم الطبيب تلقائياً.</p>
          <div className="grid gap-2 sm:grid-cols-2"><label>حالة تاريخ قراءة {title}<select aria-label={`حالة تاريخ قراءة ${title}`} className={control} value={value.dateState} disabled={!editable} onChange={event => patch(row.id, { dateState: event.target.value as MeasurementValueDraftV2["dateState"] })}>
            <option value="">اختر…</option><option value="known">معلوم</option><option value="unknown">غير معلوم</option></select></label>
            {value.dateState === "known" && <label>تاريخ قراءة {title}<input className={control} type="date" value={value.date} disabled={!editable} onChange={event => patch(row.id, { date: event.target.value })} /></label>}
            {value.dateState === "unknown" && <label>سبب غياب تاريخ قراءة {title}<input className={control} maxLength={500} value={value.dateReason} disabled={!editable} onChange={event => patch(row.id, { dateReason: event.target.value })} /></label>}
            <label>طريقة قراءة {title}<select aria-label={`طريقة قراءة ${title}`} className={control} value={value.method} disabled={!editable} onChange={event => patch(row.id, { method: event.target.value as MeasurementValueDraftV2["method"] })}>
              <option value="">اختر…</option><option value="direct_examination">فحص مباشر للصورة بواسطة الطبيب</option>
              {value.method && value.method !== "direct_examination" && <option value={value.method}>طريقة محفوظة: {value.method}</option>}
            </select></label><label>وصف طريقة قراءة {title}<input className={control} maxLength={500} value={value.methodDescription} disabled={!editable} onChange={event => patch(row.id, { methodDescription: event.target.value })} /></label>
            <label>من قرأ {title}<select aria-label={`من قرأ ${title}`} className={control} value={value.performer} disabled={!editable} onChange={event => patch(row.id, { performer: event.target.value as MeasurementValueDraftV2["performer"] })}>
              <option value="unknown">غير معلوم</option><option value="documented">إسناد موثق</option></select></label>
            {value.performer === "documented" && <label>اسم قارئ {title}<input className={control} maxLength={500} value={value.performerAttribution} disabled={!editable} onChange={event => patch(row.id, { performerAttribution: event.target.value })} /></label>}
          </div>
          <p className="text-xs">مرتبطة بأصل الصورة #{identity.documentId}. تعديل القراءة ينشئ نسخة تقييم جديدة مع بقاء النسخة السابقة.</p>
        </>}
      </fieldset>;
    })}
  </section>;
}
