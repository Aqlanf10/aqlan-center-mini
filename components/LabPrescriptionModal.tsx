"use client";

import React, { useRef, useState, useEffect } from "react";
import QRCode from "qrcode";
import {
  type LabOrderClinicalDTO,
  type LabOrder,
  LAB_PRIORITY_LABEL,
  LAB_IMPRESSION_LABEL,
  LAB_TOOTH_ROLE_META,
  parseLabTeeth,
  formatLabPrescriptionText,
} from "@/lib/lab";
import { LabDentalChart } from "./LabDentalChart";
import { toUniversal } from "@/lib/dental";
import { useSetting } from "./SettingsProvider";
import { ReportPrintIdentity } from "./ReportPrintHeader";

interface LabPrescriptionModalProps {
  order: LabOrderClinicalDTO | LabOrder;
  clinicName?: string;
  clinicPhone?: string;
  onClose: () => void;
}

type PaperSize = "a4" | "a5";

export function LabPrescriptionModal({
  order,
  clinicName,
  clinicPhone,
  onClose,
}: LabPrescriptionModalProps) {
  // الروشتة تُرسل إلى المختبر باسم المركز — الاسم والهاتف من الإعدادات،
  // فالمختبر يتصل بالرقم المطبوع ليطلب تعديلًا، والرقم الخاطئ مكالمة ضائعة.
  const settingsName = useSetting("clinic.name");
  const settingsPhone = useSetting("clinic.phone");
  const resolvedName = clinicName ?? settingsName;
  const resolvedPhone = clinicPhone ?? settingsPhone;
  const printRef = useRef<HTMLDivElement>(null);
  const [paperSize, setPaperSize] = useState<PaperSize>("a4");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const toothMap = parseLabTeeth(order.toothNumbers);
  const selectedTeethCodes = Object.keys(toothMap).map(Number).sort((a, b) => a - b);

  // Generate QR Code containing the lab order reference
  useEffect(() => {
    const qrPayload = JSON.stringify({
      rx: `RX-${order.id}`,
      patient: order.patientName,
      fileNo: order.patientNumber || undefined,
      work: order.workType,
      shade: order.shade || undefined,
      lab: order.labName,
      sentDate: order.sentDate,
      dueDate: order.dueDate,
      priority: order.priority || "normal",
      teeth: order.toothNumbers || undefined,
    });

    QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 160,
      color: {
        dark: "#0a192f",
        light: "#ffffff",
      },
    })
      .then((url) => setQrCodeDataUrl(url))
      .catch((err) => {
        console.error("Failed to generate QR Code:", err);
      });
  }, [order]);

  const handlePrint = () => {
    window.print();
  };

  const handleCopyWhatsApp = () => {
    const text = formatLabPrescriptionText(order, resolvedName, resolvedPhone);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/75 p-2 sm:p-4 backdrop-blur-xs overflow-y-auto print:static print:inset-auto print:bg-white print:p-0 print:backdrop-blur-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Print Style Injector for A4 / A5 Layouts */}
      <style jsx global>{`
        @media print {
          @page {
            size: ${paperSize === "a5" ? "A5 portrait" : "A4 portrait"};
            margin: ${paperSize === "a5" ? "8mm" : "12mm"};
          }
          body {
            background: #ffffff !important;
            color: #000000 !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          /* Hide non-printable elements */
          nav, header, aside, .print\\:hidden {
            display: none !important;
          }
          /* Show print sheet clearly */
          #lab-prescription-print-root {
            display: block !important;
            box-shadow: none !important;
            border: none !important;
            width: 100% !important;
            max-width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
          }
        }
      `}</style>

      <div className="relative my-4 sm:my-8 w-full max-w-4xl rounded-3xl border border-slate-200 bg-white p-4 sm:p-7 shadow-2xl transition-all print:m-0 print:max-w-none print:rounded-none print:border-none print:p-0 print:shadow-none">
        {/* Modal Top Control Bar (Hidden in Print) */}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4 print:hidden">
          <div className="flex items-center gap-2.5">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-navy-900 text-lg text-white shadow-xs">
              📋
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-black text-navy-950">
                  استمارة طلب العمل المخبري
                </h3>
                <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-800 border border-emerald-200">
                  🔒 بيانات سريرية خالية من التكاليف المالية
                </span>
              </div>
              <p className="text-xs text-slate-500">
                مستند فني وسريري معتمد يشمل مخطط الأسنان، مواصفات العمل، ورمز الاستجابة السريعة
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Paper Size Selector */}
            <div className="flex items-center rounded-xl bg-slate-100 p-1 border border-slate-200 text-xs font-bold">
              <span className="px-2 text-slate-500 text-[11px]">حجم الورق:</span>
              <button
                type="button"
                onClick={() => setPaperSize("a4")}
                className={`rounded-lg px-2.5 py-1 text-xs transition ${
                  paperSize === "a4"
                    ? "bg-white text-navy-900 shadow-xs font-black"
                    : "text-slate-600 hover:text-navy-900"
                }`}
                title="تنسيق A4 الكامل (210×297 مم) - للمستندات السريرية الكاملة"
              >
                📄 A4 قياسي
              </button>
              <button
                type="button"
                onClick={() => setPaperSize("a5")}
                className={`rounded-lg px-2.5 py-1 text-xs transition ${
                  paperSize === "a5"
                    ? "bg-white text-navy-900 shadow-xs font-black"
                    : "text-slate-600 hover:text-navy-900"
                }`}
                title="تنسيق A5 المضغوط (148×210 مم) - موفر للورق وعملي للإرسال اليومي"
              >
                📑 A5 مضغوط
              </button>
            </div>

            {/* WhatsApp Copy */}
            <button
              type="button"
              onClick={handleCopyWhatsApp}
              className="flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800 hover:bg-emerald-100"
            >
              <span>{copied ? "✓ تم النسخ!" : "💬 نسخ لواتساب"}</span>
            </button>

            {/* Open Dedicated Print Page */}
            <a
              href={`/print/lab/${order.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-xl border border-sky-300 bg-sky-50 px-3 py-2 text-xs font-bold text-sky-800 hover:bg-sky-100"
            >
              <span>📄 صفحة طباعة رسمية</span>
            </a>

            {/* Print Button */}
            <button
              type="button"
              onClick={handlePrint}
              className="flex items-center gap-1.5 rounded-xl bg-navy-900 px-4 py-2 text-xs font-black text-white shadow-xs hover:bg-navy-800"
            >
              <span>🖨️ طباعة ({paperSize.toUpperCase()})</span>
            </button>

            {/* Close */}
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Printable Prescription Body */}
        <div
          id="lab-prescription-print-root"
          ref={printRef}
          className={`space-y-4 text-slate-900 ${
            paperSize === "a5" ? "text-[11px] leading-tight space-y-3" : "text-xs space-y-4"
          }`}
        >
          {/* Top Header & Branding */}
          <div className="flex items-start justify-between border-b-2 border-navy-900 pb-3">
            <div className="space-y-1">
              {/* الشعار الرسمي: الروشتة تُحمل خارج المركز إلى المختبر —
                  والشعار هو ما يميّزها بين أوراقه. */}
              <ReportPrintIdentity
                clinicName={resolvedName}
                clinicPhone={resolvedPhone}
                logoClassName={paperSize === "a5" ? "h-10 w-10" : "h-12 w-12"}
              />
              <p className="text-[10px] sm:text-[11px] font-bold text-slate-500">
                قسم الاستعاضة السنية والتركيبات المتقدمة
              </p>
            </div>

            {/* Reference Badge & QR Code */}
            <div className="flex items-center gap-3" dir="ltr">
              {qrCodeDataUrl ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-1 shadow-2xs">
                  {/* الرمز يُمسح بجهاز المختبر، والنصّ تحته للإنسان — عربيّ دائمًا. */}
                  <img
                    src={qrCodeDataUrl}
                    alt={`رمز استعلام للطلب رقم ${order.id}`}
                    className={paperSize === "a5" ? "h-14 w-14" : "h-18 w-18"}
                  />
                  <span className="text-[8px] font-mono font-bold text-slate-500 mt-0.5">امسح للاستعلام</span>
                </div>
              ) : null}

              <div className="text-right" dir="rtl">
                <div className="inline-block rounded-xl bg-navy-950 px-3 py-1 text-xs font-black text-white font-mono shadow-2xs">
                  طلب مخبري رقم {order.id}
                </div>
                <p className="mt-1 text-[10px] font-bold text-slate-500">
                  تاريخ الإرسال: <span className="font-mono text-slate-900 font-bold">{order.sentDate}</span>
                </p>
                <p className="text-[10px] font-bold text-slate-500">
                  تاريخ الاستحقاق: <span className="font-mono text-rose-700 font-bold">{order.dueDate}</span>
                </p>
              </div>
            </div>
          </div>

          {/* Patient, Doctor & Laboratory Info Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 rounded-2xl bg-slate-50/80 p-3 text-xs border border-slate-200">
            <div>
              <span className="block text-[10px] font-bold text-slate-400">اسم المريض</span>
              <span className="font-black text-navy-950 text-xs sm:text-sm">{order.patientName}</span>
              {order.patientNumber && (
                <span className="block text-[10px] font-mono text-slate-500 font-bold">
                  ملف رقم: #{order.patientNumber}
                </span>
              )}
            </div>

            <div>
              <span className="block text-[10px] font-bold text-slate-400">المختبر السني</span>
              <span className="font-black text-navy-900 text-xs sm:text-sm">{order.labName}</span>
              {order.labPhone && (
                <span className="block text-[10px] font-mono text-slate-500 font-semibold">{order.labPhone}</span>
              )}
            </div>

            <div>
              <span className="block text-[10px] font-bold text-slate-400">الطبيب المعالج</span>
              <span className="font-bold text-slate-800 text-xs">{order.doctorName || "عيادة المركز"}</span>
            </div>

            <div>
              <span className="block text-[10px] font-bold text-slate-400">درجة الأولوية</span>
              <span
                className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-black ${
                  LAB_PRIORITY_LABEL[order.priority || "normal"].bg
                } ${LAB_PRIORITY_LABEL[order.priority || "normal"].text}`}
              >
                {LAB_PRIORITY_LABEL[order.priority || "normal"].label}
              </span>
            </div>
          </div>

          {/* Clinical Work & Shade Specifications */}
          <div className="rounded-2xl border border-slate-200 p-3 sm:p-4 bg-white space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
              <div>
                <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">
                  نوع العمل / التركيبة المطلوبة
                </span>
                <span className="text-sm sm:text-base font-black text-navy-900">{order.workType}</span>
              </div>

              {/* Shades & Aesthetics */}
              <div className="flex flex-wrap items-center gap-1.5">
                {order.shade && (
                  <span className="rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-1 text-xs font-bold text-amber-900">
                    لون السن: <strong className="font-mono text-sm">{order.shade}</strong>
                  </span>
                )}
                {order.stumpShade && (
                  <span className="rounded-lg bg-slate-100 border border-slate-300 px-2.5 py-1 text-xs font-bold text-slate-800">
                    لون الجذع: <strong className="font-mono">{order.stumpShade}</strong>
                  </span>
                )}
              </div>
            </div>

            {/* Technical Specifications Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-[10px] font-bold text-slate-400 block">نوع الطبعة المسلّمة</span>
                <span className="font-bold text-slate-800">
                  {LAB_IMPRESSION_LABEL[order.impressionType || "physical"]}
                </span>
              </div>

              {order.details && (
                <div>
                  <span className="text-[10px] font-bold text-slate-400 block">المواصفات والتعليمات الفنية</span>
                  <span className="font-medium text-slate-800">{order.details}</span>
                </div>
              )}
            </div>

            {order.note && (
              <div className="rounded-xl bg-amber-50/60 p-2 text-xs text-amber-950 border border-amber-200/80">
                <span className="font-bold">ملاحظات الطبيب الفنية: </span>
                <span>{order.note}</span>
              </div>
            )}
          </div>

          {/* FDI Dental Chart (Visual Clinical Tooth Roles) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-black text-navy-950 flex items-center gap-1.5">
                <span>🦷</span>
                <span>مخطط الأسنان السريري وتوزيع الأدوار</span>
              </h4>
              {selectedTeethCodes.length > 0 && (
                <span className="text-[10px] font-bold text-slate-500 font-mono">
                  إجمالي الوحدات: {selectedTeethCodes.length}
                </span>
              )}
            </div>

            {order.toothNumbers ? (
              <div className={paperSize === "a5" ? "scale-[0.88] origin-top -mb-2" : ""}>
                <LabDentalChart value={order.toothNumbers} readOnly={true} showSummary={false} />
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-slate-200 p-3 text-center text-xs text-slate-400">
                لم يتم تحديد أرقام أسنان محددة في هذا الطلب.
              </p>
            )}

            {/* Tooth Roles Breakdown Badges */}
            {selectedTeethCodes.length > 0 && (
              <div className="rounded-xl bg-slate-50 p-2.5 border border-slate-200">
                <span className="text-[10px] font-extrabold text-slate-500 block mb-1.5">
                  تفصيل دور كل سن وموقعه ({selectedTeethCodes.length} أسنان):
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                  {selectedTeethCodes.map((code) => {
                    const role = toothMap[code];
                    const meta = LAB_TOOTH_ROLE_META[role];
                    return (
                      <div
                        key={code}
                        className="flex items-center justify-between rounded-lg bg-white p-1.5 border border-slate-200 shadow-2xs text-[11px]"
                      >
                        <div>
                          <span className="font-mono font-black text-navy-950 text-xs">سن {code}</span>
                          <span className="block text-[9px] text-slate-400 font-mono">ترقيم موحد {toUniversal(code)}</span>
                        </div>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[9px] font-black ${
                            meta ? meta.badgeClass : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {meta ? `${meta.icon} ${meta.shortLabel}` : role}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Quality Checklist at Lab Reception (Clinical Check Only) */}
          <div className="rounded-2xl border border-dashed border-slate-300 p-2.5 text-[10px] bg-slate-50/40 text-slate-600">
            <span className="font-extrabold text-navy-900 block mb-1">
              قائمة التحقق المبدئية عند تسليم واستلام التركيبة:
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <label className="flex items-center gap-1">
                <input type="checkbox" disabled className="rounded" />
                <span>مطابقة اللون وتدرج الظل</span>
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" disabled className="rounded" />
                <span>انطباق الحواف</span>
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" disabled className="rounded" />
                <span>نقاط التماس والإطباق</span>
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" disabled className="rounded" />
                <span>سلامة التلميع والإنهاء</span>
              </label>
            </div>
          </div>

          {/* Doctor & Lab Signatures */}
          <div className="pt-3 border-t-2 border-slate-200 grid grid-cols-2 gap-6 text-xs text-slate-700">
            <div className="space-y-7">
              <div>
                <p className="font-black text-navy-900">ختم وتوقيع الطبيب المعالج:</p>
              </div>
              <div className="h-0.5 w-44 bg-slate-400" />
            </div>

            <div className="space-y-7 text-left">
              <div>
                <p className="font-black text-navy-900">فني المعمل / المستلم:</p>
                <p className="text-[10px] text-slate-400">توقيع واستلام فني المعمل</p>
              </div>
              <div className="h-0.5 w-44 bg-slate-400 mr-auto ml-0" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

