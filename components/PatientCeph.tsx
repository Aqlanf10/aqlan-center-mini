"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
  currentPhase?: OrthoPhase | null;
  embedded?: boolean;
  onAnalysisCreated?: (analysisId: number) => void;
}

export function PatientCeph({
  patientId,
  orthoCaseId: propOrthoCaseId,
  currentPhase,
  embedded = false,
  onAnalysisCreated,
}: PatientCephProps) {
  const [analyses, setAnalyses] = useState<CephAnalysis[] | null>(null);
  const [documents, setDocuments] = useState<PatientDocument[] | null>(null);
  const [images, setImages] = useState<PatientDocument[]>([]);
  const [orthoCases, setOrthoCases] = useState<OrthoCaseLite[]>([]);
  const [refSets, setRefSets] = useState<RefSetLite[]>([]);

  // نموذج الفحص الجديد
  const [showNewStudy, setShowNewStudy] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<number | null>(null);

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
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterThisCase, setFilterThisCase] = useState<boolean>(Boolean(propOrthoCaseId && embedded));

  // تحديث المرحلة المقترحة تلقائيًا عند تغير الحالة أو المرحلة
  useEffect(() => {
    if (propOrthoCaseId) {
      setTargetCaseId(String(propOrthoCaseId));
      setPhase(smartPhase);
    }
  }, [propOrthoCaseId, smartPhase]);

  const load = useCallback(async () => {
    try {
      const [cephRes, docsRes, orthoRes, refsRes] = await Promise.all([
        fetch(`/api/patients/${patientId}/ceph`),
        fetch(`/api/patients/${patientId}/documents`),
        fetch(`/api/ortho?patientId=${patientId}`),
        fetch("/api/ceph-reference-sets"),
      ]);
      if (cephRes.ok) {
        setAnalyses((await cephRes.json()).analyses);
      } else {
        setError("تعذّر تحميل دراسات السيفالو.");
      }
      if (docsRes.ok) {
        const data = await docsRes.json();
        const docs: PatientDocument[] = data.documents ?? [];
        setDocuments(docs);
        const imgs = docs.filter((d) => d.isImage);
        setImages(imgs);
        setSelectedDoc((prev) => prev ?? imgs[0]?.id ?? null);
      }
      if (orthoRes.ok) {
        const data = await orthoRes.json();
        setOrthoCases((data.cases ?? []) as OrthoCaseLite[]);
      }
      if (refsRes.ok) {
        const data = await refsRes.json();
        setRefSets((data.sets ?? []) as RefSetLite[]);
      }
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  // أحدث تحليل معتمد لعرض ملخصه الفوري
  const latestCompleted = useMemo(() => {
    if (!analyses) return null;
    return analyses.find((a) => a.status === "completed") ?? null;
  }, [analyses]);

  const openDraft = async () => {
    if (!selectedDoc) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`/api/patients/${patientId}/ceph`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: selectedDoc,
          phase,
          xrayDate: xrayDate || null,
          device: device || null,
          orthoCaseId: targetCaseId ? Number(targetCaseId) : null,
          refSet: refSet || null,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        if (onAnalysisCreated) {
          onAnalysisCreated(data.id);
        }
        window.location.href = `/ceph/${data.id}`;
      } else {
        setError(data.message ?? "تعذّر فتح التحليل.");
      }
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setCreating(false);
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
            onClick={() => setShowNewStudy((prev) => !prev)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-brand-orange px-3.5 py-1.5 text-xs font-black text-white shadow-xs hover:bg-amber-600 transition-colors"
          >
            <span>{showNewStudy ? "✕ إغلاق النموذج" : "+ دراسة سيفالومترية جديدة"}</span>
          </button>
        </div>
      </div>

      {/* ملخص أحدث فحص معتمد إن وجد */}
      {latestCompleted && latestCompleted.findings && (
        <div className="rounded-xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-teal-50/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-emerald-600 px-2 py-0.5 text-[10px] font-extrabold text-white">
                أحدث دراسة معتمدة
              </span>
              <span className="text-xs font-black text-emerald-950">
                {CEPH_DIAGNOSTIC_STAGES[latestCompleted.phase]?.labelAr ?? latestCompleted.phase} · #{latestCompleted.id}
              </span>
              {latestCompleted.xrayDate && (
                <span className="text-[11px] text-emerald-800">
                  ({friendlyDateLong(latestCompleted.xrayDate)})
                </span>
              )}
            </div>

            <Link
              href={`/ceph/${latestCompleted.id}`}
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
                onChange={(e) => setSelectedDoc(Number(e.target.value) || null)}
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
              disabled={!selectedDoc || creating || images.length === 0}
              className="rounded-xl bg-navy-800 px-5 py-2.5 text-xs font-black text-white shadow-xs hover:bg-navy-900 disabled:opacity-40 transition-colors"
            >
              {creating ? "جارٍ فتح كابينة الرسم…" : "📐 افتح مساحة التتبع والتحليل"}
            </button>
            <button
              type="button"
              onClick={() => setShowNewStudy(false)}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors"
            >
              إلغاء
            </button>
            <p className="text-[11px] text-slate-500">
              سيتم فتح مساحة التتبع فوراً مع تحديد المعالم وحساب الزوايا بمحاذاة المدارس العالمية.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-bold text-red-700">
          {error}
        </div>
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
              onClick={() => setShowNewStudy(true)}
              className="mt-3 inline-flex items-center gap-1 rounded-xl bg-navy-800 px-4 py-2 text-xs font-black text-white hover:bg-navy-900"
            >
              + ابدأ فحص سيفالومتري الآن
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-xs">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 font-black text-slate-600">
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
                    <td className="px-3 py-2.5 font-mono font-bold text-slate-800">
                      #{a.id}
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
                      {a.xrayDate ? friendlyDateLong(a.xrayDate) : "—"}
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
                        href={`/ceph/${a.id}`}
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
