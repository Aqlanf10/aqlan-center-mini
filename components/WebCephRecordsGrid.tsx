"use client";

import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  WEBCEPH_RECORD_SLOTS,
  PHOTO_STAGE_LABEL,
  suggestPhotoStage,
  type PhotoStage,
  type PhotoView,
} from "@/lib/ortho-photos";
import { suggestCephPhase, type OrthoPhase } from "@/lib/ortho";
import { useSession } from "./SessionProvider";
import {
  caseRecordSlots, caseRecordStudy, decodeOrthoRecordDocuments, decodeOrthoRecordStudies,
  ORTHO_RECORDS_READ_FAILURE, recordStudyId, type OrthoRecordDocument, type OrthoRecordStudy,
} from "@/lib/ortho-records";

type Owner = { scope: readonly unknown[]; active: boolean; ready: boolean; busy: boolean; sequence: number;
  controller: AbortController | null; timer: ReturnType<typeof setTimeout> | null; picker: PhotoView | null };
type Snapshot = { owner: Owner; status: "loading" | "ready" | "error";
  documents: OrthoRecordDocument[]; studies: OrthoRecordStudy[] };
const READ_TIMEOUT_MS = 15_000;

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
  const session = useSession();
  const hasSession = Boolean(session?.username?.trim());
  const canRead = hasSession && (session?.role === "admin" || session?.role === "reception"
    || (session?.role === "doctor" && session.permissions?.canViewXrays === true));
  const canUpload = canRead && (session?.role !== "doctor" || session.permissions?.canUploadXrays === true);
  const permissionScope = JSON.stringify(session?.permissions ?? null);
  const owner = useMemo<Owner>(() => ({ scope: [patientId, orthoCaseId, session?.username, session?.role, permissionScope],
    active: false, ready: false, busy: false, sequence: 0,
    controller: null, timer: null, picker: null }),
    [patientId, orthoCaseId, session?.username, session?.role, permissionScope]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [operation, setOperation] = useState<{ owner: Owner; slot?: PhotoView; documentId?: number } | null>(null);
  const [failure, setFailure] = useState<{ owner: Owner; message: string } | null>(null);
  const [selection, setSelection] = useState<{ owner: Owner; stage: PhotoStage | "all" } | null>(null);
  const ready = canRead && snapshot?.owner === owner && snapshot.status === "ready";
  const failed = canRead && snapshot?.owner === owner && snapshot.status === "error";
  const loading = canRead && !ready && !failed;
  const documents = useMemo(() => ready ? snapshot.documents : [], [ready, snapshot]);
  const cephStudies = useMemo(() => ready ? snapshot.studies : [], [ready, snapshot]);
  const uploadingSlot = operation?.owner === owner ? operation.slot : undefined;
  const launchingCeph = operation?.owner === owner ? operation.documentId : undefined;
  const error = failure?.owner === owner ? failure.message : null;
  const activeStage = selection?.owner === owner ? selection.stage : "all";
  const setActiveStage = (stage: PhotoStage | "all") => {
    if (owner.active) setSelection({ owner, stage });
  };
  const setError = (message: string | null) => {
    if (owner.active) setFailure(message ? { owner, message } : null);
  };
  useLayoutEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false; owner.ready = false; owner.picker = null; owner.controller?.abort();
      if (owner.timer !== null) clearTimeout(owner.timer);
    };
  }, [owner]);

  // المرحلة الزمنية المحددة للفلترة (افتراضياً: المقترحة تلقائياً أو "all")
  const defaultStage = useMemo<PhotoStage>(() => {
    return suggestPhotoStage({
      date: clinicDateString(new Date(), CLINIC_ZONE_FALLBACK),
      startDate: startDate || clinicDateString(new Date(), CLINIC_ZONE_FALLBACK),
      phase: currentPhase,
      isFirstSession: false,
    });
  }, [startDate, currentPhase]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadData = useCallback(async () => {
    if (!owner.active || !canRead) return false;
    owner.ready = false; owner.picker = null; owner.controller?.abort();
    if (owner.timer !== null) clearTimeout(owner.timer);
    const sequence = ++owner.sequence;
    const controller = new AbortController(); owner.controller = controller;
    const current = () => owner.active && owner.sequence === sequence;
    setSnapshot({ owner, status: "loading", documents: [], studies: [] });
    setFailure(null);
    try {
      const read = async () => {
        const [docsRes, cephRes] = await Promise.all([
          fetch(`/api/patients/${patientId}/documents`, { cache: "no-store", signal: controller.signal }),
          fetch(`/api/patients/${patientId}/ceph`, { cache: "no-store", signal: controller.signal }),
        ]);
        if (!docsRes.ok || !cephRes.ok) throw new Error(ORTHO_RECORDS_READ_FAILURE);
        const [docs, studies] = await Promise.all([docsRes.json(), cephRes.json()]);
        return { documents: decodeOrthoRecordDocuments(docs, patientId), studies: decodeOrthoRecordStudies(studies, patientId) };
      };
      const payload = await Promise.race([read(), new Promise<never>((_, reject) => {
        owner.timer = setTimeout(() => { controller.abort(); reject(new Error(ORTHO_RECORDS_READ_FAILURE)); }, READ_TIMEOUT_MS);
      })]);
      if (!current() || controller.signal.aborted) return false;
      owner.ready = true;
      setSnapshot({ owner, status: "ready", ...payload });
      return true;
    } catch {
      if (current()) setSnapshot({ owner, status: "error", documents: [], studies: [] });
      return false;
    } finally {
      if (current() && owner.timer !== null) { clearTimeout(owner.timer); owner.timer = null; }
    }
  }, [patientId, owner, canRead]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // خريطة الصور المقترنة بكل Slot
  const slotMap = useMemo(() => caseRecordSlots(documents, patientId, orthoCaseId, activeStage),
    [documents, patientId, orthoCaseId, activeStage]);
  const referenceDocuments = documents.filter(doc => doc.orthoCaseId !== orthoCaseId);

  // فتح أو إنشاء دراسة السيفالومتري فوراً
  const handleLaunchCeph = async (docId: number) => {
    if (!owner.active || !owner.ready || owner.busy || !canRead
      || !documents.some(doc => doc.id === docId && doc.orthoCaseId === orthoCaseId)) return;
    const existing = caseRecordStudy(cephStudies, patientId, orthoCaseId, docId);
    // A patient-wide study is an explicit reference, never this case's analysis.
    if (!existing && cephStudies.some(study => study.documentId === docId)) {
      setError("لهذه الصورة تحليل بسياق آخر. راجع رابط التحليل المرجعي؛ لا يُعدّ تحليلاً لهذه الحالة.");
      return;
    }
    if (!existing && !canUpload) return;
    owner.busy = true;
    setOperation({ owner, documentId: docId });
    setError(null);
    try {
      // 1. فحص هل توجد دراسة سابقة لهذه الشععة
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
      if (!owner.active) return;
      const analysisId = recordStudyId(data?.id);
      if (res.ok && analysisId !== null) {
        window.location.href = `/ceph/${analysisId}`;
      } else {
        setError(data.message ?? "تعذّر فتح جلسة الرسم والتحليل السيفالومتري.");
      }
    } catch {
      setError("تعذّر الاتصال بخادم السيفالومتري.");
    } finally {
      owner.busy = false;
      if (owner.active) setOperation(null);
    }
  };

  // تشغيل منتقي الملفات للسلوت المحدد
  const triggerUpload = (slotKey: PhotoView) => {
    if (!owner.active || !owner.ready || owner.busy || !canUpload) return;
    owner.picker = slotKey;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
  };

  // رفع الصورة المحددة إلى الخادم وربطها بالسلوت والحالة
  const onFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const slotKey = owner.picker;
    if (!owner.active || !owner.ready || owner.busy || !canUpload || !file || !slotKey) return;
    owner.picker = null; owner.busy = true;

    setOperation({ owner, slot: slotKey });
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
    formData.append("takenOn", clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));

    try {
      const res = await fetch(`/api/patients/${patientId}/documents`, {
        method: "POST",
        body: formData,
      });
      const doc = await res.json();
      if (!owner.active) return;
      if (!res.ok) {
        setError(doc.message ?? "تعذّر رفع الصورة.");
        return;
      }

      // Revalidate the saved link before offering analysis. Read recovery must
      // never upload again or create a study from an unverified/stale document.
      void loadData();
    } catch {
      setError("تعذّر الاتصال أثناء الرفع.");
    } finally {
      owner.busy = false;
      if (owner.active) setOperation(null);
    }
  };

  const categories = [
    { key: "xray", title: "⚡ الأشعة التشخيصية (Radiographs)", desc: "سيفالومتري جانبي وأمامي وبانوراما" },
    { key: "extraoral", title: "👤 الصور الوجهية (Facial & Profile)", desc: "الوجه والابتسامة والبروفايل بزاوية 90° و45°" },
    { key: "intraoral", title: "🦷 صور الأسنان وداخل الفم (Intraoral)", desc: "الإطباق الأمامي والجانبي وأقواس الفكين" },
  ] as const;

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-xs" data-testid="ortho-records-grid">
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
            مواضع هذه الحالة تعرض الصور المرتبطة بها فقط. صور الملف الأخرى تبقى مراجع منفصلة.
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
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          ⚠️ {error}
        </div>
      )}
      {!canRead ? (
        <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">عرض سجلات الصور والأشعة غير متاح لهذا الحساب.</p>
      ) : failed ? (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <p>{ORTHO_RECORDS_READ_FAILURE}</p>
          <button type="button" onClick={() => { if (owner.active && !owner.busy) void loadData(); }}
            className="mt-2 font-bold underline">إعادة تحميل سجلات الحالة</button>
        </div>
      ) : null}

      {/* مدخل ملف مخفي للرفع المباشر */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        disabled={!ready || !canUpload || Boolean(operation?.owner === owner)}
        onChange={(e) => void onFileSelected(e)}
      />

      {loading ? (
        <div className="py-8 text-center text-xs text-slate-400">
          جارٍ تحميل سجلات الحالة والصور…
        </div>
      ) : ready ? (
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
                    const studyForDoc = doc ? caseRecordStudy(cephStudies, patientId, orthoCaseId, doc.id) : null;
                    const referenceStudies = doc ? cephStudies.filter(study => study.documentId === doc.id && study.orthoCaseId !== orthoCaseId) : [];
                    const contextConflict = !studyForDoc && referenceStudies.length > 0;
                    const isLaunching = doc && launchingCeph === doc.id;
                    const launchDisabled = Boolean(isLaunching || (!studyForDoc && !canUpload) || contextConflict);

                    return (
                      <div
                        key={slot.key}
                        data-testid={`ortho-record-slot-${slot.key}`}
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
                                    disabled={launchDisabled}
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
                                  disabled={!canUpload || Boolean(operation?.owner === owner)}
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
                              disabled={!canUpload || Boolean(operation?.owner === owner)}
                              className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center text-slate-400 hover:text-slate-700 transition-colors"
                            >
                              <span className="text-xl">
                                {isCephTarget ? "📐" : cat.key === "xray" ? "⚡" : cat.key === "extraoral" ? "👤" : "🦷"}
                              </span>
                              <span className="text-[10px] font-bold leading-tight">
                                {!canUpload ? "لا توجد صورة مرتبطة بهذا الموضع" : isCephTarget ? "+ رفع السيفالو" : "+ إضافة صورة"}
                              </span>
                              {canUpload ? <span className="text-[9px] text-slate-400">انقر للتحميل</span> : null}
                            </button>
                          )}
                        </div>

                        {/* الشريط السفلي الخاص بالـ Lateral Ceph */}
                        {isCephTarget && doc && (
                          <div className="bg-purple-100/80 px-2 py-1 text-center">
                            <button
                              type="button"
                              onClick={() => void handleLaunchCeph(doc.id)}
                              disabled={launchDisabled}
                              className="w-full text-[11px] font-black text-purple-900 hover:text-purple-700 inline-flex items-center justify-center gap-1"
                            >
                              <span>📐</span>
                              <span>
                                {contextConflict
                                  ? "راجع التحليل المرجعي أدناه"
                                  : isLaunching
                                  ? "جارٍ الفتح…"
                                  : studyForDoc
                                  ? `فتح التحليل (#${studyForDoc.id}) ←`
                                  : "بدء التتبع والتحليل ←"}
                              </span>
                            </button>
                          </div>
                        )}
                        {isCephTarget && referenceStudies.length > 0 ? (
                          <div className="space-y-1 bg-amber-50 px-2 py-1 text-[10px] text-amber-900">
                            {referenceStudies.map(study => (
                              <a key={study.id} href={`/ceph/${study.id}`} className="block underline">
                                تحليل مرجعي #{study.id} · {study.orthoCaseId === null ? "بلا ربط بحالة" : `لحالة أخرى #${study.orthoCaseId}`}
                              </a>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {ready && referenceDocuments.length > 0 ? (
        <details className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs" data-testid="ortho-record-references">
          <summary className="cursor-pointer font-bold text-slate-700">صور أخرى في ملف المريض ({referenceDocuments.length})</summary>
          <p className="mt-2 text-slate-500">مراجع محفوظة في الملف؛ لا تملأ مواضع هذه الحالة ولا يُغيَّر ربطها تلقائيًا.</p>
          <ul className="mt-2 space-y-1">
            {referenceDocuments.map(doc => (
              <li key={doc.id}>
                <a href={`/api/documents/${doc.id}`} target="_blank" rel="noopener noreferrer" className="font-bold text-navy-800 underline">
                  {doc.title}
                </a>
                {" · "}{doc.orthoCaseId === null ? "غير مرتبطة بحالة" : `مرتبطة بحالة أخرى #${doc.orthoCaseId}`}
                {cephStudies.filter(study => study.documentId === doc.id).map(study => (
                  <a key={study.id} href={`/ceph/${study.id}`} className="mr-2 inline-block text-purple-800 underline">
                    تحليل مرجعي #{study.id} · {study.orthoCaseId === null ? "بلا ربط بحالة" : `الحالة #${study.orthoCaseId}`}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
