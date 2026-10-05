"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CASE_STATUS_LABEL, CASE_TERMINAL, DEPENDENCY_REQUIREMENT_LABEL, PROBLEM_STATUS_LABEL, SPECIALTY_LABEL,
  type CaseStatus, type DependencyRequirement, type ProblemStatus,
} from "@/lib/cases";
import { useSession } from "./SessionProvider";
import { SPECIALTIES, type ServiceSpecialty } from "@/lib/appointment-services";
import type { CasePlanItem, PatientProblem, PlanItemDependency, SpecialtyCase } from "@/lib/db";

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

const STATUS_TONE: Record<CaseStatus, string> = {
  active: "bg-emerald-50 text-emerald-800 border-emerald-200",
  waiting: "bg-amber-50 text-amber-800 border-amber-200",
  completed: "bg-sky-50 text-sky-800 border-sky-200",
  closed: "bg-slate-100 text-slate-600 border-slate-200",
  cancelled: "bg-rose-50 text-rose-700 border-rose-200",
};

const specialtyLabel = (value: string | null) =>
  value && value in SPECIALTY_LABEL ? SPECIALTY_LABEL[value as ServiceSpecialty] : value ?? "—";

interface PatientCasesProps {
  patientId: number;
  canWrite: boolean;
  onOpenOrtho?: () => unknown;
  /** Returns identity-bound cleanup, so an old child cannot clear a newer guard. */
  onNavigationGuardChange?: (guard: () => boolean) => () => void;
}
type CasesOwner = {
  active: boolean; ready: boolean; writes: number; readSequence: number;
  uncertain: boolean; hadUncertain: boolean; uncertainDrafts: Set<string>;
  controller: AbortController | null; drafts: Map<string, unknown>;
  priorities: Map<number, { value: string; readSequence: number }>;
};
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function linkedOrthoRow(row: SpecialtyCase, patientId: number) {
  return row.patientId === patientId && row.specialty === "orthodontics" && positiveId(row.orthoCaseId)
    && ["active", "completed", "closed"].includes(row.status)
    && (row.kind === "ortho" ? row.id === null : row.kind === "specialty" && positiveId(row.id));
}
function useCaseDraft<T>(owner: CasesOwner, key: string): [T | null, (next: T | null) => void, () => void] {
  const [value, publish] = useState<T | null>(null);
  const readSequence = owner.readSequence;
  return [value, (next) => {
    if (!owner.active || owner.writes > 0 || owner.uncertain || owner.readSequence !== readSequence
      || (next !== null && owner.uncertainDrafts.has(key))
      || (value === null ? owner.drafts.has(key) : owner.drafts.get(key) !== value)) return;
    if (next === null) { owner.drafts.delete(key); owner.uncertainDrafts.delete(key); } else owner.drafts.set(key, next);
    publish(next);
  }, () => {
    // Only the already-confirmed send completion invokes this branch. Its
    // authoritative refresh retires old editors, but must still close the exact
    // successfully saved draft; a changed/cancelled owner or draft never qualifies.
    if (!owner.active || owner.uncertain || owner.writes > 0 || value === null || owner.drafts.get(key) !== value) return;
    owner.drafts.delete(key); publish(null);
  }];
}

export function PatientCases(props: PatientCasesProps) {
  const session = useSession();
  const scope = JSON.stringify([props.patientId, session?.username, session?.role, session?.permissions ?? null, props.canWrite]);
  const canRead = !!session?.username?.trim() && ["admin", "doctor", "reception", "assistant"].includes(session.role);
  return <PatientCasesWorkspace key={scope} {...props} canRead={canRead} />;
}

function PatientCasesWorkspace({ patientId, canWrite, canRead, onOpenOrtho, onNavigationGuardChange }:
  PatientCasesProps & { canRead: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const owner = useRef<CasesOwner>({ active: false, ready: false, writes: 0, readSequence: 0,
    controller: null, drafts: new Map(), priorities: new Map(), uncertain: false, hadUncertain: false, uncertainDrafts: new Set() }).current;
  const [caseForm, setCaseForm, clearCaseFormAfterSave] = useCaseDraft<{ specialty: ServiceSpecialty; title: string; site: string; problem: string; responsiblePartyId: string }>(owner, "case");
  const [problemForm, setProblemForm, clearProblemFormAfterSave] = useCaseDraft<{ label: string; site: string; specialty: string; caseId: string }>(owner, "problem");
  const [closing, setClosing, clearClosingAfterSave] = useCaseDraft<{ id: number; status: CaseStatus; outcome: string }>(owner, "closing");
  const [depForm, setDepForm, clearDepFormAfterSave] = useCaseDraft<{ itemId: number; requiresItemId: string; requirement: DependencyRequirement }>(owner, "dependency");
  useLayoutEffect(() => {
    owner.active = true;
    return () => { owner.active = false; owner.ready = false; owner.readSequence++; owner.controller?.abort(); };
  }, [owner]);
  const canLeave = useCallback(() => {
    if (!owner.active || owner.writes > 0) return false;
    if (owner.hadUncertain) return window.confirm("نتيجة الحفظ غير مؤكدة؛ قد يكون الطلب نُفّذ. المغادرة لا تلغي الطلب ولا تعيد إرساله، وستُترك أي مسودة غير محفوظة. هل تريد مغادرة القسم؟");
    return (owner.drafts.size === 0 && owner.priorities.size === 0)
      || window.confirm("هناك عمل غير محفوظ في الحالات والمشاكل. هل تريد تجاهله؟");
  }, [owner]);
  useLayoutEffect(() => onNavigationGuardChange?.(canLeave), [canLeave, onNavigationGuardChange]);

  const load = useCallback(async (manualReview = false) => {
    if (!owner.active || (manualReview && owner.writes > 0)) return;
    const sequence = ++owner.readSequence;
    owner.controller?.abort();
    const controller = new AbortController(); owner.controller = controller;
    owner.ready = false; setReady(false);
    const current = () => owner.active && owner.readSequence === sequence && !controller.signal.aborted;
    try {
      if (!canRead) throw new Error("غير مصرّح لك بعرض حالات هذا المريض.");
      const response = await fetch(`/api/patients/${patientId}/cases`, { cache: "no-store", signal: controller.signal });
      if (!current()) return;
      if ([401, 403, 404].includes(response.status)) setData(null);
      const payload = await response.json().catch(() => null) as (Payload & { message?: string }) | null;
      if (!current()) return;
      if (!response.ok || response.redirected || !payload || !Array.isArray(payload.cases) || !Array.isArray(payload.problems)
        || !Array.isArray(payload.items) || !Array.isArray(payload.dependencies)
        || payload.cases.some(row => !row || row.patientId !== patientId
          || typeof row.title !== "string" || !Object.hasOwn(STATUS_TONE, row.status)
          || (row.kind !== "ortho" && row.kind !== "specialty")
          || (row.kind === "ortho" ? !linkedOrthoRow(row, patientId) : !positiveId(row.id))
          || (row.orthoCaseId !== null && !linkedOrthoRow(row, patientId)))) {
        throw new Error(payload?.message ?? "تعذّر التحقق من حالات هذا المريض. أعد التحميل.");
      }
      setData(payload);
      if (manualReview && owner.uncertain) {
        owner.uncertain = false; setUncertain(false);
        setReviewNotice("أُعيد تحميل السجل للمراجعة فقط؛ لا يعني ذلك تأكيد نتيجة الطلب السابق. المسودة غير المؤكدة لا تُرسل مجددًا؛ ألغها بعد المراجعة وأعد فتحها لبدء طلب جديد. لم يُعد إرسال أي طلب.");
      }
      owner.ready = !owner.uncertain; setReady(owner.ready); setError(null);
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : "تعذّر الاتصال بالخادم.");
    }
  }, [patientId, canRead, owner]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!canWrite) return;
    let active = true;
    void fetch("/api/parties?kind=doctor", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : [])
      .then((rows: unknown) => { if (active && owner.active) setDoctors(Array.isArray(rows) ? (rows as Doctor[]) : []); })
      .catch(() => { if (active && owner.active) setDoctors([]); });
    return () => { active = false; };
  }, [canWrite, owner]);

  const markUncertain = (draftKey?: string) => {
    if (!owner.active) return;
    owner.uncertain = true; owner.hadUncertain = true; owner.ready = false;
    owner.readSequence++; owner.controller?.abort();
    if (draftKey) owner.uncertainDrafts.add(draftKey);
    setUncertain(true); setReady(false); setError(null);
    setReviewNotice("تعذّر تأكيد نتيجة الحفظ. قد يكون الطلب نُفّذ. الكتابة متوقفة حتى إعادة تحميل السجل ومراجعته. المسودة غير المؤكدة لا تُرسل مجددًا؛ ألغها بعد المراجعة قبل بدء طلب جديد. لن يُعاد إرسال الطلب تلقائيًا.");
  };
  // The six existing route modules return a same-patient entity for case/problem
  // writes, and {ok:true} for plan-item links/dependencies. A followed login
  // redirect, HTML, malformed JSON or another entity is not a successful write proof.
  const confirmsMutation = (url: string, method: string, payload: unknown) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const value = payload as Record<string, unknown>;
    const samePatient = positiveId(value.id) && value.patientId === patientId;
    const caseEntity = samePatient && value.kind === "specialty" && typeof value.title === "string"
      && typeof value.status === "string" && Object.hasOwn(CASE_STATUS_LABEL, value.status);
    const problemEntity = samePatient && typeof value.label === "string"
      && typeof value.status === "string" && Object.hasOwn(PROBLEM_STATUS_LABEL, value.status);
    if (method === "POST" && url === `/api/patients/${patientId}/cases`) return caseEntity;
    if (method === "POST" && url === `/api/patients/${patientId}/problems`) return problemEntity;
    const entity = /^\/api\/(cases|problems)\/(\d+)$/.exec(url);
    if (method === "PATCH" && entity) return value.id === Number(entity[2])
      && (entity[1] === "cases" ? caseEntity : problemEntity);
    return value.ok === true && ((method === "PUT" && /^\/api\/plan-items\/\d+\/case$/.test(url))
      || (method === "POST" && /^\/api\/plan-items\/\d+\/dependencies$/.test(url))
      || (method === "DELETE" && /^\/api\/plan-items\/\d+\/dependencies\?requires=\d+$/.test(url)));
  };
  /** The synchronous latch also covers an existing priority onBlur write before a navigation click. */
  const send = async (url: string, method: string, body?: unknown, draftKey?: string, draftIdentity?: unknown): Promise<boolean> => {
    if (!owner.active || !owner.ready || owner.uncertain || !canWrite || owner.writes > 0 || owner.readSequence !== renderRead
      || (draftKey !== undefined && (!owner.drafts.has(draftKey) || owner.uncertainDrafts.has(draftKey)
        || owner.drafts.get(draftKey) !== draftIdentity))) return false;
    owner.writes++; setBusy(true);
    try {
      const response = await fetch(url, {
        method, headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!owner.active) return false;
      if (response.redirected || response.status >= 500
        || (!response.ok && ![400, 401, 403, 404, 409].includes(response.status))) {
        markUncertain(draftKey); return false;
      }
      if ([401, 403, 404].includes(response.status)) { owner.ready = false; setReady(false); setData(null); }
      const payload = await response.json().catch(() => null) as { message?: string } | null;
      if (!owner.active) return false;
      if (!response.ok) { setError(payload?.message ?? "تعذّر الحفظ."); return false; }
      if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" || !confirmsMutation(url, method, payload)) {
        markUncertain(draftKey); return false;
      }
      setError(null); await load();
      return owner.active;
    } catch {
      if (owner.active) markUncertain(draftKey);
      return false;
    } finally {
      owner.writes--; if (owner.active) setBusy(false);
    }
  };
  const writeBlocked = busy || uncertain || !ready;
  const renderRead = owner.readSequence;
  const openOrtho = (row: SpecialtyCase) => {
    if (!owner.active || !owner.ready || owner.writes > 0 || owner.readSequence !== renderRead
      || !data?.cases.includes(row) || !linkedOrthoRow(row, patientId)) return;
    // Navigation belongs to the page; it invokes the registered Cases guard.
    onOpenOrtho?.();
  };

  const itemsById = useMemo(() => new Map((data?.items ?? []).map((item) => [item.id, item])), [data]);
  const openCases = (data?.cases ?? []).filter((item) => item.id !== null && !CASE_TERMINAL.includes(item.status));
  const itemLabel = (item: CasePlanItem | undefined) =>
    item ? `${item.serviceName}${item.toothCode ? ` — سن ${item.toothCode}` : ""}` : "بند محذوف";

  if (!data) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
      <p role={error ? "alert" : "status"}>{error ?? "جارٍ التحميل…"}</p>
      {error && canRead ? <button type="button" onClick={() => void load(true)} className="mt-2 min-h-11 rounded-lg px-3 font-bold underline">إعادة تحميل الحالات</button> : null}
    </div>;
  }

  return (
    <div className="space-y-4" data-testid="patient-cases">
      {reviewNotice ? <div role="alert" data-testid="cases-write-uncertain" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
        <p>{reviewNotice}</p>
        <button type="button" disabled={busy} onClick={() => void load(true)} className="mt-1 min-h-11 rounded-lg px-3 font-bold underline">إعادة تحميل الحالات للمراجعة</button>
      </div> : null}
      {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800"><p>{error}</p>
        {!ready ? <button type="button" disabled={busy} onClick={() => void load(true)} className="min-h-11 px-3 font-bold underline">إعادة تحميل الحالات</button> : null}
      </div> : null}

      {/* ── الحالات التخصصية ── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="الحالات التخصصية">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-black text-navy-900">الحالات التخصصية</h3>
          {canWrite && !caseForm ? (
            <button type="button" disabled={writeBlocked} onClick={() => setCaseForm({ specialty: "endodontics", title: "", site: "", problem: "", responsiblePartyId: "" })}
              className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white">+ حالة جديدة</button>
          ) : null}
        </div>

        {caseForm ? (
          <div className="mb-3 grid gap-2 rounded-xl border border-navy-100 bg-navy-50/40 p-2 sm:grid-cols-2">
            <label className="text-xs font-bold text-slate-600">التخصص
              <select disabled={writeBlocked || owner.uncertainDrafts.has("case")} value={caseForm.specialty} onChange={(event) => setCaseForm({ ...caseForm, specialty: event.target.value as ServiceSpecialty })}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
                {SPECIALTIES.map((key) => <option key={key} value={key}>{SPECIALTY_LABEL[key]}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-slate-600">العنوان
              <input disabled={writeBlocked || owner.uncertainDrafts.has("case")} value={caseForm.title} onChange={(event) => setCaseForm({ ...caseForm, title: event.target.value })}
                placeholder="علاج عصب — سن ٣٦" className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs font-bold text-slate-600">الموضع (الأسنان / المنطقة)
              <input disabled={writeBlocked || owner.uncertainDrafts.has("case")} value={caseForm.site} onChange={(event) => setCaseForm({ ...caseForm, site: event.target.value })}
                placeholder="36" className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs font-bold text-slate-600">الطبيب المسؤول
              <select disabled={writeBlocked || owner.uncertainDrafts.has("case")} value={caseForm.responsiblePartyId} onChange={(event) => setCaseForm({ ...caseForm, responsiblePartyId: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
                <option value="">—</option>
                {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-slate-600 sm:col-span-2">المشكلة / التشخيص
              <textarea disabled={writeBlocked || owner.uncertainDrafts.has("case")} value={caseForm.problem} onChange={(event) => setCaseForm({ ...caseForm, problem: event.target.value })}
                rows={2} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
            </label>
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" disabled={writeBlocked || owner.uncertainDrafts.has("case") || !caseForm.title.trim()}
                onClick={async () => {
                  if (await send(`/api/patients/${patientId}/cases`, "POST", {
                    ...caseForm, responsiblePartyId: caseForm.responsiblePartyId || null,
                  }, "case", caseForm)) clearCaseFormAfterSave();
                }}
                className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">حفظ الحالة</button>
              <button type="button" disabled={writeBlocked} onClick={() => setCaseForm(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600">إلغاء</button>
            </div>
          </div>
        ) : null}

        {data.cases.length === 0 ? (
          <p className="text-xs text-slate-500">لا حالات تخصصية بعد. الخطة الشاملة وحدها تكفي لمريضٍ بتخصصٍ واحد.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {data.cases.map((item) => (
              <li key={item.id ?? `ortho-${item.orthoCaseId}`} className="rounded-xl border border-slate-200 p-2.5 text-sm">
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
                  <div className="mt-1 text-[11px] text-sky-700">
                    <p>تفاصيلها وإغلاقها في «التقويم وسيفالو» — تُقرأ هنا ضمن حالات المريض.</p>
                    {onOpenOrtho && ready && linkedOrthoRow(item, patientId) ? (
                      <button type="button" disabled={busy} onClick={() => openOrtho(item)}
                        data-testid={`cases-open-ortho-${item.orthoCaseId}`}
                        className="mt-1 min-h-11 max-w-full rounded-lg border border-sky-200 px-3 py-2 text-start text-xs font-bold text-sky-800 disabled:opacity-50">
                        عرض قسم التقويم للمريض
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {canWrite && item.kind === "ortho" && item.orthoCaseId !== null ? (
                  <button type="button" disabled={writeBlocked}
                    onClick={() => void send(`/api/patients/${patientId}/cases`, "POST", {
                      specialty: "orthodontics", title: item.title, orthoCaseId: item.orthoCaseId,
                      responsiblePartyId: item.responsiblePartyId,
                    })}
                    className="mt-2 rounded-lg border border-sky-200 px-2 py-0.5 text-[11px] font-bold text-sky-800">
                    ربطها بالمشاكل وبنود الخطة
                  </button>
                ) : null}
                {canWrite && item.id !== null && item.orthoCaseId === null && !CASE_TERMINAL.includes(item.status) ? (
                  closing?.id === item.id ? (
                    <div className="mt-2 space-y-1">
                      <textarea disabled={writeBlocked || owner.uncertainDrafts.has("closing")} value={closing.outcome} onChange={(event) => setClosing({ ...closing, outcome: event.target.value })}
                        rows={2} placeholder={closing.status === "cancelled" ? "سبب الإلغاء (مطلوب)" : "النتيجة (اختياري)"}
                        className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs" />
                      <div className="flex gap-2">
                        <button type="button" disabled={writeBlocked || owner.uncertainDrafts.has("closing") || (closing.status === "cancelled" && !closing.outcome.trim())}
                          onClick={async () => {
                            if (await send(`/api/cases/${item.id}`, "PATCH", { status: closing.status, outcome: closing.outcome || null }, "closing", closing)) clearClosingAfterSave();
                          }}
                          className="rounded-lg bg-navy-900 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40">
                          تأكيد: {CASE_STATUS_LABEL[closing.status]}
                        </button>
                        <button type="button" disabled={writeBlocked} onClick={() => setClosing(null)} className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600">رجوع</button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {item.status === "active" ? (
                        <button type="button" disabled={writeBlocked} onClick={() => void send(`/api/cases/${item.id}`, "PATCH", { status: "waiting" })}
                          className="rounded-lg border border-amber-200 px-2 py-0.5 text-[11px] font-bold text-amber-800">بانتظار</button>
                      ) : (
                        <button type="button" disabled={writeBlocked} onClick={() => void send(`/api/cases/${item.id}`, "PATCH", { status: "active" })}
                          className="rounded-lg border border-emerald-200 px-2 py-0.5 text-[11px] font-bold text-emerald-800">استئناف</button>
                      )}
                      {(["completed", "closed", "cancelled"] as CaseStatus[]).map((status) => (
                        <button key={status} type="button" onClick={() => setClosing({ id: item.id as number, status, outcome: "" })}
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
          {canWrite && !problemForm ? (
            <button type="button" disabled={writeBlocked} onClick={() => setProblemForm({ label: "", site: "", specialty: "", caseId: "" })}
              className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white">+ مشكلة</button>
          ) : null}
        </div>
        {problemForm ? (
          <div className="mb-3 grid gap-2 rounded-xl border border-navy-100 bg-navy-50/40 p-2 sm:grid-cols-4">
            <input disabled={writeBlocked || owner.uncertainDrafts.has("problem")} value={problemForm.label} onChange={(event) => setProblemForm({ ...problemForm, label: event.target.value })}
              placeholder="التهاب لب غير عكوس" aria-label="المشكلة" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm sm:col-span-2" />
            <input disabled={writeBlocked || owner.uncertainDrafts.has("problem")} value={problemForm.site} onChange={(event) => setProblemForm({ ...problemForm, site: event.target.value })}
              placeholder="36" aria-label="الموضع" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
            <select disabled={writeBlocked || owner.uncertainDrafts.has("problem")} value={problemForm.caseId} onChange={(event) => setProblemForm({ ...problemForm, caseId: event.target.value })}
              aria-label="الحالة" className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
              <option value="">بلا حالة</option>
              {openCases.map((item) => <option key={item.id} value={item.id as number}>{item.title}</option>)}
            </select>
            <div className="flex gap-2 sm:col-span-4">
              <button type="button" disabled={writeBlocked || owner.uncertainDrafts.has("problem") || !problemForm.label.trim()}
                onClick={async () => {
                  const linked = openCases.find((item) => String(item.id) === problemForm.caseId);
                  if (await send(`/api/patients/${patientId}/problems`, "POST", {
                    label: problemForm.label, site: problemForm.site || null,
                    specialty: linked?.specialty ?? null, caseId: problemForm.caseId || null,
                  }, "problem", problemForm)) clearProblemFormAfterSave();
                }}
                className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">حفظ</button>
              <button type="button" disabled={writeBlocked} onClick={() => setProblemForm(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600">إلغاء</button>
            </div>
          </div>
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
                  {canWrite ? (["active", "resolved", "inactive"] as ProblemStatus[])
                    .filter((status) => status !== problem.status)
                    .map((status) => (
                      <button key={status} type="button" disabled={writeBlocked}
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
        {data.planVisible === false ? (
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
                    {canWrite ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <select value={item.caseId ?? ""} disabled={writeBlocked} aria-label={`حالة ${item.serviceName}`}
                          onChange={(event) => void send(`/api/plan-items/${item.id}/case`, "PUT", { caseId: event.target.value || null, priority: item.priority })}
                          className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-xs">
                          <option value="">بلا حالة</option>
                          {data.cases.filter((one) => one.id !== null).map((one) => <option key={one.id} value={one.id as number}>{one.title}</option>)}
                        </select>
                        <input type="number" min={1} max={999} disabled={writeBlocked} defaultValue={item.priority ?? ""} aria-label={`أولوية ${item.serviceName}`}
                          onChange={(event) => {
                            if (!owner.active || !owner.ready || owner.uncertain || owner.writes > 0 || owner.readSequence !== renderRead) return;
                            const value = event.target.value.trim();
                            if (value === String(item.priority ?? "")) owner.priorities.delete(item.id);
                            else owner.priorities.set(item.id, { value, readSequence: renderRead });
                          }}
                          onBlur={(event) => {
                            if (!owner.active || !owner.ready || owner.uncertain || owner.writes > 0 || owner.readSequence !== renderRead) return;
                            const value = event.target.value.trim();
                            if (value === String(item.priority ?? "")) { owner.priorities.delete(item.id); return; }
                            // defaultValue does not reset a dirty DOM input after a
                            // reread. Require a new actual edit in this read generation;
                            // focusing/blurring retained pre-review text is not new intent.
                            const edited = owner.priorities.get(item.id);
                            if (!edited || edited.readSequence !== renderRead || edited.value !== value) return;
                            void send(`/api/plan-items/${item.id}/case`, "PUT", { caseId: item.caseId, priority: value || null })
                              .then(saved => { if (saved && owner.active && owner.priorities.get(item.id) === edited) owner.priorities.delete(item.id); });
                          }}
                          className="w-16 rounded-lg border border-slate-200 px-1.5 py-1 text-xs" placeholder="الأولوية" />
                        <button type="button" disabled={writeBlocked} onClick={() => setDepForm({ itemId: item.id, requiresItemId: "", requirement: "completed" })}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-600">+ يتطلب</button>
                      </span>
                    ) : null}
                  </div>
                  {requires.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {requires.map((dep) => (
                        <li key={dep.requiresItemId} className={dep.met ? "text-emerald-700" : "text-amber-800"}>
                          {dep.met ? "✓" : "⚠️"} يتطلب: {itemLabel(itemsById.get(dep.requiresItemId))} ({DEPENDENCY_REQUIREMENT_LABEL[dep.requirement]})
                          {canWrite ? (
                            <button type="button" disabled={writeBlocked}
                              onClick={() => void send(`/api/plan-items/${item.id}/dependencies?requires=${dep.requiresItemId}`, "DELETE")}
                              className="mr-1 text-[10px] font-bold text-slate-500 underline">إزالة</button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {depForm?.itemId === item.id ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <select disabled={writeBlocked || owner.uncertainDrafts.has("dependency")} value={depForm.requiresItemId} aria-label="البند المطلوب قبله"
                        onChange={(event) => setDepForm({ ...depForm, requiresItemId: event.target.value })}
                        className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-xs">
                        <option value="">اختر البند المطلوب قبله</option>
                        {data.items.filter((other) => other.id !== item.id).map((other) => (
                          <option key={other.id} value={other.id}>{itemLabel(other)}</option>
                        ))}
                      </select>
                      <select disabled={writeBlocked || owner.uncertainDrafts.has("dependency")} value={depForm.requirement} aria-label="نوع الاعتماد"
                        onChange={(event) => setDepForm({ ...depForm, requirement: event.target.value as DependencyRequirement })}
                        className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-xs">
                        <option value="completed">{DEPENDENCY_REQUIREMENT_LABEL.completed}</option>
                        <option value="clearance">{DEPENDENCY_REQUIREMENT_LABEL.clearance}</option>
                      </select>
                      <button type="button" disabled={writeBlocked || owner.uncertainDrafts.has("dependency") || !depForm.requiresItemId}
                        onClick={async () => {
                          if (await send(`/api/plan-items/${item.id}/dependencies`, "POST", {
                            requiresItemId: depForm.requiresItemId, requirement: depForm.requirement,
                          }, "dependency", depForm)) clearDepFormAfterSave();
                        }}
                        className="rounded-lg bg-navy-900 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40">حفظ</button>
                      <button type="button" disabled={writeBlocked} onClick={() => setDepForm(null)} className="text-[11px] font-bold text-slate-500">إلغاء</button>
                    </div>
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
