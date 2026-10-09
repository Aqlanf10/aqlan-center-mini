"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import {
  HR_PAYROLL_RUN_STATUS_LABELS,
  HR_PAYROLL_ITEM_STATUS_LABELS,
  type HrCurrency,
  type HrPayrollRunStatus,
} from "@/lib/hr-payroll-shared";
import { CURRENCIES, CURRENCY_SHORT, formatAmount, type Currency } from "@/lib/money";

interface PayrollPeriodItem {
  id: string;
  periodMonth: string;
  startDate: string;
  endDate: string;
  status: "open" | "closed";
}

interface PayrollRunItem {
  id: string;
  periodId: string;
  currency: HrCurrency;
  status: HrPayrollRunStatus;
  totalBase: number;
  totalAllowances: number;
  totalDeductions: number;
  totalCommissions: number;
  totalOvertime: number;
  totalNet: number;
  approvedBy: string | null;
  approvedAt: string | null;
  items?: PayrollItemDetail[];
}

interface PayrollItemDetail {
  id: string;
  payrollRunId: string;
  staffId: string;
  staffName?: string;
  jobTitle?: string;
  baseSalary: number;
  allowances: number;
  deductions: number;
  commissionAmount: number;
  overtimeAmount: number;
  netSalary: number;
  disbursedAmount: number;
  remainingAmount: number;
  status: string;
  commissionDetails?: any;
}

export function HrPayrollPanel() {
  const [periods, setPeriods] = useState<PayrollPeriodItem[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<string>("");
  const [selectedCurrency, setSelectedCurrency] = useState<HrCurrency>("YER");
  const [runs, setRuns] = useState<PayrollRunItem[]>([]);
  const [activeRun, setActiveRun] = useState<PayrollRunItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modals
  const [periodModalOpen, setPeriodModalOpen] = useState(false);
  const [newPeriodMonth, setNewPeriodMonth] = useState(new Date().toISOString().slice(0, 7));
  const [disburseModalOpen, setDisburseModalOpen] = useState(false);
  const [disburseItem, setDisburseItem] = useState<PayrollItemDetail | null>(null);
  const [disburseAmount, setDisburseAmount] = useState<string>("");
  const [disburseMethod, setDisburseMethod] = useState("cash");
  const [disburseRef, setDisburseRef] = useState("");
  const [disburseNotes, setDisburseNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadPeriods = useCallback(async () => {
    try {
      const res = await fetch("/api/hr/payroll/periods", { cache: "no-store" });
      if (!res.ok) throw new Error("تعذّر تحميل فترات المسير.");
      const data = await res.json();
      setPeriods(data);
      if (data.length > 0 && !selectedPeriod) {
        setSelectedPeriod(data[0].id);
      }
      setError(null);
    } catch (err: any) {
      setError(err?.message || "حدث خطأ أثناء تحميل الفترات.");
    } finally {
      setLoading(false);
    }
  }, [selectedPeriod]);

  const loadRuns = useCallback(async () => {
    if (!selectedPeriod) return;
    try {
      const res = await fetch(`/api/hr/payroll/runs?periodId=${selectedPeriod}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setRuns(data);
        const matching = data.find((r: PayrollRunItem) => r.currency === selectedCurrency);
        if (matching) {
          const detailRes = await fetch(`/api/hr/payroll/runs?id=${matching.id}`, { cache: "no-store" });
          if (detailRes.ok) {
            const detailData = await detailRes.json();
            setActiveRun(detailData);
          } else {
            setActiveRun(matching);
          }
        } else {
          setActiveRun(null);
        }
      }
    } catch {
      // Ignored
    }
  }, [selectedPeriod, selectedCurrency]);

  useEffect(() => {
    void loadPeriods();
  }, [loadPeriods]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const handleOpenPeriod = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/hr/payroll/periods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodMonth: newPeriodMonth }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر فتح الفترة.");
      }
      setPeriodModalOpen(false);
      void loadPeriods();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء فتح الفترة.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCalculateRun = async () => {
    if (!selectedPeriod) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/hr/payroll/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "calculate",
          periodId: selectedPeriod,
          currency: selectedCurrency,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر احتساب المسير.");
      }
      void loadRuns();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء احتساب المسير.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleApproveRun = async () => {
    if (!activeRun) return;
    if (!confirm("هل أنت متأكد من اعتماد هذا المسير؟ سيتم تسجيل الالتزام المالي في الذمم الدائنة.")) {
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/hr/payroll/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          runId: activeRun.id,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر اعتماد المسير.");
      }
      alert("تم اعتماد مسير الرواتب وترحيله للمالية بنجاح.");
      void loadRuns();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء الاعتماد.");
    } finally {
      setSubmitting(false);
    }
  };

  const openDisburseForItem = (item: PayrollItemDetail) => {
    setDisburseItem(item);
    setDisburseAmount(String(item.remainingAmount || item.netSalary));
    setDisburseModalOpen(true);
  };

  const handleDisburse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!disburseItem) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/hr/payroll/disburse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: disburseItem.id,
          amount: parseFloat(disburseAmount) || 0,
          paymentMethod: disburseMethod,
          referenceNumber: disburseRef || null,
          notes: disburseNotes || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر تنفيذ الصرف.");
      }
      setDisburseModalOpen(false);
      setDisburseItem(null);
      void loadRuns();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء عملية الصرف.");
    } finally {
      setSubmitting(false);
    }
  };

  const currentPeriodObj = periods.find((p) => p.id === selectedPeriod);

  return (
    <section aria-label="إدارة المسير والصرف" className="space-y-4">
      {/* Top Header: Period & Currency */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-navy-100 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-navy-500">فترة المسير:</label>
            <div className="flex items-center gap-2">
              <select
                value={selectedPeriod}
                onChange={(e) => setSelectedPeriod(e.target.value)}
                className="rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm font-semibold text-navy-800 outline-none"
              >
                {periods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.periodMonth} {p.status === "closed" ? "(مغلقة)" : "(مفتوحة)"}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setPeriodModalOpen(true)}
                className="rounded-xl border border-navy-200 bg-navy-50 px-3 py-2 text-xs font-semibold text-navy-700 hover:bg-navy-100"
              >
                + شهر جديد
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-navy-500">العملة (عزل تام):</label>
            <div className="flex gap-1.5">
              {CURRENCIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setSelectedCurrency(c as HrCurrency)}
                  className={`rounded-xl px-3 py-1.5 text-xs font-bold transition ${
                    selectedCurrency === c
                      ? "bg-navy-800 text-white shadow-sm"
                      : "border border-navy-200 bg-white text-navy-700 hover:bg-navy-50"
                  }`}
                >
                  {c} ({CURRENCY_SHORT[c]})
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Calculate & Approve Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={handleCalculateRun}
            className="flex items-center gap-1.5 rounded-xl bg-navy-800 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-navy-700 disabled:opacity-50"
          >
            <span>⚡</span>
            <span>احتساب المسير ({selectedCurrency})</span>
          </button>

          {activeRun && activeRun.status === "draft" && (
            <button
              type="button"
              disabled={submitting}
              onClick={handleApproveRun}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50"
            >
              <span>✓</span>
              <span>اعتماد وترحيل للمالية</span>
            </button>
          )}

          {activeRun && (
            <a
              href={`/print/hr/payroll/${activeRun.id}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-navy-200 bg-white px-3 py-2.5 text-xs font-semibold text-navy-700 hover:bg-navy-50"
            >
              طباعة الكشف
            </a>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Summary Cards */}
      {activeRun ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <div className="rounded-2xl border border-navy-100 bg-white p-3 shadow-sm">
            <div className="text-xs font-semibold text-navy-500">الراتب الأساسي</div>
            <div className="mt-1 font-mono text-lg font-bold text-navy-900">
              {formatAmount(activeRun.totalBase, activeRun.currency as Currency)}
            </div>
          </div>
          <div className="rounded-2xl border border-navy-100 bg-white p-3 shadow-sm">
            <div className="text-xs font-semibold text-navy-500">البدلات</div>
            <div className="mt-1 font-mono text-lg font-bold text-navy-900">
              {formatAmount(activeRun.totalAllowances, activeRun.currency as Currency)}
            </div>
          </div>
          <div className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-3 shadow-sm">
            <div className="text-xs font-semibold text-emerald-700">نسب الأطباء</div>
            <div className="mt-1 font-mono text-lg font-bold text-emerald-800">
              {formatAmount(activeRun.totalCommissions, activeRun.currency as Currency)}
            </div>
          </div>
          <div className="rounded-2xl border border-navy-100 bg-white p-3 shadow-sm">
            <div className="text-xs font-semibold text-navy-500">الإضافي</div>
            <div className="mt-1 font-mono text-lg font-bold text-navy-900">
              {formatAmount(activeRun.totalOvertime, activeRun.currency as Currency)}
            </div>
          </div>
          <div className="rounded-2xl border border-rose-100 bg-rose-50/50 p-3 shadow-sm">
            <div className="text-xs font-semibold text-rose-700">الخصميات والغياب</div>
            <div className="mt-1 font-mono text-lg font-bold text-rose-800">
              {formatAmount(activeRun.totalDeductions, activeRun.currency as Currency)}
            </div>
          </div>
          <div className="rounded-2xl border border-navy-800 bg-navy-800 p-3 text-white shadow-sm">
            <div className="text-xs font-semibold text-navy-200">الصافي المستحق</div>
            <div className="mt-1 font-mono text-lg font-bold text-white">
              {formatAmount(activeRun.totalNet, activeRun.currency as Currency)}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-navy-200 bg-white p-8 text-center text-sm text-navy-500">
          لم يتم احتساب مسير رواتب لعملة {selectedCurrency} في هذا الشهر بعد. اضغط على «احتساب المسير» للبدء.
        </div>
      )}

      {/* Breakdown Items Table */}
      {activeRun && activeRun.items && activeRun.items.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-navy-100 bg-white shadow-sm">
          <table className="w-full text-right text-sm">
            <thead className="border-b border-navy-100 bg-navy-50/60 text-xs font-semibold text-navy-600">
              <tr>
                <th className="px-4 py-3">الموظف</th>
                <th className="px-4 py-3">الأساسي</th>
                <th className="px-4 py-3">البدلات</th>
                <th className="px-4 py-3">نسبة طبيب</th>
                <th className="px-4 py-3">إضافي</th>
                <th className="px-4 py-3">خصم</th>
                <th className="px-4 py-3">الصافي</th>
                <th className="px-4 py-3">المصروف</th>
                <th className="px-4 py-3">الحالة</th>
                <th className="px-4 py-3 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-100 font-mono text-xs">
              {activeRun.items.map((item) => {
                const hasCommission = item.commissionAmount > 0;
                const isPaid = item.status === "paid";

                return (
                  <tr key={item.id} className="transition hover:bg-navy-50/40">
                    <td className="px-4 py-3 font-sans font-semibold text-navy-900">
                      <div>{item.staffName || `موظف #${item.staffId}`}</div>
                      {item.jobTitle && <div className="text-xs text-navy-500">{item.jobTitle}</div>}
                    </td>
                    <td className="px-4 py-3">{formatAmount(item.baseSalary, activeRun.currency as Currency)}</td>
                    <td className="px-4 py-3">{formatAmount(item.allowances, activeRun.currency as Currency)}</td>
                    <td className="px-4 py-3">
                      {hasCommission ? (
                        <span className="font-bold text-emerald-700">
                          {formatAmount(item.commissionAmount, activeRun.currency as Currency)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {item.overtimeAmount > 0 ? (
                        formatAmount(item.overtimeAmount, activeRun.currency as Currency)
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-rose-700">
                      {item.deductions > 0 ? (
                        `-${formatAmount(item.deductions, activeRun.currency as Currency)}`
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 font-bold text-navy-900">
                      {formatAmount(item.netSalary, activeRun.currency as Currency)}
                    </td>
                    <td className="px-4 py-3 text-emerald-800">
                      {formatAmount(item.disbursedAmount, activeRun.currency as Currency)}
                    </td>
                    <td className="px-4 py-3 font-sans">
                      <span
                        className={`inline-block rounded-lg px-2 py-0.5 text-xs font-semibold ${
                          isPaid
                            ? "bg-emerald-100 text-emerald-800"
                            : item.status === "approved"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {HR_PAYROLL_ITEM_STATUS_LABELS[item.status as any] || item.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-sans text-center">
                      {!isPaid && activeRun.status !== "draft" && (
                        <button
                          type="button"
                          onClick={() => openDisburseForItem(item)}
                          className="rounded-lg bg-navy-800 px-2.5 py-1 text-xs font-semibold text-white hover:bg-navy-700"
                        >
                          صرف
                        </button>
                      )}
                      {isPaid && <span className="text-xs text-emerald-700 font-bold">مصروف كامل</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Open Period Modal */}
      {periodModalOpen && (
        <Modal open={periodModalOpen} onClose={() => setPeriodModalOpen(false)}>
          <form onSubmit={handleOpenPeriod} className="space-y-3">
            <h3 className="text-base font-bold text-navy-900">فتح فترة مسير رواتب جديدة</h3>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">الشهر (YYYY-MM) *</label>
              <input
                required
                type="month"
                value={newPeriodMonth}
                onChange={(e) => setNewPeriodMonth(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPeriodModalOpen(false)}
                className="rounded-xl border border-navy-200 px-3 py-1.5 text-xs font-semibold text-navy-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-semibold text-white"
              >
                {submitting ? "جاري الفتح..." : "فتح الفترة"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Disburse Modal */}
      {disburseModalOpen && disburseItem && activeRun && (
        <Modal open={disburseModalOpen} onClose={() => setDisburseModalOpen(false)}>
          <form onSubmit={handleDisburse} className="space-y-3">
            <h3 className="text-base font-bold text-navy-900">صرف مستحق راتب</h3>
            <div className="rounded-xl bg-navy-50/50 p-2.5 text-xs text-navy-700">
              الموظف: <span className="font-semibold">{disburseItem.staffName}</span> | المتبقي:{" "}
              <span className="font-semibold">
                {formatAmount(disburseItem.remainingAmount || disburseItem.netSalary, activeRun.currency as Currency)}{" "}
                {activeRun.currency}
              </span>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">المبلغ المصروف *</label>
              <input
                required
                type="number"
                step="any"
                value={disburseAmount}
                onChange={(e) => setDisburseAmount(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none font-mono"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">طريقة الدفع</label>
                <select
                  value={disburseMethod}
                  onChange={(e) => setDisburseMethod(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                >
                  <option value="cash">نقداً (الصندوق)</option>
                  <option value="bank_transfer">تحويل بنكي</option>
                  <option value="cheque">شيك</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">رقم السند / المرجع</label>
                <input
                  type="text"
                  value={disburseRef}
                  onChange={(e) => setDisburseRef(e.target.value)}
                  placeholder="مثال: سند صرف #120"
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">ملاحظات الصرف</label>
              <input
                type="text"
                value={disburseNotes}
                onChange={(e) => setDisburseNotes(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDisburseModalOpen(false)}
                className="rounded-xl border border-navy-200 px-3 py-1.5 text-xs font-semibold text-navy-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-semibold text-white"
              >
                {submitting ? "جاري الصرف..." : "تأكيد الصرف وتسجيل المصروف"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
