"use client";

import { cephStudyHref, clinicalContextSearch, type ClinicalNavigationContext } from "@/lib/patient-navigation";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "./SessionProvider";
import { CephUnlinkedStudiesPanel } from "./CephUnlinkedStudiesPanel";
import { friendlyDateLong } from "@/lib/reminders";
import {
  CEPH_DIAGNOSTIC_STAGES,
  suggestCephPhase,
  type CephDiagnosticStage,
  type OrthoPhase,
} from "@/lib/ortho";

/**
 * كابينة التحليل السيفالومتري ومخطط ويب سيف (WebCeph & Ceph Analysis Cockpit).
 *
 * الركن التشخيصي الأساسي في تقويم الأسنان:
 * - دراسات السيفالومتري مصنفة حسب مراحل التقويم الأربع:
 *   * T1: ما قبل العلاج (التشخيص الأولي وخطة العلاج)
 *   * T2: أثناء التقدم والعلاج (حركة الجذور واستجابة الفكين)
 *   * T3: بعد انتهاء العلاج (استقرار الإطباق والنتيجة الجمالية)
 *   * T4: المتابعة والتثبيت (الاستبقاء ومنع الارتداد)
 *
 * ترتبط مباشرة بحالة التقويم التخصصية للمريض، مع ربط تلقائي بالشععة والمعايرة
 * والمدارس السبع (Steiner, Tweed, Downs, McNamara, Ricketts, Jarabak, Wits).
 */

export interface CephAnalysis {
  id: number;
  patientId: number;
  documentId: number;
  status: "draft" | "completed" | "discarded";
  orthoCaseId: number | null;
  phase: CephDiagnosticStage;
  xrayDate: string | null;
  device: string | null;
  refSet: string;
  calibration: { x1: number; y1: number; x2: number; y2: number; mm: number } | null;
  mmPerPixel: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
  findings: { anb: number | null; fma: number | null; wits: number | null } | null;
  /** (ORTHO-ID-2) أصل التصحيح وتصحيحاته — يُعرضان معًا ولا يُخفى التاريخ السابق. */
  correctsAnalysisId?: number | null;
  correctedBy?: number[];
}

interface PatientDocument {
  id: number;
  title: string;
  isImage: boolean;
  mimeType: string;
  takenOn: string | null;
  uploadedAt: string;
  removedAt: string | null;
}

interface OrthoCaseLite {
  id: number;
  status?: string;
  appliance?: string;
}

interface RefSetLite {
  key: string;
  name: string;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  draft: { label: "مسودة رسم", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  completed: { label: "معتمد سريريًا", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  discarded: { label: "مستبعد", cls: "bg-slate-100 text-slate-500 border-slate-200" },
};

const STAGE_COLORS: Record<CephDiagnosticStage, { badge: string; text: string; bg: string }> = {
  pretreatment: { badge: "bg-blue-50 text-blue-700 border-blue-200", text: "text-blue-700", bg: "bg-blue-600" },
  during: { badge: "bg-purple-50 text-purple-700 border-purple-200", text: "text-purple-700", bg: "bg-purple-600" },
  posttreatment: { badge: "bg-emerald-50 text-emerald-700 border-emerald-200", text: "text-emerald-700", bg: "bg-emerald-600" },
  followup: { badge: "bg-amber-50 text-amber-700 border-amber-200", text: "text-amber-700", bg: "bg-amber-600" },
};

const fmt = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? "—" : String(Math.round(v * 10) / 10);

export interface PatientCephProps {
  patientId: number;
  orthoCaseId?: number | null;
  navigationContext?: ClinicalNavigationContext;
  onNavigationGuardChange?: (guard: () => boolean) => () => void;
  currentPhase?: OrthoPhase | null;
  embedded?: boolean;
  onAnalysisCreated?: (analysisId: number) => void;
}

type Creation = { readonly controller: AbortController };
type StudyForm = { readonly identity: symbol };
function createWriteOwner() {
  // Mutable leases stay inside this factory, never in React state/props or in
  // a hook-returned object. React state below is only a redraw counter.
  let active = false;
  let form: StudyForm | null = null;
  let pending: Creation | null = null;
  const retireForm = () => {
    form = null;
    pending?.controller.abort();
    pending = null;
  };
  const current = (candidate: StudyForm, operation: Creation) =>
    active && form === candidate && pending === operation;
  return {
    activate: () => { active = true; },
    isActive: () => active,
    retire: () => { active = false; retireForm(); },
    snapshot: () => ({ form, creating: pending !== null }),
    open: () => {
      if (!active || form) return false;
      form = { identity: Symbol("ceph-study-form") };
      return true;
    },
    close: (candidate: StudyForm | null) => {
      if (!active || !candidate || candidate !== form) return false;
      retireForm(); return true;
    },
    begin: (candidate: StudyForm) => {
      if (!active || candidate !== form || pending) return null;
      pending = { controller: new AbortController() };
      return pending;
    },
    current,
    finish: (candidate: StudyForm, operation: Creation) => {
      if (!current(candidate, operation)) return false;
      pending = null; return true;
    },
  };
}

function createReadOwner() {
  let pending: AbortController | null = null;
  return {
    begin: () => {
      pending?.abort();
      pending = new AbortController();
      return pending;
    },
    current: (operation: AbortController) => pending === operation && !operation.signal.aborted,
    active: () => pending !== null && !pending.signal.aborted,
    retire: () => { pending?.abort(); pending = null; },
  };
}

type ImageSelection = {
  owner: ReturnType<typeof createReadOwner>;
  patientId: number;
  authority: string;
  images: PatientDocument[];
  selectedDoc: number | null;
};

export function PatientCeph({
  patientId,
  orthoCaseId: propOrthoCaseId,
  navigationContext,
  onNavigationGuardChange,
  currentPhase,
  embedded = false,
  onAnalysisCreated,
}: PatientCephProps) {
  const studyContext: ClinicalNavigationContext = { ...navigationContext, patientId,
    ...(propOrthoCaseId != null ? { orthoCaseId: propOrthoCaseId } : {}), pillar: "diagnostics" };
  const session = useSession();
  // Same canonical principal/role/permission scope as the orthodontic parent.
  // Display-name-only changes must not dismiss an ordinary same-owner draft.
  const authority = JSON.stringify(session ? [session.username, session.role, session.permissions ?? null] : null);
  const owner = useMemo(createWriteOwner, [patientId, propOrthoCaseId, authority]);
  // These endpoints and image options are patient-wide; case changes only
  // retire writes and change the summary projection, without another read.
  const readOwner = useMemo(createReadOwner, [patientId, authority]);
  const mayCreate = !!session?.username?.trim() && (session.role === "admin" || session.role === "reception"
    || (session.role === "doctor" && session.permissions?.canUploadXrays === true));
  // ربط دراسة سابقة بحالة التقويم قرارٌ سريري: الطبيب والمدير وحدهما (والخادم يفرض الشرط نفسه).
  const mayLink = !!session?.username?.trim() && (session.role === "admin"
    || (session.role === "doctor" && session.permissions?.canUploadXrays === true));
  useLayoutEffect(() => {
    owner.activate();
    return owner.retire;
  }, [owner]);
  // Retire reads at commit, before a newer view can accept old response bodies.
  useLayoutEffect(() => readOwner.retire, [readOwner]);
  const [analysisSnapshot, setAnalysisSnapshot] = useState<{ owner: typeof readOwner; operation: AbortController; rows: CephAnalysis[] } | null>(null);
  const analyses = analysisSnapshot?.owner === readOwner && readOwner.current(analysisSnapshot.operation) ? analysisSnapshot.rows : null;
  const [imageSelection, setImageSelection] = useState<ImageSelection | null>(null);
  const images = imageSelection?.owner === readOwner ? imageSelection.images : [];
  const selectedDoc = imageSelection?.owner === readOwner ? imageSelection.selectedDoc : null;
  const [orthoCases, setOrthoCases] = useState<OrthoCaseLite[]>([]);
  const [refSets, setRefSets] = useState<RefSetLite[]>([]);

  // نموذج الفحص الجديد
  const [, setFormRevision] = useState(0);
  const { form, creating } = owner.snapshot();
  const showNewStudy = form !== null;
  const canLeave = useCallback(() => {
    if (!owner.isActive()) return false;
    const latest = owner.snapshot();
    if (latest.creating) return false;
    return latest.form === null || window.confirm("هناك نموذج دراسة غير محفوظ. هل تريد مغادرة التشخيص؟");
  }, [owner]);
  useLayoutEffect(() => onNavigationGuardChange?.(canLeave), [onNavigationGuardChange, canLeave]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { const state = owner.snapshot(); if (state.form || state.creating) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [owner]);
  const redrawForm = () => setFormRevision((value) => value + 1);
  /* مقارنة تحليلين (من مستودع الوكيل الآخر): تُختار بالتحديد من الجدول، ولا
     تُقارَن إلا المكتملة — المسودة أرقامها لم تُختم فمقارنتها حكمٌ على لا شيء. */
  const [compareIds, setCompareIds] = useState<number[]>([]);

  const smartPhase = useMemo(
    () => suggestCephPhase(currentPhase, currentPhase === "aligning" ? 1 : 0),
    [currentPhase],
  );

  const [phase, setPhase] = useState<CephDiagnosticStage>(smartPhase);
  const [xrayDate, setXrayDate] = useState("");
  const [device, setDevice] = useState("");
  const [targetCaseId, setTargetCaseId] = useState<string>(
    propOrthoCaseId ? String(propOrthoCaseId) : "",
  );
  const [refSet, setRefSet] = useState("builtin_default");
  const [error, setError] = useState<string | null>(null);
  const [filterThisCase, setFilterThisCase] = useState<boolean>(Boolean(propOrthoCaseId && embedded));

  // تحديث المرحلة المقترحة تلقائيًا عند تغير الحالة أو المرحلة
  useEffect(() => {
    if (propOrthoCaseId) {
      setTargetCaseId(String(propOrthoCaseId));
      setPhase(smartPhase);
    }
  }, [propOrthoCaseId, smartPhase]);

  const load = useCallback(async (operation: AbortController) => {
    const current = () => readOwner.current(operation);
    try {
      const [cephRes, docsRes, orthoRes, refsRes] = await Promise.all([
        fetch(`/api/patients/${patientId}/ceph`, { signal: operation.signal }),
        fetch(`/api/patients/${patientId}/documents`, { signal: operation.signal }),
        fetch(`/api/ortho?patientId=${patientId}`, { signal: operation.signal }),
        fetch("/api/ceph-reference-sets", { signal: operation.signal }),
      ]);
      if (!current()) return;
      if (cephRes.ok) {
        const data = await cephRes.json();
        if (!current()) return;
        if (!Array.isArray(data.analyses) || data.analyses.some((row: CephAnalysis) => !row || row.patientId !== patientId || !Number.isSafeInteger(row.id) || row.id <= 0)) throw new Error("Invalid study owner");
        setAnalysisSnapshot({ owner: readOwner, operation, rows: data.analyses });
      } else {
        setAnalysisSnapshot(null); setError("تعذّر تحميل دراسات السيفالو.");
      }
      if (docsRes.ok) {
        const data = await docsRes.json();
        if (!current()) return;
        const docs: PatientDocument[] = data.documents ?? [];
        const imgs = docs.filter((d) => d.isImage);
        setImageSelection((previous) => {
          const selected = previous?.patientId === patientId && previous.authority === authority
            ? previous.selectedDoc : null;
          return { owner: readOwner, patientId, authority, images: imgs,
            selectedDoc: imgs.some((image) => image.id === selected) ? selected : imgs[0]?.id ?? null };
        });
      }
      if (orthoRes.ok) {
        const data = await orthoRes.json();
        if (!current()) return;
        setOrthoCases((data.cases ?? []) as OrthoCaseLite[]);
      }
      if (refsRes.ok) {
        const data = await refsRes.json();
        if (!current()) return;
        setRefSets((data.sets ?? []) as RefSetLite[]);
      }
    } catch {
      if (current()) { setAnalysisSnapshot(null); setError("تعذّر الاتصال بالخادم."); }
    }
  }, [patientId, authority, readOwner]);

  useEffect(() => {
    void load(readOwner.begin());
    return readOwner.retire;
  }, [load, readOwner]);

  const canOpenStudies = (ids: readonly number[]) => owner.isActive() && analysisSnapshot?.owner === readOwner
    && readOwner.current(analysisSnapshot.operation) && ids.every((id) => analysisSnapshot.rows.some((row) => row.id === id && row.patientId === patientId)) && canLeave();

  const displayedAnalyses = useMemo(() => {
    if (!analyses) return [];
    if (filterThisCase && propOrthoCaseId) {
      return analyses.filter((a) => a.orthoCaseId === propOrthoCaseId);
    }
    return analyses;
  }, [analyses, filterThisCase, propOrthoCaseId]);

  const studiesOnSelectedDoc = (selectedDoc != null && analyses != null)
    ? analyses.filter((a) => a.documentId === selectedDoc)
    : [];

  // الملخص يتبع نطاق الجدول؛ لا تُنسب دراسة حالة أخرى أو دراسة غير مرتبطة للحالة الحالية.
  const latestCompleted = useMemo(() => {
    return displayedAnalyses.find((a) => a.status === "completed") ?? null;
  }, [displayedAnalyses]);

  // دراسات المريض التي لا حالة لها — تُعرض للربط الصريح داخل حالة التقويم الحالية فقط.
  const unlinkedStudies = useMemo(
    () => (analyses ?? []).filter((a) => a.orthoCaseId == null && a.status !== "discarded"),
    [analyses],
  );

  const openStudyForm = () => {
    if (!mayCreate || !owner.open()) return;
    redrawForm();
    setError(null);
  };
  const closeStudyForm = () => {
    // A saved Close handler cannot close a newer form from the same owner.
    if (owner.close(form)) redrawForm();
  };
  const openDraft = async () => {
    // The form identity and synchronous latch also guard captured handlers and
    // repeated events before React paints the disabled button.
    if (!mayCreate || !form || !selectedDoc || !images.some((image) => image.id === selectedDoc)) return;
    const operation = owner.begin(form);
    if (!operation) return;
    const current = () => owner.current(form, operation);
    redrawForm();
    setError(null);
    try {
      const res = await fetch(`/api/patients/${patientId}/ceph`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: operation.controller.signal,
        body: JSON.stringify({
          documentId: selectedDoc,
          phase,
          xrayDate: xrayDate || null,
          device: device || null,
          orthoCaseId: targetCaseId ? Number(targetCaseId) : null,
          refSet: refSet || null,
        }),
      });
      if (!current()) return;
      const data = await res.json();
      if (!current()) return;
      if (res.ok) {
        if (!Number.isSafeInteger(data?.id) || data.id <= 0) throw new Error("Invalid study response");
        onAnalysisCreated?.(data.id);
        // A callback may synchronously change patient/view/session or unmount.
        if (!current()) return;
        window.location.href = cephStudyHref(data.id, { ...studyContext, ...(targetCaseId ? { orthoCaseId: Number(targetCaseId) } : {}) });
      } else {
        setError(typeof data?.message === "string" ? data.message : "تعذّر فتح التحليل.");
      }
    } catch {
      if (current()) setError("تعذّر تأكيد فتح التحليل. قد يكون الطلب نُفّذ؛ راجع الدراسات قبل المحاولة مجددًا.");
    } finally {
      if (owner.finish(form, operation)) redrawForm();
    }
  };

  return (
    <div className={`space-y-3 ${embedded ? "" : "rounded-2xl border border-slate-200 bg-white p-4"}`}>
      {/* رأس الوحدة التشخيصية */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-navy-800 text-base text-white shadow-xs">
            📐
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-extrabold text-navy-900">
                التحليل السيفالومتري ومخطط ويب سيف (WebCeph)
              </h3>
              {analyses && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-black text-slate-700">
                  {analyses.length} دراسة
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500">
              التشخيص الهيكلي والسنخي ومعايير المدارس السبع ومراحل T1 إلى T4
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {propOrthoCaseId && (
            <button
              type="button"
              onClick={() => setFilterThisCase((prev) => !prev)}
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors ${
                filterThisCase
                  ? "border-navy-800 bg-navy-800 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {filterThisCase ? `دراسات الحالة #${propOrthoCaseId}` : "كافة دراسات المريض"}
            </button>
          )}

          <button
            type="button"
            onClick={showNewStudy ? closeStudyForm : openStudyForm}
            disabled={!mayCreate}
            className="inline-flex items-center gap-1.5 rounded-xl bg-brand-orange px-3.5 py-1.5 text-xs font-black text-white shadow-xs hover:bg-amber-600 transition-colors"
          >
            <span>{showNewStudy ? "✕ إغلاق النموذج" : "+ دراسة سيفالومترية جديدة"}</span>
          </button>
        </div>
      </div>

      {/* ملخص أحدث فحص معتمد إن وجد */}
      {latestCompleted && latestCompleted.findings && (
        <div data-testid="patient-ceph-summary" className="rounded-xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-teal-50/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div data-testid="patient-ceph-summary-header" className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
              <span className="rounded-md bg-emerald-600 px-2 py-0.5 text-[10px] font-extrabold text-white">
                {filterThisCase && propOrthoCaseId
                  ? `أحدث دراسة معتمدة للحالة #${propOrthoCaseId}`
                  : "أحدث دراسة معتمدة للمريض (كافة الحالات)"}
              </span>
              <span className="text-xs font-black text-emerald-950">
                {CEPH_DIAGNOSTIC_STAGES[latestCompleted.phase]?.labelAr ?? latestCompleted.phase} · #{latestCompleted.id}
              </span>
              <span className="text-[11px] font-bold text-emerald-800">
                {latestCompleted.orthoCaseId != null
                  ? `مرتبطة بالحالة #${latestCompleted.orthoCaseId}`
                  : "بلا ربط بحالة"}
              </span>
              {latestCompleted.xrayDate && (
                <span className="text-[11px] text-emerald-800">
                  ({friendlyDateLong(latestCompleted.xrayDate)})
                </span>
              )}
            </div>

            <Link
              data-testid="ceph-open-latest" href={cephStudyHref(latestCompleted.id, studyContext)}
              onClick={(event) => { if (!canOpenStudies([latestCompleted.id])) event.preventDefault(); }}
              className="rounded-lg bg-white px-2.5 py-1 text-[11px] font-bold text-emerald-800 border border-emerald-200 hover:bg-emerald-50"
            >
              استعراض المخطط والتتبع ←
            </Link>
          </div>

          <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 gap-2 text-center">
            <div className="rounded-lg bg-white/80 p-1.5 border border-emerald-100">
              <span className="block text-[10px] text-slate-500 font-bold">العلاقة الفكية ANB</span>
              <span className="text-xs font-black text-navy-900" dir="ltr">
                {fmt(latestCompleted.findings.anb)}°
              </span>
            </div>
            <div className="rounded-lg bg-white/80 p-1.5 border border-emerald-100">
              <span className="block text-[10px] text-slate-500 font-bold">زاوية الفك FMA</span>
              <span className="text-xs font-black text-navy-900" dir="ltr">
                {fmt(latestCompleted.findings.fma)}°
              </span>
            </div>
            <div className="rounded-lg bg-white/80 p-1.5 border border-emerald-100">
              <span className="block text-[10px] text-slate-500 font-bold">علاقة ويتس Wits</span>
              <span className="text-xs font-black text-navy-900" dir="ltr">
                {fmt(latestCompleted.findings.wits)} مم
              </span>
            </div>
            <div className="rounded-lg bg-white/80 p-1.5 border border-emerald-100 col-span-3 sm:col-span-1">
              <span className="block text-[10px] text-slate-500 font-bold">المعايرة</span>
              <span className="text-[11px] font-bold text-emerald-700">
                {latestCompleted.mmPerPixel != null
                  ? `${(1 / latestCompleted.mmPerPixel).toFixed(1)} بكسل/مم`
                  : "غير معايرة"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* استمارة فتح دراسة سيفالومترية جديدة */}
      {showNewStudy && (
        <div className="rounded-2xl border border-brand-orange/40 bg-orange-50/40 p-4 transition-all">
          <div className="mb-3 flex items-center justify-between border-b border-orange-200/60 pb-2">
            <div>
              <p className="text-xs font-black text-navy-900">
                إنشاء دراسة سيفالومترية ذكية (Ceph Tracing Study)
              </p>
              <p className="text-[10px] text-slate-500">
                يتم ربط التحليل تلقائياً بملف ومرحلة حالة التقويم الحالية
              </p>
            </div>
            {propOrthoCaseId && (
              <span className="rounded-full bg-navy-100 px-2.5 py-0.5 text-[10px] font-extrabold text-navy-900">
                مرتبط بحالة التقويم #{propOrthoCaseId}
              </span>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* اختيار الشععة */}
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-600">
                الشععة السيفالومترية (من مستندات المريض) *
              </label>
              <select
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 shadow-xs focus:border-navy-800 focus:outline-hidden"
                value={selectedDoc ?? ""}
                onChange={(e) => {
                  const selected = Number(e.target.value) || null;
                  setImageSelection((previous) => readOwner.active() && previous?.owner === readOwner
                    ? { ...previous, selectedDoc: selected } : previous);
                }}
              >
                {images.length === 0 && <option value="">لا توجد صور في مستندات المريض</option>}
                {images.map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    #{doc.id} — {doc.title} {doc.takenOn ? `(${friendlyDateLong(doc.takenOn)})` : ""}
                  </option>
                ))}
              </select>
            </div>

            {/* مرحلة العلاج والتقويم */}
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-600">
                مرحلة الدراسة التقويمية (T-Stage) *
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {(Object.keys(CEPH_DIAGNOSTIC_STAGES) as CephDiagnosticStage[]).map((key) => {
                  const info = CEPH_DIAGNOSTIC_STAGES[key];
                  const isSelected = phase === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setPhase(key)}
                      className={`rounded-lg border px-2 py-1.5 text-right text-[11px] font-bold transition-all ${
                        isSelected
                          ? "border-navy-800 bg-navy-800 text-white shadow-xs"
                          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <span className="block font-black">{info.tCode} - {info.labelAr}</span>
                      <span className={`block text-[9px] truncate ${isSelected ? "text-navy-100" : "text-slate-400"}`}>
                        {info.descAr}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* تاريخ الشععة */}
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-600">
                تاريخ التقاط الشععة
              </label>
              <input
                type="date"
                value={xrayDate}
                onChange={(e) => setXrayDate(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 shadow-xs focus:border-navy-800 focus:outline-hidden"
              />
              <p className="mt-1 text-[10px] text-slate-400">
                يُستخدم لحساب العمر الزمني بدقة وقت أخذ الشععة
              </p>
            </div>

            {/* حالة التقويم المرتبطة */}
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-600">
                حالة التقويم التخصصية المرتبطة
              </label>
              <select
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 shadow-xs focus:border-navy-800 focus:outline-hidden"
                value={targetCaseId}
                onChange={(e) => setTargetCaseId(e.target.value)}
              >
                <option value="">بدون ربط بحالة</option>
                {orthoCases.map((c) => (
                  <option key={c.id} value={c.id}>
                    حالة تقويم #{c.id} {c.status ? `(${c.status})` : ""}
                  </option>
                ))}
              </select>
            </div>

            {/* المجموعة المرجعية */}
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-600">
                المجموعة المرجعية والمعايير (Ceph Norms)
              </label>
              <select
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 shadow-xs focus:border-navy-800 focus:outline-hidden"
                value={refSet}
                onChange={(e) => setRefSet(e.target.value)}
              >
                {refSets.length === 0 && (
                  <option value="builtin_default">المرجع القياسي المدمج (Steiner / Tweed / McNamara)</option>
                )}
                {refSets.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            {/* جهاز الأشعة */}
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-600">
                جهاز الأشعة / المركز (اختياري)
              </label>
              <input
                type="text"
                value={device}
                onChange={(e) => setDevice(e.target.value)}
                maxLength={120}
                placeholder="مثال: جهاز السيفالو الرقمي بالمركز"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 shadow-xs focus:border-navy-800 focus:outline-hidden"
              />
            </div>
          </div>

          {studiesOnSelectedDoc.length > 0 && (
            <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
              <span className="font-bold">⚠️ تنبيه تكرار:</span> لهذه الشععة {studiesOnSelectedDoc.length} دراسة سابقة
              ({studiesOnSelectedDoc.map((a) => `#${a.id}`).join("، ")}) — تابع فقط إذا كنت ترغب في تحليل جديد منفصل.
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void openDraft()}
              disabled={!mayCreate || !selectedDoc || creating || !images.some((image) => image.id === selectedDoc)}
              className="rounded-xl bg-navy-800 px-5 py-2.5 text-xs font-black text-white shadow-xs hover:bg-navy-900 disabled:opacity-40 transition-colors"
            >
              {creating ? "جارٍ فتح كابينة الرسم…" : "📐 افتح مساحة التتبع والتحليل"}
            </button>
            <button
              type="button"
              onClick={closeStudyForm}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors"
            >
              إلغاء
            </button>
            <p className="text-[11px] text-slate-500">
              سيتم فتح مساحة التتبع فوراً مع تحديد المعالم وحساب الزوايا بمحاذاة المدارس العالمية.
            </p>
            <p className="basis-full text-[11px] text-slate-500">
              هذه دراسة جديدة بمرحلتها وتاريخ أشعتها الفعليين. لتصحيح دراسة معتمدة افتحها واختر «تصحيح هذه الدراسة».
            </p>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-bold text-red-700">
          {error}
        </div>
      )}

      {propOrthoCaseId && mayLink && analyses != null && (
        <CephUnlinkedStudiesPanel
          patientId={patientId}
          orthoCaseId={propOrthoCaseId}
          authority={authority}
          studies={unlinkedStudies}
          onLinked={() => void load(readOwner.begin())}
          onRefresh={() => void load(readOwner.begin())}
        />
      )}

      {/* جدول وسجلات الدراسات السيفالومترية */}
      {analyses == null ? (
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-center text-xs text-slate-500">
          جارٍ تحميل سجلات السيفالومتري…
        </p>
      ) : displayedAnalyses.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-6 text-center">
          <p className="text-sm font-bold text-slate-700">لا توجد دراسات سيفالومترية مسجلة بعد</p>
          <p className="mt-1 text-xs text-slate-500">
            {images.length > 0
              ? "ابدأ الفحص التشخيصي الأول (T1) لتحديد العلاقات الفكية وخطة التقويم."
              : "ارفع صورة الشععة السيفالومترية للمريض من قسم المستندات لبدء التحليل."}
          </p>
          {images.length > 0 && (
            <button
              type="button"
              onClick={openStudyForm}
              disabled={!mayCreate}
              className="mt-3 inline-flex items-center gap-1 rounded-xl bg-navy-800 px-4 py-2 text-xs font-black text-white hover:bg-navy-900"
            >
              + ابدأ فحص سيفالومتري الآن
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-xs">
          {/* شريط المقارنة: لا يظهر إلا وقد اختير تحليلان — والرابط يمرّ بالمعرّفين
              والمريض، والخادم هو الذي يفرض الترتيب الزمني ويمنع مريضين مختلفين. */}
          {compareIds.length === 2 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-sky-200 bg-sky-50 px-3 py-2">
              <p className="text-[11px] font-bold text-sky-900">
                مقارنة #{compareIds[0]} مع #{compareIds[1]} — الأقدم «قبل» والأحدث «بعد» بترتيبٍ من الخادم.
              </p>
              {new Set(compareIds.map((id) => analyses?.find((row) => row.id === id)?.orthoCaseId ?? null)).size > 1 ? (
                <p role="status" data-testid="ceph-cross-case-comparison" className="text-xs font-bold text-amber-900">الدراستان من حالتين مختلفتين أو إحداهما غير مرتبطة؛ المقارنة لا توحّد هويتهما ولا تغيّر ارتباطهما.</p>
              ) : null}
              <div className="flex gap-1.5">
                <Link
                  data-testid="ceph-open-comparison" href={`/ceph/compare?first=${compareIds[0]}&second=${compareIds[1]}&patient=${patientId}&${clinicalContextSearch(studyContext)}`}
                  onClick={(event) => { if (!canOpenStudies(compareIds)) event.preventDefault(); }}
                  className="rounded-lg bg-navy-800 px-3 py-1 text-[11px] font-extrabold text-white hover:bg-navy-900"
                >
                  🔍 افتح المقارنة والتراكب
                </Link>
                <button type="button" onClick={() => setCompareIds([])}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-[11px] font-bold text-slate-600">
                  إلغاء
                </button>
              </div>
            </div>
          ) : null}
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 font-black text-slate-600">
                <th className="px-2 py-2.5">مقارنة</th>
                <th className="px-3 py-2.5">#</th>
                <th className="px-3 py-2.5">المرحلة التقويمية</th>
                <th className="px-3 py-2.5">الحالة</th>
                <th className="px-3 py-2.5">الحالة المرتبطة</th>
                <th className="px-3 py-2.5">تاريخ الشععة</th>
                <th className="px-3 py-2.5">المعايرة</th>
                <th className="px-3 py-2.5">أهم القياسات</th>
                <th className="px-3 py-2.5">التاريخ والمنشئ</th>
                <th className="px-3 py-2.5 text-left">إجراء</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {displayedAnalyses.map((a) => {
                const st = STATUS_BADGE[a.status] ?? {
                  label: a.status,
                  cls: "bg-slate-50 text-slate-600 border-slate-200",
                };
                const phaseInfo = CEPH_DIAGNOSTIC_STAGES[a.phase] ?? {
                  tCode: "T",
                  labelAr: a.phase,
                  descAr: "",
                };
                const phaseColor = STAGE_COLORS[a.phase] ?? {
                  badge: "bg-slate-50 text-slate-600 border-slate-200",
                  text: "text-slate-700",
                  bg: "bg-slate-600",
                };

                return (
                  <tr key={a.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="px-2 py-2.5 text-center">
                      {a.status === "completed" ? (
                        <input
                          type="checkbox"
                          aria-label={`تحديد ${a.id} للمقارنة`}
                          className="h-4 w-4 accent-navy-800"
                          checked={compareIds.includes(a.id)}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setCompareIds((current) => {
                              if (checked) return [...current, a.id].slice(-2);
                              return current.filter((id) => id !== a.id);
                            });
                          }}
                        />
                      ) : (
                        <span className="text-[10px] text-slate-300" title="المسودة لا تُقارَن — أرقامها لم تُختم">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono font-bold text-slate-800">
                      #{a.id}
                      {a.correctsAnalysisId != null && (
                        <span className="mt-0.5 block font-sans text-[10px] font-bold text-sky-700">تصحيح للدراسة #{a.correctsAnalysisId}</span>
                      )}
                      {(a.correctedBy?.length ?? 0) > 0 && (
                        <span className="mt-0.5 block font-sans text-[10px] font-bold text-emerald-700">
                          لها تصحيح: {a.correctedBy!.map((id) => `#${id}`).join("، ")}
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-black ${phaseColor.badge}`}
                        title={phaseInfo.descAr}
                      >
                        <span className="font-mono">{phaseInfo.tCode}</span>
                        <span>·</span>
                        <span>{phaseInfo.labelAr}</span>
                      </span>
                    </td>

                    <td className="px-3 py-2.5">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${st.cls}`}>
                        {st.label}
                      </span>
                    </td>

                    <td className="px-3 py-2.5">
                      {a.orthoCaseId ? (
                        <span
                          className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                            propOrthoCaseId && a.orthoCaseId === propOrthoCaseId
                              ? "bg-navy-100 text-navy-800 font-extrabold"
                              : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          حالة #{a.orthoCaseId}
                          {propOrthoCaseId && a.orthoCaseId === propOrthoCaseId ? " (الحالية)" : ""}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>

                    <td className="px-3 py-2.5 text-slate-600">
                      {a.xrayDate ? friendlyDateLong(a.xrayDate) : <span className="text-slate-500">تاريخ غير معروف</span>}
                    </td>

                    <td className="px-3 py-2.5">
                      {a.mmPerPixel != null ? (
                        <span className="text-[11px] font-bold text-emerald-700">
                          ✓ {(1 / a.mmPerPixel).toFixed(1)} px/mm
                        </span>
                      ) : (
                        <span className="text-[11px] font-bold text-amber-600">
                          بلا معايرة
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-2.5 font-mono text-[11px] text-slate-700">
                      {a.findings ? (
                        <span title="ANB · FMA · Wits">
                          ANB <strong className="text-navy-900">{fmt(a.findings.anb)}°</strong> · FMA {fmt(a.findings.fma)}° · W {fmt(a.findings.wits)}
                        </span>
                      ) : (
                        <span className="text-slate-400">— مسودة —</span>
                      )}
                    </td>

                    <td className="px-3 py-2.5 text-[11px] text-slate-500">
                      {friendlyDateLong(a.createdAt.slice(0, 10))} · {a.createdBy}
                    </td>

                    <td className="px-3 py-2.5 text-left">
                      <Link
                        data-testid={`ceph-open-study-${a.id}`} href={cephStudyHref(a.id, studyContext)}
                        onClick={(event) => { if (!canOpenStudies([a.id])) event.preventDefault(); }}
                        className="inline-flex items-center gap-1 rounded-lg bg-navy-800 px-3 py-1 text-[11px] font-bold text-white hover:bg-navy-900 transition-colors"
                      >
                        <span>فتح التتبع</span>
                        <span>←</span>
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
