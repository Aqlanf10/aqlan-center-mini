"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { PERIO_SITES } from "@/lib/periodontics";
import type { PerioExamView } from "@/lib/periodontics-db";
import { toothName } from "@/lib/dental";
import { PeriodonticsWorkspaceController, workspacePending, type WorkspaceContext } from "./workspace-controller";
import { changedDraftCells, displayedTeeth, draftCoverage, editorDraft, editorIsDirty, eligibleCases, parseDepthText, type PerioCaseOption, type PerioInputSite } from "./workspace-model";

export interface PeriodonticsWorkspaceProps extends WorkspaceContext {
  patientName: string;
  /** The caller must change this key whenever identity or clinical authority changes. */
  authorityKey: string;
  doctors: readonly { id: number; name: string }[];
  cases: readonly PerioCaseOption[];
  contextError?: string | null;
  onRetryContext?: () => void;
  visibleToothCodes?: readonly number[];
  onDraftChange?: (pending: boolean) => void;
  onNavigationGuardChange?: (guard: (() => boolean) | null) => void;
  onBusyChange?: (busy: boolean) => void;
  /** Refresh only persisted summaries; do not remount the patient shell or discard other drafts. */
  onPersisted?: (exam: PerioExamView) => void | Promise<void>;
}
const inputClass = "w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 disabled:bg-slate-50 disabled:text-slate-600 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100";
const buttonClass = "rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const dateText = (date: string | null | undefined) => {
  if (!date) return "غير مسجّل";
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleString("ar", { dateStyle: "medium", timeStyle: "short" });
};
const bopText = (value: boolean | null | undefined) => value === true ? "نعم" : value === false ? "لا" : "غير مسجّل";
const cellText = (cell: PerioInputSite | null) => cell ? `PD: ${cell.depthText || "غير مسجّل"}؛ BOP: ${bopText(cell.bleedingOnProbing)}` : "لا يوجد موضع محفوظ";

/** Ordinary patient navigation is guarded; authority revocation must remount immediately for privacy. */
export function PeriodonticsWorkspace(props: PeriodonticsWorkspaceProps) {
  return <Workspace key={`${props.patientId}:${props.authorityKey}:${props.editable}`} {...props} />;
}
export default PeriodonticsWorkspace;

function Workspace(props: PeriodonticsWorkspaceProps) {
  const { patientId, currentVisit, editable, contextStatus, onDraftChange, onBusyChange, onNavigationGuardChange, onPersisted } = props;
  const [controller] = useState(() => new PeriodonticsWorkspaceController(props));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [showRetained, setShowRetained] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const callbacks = useRef({ onDraftChange, onBusyChange });
  const prefix = useId();
  const pending = workspacePending(state);
  const guard = useCallback(() => {
    const snapshot = controller.getSnapshot();
    if (snapshot.busy) { window.alert("انتظر اكتمال الطلب قبل تغيير السياق."); return false; }
    return !workspacePending(snapshot) || window.confirm("توجد تعديلات غير محفوظة في اللثة. هل تريد المتابعة؟ ستُفقد المسودة إذا غادرت مساحة اللثة.");
  }, [controller]);
  useEffect(() => { controller.activate(); void controller.load(); return () => controller.dispose(); }, [controller]);
  useEffect(() => { controller.setContext({ patientId, currentVisit, editable, contextStatus }); }, [controller, patientId, currentVisit, editable, contextStatus]);
  useEffect(() => {
    const publish = () => { const snapshot = controller.getSnapshot(); onDraftChange?.(workspacePending(snapshot)); onBusyChange?.(!!snapshot.busy); };
    publish(); return controller.subscribe(publish);
  }, [controller, onDraftChange, onBusyChange]);
  useEffect(() => { onNavigationGuardChange?.(guard); return () => onNavigationGuardChange?.(null); }, [guard, onNavigationGuardChange]);
  useEffect(() => { callbacks.current = { onDraftChange, onBusyChange }; }, [onDraftChange, onBusyChange]);
  useEffect(() => () => { callbacks.current.onDraftChange?.(false); callbacks.current.onBusyChange?.(false); }, []);
  useEffect(() => {
    if (!pending && !state.busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload); return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [pending, state.busy]);
  useEffect(() => {
    controller.setPersistedListener((exam) => { void Promise.resolve(onPersisted?.(exam)).catch(() => undefined); });
    return () => controller.setPersistedListener(undefined);
  }, [controller, onPersisted]);

  const currentExam = state.exams.find((exam) => exam.visitId === state.anchorVisit?.id) ?? null;
  const selectedExam = state.selected === "current" ? currentExam : state.exams.find((exam) => exam.id === state.selected) ?? null;
  const history = state.selected !== "current";
  const accessEnded = state.access === "denied" || state.access === "unavailable";
  const staleRead = state.access === "stale";
  const signed = !!selectedExam?.signedAt || (!history && !!state.anchorVisit?.signedAt);
  const draft = history || signed ? editorDraft(selectedExam, null) : state.draft;
  const editing = !history && controller.canEdit() && props.contextStatus === "ready" && props.editable;
  const coverage = draftCoverage(draft);
  const visible = displayedTeeth(props.visibleToothCodes, draft, showRetained || history);
  const hiddenTeeth = [...new Set(draft.sites.map((site) => site.toothCode))].filter((tooth) => !visible.includes(tooth));
  const choices = eligibleCases(props.cases, props.patientId);
  const invalid = draft.sites.filter((site) => !parseDepthText(site.depthText).ok);
  const dirty = editorIsDirty(state.draft, state.baseline);
  const addendum = selectedExam ? state.addenda[selectedExam.id] : undefined;
  const conflictCells = changedDraftCells(state.draft, currentExam);
  const runSave = () => { controller.setContext(props); void controller.save(); };
  const safeSwitch = (selected: "current" | number) => { if (guard()) { controller.select(selected); setReviewed(false); } };

  return <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3 sm:p-4" dir="rtl" aria-label="مساحة فحص اللثة">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-base font-bold text-slate-900">فحص اللثة <span className="text-xs font-normal text-slate-500">PD / BOP</span></h2>
        <p className="mt-1 text-xs text-slate-500">{props.patientName} · ملف {props.patientId} · {accessEnded ? "سياق سجل اللثة غير متاح" : history ? `زيارة ${selectedExam?.visitId ?? "—"}` : state.anchorVisit ? `الزيارة الحالية ${state.anchorVisit.id} · ${dateText(state.anchorVisit.date)}` : "لا توجد زيارة حالية محددة"}</p>
      </div>
      <div className="flex items-center gap-2 text-xs"><span className={`rounded-full px-2.5 py-1 ${accessEnded ? "bg-rose-50 text-rose-800" : staleRead ? "bg-amber-50 text-amber-800" : signed ? "bg-slate-100 text-slate-700" : dirty ? "bg-amber-50 text-amber-800" : "bg-teal-50 text-teal-800"}`}>{accessEnded ? (state.access === "denied" ? "الوصول مرفوض" : "السجل غير متاح") : staleRead ? "نسخة سابقة للقراءة فقط" : !state.loaded ? "السجل غير متحقق" : history ? "عرض تاريخي" : signed ? "فحص موقّع" : dirty ? "مسودة غير محفوظة" : currentExam ? `محفوظ · إصدار ${currentExam.revision}` : "لم يُحفظ فحص"}</span>
        <button type="button" className={buttonClass} disabled={!!state.busy || accessEnded} onClick={() => { setReviewed(false); void controller.load(); }}>تحديث السجل</button>
      </div>
    </header>

    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-2">
      <label className="text-xs font-semibold" htmlFor={`${prefix}-exam`}>الفحص</label>
      <select id={`${prefix}-exam`} className={`${inputClass} max-w-lg`} value={state.selected} disabled={!!state.busy || accessEnded} onChange={(event) => safeSwitch(event.target.value === "current" ? "current" : Number(event.target.value))}>
        <option value="current">{accessEnded ? "سجل اللثة غير متاح" : `الزيارة الحالية ${state.anchorVisit ? `#${state.anchorVisit.id}` : "غير محددة"}`}</option>
        {state.exams.map((exam) => <option key={exam.id} value={exam.id}>{dateText(exam.recordedAt)} · زيارة #{exam.visitId} · {exam.doctorName} · {exam.signedAt ? "موقّع" : "للقراءة"}</option>)}
      </select>
      {!!state.busy && <span role="status" className="text-xs text-slate-600">{state.busy === "load" ? "تحميل السجل…" : state.busy === "save" ? "التحقق من حفظ الفحص…" : "التحقق من حفظ الملحق…"}</span>}
    </div>
    {props.contextStatus !== "ready" && <div role={props.contextStatus === "error" ? "alert" : "status"} className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
      {props.contextStatus === "loading" ? "جارٍ تحميل سياق الزيارة والأطباء والحالات؛ إدخال البيانات متوقف حتى اكتماله." : props.contextError || "تعذّر تحميل سياق الزيارة. لا يمكن اختيار زيارة أو طبيب أو حالة حتى نجاح التحميل."}
      {props.contextStatus === "error" && props.onRetryContext && <button type="button" className={`${buttonClass} mr-2`} onClick={props.onRetryContext}>إعادة تحميل السياق</button>}
    </div>}
    {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{state.error}</p>}
    {staleRead && <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">تعذّر تحديث السجل. المعروض نسخة سابقة ومسودات محلية للقراءة فقط؛ استخدم «تحديث السجل» قبل أي تعديل أو إعادة محاولة.</p>}
    {state.notice && <p role="status" className="rounded-xl bg-sky-50 p-2.5 text-xs text-sky-900">{state.notice}</p>}
    {state.staleContext && <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      تغيّر سياق الزيارة. المسودة باقية مرتبطة بالزيارة #{state.anchorVisit?.id ?? "—"} وإصدارها الأصلي؛ الحفظ متوقف.
      <button type="button" className={`${buttonClass} mr-2`} disabled={!!state.busy || props.contextStatus !== "ready"} onClick={() => { if (guard()) { controller.adoptContext(); setReviewed(false); } }}>ترك المسودة وفتح السياق الحالي</button>
    </div>}
    {!state.loaded && !state.busy && !accessEnded && <p className="text-sm text-slate-500">لم يُحمّل سجل اللثة بعد. استخدم «تحديث السجل» قبل الإدخال.</p>}
    {!history && signed && dirty && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">الجدول يعرض أصل الفحص الموقّع فقط. مسودتك السابقة ما زالت محفوظة محليًا ولم تُطبّق على الأصل؛ راجع الفروق قبل تركها.</p>}
    {state.loaded && <>
      {selectedExam && <p className="text-xs leading-6 text-slate-500">سُجّل {dateText(selectedExam.recordedAt)} بواسطة {selectedExam.recordedBy} · المعالج: {selectedExam.doctorName} · {selectedExam.caseTitle || "دون حالة مرتبطة"}
        {selectedExam.updatedAt && ` · آخر تعديل ${dateText(selectedExam.updatedAt)} بواسطة ${selectedExam.updatedBy ?? "غير مسجّل"}`}
        {selectedExam.signedAt && ` · توقيع ${selectedExam.signedBy ?? "غير مسجّل"} في ${dateText(selectedExam.signedAt)}`}</p>}
      {!history && <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-semibold text-slate-600">الطبيب المعالج الفعلي
          <select className={inputClass} aria-label="الطبيب المعالج الفعلي" value={draft.doctorId ?? ""} disabled={!editing} onChange={(event) => controller.changeContext({ doctorId: event.target.value ? Number(event.target.value) : null })}>
            <option value="">اختر الطبيب المعالج</option>
            {draft.doctorId !== null && !props.doctors.some((doctor) => doctor.id === draft.doctorId) && <option value={draft.doctorId}>{currentExam?.doctorName ?? `طبيب #${draft.doctorId}`} (من السجل)</option>}
            {props.doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs font-semibold text-slate-600">حالة اللثة المرتبطة (اختياري)
          <select className={inputClass} aria-label="حالة اللثة المرتبطة" value={draft.caseId === undefined ? "" : draft.caseId === null ? "none" : draft.caseId} disabled={!editing || state.anchorVisit?.caseId !== null} onChange={(event) => controller.changeContext({ caseId: event.target.value === "" ? undefined : event.target.value === "none" ? null : Number(event.target.value) })}>
            <option value="">اختر حالة أو دون ارتباط</option><option value="none">دون حالة مرتبطة</option>
            {typeof draft.caseId === "number" && !choices.some((item) => item.id === draft.caseId) && <option value={draft.caseId}>{currentExam?.caseTitle ?? props.cases.find((item) => item.id === draft.caseId)?.title ?? `حالة #${draft.caseId}`} (السياق الحالي)</option>}
            {choices.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </label>
      </div>}
      {!history && !state.anchorVisit && <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">اختر زيارة موجودة لهذا المريض من مساحة الزيارة. لا ينشئ فحص اللثة زيارة أو حالة تلقائيًا.</p>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600" aria-label="تغطية التسجيل">
        <span>PD مسجّل: <strong>{coverage.recordedDepthSites}</strong> موضعًا</span><span>BOP مسجّل: <strong>{coverage.recordedBleedingSites}</strong> موضعًا</span>
        <span>نزف: <strong>{coverage.bleedingSites}</strong> من {coverage.recordedBleedingSites} ({coverage.bleedingPercent === null ? "غير مسجّل" : `${coverage.bleedingPercent.toFixed(1)}%`})</span>
        {hiddenTeeth.length > 0 && <button type="button" className="font-semibold text-teal-700 underline" onClick={() => setShowRetained(true)}>عرض {hiddenTeeth.length} أسنان أخرى محفوظة ضمن المسودة</button>}
      </div>
      <p id={`${prefix}-help`} className="text-xs text-slate-500">كل موضع: عمق الجيب بالملليمتر ثم النزف. الفارغ = غير مسجّل؛ 0 و«لا» قيمتان مسجّلتان. Tab للتنقل بين الخلايا. الأرقام العربية والفاصل «٫» يظهران بصيغة 0–9 و«.» دون تقريب. التسجيل وصفي ولا ينتج تشخيصًا أو إجراءً أو فاتورة.</p>
      <div className="max-h-[26rem] overflow-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[660px] border-collapse text-center text-xs" aria-describedby={`${prefix}-help`}>
          <caption className="sr-only">قياسات اللثة بستة مواضع لكل سن؛ كل خلية تحتوي عمق الجيب والنزف</caption>
          <thead className="sticky top-0 z-10 bg-slate-100 text-slate-600"><tr><th scope="col" className="p-2">السن</th>{PERIO_SITES.map((site) => <th scope="col" key={site} className="p-2" dir="ltr">{site}</th>)}</tr></thead>
          <tbody>{visible.map((toothCode) => <tr key={toothCode} className="border-t border-slate-100 even:bg-slate-50/50">
            <th scope="row" className="w-12 px-2 font-bold text-slate-700" title={toothName(toothCode)}>{toothCode}</th>
            {PERIO_SITES.map((site) => {
              const cell = draft.sites.find((item) => item.toothCode === toothCode && item.site === site);
              const depth = cell?.depthText ?? "";
              const valid = parseDepthText(depth).ok;
              return <td key={site} className="min-w-24 p-1.5">
                {editing ? <div className="space-y-1">
                  <input type="text" inputMode="decimal" dir="ltr" autoComplete="off" className={`${inputClass} text-center ${valid ? "" : "border-rose-400 bg-rose-50"}`} value={depth}
                    aria-label={`عمق الجيب السن ${toothCode} ${site}`} aria-invalid={!valid} placeholder="—" maxLength={12}
                    onChange={(event) => controller.changeSite(toothCode, site, { depthText: event.target.value })} />
                  <select className={`${inputClass} !py-1 !text-xs`} aria-label={`النزف السن ${toothCode} ${site}`} value={cell?.bleedingOnProbing === true ? "yes" : cell?.bleedingOnProbing === false ? "no" : "unrecorded"}
                    onChange={(event) => controller.changeSite(toothCode, site, { bleedingOnProbing: event.target.value === "yes" ? true : event.target.value === "no" ? false : null })}>
                    <option value="unrecorded">غير مسجّل</option><option value="no">لا</option><option value="yes">نعم</option>
                  </select>
                </div> : <div className="space-y-1 py-1"><span className="block font-medium" dir="ltr">{depth || "—"}</span><span className="block text-[11px] text-slate-500">{bopText(cell?.bleedingOnProbing)}</span></div>}
              </td>;
            })}
          </tr>)}</tbody>
        </table>
        {visible.length === 0 && <p className="p-3 text-center text-sm text-slate-500">لا توجد أسنان معروضة في السياق الحالي؛ لا تُحذف القياسات المحفوظة.</p>}
      </div>
      {invalid.length > 0 && <p role="alert" className="text-xs text-rose-700">{invalid.length} مواضع غير صالحة. أدخل 0–99.99 بمنزلتين عشريتين كحد أقصى؛ لا يجري تقريب القيم تلقائيًا.</p>}
      {!history && state.recovery && <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
        <p className="font-bold">المسودة لم تُستبدل. {state.recovery === "reload" ? "يجب تحميل السجل قبل إعادة المحاولة." : "راجع النسخة المحفوظة مقارنةً بمسودتك."}</p>
        {state.recovery === "review" && <>
          <p>المحفوظ: إصدار {currentExam?.revision ?? "لا يوجد فحص"} · المعالج {currentExam?.doctorName ?? "—"} · الحالة {currentExam?.caseTitle ?? "دون ارتباط"}</p>
          <p>المسودة: إصدار أساس {state.draft.expectedRevision ?? "جديد"} · معالج #{state.draft.doctorId ?? "غير محدد"} · حالة {state.draft.caseId ?? "دون ارتباط"}</p>
          <ul className="max-h-36 space-y-1 overflow-auto">{conflictCells.map((cell) => <li key={cell.identity}><strong dir="ltr">{cell.identity}</strong> · المحفوظ: {cellText(cell.saved)} · المسودة: {cellText(cell.draft)}</li>)}</ul>
          {conflictCells.length === 0 && <p>لا يوجد اختلاف في خلايا القياس. راجع الطبيب والحالة والتوقيع والإصدار.</p>}
          <label className="flex items-center gap-2"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />راجعت النسخة المحفوظة والفروق</label>
          <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!reviewed || !!state.busy || signed || state.staleContext} onClick={() => { controller.useReviewedRevision(); setReviewed(false); }}>اعتماد الإصدار لمسودتي دون حفظ</button>
            <button type="button" className={buttonClass} disabled={!!state.busy} onClick={() => { if (guard()) { controller.discardDraft(); setReviewed(false); } }}>ترك المسودة واستخدام المحفوظ</button></div>
        </>}
      </div>}
      {!history && <footer className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">{signed ? "أصل الفحص للقراءة فقط. التصحيح بملحق مستقل أدناه." : "حفظ الفحص منفصل عن توقيع الزيارة. التوقيع يراجع العمل المحفوظ فقط."}</p>
        {!signed && <button type="button" className="rounded-xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50" disabled={!editing || !dirty || invalid.length > 0} onClick={runSave}>حفظ فحص اللثة</button>}
      </footer>}
      {selectedExam?.signedAt && <section className="space-y-2 border-t border-slate-100 pt-3" aria-label="ملاحق الفحص الموقّع">
        <h3 className="text-sm font-bold text-slate-800">ملاحق الفحص</h3>
        {selectedExam.addenda.length === 0 && <p className="text-xs text-slate-500">لا توجد ملاحق محفوظة.</p>}
        {selectedExam.addenda.map((item) => <article key={item.id} className="rounded-xl bg-slate-50 p-3"><p className="whitespace-pre-wrap break-words text-sm text-slate-800">{item.body}</p><p className="mt-1 text-xs text-slate-500">{item.author} · {dateText(item.createdAt)} · ملحق #{item.id}</p></article>)}
        {props.editable && <div className="space-y-2">
          <label className="block text-xs font-semibold text-slate-600" htmlFor={`${prefix}-addendum`}>إضافة توضيح أو تصحيح دون تغيير الأصل</label>
          <textarea id={`${prefix}-addendum`} className={inputClass} rows={3} maxLength={4000} value={addendum?.text ?? ""}
            disabled={!!state.busy || state.access !== "ready" || state.staleContext || state.writeBlocked || props.contextStatus !== "ready" || !!addendum?.attemptedText}
            onChange={(event) => controller.changeAddendum(selectedExam.id, event.target.value)} />
          {addendum?.attemptedText && <p className="text-xs text-amber-800">هذه محاولة لم تُؤكّد بعد. النص ثابت، وإعادة المحاولة تستخدم مفتاح الطلب نفسه؛ لا تعتمد على تشابه نص ملحق ظاهر.</p>}
          <button type="button" className={buttonClass} disabled={!!state.busy || state.access !== "ready" || state.staleContext || state.writeBlocked || props.contextStatus !== "ready" || !addendum?.text.trim() || addendum.needsReload || addendum.blocked}
            onClick={() => { controller.setContext(props); void controller.saveAddendum(selectedExam.id); }}>{addendum?.attemptedText ? "إعادة التحقق من الملحق نفسه" : "حفظ الملحق"}</button>
        </div>}
      </section>}
    </>}
  </section>;
}
