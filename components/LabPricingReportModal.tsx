"use client";

import React, { useState, useEffect, useRef } from "react";
import QRCode from "qrcode";
import { type Currency, CURRENCY_LABEL, formatAmount } from "@/lib/money";
import {
  type LabPricingRule,
  type LabService,
  type LabServiceCategory,
  LAB_SERVICE_CATEGORY_META,
  LAB_TOOTH_SCOPE_META,
} from "@/lib/lab";
import { clinicDateString } from "@/lib/schedule";

export interface LabPricingReportLab {
  id: number;
  name: string;
  currency: Currency;
  isActive: boolean;
  deliveryDays: number;
  phone?: string | null;
  contactPerson?: string | null;
  address?: string | null;
}

interface LabPricingReportModalProps {
  laboratories: LabPricingReportLab[];
  services: LabService[];
  rules: LabPricingRule[];
  initialLabId?: number | "all";
  clinicName?: string;
  clinicPhone?: string;
  onClose: () => void;
}

export function LabPricingReportModal({
  laboratories,
  services,
  rules,
  initialLabId = "all",
  clinicName = "مركز عقلان لطب وجراحة الفم والأسنان",
  clinicPhone = "+967 1 234567",
  onClose,
}: LabPricingReportModalProps) {
  const [selectedLabId, setSelectedLabId] = useState<number | "all">(initialLabId);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>("");
  const printRef = useRef<HTMLDivElement>(null);

  const today = clinicDateString(new Date(), "Asia/Aden");

  // Map service lookup
  const serviceMap = React.useMemo(() => {
    const map = new Map<number, LabService>();
    services.forEach((s) => map.set(s.id, s));
    return map;
  }, [services]);

  // Filter ONLY active/valid rules (Hiding expired rules where effectiveTo < today)
  const activeRules = React.useMemo(() => {
    return rules.filter((r) => {
      // Must not be expired
      if (r.effectiveTo && r.effectiveTo < today) return false;
      return true;
    });
  }, [rules, today]);

  // Selected labs to display in report
  const displayLabs = React.useMemo(() => {
    if (selectedLabId === "all") {
      return laboratories.filter((l) => l.isActive);
    }
    return laboratories.filter((l) => l.id === selectedLabId);
  }, [laboratories, selectedLabId]);

  // Generate QR Code for report authentication
  useEffect(() => {
    const labName =
      selectedLabId === "all"
        ? "All Active Labs"
        : laboratories.find((l) => l.id === selectedLabId)?.name || "Lab";

    const payload = JSON.stringify({
      title: "Lab Pricing Reference Report",
      clinic: clinicName,
      lab: labName,
      issueDate: today,
      activeRulesCount: activeRules.length,
      docType: "A4-Official-Lab-Pricing",
    });

    QRCode.toDataURL(payload, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 140,
      color: {
        dark: "#0a192f",
        light: "#ffffff",
      },
    })
      .then((url) => setQrCodeDataUrl(url))
      .catch((err) => {
        console.error("Failed to generate QR Code:", err);
      });
  }, [selectedLabId, laboratories, clinicName, today, activeRules.length]);

  const handlePrint = () => {
    window.print();
  };

  const categoriesOrder: LabServiceCategory[] = [
    "prostho",
    "implant",
    "ortho",
    "restorative",
    "appliance",
    "other",
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/75 p-2 sm:p-4 backdrop-blur-xs overflow-y-auto print:static print:inset-auto print:bg-white print:p-0 print:backdrop-blur-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Print CSS Rules specifically for A4 format */}
      <style jsx global>{`
        @media print {
          @page {
            size: A4 portrait;
            margin: 12mm 10mm;
          }
          body {
            background: #ffffff !important;
            color: #000000 !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          nav, header, aside, .print\\:hidden {
            display: none !important;
          }
          #lab-pricing-report-root {
            display: block !important;
            box-shadow: none !important;
            border: none !important;
            width: 100% !important;
            max-width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          .page-break {
            page-break-after: always;
            break-after: page;
          }
        }
      `}</style>

      <div className="relative my-4 sm:my-8 w-full max-w-5xl rounded-3xl border border-slate-200 bg-white p-4 sm:p-7 shadow-2xl transition-all print:m-0 print:max-w-none print:rounded-none print:border-none print:p-0 print:shadow-none">
        {/* Modal Toolbar (Hidden during printing) */}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4 print:hidden">
          <div className="flex items-center gap-2.5">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-navy-900 text-lg text-white shadow-xs">
              📄
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-black text-navy-950">
                  تقرير قائمة الأسعار المعتمدة للمختبرات (A4 Reference)
                </h3>
                <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-800 border border-emerald-200">
                  ✓ الأسعار السارية فقط (إخفاء المنتهية)
                </span>
              </div>
              <p className="text-xs text-slate-500">
                وثيقة رسمية بصيغة A4 لتقديمها لمعامل الأسنان كمرجع رسمي معتمد لقائمة أسعار الخدمات
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Lab Filter Selector in Modal */}
            <div className="flex items-center gap-1.5 rounded-xl bg-slate-100 p-1 border border-slate-200 text-xs">
              <span className="px-2 text-slate-500 font-bold text-[11px]">المختبر:</span>
              <select
                value={selectedLabId}
                onChange={(e) => {
                  const val = e.target.value;
                  setSelectedLabId(val === "all" ? "all" : Number(val));
                }}
                className="rounded-lg bg-white px-2.5 py-1 text-xs font-bold text-navy-900 border border-slate-200 focus:outline-none"
              >
                <option value="all">جميع المختبرات النشطة ({laboratories.filter((l) => l.isActive).length})</option>
                {laboratories.map((lab) => (
                  <option key={lab.id} value={lab.id}>
                    {lab.name} ({lab.currency})
                  </option>
                ))}
              </select>
            </div>

            {/* Print Button */}
            <button
              type="button"
              onClick={handlePrint}
              className="flex items-center gap-1.5 rounded-xl bg-navy-900 px-4 py-2 text-xs font-black text-white shadow-xs hover:bg-navy-800"
            >
              <span>🖨️ طباعة التقرير (A4)</span>
            </button>

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100"
            >
              إغلاق
            </button>
          </div>
        </div>

        {/* Printable Report Document Body */}
        <div id="lab-pricing-report-root" ref={printRef} className="space-y-8 text-slate-900">
          {displayLabs.map((lab, labIdx) => {
            // Get active rules for this lab
            const labRules = activeRules.filter((r) => r.partyId === lab.id);

            // Group lab rules by service category
            const rulesByCategory: Record<LabServiceCategory, LabPricingRule[]> = {
              prostho: [],
              implant: [],
              ortho: [],
              restorative: [],
              appliance: [],
              other: [],
            };

            labRules.forEach((r) => {
              const svc = serviceMap.get(r.labServiceId);
              const cat = svc?.category || "other";
              if (!rulesByCategory[cat]) rulesByCategory[cat] = [];
              rulesByCategory[cat].push(r);
            });

            const isLast = labIdx === displayLabs.length - 1;

            return (
              <div
                key={lab.id}
                className={`space-y-4 rounded-2xl border border-slate-200 bg-white p-5 sm:p-7 shadow-xs print:border-none print:p-0 print:shadow-none ${
                  !isLast ? "page-break" : ""
                }`}
              >
                {/* Official Header */}
                <div className="flex items-start justify-between border-b-2 border-navy-950 pb-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-navy-950 text-white font-black text-base">
                        🦷
                      </div>
                      <div>
                        <h1 className="text-lg sm:text-xl font-black text-navy-950">{clinicName}</h1>
                        <p className="text-xs font-bold text-slate-600">
                          قسم الاستعاضة والتركيبات السنية وإدارة شؤون المختبرات
                        </p>
                      </div>
                    </div>
                    {clinicPhone && (
                      <p className="text-[11px] text-slate-500 font-mono">
                        هاتف العيادة: <span className="font-bold text-slate-700">{clinicPhone}</span>
                      </p>
                    )}
                  </div>

                  {/* QR Code & Issue Meta */}
                  <div className="flex items-center gap-3" dir="ltr">
                    {qrCodeDataUrl && (
                      <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-1 shadow-2xs">
                        <img
                          src={qrCodeDataUrl}
                          alt="QR Verification"
                          className="h-16 w-16"
                        />
                        <span className="text-[8px] font-mono font-bold text-slate-500 mt-0.5">VERIFIED</span>
                      </div>
                    )}

                    <div className="text-right" dir="rtl">
                      <div className="inline-block rounded-xl bg-navy-950 px-3 py-1 text-xs font-black text-white font-mono shadow-2xs">
                        OFFICIAL LAB TARIFF
                      </div>
                      <p className="mt-1 text-[11px] font-bold text-slate-500">
                        تاريخ الإصدار: <span className="font-mono text-navy-950 font-bold">{today}</span>
                      </p>
                      <p className="text-[11px] font-bold text-slate-500">
                        صيغة الوثيقة: <span className="font-mono text-slate-800">A4 Standard</span>
                      </p>
                    </div>
                  </div>
                </div>

                {/* Laboratory Info Banner */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-2xl bg-slate-50 p-3.5 text-xs border border-slate-200">
                  <div>
                    <span className="block text-[10px] font-bold text-slate-400">المختبر السني المعتمد</span>
                    <span className="font-black text-navy-950 text-sm sm:text-base">{lab.name}</span>
                    <span className="block text-[10px] font-mono text-slate-500 font-bold">Party #{lab.id}</span>
                  </div>

                  <div>
                    <span className="block text-[10px] font-bold text-slate-400">العملة المعتمدة للتسعير</span>
                    <span className="font-black text-brand-blue text-xs sm:text-sm">
                      {CURRENCY_LABEL[lab.currency]} ({lab.currency})
                    </span>
                  </div>

                  <div>
                    <span className="block text-[10px] font-bold text-slate-400">مدة التسليم المتفق عليها</span>
                    <span className="font-bold text-slate-800 text-xs">
                      ⏱️ {lab.deliveryDays} أيام عمل اعتيادية
                    </span>
                  </div>

                  <div>
                    <span className="block text-[10px] font-bold text-slate-400">إجمالي الخدمات المسعرة</span>
                    <span className="font-black text-emerald-800 text-xs sm:text-sm">
                      {labRules.length} خدمة سارية ومثبتة
                    </span>
                  </div>
                </div>

                {/* Document Title */}
                <div className="text-center py-1 border-b border-dashed border-slate-200">
                  <h2 className="text-sm font-black text-navy-950 tracking-wide">
                    قائمة الأسعار المعتمدة للخدمات والتركيبات السنية السارية
                  </h2>
                  <p className="text-[11px] text-slate-500">
                    تُعتمد هذه التكاليف كأساس ملزم لمحاسبة وتوريد طلبات المعمل الصادرة ابتداءً من تواريخ السريان
                  </p>
                </div>

                {/* Tables by Specialty Category */}
                {labRules.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400">
                    لا توجد قواعد تسعير سارية مسجلة لهذا المختبر حالياً.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {categoriesOrder.map((catKey) => {
                      const catRules = rulesByCategory[catKey];
                      if (!catRules || catRules.length === 0) return null;
                      const catMeta = LAB_SERVICE_CATEGORY_META[catKey];

                      return (
                        <div key={catKey} className="overflow-hidden rounded-xl border border-slate-200">
                          <div className={`flex items-center justify-between px-3 py-1.5 ${catMeta?.bg || "bg-slate-100"} border-b border-slate-200`}>
                            <span className={`text-xs font-black ${catMeta?.text || "text-navy-950"} flex items-center gap-1.5`}>
                              <span>{catMeta?.label || catKey}</span>
                              <span className="text-[10px] font-bold opacity-80">({catRules.length} خدمات)</span>
                            </span>
                          </div>

                          <table className="w-full text-right text-[11px] border-collapse">
                            <thead>
                              <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-extrabold text-[10px]">
                                <th className="p-2 w-12 text-center">#الكود</th>
                                <th className="p-2">الخدمة السنية / التركيبة</th>
                                <th className="p-2 w-24 text-center">نطاق السن</th>
                                <th className="p-2 w-24 text-center">مدة الإنجاز</th>
                                <th className="p-2 w-28 text-center">تاريخ السريان</th>
                                <th className="p-2 w-32 text-left pl-3">سعر التكلفة المعتمد</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {catRules.map((rule) => {
                                const svc = serviceMap.get(rule.labServiceId);
                                const scopeMeta = svc ? LAB_TOOTH_SCOPE_META[svc.toothScope] : null;

                                return (
                                  <tr key={rule.id} className="hover:bg-slate-50/50">
                                    <td className="p-2 text-center font-mono text-[10px] text-slate-500 font-bold">
                                      {svc?.code ? `#${svc.code}` : "—"}
                                    </td>
                                    <td className="p-2">
                                      <span className="font-bold text-navy-950 block">
                                        {svc?.name || rule.serviceName || `خدمة #${rule.labServiceId}`}
                                      </span>
                                      {rule.note && (
                                        <span className="text-[10px] text-slate-500 block font-normal mt-0.5">
                                          ملاحظة: {rule.note}
                                        </span>
                                      )}
                                    </td>
                                    <td className="p-2 text-center">
                                      {scopeMeta ? (
                                        <span className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-bold ${scopeMeta.badgeBg}`}>
                                          {scopeMeta.shortLabel}
                                        </span>
                                      ) : (
                                        "—"
                                      )}
                                    </td>
                                    <td className="p-2 text-center font-mono text-[10px] text-slate-600">
                                      {svc ? `${svc.defaultDays} أيام` : "—"}
                                    </td>
                                    <td className="p-2 text-center font-mono text-[10px] text-slate-600">
                                      {rule.effectiveFrom}
                                    </td>
                                    <td className="p-2 text-left pl-3 font-mono font-black text-xs text-navy-950" dir="ltr">
                                      {formatAmount(rule.costMinor, rule.costCurrency)} {rule.costCurrency}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Important Notes & Conditions Box */}
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-[10px] text-slate-600 space-y-1">
                  <span className="font-extrabold text-navy-950 block">الشروط والضوابط الفنية المتفق عليها:</span>
                  <ul className="list-disc list-inside space-y-0.5 pr-1">
                    <li>الأسعار المذكورة أعلاه ملزمة ومعتمدة ولا تسري أي زيادة إلا بعد إشعار مسبق وتحديث السجل بتاريخ جديد.</li>
                    <li>يشمل السعر الفحص والتسليم وإعادة ضبط الحواف ونقاط التماس والإطباق وفق معايير الجودة المتبعة.</li>
                    <li>جميع التركيبات تخضع لفترة ضمان الجودة المتفق عليها ضد العيوب المصنعية.</li>
                  </ul>
                </div>

                {/* Official Sign-off and Authorization Box */}
                <div className="pt-4 border-t-2 border-slate-300 grid grid-cols-2 gap-8 text-xs text-slate-700">
                  <div className="space-y-6">
                    <div>
                      <p className="font-black text-navy-950">اعتماد إدارة المركز / الطبيب المسؤول:</p>
                      <p className="text-[10px] text-slate-500">Clinic Management Stamp & Signature</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="h-0.5 w-44 bg-slate-400" />
                      <span className="text-[10px] text-slate-400 font-mono">التاريخ: {today}</span>
                    </div>
                  </div>

                  <div className="space-y-6 text-left" dir="ltr">
                    <div>
                      <p className="font-black text-navy-950">Dental Lab Management / Acceptance:</p>
                      <p className="text-[10px] text-slate-500">اعتماد وتوقيع إدارة المختبر السني</p>
                    </div>
                    <div className="flex items-center gap-4 justify-end">
                      <span className="text-[10px] text-slate-400 font-mono">Date: ___/___/2026</span>
                      <div className="h-0.5 w-44 bg-slate-400" />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
