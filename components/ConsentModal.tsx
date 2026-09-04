"use client";

import { useState, useRef, useEffect } from "react";
import {
  FileText,
  PenTool,
  AlertTriangle,
  CheckCircle2,
  X,
  RotateCcw,
  Save,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import {
  CONSENT_TEMPLATES,
  getConsentTemplate,
  type ConsentTemplate,
} from "@/lib/consent-templates";

interface ConsentModalProps {
  isOpen: boolean;
  onClose: () => void;
  patientId: number;
  patientName: string;
  onSigned?: (document: any) => void;
}

export function ConsentModal({
  isOpen,
  onClose,
  patientId,
  patientName,
  onSigned,
}: ConsentModalProps) {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("surgical_extraction");
  const [signatoryName, setSignatoryName] = useState<string>("");
  const [signatoryRelation, setSignatoryRelation] = useState<"self" | "guardian">("self");
  const [guardianRelation, setGuardianRelation] = useState<string>("");
  const [agreedToTerms, setAgreedToTerms] = useState<boolean>(false);
  const [openPrintAfterSave, setOpenPrintAfterSave] = useState<boolean>(true);

  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSignature, setHasSignature] = useState<boolean>(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawing = useRef<boolean>(false);

  const template = getConsentTemplate(selectedTemplateId) ?? CONSENT_TEMPLATES[0];

  useEffect(() => {
    if (isOpen) {
      setSignatoryName(patientName);
      setSignatoryRelation("self");
      setGuardianRelation("");
      setAgreedToTerms(false);
      setHasSignature(false);
      setError(null);

      // إعادة تهيئة الكانفاس بعد الرندرة
      setTimeout(clearSignature, 100);
    }
  }, [isOpen, patientName, selectedTemplateId]);

  if (!isOpen) return null;

  // دوال الرسم على الكانفاس
  const getCoordinates = (e: MouseEvent | TouchEvent, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    if ("touches" in e && e.touches[0]) {
      return {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top,
      };
    } else if ("clientX" in e) {
      return {
        x: (e as MouseEvent).clientX - rect.left,
        y: (e as MouseEvent).clientY - rect.top,
      };
    }
    return { x: 0, y: 0 };
  };

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    isDrawing.current = true;
    const { x, y } = getCoordinates(e.nativeEvent, canvas);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { x, y } = getCoordinates(e.nativeEvent, canvas);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a"; // Navy 900
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasSignature(true);
  };

  const stopDrawing = () => {
    isDrawing.current = false;
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  const handleSaveConsent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;

    if (!agreedToTerms) {
      setError("يجب تأكيد قراءة الشروط والموافقة عليها قبل حفظ الإقرار.");
      return;
    }

    if (!hasSignature || !canvasRef.current) {
      setError("يرجى توقيع المريض أو ولي أمره في لوحة التوقيع الرقمية.");
      return;
    }

    const name = signatoryName.trim() || patientName;
    setSaving(true);
    setError(null);

    try {
      // تحويل الكانفاس إلى Blob
      const canvas = canvasRef.current;
      const dataUrl = canvas.toDataURL("image/png");
      const resBlob = await fetch(dataUrl);
      const blob = await resBlob.blob();

      const fileName = `consent_${template.id}_${Date.now()}.png`;
      const file = new File([blob], fileName, { type: "image/png" });

      const form = new FormData();
      form.set("file", file);
      form.set("kind", "consent");
      form.set("title", `إقرار موافقة: ${template.procedureName}`);
      form.set("takenOn", new Date().toISOString().slice(0, 10));
      const notePayload = {
        templateId: template.id,
        signatoryName: name,
        signatoryRelation,
        guardianRelation: guardianRelation || null,
        procedureName: template.procedureName,
        title: template.title,
        textNote: `الموقع: ${name} (${signatoryRelation === "self" ? "المريض شخصياً" : `ولي الأمر: ${guardianRelation || "قريب"}`}) · ${template.title}`,
      };
      form.set("note", JSON.stringify(notePayload));

      const response = await fetch(`/api/patients/${patientId}/documents`, {
        method: "POST",
        body: form,
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.message || "تعذّر حفظ وثيقة الإقرار.");
      }

      if (openPrintAfterSave && payload?.id) {
        window.open(`/print/consent/${patientId}?docId=${payload.id}`, "_blank");
      }

      if (onSigned) {
        onSigned(payload);
      }
      onClose();
    } catch (err: any) {
      setError(err.message || "حدث خطأ غير متوقع أثناء حفظ الإقرار.");
    } finally {
      setSaving(false);
    }
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
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSaveConsent} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
          )}

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
                    onClick={() => setSelectedTemplateId(t.id)}
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
                    setSignatoryRelation("self");
                    setSignatoryName(patientName);
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
                  onClick={() => setSignatoryRelation("guardian")}
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
                onChange={(e) => setSignatoryName(e.target.value)}
                placeholder="اسم المريض أو ولي الأمر..."
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              {signatoryRelation === "guardian" && (
                <input
                  type="text"
                  value={guardianRelation}
                  onChange={(e) => setGuardianRelation(e.target.value)}
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
                onClick={clearSignature}
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
                onChange={(e) => setAgreedToTerms(e.target.checked)}
                className="mt-0.5 rounded border-slate-300 text-navy-900 focus:ring-navy-900"
              />
              <span className="leading-relaxed">
                أقر بأنني قرأت وفهمت كافة الشروط والمضاعفات المذكورة أعلاه، وأمنح موافقتي التامة للطبيب المعالج لإجراء المعالجة المطلوبة.
              </span>
            </label>
          </div>

          <div className="flex items-center justify-between gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
            <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={openPrintAfterSave}
                onChange={(e) => setOpenPrintAfterSave(e.target.checked)}
                className="rounded border-slate-300 text-navy-900 focus:ring-navy-900"
              />
              <span>🖨️ فتح نموذج الطباعة الرسمي (A4) فور الحفظ</span>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                إلغاء
              </button>
            <button
              type="submit"
              disabled={saving || !agreedToTerms || !hasSignature}
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
