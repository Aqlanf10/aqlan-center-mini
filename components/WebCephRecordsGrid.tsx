"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WEBCEPH_RECORD_SLOTS,
  PHOTO_STAGE_LABEL,
  suggestPhotoStage,
  type PhotoStage,
  type PhotoView,
} from "@/lib/ortho-photos";
import { suggestCephPhase, type OrthoPhase } from "@/lib/ortho";

interface PatientDocItem {
  id: number;
  title: string;
  isImage: boolean;
  photoStage: string | null;
  photoView: string | null;
  takenOn: string | null;
  uploadedAt: string;
}

interface CephStudyItem {
  id: number;
  documentId: number;
  phase: string;
  status: string;
}

export interface WebCephRecordsGridProps {
  patientId: number;
  orthoCaseId: number;
  currentPhase?: OrthoPhase;
  startDate?: string;
}

export function WebCephRecordsGrid({
  patientId,
  orthoCaseId,
  currentPhase = "aligning",
  startDate,
}: WebCephRecordsGridProps) {
  const [documents, setDocuments] = useState<PatientDocItem[]>([]);
  const [cephStudies, setCephStudies] = useState<CephStudyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingSlot, setUploadingSlot] = useState<PhotoView | null>(null);
  const [launchingCeph, setLaunchingCeph] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // المرحلة الزمنية المحددة للفلترة (افتراضياً: المقترحة تلقائياً أو "all")
  const defaultStage = useMemo<PhotoStage>(() => {
    return suggestPhotoStage({
      date: new Date().toISOString().slice(0, 10),
      startDate: startDate || new Date().toISOString().slice(0, 10),
      phase: currentPhase,
      isFirstSession: false,
    });
  }, [startDate, currentPhase]);

  const [activeStage, setActiveStage] = useState<PhotoStage | "all">("all");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const targetSlotRef = useRef<PhotoView | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [docsRes, cephRes] = await Promise.all([
        fetch(`/api/patients/${patientId}/documents`, { cache: "no-store" }),
        fetch(`/api/patients/${patientId}/ceph`, { cache: "no-store" }),
      ]);
      if (docsRes.ok) {
        const dData = await docsRes.json();
        const imgs = ((dData.documents ?? []) as PatientDocItem[]).filter(
          (d) => d.isImage && (!d.photoStage || d.photoStage !== "archived")
        );
        setDocuments(imgs);
      }
      if (cephRes.ok) {
        const cData = await cephRes.json();
        setCephStudies((cData.analyses ?? []) as CephStudyItem[]);
      }
    } catch {
      setError("تعذّر تحميل سجلات الصور والأشعة.");
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // خريطة الصور المقترنة بكل Slot
  const slotMap = useMemo(() => {
    const map = new Map<PhotoView, PatientDocItem>();
    const filtered = activeStage === "all"
      ? documents
      : documents.filter((d) => d.photoStage === activeStage);

    for (const doc of filtered) {
      if (doc.photoView && !map.has(doc.photoView as PhotoView)) {
        map.set(doc.photoView as PhotoView, doc);
      }
    }
    return map;
  }, [documents, activeStage]);

  // فتح أو إنشاء دراسة السيفالومتري فوراً
  const handleLaunchCeph = async (docId: number) => {
    setLaunchingCeph(docId);
    setError(null);
    try {
      // 1. فحص هل توجد دراسة سابقة لهذه الشععة
      const existing = cephStudies.find((s) => s.documentId === docId);
      if (existing) {
        window.location.href = `/ceph/${existing.id}`;
        return;
      }

      // 2. إنشاء دراسة جديدة ونقل الطبيب إليها فوراً
      const phase = suggestCephPhase(currentPhase);
      const res = await fetch(`/api/patients/${patientId}/ceph`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: docId,
          orthoCaseId,
          phase,
          refSet: "builtin_default",
        }),
      });
      const data = await res.json();
      if (res.ok && data.id) {
        window.location.href = `/ceph/${data.id}`;
      } else {
        setError(data.message ?? "تعذّر فتح جلسة الرسم والتحليل السيفالومتري.");
      }
    } catch {
      setError("تعذّر الاتصال بخادم السيفالومتري.");
    } finally {
      setLaunchingCeph(null);
    }
  };

  // تشغيل منتقي الملفات للسلوت المحدد
  const triggerUpload = (slotKey: PhotoView) => {
    targetSlotRef.current = slotKey;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
  };

  // رفع الصورة المحددة إلى الخادم وربطها بالسلوت والحالة
  const onFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const slotKey = targetSlotRef.current;
    if (!file || !slotKey) return;

    setUploadingSlot(slotKey);
    setError(null);

    const stageToSave = activeStage === "all" ? defaultStage : activeStage;
    const slotDef = WEBCEPH_RECORD_SLOTS.find((s) => s.key === slotKey);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("kind", slotDef?.category === "xray" ? "xray" : "photo");
    formData.append("title", slotDef ? `${slotDef.labelAr} (${slotDef.labelEn})` : file.name);
    formData.append("photoView", slotKey);
    formData.append("photoStage", stageToSave);
    formData.append("orthoCaseId", String(orthoCaseId));
    formData.append("takenOn", new Date().toISOString().slice(0, 10));

    try {
      const res = await fetch(`/api/patients/${patientId}/documents`, {
        method: "POST",
        body: formData,
      });
      const doc = await res.json();
      if (!res.ok) {
        setError(doc.message ?? "تعذّر رفع الصورة.");
        return;
      }

      await loadData();

      // إذا كانت الصورة المرفوعة هي أشعة سيفالو جانبية، نقوم بفتح محطة الرسم فوراً كمنصة WebCeph
      if (slotDef?.isCephTracerTarget && doc.id) {
        await handleLaunchCeph(doc.id);
      }
    } catch {
      setError("تعذّر الاتصال أثناء الرفع.");
    } finally {
      setUploadingSlot(null);
    }
  };

  const categories = [
    { key: "xray", title: "⚡ الأشعة التشخيصية (Radiographs)", desc: "سيفالومتري جانبي وأمامي وبانوراما" },
    { key: "extraoral", title: "👤 الصور الوجهية (Facial & Profile)", desc: "الوجه والابتسامة والبروفايل بزاوية 90° و45°" },
    { key: "intraoral", title: "🦷 صور الأسنان وداخل الفم (Intraoral)", desc: "الإطباق الأمامي والجانبي وأقواس الفكين" },
  ] as const;

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-xs">
      {/* رأس المعرض وأزرار المراحل التطورية كمنصة WebCeph */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-navy-800 text-sm text-white shadow-xs">
              🖼️
            </span>
            <h3 className="text-xs font-black text-navy-900">
              معرض سجلات الحالة والصور والأشعة (WebCeph Records Gallery)
            </h3>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
              12 موضعاً معيارياً
            </span>
          </div>
          <p className="mt-0.5 text-[10px] text-slate-500">
            انقر على صورة الأشعة السيفالومترية لبدء الرسم الذكي والتحليل الفوري (WebCeph Workflow)
          </p>
        </div>

        {/* أشرطة المراحل الزمنية T1 -> T4 */}
        <div className="flex flex-wrap items-center gap-1 rounded-xl bg-slate-100 p-1 text-xs">
          <button
            type="button"
            onClick={() => setActiveStage("all")}
            className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-all ${
              activeStage === "all" ? "bg-white text-navy-900 shadow-xs" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            كافة المراحل
          </button>
          {(["initial", "progress", "debond", "retention"] as PhotoStage[]).map((stage) => {
            const isSelected = activeStage === stage;
            const label = PHOTO_STAGE_LABEL[stage];
            return (
              <button
                key={stage}
                type="button"
                onClick={() => setActiveStage(stage)}
                className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-all ${
                  isSelected
                    ? "bg-navy-800 text-white shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          ⚠️ {error}
        </div>
      )}

      {/* مدخل ملف مخفي للرفع المباشر */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void onFileSelected(e)}
      />

      {loading ? (
        <div className="py-8 text-center text-xs text-slate-400">
          جارٍ تحميل سجلات الحالة والصور…
        </div>
      ) : (
        <div className="space-y-4">
          {categories.map((cat) => {
            const slots = WEBCEPH_RECORD_SLOTS.filter((s) => s.category === cat.key);
            return (
              <div key={cat.key} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                  <span>{cat.title}</span>
                  <span className="text-[10px] text-slate-400 font-normal">{cat.desc}</span>
                </div>

                <div className={`grid gap-2.5 ${
                  cat.key === "xray"
                    ? "grid-cols-1 sm:grid-cols-3"
                    : cat.key === "extraoral"
                    ? "grid-cols-2 sm:grid-cols-4"
                    : "grid-cols-2 sm:grid-cols-3 md:grid-cols-5"
                }`}>
                  {slots.map((slot) => {
                    const doc = slotMap.get(slot.key);
                    const isUploading = uploadingSlot === slot.key;
                    const isCephTarget = slot.isCephTracerTarget;
                    const studyForDoc = doc ? cephStudies.find((s) => s.documentId === doc.id) : null;
                    const isLaunching = doc && launchingCeph === doc.id;

                    return (
                      <div
                        key={slot.key}
                        className={`group relative flex flex-col justify-between overflow-hidden rounded-xl border transition-all ${
                          isCephTarget
                            ? doc
                              ? "border-purple-300 bg-purple-50/40 hover:border-purple-500 shadow-sm"
                              : "border-purple-200 bg-purple-50/20 hover:border-purple-400"
                            : doc
                            ? "border-slate-200 bg-white hover:border-slate-300"
                            : "border-dashed border-slate-200 bg-slate-50/60 hover:border-slate-300"
                        }`}
                      >
                        {/* عنوان ومسمى السلوت */}
                        <div className="flex items-center justify-between border-b border-slate-100/80 bg-white/70 px-2 py-1 text-[10px]">
                          <span className="font-bold text-slate-700 truncate">{slot.labelAr}</span>
                          <span className="font-mono text-[9px] text-slate-400">{slot.labelEn}</span>
                        </div>

                        {/* المحتوى: صورة أو زر رفع */}
                        <div className="relative aspect-4/3 w-full overflow-hidden bg-slate-900/5">
                          {isUploading ? (
                            <div className="flex h-full flex-col items-center justify-center gap-1 text-purple-700">
                              <span className="animate-spin text-lg">⏳</span>
                              <span className="text-[10px] font-bold">جارٍ الرفع…</span>
                            </div>
                          ) : doc ? (
                            <div className="relative h-full w-full">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={`/api/documents/${doc.id}`}
                                alt={slot.labelAr}
                                className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                                loading="lazy"
                              />

                              {/* وسم المرحلة */}
                              {doc.photoStage && (
                                <span className="absolute top-1 right-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-white">
                                  {PHOTO_STAGE_LABEL[doc.photoStage as PhotoStage] ?? doc.photoStage}
                                </span>
                              )}

                              {/* طبقة الأزرار والإجراءات عند التحويم */}
                              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-slate-950/70 p-2 opacity-0 backdrop-blur-xs transition-opacity group-hover:opacity-100">
                                {isCephTarget ? (
                                  <button
                                    type="button"
                                    onClick={() => void handleLaunchCeph(doc.id)}
                                    disabled={isLaunching}
                                    className="w-full rounded-lg bg-purple-600 py-1.5 text-center text-xs font-black text-white shadow-md hover:bg-purple-700 transition-colors"
                                  >
                                    {isLaunching ? "جارٍ الفتح…" : "📐 طاولة الرسم والتحليل"}
                                  </button>
                                ) : (
                                  <a
                                    href={`/api/documents/${doc.id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="w-full rounded-lg bg-white/90 py-1 text-center text-[11px] font-bold text-slate-900 hover:bg-white transition-colors"
                                  >
                                    👁️ عرض مكبّر
                                  </a>
                                )}

                                <button
                                  type="button"
                                  onClick={() => triggerUpload(slot.key)}
                                  className="w-full rounded-lg bg-slate-800/90 py-1 text-center text-[10px] font-medium text-white hover:bg-slate-700 transition-colors"
                                >
                                  🔄 استبدال
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => triggerUpload(slot.key)}
                              className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center text-slate-400 hover:text-slate-700 transition-colors"
                            >
                              <span className="text-xl">
                                {isCephTarget ? "📐" : cat.key === "xray" ? "⚡" : cat.key === "extraoral" ? "👤" : "🦷"}
                              </span>
                              <span className="text-[10px] font-bold leading-tight">
                                {isCephTarget ? "+ رفع السيفالو" : "+ إضافة صورة"}
                              </span>
                              <span className="text-[9px] text-slate-400">انقر للتحميل</span>
                            </button>
                          )}
                        </div>

                        {/* الشريط السفلي الخاص بالـ Lateral Ceph */}
                        {isCephTarget && doc && (
                          <div className="bg-purple-100/80 px-2 py-1 text-center">
                            <button
                              type="button"
                              onClick={() => void handleLaunchCeph(doc.id)}
                              disabled={isLaunching}
                              className="w-full text-[11px] font-black text-purple-900 hover:text-purple-700 inline-flex items-center justify-center gap-1"
                            >
                              <span>📐</span>
                              <span>
                                {isLaunching
                                  ? "جارٍ الفتح…"
                                  : studyForDoc
                                  ? `فتح التحليل (#${studyForDoc.id}) ←`
                                  : "بدء التتبع والتحليل ←"}
                              </span>
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
