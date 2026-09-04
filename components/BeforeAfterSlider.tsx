"use client";

import { useState, useRef, useCallback } from "react";
import {
  Sparkles,
  X,
  Share2,
  Columns,
  SplitSquareVertical,
  Check,
} from "lucide-react";

interface BeforeAfterSliderProps {
  isOpen: boolean;
  onClose: () => void;
  patientName: string;
  patientPhone?: string | null;
  beforeImageUrl: string;
  afterImageUrl: string;
  procedureName?: string;
  beforeLabel?: string;
  afterLabel?: string;
  clinicName?: string;
}

export function BeforeAfterSlider({
  isOpen,
  onClose,
  patientName,
  patientPhone,
  beforeImageUrl,
  afterImageUrl,
  procedureName = "تجميل وتأهيل الابتسامة",
  beforeLabel = "قبل المعالجة (Initial)",
  afterLabel = "بعد المعالجة (Result)",
  clinicName = "مركز الدكتور عقلان الكامل لطب وجراحة الفم والأسنان",
}: BeforeAfterSliderProps) {
  const [sliderPos, setSliderPos] = useState<number>(50);
  const [viewMode, setViewMode] = useState<"slider" | "side_by_side">("slider");
  const [copiedLink, setCopiedLink] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const isDragging = useRef<boolean>(false);

  const updatePosition = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setSliderPos(percentage);
  }, []);

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches[0]) {
      updatePosition(e.touches[0].clientX);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging.current) {
      updatePosition(e.clientX);
    }
  };

  if (!isOpen) return null;

  const handleWhatsAppShare = () => {
    const cleanPhone = patientPhone ? patientPhone.replace(/[^\d]/g, "") : "";
    const msg = [
      `السلام عليكم ${patientName}،`,
      `يسعدنا في ${clinicName} أن نشارككم النتيجة الرائعة لعلاجكم (${procedureName}) ✨.`,
      `فخورون بثقتكم وابتسامتكم الجديدة!`,
      `نتمنى لكم دوام الصحة والعافية.`,
    ].join("\n");

    const url = cleanPhone
      ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`
      : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    window.open(url, "_blank");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-3 sm:p-5 backdrop-blur-md animate-in fade-in duration-200"
      dir="rtl"
    >
      <div
        className="w-full max-w-3xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl transition-all dark:border-slate-800 dark:bg-slate-900 flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
      >
        {/* شريط العنوان */}
        <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-amber-50/70 via-white to-emerald-50/70 px-6 py-4 dark:border-slate-800 dark:from-amber-950/30 dark:via-slate-900 dark:to-emerald-950/30">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-amber-600 text-white shadow-md shadow-amber-500/25">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-extrabold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                <span>معرض نتائج الابتسامة (Smile Transformation)</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                المريض: <strong className="text-navy-900 dark:text-slate-200">{patientName}</strong> · {procedureName}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-800">
              <button
                type="button"
                onClick={() => setViewMode("slider")}
                className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs font-bold transition-all ${
                  viewMode === "slider"
                    ? "bg-white text-navy-900 shadow-xs dark:bg-slate-900 dark:text-white"
                    : "text-slate-600 dark:text-slate-400"
                }`}
                title="شريط المقارنة التفاعلي"
              >
                <SplitSquareVertical className="h-3.5 w-3.5" />
                <span>شريط</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("side_by_side")}
                className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs font-bold transition-all ${
                  viewMode === "side_by_side"
                    ? "bg-white text-navy-900 shadow-xs dark:bg-slate-900 dark:text-white"
                    : "text-slate-600 dark:text-slate-400"
                }`}
                title="عرض جنباً إلى جنب"
              >
                <Columns className="h-3.5 w-3.5" />
                <span>مقارنة</span>
              </button>
            </div>

            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* مساحة العرض التفاعلية */}
        <div className="p-6 flex-1 flex flex-col items-center justify-center overflow-hidden bg-slate-900/5 dark:bg-slate-950/40">
          {viewMode === "slider" ? (
            <div
              ref={containerRef}
              onMouseDown={(e) => {
                isDragging.current = true;
                updatePosition(e.clientX);
              }}
              onMouseMove={handleMouseMove}
              onMouseUp={() => (isDragging.current = false)}
              onMouseLeave={() => (isDragging.current = false)}
              onTouchMove={handleTouchMove}
              style={{ touchAction: "none" }}
              className="relative w-full max-w-xl aspect-[4/3] select-none overflow-hidden rounded-2xl border-4 border-white bg-slate-950 shadow-2xl cursor-ew-resize"
            >
              {/* صورة النتيجة (بعد) في الخلفية */}
              <img
                src={afterImageUrl}
                alt={afterLabel}
                className="absolute inset-0 h-full w-full object-cover pointer-events-none"
              />

              <div className="absolute top-3 right-3 rounded-lg bg-emerald-600/90 px-2.5 py-1 text-[11px] font-black text-white shadow-md backdrop-blur-xs">
                {afterLabel}
              </div>

              {/* صورة البداية (قبل) في المقدمة مقصوصة بالشريط */}
              <div
                style={{ clipPath: `polygon(0 0, ${sliderPos}% 0, ${sliderPos}% 100%, 0 100%)` }}
                className="absolute inset-0 h-full w-full pointer-events-none"
              >
                <img
                  src={beforeImageUrl}
                  alt={beforeLabel}
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <div className="absolute top-3 left-3 rounded-lg bg-slate-900/90 px-2.5 py-1 text-[11px] font-black text-white shadow-md backdrop-blur-xs">
                  {beforeLabel}
                </div>
              </div>

              {/* المقبض والخط الفاصل */}
              <div
                style={{ left: `${sliderPos}%` }}
                className="absolute inset-y-0 -ml-0.5 w-1 bg-white shadow-lg pointer-events-none flex items-center justify-center"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-navy-900 text-white shadow-xl text-xs font-bold">
                  ↔
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-2xl">
              <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border-2 border-slate-200 shadow-md">
                <img src={beforeImageUrl} alt={beforeLabel} className="h-full w-full object-cover" />
                <div className="absolute bottom-2 right-2 rounded-lg bg-slate-900/80 px-2.5 py-1 text-xs font-bold text-white backdrop-blur-xs">
                  {beforeLabel}
                </div>
              </div>
              <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border-2 border-emerald-500 shadow-md">
                <img src={afterImageUrl} alt={afterLabel} className="h-full w-full object-cover" />
                <div className="absolute bottom-2 right-2 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white shadow-xs">
                  {afterLabel}
                </div>
              </div>
            </div>
          )}

          <p className="mt-3 text-[11px] text-slate-500 font-medium text-center">
            {viewMode === "slider"
              ? "اسحب الخط الفاصل يميناً ويساراً لمشاهدة التحول المذهل في الابتسامة"
              : "مقارنة مباشرة بين حالة الأسنان قبل وبدء العلاج"}
          </p>
        </div>

        {/* الشريط السفلي ومشاركة الإنجاز */}
        <div className="flex items-center justify-between border-t border-slate-100 bg-white px-6 py-3.5 dark:border-slate-800 dark:bg-slate-900">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {clinicName}
          </span>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleWhatsAppShare}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-md shadow-emerald-600/20 hover:bg-emerald-700 active:scale-95 transition-all"
            >
              <Share2 className="h-4 w-4" />
              <span>مشاركة مع المريض عبر واتساب</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              إغلاق
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
