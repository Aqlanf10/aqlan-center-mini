"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSession } from "./SessionProvider";
import { checkStrategyCommand, ORTHO_STRATEGY_LIMITS, type StrategyProjection } from "@/lib/ortho-treatment-strategy";
import { readStrategyProjection, readStrategyResponse, type StrategyRead } from "@/lib/ortho-strategy-client";

type Field = "document" | "problemLabel" | "problemSite";
export interface StrategyWriteLease {
  current: () => boolean;
  checkHeaders: (response: Response) => boolean;
  markUncertain: () => void;
  finish: () => void;
}
/** Adapter to the EXISTING Ortho owner/draft/command lifetime. No second draft authority. */
export interface StrategyLifetime {
  identity: object;
  active: () => boolean;
  editable: () => boolean;
  denied: () => void;
  busy: boolean; uncertain: boolean; dirty: boolean;
  /** Confirmed commands invalidate only the exact draft's currently mounted read. */
  readVersion: number;
  refresh: () => void;
  values: Record<Field, string>;
  change: (field: Field, value: string) => void;
  settle: (field: Field, value: string) => void;
  begin: () => StrategyWriteLease | null;
}
interface DraftRow { key: string; problemId: number | null; objective: string; strategy: string; rationale: string; planItemIds: number[] }
interface Draft { commandId: string; expectedRevisionId: number | null; reason: string; rows: DraftRow[] }
const nonce = () => crypto.randomUUID();
const blankRow = (): DraftRow => ({ key: nonce(), problemId: null, objective: "", strategy: "", rationale: "", planItemIds: [] });
function draftOf(value: string): Draft | null {
  if (!value) return null;
  try {
    const draft: unknown = JSON.parse(value);
    const object = (one: unknown): one is Record<string, unknown> => one !== null && typeof one === "object" && !Array.isArray(one);
    const id = (one: unknown) => typeof one === "number" && Number.isSafeInteger(one) && one > 0;
    if (!object(draft) || typeof draft.commandId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(draft.commandId)
      || !(draft.expectedRevisionId === null || id(draft.expectedRevisionId)) || typeof draft.reason !== "string"
      || draft.reason.length > ORTHO_STRATEGY_LIMITS.reason || !Array.isArray(draft.rows)
      || !draft.rows.length || draft.rows.length > ORTHO_STRATEGY_LIMITS.rows) return null;
    const keys = new Set<string>();
    for (const row of draft.rows) {
      if (!object(row) || typeof row.key !== "string" || keys.has(row.key) || !(row.problemId === null || id(row.problemId))
        || typeof row.objective !== "string" || row.objective.length > ORTHO_STRATEGY_LIMITS.objective
        || typeof row.strategy !== "string" || row.strategy.length > ORTHO_STRATEGY_LIMITS.strategy
        || typeof row.rationale !== "string" || row.rationale.length > ORTHO_STRATEGY_LIMITS.rationale
        || !Array.isArray(row.planItemIds) || row.planItemIds.length > ORTHO_STRATEGY_LIMITS.itemsPerRow
        || row.planItemIds.some(item => !id(item)) || new Set(row.planItemIds).size !== row.planItemIds.length) return null;
      keys.add(row.key);
    }
    return draft as unknown as Draft;
  } catch { return null; }
}
const fieldClass = "mt-1 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-100";
const buttonClass = "min-h-11 rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold disabled:opacity-40";
const currentText = (link: StrategyProjection["rows"][number]["currentProblem"]) => link.state === "available"
  ? `الحالة الحالية: ${link.status ?? "غير معروفة"}`
  : link.state === "missing" ? "المرجع الحالي غير موجود" : link.state === "moved" ? "نُقل المرجع من هذه الحالة" : "تعذّر التحقق من المرجع الحالي";

function Revision({ revision }: { revision: StrategyProjection }) {
  return <div data-testid="ortho-strategy-saved" className="space-y-3">
    <p className="text-xs text-slate-600">نسخة {revision.version} · {revision.createdBy} · <time dateTime={revision.createdAt}>{revision.createdAt.slice(0, 10)}</time></p>
    {revision.recordingContext === "retrospective" ? <p className="text-xs font-bold text-amber-900">تصحيح توثيقي لحالة سابقة؛ لا يعيد فتح الحالة ولا يسجّل تنفيذ علاج.</p> : null}
    {revision.recordedPatientId !== revision.patientId ? <p className="text-xs text-slate-600">احتُفظ بمصدر التوثيق السابق بعد دمج ملف المريض.</p> : null}
    <p className="whitespace-pre-wrap text-xs text-slate-700">سبب النسخة: {revision.reason}</p>
    <ol className="space-y-3">{revision.rows.map((row, index) => <li key={`${row.problem.id}:${index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="grid gap-3 md:grid-cols-3">
        <div><h5 className="text-xs font-black text-navy-900">المشكلة المسجّلة</h5><p className="whitespace-pre-wrap text-sm">{row.problem.label}</p>{row.problem.site ? <p className="text-xs">{row.problem.site}</p> : null}<p className="mt-1 text-[11px] text-slate-500">{currentText(row.currentProblem)}</p></div>
        <div><h5 className="text-xs font-black text-navy-900">الهدف</h5><p className="whitespace-pre-wrap text-sm">{row.objective ?? "غير مسجّل"}</p></div>
        <div><h5 className="text-xs font-black text-navy-900">الاستراتيجية التي دوّنها الطبيب</h5><p className="whitespace-pre-wrap text-sm">{row.strategy ?? "غير مسجّلة"}</p></div>
      </div>
      {row.rationale ? <p className="mt-2 whitespace-pre-wrap text-xs text-slate-600">المبرر: {row.rationale}</p> : null}
      {row.planLinks.state === "allowed" ? row.planLinks.items.length ? <ul className="mt-2 space-y-1 text-xs text-slate-600">{row.planLinks.items.map(item => <li key={item.id}>{item.serviceName}{item.toothCode ? ` · سن ${item.toothCode}` : ""} · {currentText(item.current)}</li>)}</ul> : <p className="mt-2 text-xs text-slate-500">لا توجد بنود خطة مرتبطة بهذا السطر.</p>
        : <p className="mt-2 text-xs text-slate-500">روابط بنود الخطة {row.planLinks.state === "restricted" ? "محجوبة حسب الصلاحيات" : "غير متاحة للتحقق"}.</p>}
    </li>)}</ol>
    <p className="text-[11px] text-slate-500">النصوص ومراجعها المحفوظة توثيق تاريخي؛ الحالات المعروضة للروابط هي حالاتها الحالية فقط.</p>
  </div>;
}

export interface OrthoTreatmentStrategyProps {
  patientId: number; orthoCaseId: number; caseTitle?: string; lifetime?: StrategyLifetime; referenceVisitId?: number;
}
export function OrthoTreatmentStrategy(props: OrthoTreatmentStrategyProps) {
  const session = useSession();
  const authority = JSON.stringify([session?.username, session?.role, session?.permissions ?? null]);
  // Presentation state belongs to this exact patient/case/session/visit owner.
  // In particular, B must never request A's selected history revision.
  return <StrategyWorkspace key={`${props.patientId}:${props.orthoCaseId}:${props.referenceVisitId ?? "case"}:${authority}`} {...props} />;
}
function StrategyWorkspace({ patientId, orthoCaseId, caseTitle, lifetime, referenceVisitId }: OrthoTreatmentStrategyProps) {
  const session = useSession();
  const authority = JSON.stringify([session?.username, session?.role, session?.permissions ?? null]);
  const owner = useMemo(() => ({ patientId, orthoCaseId, authority, referenceVisitId, identity: lifetime?.identity, active: false }),
    [patientId, orthoCaseId, authority, referenceVisitId, lifetime?.identity]);
  useLayoutEffect(() => { owner.active = true; return () => { owner.active = false; }; }, [owner]);
  const lifetimeRef = useRef(lifetime);
  useLayoutEffect(() => { lifetimeRef.current = lifetime; }, [lifetime]);
  const [selected, setSelected] = useState<number | undefined>();
  const [reload, setReload] = useState(0);
  const [read, setRead] = useState<{ owner: typeof owner; data: StrategyRead | null; error: string | null; loading: boolean }>({ owner, data: null, error: null, loading: true });
  const [message, setMessage] = useState<string | null>(null);
  const [problemForm, setProblemForm] = useState(false);
  const [problemSearch, setProblemSearch] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const readVersion = lifetime?.readVersion ?? 0;
  const data = read.owner === owner ? read.data : null;
  const loading = read.owner !== owner || read.loading;
  const draft = draftOf(lifetime?.values.document ?? "");
  const malformedDraft = Boolean(lifetime?.values.document && !draft);
  const blocked = loading || !data || !!lifetime?.busy || !!lifetime?.uncertain || !lifetime?.editable();
  const strategyBlocked = blocked || data?.state === "ready" && !data.canRevise;
  const scope = data?.state === "ready" ? { patientId, orthoCaseId, clinicalCaseId: data.clinicalCaseId } : null;

  useEffect(() => {
    const life = lifetimeRef.current;
    const controller = new AbortController(); let active = true;
    const current = () => owner.active && active && !controller.signal.aborted && (!life || life.active());
    setRead({ owner, data: null, error: null, loading: true });
    const timer = setTimeout(() => {
      if (!current()) return;
      setRead({ owner, data: null, loading: false, error: "تعذّر إكمال قراءة خطة الحالة. أعد التحميل." }); controller.abort();
    }, 15_000);
    void (async () => {
      try {
        const response = await fetch(`/api/ortho/${orthoCaseId}/strategy${selected === undefined ? "" : `?revisionId=${selected}`}`, { cache: "no-store", signal: controller.signal });
        if (!current()) return;
        if ([401, 403].includes(response.status)) { life?.denied(); throw new Error("غير مصرّح لك بخطة هذه الحالة."); }
        if (!response.ok || response.redirected) throw new Error("تعذّر قراءة خطة الحالة؛ لا تعني النتيجة أن السجل فارغ.");
        const payload: unknown = await response.json(); if (!current()) return;
        const verified = readStrategyResponse(payload, patientId, orthoCaseId, selected);
        if (!verified) throw new Error("تعذّر التحقق من نطاق خطة الحالة أو نسختها.");
        setRead({ owner, data: verified, error: null, loading: false });
      } catch (error) {
        if (current()) setRead({ owner, data: null, loading: false, error: error instanceof Error ? error.message : "تعذّر قراءة الخطة." });
      } finally { clearTimeout(timer); }
    })();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [owner, patientId, orthoCaseId, selected, reload, readVersion]);

  const update = (next: Draft) => { if (!strategyBlocked) lifetime?.change("document", JSON.stringify(next)); };
  const changeRow = (index: number, patch: Partial<DraftRow>) => { if (draft) update({ ...draft, rows: draft.rows.map((row, i) => i === index ? { ...row, ...patch } : row) }); };
  const beginRevision = () => {
    if (strategyBlocked || !lifetime || data?.state !== "ready" || !data.clinicalWritable) return;
    if (data.revision && data.history[0]?.revisionId !== data.revision.revisionId) return;
    if (data.revision && !data.canRevise) return;
    const next: Draft = { commandId: nonce(), expectedRevisionId: data.revision?.revisionId ?? null, reason: "",
      rows: data.revision ? data.revision.rows.map(row => ({ key: nonce(), problemId: row.problem.id,
        objective: row.objective ?? "", strategy: row.strategy ?? "", rationale: row.rationale ?? "",
        planItemIds: row.planLinks.state === "allowed" ? row.planLinks.items.map(item => item.id) : [] })) : [blankRow()] };
    lifetime.settle("document", JSON.stringify(next)); setMessage(null);
  };
  const discard = () => {
    if (!lifetime || lifetime.busy || lifetime.uncertain || !lifetime.active()) return;
    if (lifetime.dirty && !window.confirm("هل تريد تجاهل التغييرات غير المحفوظة في مسودة خطة الحالة؟")) return;
    lifetime.settle("document", ""); setMessage(null);
  };

  async function send(kind: "strategy" | "bridge" | "problem") {
    if (blocked || !lifetime || !data?.clinicalWritable || !owner.active) return;
    let body: unknown;
    if (kind === "strategy") {
      if (strategyBlocked || !draft || !scope) return;
      const checked = checkStrategyCommand({ schemaVersion: 1, commandId: draft.commandId, expectedRevisionId: draft.expectedRevisionId,
        reason: draft.reason, rows: draft.rows.map(({ problemId, objective, strategy, rationale, planItemIds }) => ({ problemId, objective, strategy, rationale, planItemIds })) });
      if (!checked.ok) { setMessage(checked.message); return; } body = checked.value;
    } else if (kind === "bridge") {
      if (data.state !== "bridge_missing" || !caseTitle || !window.confirm(`ربط ${caseTitle} بالمشاكل وبنود الخطة؟ لا ينشئ هذا الإجراء حالة تقويم أو فاتورة جديدة.`)) return;
      body = { specialty: "orthodontics", title: caseTitle, orthoCaseId };
    } else {
      if (!scope || !lifetime.values.problemLabel.trim()) return;
      body = { label: lifetime.values.problemLabel.trim(), site: lifetime.values.problemSite.trim() || null, specialty: "orthodontics", caseId: scope.clinicalCaseId };
    }
    const operation = lifetime.begin(); if (!operation) return;
    let confirmed = false; let existingBridge = false;
    // Command ownership outlives a temporary pillar view. Its result must still
    // settle/freeze the owned draft, but never write retired presentation state.
    const showMessage = (value: string) => { if (owner.active) setMessage(value); };
    setMessage(null);
    try {
      const url = kind === "strategy" ? `/api/ortho/${orthoCaseId}/strategy` : `/api/patients/${patientId}/${kind === "bridge" ? "cases" : "problems"}`;
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!operation.current() || !operation.checkHeaders(response)) return;
      if (response.redirected || response.status >= 500) { operation.markUncertain(); showMessage("لم تتأكد نتيجة الحفظ. راجع السجل بعد إعادة التحميل؛ لا تُنشئ طلبًا آخر."); return; }
      if (!response.ok && ![400, 401, 403, 404, 409, 413].includes(response.status)) {
        operation.markUncertain(); showMessage("وصلت نتيجة غير معروفة للطلب. راجع السجل قبل أي محاولة أخرى."); return;
      }
      if (kind === "bridge" && response.status === 409) { existingBridge = true; return; }
      const payload: unknown = await response.json().catch(() => null); if (!operation.current()) return;
      if (!response.ok) {
        const error = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string" ? payload.message : "تعذّر الحفظ.";
        showMessage(error);
        if (response.status === 404 && owner.active) setRead({ owner, data: null, error, loading: false });
        return;
      }
      if (kind === "strategy") {
        const result = payload as { ok?: unknown; revision?: unknown; replayed?: unknown } | null;
        const revision = scope && readStrategyProjection(result?.revision, scope);
        confirmed = !!revision && result?.ok === true && typeof result.replayed === "boolean"
          && response.status === (result.replayed ? 200 : 201) && revision.supersedesRevisionId === draft!.expectedRevisionId;
      } else {
        const result = payload as { id?: unknown; patientId?: unknown; caseId?: unknown; orthoCaseId?: unknown; label?: unknown } | null;
        confirmed = response.status === 201 && !!result && Number.isSafeInteger(result.id) && Number(result.id) > 0 && result.patientId === patientId
          && (kind === "bridge" ? result.orthoCaseId === orthoCaseId : result.caseId === scope?.clinicalCaseId && result.label === lifetime.values.problemLabel.trim());
      }
      if (!confirmed) { operation.markUncertain(); showMessage("وصل رد لا يؤكد السجل المطلوب. راجع السجل قبل أي طلب آخر."); }
    } catch {
      if (operation.current()) { operation.markUncertain(); showMessage("نتيجة الحفظ غير مؤكدة؛ قد يكون الطلب نُفّذ. لا تُعد إرساله بمعرّف جديد."); }
    } finally {
      const current = operation.current(); operation.finish();
      if (current && (confirmed || existingBridge)) {
        if (confirmed && kind === "strategy") lifetime.settle("document", "");
        if (confirmed && kind === "problem") { lifetime.settle("problemLabel", ""); lifetime.settle("problemSite", ""); if (owner.active) setProblemForm(false); }
        lifetime.refresh();
        if (owner.active) { setSelected(undefined); setMessage(existingBridge ? "الحالة مرتبطة مسبقًا؛ جارٍ التحقق من الرابط الموجود دون تكرار الإنشاء." : "حُفظ التوثيق؛ جارٍ قراءة السجل المعتمد."); }
      }
    }
  }

  return <section aria-label={lifetime ? "خطة الحالة: المشكلة والهدف والاستراتيجية" : "خطة الحالة للمرجع فقط"} data-testid={lifetime ? "ortho-strategy-editor" : "ortho-strategy-reference"}
    className="min-w-0 space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-black text-navy-900">المشكلة ← الهدف ← الاستراتيجية</h4>
      <button type="button" className={buttonClass} disabled={!!lifetime?.busy} onClick={() => setReload(value => value + 1)}>تحديث سجل الخطة</button></div>
    {!lifetime ? <p className="text-xs text-slate-500">مرجع للقراءة فقط. لا ينسخ النص إلى الزيارة ولا يضيف إجراءً أو توقيعًا أو مبلغًا.</p> : null}
    {loading ? <p role="status" className="text-sm text-slate-500">جارٍ التحقق من خطة الحالة…</p> : null}
    {read.owner === owner && read.error ? <p role="alert" className="text-sm text-rose-800">{read.error}</p> : null}
    {message ? <p role="status" className="text-xs text-slate-700">{message}</p> : null}
    {lifetime?.uncertain ? <p role="alert" className="text-xs font-bold text-amber-900">نتيجة الطلب السابق غير مؤكدة. احتُفظ بالمسودة وتوقف الحفظ. راجع السجل بعد إعادة تحميل الصفحة قبل فتح مسودة أخرى.</p> : null}
    {malformedDraft ? <p role="alert">تعذّر قراءة المسودة المحفوظة لهذه الجلسة؛ لم تُستبدل بنموذج فارغ.</p> : null}
    {data?.state === "bridge_missing" ? <div className="space-y-2 text-sm"><p>هذه الحالة غير مرتبطة بعد بقائمة المشاكل السريرية. لم يُنشأ رابط تلقائي.</p>
      {lifetime && data.clinicalWritable ? <button type="button" disabled={blocked} onClick={() => void send("bridge")} className={buttonClass}>ربط هذه الحالة بالمشاكل وبنود الخطة</button> : null}</div> : null}
    {data?.state === "ready" ? <>
      {data.history.length ? <label className="block text-xs font-bold text-slate-600">النسخة المعروضة
        <select aria-label="نسخة خطة الحالة" className={fieldClass} disabled={!!draft || !!lifetime?.busy || !!lifetime?.uncertain} value={selected ?? data.history[0].revisionId}
          onChange={event => { setSelected(Number(event.target.value)); setMessage(null); }}>
          {data.history.map(entry => <option key={entry.revisionId} value={entry.revisionId}>نسخة {entry.version} · {entry.createdAt.slice(0, 10)} · {entry.createdBy}{entry.recordingContext === "retrospective" ? " · تصحيح توثيقي" : ""}</option>)}
        </select></label> : <p className="text-sm text-slate-500">لا توجد نسخة موثّقة لخطة هذه الحالة بعد.</p>}
      {data.revision ? <Revision revision={data.revision} /> : null}
      {lifetime && data.revision && !data.canRevise ? <p className="text-xs text-slate-500">هذه النسخة للقراءة فقط بصلاحياتك الحالية. لا تُحذف الروابط المحجوبة بفتح مسودة فارغة.</p> : null}
      {lifetime && data.clinicalWritable && !draft && !malformedDraft ? <button type="button" className={buttonClass}
        disabled={blocked || !!data.revision && (data.history[0]?.revisionId !== data.revision.revisionId || !data.canRevise)} onClick={beginRevision}>
        {data.revision ? "فتح مراجعة جديدة من النسخة الحالية" : "بدء خطة الحالة من نموذج فارغ"}</button> : null}
      {lifetime && data.clinicalWritable ? <details open={problemForm} onToggle={event => setProblemForm(event.currentTarget.open)} className="rounded-xl border border-slate-200 p-3">
        <summary className="cursor-pointer text-xs font-bold">إضافة مشكلة سريرية لهذه الحالة</summary>
        <p className="mt-2 text-xs text-slate-500">تُحفظ المشكلة في قائمة مشاكل المريض الموجودة، ثم تختارها صراحةً في سطر الخطة.</p>
        <label className="mt-2 block text-xs">نص المشكلة<input className={fieldClass} maxLength={200} value={lifetime.values.problemLabel} disabled={blocked} onChange={event => lifetime.change("problemLabel", event.target.value)} /></label>
        <label className="mt-2 block text-xs">موضع المشكلة (اختياري)<input className={fieldClass} maxLength={60} value={lifetime.values.problemSite} disabled={blocked} onChange={event => lifetime.change("problemSite", event.target.value)} /></label>
        <button type="button" className={`${buttonClass} mt-2`} disabled={blocked || !lifetime.values.problemLabel.trim()} onClick={() => void send("problem")}>حفظ المشكلة في هذه الحالة</button>
      </details> : null}
      {draft && lifetime ? <div data-testid="ortho-strategy-draft" className="space-y-4 rounded-xl border border-navy-100 bg-slate-50 p-3">
        {data.recordingContext === "retrospective" ? <p className="text-xs font-bold text-amber-900">مراجعة توثيقية لحالة سابقة. تبقى حالة العلاج كما هي.</p> : null}
        <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold">بحث في مشاكل هذه الحالة<input type="search" className={fieldClass} value={problemSearch} onChange={event => setProblemSearch(event.target.value)} /></label>
          <label className="text-xs font-bold">بحث في بنود خطة هذه الحالة<input type="search" className={fieldClass} value={itemSearch} onChange={event => setItemSearch(event.target.value)} disabled={!data.planVisible} /></label></div>
        {draft.rows.map((row, index) => <fieldset key={row.key} disabled={strategyBlocked} data-testid="ortho-strategy-row" className="min-w-0 space-y-3 rounded-xl border border-slate-200 bg-white p-3">
          <legend className="px-1 text-xs font-black">سطر الخطة {index + 1}</legend>
          <div className="grid gap-3 md:grid-cols-3"><label className="min-w-0 text-xs font-bold">المشكلة
            <select className={`${fieldClass} max-h-40`} size={4} value={row.problemId ?? ""} onChange={event => changeRow(index, { problemId: event.target.value ? Number(event.target.value) : null })}>
              <option value="" disabled>اختر مشكلة موثّقة</option>
              {row.problemId !== null && !data.choices.problems.some(problem => problem.id === row.problemId) ? <option value={row.problemId}>مرجع المشكلة #{row.problemId} غير متاح حاليًا</option> : null}
              {data.choices.problems.filter(problem => problem.id === row.problemId || `${problem.label} ${problem.site ?? ""}`.toLowerCase().includes(problemSearch.toLowerCase())).map(problem => <option key={problem.id} value={problem.id}>{problem.label}{problem.site ? ` · ${problem.site}` : ""} · {problem.status ?? "غير معروف"}</option>)}
            </select></label>
            <label className="text-xs font-bold">الهدف (نص الطبيب)<textarea aria-label="الهدف (نص الطبيب)" className={fieldClass} rows={4} maxLength={ORTHO_STRATEGY_LIMITS.objective} value={row.objective} onChange={event => changeRow(index, { objective: event.target.value })} /></label>
            <label className="text-xs font-bold">الاستراتيجية (نص الطبيب)<textarea aria-label="الاستراتيجية (نص الطبيب)" className={fieldClass} rows={4} maxLength={ORTHO_STRATEGY_LIMITS.strategy} value={row.strategy} onChange={event => changeRow(index, { strategy: event.target.value })} /></label></div>
          <label className="block text-xs font-bold">المبرر أو ملاحظة القرار (اختياري)<textarea aria-label="المبرر أو ملاحظة القرار (اختياري)" className={fieldClass} rows={2} maxLength={ORTHO_STRATEGY_LIMITS.rationale} value={row.rationale} onChange={event => changeRow(index, { rationale: event.target.value })} /></label>
          <fieldset disabled={!data.planLinksWritable} className="rounded-lg border border-slate-200 p-2"><legend className="px-1 text-xs font-bold">روابط بنود الخطة (اختياري)</legend>
            {data.planVisible ? <div className="max-h-44 space-y-1 overflow-y-auto overscroll-contain">
              {row.planItemIds.filter(id => !data.choices.planItems.some(item => item.id === id)).map(id => <label key={id} className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked onChange={() => changeRow(index, { planItemIds: row.planItemIds.filter(value => value !== id) })} />بند #{id} غير متاح حاليًا؛ أزل الرابط صراحةً أو أصلحه من الخطة.</label>)}
              {data.choices.planItems.filter(item => row.planItemIds.includes(item.id) || `${item.serviceName} ${item.toothCode ?? ""}`.toLowerCase().includes(itemSearch.toLowerCase())).map(item => <label key={item.id} className="flex min-h-11 items-center gap-2 text-xs">
                <input type="checkbox" checked={row.planItemIds.includes(item.id)} disabled={!row.planItemIds.includes(item.id) && row.planItemIds.length >= ORTHO_STRATEGY_LIMITS.itemsPerRow}
                  onChange={event => changeRow(index, { planItemIds: event.target.checked ? [...row.planItemIds, item.id] : row.planItemIds.filter(id => id !== item.id) })} />
                <span>{item.serviceName}{item.toothCode ? ` · سن ${item.toothCode}` : ""} · الحالة الحالية: {item.status ?? "غير معروفة"}</span></label>)}
              {!data.choices.planItems.length ? <p className="text-xs text-slate-500">لا توجد بنود خطة مرتبطة بهذه الحالة. يمكنك توثيق النص دون رابط؛ تعيين البنود يتم من قسم حالات المريض.</p> : null}
            </div> : <p className="text-xs text-slate-500">روابط بنود الخطة محجوبة حسب الصلاحيات.</p>}
          </fieldset>
          <button type="button" className={buttonClass} disabled={strategyBlocked || draft.rows.length === 1} onClick={() => update({ ...draft, rows: draft.rows.filter((_, i) => i !== index) })}>حذف هذا السطر من المسودة</button>
        </fieldset>)}
        <button type="button" className={buttonClass} disabled={strategyBlocked || draft.rows.length >= ORTHO_STRATEGY_LIMITS.rows} onClick={() => update({ ...draft, rows: [...draft.rows, blankRow()] })}>إضافة سطر مشكلة وهدف واستراتيجية</button>
        <label className="block text-xs font-bold">سبب توثيق هذه النسخة (مطلوب)<textarea aria-label="سبب توثيق هذه النسخة (مطلوب)" className={fieldClass} rows={2} maxLength={ORTHO_STRATEGY_LIMITS.reason} value={draft.reason} disabled={strategyBlocked} onChange={event => update({ ...draft, reason: event.target.value })} /></label>
        <p className="text-xs text-slate-500">لا يُملأ هدف أو قرار تلقائيًا. الحفظ نسخة توثيقية جديدة، ولا يعني تنفيذ البنود أو تحقق شروطها.</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={`${buttonClass} bg-navy-900 text-white`} disabled={strategyBlocked || !draft.reason.trim() || draft.rows.some(row => row.problemId === null)} onClick={() => void send("strategy")}>حفظ نسخة خطة الحالة</button>
          <button type="button" className={buttonClass} disabled={lifetime.busy || lifetime.uncertain} onClick={discard}>إلغاء مسودة الخطة</button></div>
      </div> : null}
    </> : null}
  </section>;
}
