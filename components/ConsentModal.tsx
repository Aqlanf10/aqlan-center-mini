"use client";

import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { useState, useRef, useEffect, useCallback } from "react";
import { FileText, PenTool, AlertTriangle, X, RotateCcw, Save, Loader2, ShieldCheck } from "lucide-react";
import { CONSENT_TEMPLATES, getConsentTemplate } from "@/lib/consent-templates";
import { CONSENT_ACKNOWLEDGEMENT, createConsentDocumentMetadata, parseStoredConsentDocumentMetadata } from "@/lib/consent-document";
import { useSession } from "./SessionProvider";
import type { PatientDocument } from "@/lib/db";

interface ConsentModalProps {
  isOpen: boolean;
  onClose: () => void;
  patientId: number;
  patientName: string;
  onSigned?: (document: PatientDocument) => void;
  authorityKey?: string;
  onDraftChange?: (pending: boolean) => void;
  onNavigationGuardChange?: (guard: (() => boolean) | null) => void;
}

type SaveExpectation = Pick<PatientDocument, "title" | "note" | "takenOn" | "sizeBytes">;
type SaveReview = { documentId: number | null; expected: SaveExpectation; reviewed: boolean };
// Memory only, shared by both launchers. Closing/reopening cannot silently permit
// a duplicate POST. No image/signature bytes, credentials or browser storage.
// Reloading the whole page cannot recover an unknown result without API idempotency.
const pendingSaves = new Map<string, SaveReview>();
const validId = (value: unknown): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const optionalId = (value: unknown) => value === null || validId(value);
function hasDocumentContext(value: unknown, patientId: number): value is PatientDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as PatientDocument;
  return validId(document.id) && document.patientId === patientId
    && optionalId(document.visitId) && optionalId(document.orthoCaseId) && optionalId(document.adjustmentId);
}
function matchesConsent(value: unknown, patientId: number, expected: SaveExpectation): value is PatientDocument {
  if (!hasDocumentContext(value, patientId)) return false;
  return value.kind === "consent" && value.mimeType === "image/png" && value.removedAt === null
    && value.visitId === null && value.orthoCaseId === null && value.adjustmentId === null
    && value.title === expected.title && value.note === expected.note
    && value.takenOn === expected.takenOn && value.sizeBytes === expected.sizeBytes;
}

function metadataForReview(review: SaveReview | null, patientId: number) {
  if (!review) return null;
  const parsed = parseStoredConsentDocumentMetadata(review.expected.note, { patientId, visitId: null,
    orthoCaseId: null, adjustmentId: null, takenOn: review.expected.takenOn });
  return parsed.ok ? parsed.metadata : null;
}

export function ConsentModal(props: ConsentModalProps) {
  const session = useSession();
  const authority = `${session?.username ?? ""}:${session?.role ?? ""}:${JSON.stringify(session?.permissions ?? {})}`;
  const canUpload = session?.role === "admin" || session?.role === "reception"
    || (session?.role === "doctor" && session.permissions?.canUploadXrays === true);
  // The server still owns patient access and rechecks canUploadXrays on POST.
  const scope = `${props.patientId}:${authority}`;
  return props.isOpen ? <ConsentDocumentDraft key={`${scope}:${props.authorityKey ?? ""}:${props.patientName}`}
    {...props} canUpload={canUpload} scope={scope} /> : null;
}

function ConsentDocumentDraft({ onClose, patientId, patientName, onSigned,
  onDraftChange, onNavigationGuardChange, canUpload, scope,
}: ConsentModalProps & { canUpload: boolean; scope: string }) {
  const initialReview = pendingSaves.get(scope) ?? null;
  const initialMetadata = metadataForReview(initialReview, patientId);
  const [selectedTemplateId, setSelectedTemplateId] = useState(initialMetadata?.templateId ?? "surgical_extraction");
  const [signatoryName, setSignatoryName] = useState(initialMetadata?.signatoryName ?? patientName);
  const [signatoryRelation, setSignatoryRelation] = useState<"self" | "guardian">(initialMetadata?.signatoryRelation ?? "self");
  const [guardianRelation, setGuardianRelation] = useState(initialMetadata?.guardianRelation ?? "");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [takenOn, setTakenOn] = useState(() => initialMetadata?.takenOn ?? clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
  const [openPrintAfterSave, setOpenPrintAfterSave] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSignature, setHasSignature] = useState(false);
  const [review, setReview] = useState<SaveReview | null>(initialReview);
  const [reviewDocuments, setReviewDocuments] = useState<PatientDocument[]>([]);
  const [savedDocument, setSavedDocument] = useState<PatientDocument | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawing = useRef(false);
  const busyRef = useRef(false);
  const requestController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const completed = useRef(false);
  const dirtyRef = useRef(false);
  const reviewMetadata = metadataForReview(review, patientId);
  // Reopening an unresolved outcome shows the original reviewed content. It
  // never reconstructs the signature or checks consent on the human's behalf.
  const template = reviewMetadata ? { id: reviewMetadata.templateId, ...reviewMetadata.content }
    : getConsentTemplate(selectedTemplateId) ?? CONSENT_TEMPLATES[0];
  const dirty = hasSignature || agreedToTerms || signatoryName !== patientName
    || signatoryRelation !== "self" || guardianRelation !== "" || selectedTemplateId !== "surgical_extraction";
  const pending = saving || review !== null || (canUpload && dirty && !savedDocument);
  const locked = saving || review !== null || savedDocument !== null || !canUpload;
  const canEdit = () => mounted.current && !busyRef.current && review === null && !pendingSaves.has(scope) && !completed.current && canUpload;

  const clearSignature = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    isDrawing.current = false;
    setHasSignature(false);
  }, []);
  const invalidateSignature = () => {
    dirtyRef.current = true; clearSignature(); setAgreedToTerms(false);
  };
  const resetDraft = useCallback(() => {
    setSelectedTemplateId("surgical_extraction"); setSignatoryName(patientName);
    setSignatoryRelation("self"); setGuardianRelation(""); setAgreedToTerms(false);
    setTakenOn(clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
    dirtyRef.current = false; clearSignature();
  }, [patientName, clearSignature]);
  const discard = useCallback(() => {
    if (completed.current) return true;
    if (busyRef.current) return false;
    const uncertain = pendingSaves.has(scope) || review !== null;
    if ((uncertain || dirtyRef.current || (canUpload && dirty)) && !completed.current && !window.confirm(uncertain
      ? "نتيجة حفظ الإقرار غير مؤكدة. هل تريد المغادرة؟ ستبقى مراجعة النتيجة مطلوبة قبل إقرار جديد."
      : "هناك مسودة إقرار وتوقيع غير محفوظة. هل تريد تجاهلها؟")) return false;
    if (!uncertain) resetDraft();
    return true;
  }, [dirty, resetDraft, scope, canUpload, review]);
  useEffect(() => {
    onNavigationGuardChange?.(discard);
    return () => onNavigationGuardChange?.(null);
  }, [discard, onNavigationGuardChange]);
  useEffect(() => { onDraftChange?.(pending); return () => onDraftChange?.(false); }, [pending, onDraftChange]);
  useEffect(() => {
    mounted.current = true;
    const warn = (event: BeforeUnloadEvent) => {
      if (!completed.current && (busyRef.current || dirtyRef.current || pendingSaves.has(scope))) {
        event.preventDefault(); event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => { mounted.current = false; window.removeEventListener("beforeunload", warn); };
  }, [scope]);
  const close = () => { if (discard()) onClose(); };

  const getCoordinates = (e: MouseEvent | TouchEvent, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    const point = "touches" in e ? e.touches[0] : e;
    // Canvas backing pixels differ from its responsive CSS dimensions.
    return { x: point ? (point.clientX - rect.left) * (rect.width ? canvas.width / rect.width : 1) : 0,
      y: point ? (point.clientY - rect.top) * (rect.height ? canvas.height / rect.height : 1) : 0 };
  };
  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!canEdit()) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    isDrawing.current = true;
    const { x, y } = getCoordinates(e.nativeEvent, canvas);
    ctx.beginPath(); ctx.moveTo(x, y);
  };
  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!canEdit() || !isDrawing.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { x, y } = getCoordinates(e.nativeEvent, canvas);
    ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0f172a";
    ctx.lineTo(x, y); ctx.stroke(); dirtyRef.current = true; setHasSignature(true);
  };
  const stopDrawing = () => { isDrawing.current = false; };
  const rememberReview = (next: SaveReview) => {
    pendingSaves.set(scope, next);
    if (mounted.current) setReview(next);
  };
  const finish = (document: PatientDocument) => {
    if (!mounted.current || completed.current) return;
    completed.current = true; dirtyRef.current = false; pendingSaves.delete(scope);
    setReview(null); setSavedDocument(document); setError(null);
    // UI/print failures after verification are never classified as upload failure.
    if (openPrintAfterSave) {
      try { window.open(`/print/consent/${patientId}?docId=${document.id}`, "_blank", "noopener,noreferrer"); }
      catch { setError("تم حفظ الإقرار والتحقق منه، لكن تعذّر فتح الطباعة. افتحه من سجل المستندات."); }
    }
    try { onSigned?.(document); }
    catch { setError("تم حفظ الإقرار والتحقق منه، لكن تعذّر تحديث العرض. حدّث سجل المستندات."); }
    try { onClose(); } catch { /* The verified record remains locked against resubmission. */ }
  };
  const requestDocuments = async (init: RequestInit) => {
    const controller = new AbortController();
    requestController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`/api/patients/${patientId}/documents`, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => null);
      return { response, payload };
    } finally {
      clearTimeout(timeout);
      if (requestController.current === controller) requestController.current = null;
    }
  };
  const readBack = async (outcome: SaveReview) => {
    const { response, payload } = await requestDocuments({ cache: "no-store" });
    if (!mounted.current) return;
    if (!response.ok || !Array.isArray(payload?.documents)
      || !payload.documents.every((document: unknown) => hasDocumentContext(document, patientId))) {
      throw new Error("تعذّر التحقق من سجل مستندات هذا المريض. لا تُعد حفظ الإقرار قبل المراجعة.");
    }
    const exact = payload.documents.filter((document: PatientDocument) => document.id === outcome.documentId);
    if (outcome.documentId !== null && exact.length === 1 && matchesConsent(exact[0], patientId, outcome.expected)) {
      finish(exact[0]); return;
    }
    // A similar title, filename, new row, or missing ID is not proof of this POST.
    rememberReview({ ...outcome, reviewed: true });
    setReviewDocuments(payload.documents.filter((document: PatientDocument) => document.kind === "consent" && document.removedAt === null));
    setError("لم يمكن إثبات نتيجة الحفظ بالمعرّف نفسه. راجع الإقرارات المسجلة؛ إعادة الحفظ مقفلة لتجنّب التكرار.");
  };
  const reviewSave = async () => {
    const outcome = pendingSaves.get(scope) ?? review;
    if (!outcome || busyRef.current || !mounted.current) return;
    busyRef.current = true; setSaving(true); setError(null);
    try { await readBack(outcome); }
    catch { if (mounted.current) setError("تعذّرت مراجعة السجل. قد يكون الإقرار حُفظ؛ لا تُعد رفعه قبل المراجعة."); }
    finally { busyRef.current = false; if (mounted.current) setSaving(false); }
  };
  const startReviewedDraft = () => {
    const outcome = pendingSaves.get(scope) ?? review;
    if (busyRef.current || !mounted.current || !canUpload || !outcome?.reviewed) return;
    if (!window.confirm("راجعت الإقرارات المسجلة وأريد بدء إقرار جديد. قد يكون الإقرار السابق حُفظ؛ ستُمسح المسودة والتوقيع ولن يُعاد إرسالهما. هل تريد المتابعة؟")) return;
    pendingSaves.delete(scope); setReview(null); setReviewDocuments([]); setError(null); resetDraft();
  };

  const handleSaveConsent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit() || !validId(patientId)) return;
    if (!agreedToTerms) { setError("يجب تأكيد قراءة الشروط والموافقة عليها قبل حفظ الإقرار."); return; }
    if (!hasSignature || !canvasRef.current) { setError("يرجى توقيع المريض أو ولي أمره في لوحة التوقيع الرقمية."); return; }
    const canvas = canvasRef.current;
    const consent = createConsentDocumentMetadata({ patientId, patientName, visitId: null, orthoCaseId: null, adjustmentId: null,
      takenOn, templateId: template.id, signatoryName: signatoryName.trim(), signatoryRelation,
      guardianRelation: signatoryRelation === "guardian" ? guardianRelation.trim() : null });
    if (!consent.ok) { setError(consent.message); return; }
    busyRef.current = true; isDrawing.current = false; setSaving(true); setError(null);
    let attempted = false;
    try {
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value
        ? resolve(value) : reject(new Error("تعذّر تجهيز التوقيع. لم يُرسل الإقرار؛ حاول مجددًا.")), "image/png"));
      if (!mounted.current || pendingSaves.has(scope)) return;
      const file = new File([blob], `consent_${template.id}_${Date.now()}.png`, { type: "image/png" });
      const form = new FormData();
      const title = `إقرار موافقة: ${template.procedureName}`;
      form.set("file", file); form.set("kind", "consent"); form.set("title", title);
      form.set("takenOn", takenOn); form.set("note", consent.note);
      // Full versioned consent snapshot: never treat truncated JSON as complete.
      const expected = { title: title.slice(0, 120), note: consent.note, takenOn, sizeBytes: file.size };
      const outcome: SaveReview = { documentId: null, expected, reviewed: false };
      rememberReview(outcome); attempted = true;
      const { response, payload } = await requestDocuments({ method: "POST", body: form });
      if (!response.ok) {
        // Only explicit client-error rejection is treated as a definite non-write.
        if (response.status >= 400 && response.status < 500) {
          pendingSaves.delete(scope);
          if (mounted.current) {
            setReview(null);
            if (response.status === 409) { clearSignature(); setAgreedToTerms(false); }
            setError(payload?.message || "رفض الخادم حفظ الإقرار. صحح السبب قبل المحاولة.");
          }
        } else if (mounted.current) setError("لم يؤكد الخادم نتيجة الحفظ. قد يكون الإقرار حُفظ؛ راجع السجل قبل أي إقرار جديد.");
        return;
      }
      const identified = { ...outcome, documentId: validId(payload?.id) && payload?.patientId === patientId ? payload.id : null };
      rememberReview(identified);
      if (!mounted.current) return;
      if (!matchesConsent(payload, patientId, expected)) {
        setError("لم تؤكد استجابة الحفظ هوية الإقرار وارتباطه بهذا المريض. راجع السجل قبل أي إقرار جديد."); return;
      }
      await readBack(identified);
    } catch (cause) {
      if (mounted.current) setError(attempted
        ? "انقطع تأكيد الحفظ. قد يكون الإقرار حُفظ؛ راجع السجل ولا تُعد إرساله."
        : cause instanceof Error ? cause.message : "تعذّر تجهيز التوقيع. لم يُرسل الإقرار.");
    } finally { busyRef.current = false; if (mounted.current) setSaving(false); }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 sm:p-4 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto"
      dir="rtl"
    >
      <div
        className="my-auto w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl transition-all dark:border-slate-800 dark:bg-slate-900"
        role="dialog"
        aria-modal="true"
      >
        {/* ترويسة النافذة */}
        <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-navy-50 to-slate-100 px-6 py-4 dark:border-slate-800 dark:from-navy-950/50 dark:to-slate-900">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-navy-900 text-white shadow-md">
              <ShieldCheck className="h-5 w-5 text-emerald-400" />
            </div>
            <div>
              <h3 className="font-extrabold text-navy-900 dark:text-slate-100">
                إقرار الموافقة الطبية المستنيرة (Informed Consent)
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                المريض: <span className="font-bold text-navy-900 dark:text-slate-200">{patientName}</span>
              </p>
            </div>
          </div>
          <button
            onClick={close}
            disabled={saving}
            aria-label="إغلاق نموذج الإقرار"
            type="button"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSaveConsent} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
          {error && (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
          )}

          {!canUpload ? <p role="status" className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">يمكنك قراءة نموذج الموافقة؛ اعتماد إقرار جديد وحفظه يتطلب صلاحية رفع مستندات المريض.</p> : null}
          <p className="text-xs text-slate-500">يُحفظ الإقرار على مستوى ملف المريض #{patientId}؛ بلا ربط تلقائي بزيارة أو حالة تخصصية.</p>
          <p className="text-xs font-semibold text-slate-700">تاريخ الإقرار المعروض للمراجعة: <time aria-label="تاريخ الإقرار" dateTime={takenOn}>{takenOn}</time></p>
          {reviewMetadata ? <p className="text-xs text-slate-600">المريض عند إعداد الإقرار: {reviewMetadata.patientName}</p> : null}
          {savedDocument ? <p role="status">تم التحقق من حفظ الإقرار #{savedDocument.id} لهذا المريض.</p> : null}
          {review ? <section aria-label="مراجعة نتيجة حفظ الإقرار" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs">
            <p>نتيجة الحفظ تحتاج مراجعة{review.documentId === null ? "؛ لم يصل معرّف موثوق" : `: المستند #${review.documentId}`}.</p>
            {saving ? <button type="button" onClick={() => requestController.current?.abort()} className="rounded-lg border border-amber-400 px-3 py-2 font-bold">إيقاف الانتظار دون إعادة الإرسال</button> : null}
            <p>إغلاق النافذة وفتحها لا يسمح بإعادة الإرسال. لا يمكن اعتبار غياب مستند أو تشابه اسمه دليلًا على عدم الحفظ.</p>
            <button type="button" disabled={saving} onClick={() => void reviewSave()} className="rounded-lg border border-amber-400 px-3 py-2 font-bold">مراجعة السجل دون إعادة الحفظ</button>
            {review.reviewed ? <>
              <p>الإقرارات الظاهرة للمراجعة: {reviewDocuments.length}.</p>
              <ul>{reviewDocuments.map((document) => <li key={document.id}><a href={`/print/consent/${patientId}?docId=${document.id}`} target="_blank" rel="noopener noreferrer">مراجعة الإقرار #{document.id} · {document.title}</a></li>)}</ul>
              <button type="button" disabled={saving || !canUpload} onClick={startReviewedDraft} className="rounded-lg border border-amber-400 px-3 py-2 font-bold">راجعت السجل؛ ابدأ إقرارًا جديدًا</button>
            </> : null}
          </section> : null}
          {/* اختيار نوع الإجراء الطبي */}
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
              اختر نوع الإجراء السريري:
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {CONSENT_TEMPLATES.map((t) => {
                const isSelected = selectedTemplateId === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={saving || review !== null || savedDocument !== null}
                    onClick={() => {
                      if (!mounted.current || busyRef.current || pendingSaves.has(scope) || completed.current || t.id === selectedTemplateId) return;
                      if (canUpload && !discard()) return;
                      setSelectedTemplateId(t.id); dirtyRef.current = canUpload; setError(null);
                    }}
                    className={`flex items-center gap-2 rounded-xl p-2.5 text-right text-xs font-bold transition-all border ${
                      isSelected
                        ? "border-navy-900 bg-navy-900 text-white shadow-md shadow-navy-900/20 scale-[1.02]"
                        : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-300"
                    }`}
                  >
                    <span className="text-base shrink-0">{t.icon}</span>
                    <span className="truncate">{t.procedureName}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* نص الإقرار والبنود والمخاطر */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3 dark:border-slate-800 dark:bg-slate-800/30 text-xs">
            <h4 className="font-black text-navy-900 dark:text-slate-100 flex items-center gap-1.5">
              <FileText className="h-4 w-4 text-navy-700" />
              <span>{template.title}</span>
            </h4>
            <p className="leading-relaxed text-slate-700 dark:text-slate-300 text-[11px] bg-white dark:bg-slate-900 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800">
              {template.summary}
            </p>

            {/* البنود والتعهدات */}
            <div>
              <span className="font-bold text-slate-800 dark:text-slate-200 block mb-1">
                البنود والتعهدات الطبية:
              </span>
              <ul className="list-disc list-inside space-y-1 text-[11px] text-slate-600 dark:text-slate-400">
                {template.terms.map((term, i) => (
                  <li key={i} className="leading-relaxed">
                    {term}
                  </li>
                ))}
              </ul>
            </div>

            {/* المضاعفات والمخاطر المحتملة */}
            <div className="rounded-lg border border-amber-200 bg-amber-50/80 p-2.5 dark:border-amber-900/40 dark:bg-amber-950/30">
              <span className="font-bold text-amber-900 dark:text-amber-200 flex items-center gap-1 mb-1">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                <span>المضاعفات والآثار الجانبية المحتملة بعد الإجراء:</span>
              </span>
              <ul className="list-disc list-inside space-y-1 text-[10.5px] text-amber-950/90 dark:text-amber-300">
                {template.risks.map((risk, i) => (
                  <li key={i} className="leading-relaxed">
                    {risk}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <fieldset disabled={locked} className="min-w-0 space-y-4">
          {/* بيانات الموقع: المريض نفسه أو ولي الأمر */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                صفة الموقّع:
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!canEdit() || (signatoryRelation === "self" && signatoryName === patientName && guardianRelation === "")) return;
                    invalidateSignature(); setSignatoryRelation("self");
                    setSignatoryName(patientName); setGuardianRelation("");
                  }}
                  className={`flex-1 rounded-lg py-1.5 text-xs font-bold transition-colors ${
                    signatoryRelation === "self"
                      ? "bg-navy-900 text-white"
                      : "border border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800"
                  }`}
                >
                  المريض شخصياً
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!canEdit() || signatoryRelation === "guardian") return;
                    invalidateSignature(); setSignatoryRelation("guardian"); setSignatoryName("");
                  }}
                  className={`flex-1 rounded-lg py-1.5 text-xs font-bold transition-colors ${
                    signatoryRelation === "guardian"
                      ? "bg-navy-900 text-white"
                      : "border border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800"
                  }`}
                >
                  ولي الأمر / الوصي
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                اسم الموقّع الثلاثي:
              </label>
              <input
                type="text"
                value={signatoryName}
                maxLength={200}
                required
                aria-label="اسم الموقّع"
                onChange={(e) => { if (canEdit() && e.target.value !== signatoryName) { invalidateSignature(); setSignatoryName(e.target.value); } }}
                placeholder="اسم المريض أو ولي الأمر..."
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              {signatoryRelation === "guardian" && (
                <input
                  type="text"
                  value={guardianRelation}
                  maxLength={120}
                  required
                  aria-label="صلة القرابة"
                  onChange={(e) => { if (canEdit() && e.target.value !== guardianRelation) { invalidateSignature(); setGuardianRelation(e.target.value); } }}
                  placeholder="صلة القرابة (أب، أم، وصي شرعي...)"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              )}
            </div>
          </div>

          {/* لوحة التوقيع الحي (HTML5 Canvas Signature Pad) */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-200">
                <PenTool className="h-3.5 w-3.5 text-navy-800" />
                <span>توقيع المريض أو ولي أمره (باللمس أو القلم الإلكتروني):</span>
              </label>
              <button
                type="button"
                onClick={() => { if (canEdit()) invalidateSignature(); }}
                className="flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-rose-600 transition-colors"
                title="مسح وإعادة التوقيع"
              >
                <RotateCcw className="h-3 w-3" />
                <span>مسح</span>
              </button>
            </div>

            <div className="relative rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/50 dark:border-slate-700 dark:bg-slate-900/50 overflow-hidden">
              <canvas
                ref={canvasRef}
                aria-label="لوحة توقيع الإقرار"
                aria-disabled={locked}
                width={550}
                height={150}
                onMouseDown={startDrawing}
                onMouseMove={draw}
                onMouseUp={stopDrawing}
                onMouseLeave={stopDrawing}
                onTouchStart={startDrawing}
                onTouchMove={draw}
                onTouchEnd={stopDrawing}
                style={{ touchAction: "none" }}
                className="w-full h-[140px] cursor-crosshair bg-white dark:bg-slate-900 block"
              />
              {!hasSignature && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs font-semibold text-slate-400">
                  ✍️ وقّع هنا بإصبعك أو بالقلم
                </div>
              )}
            </div>
          </div>

          {/* خانة الإقرار النهائي */}
          <div className="pt-1">
            <label className="flex items-start gap-2 text-xs font-bold text-slate-800 dark:text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={agreedToTerms}
                aria-label="الموافقة على شروط الإقرار"
                onChange={(e) => { if (canEdit()) { dirtyRef.current = true; setAgreedToTerms(e.target.checked); } }}
                className="mt-0.5 rounded border-slate-300 text-navy-900 focus:ring-navy-900"
              />
              <span className="leading-relaxed">
                {CONSENT_ACKNOWLEDGEMENT}
              </span>
            </label>
          </div>

          </fieldset>
          <div className="flex items-center justify-between gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
            <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={openPrintAfterSave}
                disabled={locked}
                aria-label="فتح الطباعة بعد الحفظ"
                onChange={(e) => { if (canEdit()) setOpenPrintAfterSave(e.target.checked); }}
                className="rounded border-slate-300 text-navy-900 focus:ring-navy-900"
              />
              <span>🖨️ فتح نموذج الطباعة الرسمي (A4) فور الحفظ</span>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={close}
                disabled={saving}
                className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                إلغاء
              </button>
            <button
              type="submit"
              disabled={locked || !agreedToTerms || !hasSignature || !validId(patientId)}
              className="flex items-center gap-2 rounded-xl bg-navy-900 px-6 py-2.5 text-xs font-extrabold text-white shadow-md shadow-navy-900/20 hover:bg-navy-800 active:scale-95 disabled:opacity-40 transition-all"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>جاري اعتماد الإقرار...</span>
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  <span>اعتماد وحفظ الإقرار الموثق</span>
                </>
              )}
            </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
