"use client";

import { useState, useMemo } from "react";
import {
  FileHeart,
  Send,
  Printer,
  X,
  AlertTriangle,
  Clock,
  Utensils,
  Sparkles,
  ShieldAlert,
} from "lucide-react";
import {
  POST_OP_TEMPLATES,
  getPostOpTemplate,
  detectPostOpTemplateFromText,
  formatPostOpWhatsAppMessage,
  type PostOpTemplate,
} from "@/lib/post-op-care";
import { toWhatsAppNumber } from "@/lib/reminders";

interface PostOpModalProps {
  isOpen: boolean;
  onClose: () => void;
  patientId: number;
  patientName: string;
  patientPhone?: string | null;
  initialTreatmentText?: string;
  clinicName?: string;
  clinicPhone?: string | null;
}

export function PostOpModal({
  isOpen,
  onClose,
  patientId,
  patientName,
  patientPhone,
  initialTreatmentText = "",
  clinicName = "مركز الدكتور عقلان الكامل لطب وجراحة الفم والأسنان",
  clinicPhone,
}: PostOpModalProps) {
  const defaultTemplate = useMemo(() => {
    return detectPostOpTemplateFromText(initialTreatmentText);
  }, [initialTreatmentText]);

  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    defaultTemplate.id,
  );
  const [customNotes, setCustomNotes] = useState<string>("");

  if (!isOpen) return null;

  const currentTemplate: PostOpTemplate =
    getPostOpTemplate(selectedTemplateId) ?? POST_OP_TEMPLATES[0];

  const handleWhatsApp = () => {
    const message = formatPostOpWhatsAppMessage(
      currentTemplate,
      patientName,
      clinicName,
      clinicPhone,
      customNotes,
    );

    const waNumber = patientPhone ? toWhatsAppNumber(patientPhone) : null;
    const url = waNumber
      ? `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`
      : `https://wa.me/?text=${encodeURIComponent(message)}`;

    window.open(url, "_blank");
  };

  const handlePrint = () => {
    const params = new URLSearchParams();
    params.set("templateId", currentTemplate.id);
    if (customNotes.trim()) {
      params.set("notes", customNotes.trim());
    }
    window.open(`/print/post-op/${patientId}?${params.toString()}`, "_blank");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 sm:p-4 backdrop-blur-xs animate-in fade-in duration-150 overflow-y-auto"
      dir="rtl"
    >
      <div
        className="my-auto flex flex-col max-h-[92vh] w-full max-w-3xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
        role="dialog"
        aria-modal="true"
      >
        {/* ترويسة النافذة */}
        <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-teal-50/50 px-6 py-4 dark:border-slate-800 dark:from-emerald-950/30 dark:to-slate-900">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-xs">
              <FileHeart className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-black text-navy-900 dark:text-slate-100">
                إرشادات العناية ما بعد العلاج السني (Post-Op Care)
              </h2>
              <p className="text-xs text-slate-500 font-medium dark:text-slate-400">
                المريض: <strong className="text-navy-900 dark:text-white">{patientName}</strong>
                {patientPhone ? ` · ${patientPhone}` : ""}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* محتوى النافذة */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* اختيار نوع الإجراء السني */}
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">
              🏥 اختر الإجراء السني المعالج:
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {POST_OP_TEMPLATES.map((tmpl) => {
                const isSelected = tmpl.id === currentTemplate.id;
                return (
                  <button
                    key={tmpl.id}
                    type="button"
                    onClick={() => setSelectedTemplateId(tmpl.id)}
                    className={`flex items-center gap-2 rounded-xl border p-2.5 text-right text-xs font-bold transition-all ${
                      isSelected
                        ? "border-emerald-600 bg-emerald-50 text-emerald-950 shadow-xs ring-1 ring-emerald-500/50 dark:bg-emerald-950/50 dark:text-emerald-200"
                        : "border-slate-200 bg-slate-50/70 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    <span className="text-base">{tmpl.icon}</span>
                    <span className="truncate">{tmpl.procedureName}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* بطاقة ملخص الإجراء */}
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/20">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xl">{currentTemplate.icon}</span>
              <h3 className="text-sm font-extrabold text-emerald-950 dark:text-emerald-200">
                {currentTemplate.title}
              </h3>
            </div>
            <p className="text-xs leading-relaxed text-emerald-900/80 dark:text-emerald-300/80">
              {currentTemplate.summary}
            </p>
          </div>

          {/* تفاصيل التعليمات في بطاقات منسقة */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {/* الساعات الـ 24 الأولى */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs dark:border-slate-800 dark:bg-slate-800/50 space-y-2">
              <div className="flex items-center gap-2 text-xs font-black text-navy-900 dark:text-slate-100">
                <Clock className="h-4 w-4 text-amber-500" />
                <span>⏰ الساعات الـ 24 الأولى (حرجة)</span>
              </div>
              <ul className="space-y-1.5 text-xs text-slate-700 dark:text-slate-300 pr-1">
                {currentTemplate.first24Hours.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-1.5">
                    <span className="text-emerald-600 font-bold shrink-0">•</span>
                    <span className="leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* المأكولات والمشروبات */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs dark:border-slate-800 dark:bg-slate-800/50 space-y-2">
              <div className="flex items-center gap-2 text-xs font-black text-navy-900 dark:text-slate-100">
                <Utensils className="h-4 w-4 text-emerald-600" />
                <span>🍲 المأكولات والمشروبات</span>
              </div>
              <div className="space-y-2 text-xs">
                <div>
                  <span className="font-extrabold text-emerald-800 dark:text-emerald-400">
                    ✅ المسموح:
                  </span>
                  <p className="mt-0.5 text-slate-700 dark:text-slate-300 leading-relaxed">
                    {currentTemplate.diet.allowed.join(" · ")}
                  </p>
                </div>
                <div>
                  <span className="font-extrabold text-rose-700 dark:text-rose-400">
                    ❌ الممنوع تجنبه:
                  </span>
                  <p className="mt-0.5 text-slate-700 dark:text-slate-300 leading-relaxed">
                    {currentTemplate.diet.avoid.join(" · ")}
                  </p>
                </div>
              </div>
            </div>

            {/* الأدوية ونظافة الفم */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs dark:border-slate-800 dark:bg-slate-800/50 space-y-2">
              <div className="flex items-center gap-2 text-xs font-black text-navy-900 dark:text-slate-100">
                <Sparkles className="h-4 w-4 text-teal-600" />
                <span>🪥 نظافة الفم والمسكنات</span>
              </div>
              <div className="space-y-1.5 text-xs text-slate-700 dark:text-slate-300">
                {currentTemplate.hygiene.concat(currentTemplate.medications).map((item, idx) => (
                  <div key={idx} className="flex items-start gap-1.5">
                    <span className="text-teal-600 font-bold shrink-0">•</span>
                    <span className="leading-relaxed">{item}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* علامات الخطر التي تستوجب الاتصال بالمركز */}
            <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-4 shadow-2xs dark:border-rose-900/50 dark:bg-rose-950/20 space-y-2">
              <div className="flex items-center gap-2 text-xs font-black text-rose-900 dark:text-rose-300">
                <ShieldAlert className="h-4 w-4 text-rose-600" />
                <span>🚨 متى تتصل بالمركز فوراً؟</span>
              </div>
              <ul className="space-y-1.5 text-xs text-rose-950 dark:text-rose-200 pr-1">
                {currentTemplate.emergencyWarnings.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-1.5">
                    <span className="text-rose-600 font-bold shrink-0">⚠️</span>
                    <span className="leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* ملاحظات الطبيب المخصصة للمريض */}
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
              ✍️ ملاحظة أو توجيه خاص من الطبيب (اختياري، ستُضاف لرسالة الواتساب والطباعة):
            </label>
            <textarea
              value={customNotes}
              onChange={(e) => setCustomNotes(e.target.value)}
              rows={2}
              placeholder="مثال: يرجى الحضور بعد 7 أيام لإزالة الخياطة، أو الالتزام بوضع كمادة دافئة بدءاً من الغد..."
              className="w-full rounded-2xl border border-slate-300 p-3 text-xs focus:border-emerald-600 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            />
          </div>
        </div>

        {/* تذييل النافذة والإجراءات */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-4 dark:border-slate-800 dark:bg-slate-900/80">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            إغلاق
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrint}
              className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-navy-900 hover:bg-slate-100 shadow-2xs transition-colors dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <Printer className="h-4 w-4 text-slate-600" />
              <span>طباعة كرت العناية (A5)</span>
            </button>

            <button
              type="button"
              onClick={handleWhatsApp}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-5 py-2 text-xs font-extrabold text-white shadow-xs hover:bg-emerald-700 active:scale-95 transition-all"
            >
              <Send className="h-4 w-4" />
              <span>إرسال الإرشادات للمريض عبر واتساب</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
