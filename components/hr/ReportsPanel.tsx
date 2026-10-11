"use client";

import { useCallback, useEffect, useState } from "react";
import { formatAmount, CURRENCY_SHORT, type Currency } from "@/lib/money";

interface HrReportData {
  staffSummary: {
    totalStaff: number;
    activeStaff: number;
    departmentBreakdown: Record<string, number>;
  };
  expiringContracts: {
    id: string;
    staffId: string;
    staffName: string;
    contractNumber: string;
    endDate: string;
    daysRemaining: number;
  }[];
  attendanceExceptions: {
    date: string;
    latePunchesCount: number;
    incompletePunchesCount: number;
    totalOvertimeHours: number;
  };
  leaveSummary: {
    totalApprovedLeaves: number;
    pendingRequestsCount: number;
    consumedDaysThisYear: number;
  };
  payrollSummaryByCurrency: {
    currency: string;
    totalNetDue: number;
    totalDisbursed: number;
    totalRemainingPayable: number;
  }[];
}

export function HrReportsPanel() {
  const [report, setReport] = useState<HrReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadReport = useCallback(async () => {
    try {
      const res = await fetch("/api/hr/reports", { cache: "no-store" });
      if (!res.ok) throw new Error("تعذّر استخراج تقارير الموارد البشرية.");
      const data = await res.json();
      setReport(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message || "حدث خطأ أثناء تحميل التقارير.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  if (loading) {
    return <div className="py-12 text-center text-sm text-navy-500">جاري استخراج بيانات التقارير...</div>;
  }

  if (error || !report) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
        {error || "تعذّر تحميل التقارير."}
      </div>
    );
  }

  return (
    <section aria-label="تقارير الموارد البشرية الشاملة" className="space-y-6">
      {/* 1. Executive Summary Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-navy-100 bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold text-navy-500">إجمالي الطاقم</div>
          <div className="mt-1 text-2xl font-bold text-navy-900">{report.staffSummary.totalStaff}</div>
          <div className="text-xs text-emerald-700">{report.staffSummary.activeStaff} نشط على رأس العمل</div>
        </div>

        <div className="rounded-2xl border border-amber-100 bg-amber-50/50 p-4 shadow-sm">
          <div className="text-xs font-semibold text-amber-800">عقود تنتهي قريباً (30 يوماً)</div>
          <div className="mt-1 text-2xl font-bold text-amber-900">{report.expiringContracts.length}</div>
          <div className="text-xs text-amber-700">تتطلب تجديداً أو إجراءً</div>
        </div>

        <div className="rounded-2xl border border-navy-100 bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold text-navy-500">استثناءات الدوام اليوم</div>
          <div className="mt-1 text-2xl font-bold text-navy-900">
            {report.attendanceExceptions.incompletePunchesCount}
          </div>
          <div className="text-xs text-rose-600">
            بصمة ناقصة ({report.attendanceExceptions.latePunchesCount} تأخير)
          </div>
        </div>

        <div className="rounded-2xl border border-navy-100 bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold text-navy-500">طلبات إجازة قيد الانتظار</div>
          <div className="mt-1 text-2xl font-bold text-navy-900">{report.leaveSummary.pendingRequestsCount}</div>
          <div className="text-xs text-navy-500">إجمالي الأيام المستهلكة: {report.leaveSummary.consumedDaysThisYear}</div>
        </div>
      </div>

      {/* 2. Expiring Contracts Table */}
      <div className="rounded-2xl border border-navy-100 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-bold text-navy-900">العقود التي تنتهي خلال 30 يوماً</h3>
          <span className="rounded-lg bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
            {report.expiringContracts.length} عقد
          </span>
        </div>

        {report.expiringContracts.length === 0 ? (
          <div className="p-4 text-center text-xs text-navy-400">لا توجد عقود تقترب من الانتهاء حالياً.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="border-b border-navy-100 bg-navy-50/50 font-semibold text-navy-600">
                <tr>
                  <th className="px-3 py-2">الموظف</th>
                  <th className="px-3 py-2">رقم العقد</th>
                  <th className="px-3 py-2">تاريخ الانتهاء</th>
                  <th className="px-3 py-2">الأيام المتبقية</th>
                  <th className="px-3 py-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-100">
                {report.expiringContracts.map((c) => (
                  <tr key={c.id}>
                    <td className="px-3 py-2 font-medium text-navy-900">{c.staffName}</td>
                    <td className="px-3 py-2 font-mono text-navy-700">{c.contractNumber}</td>
                    <td className="px-3 py-2 text-navy-600">{c.endDate}</td>
                    <td className="px-3 py-2 font-bold text-amber-700">{c.daysRemaining} يوم</td>
                    <td className="px-3 py-2 text-center">
                      <a
                        href={`/print/hr/contracts/${c.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg border border-navy-200 px-2 py-1 text-navy-700 hover:bg-navy-50"
                      >
                        معاينة
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 3. Multi-Currency Payroll Liabilities Report */}
      <div className="rounded-2xl border border-navy-100 bg-white p-4 shadow-sm">
        <h3 className="mb-3 font-bold text-navy-900">ملخص الرواتب والذمم الدائنة (مفصول حسب العملة)</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {report.payrollSummaryByCurrency.map((p) => {
            const curr = p.currency as Currency;
            return (
              <div key={p.currency} className="rounded-xl border border-navy-100 bg-navy-50/40 p-4">
                <div className="flex items-center justify-between border-b border-navy-100 pb-2">
                  <span className="font-bold text-navy-900">عملة {p.currency}</span>
                  <span className="text-xs font-semibold text-navy-500">
                    {CURRENCY_SHORT[curr] || p.currency}
                  </span>
                </div>
                <div className="mt-3 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-navy-600">إجمالي المستحق (الصافي):</span>
                    <span className="font-mono font-bold text-navy-900">{formatAmount(p.totalNetDue, curr)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-navy-600">إجمالي المصروف (نقداً):</span>
                    <span className="font-mono font-bold text-emerald-800">{formatAmount(p.totalDisbursed, curr)}</span>
                  </div>
                  <div className="flex justify-between border-t border-navy-100 pt-2 font-bold">
                    <span className="text-rose-700">المتبقي كذمة دائنة:</span>
                    <span className="font-mono text-rose-800">{formatAmount(p.totalRemainingPayable, curr)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
