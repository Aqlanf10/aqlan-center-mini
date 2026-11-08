"use client";
import { useEffect, useRef, useState } from "react";
import { caseLayout } from "@/lib/ortho-case-template";
import type { StudyDraftContent, StudySourceSelection } from "@/lib/ortho-case-study";
import type { JourneyScope } from "@/lib/ortho-case-journey-records";
import { fetchStudyImageBasis, StudyImageAccessDenied } from "@/lib/ortho-study-image-client";
import type { OrthoMediaRecipe } from "@/lib/ortho-study-media";
const control = "min-h-11 min-w-11 rounded border px-3 py-2 disabled:opacity-50";
export default function OrthoStudyImagePicker(props: { scope: JourneyScope; content: StudyDraftContent; panelId: string; editable: boolean;
  onDenied(): void;
  onAttach(source: StudySourceSelection, panelId: string, slot: string, recipe: OrthoMediaRecipe): boolean }) {
  const [sourceKey,setSourceKey] = useState(""), [slotKey,setSlotKey] = useState(""), [notice,setNotice] = useState(""), [busy,setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  const panel = props.content.panels.find(p => p.instanceId === props.panelId);
  const sources = props.content.sources.filter(s => s.kind === "document" && panel?.sourceKeys.includes(s.key));
  const slots = caseLayout(panel?.layoutKey ?? "")?.images.filter(s => s.sourceKind === "patient-document" && !panel?.images.some(i => i.slot === s.slotId)) ?? [];
  const source = sources.find(s => s.key === sourceKey) ?? sources[0], slot = slots.find(s => s.slotId === slotKey) ?? slots[0];
  if (!panel || !sources.length) return null;
  const attach = async () => {
    if (!source || !slot || !props.editable || busy) return;
    const abort = new AbortController(); active.current = abort; setBusy(true); setNotice("");
    try {
      const recipe = await fetchStudyImageBasis(props.scope,source.id,source.contentHash,abort.signal);
      if (abort.signal.aborted) return;
      setNotice(props.onAttach(source,panel.instanceId,slot.slotId,recipe) ? "أُضيفت الصورة إلى المسودة. احفظ نسخة الدراسة للاحتفاظ بها." : "تغيرت المسودة أثناء القراءة. أعد اختيار الصورة؛ لم تُستبدل التعديلات.");
    } catch (error) { if (!abort.signal.aborted && error instanceof StudyImageAccessDenied) props.onDenied(); if (!abort.signal.aborted) setNotice("تعذّر التحقق من الصورة أو صلاحيتها. بقي المرجع والمسودة دون تغيير."); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  return <fieldset className="rounded border p-3 space-y-2"><legend>إسناد صورة إلى القسم / Assign image</legend>
    <p>تُقرأ أبعاد الصورة واتجاهها من الأصل. هذه تعديلات عرض مستقلة عن القياسات السريرية.</p>
    {!slots.length ? <p>لا يوجد إطار فارغ في هذا القسم. لإبدال صورة، أزل استخدامها أولاً؛ يبقى الملف الأصلي محفوظاً.</p> : <div className="flex flex-wrap gap-2">
      <select aria-label="مصدر الصورة / Image source" className={control} value={source?.key ?? ""} disabled={!props.editable || busy} onChange={e => setSourceKey(e.currentTarget.value)}>{sources.map(s => <option key={s.key} value={s.key}>المستند #{s.id}</option>)}</select>
      <select aria-label="إطار الصورة / Image slot" className={control} value={slot?.slotId ?? ""} disabled={!props.editable || busy} onChange={e => setSlotKey(e.currentTarget.value)}>{slots.map((s,i) => <option key={s.slotId} value={s.slotId}>الإطار {i+1} — {s.slotId}</option>)}</select>
      <button type="button" className={control} disabled={!props.editable || busy} onClick={() => void attach()}>{busy ? "جارٍ التحقق من الصورة…" : "إضافة الصورة إلى الإطار"}</button>
    </div>}{notice && <p role="status">{notice}</p>}
  </fieldset>;
}
