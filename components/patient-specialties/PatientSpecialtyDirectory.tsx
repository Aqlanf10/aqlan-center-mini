"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpLeft, Layers3, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { SPECIALTY_LABEL, type ServiceSpecialty } from "@/lib/appointment-services";
import { CASE_STATUS_LABEL, DEPENDENCY_REQUIREMENT_LABEL, PROBLEM_STATUS_LABEL } from "@/lib/cases";
import { WORKFLOW_ITEM_STATUS_LABEL, type WorkflowItemStatus } from "@/lib/workflow";
import type { PatientRecordFocus } from "@/lib/patient-workspace-focus";
import { SPECIALTY_WORKSPACES, readSpecialtyContext, specialtyCaseFocus, specialtyPlanItemFocus, specialtyVisitWorkFocus,
  type SpecialtyContextCase, type SpecialtyContextItem, type SpecialtyContextSnapshot } from "@/lib/patient-specialty-workspaces";

interface DirectoryProps {
  patientId: number;
  authorityKey: string;
  canViewPlans: boolean;
  openVisitId?: number | null;
  onNavigate: (target: string) => void;
  onFocus?: (focus: PatientRecordFocus) => void;
  active?: boolean;
}
interface ReadState {
  key: string;
  scope: object | null;
  generation: number;
  status: "loading" | "ready" | "unavailable" | "denied" | "inactive";
  value: SpecialtyContextSnapshot | null;
}
const EMPTY: ReadState = { key: "", scope: null, generation: 0, status: "loading", value: null };

/** One protected read, with an independent lifecycle from all canonical editors. */
export function useSpecialtyDirectoryRead({ patientId, authorityKey, canViewPlans, active = true, openVisitId = null }: Pick<DirectoryProps, "patientId" | "authorityKey" | "canViewPlans" | "active" | "openVisitId">) {
  const key = JSON.stringify([patientId, authorityKey, canViewPlans, active, openVisitId]);
  const scope = useMemo(() => ({ key }), [key]);
  const owner = useRef<typeof scope | null>(null);
  const [state, setState] = useState<ReadState>(EMPTY);
  const sequence = useRef(0);
  const request = useRef<AbortController | null>(null);
  // Revoke callbacks in the commit itself, before passive reads or user events.
  // A speculative render must not mutate the authority of the committed UI.
  useLayoutEffect(() => {
    owner.current = scope;
    const revisions = sequence, pending = request;
    return () => { owner.current = null; ++revisions.current; pending.current?.abort(); };
  }, [scope]);
  const reload = useCallback(async () => {
    if (owner.current !== scope) return;
    const generation = ++sequence.current;
    request.current?.abort();
    if (!active) { setState({ key, scope, generation, status: "inactive", value: null }); return; }
    const controller = new AbortController(); request.current = controller;
    const current = () => owner.current === scope && sequence.current === generation && !controller.signal.aborted;
    setState({ key, scope, generation, status: "loading", value: null });
    if (!Number.isSafeInteger(patientId) || patientId < 1 || patientId > 2147483647 || !authorityKey) {
      setState({ key, scope, generation, status: "unavailable", value: null }); return;
    }
    try {
      const response = await fetch(`/api/patients/${patientId}/cases`, { cache: "no-store", signal: controller.signal });
      if (!current()) return;
      // Authorization is definitive before body parsing, including HTML/proxy bodies.
      if ([401, 403, 404].includes(response.status)) {
        setState({ key, scope, generation, status: "denied", value: null }); return;
      }
      if (!response.ok) { setState({ key, scope, generation, status: "unavailable", value: null }); return; }
      const payload: unknown = await response.json();
      if (!current()) return;
      // The shell's verified workflow capability can revoke plan access even if
      // this independent endpoint still returns an older permitted projection.
      // Keep validating patient/case identity, but do not inspect denied plans.
      const permittedPayload = !canViewPlans && payload && typeof payload === "object" && !Array.isArray(payload)
        && "planVisible" in payload && typeof payload.planVisible === "boolean" ? { ...payload, planVisible: false } : payload;
      const value = readSpecialtyContext(permittedPayload, patientId);
      setState({ key, scope, generation, status: "ready", value });
    } catch {
      if (current()) setState({ key, scope, generation, status: "unavailable", value: null });
    }
  }, [active, authorityKey, canViewPlans, key, patientId, scope]);
  useEffect(() => { void reload(); }, [reload]);
  // Authority/patient/capability changes hide private data in the same render.
  const current = !active ? { ...EMPTY, key, status: "inactive" as const }
    : state.key === key && state.scope === scope ? state : { ...EMPTY, key };
  // Event callbacks from an older render cannot navigate from a retired snapshot.
  const isCurrent = useCallback((generation: number) => active && owner.current === scope && sequence.current === generation && !request.current?.signal.aborted, [active, scope]);
  return { ...current, reload, isCurrent };
}

const button = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-teal-300 hover:bg-teal-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed disabled:opacity-40";
const quiet = "text-xs leading-6 text-slate-500";

/** Newly reconstructed directory. Navigating never creates, stages, saves or bills. */
export function PatientSpecialtyDirectory({ patientId, authorityKey, canViewPlans, openVisitId = null, onNavigate, onFocus, active = true }: DirectoryProps) {
  const context = useSpecialtyDirectoryRead({ patientId, authorityKey, canViewPlans, active, openVisitId });
  const [selected, setSelected] = useState<ServiceSpecialty | null>(null);
  const [query, setQuery] = useState("");
  const snapshot = context.value;
  const workspace = SPECIALTY_WORKSPACES.find((row) => row.id === selected);
  const search = query.trim().toLocaleLowerCase("ar");
  const entries = SPECIALTY_WORKSPACES.filter((row) => !search || [row.label, ...row.aliases].some((label) => label.toLocaleLowerCase("ar").includes(search)));
  const focus = (value: PatientRecordFocus) => { if (snapshot && context.isCurrent(context.generation)) onFocus?.(value); };
  const navigate = (target: string) => { if (context.isCurrent(context.generation) && context.status !== "denied" && context.status !== "inactive") onNavigate(target); };

  if (!active) return null;
  return <section dir="rtl" data-testid="patient-specialty-directory" className="space-y-4">
    <header className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-1 text-[11px] font-extrabold tracking-wide text-teal-700">ملف واحد · {SPECIALTY_WORKSPACES.length} تخصصًا</p>
          <h3 className="text-lg font-black text-slate-900">التخصصات والسجل المشترك</h3>
          <p className={quiet}>اختر تخصصًا لعرض حالاته المحفوظة والوصول إلى مساحة العمل الأصلية</p>
        </div>
        <button type="button" className={button} onClick={() => void context.reload()} disabled={context.status === "loading"} aria-label="تحديث سياق التخصصات">
          <RefreshCw size={14} aria-hidden="true" /> تحديث
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border border-slate-200 px-3 text-slate-500">
          <Search size={15} aria-hidden="true" /><span className="sr-only">ابحث عن تخصص</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="ابحث عن تخصص أو علاج العصب…" className="min-w-0 flex-1 bg-transparent py-2 text-sm text-slate-800 outline-none" />
        </label>
        <button type="button" className={button} disabled={context.status === "denied"} onClick={() => navigate("cases")}>الحالات والمشاكل</button>
        <button type="button" className={button} disabled={!snapshot?.planVisible} onClick={() => { if (snapshot?.planVisible && context.isCurrent(context.generation)) onNavigate("plans"); }}>الخطة المشتركة</button>
        <button type="button" className={button} disabled={context.status === "denied"} onClick={() => navigate("referrals")}>الإحالات</button>
      </div>
    </header>

    {context.status === "loading" ? <p role="status" className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">جارٍ التحقق من الحالات وارتباطاتها…</p> : null}
    {context.status === "denied" ? <p role="alert" data-testid="specialty-context-denied" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">لم يعد السجل متاحًا ضمن صلاحياتك الحالية. أُخفيت البيانات السابقة؛ أعد التحقق قبل المتابعة.</p> : null}
    {context.status === "unavailable" ? <p role="alert" data-testid="specialty-context-unavailable" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">تعذّر التحقق من السجل الآن. الحالة غير معروفة وليست «بلا حالات». حدّث السياق لإعادة المحاولة.</p> : null}
    {snapshot && !snapshot.planVisible ? <p data-testid="specialty-plan-hidden" className="flex gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600"><ShieldCheck size={16} aria-hidden="true" />بنود الخطط واعتمادياتها محجوبة ضمن الوصول الحالي</p> : null}

    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="دليل التخصصات">
      {entries.map((entry) => {
        const count = snapshot?.cases.filter((row) => row.specialty === entry.id).length;
        return <button key={entry.id} type="button" data-testid={`specialty-card-${entry.id}`} aria-pressed={selected === entry.id}
          aria-controls="specialty-saved-context" onClick={() => setSelected(entry.id)}
          className={`min-w-0 rounded-2xl border p-3 text-start transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 ${selected === entry.id ? "border-teal-500 bg-teal-50" : "border-slate-200 bg-white hover:border-teal-300"}`}>
          <span className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-extrabold text-slate-900">{entry.label}</span><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">{entry.kind === "dedicated" ? "مساحة متخصصة · جزئية" : "مسار مشترك · جزئي"}</span></span>
          <span className="mt-1 block text-xs leading-5 text-slate-600">{entry.description}</span>
          <span className="mt-2 flex items-center justify-between gap-2 text-[11px] font-bold text-teal-800"><span>{count === undefined ? "الحالات غير متاحة الآن" : count === 0 ? "لا حالات محفوظة لهذا التخصص" : `${count} حالة محفوظة`}</span><ArrowUpLeft size={14} aria-hidden="true" /></span>
        </button>;
      })}
    </div>
    {!entries.length ? <p className={quiet}>لا تخصص مطابق لهذا البحث. <button type="button" className="min-h-10 font-bold text-teal-800 underline" onClick={() => setQuery("")}>عرض كل التخصصات</button></p> : null}

    <section id="specialty-saved-context" className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="تفاصيل التخصص المختار">
      {!workspace ? <p className="flex items-center gap-2 text-sm text-slate-600"><Layers3 size={18} aria-hidden="true" />اختر بطاقة لعرض الحالات والارتباطات الدقيقة، دون فتح نموذج جديد</p> : <>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0"><h4 className="font-black text-slate-900">{workspace.label}</h4><p className={quiet}>{workspace.gap}</p></div>
          <button type="button" className={button} disabled={context.status === "denied"} onClick={() => navigate(workspace.destination)}>افتح {workspace.kind === "dedicated" ? "مساحة التخصص" : "المسار المشترك"}<ArrowUpLeft size={14} aria-hidden="true" /></button>
        </div>
        {snapshot ? <>
          <div className="mt-3 space-y-2">
            {snapshot.cases.filter((row) => row.specialty === workspace.id).map((row) => <CaseCard key={row.id ?? `ortho-${row.orthoCaseId}`} row={row} snapshot={snapshot} openVisitId={openVisitId} onNavigate={navigate} onFocus={onFocus ? focus : undefined} />)}
            {!snapshot.cases.some((row) => row.specialty === workspace.id) ? <p className={quiet}>لا حالات محفوظة لهذا التخصص في القراءة الحالية. فتح المسار لا ينشئ حالة.</p> : null}
          </div>
          {snapshot.problems.some((row) => row.caseId === null && row.specialty === workspace.id) ? <div className="mt-3"><h5 className="text-xs font-bold text-slate-700">مشاكل مسجلة دون ربط بحالة</h5><ul className="mt-1 space-y-1">{snapshot.problems.filter((row) => row.caseId === null && row.specialty === workspace.id).map((row) => <li key={row.id} className={quiet}>{row.label}{row.site ? ` · ${row.site}` : ""} · {PROBLEM_STATUS_LABEL[row.status]}</li>)}</ul></div> : null}
        </> : <p className={`mt-3 ${quiet}`}>تفاصيل السجل غير متاحة حتى تنجح القراءة الحالية</p>}
      </>}
    </section>
    {snapshot?.planVisible && snapshot.items.some((item) => item.caseId === null) ? <details className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="specialty-unlinked-items">
      <summary className="min-h-10 cursor-pointer text-sm font-extrabold text-slate-800">بنود مشتركة غير مرتبطة بحالة تخصصية ({snapshot.items.filter((item) => item.caseId === null).length})</summary>
      <p className={quiet}>تظل البنود في خططها الأصلية؛ لا يُفترض تخصصها أو تُنسب إلى أول حالة</p>
      <ul className="mt-2 space-y-2">{snapshot.items.filter((item) => item.caseId === null).map((item) => <ItemRow key={item.id} item={item} snapshot={snapshot} openVisitId={openVisitId} onFocus={onFocus ? focus : undefined} />)}</ul>
    </details> : null}
    <p className={quiet}>العرض والمراجعة لا يحفظان إجراءً ولا يصدران فاتورة. تُراجع أهلية البند وطبيب الزيارة في الزيارة الأصلية قبل الإضافة الصريحة.</p>
  </section>;
}

function CaseCard({ row, snapshot, openVisitId, onFocus, onNavigate }: {
  row: SpecialtyContextCase; snapshot: SpecialtyContextSnapshot; openVisitId: number | null;
  onFocus?: (focus: PatientRecordFocus) => void; onNavigate: (target: string) => void;
}) {
  const focus = specialtyCaseFocus(snapshot, row.id);
  const items = row.id === null ? [] : snapshot.items.filter((item) => item.caseId === row.id);
  const problems = row.id === null ? [] : snapshot.problems.filter((problem) => problem.caseId === row.id);
  return <details className="rounded-xl border border-slate-200 p-3" data-testid={`specialty-case-${row.id ?? `ortho-${row.orthoCaseId}`}`}>
    <summary className="min-h-10 cursor-pointer text-sm font-extrabold text-slate-800"><span>{row.title}{row.site ? ` · ${row.site}` : ""}</span><span className="ms-2 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-600">{CASE_STATUS_LABEL[row.status]}</span></summary>
    <p className={quiet}>{SPECIALTY_LABEL[row.specialty]} · مسؤول الحالة: {row.responsibleName ?? "غير مسجل"} · بدأت: <bdi>{row.startedOn}</bdi></p>
    <p className={quiet}>مسؤول الحالة مستقل عن الطبيب المعالج في الزيارة</p>
    {row.problem ? <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{row.problem}</p> : null}
    {row.outcome ? <p className={quiet}>النتيجة المسجلة: {row.outcome}</p> : null}
    {row.waitingOn.length ? <div className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900"><p className="font-bold">إحالات تنتظرها الحالة</p><ul>{row.waitingOn.map((label, index) => <li key={index}>{label}</li>)}</ul><button type="button" className="mt-1 min-h-10 font-bold underline" onClick={() => onNavigate("referrals")}>راجع الإحالات الأصلية</button></div> : null}
    {row.id === null ? <p className="mt-2 text-xs leading-6 text-amber-900">حالة تقويم أصلية #{row.orthoCaseId} بلا رابط حالة سريرية عامة. لن تُربط أو تُنشأ حالة عند فتح التقويم.</p> : null}
    <div className="mt-2 flex flex-wrap gap-2">
      {focus && onFocus ? <button type="button" className={button} data-testid={`specialty-open-case-${row.id}`} onClick={() => onFocus(focus)}>افتح الحالة #{row.id}</button> : null}
      {row.kind === "ortho" ? <button type="button" className={button} onClick={() => onNavigate("ortho")}>افتح التقويم الأصلي</button> : null}
    </div>
    {problems.length ? <ul className="mt-2 space-y-1">{problems.map((problem) => <li key={problem.id} className={quiet}>{problem.label}{problem.site ? ` · ${problem.site}` : ""} · {PROBLEM_STATUS_LABEL[problem.status]}</li>)}</ul> : null}
    {snapshot.planVisible && row.id !== null ? <div className="mt-3"><h5 className="text-xs font-bold text-slate-700">البنود المرتبطة بهذه الحالة</h5>{items.length ? <ul className="mt-2 space-y-2">{items.map((item) => <ItemRow key={item.id} item={item} snapshot={snapshot} openVisitId={openVisitId} onFocus={onFocus} />)}</ul> : <p className={quiet}>لا بنود مرتبطة بهذه الحالة في القراءة الحالية</p>}</div> : null}
  </details>;
}

function ItemRow({ item, snapshot, openVisitId, onFocus }: {
  item: SpecialtyContextItem; snapshot: SpecialtyContextSnapshot; openVisitId: number | null; onFocus?: (focus: PatientRecordFocus) => void;
}) {
  const planFocus = specialtyPlanItemFocus(snapshot, item);
  const visitFocus = specialtyVisitWorkFocus(snapshot, item, openVisitId);
  const dependencies = snapshot.dependencies.filter((row) => row.itemId === item.id);
  return <li className="rounded-xl border border-slate-100 bg-slate-50 p-3" data-testid={`specialty-item-${item.id}`}>
    <p className="text-sm font-bold text-slate-800">{item.serviceName}{item.toothCode === null ? " · دون سن محدد" : <> · سن <bdi>{item.toothCode}</bdi></>}</p>
    <p className={quiet}>{item.planTitle} · خطة #{item.planId} / بند #{item.id} · {WORKFLOW_ITEM_STATUS_LABEL[item.status as WorkflowItemStatus]}</p>
    <p className={quiet}>الطبيب المعيّن للبند: {item.doctorName ?? "غير مسجل"}</p>
    <div className="mt-1 flex flex-wrap gap-x-3">
      {onFocus && planFocus ? <button type="button" className="min-h-10 text-xs font-bold text-teal-800 underline" data-testid={`specialty-open-plan-item-${item.id}`} onClick={() => onFocus(planFocus)}>راجع البند في خطته</button> : null}
      {onFocus && visitFocus ? <button type="button" className="min-h-10 text-xs font-bold text-teal-800 underline" data-testid={`specialty-review-visit-item-${item.id}`} onClick={() => onFocus(visitFocus)}>راجع هذا البند في الزيارة #{openVisitId}</button> : null}
    </div>
    {dependencies.length ? <ul className="mt-1 space-y-1" aria-label="ارتباطات البند">{dependencies.map((dependency) => {
      const required = snapshot.items.find((row) => row.id === dependency.requiresItemId)!;
      const target = specialtyPlanItemFocus(snapshot, required);
      return <li key={`${dependency.itemId}:${dependency.requiresItemId}`} className="text-xs leading-6 text-slate-600">
        <span>{dependency.met ? "متحقق حسب السجل" : "بانتظار"}: {required.serviceName}{required.toothCode === null ? "" : ` · سن ${required.toothCode}`} · {DEPENDENCY_REQUIREMENT_LABEL[dependency.requirement]}</span>
        {dependency.note ? <span> · {dependency.note}</span> : null}
        {onFocus && target ? <button type="button" className="ms-2 min-h-10 font-bold text-teal-800 underline" data-testid={`specialty-dependency-${dependency.itemId}-${dependency.requiresItemId}`} onClick={() => onFocus(target)}>افتح البند المطلوب #{required.id}</button> : null}
      </li>;
    })}</ul> : null}
  </li>;
}
