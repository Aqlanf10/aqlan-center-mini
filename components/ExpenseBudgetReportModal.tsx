"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import QRCode from "qrcode";
import { formatMoney, type Currency } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { Icon } from "@/components/Icon";
import { exportExpenseBudgetToExcel } from "@/lib/expenseBudgetExport";
import type { ExpenseCategoryDTO, ExpenseBudgetSummary } from "@/lib/db";

interface ExpenseBudgetReportModalProps {
  categories: ExpenseCategoryDTO[];
  summary: ExpenseBudgetSummary;
  month: string;
  clinicName?: string;
  clinicPhone?: string;
  clinicAddress?: string;
  baseCurrency?: Currency;
  onClose: () => void;
}

export function ExpenseBudgetReportModal({
  categories,
  summary,
  month,
  clinicName = "مركز عقلان لطب وجراحة الفم والأسنان",
  clinicPhone = "+967 1 234567",
  clinicAddress = "صنعاء - شارع بغداد",
  baseCurrency = "YER",
  onClose,
}: ExpenseBudgetReportModalProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const [selectedGroup, setSelectedGroup] = useState<string>("all");
  const [budgetStatusFilter, setBudgetStatusFilter] = useState<"all" | "over" | "within">("all");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>("");

  const today = clinicDateString(new Date(), "Asia/Aden");
  const reportTime = new Intl.DateTimeFormat("ar-YE", {
    timeZone: "Asia/Aden",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  const auditDocRef = useMemo(() => {
    const d = today.replace(/-/g, "");
    return `AUD-EXP-${month.replace(/-/g, "")}-${d}`;
  }, [today, month]);

  const uniqueGroups = useMemo(() => {
    return Array.from(new Set(categories.map((c) => c.categoryGroup)));
  }, [categories]);

  const filteredRows = useMemo(() => {
    return categories.filter((row) => {
      if (selectedGroup !== "all" && row.categoryGroup !== selectedGroup) return false;
      if (budgetStatusFilter === "over" && !row.isOverBudget) return false;
      if (budgetStatusFilter === "within" && row.isOverBudget) return false;
      return true;
    });
  }, [categories, selectedGroup, budgetStatusFilter]);

  const totalMonthlyBudget = useMemo(
    () => filteredRows.reduce((sum, r) => sum + r.monthlyBudgetMinor, 0),
    [filteredRows],
  );
  const totalActualSpent = useMemo(
    () => filteredRows.reduce((sum, r) => sum + r.actualSpentMinor, 0),
    [filteredRows],
  );
  const totalVariance = totalMonthlyBudget - totalActualSpent;
  const totalExpensesCount = useMemo(
    () => filteredRows.reduce((sum, r) => sum + r.expensesCount, 0),
    [filteredRows],
  );
  const overBudgetCount = filteredRows.filter((r) => r.isOverBudget).length;
  const overallPercent = totalMonthlyBudget > 0 ? Math.round((totalActualSpent / totalMonthlyBudget) * 100) : 0;
  const totalVariancePercent = totalMonthlyBudget > 0
    ? Math.round(((totalActualSpent - totalMonthlyBudget) / totalMonthlyBudget) * 100)
    : totalActualSpent > 0 ? 100 : 0;

  useEffect(() => {
    const qrPayload = JSON.stringify({
      ref: auditDocRef,
      clinic: clinicName,
      month,
      items: categories.length,
      budgetTotal: (summary.totalMonthlyBudgetMinor / 100).toFixed(2),
      actualTotal: (summary.totalActualSpentMinor / 100).toFixed(2),
      date: `${today} ${reportTime}`,
    });

    QRCode.toDataURL(qrPayload, {
      width: 140,
      margin: 1,
      color: { dark: "#0F172A", light: "#FFFFFF" },
    })
      .then((url) => setQrCodeDataUrl(url))
      .catch((err) => console.error("QR Code generation error:", err));
  }, [auditDocRef, clinicName, month, categories.length, summary, today, reportTime]);

  const handlePrint = () => {
    window.print();
  };

  const handleExcelExport = () => {
    exportExpenseBudgetToExcel({
      clinicName,
      clinicPhone,
      clinicAddress,
      baseCurrency,
      categories: filteredRows,
      summary,
      month,
      generatedDate: today,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-2 sm:p-4 backdrop-blur-sm overflow-y-auto print:p-0 print:bg-white print:static print:inset-auto">
      {/* Container */}
      <div className="relative w-full max-w-5xl rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden flex flex-col my-auto max-h-[92vh] print:max-h-none print:shadow-none print:border-none print:rounded-none">
        {/* Modal Controls Header (Hidden in Print) */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/90 px-5 py-3.5 print:hidden">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-100 text-teal-700">
              <Icon name="file" className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-800">
                تقرير تدقيق بنود المصروفات التشغيلية والميزانيات التقديرية
              </h2>
              <p className="text-xs text-slate-500">
                شهر: {month} — كود التوثيق: <span className="font-mono text-slate-700">{auditDocRef}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleExcelExport}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 transition shadow-sm"
              title="تنزيل كملف Excel معتمد"
            >
              <Icon name="download" className="h-4 w-4 text-emerald-600" />
              تصدير Excel
            </button>

            <button
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 transition shadow-sm"
              title="طباعة التقرير أو حفظه بصيغة PDF"
            >
              <Icon name="print" className="h-4 w-4" />
              طباعة / PDF
            </button>

            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 transition"
              title="إغلاق النافذة"
            >
              <Icon name="close" className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Modal Filter Toolbar (Hidden in Print) */}
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-5 py-2.5 text-xs print:hidden">
          <div className="flex items-center gap-1.5">
            <label className="text-slate-500 font-medium">المجموعة:</label>
            <select
              value={selectedGroup}
              onChange={(e) => setSelectedGroup(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:border-teal-500 focus:outline-none"
            >
              <option value="all">كافة المجموعات ({categories.length})</option>
              {uniqueGroups.map((grp) => (
                <option key={grp} value={grp}>
                  {grp}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <label className="text-slate-500 font-medium">حالة الميزانية:</label>
            <select
              value={budgetStatusFilter}
              onChange={(e) => setBudgetStatusFilter(e.target.value as any)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:border-teal-500 focus:outline-none"
            >
              <option value="all">كافة الحالات</option>
              <option value="over">المتجاوزة للميزانية (عجز)</option>
              <option value="within">الملتزمة بالميزانية (وفر)</option>
            </select>
          </div>

          <div className="ms-auto text-slate-500 text-xs">
            عرض <span className="font-semibold text-slate-800">{filteredRows.length}</span> من أصل{" "}
            <span className="font-semibold text-slate-800">{categories.length}</span> بنداً
          </div>
        </div>

        {/* Printable Area */}
        <div
          ref={printRef}
          className="flex-1 overflow-y-auto p-6 sm:p-8 bg-white print:p-4 print:overflow-visible text-slate-900"
          dir="rtl"
        >
          {/* Clinic Official Header */}
          <div className="flex items-start justify-between border-b-2 border-slate-800 pb-5 mb-5">
            <div className="space-y-1">
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                {clinicName}
              </h1>
              <p className="text-xs text-slate-600 font-medium">
                قسم الإدارة المالية والمحاسبية • رقابة المصروفات التشغيلية والموازنات
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-[11px] text-slate-500">
                {clinicPhone && <span>الهاتف: {clinicPhone}</span>}
                {clinicAddress && <span>العنوان: {clinicAddress}</span>}
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="text-left space-y-0.5 text-xs">
                <div className="inline-block px-2.5 py-1 rounded bg-teal-50 border border-teal-200 text-teal-800 font-bold text-[11px]">
                  تقرير تدقيق معتمد
                </div>
                <div className="text-slate-500 font-mono text-[10px] pt-1">
                  المرجع: {auditDocRef}
                </div>
                <div className="text-slate-500 text-[10px]">
                  التاريخ: {today} | {reportTime}
                </div>
              </div>

              {qrCodeDataUrl ? (
                <img
                  src={qrCodeDataUrl}
                  alt="QR Code للتثبت الرقمي"
                  className="h-16 w-16 rounded border border-slate-200 p-0.5 shadow-sm"
                />
              ) : (
                <div className="h-16 w-16 rounded border border-slate-200 bg-slate-50 animate-pulse" />
              )}
            </div>
          </div>

          {/* Report Title & Scope */}
          <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 mb-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-bold text-slate-800">
                  كشف تدقيق بنود المصروفات التشغيلية والموازنة التقديرية
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  فترة التقرير: شهر <span className="font-bold text-slate-700">{month}</span> •
                  العملة المحاسبية: <span className="font-bold text-slate-700">{baseCurrency}</span>
                </p>
              </div>

              <div className="flex items-center gap-2 text-xs">
                <span className="rounded-md bg-white px-2.5 py-1 font-semibold text-slate-700 border border-slate-200 shadow-xs">
                  إجمالي البنود: {filteredRows.length}
                </span>
                {overBudgetCount > 0 ? (
                  <span className="rounded-md bg-rose-50 px-2.5 py-1 font-semibold text-rose-700 border border-rose-200 shadow-xs">
                    تجاوز الميزانية: {overBudgetCount}
                  </span>
                ) : (
                  <span className="rounded-md bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700 border border-emerald-200 shadow-xs">
                    ضمن الميزانية تماماً
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* KPI Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <span className="text-[11px] font-medium text-slate-500 block">إجمالي الميزانية التقديرية</span>
              <span className="text-sm sm:text-base font-bold text-slate-800 font-mono">
                {formatMoney(totalMonthlyBudget, baseCurrency)}
              </span>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <span className="text-[11px] font-medium text-slate-500 block">المنصرف الفعلي للشهر</span>
              <span className="text-sm sm:text-base font-bold text-slate-800 font-mono">
                {formatMoney(totalActualSpent, baseCurrency)}
              </span>
            </div>

            <div className={`rounded-lg border p-3 ${totalVariance < 0 ? 'bg-rose-50/70 border-rose-200' : 'bg-emerald-50/70 border-emerald-200'}`}>
              <span className="text-[11px] font-medium text-slate-500 block">
                {totalVariance < 0 ? "صافي العجز (تجاوز)" : "صافي الوفر المتبقي"}
              </span>
              <span className={`text-sm sm:text-base font-bold font-mono ${totalVariance < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                {formatMoney(Math.abs(totalVariance), baseCurrency)}
              </span>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <span className="text-[11px] font-medium text-slate-500 block">نسبة الاستهلاك الإجمالية</span>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`text-sm sm:text-base font-bold font-mono ${overallPercent > 100 ? 'text-rose-700' : 'text-slate-800'}`}>
                  {overallPercent}%
                </span>
                <span className="text-[10px] text-slate-500">
                  ({totalExpensesCount} حركة صرف)
                </span>
              </div>
            </div>
          </div>

          {/* Detailed Audit Table */}
          <div className="overflow-x-auto border border-slate-300 rounded-lg mb-6">
            <table className="w-full border-collapse text-right text-xs">
              <thead>
                <tr className="bg-slate-800 text-white font-medium">
                  <th className="p-2.5 text-center border-b border-slate-700 w-10">م</th>
                  <th className="p-2.5 border-b border-slate-700">بند المصروف التشغيلي</th>
                  <th className="p-2.5 border-b border-slate-700 text-center">المجموعة</th>
                  <th className="p-2.5 border-b border-slate-700">الحساب المحاسبي بدليل الحسابات</th>
                  <th className="p-2.5 border-b border-slate-700 text-left font-mono">الميزانية الشهرية</th>
                  <th className="p-2.5 border-b border-slate-700 text-left font-mono">المنصرف الفعلي</th>
                  <th className="p-2.5 border-b border-slate-700 text-left font-mono">الوفر / الفارق</th>
                  <th className="p-2.5 border-b border-slate-700 text-center font-mono">نسبة الانحراف</th>
                  <th className="p-2.5 border-b border-slate-700 text-center">الاستهلاك</th>
                  <th className="p-2.5 border-b border-slate-700 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-8 text-center text-slate-400">
                      لا توجد بنود مصروفات تطابق معايير الفرز المحددة.
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((cat, idx) => {
                    const isDeficit = cat.isOverBudget;
                    const catVariancePct = cat.monthlyBudgetMinor > 0
                      ? Math.round(((cat.actualSpentMinor - cat.monthlyBudgetMinor) / cat.monthlyBudgetMinor) * 100)
                      : cat.actualSpentMinor > 0 ? 100 : 0;
                    return (
                      <tr
                        key={cat.id}
                        className={`hover:bg-slate-50 transition-colors ${
                          idx % 2 === 1 ? "bg-slate-50/50" : "bg-white"
                        }`}
                      >
                        <td className="p-2.5 text-center font-mono text-slate-500 border-e border-slate-200">
                          {idx + 1}
                        </td>
                        <td className="p-2.5 font-bold text-slate-900 border-e border-slate-200">
                          <div>{cat.name}</div>
                          <div className="text-[10px] font-mono text-slate-400 font-normal">
                            كود: {cat.key}
                          </div>
                        </td>
                        <td className="p-2.5 text-center border-e border-slate-200">
                          <span className="inline-block px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-700 border border-slate-200">
                            {cat.categoryGroup}
                          </span>
                        </td>
                        <td className="p-2.5 border-e border-slate-200">
                          <div className="font-semibold text-slate-800">{cat.accountName}</div>
                          <div className="text-[10px] font-mono text-teal-700">
                            حساب رقم: {cat.accountCode}
                          </div>
                        </td>
                        <td className="p-2.5 text-left font-mono font-medium text-slate-800 border-e border-slate-200">
                          {formatMoney(cat.monthlyBudgetMinor, baseCurrency)}
                        </td>
                        <td className="p-2.5 text-left font-mono font-semibold text-slate-900 border-e border-slate-200">
                          {formatMoney(cat.actualSpentMinor, baseCurrency)}
                        </td>
                        <td
                          className={`p-2.5 text-left font-mono font-bold border-e border-slate-200 ${
                            cat.varianceMinor < 0 ? "text-rose-600 bg-rose-50/40" : "text-emerald-700"
                          }`}
                        >
                          {cat.varianceMinor < 0 ? "-" : "+"}
                          {formatMoney(Math.abs(cat.varianceMinor), baseCurrency)}
                        </td>
                        <td className="p-2.5 text-center font-mono border-e border-slate-200">
                          {cat.monthlyBudgetMinor === 0 && cat.actualSpentMinor === 0 ? (
                            <span className="text-slate-400">0%</span>
                          ) : cat.monthlyBudgetMinor === 0 && cat.actualSpentMinor > 0 ? (
                            <span className="font-bold text-rose-700">+100% ▲</span>
                          ) : catVariancePct > 0 ? (
                            <span className="font-bold text-rose-700">+{catVariancePct}% ▲</span>
                          ) : catVariancePct < 0 ? (
                            <span className="font-bold text-emerald-700">{catVariancePct}% ▼</span>
                          ) : (
                            <span className="text-slate-600 font-medium">0%</span>
                          )}
                        </td>
                        <td className="p-2.5 text-center border-e border-slate-200">
                          <span
                            className={`font-mono font-bold ${
                              cat.consumptionPercent > 100
                                ? "text-rose-700"
                                : cat.consumptionPercent > 80
                                ? "text-amber-600"
                                : "text-slate-700"
                            }`}
                          >
                            {cat.consumptionPercent}%
                          </span>
                        </td>
                        <td className="p-2.5 text-center">
                          {isDeficit ? (
                            <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800">
                              تجاوز الميزانية
                            </span>
                          ) : (
                            <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 text-emerald-800">
                              ضمن الميزانية
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
              <tfoot>
                <tr className="bg-slate-100 font-bold text-slate-900 border-t-2 border-slate-400">
                  <td colSpan={4} className="p-3 text-right">
                    الإجمالي العام للبـنود المعروضة ({filteredRows.length} بنداً)
                  </td>
                  <td className="p-3 text-left font-mono">
                    {formatMoney(totalMonthlyBudget, baseCurrency)}
                  </td>
                  <td className="p-3 text-left font-mono">
                    {formatMoney(totalActualSpent, baseCurrency)}
                  </td>
                  <td
                    className={`p-3 text-left font-mono ${
                      totalVariance < 0 ? "text-rose-700" : "text-emerald-700"
                    }`}
                  >
                    {totalVariance < 0 ? "-" : "+"}
                    {formatMoney(Math.abs(totalVariance), baseCurrency)}
                  </td>
                  <td className="p-3 text-center font-mono font-black">
                    {totalVariancePercent > 0 ? `+${totalVariancePercent}%` : `${totalVariancePercent}%`}
                  </td>
                  <td className="p-3 text-center font-mono">
                    {overallPercent}%
                  </td>
                  <td className="p-3 text-center text-[10px]">
                    {overBudgetCount > 0 ? `${overBudgetCount} عجز` : "مطابق"}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Audit Verification Statement */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3.5 mb-8 text-[11px] text-slate-600 space-y-1">
            <p className="font-semibold text-slate-800">
              إقرار التدقيق والترحيل المحاسبي:
            </p>
            <p>
              تخضع كافة سندات الصرف المسجلة على هذه البنود للترحيل الآلي إلى الحسابات المحاسبية المربوطة
              بدليل الحسابات الموحد لمركز عقلان لطب الأسنان. هذا التقرير يمثل المطابقة التقديرية والفعلية
              للشهر المالي المذكور، ويُعد وثيقة محاسبية معتمدة لأغراض الرقابة المالية وإعداد الموازنات التقديرية.
            </p>
          </div>

          {/* Official Signatures Section */}
          <div className="grid grid-cols-3 gap-6 pt-4 border-t border-slate-300 text-center text-xs">
            <div className="space-y-12">
              <p className="font-bold text-slate-700">إعداد المحاسب القانوني</p>
              <div className="border-t border-dashed border-slate-400 w-3/4 mx-auto pt-1 text-[11px] text-slate-500">
                التوقيع والختم
              </div>
            </div>

            <div className="space-y-12">
              <p className="font-bold text-slate-700">تدقيق المراجعة الداخلية</p>
              <div className="border-t border-dashed border-slate-400 w-3/4 mx-auto pt-1 text-[11px] text-slate-500">
                التوقيع والختم
              </div>
            </div>

            <div className="space-y-12">
              <p className="font-bold text-slate-700">اعتماد الإدارة المالية / المدير العام</p>
              <div className="border-t border-dashed border-slate-400 w-3/4 mx-auto pt-1 text-[11px] text-slate-500">
                التوقيع والختم الرسمي
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
