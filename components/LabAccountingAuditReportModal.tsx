"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import QRCode from "qrcode";
import { formatMoney, type Currency } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { Icon } from "@/components/Icon";
import {
  exportLabAccountingToExcel,
  exportLabAccountingToCsv,
  type LabAccountingExportRow,
} from "@/lib/labAccountingExport";

interface LabAccountingAuditReportModalProps {
  mappings: LabAccountingExportRow[];
  summary?: {
    totalLabs: number;
    activeLabs: number;
    totalOwedMinor: number;
    totalPaidMinor: number;
    totalDueMinor: number;
    activeOrdersTotal: number;
    customMappedCount: number;
  } | null;
  clinicName?: string;
  clinicPhone?: string;
  clinicAddress?: string;
  baseCurrency?: Currency;
  onClose: () => void;
}

export function LabAccountingAuditReportModal({
  mappings,
  summary,
  clinicName = "مركز عقلان لطب وجراحة الفم والأسنان",
  clinicPhone = "+967 1 234567",
  clinicAddress = "صنعاء - شارع بغداد",
  baseCurrency = "YER",
  onClose,
}: LabAccountingAuditReportModalProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const [selectedLabId, setSelectedLabId] = useState<number | "all">("all");
  const [autoPostFilter, setAutoPostFilter] = useState<"all" | "active" | "inactive">("all");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>("");

  const today = clinicDateString(new Date(), "Asia/Aden");
  const reportTime = new Intl.DateTimeFormat("ar-YE", {
    timeZone: "Asia/Aden",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  const auditDocRef = useMemo(() => {
    const d = today.replace(/-/g, "");
    return `AUD-LAB-${d}-${mappings.length}`;
  }, [today, mappings.length]);

  // Filter mappings based on modal selectors
  const filteredRows = useMemo(() => {
    return mappings.filter((row) => {
      if (selectedLabId !== "all" && row.id !== selectedLabId) return false;
      if (autoPostFilter === "active" && !row.autoPostJournal) return false;
      if (autoPostFilter === "inactive" && row.autoPostJournal) return false;
      return true;
    });
  }, [mappings, selectedLabId, autoPostFilter]);

  // Metrics for filtered rows
  const autoPostActiveCount = filteredRows.filter((r) => r.autoPostJournal).length;
  const totalOwed = filteredRows.reduce((sum, r) => sum + r.totalOwedMinor, 0);
  const totalPaid = filteredRows.reduce((sum, r) => sum + r.totalPaidMinor, 0);
  const totalDue = filteredRows.reduce((sum, r) => sum + r.dueMinor, 0);
  const totalActiveOrders = filteredRows.reduce((sum, r) => sum + r.activeOrdersCount, 0);

  // Generate QR Code for report authentication
  useEffect(() => {
    const payload = JSON.stringify({
      doc: "Lab-Accounting-Audit-Report",
      ref: auditDocRef,
      clinic: clinicName,
      date: `${today} ${reportTime}`,
      labsCount: filteredRows.length,
      autoPostEnabled: autoPostActiveCount,
      totalDue: totalDue,
      currency: baseCurrency,
    });

    QRCode.toDataURL(payload, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 120,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    })
      .then((url) => setQrCodeDataUrl(url))
      .catch((err) => {
        console.error("Failed to generate QR Code:", err);
      });
  }, [auditDocRef, clinicName, today, reportTime, filteredRows.length, autoPostActiveCount, totalDue, baseCurrency]);

  const handlePrint = () => {
    window.print();
  };

  const handleExportExcel = () => {
    exportLabAccountingToExcel({
      clinicName,
      clinicPhone,
      clinicAddress,
      baseCurrency,
      rows: filteredRows,
      summary,
      filterLabel:
        selectedLabId !== "all"
          ? mappings.find((m) => m.id === selectedLabId)?.name
          : autoPostFilter === "active"
          ? "المختبرات المفعل بها الترحيل التلقائي فقط"
          : "كافة المختبرات",
      generatedDate: today,
    });
  };

  const handleExportCsv = () => {
    exportLabAccountingToCsv({
      clinicName,
      clinicPhone,
      clinicAddress,
      baseCurrency,
      rows: filteredRows,
      summary,
      generatedDate: today,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 p-2 sm:p-4 backdrop-blur-xs overflow-y-auto print:static print:inset-auto print:bg-white print:p-0 print:backdrop-blur-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      id="lab-accounting-audit-modal"
    >
      {/* Print stylesheet */}
      <style jsx global>{`
        @media print {
          @page {
            size: A4 portrait;
            margin: 8mm 8mm 8mm 8mm;
          }
          body {
            background: #ffffff !important;
            color: #000000 !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          nav,
          header,
          aside,
          .print\\:hidden {
            display: none !important;
          }
          #lab-accounting-audit-print-root {
            width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          .page-break {
            page-break-after: always;
            break-after: page;
          }
        }
      `}</style>

      <div className="relative my-4 sm:my-8 w-full max-w-6xl rounded-3xl border border-slate-200 bg-white p-4 sm:p-7 shadow-2xl transition-all print:m-0 print:max-w-none print:rounded-none print:border-none print:p-0 print:shadow-none">
        {/* Modal Toolbar (Hidden during printing) */}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4 print:hidden">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-xs">
              <Icon name="clipboard" className="h-5 w-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-black text-slate-900">
                  تقرير تدقيق ومطابقة ربط حسابات المختبرات
                </h3>
                <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800 border border-emerald-200">
                  معتمد للتدقيق المحاسبي
                </span>
              </div>
              <p className="text-xs text-slate-500">
                وثيقة تدقيق رسمية جاهزة للطباعة بصيغة PDF وتصدير Excel تتضمن ربط دليل الحسابات وأثر الترحيل التلقائي
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Lab filter */}
            <div className="flex items-center gap-1.5 rounded-xl bg-slate-100 p-1 border border-slate-200 text-xs">
              <span className="px-1.5 text-slate-500 font-semibold text-[11px]">المختبر:</span>
              <select
                value={selectedLabId}
                onChange={(e) => {
                  const val = e.target.value;
                  setSelectedLabId(val === "all" ? "all" : Number(val));
                }}
                className="rounded-lg bg-white px-2 py-1 text-xs font-semibold text-slate-900 border border-slate-200 focus:outline-hidden"
              >
                <option value="all">كافة المختبرات ({mappings.length})</option>
                {mappings.map((lab) => (
                  <option key={lab.id} value={lab.id}>
                    {lab.name} ({lab.currency})
                  </option>
                ))}
              </select>
            </div>

            {/* Auto-post filter */}
            <div className="flex items-center gap-1.5 rounded-xl bg-slate-100 p-1 border border-slate-200 text-xs">
              <span className="px-1.5 text-slate-500 font-semibold text-[11px]">الترحيل:</span>
              <select
                value={autoPostFilter}
                onChange={(e) => setAutoPostFilter(e.target.value as any)}
                className="rounded-lg bg-white px-2 py-1 text-xs font-semibold text-slate-900 border border-slate-200 focus:outline-hidden"
              >
                <option value="all">الكل ({mappings.length})</option>
                <option value="active">مفعّل فقط ({mappings.filter((m) => m.autoPostJournal).length})</option>
                <option value="inactive">معطّل فقط ({mappings.filter((m) => !m.autoPostJournal).length})</option>
              </select>
            </div>

            {/* Export Excel Button */}
            <button
              type="button"
              onClick={handleExportExcel}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-700 px-3.5 py-2 text-xs font-bold text-white shadow-xs hover:bg-emerald-800 transition-colors"
              title="تحميل جدول إكسل منسق باللغة العربية"
            >
              <Icon name="download" className="h-4 w-4" />
              <span>تنزيل Excel (.xls)</span>
            </button>

            {/* Export CSV Button */}
            <button
              type="button"
              onClick={handleExportCsv}
              className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-xs hover:bg-slate-50 transition-colors"
              title="تحميل ملف CSV"
            >
              <Icon name="download" className="h-4 w-4 text-slate-500" />
              <span>CSV</span>
            </button>

            {/* Print / Save PDF Button */}
            <button
              type="button"
              onClick={handlePrint}
              className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white shadow-xs hover:bg-indigo-700 transition-colors"
              title="طباعة التقرير أو حفظه كملف PDF"
            >
              <Icon name="print" className="h-4 w-4" />
              <span>طباعة / حفظ PDF</span>
            </button>

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 transition-colors"
            >
              إغلاق
            </button>
          </div>
        </div>

        {/* Printable Document Root */}
        <div id="lab-accounting-audit-print-root" ref={printRef} className="space-y-6 text-slate-900">
          {/* Header section */}
          <div className="flex flex-wrap items-start justify-between border-b-2 border-slate-900 pb-4 gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white font-black text-lg shadow-xs">
                  🦷
                </div>
                <div>
                  <h1 className="text-lg font-black tracking-tight text-slate-950">
                    {clinicName}
                  </h1>
                  <p className="text-xs text-slate-500">
                    {clinicAddress} {clinicPhone ? `· هاتف: ${clinicPhone}` : ""}
                  </p>
                </div>
              </div>
              <div className="pt-2">
                <h2 className="text-base font-black text-indigo-950">
                  تقرير مطابقة وتدقيق ربط حسابات المختبرات والترحيل الآلي
                </h2>
                <p className="text-xs font-semibold text-slate-600">
                  Laboratory Accounting & Auto-Posting Audit Statement (Income Statement & Balance Sheet)
                </p>
              </div>
            </div>

            {/* Document metadata & QR Code */}
            <div className="flex items-center gap-3">
              <div className="text-left text-xs space-y-1 font-mono">
                <div className="text-[11px] font-bold text-slate-900">
                  الرقم المرجعي: <span className="text-indigo-700">{auditDocRef}</span>
                </div>
                <div className="text-slate-500 text-[10px]">
                  التاريخ: {today} | {reportTime}
                </div>
                <div className="text-slate-500 text-[10px]">
                  العملة الأساسية: {baseCurrency}
                </div>
                <div className="inline-block rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-sans font-bold text-slate-700">
                  نطاق التقرير: {filteredRows.length} مختبر
                </div>
              </div>

              {qrCodeDataUrl && (
                <div className="flex flex-col items-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={qrCodeDataUrl}
                    alt="Audit Verification QR"
                    className="h-16 w-16 rounded-lg border border-slate-200 bg-white p-0.5 shadow-xs"
                  />
                  <span className="mt-0.5 text-[8px] font-mono text-slate-400">ختم التدقيق الرقمي</span>
                </div>
              )}
            </div>
          </div>

          {/* Audit Key Metrics Cards */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5 text-xs">
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <div className="text-[10px] font-bold text-slate-500">المختبرات بالتقرير</div>
              <div className="mt-1 text-base font-black text-slate-900">
                {filteredRows.length}
                <span className="text-[10px] font-normal text-slate-500 mr-1.5">
                  ({filteredRows.filter((r) => r.isActive).length} نشط)
                </span>
              </div>
            </div>

            <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
              <div className="text-[10px] font-bold text-indigo-700">الترحيل التلقائي (Auto-Post)</div>
              <div className="mt-1 text-base font-black text-indigo-950">
                {autoPostActiveCount} من {filteredRows.length}
                <span className="text-[10px] font-semibold text-emerald-700 mr-1.5">
                  ({Math.round((autoPostActiveCount / (filteredRows.length || 1)) * 100)}%)
                </span>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <div className="text-[10px] font-bold text-slate-500">إجمالي الالتزامات (المصروفات)</div>
              <div className="mt-1 text-sm font-black font-mono text-slate-900">
                {formatMoney(totalOwed, baseCurrency)}
              </div>
            </div>

            <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-3">
              <div className="text-[10px] font-bold text-emerald-800">إجمالي المسدد للمعامل</div>
              <div className="mt-1 text-sm font-black font-mono text-emerald-700">
                {formatMoney(totalPaid, baseCurrency)}
              </div>
            </div>

            <div className="rounded-xl border border-rose-100 bg-rose-50/60 p-3 col-span-2 sm:col-span-1">
              <div className="text-[10px] font-bold text-rose-800">صافي الذمم الدائنة القائمة</div>
              <div className="mt-1 text-sm font-black font-mono text-rose-700">
                {formatMoney(totalDue, baseCurrency)}
              </div>
            </div>
          </div>

          {/* Audit Table */}
          <div className="overflow-hidden rounded-xl border border-slate-300 bg-white">
            <table className="w-full text-right text-[11px]">
              <thead className="border-b border-slate-300 bg-slate-100 text-slate-900 font-bold">
                <tr>
                  <th className="py-2.5 pr-3 pl-1 text-center w-8">م</th>
                  <th className="py-2.5 px-2">المختبر / المعمل</th>
                  <th className="py-2.5 px-2">الحالة / العملة</th>
                  <th className="py-2.5 px-2">بند المصروف (قائمة الدخل Debit)</th>
                  <th className="py-2.5 px-2">بند الذمم (الميزانية Credit)</th>
                  <th className="py-2.5 px-2">مسمى الحساب بالدفاتر</th>
                  <th className="py-2.5 px-2 text-center">الترحيل التلقائي</th>
                  <th className="py-2.5 px-2 text-center">الطلبات النشطة</th>
                  <th className="py-2.5 pr-2 pl-3 text-left">الرصيد المستحق (الذمة)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-slate-800">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-slate-400">
                      لا توجد بيانات مطابقة لمعايير التقرير المحددة.
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row, idx) => (
                    <tr
                      key={row.id}
                      className={`hover:bg-slate-50 transition-colors ${
                        idx % 2 === 1 ? "bg-slate-50/40" : "bg-white"
                      }`}
                    >
                      <td className="py-2.5 pr-3 pl-1 text-center font-mono text-slate-500 font-semibold">
                        {idx + 1}
                      </td>
                      <td className="py-2.5 px-2">
                        <div className="font-bold text-slate-950">{row.name}</div>
                        <div className="text-[10px] text-slate-500">
                          {row.totalOrdersCount} طلب إجمالي · تسليم خلال {row.deliveryDays} أيام
                        </div>
                      </td>
                      <td className="py-2.5 px-2">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`inline-block h-2 w-2 rounded-full ${
                              row.isActive ? "bg-emerald-500" : "bg-slate-300"
                            }`}
                          />
                          <span className="font-semibold text-slate-700">
                            {row.isActive ? "نشط" : "معطّل"}
                          </span>
                          <span className="rounded bg-slate-100 px-1 py-0.2 text-[9px] font-mono text-slate-600">
                            {row.currency}
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 px-2">
                        <div className="font-mono font-bold text-indigo-950">
                          {row.expenseAccountCode}
                        </div>
                        <div className="text-[10px] text-slate-600 font-medium truncate max-w-[190px]">
                          {row.expenseAccountName}
                        </div>
                      </td>
                      <td className="py-2.5 px-2">
                        <div className="font-mono font-bold text-slate-900">
                          {row.payableAccountCode}
                        </div>
                        <div className="text-[10px] text-slate-600 font-medium truncate max-w-[170px]">
                          {row.payableAccountName}
                        </div>
                      </td>
                      <td className="py-2.5 px-2 text-slate-700">
                        {row.customAccountName ? (
                          <span className="font-semibold text-indigo-900">{row.customAccountName}</span>
                        ) : (
                          <span className="text-slate-400">افتراضي ({row.name})</span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-center">
                        {row.autoPostJournal ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-800 border border-emerald-200">
                            <span>✓</span>
                            <span>مفعّل آلياً</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600 border border-slate-200">
                            <span>✗</span>
                            <span>معطّل (يدوي)</span>
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-center font-mono font-semibold text-slate-700">
                        {row.activeOrdersCount}
                      </td>
                      <td className="py-2.5 pr-2 pl-3 text-left">
                        <div
                          className={`font-mono font-bold ${
                            row.dueMinor > 0 ? "text-rose-700" : "text-slate-900"
                          }`}
                        >
                          {formatMoney(row.dueMinor, baseCurrency)}
                        </div>
                        <div className="text-[9px] text-slate-400">
                          مسدد: {formatMoney(row.totalPaidMinor, baseCurrency)}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot className="border-t-2 border-slate-900 bg-slate-100 text-slate-950 font-bold text-[11px]">
                <tr>
                  <td className="py-2.5 pr-3 pl-1 text-center">∑</td>
                  <td colSpan={6} className="py-2.5 px-2">
                    الإجمالي العام ({filteredRows.length} مختبر مسجل)
                  </td>
                  <td className="py-2.5 px-2 text-center font-mono">
                    {totalActiveOrders}
                  </td>
                  <td className="py-2.5 pr-2 pl-3 text-left font-mono font-black text-rose-700">
                    {formatMoney(totalDue, baseCurrency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Accounting Double-Entry Impact & Audit Standards */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3.5 text-xs text-slate-700 space-y-2">
            <div className="font-bold text-slate-900 flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-indigo-600" />
              <span>معايير التوجيه المحاسبي لدفتر اليومية والتدقيق:</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-lg border border-indigo-100 bg-white p-2">
                <span className="font-bold text-indigo-900 block mb-0.5">
                  1. إثبات التزام طلب المختبر (عند اعتماد الطلب):
                </span>
                <span className="text-slate-600 block">
                  <strong>مدين:</strong> حساب المصروف المحدد (5101 - 5109) بقائمة الدخل.
                  <br />
                  <strong>دائن:</strong> حساب الذمم الدائنة (2101 - 2104) بالميزانية العمومية.
                </span>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-2">
                <span className="font-bold text-slate-900 block mb-0.5">
                  2. سداد دفعات المختبر (سندات الصرف):
                </span>
                <span className="text-slate-600 block">
                  <strong>مدين:</strong> حساب الذمم الدائنة للمختبر (2101 - 2104) لتخفيض الالتزام.
                  <br />
                  <strong>دائن:</strong> حساب الصندوق والنقدية وما في حكمها (1101).
                </span>
              </div>
            </div>
          </div>

          {/* Official Sign-off & Audit Signature Block */}
          <div className="pt-4 border-t border-slate-300">
            <div className="grid grid-cols-3 gap-6 text-center text-xs">
              <div className="space-y-8">
                <div className="font-bold text-slate-900">إعداد المحاسب المالي</div>
                <div className="border-b border-dashed border-slate-400 w-3/4 mx-auto" />
                <div className="text-[10px] text-slate-400">التوقيع والتاريخ</div>
              </div>

              <div className="space-y-8">
                <div className="font-bold text-slate-900">تدقيق المراجع المالي الداخلي</div>
                <div className="border-b border-dashed border-slate-400 w-3/4 mx-auto" />
                <div className="text-[10px] text-slate-400">التوقيع والاعتماد</div>
              </div>

              <div className="space-y-8">
                <div className="font-bold text-slate-900">اعتماد الإدارة المالية / الختم الرسمي</div>
                <div className="border-b border-dashed border-slate-400 w-3/4 mx-auto" />
                <div className="text-[10px] text-slate-400">الختم الرسمي للمركز</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
