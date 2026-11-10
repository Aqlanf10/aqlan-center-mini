"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { readStudyDisplayLocale, STUDY_DISPLAY_LOCALE_KEY, studyDirection, studyLayoutTitle, studySourceName, studyText, type StudyDisplayLocale, type StudyMessage } from "@/lib/ortho-case-presentation-i18n";
import { CASE_LAYOUTS, CASE_PAGE, caseLayout } from "@/lib/ortho-case-template";
import { canonicalJourneyJSON } from "@/lib/ortho-case-journey-json";
import { AVAILABLE_STUDY_SOURCE_KINDS, type StudySourceKind, type StudySourceSelection } from "@/lib/ortho-case-study";
import { initialStudyEditorDraft, readStudyEditorDraft, serializeStudyEditorDraft, type StudyEditorDraft } from "@/lib/ortho-case-study-editor-draft";
import { verifyStudyEditorRead } from "@/lib/ortho-case-study-editor-response";
import type { StudyEditorRead } from "@/lib/ortho-case-study-editor-contract";
import type { StudyOwner } from "@/lib/ortho-case-study-owner";
import type { JourneyScope } from "@/lib/ortho-case-journey-records";
import { OrthoStudyTimepoints } from "./OrthoStudyTimepoints";
import { OrthoStudyExportLinks } from "./OrthoStudyExportLinks";
import OrthoSavedStudyReview from "@/components/OrthoSavedStudyReview";
import OrthoStudyImagePicker from "@/components/OrthoStudyImagePicker";
import { attachStudyImage, detachStudyImage } from "@/lib/ortho-study-image-selection";
import { fetchStudyImagePreview } from "@/lib/ortho-study-image-client";
import OrthoStudyImageEditor from "@/components/OrthoStudyImageEditor";
import { canonicalOrthoMediaRecipe } from "@/lib/ortho-study-media";
import type { StudyImageEditRequest, StudyImagePreviewRequest, StudyImagePreviewResult } from "@/lib/ortho-study-image-editor";
import { readStudyInventoryResponse } from "@/lib/ortho-case-study-inventory-client";
import { fetchStudySubmissionRecovery, canRetryStudySubmission, canCancelStudySubmission, submitAndAcknowledgeStudy, cancelAndAcknowledgeStudy, type StudySubmissionRead } from "@/lib/ortho-study-submission-client";
export interface OrthoCaseStudyProps extends JourneyScope {
  patientName: string; ownerKey: string; owner: StudyOwner;
  confirmDiscard(): boolean;
  requestImagePreview?: (request: StudyImagePreviewRequest) => Promise<StudyImagePreviewResult>;
}
const control = "min-h-11 min-w-11 rounded border px-3 py-2 disabled:opacity-50";

type View = { owner: StudyOwner; readVersion: number; selected: number | null; state: "loading" | "error"; message?: StudyMessage }
  | { owner: StudyOwner; readVersion: number; selected: number | null; state: "ready"; value: StudyEditorRead; recovery: StudySubmissionRead }
  | { owner: StudyOwner; readVersion: number; selected: number | null; state: "metadata"; recovery: StudySubmissionRead };
async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text(); if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) throw new Error("study_response_limit"); return JSON.parse(text);
}
export default function OrthoCaseStudy(props: OrthoCaseStudyProps) {
  if (!props.owner.matches(props) || !props.ownerKey) return <p role="alert">{studyText("ar", "تغيرت هوية الحالة؛ أعد فتح الدراسة من الحالة الصحيحة.")}</p>;
  return <StudyWorkspace key={JSON.stringify([props.patientId, props.orthoCaseId, props.clinicalCaseId, props.ownerKey])} {...props} />;
}
function StudyWorkspace(props: OrthoCaseStudyProps) {
  const { owner, patientId, orthoCaseId, clinicalCaseId } = props;
  const [locale, setLocale] = useState<StudyDisplayLocale>("ar");
  const t = (message: StudyMessage) => studyText(locale, message);
  useEffect(() => {
    try { setLocale(readStudyDisplayLocale(localStorage.getItem(STUDY_DISPLAY_LOCALE_KEY))); } catch { /* Display still works without browser storage. */ }
  }, []);
  const changeLocale = (value: string) => {
    const next = readStudyDisplayLocale(value); setLocale(next);
    try { localStorage.setItem(STUDY_DISPLAY_LOCALE_KEY, next); } catch { /* No patient data or draft is stored here. */ }
  };
  const [, update] = useState(0), [selected, setSelected] = useState<number | null>(null), [view, setView] = useState<View | null>(null);
  const [notice, setNotice] = useState<StudyMessage | null>(null), [layout, setLayout] = useState("interview"), [sourcePanel, setSourcePanel] = useState("");
  const [selectedImage, setSelectedImage] = useState("");
  const [transitionBusy, setTransitionBusy] = useState(false), [recoveryNotice, setRecoveryNotice] = useState(false);
  const transition = useRef<object | null>(null);
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
        // Recovery has independent metadata authorization. A source-restricted
        // saved revision must not make its pending command impossible to cancel.
        const recovery = await fetchStudySubmissionRecovery({ owner, scope: { patientId, orthoCaseId, clinicalCaseId }, current }, abort.signal);
        if (!current()) return;
        const query = new URLSearchParams({ patientId: String(patientId) }); if (selected !== null) query.set("revisionId", String(selected));
        const response = await fetch(`/api/ortho/${orthoCaseId}/case-study/editor?${query}`, { cache: "no-store", credentials: "same-origin", signal: abort.signal });
        if (!current()) return;
        if (response.status === 401) { owner.denied(); throw new Error("restricted"); }
        if (response.status === 403) {
          owner.quarantineDraft();
          setView({ owner, readVersion, selected, state: "metadata", recovery });
          return;
        }
        if (!response.ok || !response.headers.get("cache-control")?.includes("no-store")) throw new Error("read_unavailable");
        const value = await verifyStudyEditorRead(await boundedJson(response), { patientId, orthoCaseId, clinicalCaseId }, selected);
        if (!current()) return;
        if (selected !== null && value.revision?.id !== selected) throw new Error("revision_changed");
        if (!owner.draftQuarantined && !owner.document && !owner.busy && !owner.uncertain) owner.settle(serializeStudyEditorDraft(initialStudyEditorDraft(value)));
        setView({ owner, readVersion, selected, state: "ready", value, recovery });
      } catch {
        if (live && owner.readVersion === readVersion) setView({ owner, readVersion, selected, state: "error", message: "تعذّرت قراءة الدراسة أو تغيرت الصلاحية. لم يُعتبر السجل فارغًا ولم تُستبدل المسودة." });
      }
    })();
    return () => { live = false; abort.abort(); };
  }, [owner, readVersion, patientId, orthoCaseId, clinicalCaseId, selected]);
  const currentView = view?.owner === owner && view.readVersion === readVersion && view.selected === selected && owner.active() ? view : null;
  const ready = currentView?.state === "ready" ? currentView.value : null;
  let draft: StudyEditorDraft | null = null;
  try { if (owner.document) draft = readStudyEditorDraft(owner.document); } catch { /* Keep corrupt local bytes for explicit recovery; never silently blank. */ }
  const effectiveSourcePanel = draft?.content.panels.find(panel => panel.instanceId === sourcePanel)?.instanceId
    ?? draft?.content.panels[0]?.instanceId ?? "";
  const recovery = currentView?.state === "ready" || currentView?.state === "metadata" ? currentView.recovery : null;
  const metadataCancellation = currentView?.state === "metadata";
  const canCancel = (!!ready?.canAppend || metadataCancellation) && canCancelStudySubmission(owner, recovery);
  const canDiscardHiddenDraft = !!recovery && owner.draftQuarantined && !owner.retryExpectation && !owner.uncertain && !owner.busy && !owner.recoveryBlocked;
  const editable = !!ready?.canAppend && !!recovery && !recovery.receipt && !recovery.conflict && !transitionBusy && !owner.draftQuarantined && owner.editable() && !!draft;
  const change = (next: StudyEditorDraft) => {
    if (transition.current || !editable || !owner.editable() || owner.readVersion !== readVersion || owner.document !== renderedDocument) return false;
    try { owner.change(serializeStudyEditorDraft(next)); return true; } catch { setNotice("التعديل غير صالح أو تجاوز الحد؛ بقيت المسودة السابقة محفوظة محليًا."); return false; }
  };
  const save = async (kind: "draft" | "documented", retry = false) => {
    if (transition.current || !mounted.current || !owner.active() || owner.readVersion !== readVersion) return;
    if (retry && (!ready?.canAppend || !canRetryStudySubmission(recovery) || !owner.canRetry())) return;
    if ((!editable || !draft || !ready || owner.document !== renderedDocument || owner.readVersion !== readVersion) && !retry) return;
    if (!retry && !draft!.reason.trim()) { setNotice("اكتب سبب حفظ هذه النسخة."); return; }
    const operation = retry ? owner.beginRetry() : owner.begin({ actorId: owner.actorId, scope: { patientId, orthoCaseId, clinicalCaseId }, previousVersion: draft!.previousVersion,
      command: { schemaVersion: 1, clientRequestId: crypto.randomUUID(), expectedHead: draft!.expectedHead,
        baseDocumentedRevision: draft!.baseDocumentedRevision, kind,
        documentedFrom: kind === "documented" && ready!.revision ? { id: ready!.revision.id, contentHash: ready!.revision.contentHash } : null,
        reason: draft!.reason, content: draft!.content } });
    if (!operation) { if (owner.submissionIssue === "recovery_capacity") setNotice("بلغ سجل الطلبات غير المحسومة الحد الآمن. تحقّق من الطلبات السابقة قبل حفظ طلب جديد؛ القراءة والمسودة لا تزالان متاحتين."); return; }
    const expected = owner.retryExpectation;
    if (!expected) { operation.markUncertain(); operation.finish(); return; }
    const knownIdentity = recovery?.receipt && "identity" in recovery.receipt ? recovery.receipt.identity : null;
    const confirmed = await submitAndAcknowledgeStudy(owner, operation, expected, knownIdentity ?? undefined);
    if (confirmed && mounted.current && owner.active()) { setNotice(null); setRecoveryNotice(false); }
    if (!confirmed && mounted.current && owner.active()) setNotice("لم يُؤكد الحفظ. احتُفظ بالمسودة؛ تحقّق من التعارض أو أعد نفس الطلب عند عدم اليقين.");
    if (owner.active()) owner.refresh();
  };
  const cancelSubmission = async () => {
    if (!recovery || !canCancel || transition.current || !mounted.current || !owner.active() || owner.readVersion !== readVersion) return;
    const token = {}; transition.current = token; setTransitionBusy(true); setRecoveryNotice(false);
    let declined = false;
    const current = () => mounted.current && transition.current === token && owner.active() && owner.readVersion === readVersion;
    try {
      const resolved = await cancelAndAcknowledgeStudy({ owner, scope: { patientId, orthoCaseId, clinicalCaseId }, current }, recovery,
        () => { declined = !window.confirm(locale === "ar" ? "إلغاء طلب الحفظ المعلّق؟ لن تُحذف أي نسخة سريرية محفوظة. سيبقى النص المحلي مسودة غير محفوظة." : "Cancel the pending save request? No saved clinical revision will be deleted. Local text will remain an unsaved draft."); return !declined; });
      if (!resolved && !declined && current()) setRecoveryNotice(true);
    } catch { if (current()) setRecoveryNotice(true); }
    finally {
      if (!declined && current()) owner.refresh();
      if (transition.current === token) { transition.current = null; if (mounted.current) setTransitionBusy(false); }
    }
  };
  const discardHiddenDraft = () => {
    if (!canDiscardHiddenDraft || transition.current || !mounted.current || !owner.active() || owner.readVersion !== readVersion) return;
    const discarded = owner.discardQuarantinedDraft(() => {
      const confirmed = window.confirm(locale === "ar" ? "حذف المسودة المحلية المحجوبة نهائيًا؟ ستُفقد تعديلاتها غير المحفوظة فقط، ولن تُحذف أي نسخة سريرية محفوظة." : "Permanently discard the hidden local draft? Only its unsaved edits will be lost. No saved clinical revision will be deleted.");
      return confirmed && mounted.current && owner.active() && owner.readVersion === readVersion && !owner.busy && !owner.uncertain;
    });
    if (discarded && owner.active()) owner.refresh();
  };
  const canDocument = editable && ready?.revision?.kind === "draft" && ready.head?.id === ready.revision.id
    && draft?.expectedHead?.id === ready.revision.id && canonicalJourneyJSON(draft.content) === canonicalJourneyJSON(ready.revision.authored);
  const selectRevision = (id: number | null) => {
    if (transition.current || recovery?.receipt || !owner.canLeave(props.confirmDiscard)) return;
    owner.settle(""); setSelected(id); setNotice(null);
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
    if (selection.kind === "problem_review" && !["diagnosis", "objectives", "problem-plan-strategy"].includes(panel.layoutKey)) {
      setNotice("اختر قسم التشخيص أو الأهداف أو المشكلات والاستراتيجية لعرض مراجعة المصدر."); return;
    }
    if (selection.kind === "space_ledger") {
      if (panel.layoutKey !== "model-measurements") { setNotice("اختر قسم تحليل المسافة لعرض لقطة سجل المسافات وIPR."); return; }
      const previous = draft.content.sources.find(value => value.kind === "space_ledger");
      if (previous && canonicalJourneyJSON(previous) !== canonicalJourneyJSON(selection)) { setNotice("توجد لقطة مسافات مختارة؛ أزلها صراحةً قبل اختيار رأس آخر. لا تُجمع لقطتان للسجل نفسه."); return; }
    }
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
  return <section lang={locale} dir={studyDirection(locale)} aria-label={t("دراسة حالة التقويم")} className="min-w-0 space-y-4" data-testid="ortho-case-study">
    <label className="flex flex-wrap items-center gap-2">{t("لغة العرض")}
      <select aria-label="لغة العرض / Display language" className={control} value={locale} onChange={event => changeLocale(event.currentTarget.value)}>
        <option value="ar">العربية</option><option value="en">English</option>
      </select>
    </label>
    <header><h2 className="text-lg font-semibold break-words">{t("دراسة حالة تقويم")}{ready && <> — <bdi>{props.patientName}</bdi></>}</h2>
      <p>{t("تُحفظ الدراسة داخل الملف مستقلة عن التصدير. توثيق نسخة لا يوقع موافقة علاجية ولا يغيّر العلاج أو الحساب.")}</p></header>
    {notice && <p role="status">{t(notice)}</p>}
    {owner.recoveryBlocked && <p role="alert">{t("توجد تعديلات محلية محفوظة لسياق سابق لهذه الحالة. لن يُكشف محتواها لحساب أو مريض أو رابط مختلف، ولن تُستبدل تلقائيًا. عُد للسياق الأصلي بعد التحقق من الصلاحية.")}</p>}
    {owner.uncertain && <div role="alert"><p>{t("نتيجة الطلب السابق غير مؤكدة. لن يُنشأ طلب حفظ جديد ولن تُحذف المسودة.")}</p>
      <button type="button" className={control} disabled={transitionBusy || !ready?.canAppend || !canRetryStudySubmission(recovery) || !owner.canRetry()} onClick={() => void save("draft", true)}>{t("إعادة التحقق بنفس الطلب")}</button></div>}
    {(recovery?.receipt?.state === "blocked" || recovery?.conflict) && <p role="alert">{locale === "ar"
      ? "يوجد طلب حفظ غير محسوم أو تعارض مع المسودة المحلية. بقيت المسودة دون استبدال، والتعديل والحفظ الجديد متوقفان حتى التحقق من الطلب."
      : "An unresolved save or a conflicting local draft requires attention. The local draft was preserved. New edits and saves are blocked until the request is resolved."}</p>}
    {recovery?.receipt?.state === "cancelled" && <p role="status">{locale === "ar" ? "أُلغي طلب الحفظ السابق. أكّد استلام نتيجة الإلغاء قبل متابعة التعديل." : "The previous save request was cancelled. Acknowledge the cancellation before editing."}</p>}
    {canCancel && <button type="button" className={control} disabled={transitionBusy} onClick={() => void cancelSubmission()}>
      {recovery?.receipt?.state === "cancelled" ? (locale === "ar" ? "تأكيد استلام نتيجة الإلغاء" : "Acknowledge cancellation") : (locale === "ar" ? "إلغاء طلب الحفظ المعلّق" : "Cancel pending save request")}
    </button>}
    {currentView?.state === "metadata" && <p role="alert">{locale === "ar" ? "قراءة محتوى الدراسة مقيّدة حاليًا. لم يُعرض المحتوى السريري أو المسودة المحلية؛ تظهر فقط إجراءات الطلب المصرّح بها." : "Study content is currently restricted. Clinical content and the local draft are hidden. Only independently authorized request actions are shown."}</p>}
    {owner.draftQuarantined && <p role="alert">{locale === "ar" ? "المسودة المحلية محجوبة ومحفوظة دون تغيير. إلغاء الطلب لا يعيد صلاحية عرضها أو تعديلها." : "The local draft is hidden and retained unchanged. Cancelling the request does not restore access to view or edit it."}</p>}
    {canDiscardHiddenDraft && <button type="button" className={control} disabled={transitionBusy} onClick={discardHiddenDraft}>
      {locale === "ar" ? "حذف المسودة المحلية المحجوبة بعد التأكيد" : "Confirm discard of hidden local draft"}
    </button>}
    {recoveryNotice && <p role="alert">{locale === "ar" ? "لم يُؤكد إلغاء الطلب واستلام نتيجته. لن تُحذف المسودة أو يُفترض أن الحفظ أُلغي؛ حدّث القراءة وأعد التحقق." : "Cancellation and acknowledgment were not confirmed. The draft was preserved, and saving was not assumed cancelled. Refresh and recheck."}</p>}
    {view?.owner === owner && view.readVersion === readVersion && view.selected === selected && view.state === "error" && <p role="alert">{view.message && t(view.message)}</p>}
    {!ready && <p role="status">{t("الدراسة غير جاهزة للعرض أو التعديل.")}</p>}
    {!ready && owner.active() && <button type="button" className={control} disabled={transitionBusy || owner.busy} onClick={() => owner.refresh()}>{t("تحديث القراءة دون حذف المسودة")}</button>}
    {ready && <>
      {ready.revision && <OrthoSavedStudyReview locale={locale} owner={owner} readVersion={readVersion} revision={ready.revision} />}
      <div className="flex flex-wrap gap-2 items-center"><label>{t("النسخة المعروضة")}<select aria-label={t("النسخة المعروضة")} className={control} value={selected ?? "latest"}
        disabled={transitionBusy || owner.busy || owner.uncertain || !!recovery?.receipt} onChange={event => { const value = event.currentTarget.value; event.currentTarget.value = selected === null ? "latest" : String(selected); selectRevision(value === "latest" ? null : Number(value)); }}>
        <option value="latest">{t("آخر نسخة محفوظة")}</option>{ready.history.map(row => <option key={row.id} value={row.id}>{t("النسخة")} {row.version} — {t(row.kind === "draft" ? "مسودة" : "موثقة")}</option>)}</select></label>
        <button type="button" className={control} disabled={transitionBusy || owner.busy} onClick={() => owner.refresh()}>{t("تحديث القراءة دون حذف المسودة")}</button></div>
      {ready.revision && <OrthoStudyExportLinks patientId={patientId} orthoCaseId={orthoCaseId} revisionId={ready.revision.id} revisionHash={ready.revision.contentHash} />}
      {owner.draftQuarantined || recovery?.receipt?.state === "blocked" ? null : !draft ? <p role="alert">{t("تعذّر فك المسودة المحلية؛ لم تُستبدل بمحتوى فارغ.")}</p> : <>
        {!ready.canAppend && <p>{t("عرض فقط حسب الصلاحية الحالية.")}</p>}
        <label className="block">{t("سبب حفظ النسخة")}<input dir="auto" aria-label={t("سبب حفظ النسخة")} className={`${control} w-full`} maxLength={500} value={draft.reason} disabled={!editable} onChange={event => change({ ...draft!, reason: event.currentTarget.value })} /></label>
        <label className="block">{t("تعليق الدراسة")}<textarea dir="auto" aria-label={t("تعليق الدراسة")} className={`${control} w-full`} maxLength={4000} value={draft.content.comment} disabled={!editable} onChange={event => change({ ...draft!, content: { ...draft!.content, comment: event.currentTarget.value } })} /></label>
        <div className="flex flex-wrap gap-2"><select aria-label={t("قسم جديد للدراسة")} className={control} value={layout} onChange={event => setLayout(event.currentTarget.value)} disabled={!editable}>{CASE_LAYOUTS.map(item => <option key={item.key} value={item.key}>{studyLayoutTitle(item.key, locale)}</option>)}</select>
          <button type="button" className={control} onClick={addPanel} disabled={!editable}>{t("إضافة القسم")}</button></div>
        <ol className="space-y-3">{draft.content.panels.map((panel, index) => <li key={panel.instanceId} className="min-w-0 rounded border p-3 space-y-2">
          <h3>{studyLayoutTitle(panel.layoutKey, locale)}</h3><label><input type="checkbox" checked={panel.included} disabled={!editable} onChange={event => change({ ...draft!, content: { ...draft!.content, panels: draft!.content.panels.map(value => value.instanceId === panel.instanceId ? { ...value, included: event.currentTarget.checked } : value) } })} />{t("تضمين القسم في العرض")}</label>
          <textarea dir="auto" aria-label={`${t("تعليق")} ${studyLayoutTitle(panel.layoutKey, locale)}`} className={`${control} w-full`} value={panel.comment} maxLength={4000} disabled={!editable}
            onChange={event => change({ ...draft!, content: { ...draft!.content, panels: draft!.content.panels.map(value => value.instanceId === panel.instanceId ? { ...value, comment: event.currentTarget.value } : value) } })} />
          <p className="break-words">{t("المراجع المختارة:")} {panel.sourceKeys.length ? panel.sourceKeys.join("، ") : t("لم يُختر مصدر. لا تُفترض نتائج طبيعية.")}</p>
          <div className="flex flex-wrap gap-2">{([-1, 1] as const).map(direction => <button key={direction} type="button" className={control} disabled={!editable || index + direction < 0 || index + direction >= draft!.content.panels.length}
            onClick={() => { const panels = [...draft!.content.panels]; [panels[index], panels[index + direction]] = [panels[index + direction], panels[index]]; change({ ...draft!, content: { ...draft!.content, panels } }); }}>{t(direction < 0 ? "نقل للأعلى" : "نقل للأسفل")}</button>)}</div>
        </li>)}</ol>
        <label>{t("إضافة المرجع إلى القسم")}<select aria-label={t("إضافة المرجع إلى القسم")} className={`${control} max-w-full`} value={effectiveSourcePanel} onChange={event => setSourcePanel(event.currentTarget.value)} disabled={!editable}>{draft.content.panels.map(panel => <option key={panel.instanceId} value={panel.instanceId}>{studyLayoutTitle(panel.layoutKey, locale)} — {panel.instanceId}</option>)}</select></label>
        <SourcePicker {...props} locale={locale} editable={editable} onChoose={chooseSource} />
        <ul aria-label={t("المراجع المحفوظة في المسودة")}>{draft.content.sources.map(source => <li key={source.key} className="flex flex-wrap gap-2 items-center">
          <span>{studySourceName(source.kind, locale)} #{source.id}{source.version === null ? "" : ` — ${t("نسخة")} ${source.version}`}</span>
          <button type="button" className={control} disabled={!editable} onClick={() => removeSource(source)}>{t("إزالة المرجع واستخداماته من هذه المسودة")}</button>
        </li>)}</ul>
        <OrthoStudyTimepoints content={draft.content} editable={editable} locale={locale} onChange={content => change({ ...draft!, content })} />
        <OrthoStudyImagePicker key={effectiveSourcePanel} scope={{patientId,orthoCaseId,clinicalCaseId}} content={draft.content} panelId={effectiveSourcePanel} editable={editable} onDenied={() => { if (owner.active() && owner.readVersion === readVersion && mounted.current) owner.denied(); }}
          onAttach={(source,panelId,slot,recipe) => {
            if (!mounted.current || !draft || !editable) return false;
            try { const useId = `image_${crypto.randomUUID()}`;
              const changed = change({...draft,content:attachStudyImage(draft.content,source,panelId,slot,recipe,useId)});
              if (changed) setSelectedImage(useId); return changed;
            } catch { return false; }
          }} />
        {!!draft.content.mediaUses.length && <label>الصورة المعروضة / Image to edit<select className={control} aria-label="الصورة المعروضة / Image to edit" value={draft.content.mediaUses.some(u => u.useId === selectedImage) ? selectedImage : draft.content.mediaUses[0].useId} onChange={e => setSelectedImage(e.currentTarget.value)}>
          {draft.content.mediaUses.map((use,i) => <option key={use.useId} value={use.useId}>{i+1} — المستند #{use.documentId} — {use.slotId}</option>)}</select></label>}
        {draft.content.mediaUses.filter(use => use.useId === (draft!.content.mediaUses.some(u => u.useId === selectedImage) ? selectedImage : draft!.content.mediaUses[0]?.useId)).map(use => {
          const panel = draft!.content.panels.find(value => value.images.some(image => image.useId === use.useId));
          const binding = panel?.images.find(image => image.useId === use.useId), slot = panel && binding ? caseLayout(panel.layoutKey)?.images.find(image => image.slotId === binding.slot) : null;
          if (!slot) return <p role="alert" key={use.useId}>{t("إطار الصورة غير متاح؛ لم تُحذف تعديلات الاستخدام.")}</p>;
          return <div key={use.useId} className="space-y-2"><button type="button" className={control} disabled={!editable} onClick={() => change({...draft!,content:detachStudyImage(draft!.content,use.useId)})}>إزالة استخدام الصورة من المسودة / Remove image use</button><OrthoStudyImageEditor ownerKey={props.ownerKey} use={use} frame={{ width: Math.ceil(slot.w * CASE_PAGE.imageDpi), height: Math.ceil(slot.h * CASE_PAGE.imageDpi) }} editable={editable}
            onChange={editImage} requestPreview={props.requestImagePreview ?? (async request => {
              if (!owner.active() || owner.readVersion !== readVersion || !mounted.current) return {ok:false,code:"stale"};
              const result = await fetchStudyImagePreview({patientId,orthoCaseId,clinicalCaseId,ownerKey:props.ownerKey},request);
              if (owner.active() && owner.readVersion === readVersion && mounted.current && !result.ok && result.code === "forbidden") owner.denied();
              return owner.active() && owner.readVersion === readVersion && mounted.current ? result : {ok:false,code:"stale"};
            })} /></div>;
        })}
        <div className="flex flex-wrap gap-2"><button type="button" className={control} disabled={!editable} onClick={() => void save("draft")}>{t("حفظ مسودة الدراسة")}</button>
          <button type="button" className={control} disabled={!canDocument} onClick={() => void save("documented")}>{t("توثيق النسخة المحفوظة نفسها")}</button></div>
        <p>النسخة المصورة الحالية للمراجعة السريرية: نص وصفحات صور مختارة من النسخة المحفوظة. قالب المركز النهائي وإخفاء الهوية للمشاركة لم يكتملَا بعد.</p>
      </>}
    </>}
  </section>;
}
export function SourcePicker(props: OrthoCaseStudyProps & { locale: StudyDisplayLocale; editable: boolean; onChoose(source: StudySourceSelection): void }) {
  const t = (message: StudyMessage) => studyText(props.locale, message);
  const [kind, setKind] = useState<StudySourceKind>("assessment"), [after, setAfter] = useState<number | null>(null);
  const [result, setResult] = useState<{ owner: StudyOwner; key: string; value: ReturnType<typeof readStudyInventoryResponse> } | null>(null), [error, setError] = useState<StudyMessage | null>(null);
  const key = JSON.stringify([kind, after, props.owner.readVersion]);
  useEffect(() => {
    let active = true; const abort = new AbortController(), generation = props.owner.readVersion; setError(null);
    const currentOwner = () => active && props.owner.active() && props.owner.readVersion === generation;
    void (async () => { try {
      const query = new URLSearchParams({ patientId: String(props.patientId), kind }); if (after !== null) query.set("afterId", String(after));
      const response = await fetch(`/api/ortho/${props.orthoCaseId}/case-study/sources?${query}`, { cache: "no-store", credentials: "same-origin", signal: abort.signal });
      if (!currentOwner()) return;
      if (response.status === 401 || response.status === 403) { props.owner.denied(); throw new Error("restricted"); }
      if (!response.ok || !response.headers.get("cache-control")?.includes("no-store")) throw new Error("unavailable");
      const value = readStudyInventoryResponse(await boundedJson(response), props, kind);
      if (currentOwner()) setResult({ owner: props.owner, key, value });
    } catch { if (active) setError("تعذّرت قراءة المراجع أو أن القسم مقيّد؛ لم تُعتبر القائمة فارغة."); } })();
    return () => { active = false; abort.abort(); };
  }, [props.owner, props.patientId, props.orthoCaseId, props.clinicalCaseId, kind, after, key]);
  const current = result?.owner === props.owner && result.key === key ? result.value : null;
  return <fieldset className="min-w-0 rounded border p-3"><legend>{t("اختيار مصدر حقيقي")}</legend>
    <select className={control} aria-label={t("نوع مصدر الدراسة")} value={kind} onChange={event => { setKind(event.currentTarget.value as StudySourceKind); setAfter(null); }}>{AVAILABLE_STUDY_SOURCE_KINDS.map(value => <option key={value} value={value}>{studySourceName(value, props.locale)}</option>)}</select>
    {kind === "space_ledger" && <p>{t("اختر لقطة كاملة واحدة لسجل المسافات وIPR لقسم تحليل المسافة. لا تتضمن قياسات Bolton جديدة أو مسودات، ولا تُحدّث الدراسة المحفوظة تلقائياً.")}</p>}
    {kind === "problem_review" && <p>{t("اختر مراجعة محفوظة للمصدر. تُعرض المشكلة والملاحظة كما وثقهما الطبيب وقت المراجعة، دون استبدالهما بالبيانات الحالية.")}</p>}
    {error && <p role="alert">{t(error)}</p>}{current?.state === "restricted" && <p>{t("هذا النوع من المصادر مقيّد بالصلاحية الحالية.")}</p>}
    {current?.state === "available" && <><ul>{current.choices.map(choice => <li key={choice.id} className="flex flex-wrap gap-2 items-center"><span>{studySourceName(kind, props.locale)} #{choice.id}{choice.version === null ? "" : ` — ${t("نسخة")} ${choice.version}`}</span>
      <button type="button" className={control} disabled={!props.editable || !choice.selection} onClick={() => choice.selection && props.onChoose(choice.selection)}>{t("اختيار")}</button>
      {!choice.selection && <span>{t("المصدر غير متاح بهذه النسخة؛ لا تُفترض بيانات بديلة.")}</span>}</li>)}</ul>
      {!current.choices.length && <p>{t("لا توجد مراجع من هذا النوع في الصفحة الحالية.")}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className={control} disabled={after === null} onClick={() => setAfter(null)}>{t("الصفحة الأولى")}</button>
        <button type="button" className={control} disabled={current.nextAfterId === null} onClick={() => setAfter(current.nextAfterId)}>{t("المراجع التالية")}</button></div></>}
  </fieldset>;
}
