"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CASE_STATUS_LABEL, CASE_TERMINAL, DEPENDENCY_REQUIREMENT_LABEL, PROBLEM_STATUS_LABEL, SPECIALTY_LABEL,
  type CaseStatus, type DependencyRequirement, type ProblemStatus,
} from "@/lib/cases";
import { SPECIALTIES, type ServiceSpecialty } from "@/lib/appointment-services";
import type { CasePlanItem, PatientProblem, PlanItemDependency, SpecialtyCase } from "@/lib/db";
import { patientRecordFocusKey, resolveCaseFocus, type PatientCaseFocus } from "@/lib/patient-workspace-focus";
import { useSession } from "./SessionProvider";

/**
 * (CASE-MODEL-1) الحالات التخصصية وقائمة المشاكل وترتيب الخطة الشاملة — داخل «العلاج».
 *
 * مريضٌ واحد وسجلٌّ واحد وحالاتٌ كثيرة: كل حالة بتخصصها وطبيبها المسؤول وحالتها وبنودها،
 * والمشاكل النشطة أولًا، وبنود الخطة بأولويتها وما يتطلبه كلٌّ منها. الطبيب والمدير يكتبان؛
 * الاستقبال يطّلع. والمال لا يُمسّ هنا: الحساب واحد للمريض.
 */

interface Payload {
  cases: SpecialtyCase[];
  problems: PatientProblem[];
  items: CasePlanItem[];
  dependencies: PlanItemDependency[];
  /** صلاحية عرض خطط العلاج — بدونها تُحجب البنود وحدها. */
  planVisible?: boolean;
}

interface Doctor { id: number; name: string }

interface PatientCasesProps {
  patientId: number;
  canWrite: boolean;
  focus?: PatientCaseFocus | null;
  onNavigationGuardChange?: (guard: (() => boolean) | null) => void;
}

interface CaseDrafts {
  scope: number;
  caseForm: { specialty: ServiceSpecialty; title: string; site: string; problem: string; responsiblePartyId: string } | null;
  problemForm: { label: string; site: string; specialty: string; caseId: string } | null;
  closing: { id: number; status: CaseStatus; outcome: string } | null;
  depForm: { itemId: number; requiresItemId: string; requirement: DependencyRequirement } | null;
  priorities: Record<number, string>;
}
interface UncertainCaseWrite {
  patientId: number;
  attempt: number;
  afterRead: number;
  reviewed: boolean;
  reviewScope: number | null;
  draftKey?: "caseForm" | "problemForm" | "closing" | "depForm";
  priorityItemId?: number;
}
const emptyDrafts = (scope: number): CaseDrafts => ({ scope, caseForm: null, problemForm: null, closing: null, depForm: null, priorities: {} });
const hardDenial = (status: number) => status === 401 || status === 403 || status === 404;
const denialMessage = (status: number) => status === 404
  ? "سجل الحالات المطلوب غير متاح لهذا المريض."
  : "لم تعد صلاحية عرض هذا السجل متاحة. أعد التحقق من الجلسة.";

const STATUS_TONE: Record<CaseStatus, string> = {
  active: "bg-emerald-50 text-emerald-800 border-emerald-200",
  waiting: "bg-amber-50 text-amber-800 border-amber-200",
  completed: "bg-sky-50 text-sky-800 border-sky-200",
  closed: "bg-slate-100 text-slate-600 border-slate-200",
  cancelled: "bg-rose-50 text-rose-700 border-rose-200",
};

const specialtyLabel = (value: string | null) =>
  value && value in SPECIALTY_LABEL ? SPECIALTY_LABEL[value as ServiceSpecialty] : value ?? "—";

export function PatientCases({ patientId, canWrite, focus = null, onNavigationGuardChange }: PatientCasesProps) {
  const session = useSession();
  const contextKey = JSON.stringify([patientId, session?.username, session?.role, session?.permissions, canWrite]);
  const context = useRef({ key: contextKey, scope: 0, patientId });
  // Fence synchronously on render: effects alone leave a window for an old
  // request or an already captured event handler to publish into a new owner.
  if (context.current.key !== contextKey) context.current = { key: contextKey, scope: context.current.scope + 1, patientId };
  const scope = context.current.scope;
  const focusKey = patientRecordFocusKey(focus);
  const currentFocus = useRef(focusKey);
  const mounted = useRef(false);
  const loadSequence = useRef(0);
  const authorityVersion = useRef(0);
  const projectionRef = useRef<{ scope: number; payload: Payload } | null>(null);
  const readReadyRef = useRef<{ scope: number; focusKey: string; payload: Payload } | null>(null);
  // Render-only focus proposals must not retire the committed owner's read.
  // Layout publication fences old handlers before the new focus becomes usable.
  useLayoutEffect(() => {
    currentFocus.current = focusKey;
    if (readReadyRef.current && (readReadyRef.current.scope !== scope || readReadyRef.current.focusKey !== focusKey)) readReadyRef.current = null;
  }, [scope, focusKey]);
  const [projection, setProjection] = useState<{ scope: number; payload: Payload } | null>(null);
  const data = projection?.scope === scope ? projection.payload : null;
  const [freshRead, setFreshRead] = useState<{ scope: number; focusKey: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [issue, setIssue] = useState<{ scope: number; message: string } | null>(null);
  const error = issue?.scope === scope ? issue.message : null;
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<object | null>(null);
  const interactionVersion = useRef(0);
  const renderedInteraction = interactionVersion.current;
  // Only generic request uncertainty survives authority/patient switches. No
  // previous clinical payload or draft is stored in this component-lifetime map.
  const uncertainByPatient = useRef(new Map<number, UncertainCaseWrite>());
  const [, repaintUncertain] = useState(0);
  const uncertain = uncertainByPatient.current.get(patientId) ?? null;
  const [drafts, setDrafts] = useState<CaseDrafts>(() => emptyDrafts(scope));
  const draftRef = useRef(drafts);
  const currentDrafts = drafts.scope === scope ? drafts : emptyDrafts(scope);
  const { caseForm, problemForm, closing, depForm, priorities } = currentDrafts;
  const editable = canWrite && session !== null && data !== null;
  const writeReady = editable && !uncertain && freshRead?.scope === scope && freshRead.focusKey === focusKey;
  const canWriteRef = useRef(editable);
  canWriteRef.current = editable;

  const current = useCallback(() => mounted.current && context.current.scope === scope, [scope]);
  const setError = useCallback((message: string | null) => {
    if (current()) setIssue(message ? { scope, message } : null);
  }, [current, scope]);
  const replaceDrafts = useCallback((next: CaseDrafts) => {
    draftRef.current = next;
    setDrafts(next);
  }, []);
  const replaceUncertain = useCallback((owner: number, next: UncertainCaseWrite | null) => {
    if (next) uncertainByPatient.current.set(owner, next);
    else uncertainByPatient.current.delete(owner);
    repaintUncertain((version) => version + 1);
  }, []);
  const retire = useCallback((status: number) => {
    if (!current()) return;
    ++authorityVersion.current;
    projectionRef.current = null;
    readReadyRef.current = null;
    setProjection(null);
    setFreshRead(null);
    setDoctors([]);
    replaceDrafts(emptyDrafts(scope));
    canWriteRef.current = false;
    setError(denialMessage(status));
    // Deliberately retain inFlight: a hidden writer still owns its lock until
    // the network request settles, even after its authorized view is retired.
  }, [current, replaceDrafts, scope, setError]);

  const load = useCallback(async (reviewUncertain = false) => {
    if (!current() || currentFocus.current !== focusKey) return false;
    const sequence = ++loadSequence.current;
    const authority = authorityVersion.current;
    const attemptedWrite = uncertainByPatient.current.get(patientId) ?? null;
    if (attemptedWrite?.reviewed) replaceUncertain(patientId, { ...attemptedWrite, reviewed: false, reviewScope: null });
    const active = () => current() && currentFocus.current === focusKey && sequence === loadSequence.current && authority === authorityVersion.current;
    readReadyRef.current = null;
    setReading(true);
    setFreshRead(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/cases`, { cache: "no-store" });
      if (!active()) return false;
      // Status is authoritative even when the body is HTML, malformed or slow.
      if (hardDenial(response.status)) { retire(response.status); return false; }
      const payload = await response.json().catch(() => null) as (Payload & { message?: string }) | null;
      if (!active()) return false;
      if (!response.ok || !payload || !Array.isArray(payload.cases) || !Array.isArray(payload.problems)
        || !Array.isArray(payload.items) || !Array.isArray(payload.dependencies)) {
        setError(payload?.message ?? "تعذّر تحميل الحالات التخصصية.");
        return false;
      }
      if (payload.cases.some((row) => row.patientId !== patientId)
        || payload.problems.some((row) => row.patientId !== patientId)) {
        retire(404);
        return false;
      }
      if (payload.planVisible !== true) {
        if (projectionRef.current?.payload.planVisible === true) ++authorityVersion.current;
        if (draftRef.current.scope === scope) replaceDrafts({ ...draftRef.current, depForm: null, priorities: {} });
      }
      const next = { scope, payload };
      projectionRef.current = next;
      readReadyRef.current = { scope, focusKey, payload };
      setProjection(next);
      setFreshRead({ scope, focusKey });
      const currentAttempt = uncertainByPatient.current.get(patientId);
      if (reviewUncertain && attemptedWrite && currentAttempt?.attempt === attemptedWrite.attempt && sequence > attemptedWrite.afterRead) {
        replaceUncertain(patientId, { ...currentAttempt, reviewed: true, reviewScope: scope });
      }
      setError(null);
      return true;
    } catch {
      if (active()) setError("تعذّر الاتصال بالخادم.");
      return false;
    } finally {
      if (current() && sequence === loadSequence.current) setReading(false);
    }
  }, [current, focusKey, patientId, replaceDrafts, replaceUncertain, retire, scope, setError]);

  useLayoutEffect(() => {
    const requests = loadSequence;
    mounted.current = true;
    return () => { mounted.current = false; ++requests.current; };
  }, []);
  useEffect(() => {
    if (draftRef.current.scope !== scope) replaceDrafts(emptyDrafts(scope));
    setDoctors([]);
  }, [replaceDrafts, scope]);
  useEffect(() => {
    const requests = loadSequence;
    void load();
    return () => { ++requests.current; };
  }, [load]);
  useEffect(() => {
    let cancelled = false;
    if (!canWrite) return;
    const authority = authorityVersion.current;
    void fetch("/api/parties?kind=doctor", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : [])
      .then((rows: unknown) => { if (!cancelled && current() && authority === authorityVersion.current) setDoctors(Array.isArray(rows) ? rows as Doctor[] : []); })
      .catch(() => { if (!cancelled && current() && authority === authorityVersion.current) setDoctors([]); });
    return () => { cancelled = true; };
  }, [canWrite, current]);

  const guard = useCallback(() => {
    if (!mounted.current) return false;
    if (inFlight.current) {
      setIssue({ scope: context.current.scope, message: "انتظر اكتمال الحفظ قبل الإغلاق أو الانتقال." });
      return false;
    }
    const activeDraft = draftRef.current;
    if (activeDraft.scope !== context.current.scope) return true;
    if (activeDraft.caseForm || activeDraft.problemForm || activeDraft.closing || activeDraft.depForm) {
      setIssue({ scope: context.current.scope, message: "احفظ النموذج المفتوح أو أغلقه قبل الانتقال." });
      return false;
    }
    if (Object.keys(activeDraft.priorities).length > 0) {
      if (!window.confirm("هناك أولوية غير محفوظة. هل تريد تجاهلها؟")) return false;
      replaceDrafts(emptyDrafts(context.current.scope));
    }
    if (uncertainByPatient.current.has(context.current.patientId)
      && !window.confirm("نتيجة الحفظ السابق غير مؤكدة وقد يكون سُجّل بالفعل. مغادرة هذه الشاشة قد تنهي التحذير المحلي، وإعادة تحميل الصفحة تنهيه؛ راجع السجل قبل إنشاء أي طلب آخر لتجنب التكرار. هل تريد المغادرة؟")) return false;
    return true;
  }, [replaceDrafts]);
  useLayoutEffect(() => {
    onNavigationGuardChange?.(guard);
    return () => onNavigationGuardChange?.(null);
  }, [guard, onNavigationGuardChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const pending = draftRef.current;
      if (inFlight.current || uncertainByPatient.current.has(context.current.patientId)
        || (pending.scope === context.current.scope && (pending.caseForm || pending.problemForm || pending.closing || pending.depForm || Object.keys(pending.priorities).length))) {
        event.preventDefault(); event.returnValue = "";
      }
    };
    window.addEventListener?.("beforeunload", warn);
    return () => window.removeEventListener?.("beforeunload", warn);
  }, []);

  const changeDraft = <K extends Exclude<keyof CaseDrafts, "scope">>(key: K, value: CaseDrafts[K], expected?: CaseDrafts[K]) => {
    if (!current() || inFlight.current || !canWriteRef.current || projectionRef.current?.payload !== data
      || renderedInteraction !== interactionVersion.current) return;
    const previous = draftRef.current.scope === scope ? draftRef.current : emptyDrafts(scope);
    if (expected !== undefined && previous[key] !== expected) return;
    if (key === "closing" && previous.closing && value) {
      const next = value as NonNullable<CaseDrafts["closing"]>;
      if (previous.closing.id !== next.id || previous.closing.status !== next.status) {
        setError("احفظ نموذج الإغلاق المفتوح أو أغلقه قبل اختيار حالة أخرى."); return;
      }
    }
    if (key === "depForm" && previous.depForm && value
      && previous.depForm.itemId !== (value as NonNullable<CaseDrafts["depForm"]>).itemId) {
      setError("احفظ نموذج الاعتماد المفتوح أو أغلقه قبل اختيار بند آخر."); return;
    }
    replaceDrafts({ ...previous, [key]: value });
  };
  const setCaseForm = (value: CaseDrafts["caseForm"]) => changeDraft("caseForm", value, caseForm);
  const setProblemForm = (value: CaseDrafts["problemForm"]) => changeDraft("problemForm", value, problemForm);
  const setClosing = (value: CaseDrafts["closing"]) => changeDraft("closing", value, closing);
  const setDepForm = (value: CaseDrafts["depForm"]) => changeDraft("depForm", value, depForm);

  /** كل كتابة: طلبٌ واحد، ورسالة الخادم العربية كما هي عند الرفض، ثم إعادة تحميل. */
  const send = async (url: string, method: string, body?: unknown, draft?: { key: "caseForm" | "problemForm" | "closing" | "depForm"; value: object }): Promise<boolean> => {
    if (!current() || !canWriteRef.current || inFlight.current || !data || projectionRef.current?.payload !== data
      || uncertainByPatient.current.has(patientId)
      || readReadyRef.current?.scope !== scope || readReadyRef.current.focusKey !== focusKey || readReadyRef.current.payload !== data
      || renderedInteraction !== interactionVersion.current
      || (draft && draftRef.current[draft.key] !== draft.value)) return false;
    const record = body as Record<string, unknown> | undefined;
    const uniqueCase = (id: unknown) => data.cases.filter((row) => row.id !== null && String(row.id) === String(id) && row.patientId === patientId);
    const caseRoute = /^\/api\/cases\/([1-9]\d*)$/.exec(url);
    const problemRoute = /^\/api\/problems\/([1-9]\d*)$/.exec(url);
    const itemRoute = /^\/api\/plan-items\/([1-9]\d*)\/(case|dependencies)(?:\?requires=([1-9]\d*))?$/.exec(url);
    if (caseRoute) {
      const matches = uniqueCase(caseRoute[1]);
      if (matches.length !== 1 || matches[0].orthoCaseId !== null || CASE_TERMINAL.includes(matches[0].status)) return false;
    } else if (problemRoute) {
      if (data.problems.filter((row) => String(row.id) === problemRoute[1] && row.patientId === patientId).length !== 1) return false;
    } else if (itemRoute) {
      const id = Number(itemRoute[1]);
      if (data.planVisible !== true || data.items.filter((row) => row.id === id).length !== 1) return false;
      if (itemRoute[2] === "case" && record?.caseId != null && uniqueCase(record.caseId).length !== 1) return false;
      if (itemRoute[2] === "dependencies") {
        const required = Number(method === "DELETE" ? itemRoute[3] : record?.requiresItemId);
        if (required === id || data.items.filter((row) => row.id === required).length !== 1) return false;
        if (method === "DELETE" && !data.dependencies.some((row) => row.itemId === id && row.requiresItemId === required)) return false;
      }
    } else if (url === `/api/patients/${patientId}/cases`) {
      if (record?.orthoCaseId != null && data.cases.filter((row) => row.kind === "ortho" && row.orthoCaseId === record.orthoCaseId && row.patientId === patientId).length !== 1) return false;
    } else if (url === `/api/patients/${patientId}/problems`) {
      if (record?.caseId != null && uniqueCase(record.caseId).length !== 1) return false;
    } else return false;
    const operation = {};
    const authority = authorityVersion.current;
    const active = () => current() && authority === authorityVersion.current && inFlight.current === operation;
    ++interactionVersion.current;
    const attempt = interactionVersion.current;
    const uncertainResult = () => {
      if (!mounted.current) return;
      replaceUncertain(patientId, { patientId, attempt, afterRead: loadSequence.current, reviewed: false, reviewScope: null, draftKey: draft?.key,
        priorityItemId: itemRoute?.[2] === "case" ? Number(itemRoute[1]) : undefined });
      if (context.current.patientId !== patientId) return;
      readReadyRef.current = null;
      setFreshRead(null);
      setIssue({ scope: context.current.scope, message: "نتيجة الحفظ غير مؤكدة؛ قد يكون الطلب سُجّل بالفعل. لا تُعد إرساله قبل تحديث السجل ومراجعته." });
    };
    inFlight.current = operation;
    setBusy(true);
    try {
      const response = await fetch(url, {
        method, headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!active()) {
        if (response.ok || response.status < 400 || response.status >= 500 || response.status === 408 || response.status === 499) uncertainResult();
        return false;
      }
      if (hardDenial(response.status)) { retire(response.status); return false; }
      if ((!response.ok && response.status < 400) || response.status >= 500 || response.status === 408 || response.status === 499) { uncertainResult(); return false; }
      const payload = await response.json().catch(() => null) as { message?: string; id?: unknown; patientId?: unknown; ok?: unknown } | null;
      if (!active()) {
        if (response.ok) uncertainResult();
        return false;
      }
      if (!response.ok) { setError(payload?.message ?? "تعذّر الحفظ."); return false; }
      const recordEndpoint = !!caseRoute || !!problemRoute || url === `/api/patients/${patientId}/cases` || url === `/api/patients/${patientId}/problems`;
      const confirmed = payload && (recordEndpoint
        ? typeof payload.id === "number" && Number.isSafeInteger(payload.id) && payload.id > 0 && payload.patientId === patientId
        : payload.ok === true);
      if (!confirmed) { uncertainResult(); return false; }
      setError(null);
      // The mutation succeeded. Clear only the exact submitted owner; refresh
      // never clears unrelated drafts and cannot make a successful write retry.
      if (draft && draftRef.current[draft.key] === draft.value) {
        replaceDrafts({ ...draftRef.current, [draft.key]: null });
      }
      await load();
      return active();
    } catch {
      uncertainResult();
      return false;
    } finally {
      if (inFlight.current === operation) {
        inFlight.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  };

  const acknowledgeNewIntent = () => {
    const attempt = uncertainByPatient.current.get(patientId);
    if (!current() || inFlight.current || !canWriteRef.current || !attempt || !attempt.reviewed || attempt.reviewScope !== scope
      || attempt !== uncertain || readReadyRef.current?.scope !== scope || readReadyRef.current.focusKey !== focusKey
      || readReadyRef.current.payload !== data) return;
    if (!window.confirm("راجعت السجل المُحدّث. قد يكون الطلب السابق سُجّل بالفعل، وبدء طلب جديد قد ينشئ سجلًا مكررًا. هل تريد إنهاء التحذير وبدء طلب جديد مستقل؟")) return;
    // Acknowledgment releases a new intent, never retries or identifies an old
    // operation. Retire its draft and stale handlers while preserving siblings.
    ++interactionVersion.current;
    if (attempt.draftKey && draftRef.current.scope === scope) replaceDrafts({ ...draftRef.current, [attempt.draftKey]: null });
    if (attempt.priorityItemId !== undefined && draftRef.current.scope === scope) {
      const next = { ...draftRef.current.priorities };
      delete next[attempt.priorityItemId];
      replaceDrafts({ ...draftRef.current, priorities: next });
    }
    replaceUncertain(patientId, null);
    setError(null);
  };
  const uncertaintyNotice = uncertain ? (
    <div role="alert" data-testid="case-write-uncertain" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p>نتيجة الحفظ السابق غير مؤكدة؛ قد يكون سُجّل بالفعل. أوقفنا الإرسال لمنع إعادة طلب قد يكرر السجل.</p>
      <p>حدّث السجل وراجعه بنفسك قبل بدء طلب جديد. لا يمكن تحديد نتيجة الطلب السابق من عنوان السجل أو توقيته.</p>
      <p className="text-xs">هذا التحذير محلي ما دامت الشاشة محمّلة، ويُحتفظ به لكل مريض عند تبديل المريض أو الحساب. لا يستمر بعد إعادة تحميل الصفحة أو إغلاقها، وقد تنهيه مغادرة الشاشة. تبديل الصلاحيات يتطلب مراجعة جديدة.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || reading} onClick={() => { if (!inFlight.current) void load(true); }} className="rounded-lg border border-amber-400 px-3 py-1.5 font-bold">تحديث السجل للمراجعة</button>
        <button type="button" disabled={busy || reading || !uncertain.reviewed || uncertain.reviewScope !== scope || !data || !editable} onClick={acknowledgeNewIntent} className="rounded-lg border border-amber-400 px-3 py-1.5 font-bold">راجعت السجل، بدء طلب جديد</button>
      </div>
    </div>
  ) : null;

  const itemsById = useMemo(() => new Map((data?.items ?? []).map((item) => [item.id, item])), [data]);
  const openCases = (data?.cases ?? []).filter((item) => item.id !== null && !CASE_TERMINAL.includes(item.status));
  const itemLabel = (item: CasePlanItem | undefined) =>
    item ? `${item.serviceName}${item.toothCode ? ` — سن ${item.toothCode}` : ""}` : "بند محذوف";
  const focusResolution = focus && data && freshRead?.scope === scope && freshRead.focusKey === focusKey
    ? resolveCaseFocus(patientId, focus, data.cases) : null;
  const focusedCase = focusResolution?.status === "ready" ? focusResolution.record : null;
  const focusNotice = focus ? focusedCase ? (
    <p role="status" data-testid="case-focus-ready" className="rounded-xl border border-sky-200 bg-sky-50 p-2 text-sm text-sky-800">الحالة المطلوبة: {focusedCase.title}</p>
  ) : (
    <p role="status" data-testid="case-focus-unavailable" className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
      {reading ? "جارٍ التحقق من الحالة المطلوبة…" : "الحالة المطلوبة غير متاحة في السجل الحالي. لم تُحدّد حالة بديلة."}
    </p>
  ) : null;

  if (!data) {
    return <div className="space-y-2" data-testid="patient-cases">{focusNotice}{uncertaintyNotice}
      <p role={error ? "alert" : "status"} className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">{error ?? "جارٍ التحميل…"}</p>
      {error ? <button type="button" disabled={busy || reading} onClick={() => { if (!inFlight.current) void load(); }} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold">إعادة المحاولة</button> : null}
    </div>;
  }

  return (
    <div className="space-y-4" data-testid="patient-cases">
      {focusNotice}
      {uncertaintyNotice}
      {error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">{error}</p> : null}
      {error && !uncertain ? <button type="button" disabled={busy || reading} onClick={() => { if (!inFlight.current) void load(); }} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold">إعادة المحاولة</button> : null}
      {closing && !data.cases.some((item) => item.id === closing.id && item.orthoCaseId === null && !CASE_TERMINAL.includes(item.status)) ? (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
          حالة مسودة الإغلاق لم تعد متاحة للتحرير. احتُفظ بالمسودة دون حفظها.
          <button type="button" disabled={busy} onClick={() => setClosing(null)} className="mr-2 underline">تجاهل مسودة الإغلاق</button>
        </div>
      ) : null}
      {depForm && !data.items.some((item) => item.id === depForm.itemId) ? (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
          بند مسودة الاعتماد لم يعد متاحًا. احتُفظ بالمسودة دون حفظها.
          <button type="button" disabled={busy} onClick={() => setDepForm(null)} className="mr-2 underline">تجاهل مسودة الاعتماد</button>
        </div>
      ) : null}

      {/* ── الحالات التخصصية ── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="الحالات التخصصية">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-black text-navy-900">الحالات التخصصية</h3>
          <button type="button" disabled={busy || reading} onClick={() => { if (!inFlight.current) void load(); }} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold">تحديث السجل</button>
          {editable && !caseForm ? (
            <button type="button" disabled={busy} onClick={() => setCaseForm({ specialty: "endodontics", title: "", site: "", problem: "", responsiblePartyId: "" })}
              className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white">+ حالة جديدة</button>
          ) : null}
        </div>

        {editable && caseForm ? (
          <fieldset disabled={busy} className="mb-3 grid gap-2 rounded-xl border border-navy-100 bg-navy-50/40 p-2 sm:grid-cols-2">
            <label className="text-xs font-bold text-slate-600">التخصص
              <select value={caseForm.specialty} onChange={(event) => setCaseForm({ ...caseForm, specialty: event.target.value as ServiceSpecialty })}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
                {SPECIALTIES.map((key) => <option key={key} value={key}>{SPECIALTY_LABEL[key]}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-slate-600">العنوان
              <input value={caseForm.title} onChange={(event) => setCaseForm({ ...caseForm, title: event.target.value })}
                placeholder="علاج عصب — سن ٣٦" className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs font-bold text-slate-600">الموضع (الأسنان / المنطقة)
              <input value={caseForm.site} onChange={(event) => setCaseForm({ ...caseForm, site: event.target.value })}
                placeholder="36" className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs font-bold text-slate-600">الطبيب المسؤول
              <select value={caseForm.responsiblePartyId} onChange={(event) => setCaseForm({ ...caseForm, responsiblePartyId: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
                <option value="">—</option>
                {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-slate-600 sm:col-span-2">المشكلة / التشخيص
              <textarea value={caseForm.problem} onChange={(event) => setCaseForm({ ...caseForm, problem: event.target.value })}
                rows={2} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
            </label>
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" disabled={busy || !writeReady || !caseForm.title.trim()}
                onClick={async () => {
                  await send(`/api/patients/${patientId}/cases`, "POST", {
                    ...caseForm, responsiblePartyId: caseForm.responsiblePartyId || null,
                  }, { key: "caseForm", value: caseForm });
                }}
                className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">حفظ الحالة</button>
              <button type="button" disabled={busy} onClick={() => setCaseForm(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600">إلغاء</button>
            </div>
          </fieldset>
        ) : null}

        {data.cases.length === 0 ? (
          <p className="text-xs text-slate-500">لا حالات تخصصية بعد. الخطة الشاملة وحدها تكفي لمريضٍ بتخصصٍ واحد.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {data.cases.map((item) => (
              <li key={item.id ?? `ortho-${item.orthoCaseId}`} data-focused-case={focusedCase === item ? String(item.id) : undefined}
                className={`rounded-xl border p-2.5 text-sm ${focusedCase === item ? "border-sky-400 bg-sky-50 ring-2 ring-sky-200" : "border-slate-200"}`}>
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="font-extrabold text-navy-900">{item.title}{item.site ? ` · ${item.site}` : ""}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${STATUS_TONE[item.status]}`}>{CASE_STATUS_LABEL[item.status]}</span>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  {specialtyLabel(item.specialty)} · المسؤول: {item.responsibleName ?? "—"}
                  {item.itemsTotal > 0 ? ` · البنود ${item.itemsDone}/${item.itemsTotal}` : ""}
                </p>
                {item.waitingOn?.length ? (
                  <p className="mt-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-800">
                    بانتظار: {item.waitingOn.join("، ")}
                  </p>
                ) : null}
                {item.problem ? <p className="mt-1 text-xs text-slate-500">{item.problem}</p> : null}
                {item.outcome ? <p className="mt-1 text-xs text-slate-500">النتيجة: {item.outcome}</p> : null}
                {item.kind === "ortho" || item.orthoCaseId !== null ? (
                  <p className="mt-1 text-[11px] text-sky-700">تفاصيلها وإغلاقها في «التقويم وسيفالو» — تُقرأ هنا ضمن حالات المريض.</p>
                ) : null}
                {editable && item.kind === "ortho" && item.orthoCaseId !== null ? (
                  <button type="button" disabled={busy || !writeReady}
                    onClick={() => void send(`/api/patients/${patientId}/cases`, "POST", {
                      specialty: "orthodontics", title: item.title, orthoCaseId: item.orthoCaseId,
                      responsiblePartyId: item.responsiblePartyId,
                    })}
                    className="mt-2 rounded-lg border border-sky-200 px-2 py-0.5 text-[11px] font-bold text-sky-800">
                    ربطها بالمشاكل وبنود الخطة
                  </button>
                ) : null}
                {editable && item.id !== null && item.orthoCaseId === null && !CASE_TERMINAL.includes(item.status) ? (
                  closing?.id === item.id ? (
                    <fieldset disabled={busy} className="mt-2 space-y-1">
                      <textarea value={closing.outcome} onChange={(event) => setClosing({ ...closing, outcome: event.target.value })}
                        rows={2} placeholder={closing.status === "cancelled" ? "سبب الإلغاء (مطلوب)" : "النتيجة (اختياري)"}
                        className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs" />
                      <div className="flex gap-2">
                        <button type="button" disabled={busy || !writeReady || (closing.status === "cancelled" && !closing.outcome.trim())}
                          onClick={async () => {
                            await send(`/api/cases/${item.id}`, "PATCH", { status: closing.status, outcome: closing.outcome || null }, { key: "closing", value: closing });
                          }}
                          className="rounded-lg bg-navy-900 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40">
                          تأكيد: {CASE_STATUS_LABEL[closing.status]}
                        </button>
                        <button type="button" disabled={busy} onClick={() => setClosing(null)} className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600">رجوع</button>
                      </div>
                    </fieldset>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {item.status === "active" ? (
                        <button type="button" disabled={busy || !writeReady} onClick={() => void send(`/api/cases/${item.id}`, "PATCH", { status: "waiting" })}
                          className="rounded-lg border border-amber-200 px-2 py-0.5 text-[11px] font-bold text-amber-800">بانتظار</button>
                      ) : (
                        <button type="button" disabled={busy || !writeReady} onClick={() => void send(`/api/cases/${item.id}`, "PATCH", { status: "active" })}
                          className="rounded-lg border border-emerald-200 px-2 py-0.5 text-[11px] font-bold text-emerald-800">استئناف</button>
                      )}
                      {(["completed", "closed", "cancelled"] as CaseStatus[]).map((status) => (
                        <button key={status} type="button" disabled={busy} onClick={() => setClosing({ id: item.id as number, status, outcome: "" })}
                          className="rounded-lg border border-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-600">{CASE_STATUS_LABEL[status]}</button>
                      ))}
                    </div>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── قائمة المشاكل ── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="قائمة المشاكل">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-black text-navy-900">قائمة المشاكل</h3>
          {editable && !problemForm ? (
            <button type="button" disabled={busy} onClick={() => setProblemForm({ label: "", site: "", specialty: "", caseId: "" })}
              className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white">+ مشكلة</button>
          ) : null}
        </div>
        {editable && problemForm ? (
          <fieldset disabled={busy} className="mb-3 grid gap-2 rounded-xl border border-navy-100 bg-navy-50/40 p-2 sm:grid-cols-4">
            <input value={problemForm.label} onChange={(event) => setProblemForm({ ...problemForm, label: event.target.value })}
              placeholder="التهاب لب غير عكوس" aria-label="المشكلة" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm sm:col-span-2" />
            <input value={problemForm.site} onChange={(event) => setProblemForm({ ...problemForm, site: event.target.value })}
              placeholder="36" aria-label="الموضع" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
            <select value={problemForm.caseId} onChange={(event) => setProblemForm({ ...problemForm, caseId: event.target.value })}
              aria-label="الحالة" className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
              <option value="">بلا حالة</option>
              {openCases.map((item) => <option key={item.id} value={item.id as number}>{item.title}</option>)}
            </select>
            <div className="flex gap-2 sm:col-span-4">
              <button type="button" disabled={busy || !writeReady || !problemForm.label.trim()}
                onClick={async () => {
                  const linked = openCases.find((item) => String(item.id) === problemForm.caseId);
                  if (problemForm.caseId && !linked) { setError("الحالة المرتبطة لم تعد متاحة. اختر حالة صالحة أو بلا حالة."); return; }
                  await send(`/api/patients/${patientId}/problems`, "POST", {
                    label: problemForm.label, site: problemForm.site || null,
                    specialty: linked?.specialty ?? null, caseId: problemForm.caseId || null,
                  }, { key: "problemForm", value: problemForm });
                }}
                className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">حفظ</button>
              <button type="button" disabled={busy} onClick={() => setProblemForm(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600">إلغاء</button>
            </div>
          </fieldset>
        ) : null}
        {data.problems.length === 0 ? (
          <p className="text-xs text-slate-500">لا مشاكل مسجّلة.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.problems.map((problem) => (
              <li key={problem.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span className={problem.status === "active" ? "font-bold text-slate-800" : "text-slate-400 line-through"}>
                  {problem.label}{problem.site ? ` · ${problem.site}` : ""}
                  {problem.caseTitle ? <span className="mr-1 text-[11px] text-slate-500">({problem.caseTitle})</span> : null}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-[11px] text-slate-500">{PROBLEM_STATUS_LABEL[problem.status]}</span>
                  {editable ? (["active", "resolved", "inactive"] as ProblemStatus[])
                    .filter((status) => status !== problem.status)
                    .map((status) => (
                      <button key={status} type="button" disabled={busy || !writeReady}
                        onClick={() => void send(`/api/problems/${problem.id}`, "PATCH", { status })}
                        className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
                        {status === "resolved" ? "حُلّت" : status === "inactive" ? "غير نشطة" : "إعادة تنشيط"}
                      </button>
                    )) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── ترتيب الخطة الشاملة وما يتطلبه كل بند ── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="ترتيب الخطة الشاملة">
        <h3 className="mb-2 text-sm font-black text-navy-900">ترتيب الخطة الشاملة</h3>
        {data.planVisible !== true ? (
          <p className="text-xs text-slate-500">عرض خطط العلاج غير مفعّل لحسابك.</p>
        ) : data.items.length === 0 ? (
          <p className="text-xs text-slate-500">لا بنود خطة قائمة.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {data.items.map((item) => {
              const requires = data.dependencies.filter((dep) => dep.itemId === item.id);
              const blocked = requires.some((dep) => !dep.met) && item.status !== "done" && item.status !== "cancelled";
              return (
                <li key={item.id} className={`rounded-xl border p-2 ${blocked ? "border-amber-300 bg-amber-50/50" : "border-slate-200"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-bold text-slate-800">
                      {item.priority ? <span className="ml-1 rounded bg-navy-900 px-1.5 text-[10px] text-white">{item.priority}</span> : null}
                      {itemLabel(item)}
                      <span className="mr-1 text-[11px] font-normal text-slate-500">· {item.planTitle} · {item.doctorName ?? "—"} · {item.status === "done" ? "منفَّذ" : item.status === "in_progress" ? "قيد التنفيذ" : "مخطَّط"}</span>
                    </span>
                    {editable ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <select value={item.caseId ?? ""} disabled={busy || !writeReady} aria-label={`حالة ${item.serviceName}`}
                          onChange={(event) => void send(`/api/plan-items/${item.id}/case`, "PUT", { caseId: event.target.value || null, priority: item.priority })}
                          className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-xs">
                          <option value="">بلا حالة</option>
                          {data.cases.filter((one) => one.id !== null).map((one) => <option key={one.id} value={one.id as number}>{one.title}</option>)}
                        </select>
                        <input type="number" min={1} max={999} disabled={busy} value={priorities[item.id] ?? String(item.priority ?? "")} aria-label={`أولوية ${item.serviceName}`}
                          onChange={(event) => {
                            const next = { ...draftRef.current.priorities };
                            if (event.target.value === String(item.priority ?? "")) delete next[item.id];
                            else next[item.id] = event.target.value;
                            changeDraft("priorities", next);
                          }}
                          onBlur={(event) => {
                            const value = event.target.value.trim();
                            if (value === String(item.priority ?? "")) return;
                            if (value !== "" && (!/^[1-9]\d*$/.test(value) || Number(value) > 999)) {
                              setError("الأولوية يجب أن تكون عددًا صحيحًا من ١ إلى ٩٩٩."); return;
                            }
                            const raw = event.target.value;
                            if (draftRef.current.priorities[item.id] !== raw) return;
                            void send(`/api/plan-items/${item.id}/case`, "PUT", { caseId: item.caseId, priority: value || null }).then((saved) => {
                              if (!saved || !current() || draftRef.current.priorities[item.id] !== raw) return;
                              const next = { ...draftRef.current.priorities };
                              delete next[item.id];
                              replaceDrafts({ ...draftRef.current, priorities: next });
                            });
                          }}
                          className="w-16 rounded-lg border border-slate-200 px-1.5 py-1 text-xs" placeholder="الأولوية" />
                        <button type="button" disabled={busy} onClick={() => setDepForm({ itemId: item.id, requiresItemId: "", requirement: "completed" })}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-600">+ يتطلب</button>
                      </span>
                    ) : null}
                  </div>
                  {requires.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {requires.map((dep) => (
                        <li key={dep.requiresItemId} className={dep.met ? "text-emerald-700" : "text-amber-800"}>
                          {dep.met ? "✓" : "⚠️"} يتطلب: {itemLabel(itemsById.get(dep.requiresItemId))} ({DEPENDENCY_REQUIREMENT_LABEL[dep.requirement]})
                          {editable ? (
                            <button type="button" disabled={busy || !writeReady}
                              onClick={() => void send(`/api/plan-items/${item.id}/dependencies?requires=${dep.requiresItemId}`, "DELETE")}
                              className="mr-1 text-[10px] font-bold text-slate-500 underline">إزالة</button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {editable && depForm?.itemId === item.id ? (
                    <fieldset disabled={busy} className="mt-2 flex flex-wrap items-center gap-1.5">
                      <select value={depForm.requiresItemId} aria-label="البند المطلوب قبله"
                        onChange={(event) => setDepForm({ ...depForm, requiresItemId: event.target.value })}
                        className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-xs">
                        <option value="">اختر البند المطلوب قبله</option>
                        {data.items.filter((other) => other.id !== item.id).map((other) => (
                          <option key={other.id} value={other.id}>{itemLabel(other)}</option>
                        ))}
                      </select>
                      <select value={depForm.requirement} aria-label="نوع الاعتماد"
                        onChange={(event) => setDepForm({ ...depForm, requirement: event.target.value as DependencyRequirement })}
                        className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-xs">
                        <option value="completed">{DEPENDENCY_REQUIREMENT_LABEL.completed}</option>
                        <option value="clearance">{DEPENDENCY_REQUIREMENT_LABEL.clearance}</option>
                      </select>
                      <button type="button" disabled={busy || !writeReady || !depForm.requiresItemId}
                        onClick={async () => {
                          if (!data.items.some((other) => String(other.id) === depForm.requiresItemId && other.id !== item.id)) {
                            setError("البند المطلوب لم يعد متاحًا. اختر بندًا قائمًا في خطة المريض."); return;
                          }
                          await send(`/api/plan-items/${item.id}/dependencies`, "POST", {
                            requiresItemId: depForm.requiresItemId, requirement: depForm.requirement,
                          }, { key: "depForm", value: depForm });
                        }}
                        className="rounded-lg bg-navy-900 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40">حفظ</button>
                      <button type="button" disabled={busy} onClick={() => setDepForm(null)} className="text-[11px] font-bold text-slate-500">إلغاء</button>
                    </fieldset>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
