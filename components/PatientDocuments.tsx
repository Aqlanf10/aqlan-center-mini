"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KIND_LABEL, formatBytes, type DocumentKind } from "@/lib/storage";
import type { Patient } from "@/lib/patient";
import type { Visit } from "@/lib/flow";
import {
  PHOTO_STAGE_LABEL, PHOTO_VIEW_LABEL, type PhotoStage, type PhotoView,
} from "@/lib/ortho-photos";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { useSession } from "./SessionProvider";
import { isAdmin } from "@/lib/roles";
import { ConsentModal } from "./ConsentModal";
import { BeforeAfterSlider } from "./BeforeAfterSlider";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

/**
 * الأشعة والمستندات.
 *
 * أن تُفتح صورة الأشعة **في ملف المريض** لا في مجلّدٍ على جهازٍ في غرفة الأشعة هو
 * الفرق بين سجلٍّ يُقرأ وسجلٍّ يُبحث عنه. والأشعة القديمة أثمن ما في الملف: المقارنة
 * بين اليوم وقبل سنة هي التشخيص نفسه في كثيرٍ من الحالات.
 */

interface PatientDocument {
  id: number;
  patientId: number;
  visitId: number | null;
  kind: DocumentKind;
  title: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  note: string | null;
  takenOn: string | null;
  uploadedBy: string;
  uploadedAt: string;
  removedAt: string | null;
  removedBy: string | null;
  removedNote: string | null;
  orthoCaseId: number | null;
  adjustmentId: number | null;
  photoStage: string | null;
  photoView: string | null;
}

const KINDS = Object.keys(KIND_LABEL) as DocumentKind[];
const VISIT_STATUS_LABEL: Record<Visit["status"], string> = {
  waiting: "انتظار", called: "تم النداء", in_chair: "على الكرسي", done: "منتهية",
};
const validId = (value: unknown): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const optionalId = (value: unknown) => value === null || validId(value);
function hasDocumentContext(value: unknown, patientId: number): value is PatientDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as PatientDocument;
  return validId(document.id) && document.patientId === patientId && optionalId(document.visitId)
    && optionalId(document.orthoCaseId) && optionalId(document.adjustmentId);
}
function documentContext(document: PatientDocument): string {
  const parts = [document.visitId === null ? null : `زيارة #${document.visitId}`,
    document.orthoCaseId === null ? null : `حالة تقويم #${document.orthoCaseId}`,
    document.adjustmentId === null ? null : `شدّة تقويم #${document.adjustmentId}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "على مستوى المريض؛ بلا ربط بزيارة أو حالة تقويم";
}

interface PatientDocumentsProps {
  patientId: number;
  patientName?: string;
  patientPhone?: string | null;
  /** (PAT-3) صورة المريض الحالية، وما يُستدعى بعد تغييرها — يمرّره ملف المريض. */
  photoDocumentId?: number | null;
  onPhotoChange?: (patient: Patient) => void;
  /** Canonical patient-file projection, limited by its server to the latest 50 visits. */
  visits?: readonly Pick<Visit, "id" | "patientId" | "arrivedAt" | "status">[];
  authorityKey?: string;
  onDraftChange?: (pending: boolean) => void;
  onNavigationGuardChange?: (guard: (() => boolean) | null) => void;
}

export function PatientDocuments(props: PatientDocumentsProps) {
  const session = useSession();
  const authority = `${props.authorityKey ?? ""}:${session?.username ?? ""}:${session?.role ?? ""}:${JSON.stringify(session?.permissions ?? {})}`;
  // Old requests/drafts must never be reused for another patient or authority.
  return <PatientDocumentsWorkspace key={`${props.patientId}:${authority}`} {...props} />;
}

function PatientDocumentsWorkspace({
  patientId,
  patientName = "المريض",
  patientPhone,
  photoDocumentId = null,
  onPhotoChange,
  visits = [],
  onDraftChange,
  onNavigationGuardChange,
}: PatientDocumentsProps) {
  const session = useSession();
  const admin = isAdmin(session?.role);
  const canUpload = admin || session?.role === "reception"
    || (session?.role === "doctor" && session.permissions?.canUploadXrays === true);
  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);

  const [documents, setDocuments] = useState<PatientDocument[]>([]);
  const [ready, setReady] = useState(true);
  const [storageMessage, setStorageMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const loadSequence = useRef(0);
  const [viewing, setViewing] = useState<PatientDocument | null>(null);

  const [showConsentModal, setShowConsentModal] = useState(false);
  const [consentPending, setConsentPending] = useState(false);
  const consentGuard = useRef<(() => boolean) | null>(null);
  const registerConsentGuard = useCallback((guard: (() => boolean) | null) => { consentGuard.current = guard; }, []);
  const [showSliderModal, setShowSliderModal] = useState(false);
  const [sliderBeforeUrl, setSliderBeforeUrl] = useState<string>("");
  const [sliderAfterUrl, setSliderAfterUrl] = useState<string>("");
  const [sliderTitle, setSliderTitle] = useState<string>("مقارنة تطور العلاج");

  const [kind, setKind] = useState<DocumentKind>("xray");
  const [title, setTitle] = useState("");
  const [takenOn, setTakenOn] = useState(today);
  const [picked, setPicked] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const [photoStage, setPhotoStage] = useState<PhotoStage>("progress");
  const [photoView, setPhotoView] = useState<PhotoView | "">("");
  const [selectedVisitId, setSelectedVisitId] = useState<number | null>(null);
  const [uploadReview, setUploadReview] = useState<{ documentId: number | null; visitId: number | null; reviewed: boolean } | null>(null);
  // Reject ambiguous or cross-patient options; the backend still rechecks ownership.
  const availableVisits = visits.filter((visit) => validId(visit.id) && visit.patientId === patientId
    && visits.filter((candidate) => candidate.id === visit.id).length === 1).slice(0, 50);
  const selectedVisit = availableVisits.find((visit) => visit.id === selectedVisitId);
  const visitUnavailable = selectedVisitId !== null && !selectedVisit;
  const dirty = picked !== null || title !== "" || takenOn !== today || kind !== "xray"
    || photoStage !== "progress" || photoView !== "" || selectedVisitId !== null || uploadReview !== null;
  const pendingDraft = busy || dirty || consentPending;

  const clearDraft = useCallback(() => {
    setKind("xray"); setTitle(""); setTakenOn(today); setPicked(null);
    setPhotoStage("progress"); setPhotoView(""); setSelectedVisitId(null);
    if (fileInput.current) fileInput.current.value = "";
    if (cameraInput.current) cameraInput.current.value = "";
  }, [today]);
  const discard = useCallback(() => {
    if (busyRef.current || (consentGuard.current && !consentGuard.current())) return false;
    if (dirty && !window.confirm(uploadReview
      ? "قد يكون الرفع السابق حُفظ، ولم يكتمل التحقق منه. هل تريد ترك المسودة ومراجعة السجل لاحقًا؟"
      : "هناك مسودة مستند غير مرفوعة. هل تريد تجاهلها؟")) return false;
    clearDraft();
    setShowConsentModal(false);
    return true;
  }, [dirty, clearDraft, uploadReview]);
  useEffect(() => {
    onNavigationGuardChange?.(discard);
    return () => onNavigationGuardChange?.(null);
  }, [discard, onNavigationGuardChange]);
  useEffect(() => { onDraftChange?.(pendingDraft); return () => onDraftChange?.(false); }, [pendingDraft, onDraftChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pendingDraft) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pendingDraft]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const changeVisit = (value: string) => {
    if (busyRef.current || uploadReview || !canUpload) return;
    const next = value === "" ? null : /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
    if (next !== null && !availableVisits.some((visit) => visit.id === next)) {
      setError("الزيارة المختارة غير متاحة في سجل هذا المريض."); return;
    }
    if (next === selectedVisitId) return;
    if (!discard()) return;
    setSelectedVisitId(next); setError(null); setNotice(null);
  };

  const load = useCallback(async () => {
    if (!mounted.current) return null;
    const ticket = ++loadSequence.current;
    const current = () => mounted.current && loadSequence.current === ticket;
    setLoading(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/documents`, { cache: "no-store" });
      const payload = await response.json();
      if (!current()) return null;
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      if (!Array.isArray(payload?.documents) || !payload.documents.every((document: unknown) => hasDocumentContext(document, patientId))) {
        throw new Error("تعذّر التحقق من سياق المستندات. أعد التحميل.");
      }
      setDocuments(payload.documents as PatientDocument[]);
      setReady(Boolean(payload.storageReady));
      setStorageMessage(payload.storageMessage ?? null);
      setError(null);
      return payload.documents as PatientDocument[];
    } catch (loadError) {
      if (!current()) return null;
      setDocuments([]); setViewing(null); setReady(false);
      setShowSliderModal(false); setSliderBeforeUrl(""); setSliderAfterUrl("");
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
      return null;
    } finally {
      if (current()) setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const reviewUpload = async () => {
    if (!uploadReview || busyRef.current || !mounted.current) return;
    busyRef.current = true; setBusy(true);
    const review = uploadReview;
    try {
      const saved = await load();
      if (!mounted.current || saved === null) return;
      const persisted = review.documentId === null ? null : saved.find((document) => document.id === review.documentId);
      if (persisted && persisted.visitId === review.visitId && persisted.orthoCaseId === null && persisted.adjustmentId === null) {
        clearDraft(); setUploadReview(null);
        setNotice(`تم التحقق من المستند #${persisted.id} بعد إعادة التحميل. الارتباط المحفوظ: ${documentContext(persisted)}`);
      } else {
        // A missing record or matching filename is not proof that no write happened.
        setUploadReview({ ...review, reviewed: true });
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const upload = async (event: React.FormEvent) => {
    event.preventDefault();
    // الكاميرا والملفّ مدخلان لكن مسار الرفع واحد: أيّهما مملوءٌ يُرفع.
    const file = fileInput.current?.files?.[0] ?? cameraInput.current?.files?.[0];
    if (!file || busyRef.current || !mounted.current || !canUpload || !ready || loading || uploadReview) return;
    if (visitUnavailable) { setError("الزيارة المختارة لم تعد متاحة. اختر ارتباطًا صريحًا قبل الرفع."); return; }
    const uploadVisitId = selectedVisitId;
    busyRef.current = true;
    ++loadSequence.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", kind);
      form.set("title", title.trim() || file.name);
      form.set("takenOn", takenOn);
      if (uploadVisitId !== null) form.set("visitId", String(uploadVisitId));
      if (kind === "photo") {
        form.set("photoStage", photoStage);
        if (photoView) form.set("photoView", photoView);
      }
      const response = await fetch(`/api/patients/${patientId}/documents`, { method: "POST", body: form });
      const payload = await response.json().catch(() => null);
      if (!mounted.current) return;
      if (!response.ok) {
        if (response.status >= 500) {
          setUploadReview({ documentId: null, visitId: uploadVisitId, reviewed: false });
          setError("لم يؤكد الخادم نتيجة الرفع. قد يكون المستند حُفظ؛ راجع السجل قبل أي رفع جديد.");
        } else setError(payload?.message ?? "تعذّر الرفع.");
        return;
      }
      if (!hasDocumentContext(payload, patientId) || payload.visitId !== uploadVisitId
        || payload.orthoCaseId !== null || payload.adjustmentId !== null) {
        setUploadReview({ documentId: validId(payload?.id) && payload?.patientId === patientId ? payload.id : null, visitId: uploadVisitId, reviewed: false });
        setError("لم تؤكد استجابة الرفع الارتباط المختار. راجع السجل قبل إعادة الرفع."); return;
      }
      const saved = await load();
      if (!mounted.current) return;
      const persisted = saved?.find((document) => document.id === payload.id);
      if (persisted && persisted.visitId === uploadVisitId && persisted.orthoCaseId === null && persisted.adjustmentId === null) {
        clearDraft(); setUploadReview(null);
        setNotice(`تم التحقق من المستند #${persisted.id} بعد إعادة التحميل. الارتباط المحفوظ: ${documentContext(persisted)}`);
      } else {
        setUploadReview({ documentId: payload.id, visitId: uploadVisitId, reviewed: false });
        setError(`استلم الخادم المستند #${payload.id}، لكن لم يكتمل التحقق من ارتباطه في السجل. حدّث المستندات قبل إعادة الرفع.`);
      }
    } catch {
      if (mounted.current) {
        setUploadReview({ documentId: null, visitId: uploadVisitId, reviewed: false });
        setError("انقطع الاتصال قبل تأكيد نتيجة الرفع. قد يكون المستند حُفظ؛ راجع السجل قبل أي رفع جديد.");
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const hide = async (document: PatientDocument) => {
    if (busyRef.current || !mounted.current || !admin) return;
    const note = window.prompt(`سبب إخفاء «${document.title}»؟`);
    if (!note?.trim()) return;
    busyRef.current = true; setBusy(true);
    try {
      const response = await fetch(`/api/documents/${document.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const payload = await response.json().catch(() => null);
      if (!mounted.current) return;
      if (!response.ok) { setError(payload?.message ?? "تعذّر الإخفاء."); return; }
      await load();
    } catch {
      if (mounted.current) setError("تعذّر الاتصال بالخادم.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  // Retain the caller's photo authority, and never report an old patient's save in a new context.
  const setAsPhoto = async (documentId: number) => {
    if (!onPhotoChange || busyRef.current || !mounted.current
      || !documents.some((document) => document.id === documentId && document.isImage && !document.removedAt)) return;
    busyRef.current = true; setBusy(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/photo`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId }),
      });
      const payload = await response.json().catch(() => null);
      if (!mounted.current) return;
      if (!response.ok || payload?.id !== patientId) { setError(payload?.message ?? "تعذّر تعيين الصورة."); return; }
      setError(null); onPhotoChange(payload as Patient);
    } catch {
      if (mounted.current) setError("تعذّر الاتصال بالخادم.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const imageDocs = documents.filter((d) => d.isImage && !d.removedAt);

  const openComparisonSlider = (beforeDoc?: PatientDocument, afterDoc?: PatientDocument) => {
    if (beforeDoc && afterDoc) {
      setSliderBeforeUrl(`/api/documents/${beforeDoc.id}`);
      setSliderAfterUrl(`/api/documents/${afterDoc.id}`);
      setSliderTitle(`مقارنة: ${beforeDoc.title} ⟷ ${afterDoc.title}`);
      setShowSliderModal(true);
      return;
    }

    if (imageDocs.length < 2) return;

    const initial = imageDocs.find((d) => d.photoStage === "initial") || imageDocs[imageDocs.length - 1];
    const after = imageDocs.find((d) => d.photoStage === "debond" || d.photoStage === "retention" || d.photoStage === "progress") || imageDocs[0];

    if (initial && after && initial.id !== after.id) {
      setSliderBeforeUrl(`/api/documents/${initial.id}`);
      setSliderAfterUrl(`/api/documents/${after.id}`);
      setSliderTitle("مقارنة مراحل العلاج (قبل وبعد)");
    } else {
      setSliderBeforeUrl(`/api/documents/${imageDocs[imageDocs.length - 1].id}`);
      setSliderAfterUrl(`/api/documents/${imageDocs[0].id}`);
      setSliderTitle("مقارنة الصور السريرية");
    }
    setShowSliderModal(true);
  };

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}
          <button type="button" disabled={busy || loading} onClick={() => void load()} className="mr-2 underline">حدّث المستندات</button>
        </p>
      ) : null}
      {notice ? <p role="status" className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{notice}</p> : null}
      {uploadReview ? <div role="alert" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
        <p>نتيجة الرفع تحتاج مراجعة. لن تُعاد هذه المسودة تلقائيًا، ولا يعني غياب المستند من القائمة أنه لم يُحفظ.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={busy || loading} onClick={() => void reviewUpload()} className="rounded-lg border border-amber-400 px-3 py-1.5">حدّث السجل وراجع نتيجة الرفع</button>
          <button type="button" disabled={busy || loading || !uploadReview.reviewed} onClick={() => {
            if (busyRef.current || !uploadReview.reviewed) return;
            clearDraft(); setUploadReview(null); setError(null); setNotice(null);
          }} className="rounded-lg border border-amber-400 px-3 py-1.5 disabled:opacity-40">راجعت السجل؛ ابدأ مسودة رفع جديدة</button>
        </div>
      </div> : null}

      {/*
        * تخزينٌ غير مهيَّأ يُقال قبل أن يختار أحدٌ ملفًّا — لا بعد أن يرفعه فيفشل.
        * وبلا هذا كان الرفع سينجح ظاهريًّا ثم تختفي الأشعة عند أول إعادة نشر.
        */}
      {!ready && storageMessage ? (
        <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
          {storageMessage.split("\n").map((line, index) => (
            <p key={index}
              className={index === 0
                ? "mb-1 text-sm font-bold text-amber-900"
                : "text-[11px] leading-6 text-amber-800"}>
              {line}
            </p>
          ))}
        </div>
      ) : null}

      {/* شريط الأدوات السريرية: الإقرارات الطبية ومقارنة الابتسامة */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-gradient-to-r from-slate-50 to-navy-50/40 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || !canUpload || uploadReview !== null || showConsentModal}
            onClick={() => {
              if (!canUpload || busyRef.current || uploadReview || showConsentModal || !discard()) return;
              setShowConsentModal(true);
            }}
            className="flex items-center gap-1.5 rounded-xl bg-navy-900 px-3.5 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-navy-800 active:scale-95 transition-all"
          >
            <span>✍️</span>
            <span>إقرار طبي رقمي جديد</span>
          </button>

          {imageDocs.length >= 2 && (
            <button
              type="button"
              onClick={() => openComparisonSlider()}
              className="flex items-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-1.5 text-xs font-bold text-amber-900 hover:bg-amber-100 active:scale-95 transition-all"
            >
              <span>✨</span>
              <span>مقارنة قبل / بعد ({imageDocs.length} صور)</span>
            </button>
          )}
        </div>

        <div className="text-[11px] font-semibold text-slate-500">
          إجمالي المستندات: <span className="font-mono font-bold text-navy-900">{documents.length}</span>
        </div>
      </div>

      <form onSubmit={upload} className="mb-3 rounded-2xl border border-slate-200 bg-white p-3">
        {!canUpload ? <p role="status" className="mb-2 text-xs text-slate-600">رفع المستندات غير متاح ضمن صلاحيتك الحالية؛ صلاحية الاطلاع لا تمنح صلاحية الرفع.</p> : null}
        <fieldset disabled={busy || uploadReview !== null || !canUpload} className="min-w-0">
        <legend className="mb-2 text-sm font-bold">رفع مستند جديد</legend>
        <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
          <label className="block">
            <span className="mb-1 block text-xs font-bold text-slate-600">ربط بزيارة موجودة (اختياري)</span>
            <select value={selectedVisitId ?? ""} onChange={(event) => changeVisit(event.target.value)}
              aria-label="زيارة المستند" aria-describedby="document-visit-help"
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
              <option value="">على مستوى المريض — بلا زيارة</option>
              {visitUnavailable ? <option value={selectedVisitId!} disabled>زيارة #{selectedVisitId} غير متاحة</option> : null}
              {availableVisits.map((visit) => <option key={visit.id} value={visit.id}>
                زيارة #{visit.id} · {friendlyDateLong(visit.arrivedAt)} · {VISIT_STATUS_LABEL[visit.status] ?? "حالة غير متاحة"}
              </option>)}
            </select>
          </label>
          <p id="document-visit-help" className="mt-1 text-[11px] leading-5 text-slate-500">
            القائمة من ملف المريض وتعرض أحدث 50 زيارة كحد أقصى؛ ليست التاريخ الكامل. لا تُختار زيارة تلقائيًا.
            {" "}ربط الزيارة لا يحفظ رابطًا مستقلًا بحالة تخصصية. صور التقويم المرتبطة بالحالة أو الشدّة تُرفع من التقويم.
          </p>
          <p className="mt-1 text-xs font-semibold text-navy-800" data-testid="document-upload-context">
            السياق المختار للرفع: ملف المريض #{patientId} · {selectedVisitId === null ? "على مستوى المريض — بلا زيارة" : `زيارة #${selectedVisitId}`}
          </p>
          {visitUnavailable ? <p role="alert" className="mt-1 text-xs text-red-700">الزيارة المختارة لم تعد متاحة. اختر ارتباطًا صريحًا قبل الرفع؛ لن تُستبدل بزيارة أخرى.</p> : null}
        </div>
        <div className="mb-2 flex flex-wrap items-end gap-2">
          <label className="min-w-[7rem]">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">النوع</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as DocumentKind)}
              aria-label="نوع المستند"
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
              {KINDS.map((value) => (
                <option key={value} value={value}>{KIND_LABEL[value]}</option>
              ))}
            </select>
          </label>
          <label className="min-w-[10rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">الوصف</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)}
              aria-label="وصف المستند" placeholder="بانورامي قبل العلاج"
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
          </label>
          <label className="w-36">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">تاريخ التصوير</span>
            <input type="date" value={takenOn} onChange={(event) => setTakenOn(event.target.value)}
              aria-label="تاريخ التصوير"
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
          </label>
        </div>
        {/*
          * زرّ اختيار الملف مكتوبٌ بالعربية.
          *
          * حقل `file` الأصلي يرسم زرًّا بلغة المتصفّح — «Choose File» و«No file
          * chosen» — فيبقى سطران إنجليزيّان وسط شاشةٍ عربية كاملة. وهو أوّل ما
          * تراه عين الاستقبال في هذه الشاشة. فيُخفى الحقل ويبقى عاملًا، ويُرسم
          * فوقه زرٌّ عربي يقول اسم الملف المختار.
          */}
        {kind === "photo" ? (
          <div className="mb-2 grid grid-cols-2 gap-2">
            <label>
              <span className="mb-1 block text-[10px] font-bold text-slate-500">دور الصورة</span>
              <select value={photoStage} onChange={(event) => setPhotoStage(event.target.value as PhotoStage)}
                aria-label="دور الصورة"
                className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
                {(Object.keys(PHOTO_STAGE_LABEL) as PhotoStage[]).map((value) => (
                  <option key={value} value={value}>{PHOTO_STAGE_LABEL[value]}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-[10px] font-bold text-slate-500">وجه الصورة</span>
              <select value={photoView} onChange={(event) => setPhotoView(event.target.value as PhotoView | "")}
                aria-label="وجه الصورة"
                className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
                <option value="">— بلا وجه محدد —</option>
                {(Object.keys(PHOTO_VIEW_LABEL) as PhotoView[]).map((value) => (
                  <option key={value} value={value}>{PHOTO_VIEW_LABEL[value]}</option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileInput} type="file" id="document-file" aria-label="ملف الأشعة"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(event) => {
              if (busyRef.current || !canUpload) return;
              if (cameraInput.current) cameraInput.current.value = "";
              setPicked(event.target.files?.[0]?.name ?? null);
            }}
            className="sr-only" />
          <label htmlFor="document-file"
            className="cursor-pointer rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-bold text-navy-800">
            اختر ملفًّا
          </label>
          {/* كاميرا الجوال من داخل الملف: العنصر المخفي بـ`capture` يفتح الكاميرا
              مباشرة، والصورة تدخل مسار الرفع نفسه — لا مجلّد جوالٍ يضيع. */}
          <input ref={cameraInput} type="file" id="document-camera" aria-label="كاميرا التصوير"
            accept="image/*" capture="environment"
            onChange={(event) => {
              if (busyRef.current || !canUpload) return;
              const cameraFile = event.target.files?.[0];
              if (fileInput.current) fileInput.current.value = "";
              setPicked(cameraFile?.name ?? null);
              if (cameraFile) setKind("photo");
            }}
            className="sr-only" />
          <button type="button" onClick={() => cameraInput.current?.click()}
            className="rounded-lg bg-navy-800 px-3 py-1.5 text-xs font-extrabold text-white">
            📷 التقاط صورة الآن
          </button>
          <span className="min-w-0 flex-1 truncate text-[11px] text-slate-500">
            {picked ?? "لم يُختَر ملف بعد — صورة أو PDF"}
          </span>
          <button type="submit" disabled={busy || loading || !canUpload || !ready || !picked || visitUnavailable || uploadReview !== null}
            className="rounded-lg bg-navy-800 px-4 py-1.5 text-xs font-extrabold text-white disabled:opacity-40">
            {busy ? "جارٍ الرفع…" : "ارفع"}
          </button>
          {dirty ? <button type="button" onClick={() => { if (discard()) { setError(null); setNotice(null); } }}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs">تجاهل المسودة</button> : null}
        </div>
        </fieldset>
      </form>

      {loading && documents.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : documents.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا أشعة ولا مستندات في هذا الملف.
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {documents.map((document) => (
            <li key={document.id}
              className={`overflow-hidden rounded-2xl border bg-white ${
                document.removedAt ? "border-slate-200 opacity-60" : "border-slate-200"
              }`}>
              <button type="button" onClick={() => setViewing(document)}
                className="block w-full text-right">
                {document.isImage ? (
                  <img src={`/api/documents/${document.id}`} alt={document.title}
                    loading="lazy"
                    className="h-36 w-full bg-slate-900 object-contain" />
                ) : (
                  <div className="flex h-36 w-full items-center justify-center bg-slate-100 text-3xl">📄</div>
                )}
                <div className="p-2.5">
                  <p className="truncate text-sm font-bold">{document.title}</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {KIND_LABEL[document.kind]} · {formatBytes(document.sizeBytes)}
                    {document.takenOn ? ` · ${friendlyDateLong(document.takenOn)}` : ""}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-600" data-testid={`document-context-${document.id}`}>
                    الارتباط المحفوظ: {documentContext(document)}
                  </p>
                </div>
              </button>
              <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-2.5 py-1.5">
                <a href={`/api/documents/${document.id}?download=1`}
                  className="text-[11px] font-bold text-navy-800 underline decoration-slate-300 underline-offset-4">
                  نزّل
                </a>
                {onPhotoChange && document.isImage && !document.removedAt ? (
                  photoDocumentId === document.id ? (
                    <span className="text-[11px] font-bold text-emerald-700">✓ صورة المريض</span>
                  ) : (
                    <button type="button" onClick={() => void setAsPhoto(document.id)} disabled={busy}
                      className="text-[11px] font-bold text-violet-700 hover:text-violet-900">
                      👤 اجعلها صورة المريض
                    </button>
                  )
                ) : null}
                {document.kind === "consent" && (
                  <a
                    href={`/print/consent/${patientId}?docId=${document.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] font-bold text-sky-700 hover:text-sky-900 flex items-center gap-1"
                  >
                    <span>🖨️</span>
                    <span>طباعة الإقرار (A4)</span>
                  </a>
                )}
                {document.isImage && imageDocs.length >= 2 && (
                  <button
                    type="button"
                    onClick={() => {
                      const other = imageDocs.find((d) => d.id !== document.id) || document;
                      openComparisonSlider(other, document);
                    }}
                    className="text-[11px] font-bold text-amber-700 hover:text-amber-900 flex items-center gap-0.5"
                  >
                    <span>✨</span>
                    <span>مقارنة</span>
                  </button>
                )}
                {document.removedAt ? (
                  <span className="text-[11px] text-slate-500">
                    مخفيّ — {document.removedBy}
                    {document.removedNote ? `: ${document.removedNote}` : ""}
                  </span>
                ) : admin ? (
                  <button type="button" onClick={() => void hide(document)} disabled={busy}
                    className="mr-auto text-[11px] font-bold text-slate-400 hover:text-red-600 disabled:opacity-40">
                    أخفِ
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {viewing ? (
        <div role="dialog" aria-label={viewing.title}
          onClick={() => setViewing(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="max-h-full w-full max-w-4xl overflow-auto rounded-2xl bg-white p-3"
            onClick={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-extrabold">{viewing.title}</p>
                <p className="text-[11px] text-slate-500">
                  {KIND_LABEL[viewing.kind]} · رفعه {viewing.uploadedBy}
                  {viewing.takenOn ? ` · صُوّر ${friendlyDateLong(viewing.takenOn)}` : ""}
                </p>
                <p className="mt-1 text-xs text-slate-600">الارتباط المحفوظ: {documentContext(viewing)}</p>
              </div>
              <button type="button" onClick={() => setViewing(null)}
                className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600">
                إغلاق
              </button>
            </div>
            {viewing.isImage ? (
              <img src={`/api/documents/${viewing.id}`} alt={viewing.title}
                className="max-h-[70vh] w-full bg-slate-900 object-contain" />
            ) : (
              <iframe src={`/api/documents/${viewing.id}`} title={viewing.title}
                className="h-[70vh] w-full rounded-lg border border-slate-200" />
            )}
          </div>
        </div>
      ) : null}

      <ConsentModal
        isOpen={showConsentModal}
        onClose={() => setShowConsentModal(false)}
        patientId={patientId}
        patientName={patientName}
        onSigned={() => void load()}
        onDraftChange={setConsentPending}
        onNavigationGuardChange={registerConsentGuard}
      />

      {sliderBeforeUrl && sliderAfterUrl && (
        <BeforeAfterSlider
          isOpen={showSliderModal}
          onClose={() => setShowSliderModal(false)}
          patientName={patientName}
          patientPhone={patientPhone}
          beforeImageUrl={sliderBeforeUrl}
          afterImageUrl={sliderAfterUrl}
          procedureName={sliderTitle}
        />
      )}
    </div>
  );
}
