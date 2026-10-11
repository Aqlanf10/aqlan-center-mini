"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CASE_LAYOUTS, CASE_PAGE, caseLayout } from "@/lib/ortho-case-template";
import { canonicalJourneyJSON } from "@/lib/ortho-case-journey-json";
import { STUDY_SOURCE_KINDS, type StudySourceKind, type StudySourceSelection } from "@/lib/ortho-case-study";
import { initialStudyEditorDraft, readStudyEditorDraft, serializeStudyEditorDraft, type StudyEditorDraft } from "@/lib/ortho-case-study-editor-draft";
import { verifyStudyEditorRead } from "@/lib/ortho-case-study-editor-response";
import type { StudyEditorRead } from "@/lib/ortho-case-study-editor-contract";
import type { StudyOwner } from "@/lib/ortho-case-study-owner";
import type { JourneyScope } from "@/lib/ortho-case-journey-records";
import OrthoSavedStudyReview from "@/components/OrthoSavedStudyReview";
import OrthoStudyImageEditor from "@/components/OrthoStudyImageEditor";
import { canonicalOrthoMediaRecipe } from "@/lib/ortho-study-media";
import type { StudyImageEditRequest, StudyImagePreviewRequest, StudyImagePreviewResult } from "@/lib/ortho-study-image-editor";
import { readStudyInventoryResponse } from "@/lib/ortho-case-study-inventory-client";
export interface OrthoCaseStudyProps extends JourneyScope {
  patientName: string; ownerKey: string; owner: StudyOwner;
  confirmDiscard(): boolean;
  requestImagePreview?: (request: StudyImagePreviewRequest) => Promise<StudyImagePreviewResult>;
}
const control = "min-h-11 min-w-11 rounded border px-3 py-2 disabled:opacity-50";
const labels: Record<StudySourceKind, string> = { assessment: "التقييم", diagnosis: "التشخيص", strategy: "المشكلات والاستراتيجية", decision: "القرارات",
  retention_event: "أجهزة التثبيت ومتابعتها", document: "الصور والمستندات", ceph_study: "السيفالومتري", adjustment: "جلسات المتابعة", plan_consent: "الخطة والموافقة المسجلة" };
type View = { owner: StudyOwner; readVersion: number; selected: number | null; state: "loading" | "error"; message?: string }
  | { owner: StudyOwner; readVersion: number; selected: number | null; state: "ready"; value: StudyEditorRead };
async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text(); if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) throw new Error("study_response_limit"); return JSON.parse(text);
}
export default function OrthoCaseStudy(props: OrthoCaseStudyProps) {
  if (!props.owner.matches(props) || !props.ownerKey) return <p role="alert">تغيرت هوية الحالة؛ أعد فتح الدراسة من الحالة الصحيحة.</p>;
  return <StudyWorkspace key={JSON.stringify([props.patientId, props.orthoCaseId, props.clinicalCaseId, props.ownerKey])} {...props} />;
}
function StudyWorkspace(props: OrthoCaseStudyProps) {
  const { owner, patientId, orthoCaseId, clinicalCaseId } = props;
  const [, update] = useState(0), [selected, setSelected] = useState<number | null>(null), [view, setView] = useState<View | null>(null);
  const [notice, setNotice] = useState(""), [layout, setLayout] = useState("interview"), [sourcePanel, setSourcePanel] = useState("");
  const readVersion = owner.readVersion, renderedDocument = owner.document;
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => owner.subscribe(() => update(value => value + 1)), [owner]);
  useEffect(() => {
    let live = true; const abort = new AbortController();
    const current = () => live && owner.active() && owner.readVersion === readVersion;
    setView({ owner, readVersion, selected, state: "loading" });
    void (async () => {
      try {
        const query = new URLSearchParams({ patientId: String(patientId) }); if (selected !== null) query.set("revisionId", String(selected));
        const response = await fetch(`/api/ortho/${orthoCaseId}/case-study/editor?${query}`, { cache: "no-store", credentials: "same-origin", signal: abort.signal });
        if (!current()) return;
        if (response.status === 401 || response.status === 403) { owner.denied(); throw new Error("restricted"); }
        if (!response.ok || !response.headers.get("cache-control")?.includes("no-store")) throw new Error("read_unavailable");
        const value = await verifyStudyEditorRead(await boundedJson(response), { patientId, orthoCaseId, clinicalCaseId }, selected);
        if (!current()) return;
        if (selected !== null && value.revision?.id !== selected) throw new Error("revision_changed");
        if (!owner.document && !owner.busy && !owner.uncertain) owner.settle(serializeStudyEditorDraft(initialStudyEditorDraft(value)));
        setView({ owner, readVersion, selected, state: "ready", value });
      } catch {
        if (live && owner.readVersion === readVersion) setView({ owner, readVersion, selected, state: "error", message: "تعذّرت قراءة الدراسة أو تغيرت الصلاحية. لم يُعتبر السجل فارغًا ولم تُستبدل المسودة." });
      }
    })();
    return () => { live = false; abort.abort(); };
  }, [owner, readVersion, patientId, orthoCaseId, clinicalCaseId, selected]);
  const ready = view?.owner === owner && view.readVersion === readVersion && view.selected === selected && view.state === "ready" && owner.active() ? view.value : null;
  let draft: StudyEditorDraft | null = null;
  try { if (owner.document) draft = readStudyEditorDraft(owner.document); } catch { /* Keep corrupt local bytes for explicit recovery; never silently blank. */ }
  const effectiveSourcePanel = draft?.content.panels.find(panel => panel.instanceId === sourcePanel)?.instanceId
    ?? draft?.content.panels[0]?.instanceId ?? "";
  const editable = !!ready?.canAppend && owner.editable() && !!draft;
  const change = (next: StudyEditorDraft) => {
    if (!editable || !owner.editable() || owner.readVersion !== readVersion || owner.document !== renderedDocument) return false;
    try { owner.change(serializeStudyEditorDraft(next)); return true; } catch { setNotice("التعديل غير صالح أو تجاوز الحد؛ بقيت المسودة السابقة محفوظة محليًا."); return false; }
  };
  const save = async (kind: "draft" | "documented", retry = false) => {
    if ((!editable || !draft || !ready || owner.document !== renderedDocument || owner.readVersion !== readVersion) && !retry) return;
    if (!retry && !draft!.reason.trim()) { setNotice("اكتب سبب حفظ هذه النسخة."); return; }
    const operation = retry ? owner.beginRetry() : owner.begin({ actorId: owner.actorId, scope: { patientId, orthoCaseId, clinicalCaseId }, previousVersion: draft!.previousVersion,
      command: { schemaVersion: 1, clientRequestId: crypto.randomUUID(), expectedHead: draft!.expectedHead,
        baseDocumentedRevision: draft!.baseDocumentedRevision, kind,
        documentedFrom: kind === "documented" && ready!.revision ? { id: ready!.revision.id, contentHash: ready!.revision.contentHash } : null,
        reason: draft!.reason, content: draft!.content } });
    if (!operation) { if (owner.submissionIssue === "recovery_capacity") setNotice("بلغ سجل الطلبات غير المحسومة الحد الآمن. تحقّق من الطلبات السابقة قبل حفظ طلب جديد؛ القراءة والمسودة لا تزالان متاحتين."); return; }
    // The parent lifetime, not this temporary view, owns POST settlement. A view
    // detach does not abort a potentially committed clinical documentation write.
    try {
      const response = await fetch(`/api/ortho/${orthoCaseId}/case-study/editor`, { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: operation.body });
      if (!operation.checkHeaders(response)) return;
      if (!response.ok) { operation.refuse(response.status); if (mounted.current && operation.current()) setNotice("لم يُؤكد الحفظ. احتُفظ بالمسودة؛ تحقّق من التعارض أو أعد نفس الطلب عند عدم اليقين."); return; }
      if (!response.headers.get("cache-control")?.includes("no-store") || !await operation.confirmResponse(await boundedJson(response), response.status)) operation.markUncertain();
    } catch { operation.markUncertain(); }
    finally { operation.finish(); }
  };
  const canDocument = editable && ready?.revision?.kind === "draft" && ready.head?.id === ready.revision.id
    && draft?.expectedHead?.id === ready.revision.id && canonicalJourneyJSON(draft.content) === canonicalJourneyJSON(ready.revision.authored);
  const selectRevision = (id: number | null) => {
    if (!owner.canLeave(props.confirmDiscard)) return;
    owner.settle(""); setSelected(id); setNotice("");
  };
  const addPanel = () => {
    if (!draft || !caseLayout(layout)) return;
    if (caseLayout(layout)!.singular && draft.content.panels.some(panel => panel.layoutKey === layout)) { setNotice("هذا القسم موجود في الدراسة."); return; }
    change({ ...draft, content: { ...draft.content, panels: [...draft.content.panels, { instanceId: `panel_${crypto.randomUUID()}`, layoutKey: layout,
      included: true, state: "not_recorded", sourceKeys: [], images: [], comment: "" }] } });
  };
  const chooseSource = (selection: StudySourceSelection) => {
    if (!draft || !editable) return;
    const panelId = effectiveSourcePanel;
    const panel = draft.content.panels.find(value => value.instanceId === panelId); if (!panel) return;
    const existing = draft.content.sources.find(value => value.key === selection.key);
    if (existing && canonicalJourneyJSON(existing) !== canonicalJourneyJSON(selection)) { setNotice("تغير المصدر. أزل الاختيار القديم صراحة قبل اختيار النسخة الجديدة؛ لم تُنقل تعديلات الصور تلقائيًا."); return; }
    const sources = existing ? draft.content.sources : [...draft.content.sources, selection];
    change({ ...draft, content: { ...draft.content, sources, panels: draft.content.panels.map(value => value.instanceId === panelId
      ? { ...value, state: "available", sourceKeys: [...new Set([...value.sourceKeys, selection.key])] } : value) } });
  };
  const removeSource = (selection: StudySourceSelection) => {
    if (!draft || !editable) return;
    const removedUses = new Set(draft.content.mediaUses.filter(use => selection.kind === "document" && use.documentId === selection.id && use.sourceSha256 === selection.contentHash).map(use => use.useId));
    change({ ...draft, content: { ...draft.content, sources: draft.content.sources.filter(source => source.key !== selection.key),
      groups: draft.content.groups.map(group => ({ ...group, sourceKeys: group.sourceKeys.filter(key => key !== selection.key) })),
      mediaUses: draft.content.mediaUses.filter(use => !removedUses.has(use.useId)),
      panels: draft.content.panels.map(panel => { const sourceKeys = panel.sourceKeys.filter(key => key !== selection.key), images = panel.images.filter(image => !removedUses.has(image.useId));
        return { ...panel, sourceKeys, images, state: sourceKeys.length || images.length ? panel.state : "not_recorded" }; }) } });
  };
  const editImage = (request: StudyImageEditRequest) => {
    if (!draft || !editable || request.ownerKey !== props.ownerKey) return false;
    const use = draft.content.mediaUses.find(value => value.useId === request.useId && value.documentId === request.documentId && value.sourceSha256 === request.sourceSha256);
    if (!use || canonicalOrthoMediaRecipe(use.recipe) !== request.expectedRecipe) return false;
    return change({ ...draft, content: { ...draft.content, mediaUses: draft.content.mediaUses.map(value => value === use ? { ...value, recipe: request.recipe } : value) } });
  };
  return <section dir="rtl" aria-label="دراسة حالة التقويم" className="min-w-0 space-y-4" data-testid="ortho-case-study">
    <header><h2 className="text-lg font-semibold break-words">دراسة حالة تقويم — {props.patientName}</h2>
      <p>تُحفظ الدراسة داخل الملف مستقلة عن التصدير. توثيق نسخة لا يوقع موافقة علاجية ولا يغيّر العلاج أو الحساب.</p></header>
    {notice && <p role="status">{notice}</p>}
    {owner.recoveryBlocked && <p role="alert">توجد تعديلات محلية محفوظة لسياق سابق لهذه الحالة. لن يُكشف محتواها لحساب أو مريض أو رابط مختلف، ولن تُستبدل تلقائيًا. عُد للسياق الأصلي بعد التحقق من الصلاحية.</p>}
    {owner.uncertain && <div role="alert"><p>نتيجة الطلب السابق غير مؤكدة. لن يُنشأ طلب حفظ جديد ولن تُحذف المسودة.</p>
      <button type="button" className={control} disabled={!owner.canRetry()} onClick={() => void save("draft", true)}>إعادة التحقق بنفس الطلب</button></div>}
    {view?.owner === owner && view.readVersion === readVersion && view.selected === selected && view.state === "error" && <p role="alert">{view.message}</p>}
    {!ready && <p role="status">الدراسة غير جاهزة للعرض أو التعديل.</p>}
    {ready && <>
      {ready.revision && <OrthoSavedStudyReview owner={owner} readVersion={readVersion} revision={ready.revision} />}
      <div className="flex flex-wrap gap-2 items-center"><label>النسخة المعروضة <select aria-label="النسخة المعروضة" className={control} value={selected ?? "latest"}
        disabled={owner.busy || owner.uncertain} onChange={event => { const value = event.currentTarget.value; event.currentTarget.value = selected === null ? "latest" : String(selected); selectRevision(value === "latest" ? null : Number(value)); }}>
        <option value="latest">آخر نسخة محفوظة</option>{ready.history.map(row => <option key={row.id} value={row.id}>النسخة {row.version} — {row.kind === "draft" ? "مسودة" : "موثقة"}</option>)}</select></label>
        <button type="button" className={control} disabled={owner.busy} onClick={() => owner.refresh()}>تحديث القراءة دون حذف المسودة</button></div>
      {!draft ? <p role="alert">تعذّر فك المسودة المحلية؛ لم تُستبدل بمحتوى فارغ.</p> : <>
        {!ready.canAppend && <p>عرض فقط حسب الصلاحية الحالية.</p>}
        <label className="block">سبب حفظ النسخة<input aria-label="سبب حفظ النسخة" className={`${control} w-full`} maxLength={500} value={draft.reason} disabled={!editable} onChange={event => change({ ...draft!, reason: event.currentTarget.value })} /></label>
        <label className="block">تعليق الدراسة<textarea aria-label="تعليق الدراسة" className={`${control} w-full`} maxLength={4000} value={draft.content.comment} disabled={!editable} onChange={event => change({ ...draft!, content: { ...draft!.content, comment: event.currentTarget.value } })} /></label>
        <div className="flex flex-wrap gap-2"><select aria-label="قسم جديد للدراسة" className={control} value={layout} onChange={event => setLayout(event.currentTarget.value)} disabled={!editable}>{CASE_LAYOUTS.map(item => <option key={item.key} value={item.key}>{item.titleAr}</option>)}</select>
          <button type="button" className={control} onClick={addPanel} disabled={!editable}>إضافة القسم</button></div>
        <ol className="space-y-3">{draft.content.panels.map((panel, index) => <li key={panel.instanceId} className="min-w-0 rounded border p-3 space-y-2">
          <h3>{caseLayout(panel.layoutKey)?.titleAr}</h3><label><input type="checkbox" checked={panel.included} disabled={!editable} onChange={event => change({ ...draft!, content: { ...draft!.content, panels: draft!.content.panels.map(value => value.instanceId === panel.instanceId ? { ...value, included: event.currentTarget.checked } : value) } })} /> تضمين القسم في العرض</label>
          <textarea aria-label={`تعليق ${caseLayout(panel.layoutKey)?.titleAr}`} className={`${control} w-full`} value={panel.comment} maxLength={4000} disabled={!editable}
            onChange={event => change({ ...draft!, content: { ...draft!.content, panels: draft!.content.panels.map(value => value.instanceId === panel.instanceId ? { ...value, comment: event.currentTarget.value } : value) } })} />
          <p className="break-words">المراجع المختارة: {panel.sourceKeys.length ? panel.sourceKeys.join("، ") : "لم يُختر مصدر. لا تُفترض نتائج طبيعية."}</p>
          <div className="flex flex-wrap gap-2">{([-1, 1] as const).map(direction => <button key={direction} type="button" className={control} disabled={!editable || index + direction < 0 || index + direction >= draft!.content.panels.length}
            onClick={() => { const panels = [...draft!.content.panels]; [panels[index], panels[index + direction]] = [panels[index + direction], panels[index]]; change({ ...draft!, content: { ...draft!.content, panels } }); }}>{direction < 0 ? "نقل للأعلى" : "نقل للأسفل"}</button>)}</div>
        </li>)}</ol>
        <label>إضافة المرجع إلى القسم <select aria-label="إضافة المرجع إلى القسم" className={`${control} max-w-full`} value={effectiveSourcePanel} onChange={event => setSourcePanel(event.currentTarget.value)} disabled={!editable}>{draft.content.panels.map(panel => <option key={panel.instanceId} value={panel.instanceId}>{caseLayout(panel.layoutKey)?.titleAr} — {panel.instanceId}</option>)}</select></label>
        <SourcePicker {...props} editable={editable} onChoose={chooseSource} />
        <ul aria-label="المراجع المحفوظة في المسودة">{draft.content.sources.map(source => <li key={source.key} className="flex flex-wrap gap-2 items-center">
          <span>{labels[source.kind]} #{source.id}{source.version === null ? "" : ` — نسخة ${source.version}`}</span>
          <button type="button" className={control} disabled={!editable} onClick={() => removeSource(source)}>إزالة المرجع واستخداماته من هذه المسودة</button>
        </li>)}</ul>
        {draft.content.sources.filter(source => source.kind === "document" && !draft!.content.mediaUses.some(use => use.documentId === source.id && use.sourceSha256 === source.contentHash)).map(source => <p key={source.key}>المستند #{source.id} مختار. إسناده إلى إطار صورة ينتظر أساس أبعاد واتجاه موثوقًا؛ لا تمنع هذه الخطوة حفظ الدراسة.</p>)}
        {draft.content.mediaUses.map(use => {
          const panel = draft!.content.panels.find(value => value.images.some(image => image.useId === use.useId));
          const binding = panel?.images.find(image => image.useId === use.useId), slot = panel && binding ? caseLayout(panel.layoutKey)?.images.find(image => image.slotId === binding.slot) : null;
          if (!slot) return <p role="alert" key={use.useId}>إطار الصورة غير متاح؛ لم تُحذف تعديلات الاستخدام.</p>;
          return <OrthoStudyImageEditor key={use.useId} ownerKey={props.ownerKey} use={use} frame={{ width: Math.ceil(slot.w * CASE_PAGE.imageDpi), height: Math.ceil(slot.h * CASE_PAGE.imageDpi) }} editable={editable}
            onChange={editImage} requestPreview={props.requestImagePreview ?? (async () => ({ ok: false, code: "unavailable" }))} />;
        })}
        <div className="flex flex-wrap gap-2"><button type="button" className={control} disabled={!editable} onClick={() => void save("draft")}>حفظ مسودة الدراسة</button>
          <button type="button" className={control} disabled={!canDocument} onClick={() => void save("documented")}>توثيق النسخة المحفوظة نفسها</button></div>
        <p>التصدير غير مفعّل حتى اكتمال التحقق من ملفات PowerPoint وPDF. حفظ الدراسة وإعادة فتحها لا يحتاجان محرك التصدير.</p>
      </>}
    </>}
  </section>;
}
function SourcePicker(props: OrthoCaseStudyProps & { editable: boolean; onChoose(source: StudySourceSelection): void }) {
  const [kind, setKind] = useState<StudySourceKind>("assessment"), [after, setAfter] = useState<number | null>(null);
  const [result, setResult] = useState<{ owner: StudyOwner; key: string; value: ReturnType<typeof readStudyInventoryResponse> } | null>(null), [error, setError] = useState("");
  const key = JSON.stringify([kind, after, props.owner.readVersion]);
  useEffect(() => {
    let active = true; const abort = new AbortController(), generation = props.owner.readVersion; setError("");
    const currentOwner = () => active && props.owner.active() && props.owner.readVersion === generation;
    void (async () => { try {
      const query = new URLSearchParams({ patientId: String(props.patientId), kind }); if (after !== null) query.set("afterId", String(after));
      const response = await fetch(`/api/ortho/${props.orthoCaseId}/case-study/sources?${query}`, { cache: "no-store", credentials: "same-origin", signal: abort.signal });
      if (!currentOwner()) return;
      if (response.status === 401 || response.status === 403) throw new Error("restricted");
      if (!response.ok || !response.headers.get("cache-control")?.includes("no-store")) throw new Error("unavailable");
      const value = readStudyInventoryResponse(await boundedJson(response), props, kind);
      if (currentOwner()) setResult({ owner: props.owner, key, value });
    } catch { if (active) setError("تعذّرت قراءة المراجع أو أن القسم مقيّد؛ لم تُعتبر القائمة فارغة."); } })();
    return () => { active = false; abort.abort(); };
  }, [props.owner, props.patientId, props.orthoCaseId, props.clinicalCaseId, kind, after, key]);
  const current = result?.owner === props.owner && result.key === key ? result.value : null;
  return <fieldset className="min-w-0 rounded border p-3"><legend>اختيار مصدر حقيقي</legend>
    <select className={control} aria-label="نوع مصدر الدراسة" value={kind} onChange={event => { setKind(event.currentTarget.value as StudySourceKind); setAfter(null); }}>{STUDY_SOURCE_KINDS.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select>
    {error && <p role="alert">{error}</p>}{current?.state === "restricted" && <p>هذا النوع من المصادر مقيّد بالصلاحية الحالية.</p>}
    {current?.state === "available" && <><ul>{current.choices.map(choice => <li key={choice.id} className="flex flex-wrap gap-2 items-center"><span>{labels[kind]} #{choice.id}{choice.version === null ? "" : ` — نسخة ${choice.version}`}</span>
      <button type="button" className={control} disabled={!props.editable || !choice.selection} onClick={() => choice.selection && props.onChoose(choice.selection)}>اختيار</button>
      {!choice.selection && <span>المصدر غير متاح بهذه النسخة؛ لا تُفترض بيانات بديلة.</span>}</li>)}</ul>
      {!current.choices.length && <p>لا توجد مراجع من هذا النوع في الصفحة الحالية.</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className={control} disabled={after === null} onClick={() => setAfter(null)}>الصفحة الأولى</button>
        <button type="button" className={control} disabled={current.nextAfterId === null} onClick={() => setAfter(current.nextAfterId)}>المراجع التالية</button></div></>}
  </fieldset>;
}
