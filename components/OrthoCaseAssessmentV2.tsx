"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSession } from "./SessionProvider";
import { OrthoAssessmentFindingsV2 } from "./OrthoAssessmentFindingsV2";
import { OrthoAssessmentMeasurementsV2 } from "./OrthoAssessmentMeasurementsV2";
import { readAssessmentResponseV2 } from "@/lib/ortho-assessment-client-v2";
import { newAssessmentEditorV2, readAssessmentEditorV2, assessmentEditorCommandV2, type AssessmentEditorV2 } from "@/lib/ortho-assessment-editor-v2";
import { assessmentSaveFeedbackV2 } from "@/lib/ortho-assessment-save-feedback-v2";
import type { AssessmentOwnerV2 } from "@/lib/ortho-assessment-owner-v2";
import type { AssessmentReadResponseV2, AssessmentSaveExpectationV2 } from "@/lib/ortho-assessment-response-v2";
import { editMeasurementPayloadV2 } from "@/lib/ortho-assessment-measurement-editor-v2";
import { decodeOrthoRecordDocuments, type OrthoRecordDocument } from "@/lib/ortho-records";
import { OrthoPanoramicReview } from "./OrthoPanoramicReview";
import OrthoSavedClinicalFindings from "./OrthoSavedClinicalFindings";
import OrthoSavedModelReview from "./OrthoSavedModelReview";
import { plain } from "@/lib/ortho-assessment-model";
export interface AssessmentLifetimeV2 {
  identity: object; active(): boolean; editable(): boolean; denied(): void;
  busy: boolean; uncertain: boolean; dirty: boolean; readVersion: number;
  values: { document: string }; change(field: "document", value: string): void;
  settle(field: "document", value: string): void; refresh(): void;
  begin(expected: AssessmentSaveExpectationV2): ReturnType<AssessmentOwnerV2["begin"]>;
  beginRetry(expected: AssessmentSaveExpectationV2): ReturnType<AssessmentOwnerV2["beginRetry"]>;
}
export interface OrthoCaseAssessmentV2Props {
  patientId: number; orthoCaseId: number; clinicalCaseId?: number; lifetime?: AssessmentLifetimeV2;
  sectionView?: "interview" | "extraoral" | "intraoral" | "measurements" | "radiographs";
}
const control = "min-h-11 min-w-11 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-40";
/** Read every preserved scalar, including legacy fields unsupported by this editor.
 * No legacy field becomes a fabricated schema2 observation. */
function SavedFields({ value, path = "" }: { value: unknown; path?: string }) {
  if (value === null || typeof value !== "object") return <p className="break-words text-xs"><strong>{path}: </strong>{value === null ? "غير مسجل" : String(value)}</p>;
  return <>{Object.entries(value).map(([key, child]) => <SavedFields key={key} value={child} path={path ? `${path} / ${key}` : key} />)}</>;
}
export function OrthoCaseAssessmentV2(props: OrthoCaseAssessmentV2Props) {
  const session = useSession();
  // Do not mount a read lifetime or retain a rendered clinical snapshot for a
  // non-clinical session. The server independently enforces the same boundary.
  if (session?.role !== "admin" && session?.role !== "doctor") return null;
  const authority = JSON.stringify([session?.userId, session?.username, session?.role, session?.permissions ?? null]);
  return <Workspace key={`${props.patientId}:${props.orthoCaseId}:${props.clinicalCaseId ?? "unresolved"}:${authority}`} {...props} />;
}
function Workspace({ patientId, orthoCaseId, clinicalCaseId, lifetime, sectionView }: OrthoCaseAssessmentV2Props) {
  const owner = useMemo(() => ({}), [lifetime?.identity]);
  const committedOwner = useRef<object | null>(null);
  useLayoutEffect(() => {
    committedOwner.current = owner;
    return () => { if (committedOwner.current === owner) committedOwner.current = null; };
  }, [owner]);
  const latest = useRef(lifetime);
  useLayoutEffect(() => { latest.current = lifetime; }, [lifetime]);
  const [selected, setSelected] = useState<number>();
  const [reload, setReload] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [showSaveFeedback, setShowSaveFeedback] = useState(false);
  const readVersion = lifetime?.readVersion ?? 0;
  const generation = useMemo(() => ({ owner, selected, reload, readVersion, sectionView }), [owner, selected, reload, readVersion, sectionView]);
  // Only the committed view may act. A persistent parent owner can outlive this
  // Workspace; matching case IDs or restored permissions never revive callbacks.
  const committedGeneration = useRef<object | null>(null);
  useLayoutEffect(() => {
    committedGeneration.current = generation;
    return () => { if (committedGeneration.current === generation) committedGeneration.current = null; };
  }, [generation]);
  const currentView = () => committedOwner.current === owner && committedGeneration.current === generation
    && latest.current?.identity === lifetime?.identity && (!lifetime || lifetime.active());
  // Same-generation callbacks must also own the exact draft bytes they rendered.
  const currentDraft = () => currentView() && latest.current?.values.document === lifetime?.values.document;
  const [read, setRead] = useState<{ generation: object; data: AssessmentReadResponseV2 | null; error: string | null; panoramic?: OrthoRecordDocument[]; panoramicError?: string } | null>(null);
  const data = read?.generation === generation ? read.data : null;
  const error = read?.generation === generation ? read.error : null;
  const draft = readAssessmentEditorV2(lifetime?.values.document ?? "");
  const savedSummary = data?.state === "ready" && data.revision?.schemaVersion === 2 ? editMeasurementPayloadV2(data.revision.content.draft) : null;
  const malformed = !!lifetime?.values.document && !draft;
  const stale = !!draft && !!data && draft.expectedRevisionId !== (data.history[0]?.id ?? null);
  const writable = !!lifetime && lifetime.active() && lifetime.editable() && data?.state === "ready" && data.clinicalWritable;
  const editable = !!writable && !stale;
  const saveFeedback = showSaveFeedback && draft && editable ? assessmentSaveFeedbackV2(draft) : [];
  useEffect(() => {
    const life = latest.current, controller = new AbortController(); let live = true;
    const current = () => live && committedOwner.current === owner && committedGeneration.current === generation
      && !controller.signal.aborted && (!life || life.active());
    const timer = setTimeout(() => { if (current()) { setRead({ generation, data: null, error: "تعذرت القراءة؛ لم يُعتبر السجل فارغًا." }); controller.abort(); } }, 15000);
    void (async () => {
      try {
        const response = await fetch(`/api/ortho/${orthoCaseId}/assessment?acceptSchema=1,2${selected === undefined ? "" : `&revisionId=${selected}`}`, { cache: "no-store", signal: controller.signal });
        if (!current()) return;
        if ([401, 403].includes(response.status)) { life?.denied(); throw Error("التقييم أو مصادره محجوبة بالصلاحية الحالية."); }
        if (!response.ok || response.redirected) throw Error("تعذّر التحقق من التقييم؛ حدّث السجل قبل التحرير.");
        const raw: unknown = await response.json(); if (!current()) return;
        const accepted = await readAssessmentResponseV2(raw, { patientId, orthoCaseId, clinicalCaseId, revisionId: selected });
        if (!current()) return;
        if (!accepted) throw Error("تعذّر التحقق من هوية السجل أو بصمة نتائجه.");
        let panoramic: OrthoRecordDocument[] = [], panoramicError: string | undefined;
        if ((sectionView === undefined || sectionView === "radiographs") && accepted.state === "ready" && accepted.sources.imaging === "allowed") {
          try {
            const documents = await fetch(`/api/patients/${patientId}/documents`, { cache: "no-store", signal: controller.signal });
            if (!current()) return;
            if ([401, 403].includes(documents.status)) { life?.denied(); throw Error("مراجع الصور محجوبة بالصلاحية الحالية."); }
            if (!documents.ok || documents.redirected) throw Error("تعذر تحميل أصل البانوراما؛ لم يُعتبر السجل فارغاً.");
            const payload: unknown = await documents.json(); if (!current()) return;
            panoramic = decodeOrthoRecordDocuments(payload, patientId).filter(d => d.orthoCaseId === orthoCaseId && d.photoView === "panoramic");
          } catch (error) { if (!current()) return; panoramicError = error instanceof Error ? error.message : "تعذر تحميل الصورة."; }
        }
        if (!current()) return;
        setRead({ generation, data: accepted, error: null, panoramic, panoramicError });
      } catch (caught) { if (current()) setRead({ generation, data: null, error: caught instanceof Error ? caught.message : "تعذرت القراءة." }); }
      finally { clearTimeout(timer); }
    })();
    return () => { live = false; controller.abort(); clearTimeout(timer); };
  }, [generation, owner, patientId, orthoCaseId, clinicalCaseId, selected, sectionView]);
  const change = (next: AssessmentEditorV2) => { if (currentDraft() && editable && lifetime?.active() && latest.current?.editable()) lifetime.change("document", JSON.stringify(next)); };
  function begin() {
    if (!currentDraft() || !writable || !data || !lifetime || draft || malformed || data.revision?.id !== data.history[0]?.id) return;
    const next = newAssessmentEditorV2(crypto.randomUUID(), data.revision);
    if (!next) { setMessage("هذه نسخة تاريخية بالإصدار الأول. يلزم إجراء ترقية صريح يحافظ على القيم ومصادرها؛ لم تُحوّل إلى نموذج فارغ."); return; }
    lifetime.settle("document", JSON.stringify(next)); setMessage(null); setShowSaveFeedback(false);
  }
  async function save(retry = false) {
    if (!currentDraft() || !lifetime || !draft || data?.state !== "ready" || !data.clinicalWritable || committedOwner.current !== owner || !lifetime.active()
      || lifetime.busy || (!retry && !editable) || retry && !lifetime.uncertain) return;
    const command = assessmentEditorCommandV2(draft);
    if (!command) { setShowSaveFeedback(true); return; }
    const expected = { scope: { patientId, orthoCaseId, clinicalCaseId: data.clinicalCaseId }, command, previousVersion: draft.previousVersion };
    const lease = retry ? lifetime.beginRetry(expected) : lifetime.begin(expected); if (!lease) return;
    setShowSaveFeedback(false);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    let confirmed = false;
    const say = (text: string) => { if (currentView()) setMessage(text); };
    try {
      const response = await fetch(`/api/ortho/${orthoCaseId}/assessment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: lease.body, signal: controller.signal });
      if (!lease.current() || !lease.checkHeaders(response)) return;
      if (response.redirected || response.status >= 500 || !response.ok && ![400, 404, 409, 413].includes(response.status)) {
        lease.markUncertain(); say("نتيجة الحفظ غير مؤكدة. أعد نفس الطلب فقط لتسويته."); return;
      }
      const raw: unknown = await response.json(); if (!lease.current()) return;
      if (!response.ok) {
        if (plain(raw) && typeof raw.message === "string") { lease.refuse(response.status); say(raw.message); }
        else { lease.markUncertain(); say("رد الرفض غير قابل للتحقق؛ بقي الطلب محفوظًا."); }
        if (response.status === 409 && currentView()) setReload(value => value + 1);
        return;
      }
      confirmed = await lease.confirmResponse(raw, response.status);
      if (!confirmed) { lease.markUncertain(); say("رد الحفظ لا يثبت النسخة المطلوبة؛ بقيت المسودة والطلب دون تغيير."); }
    } catch { if (lease.current()) { lease.markUncertain(); say("قد يكون الحفظ تم رغم فقد الرد. أعد التحقق بنفس الطلب فقط."); } }
    finally {
      clearTimeout(timer); const current = lease.current(); lease.finish();
      if (current && confirmed && currentView()) { setSelected(undefined); setReload(value => value + 1); setMessage("حُفظت مراجعة موثقة؛ جارٍ إعادة قراءة القيم والنتائج المحفوظة."); }
    }
  }
  if (lifetime && !lifetime.active()) return <p role="status">السياق أو الصلاحية غير صالحين؛ التقييم محجوب حتى إعادة التحقق.</p>;
  return <section dir="rtl" data-testid="ortho-case-assessment-v2" aria-label="التقييم والقياسات المحفوظة" className="min-w-0 space-y-4 rounded-xl border bg-white p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">التقييم وقياسات الحالة</h3>
      <button type="button" className={control} disabled={!!lifetime?.busy} onClick={() => { if (currentView() && !latest.current?.busy) setReload(value => value + 1); }}>تحديث سجل التقييم</button></div>
    <p className="text-xs">توثيق الحالة ونتائج حسابية غير معتمدة سريريًا. الحفظ لا ينشئ خطة أو فاتورة ولا يغيّر التاريخ الطبي العام.</p>
    {!lifetime && <p role="status">عرض للقراءة فقط؛ حماية مسودة الحالة غير موصولة.</p>}
    {!data && !error && <p role="status">جارٍ التحقق من السجل وبصماته…</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {malformed && <p role="alert">المسودة غير قابلة للقراءة؛ لم تُستبدل بنموذج فارغ.</p>}
    {data?.state === "bridge_missing" && <p role="status">الرابط السريري غير موجود. يلزم الربط الصريح؛ لا تُستنتج حالة جديدة من غياب الزيارات.</p>}
    {data?.state === "ready" && <>
      <p className="text-xs">المريض #{patientId} · التقويم #{orthoCaseId} · الحالة السريرية #{data.clinicalCaseId}</p>
      {data.recordingContext === "retrospective" && <p>توثيق لاحق لحالة سابقة؛ لا يعيد فتح العلاج.</p>}
      {!!data.history.length && <label className="block">نسخة التقييم<select className={`${control} w-full`} value={selected ?? data.history[0].id}
        disabled={!!draft || !!lifetime?.busy || !!lifetime?.uncertain} onChange={event => { if (currentDraft() && !draft && !latest.current?.busy && !latest.current?.uncertain) setSelected(Number(event.target.value)); }}>
        {data.history.map(row => <option key={row.id} value={row.id}>نسخة {row.version} · {row.createdAt.slice(0, 10)} · {row.createdBy}</option>)}</select></label>}
      {!draft && !malformed && data.revision?.schemaVersion !== 1 && <button className={control} type="button" disabled={!writable || data.revision?.id !== data.history[0]?.id} onClick={begin}>
        {data.revision ? "فتح مراجعة تصحيحية من النسخة الحالية" : "بدء تقييم غير معبأ"}</button>}
      {(sectionView === undefined || sectionView === "measurements") && data.state === "ready" && data.revision && <OrthoSavedModelReview data={data} expected={{patientId, orthoCaseId, clinicalCaseId: data.clinicalCaseId, revisionId: data.revision.id}}/>}
      {data.revision && (sectionView === undefined || sectionView === "interview" || sectionView === "extraoral" || sectionView === "intraoral") && <OrthoSavedClinicalFindings revision={data.revision} section={sectionView} sourceStates={data.sourceStates} />}
      {data.revision ? <details className="rounded-lg border p-3" data-testid="assessment-v2-saved"><summary className="min-h-11 cursor-pointer">السجل المحفوظ: نسخة {data.revision.version}</summary>
        <p>{data.revision.createdAt} · {data.revision.createdBy} · {data.revision.reason}</p>
        <p className="break-all text-xs">البصمة: {data.revision.contentHash}</p>
        <SavedFields value={data.revision.content} />
      </details> : <p>لم تُسجّل مراجعة لهذه الحالة بعد.</p>}
      {data.sourceStates.map(row => <p className="break-all text-xs" key={`${row.source.kind}:${row.source.id}`}>{row.source.kind} #{row.source.id} · {row.source.version}: {row.state}</p>)}
      {(sectionView === undefined || sectionView === "radiographs") && read?.generation === generation && read.panoramicError && <p role="alert">{read.panoramicError}</p>}
      {(sectionView === undefined || sectionView === "radiographs") && !draft && savedSummary && <details className="space-y-3 rounded-lg border p-3" open={sectionView === "radiographs"}>
        <summary className="min-h-11 cursor-pointer py-3 font-bold">قراءة البانوراما المحفوظة</summary>
        <OrthoPanoramicReview draft={savedSummary} documents={read?.generation === generation ? read.panoramic ?? [] : []} sources={data.sources.items} onChange={() => {}} />
      </details>}
      {data.sources.imaging === "restricted" && <p>مراجع الصور والأشعة مقيدة بالصلاحية الحالية.</p>}
      {data.sources.truncated && <p>قائمة المصادر محدودة؛ غياب مصدر من القائمة لا يعني أنه غير موجود.</p>}
      {data.revision?.schemaVersion === 1 && <p role="status">نسخة تاريخية بالإصدار الأول محفوظة للقراءة. الترقية تحتاج نقلًا صريحًا للقيم ومصادرها؛ لا تحويل تلقائي.</p>}
    </>}
    {lifetime?.uncertain && <div role="alert"><p>الحفظ السابق غير مؤكد. التحرير والمغادرة متوقفان حتى تسوية نفس الطلب.</p>
      <button type="button" className={control} disabled={!data || lifetime.busy || !draft} onClick={() => void save(true)}>التحقق بإعادة نفس طلب الحفظ</button></div>}
    {draft && <div data-testid="assessment-v2-draft" className="space-y-3">
      {stale && <p role="alert">تغير رأس السجل. بقيت المسودة مرتبطة بسابقتها؛ لم تُنقل إلى نسخة جديدة تلقائيًا.</p>}
      <section aria-label="حفظ مسودة التقييم" className="space-y-3 rounded-xl border border-navy-200 bg-navy-50 p-3">
        <p role="status" className="text-sm font-bold text-navy-900">{lifetime?.busy ? "جارٍ حفظ المراجعة…" : lifetime?.uncertain ? "نتيجة الحفظ تحتاج التحقق" : lifetime?.dirty ? "تعديلات غير محفوظة" : "مسودة مفتوحة؛ لم تُحفظ مراجعة جديدة"}</p>
        <p className="text-xs text-slate-600">المقابلة والفحص والقياسات أجزاء من مسودة تقييم واحدة. يحفظ هذا الزر محتواها كله، بما فيه الأقسام غير المعروضة حاليًا.</p>
        {!!saveFeedback.length && <div role="alert" data-testid="assessment-save-feedback" className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <p className="font-bold">قبل الحفظ، أكمل الآتي:</p>
          <ul className="list-inside list-disc space-y-1">{saveFeedback.map((text, index) => <li key={index}>{text}</li>)}</ul>
          <p className="text-xs">مدخلاتك باقية في المسودة. الحقول التي لم تبدأ توثيقها يمكن أن تبقى غير مسجلة.</p>
        </div>}
        <label className="block">سبب إنشاء هذه المراجعة <span className="text-xs text-slate-500">(مطلوب)</span><input aria-label="سبب إنشاء هذه المراجعة" aria-required="true" className={`${control} w-full`} maxLength={500} disabled={!editable} value={draft.reason}
          onChange={event => change({ ...draft, reason: event.target.value })} /></label>
        <div className="flex flex-wrap gap-2"><button type="button" className="min-h-11 min-w-11 rounded-lg border border-navy-800 bg-navy-800 px-3 py-2 text-sm font-bold text-white disabled:opacity-40" disabled={!editable} onClick={() => void save()}>حفظ مراجعة تقييم جديدة</button>
          <button type="button" className={control} disabled={!lifetime?.active() || lifetime.busy || lifetime.uncertain} onClick={() => {
            if (!currentDraft() || !lifetime?.active() || latest.current?.busy || latest.current?.uncertain) return;
            if (lifetime.dirty && !window.confirm("تجاهل المسودة غير المحفوظة؟")) return;
            if (currentDraft() && lifetime.active() && !latest.current?.busy && !latest.current?.uncertain) { lifetime.settle("document", ""); setMessage(null); setShowSaveFeedback(false); }
          }}>تجاهل المسودة صراحة</button></div>
      </section>
      <div hidden={sectionView === "measurements" || sectionView === "radiographs"}>
      <OrthoAssessmentFindingsV2 draft={draft.measurements} sources={data?.sources.items ?? []}
        focusGroup={sectionView === "interview" ? "history" : sectionView === "extraoral" ? "facial" : sectionView === "intraoral" ? "intraoral" : undefined}
        owner={{ renderEditable: editable, active: currentDraft, editable: () => currentDraft() && editable && !!latest.current?.editable() }}
        onChange={measurements => change({ ...draft, measurements })} />
      </div><div hidden={sectionView !== undefined && sectionView !== "measurements"}>
      <OrthoAssessmentMeasurementsV2 draft={draft.measurements} sources={data?.sources.items ?? []}
        owner={{ renderEditable: editable, active: currentDraft, editable: () => currentDraft() && editable && !!latest.current?.editable() }}
        onChange={measurements => change({ ...draft, measurements })} />
      </div>
      {(sectionView === undefined || sectionView === "radiographs") && <details className="space-y-3 rounded-lg border p-3" open={sectionView === "radiographs"}>
        <summary className="min-h-11 cursor-pointer py-3 font-bold">قراءة البانوراما المرتبطة بالمصدر</summary>
        <OrthoPanoramicReview draft={draft.measurements} documents={read?.generation === generation ? read.panoramic ?? [] : []} sources={data?.sources.items ?? []}
          owner={{ renderEditable: editable, active: currentDraft, editable: () => currentDraft() && editable && !!latest.current?.editable() }}
          onChange={measurements => change({ ...draft, measurements })} />
      </details>}
    </div>}
  </section>;
}
