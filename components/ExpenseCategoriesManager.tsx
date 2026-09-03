"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";
import { Icon } from "@/components/Icon";
import { useSetting } from "@/components/SettingsProvider";
import { formatMoney, MINOR_UNITS, type Currency } from "@/lib/money";
import { exportExpenseBudgetToExcel } from "@/lib/expenseBudgetExport";
import { ExpenseBudgetReportModal } from "@/components/ExpenseBudgetReportModal";
import type { ExpenseCategoryDTO, ExpenseBudgetSummary } from "@/lib/db";

interface StandardAccount {
  code: string;
  name: string;
}

const SETTINGS_LINKS = [
  { href: "/settings", label: "عام" },
  { href: "/settings/finance-expenses", label: "بنود المصروفات والميزانيات", current: true },
  { href: "/settings/laboratories", label: "المختبرات" },
  { href: "/settings/lab-services", label: "دليل الخدمات" },
  { href: "/settings/lab-pricing", label: "جدول التسعير" },
  { href: "/settings/users", label: "المستخدمون والصلاحيات" },
  { href: "/settings/audit", label: "سجل التدقيق" },
  { href: "/settings/export", label: "النسخ والتصدير" },
  { href: "/settings/ai", label: "الذكاء الاصطناعي" },
];

export function ExpenseCategoriesManager({
  headerMode = "finance",
}: {
  headerMode?: "finance" | "settings";
}) {
  const [categories, setCategories] = useState<ExpenseCategoryDTO[]>([]);
  const [summary, setSummary] = useState<ExpenseBudgetSummary | null>(null);
  const [standardAccounts, setStandardAccounts] = useState<StandardAccount[]>([]);
  const [baseCurrency, setBaseCurrency] = useState<Currency>("YER");
  // اسم المركز للتقرير والتصدير من الإعدادات مباشرة: النسخة المكتوبة هنا
  // كانت تنشر اسمًا خاطئًا في كل تقرير يُطبع أو يُصدَّر من هذه الشاشة.
  const clinicName = useSetting("clinic.name");
  const clinicPhone = useSetting("clinic.phone");
  const clinicAddress = useSetting("clinic.address");

  // Filter & Search states
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [includeInactive, setIncludeInactive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<string>("all");
  const [budgetFilter, setBudgetFilter] = useState<"all" | "over" | "within">("all");

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [savingBatch, setSavingBatch] = useState(false);

  // Modals
  const [showReportModal, setShowReportModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<ExpenseCategoryDTO | null>(null);

  // Local modifications for inline editing
  const [draftEdits, setDraftEdits] = useState<
    Record<
      number,
      {
        accountCode?: string;
        monthlyBudgetMinor?: number;
        isActive?: boolean;
        autoPostJournal?: boolean;
      }
    >
  >({});

  const [syncingAccounting, setSyncingAccounting] = useState(false);

  const hasPendingChanges = Object.keys(draftEdits).length > 0;

  // Load data from API
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (selectedMonth) query.set("month", selectedMonth);
      if (includeInactive) query.set("includeInactive", "true");

      const res = await fetch(`/api/finance/expense-categories?${query.toString()}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "تعذّر تحميل البيانات.");

      setCategories(data.categories || []);
      setSummary(data.summary || null);
      if (data.standardExpenseAccounts) setStandardAccounts(data.standardExpenseAccounts);
      if (data.baseCurrency) setBaseCurrency(data.baseCurrency);
      setDraftEdits({});
    } catch (err: any) {
      setError(err.message || "حدث خطأ أثناء تحميل بنود المصروفات.");
    } finally {
      setLoading(false);
    }
  }, [selectedMonth, includeInactive]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle inline modification
  const handleDraftChange = (
    id: number,
    field: "accountCode" | "monthlyBudgetMinor" | "isActive" | "autoPostJournal",
    value: any,
  ) => {
    setDraftEdits((prev) => {
      const current = prev[id] || {};
      return {
        ...prev,
        [id]: {
          ...current,
          [field]: value,
        },
      };
    });
  };

  // Sync and ensure auto-posting accounting linkage for all categories
  const handleSyncAccounting = async () => {
    setSyncingAccounting(true);
    setError(null);
    try {
      const res = await fetch("/api/finance/expense-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync_accounting" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "تعذّر ضبط الربط المحاسبي.");

      setSuccessMsg(
        data.message || "تم ضبط وتأكيد الربط المحاسبي التلقائي لكافة البنود التشغيلية بنجاح."
      );
      setTimeout(() => setSuccessMsg(null), 5000);
      await loadData();
    } catch (err: any) {
      setError(err.message || "حدث خطأ أثناء ضبط الربط المحاسبي.");
    } finally {
      setSyncingAccounting(false);
    }
  };

  // Batch save pending changes
  const handleSaveBatch = async () => {
    if (!hasPendingChanges) return;
    setSavingBatch(true);
    setError(null);
    try {
      const updates = Object.entries(draftEdits).map(([idStr, changes]) => ({
        id: Number(idStr),
        ...changes,
      }));

      const res = await fetch("/api/finance/expense-categories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "فشل حفظ التعديلات.");

      setSuccessMsg(`تم حفظ تعديلات ${data.updatedCount || updates.length} بنداً بنجاح.`);
      setTimeout(() => setSuccessMsg(null), 3000);
      await loadData();
    } catch (err: any) {
      setError(err.message || "تعذّر حفظ التغييرات.");
    } finally {
      setSavingBatch(false);
    }
  };

  // Discard draft edits
  const handleDiscardBatch = () => {
    setDraftEdits({});
  };

  // Delete / Deactivate category
  const handleDeleteCategory = async (cat: ExpenseCategoryDTO) => {
    const isPermanent = !cat.isSystem && cat.expensesCount === 0;
    const confirmMsg = isPermanent
      ? `هل أنت متأكد من حذف بند المصروف (${cat.name}) نهائياً؟`
      : `هل أنت متأكد من تعطيل بند المصروف (${cat.name})؟ لن يظهر في سندات الصرف الجديدة.`;

    if (!confirm(confirmMsg)) return;

    try {
      const res = await fetch(`/api/finance/expense-categories?id=${cat.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "تعذّر الحذف.");

      setSuccessMsg(
        data.deactivated
          ? `تم تعطيل بند المصروف (${cat.name}) بنجاح.`
          : `تم حذف بند المصروف (${cat.name}) نهائياً.`
      );
      setTimeout(() => setSuccessMsg(null), 3000);
      await loadData();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء محاولة الحذف.");
    }
  };

  // Unique groups
  const groups = useMemo(() => {
    const set = new Set<string>();
    categories.forEach((c) => {
      if (c.categoryGroup) set.add(c.categoryGroup);
    });
    return Array.from(set);
  }, [categories]);

  // Filtered categories
  const filteredCategories = useMemo(() => {
    return categories.filter((cat) => {
      // Search
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchesName = cat.name.toLowerCase().includes(q);
        const matchesKey = cat.key.toLowerCase().includes(q);
        const matchesCode = cat.accountCode.toLowerCase().includes(q);
        const matchesAccount = cat.accountName.toLowerCase().includes(q);
        const matchesGroup = cat.categoryGroup.toLowerCase().includes(q);
        if (!matchesName && !matchesKey && !matchesCode && !matchesAccount && !matchesGroup) {
          return false;
        }
      }

      // Group filter
      if (selectedGroup !== "all" && cat.categoryGroup !== selectedGroup) {
        return false;
      }

      // Budget filter
      if (budgetFilter === "over" && !cat.isOverBudget) return false;
      if (budgetFilter === "within" && cat.isOverBudget) return false;

      return true;
    });
  }, [categories, searchQuery, selectedGroup, budgetFilter]);

  // Current effective values considering draft edits
  const getEffectiveCategory = (cat: ExpenseCategoryDTO) => {
    const draft = draftEdits[cat.id];
    const monthlyBudgetMinor =
      draft?.monthlyBudgetMinor !== undefined ? draft.monthlyBudgetMinor : cat.monthlyBudgetMinor;
    const accountCode = draft?.accountCode !== undefined ? draft.accountCode : cat.accountCode;
    const isActive = draft?.isActive !== undefined ? draft.isActive : cat.isActive;
    const autoPostJournal =
      draft?.autoPostJournal !== undefined ? draft.autoPostJournal : (cat.autoPostJournal !== false);
    const varianceMinor = monthlyBudgetMinor - cat.actualSpentMinor;
    const consumptionPercent =
      monthlyBudgetMinor > 0 ? Math.round((cat.actualSpentMinor / monthlyBudgetMinor) * 100) : 0;
    const isOverBudget = monthlyBudgetMinor > 0 && cat.actualSpentMinor > monthlyBudgetMinor;

    // نسبة الانحراف اللحظية: ((الفعلي - التقديري) ÷ التقديري) × 100
    let variancePercent = 0;
    if (monthlyBudgetMinor > 0) {
      variancePercent = Math.round(((cat.actualSpentMinor - monthlyBudgetMinor) / monthlyBudgetMinor) * 100);
    } else if (cat.actualSpentMinor > 0) {
      variancePercent = 100;
    } else {
      variancePercent = 0;
    }

    return {
      ...cat,
      monthlyBudgetMinor,
      accountCode,
      isActive,
      autoPostJournal,
      varianceMinor,
      consumptionPercent,
      variancePercent,
      isOverBudget,
    };
  };

  return (
    <main className="mx-auto max-w-7xl p-4 sm:p-6 pb-28 text-slate-900" dir="rtl">
      {/* Page Header */}
      <PageHeader
        title="إعدادات الربط المحاسبي لبنود المصروفات"
        subtitle="ربط كل بند من بنود المصروفات (كالكهرباء، الصيانة، الإيجار) بحسابه المقابل في دليل الحسابات لضمان الترحيل التلقائي للقيود المالية"
        links={headerMode === "settings" ? SETTINGS_LINKS : financeLinks("/finance/expense-categories")}
      />

      {/* Action Toolbar & Month Selector */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="flex flex-wrap items-center gap-3">
          {/* Month Picker */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-700">شهر الميزانية:</span>
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="rounded-xl border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-800 shadow-2xs focus:border-teal-500 focus:bg-white focus:outline-none"
            />
          </div>

          {/* Include Inactive Toggle */}
          <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-100 transition">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="h-4 w-4 rounded text-teal-600 focus:ring-teal-500"
            />
            <span>إظهار البنود المعطّلة</span>
          </label>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-teal-600 px-4 py-2 text-xs font-black text-white shadow-sm hover:bg-teal-700 transition"
          >
            <Icon name="plus" className="h-4 w-4" />
            إضافة بند مصروف جديد
          </button>

          <button
            onClick={handleSyncAccounting}
            disabled={syncingAccounting}
            title="فحص وضبط الربط المحاسبي المعياري لبنود المصروفات لضمان ترحيلها تلقائياً لدليل الحسابات"
            className="inline-flex items-center gap-2 rounded-xl border border-indigo-300 bg-indigo-50/90 px-3.5 py-2 text-xs font-bold text-indigo-900 shadow-2xs hover:bg-indigo-100 transition disabled:opacity-60"
          >
            <Icon name="refresh" className={`h-4 w-4 text-indigo-700 ${syncingAccounting ? "animate-spin" : ""}`} />
            {syncingAccounting ? "جاري الضبط والمزامنة..." : "ضبط وتأكيد الربط المحاسبي التلقائي"}
          </button>

          <button
            onClick={() => setShowReportModal(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-teal-300 bg-teal-50/80 px-3.5 py-2 text-xs font-bold text-teal-800 shadow-2xs hover:bg-teal-100 transition"
          >
            <Icon name="file" className="h-4 w-4 text-teal-700" />
            تقرير وتدقيق الميزانية (PDF)
          </button>

          <button
            onClick={() => {
              if (summary) {
                exportExpenseBudgetToExcel({
                  clinicName,
                  clinicPhone,
                  clinicAddress,
                  baseCurrency,
                  categories: filteredCategories,
                  summary,
                  month: selectedMonth,
                });
              }
            }}
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50/80 px-3.5 py-2 text-xs font-bold text-emerald-800 shadow-2xs hover:bg-emerald-100 transition"
          >
            <Icon name="download" className="h-4 w-4 text-emerald-700" />
            تصدير Excel
          </button>
        </div>
      </div>

      {/* Accounting Linkage & Auto-Posting Confirmation Banner */}
      <div className="mb-6 rounded-2xl border border-emerald-200 bg-gradient-to-r from-emerald-50/90 via-teal-50/50 to-white p-4 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-xs">
              <Icon name="double-check" className="h-5 w-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-black text-slate-900">
                  إعدادات الربط المحاسبي والترحيل التلقائي لدليل الحسابات (مفعّلة ومربوطة)
                </h4>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 border border-emerald-300 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 animate-pulse" />
                  ترحيل فوري لدفتر اليومية العامة
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-600 leading-relaxed max-w-4xl">
                كافة بنود المصروفات التشغيلية (الكهرباء، الصيانة، الإيجار، مستلزمات العيادة، الاتصالات، إلخ) مربوطة تلقائياً بحساباتها في دليل الحسابات. بمجرد تحرير أي سند صرف، يتم توليد قيد اليومية آلياً (مدين: حـ/ بند المصروف التشغيلي، دائن: حـ/ الصندوق أو البنك) ويُرحّل مباشرة إلى دفتر اليومية العامة، الأستاذ، ميزان المراجعة، وقائمة الدخل دون أي تدخل يدوي.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleSyncAccounting}
              disabled={syncingAccounting}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-white hover:bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800 shadow-2xs transition"
            >
              <Icon name="refresh" className={`h-3.5 w-3.5 text-emerald-700 ${syncingAccounting ? "animate-spin" : ""}`} />
              <span>تأكيد المزامنة الآلية</span>
            </button>
          </div>
        </div>
      </div>

      {/* Success / Error Alerts */}
      {successMsg && (
        <div className="mb-4 rounded-xl border border-emerald-300 bg-emerald-50 p-3.5 text-xs font-bold text-emerald-800 flex items-center gap-2 shadow-sm">
          <Icon name="check" className="h-5 w-5 text-emerald-600 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-xs font-bold text-rose-800 flex items-center gap-2 shadow-sm">
          <Icon name="alert" className="h-5 w-5 text-rose-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* KPI Cards */}
      {summary && (
        <section className="mb-6 grid grid-cols-2 lg:grid-cols-5 gap-3.5">
          {/* Total Budget */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-500">
              <span className="text-xs font-semibold">ميزانية الشهر التقديرية</span>
              <span className="rounded-lg bg-teal-50 p-1.5 text-teal-700">
                <Icon name="wallet" className="h-4 w-4" />
              </span>
            </div>
            <div className="mt-2">
              <div className="text-lg sm:text-xl font-black text-slate-900 font-mono">
                {formatMoney(summary.totalMonthlyBudgetMinor, baseCurrency)}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {summary.activeCategories} بنداً تشغيلياً نشطاً
              </div>
            </div>
          </div>

          {/* Actual Spent */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-500">
              <span className="text-xs font-semibold">المنصرف الفعلي بالشهر</span>
              <span className="rounded-lg bg-blue-50 p-1.5 text-blue-700">
                <Icon name="wallet" className="h-4 w-4" />
              </span>
            </div>
            <div className="mt-2">
              <div className="text-lg sm:text-xl font-black text-slate-900 font-mono">
                {formatMoney(summary.totalActualSpentMinor, baseCurrency)}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                إجمالي {summary.totalExpensesCount} حركة صرف
              </div>
            </div>
          </div>

          {/* Variance / Surplus or Deficit */}
          <div
            className={`rounded-2xl border p-4 shadow-xs flex flex-col justify-between ${
              summary.totalVarianceMinor < 0
                ? "border-rose-200 bg-rose-50/40"
                : "border-emerald-200 bg-emerald-50/40"
            }`}
          >
            <div className="flex items-center justify-between">
              <span
                className={`text-xs font-bold ${
                  summary.totalVarianceMinor < 0 ? "text-rose-800" : "text-emerald-800"
                }`}
              >
                {summary.totalVarianceMinor < 0 ? "صافي العجز (تجاوز)" : "صافي الوفر المتبقي"}
              </span>
              <span
                className={`rounded-lg p-1.5 ${
                  summary.totalVarianceMinor < 0
                    ? "bg-rose-100 text-rose-700"
                    : "bg-emerald-100 text-emerald-700"
                }`}
              >
                <Icon
                  name={summary.totalVarianceMinor < 0 ? "arrow" : "chart"}
                  className="h-4 w-4"
                />
              </span>
            </div>
            <div className="mt-2">
              <div className="flex items-center justify-between gap-2">
                <div
                  className={`text-lg sm:text-xl font-black font-mono ${
                    summary.totalVarianceMinor < 0 ? "text-rose-700" : "text-emerald-700"
                  }`}
                >
                  {summary.totalVarianceMinor < 0 ? "-" : "+"}
                  {formatMoney(Math.abs(summary.totalVarianceMinor), baseCurrency)}
                </div>
                {summary.overallVariancePercent !== undefined && (
                  <span
                    className={`rounded-lg px-2 py-0.5 text-xs font-mono font-black border ${
                      summary.overallVariancePercent > 0
                        ? "bg-rose-100/80 border-rose-300 text-rose-800"
                        : summary.overallVariancePercent < 0
                        ? "bg-emerald-100/80 border-emerald-300 text-emerald-800"
                        : "bg-slate-100 border-slate-300 text-slate-700"
                    }`}
                    title="نسبة الانحراف الإجمالية لكافة بنود المصروفات"
                  >
                    {summary.overallVariancePercent > 0
                      ? `+${summary.overallVariancePercent}% انحراف`
                      : `${summary.overallVariancePercent}% انحراف`}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {summary.totalVarianceMinor >= 0 ? "ضمن حدود الموازنة (وفر مالي)" : "تجاوز لسقف التقديرات (عجز)"}
              </div>
            </div>
          </div>

          {/* Overall Consumption % */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-500">
              <span className="text-xs font-semibold">نسبة استهلاك الميزانية</span>
              <span className="rounded-lg bg-purple-50 p-1.5 text-purple-700">
                <Icon name="chart" className="h-4 w-4" />
              </span>
            </div>
            <div className="mt-2">
              <div className="flex items-baseline gap-2">
                <span
                  className={`text-lg sm:text-xl font-black font-mono ${
                    summary.overallConsumptionPercent > 100
                      ? "text-rose-700"
                      : summary.overallConsumptionPercent > 80
                      ? "text-amber-600"
                      : "text-slate-900"
                  }`}
                >
                  {summary.overallConsumptionPercent}%
                </span>
                <span className="text-xs text-slate-500">من السقف الشهري</span>
              </div>
              {/* Progress bar */}
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    summary.overallConsumptionPercent > 100
                      ? "bg-rose-500"
                      : summary.overallConsumptionPercent > 80
                      ? "bg-amber-500"
                      : "bg-teal-500"
                  }`}
                  style={{
                    width: `${Math.min(100, summary.overallConsumptionPercent)}%`,
                  }}
                />
              </div>
            </div>
          </div>

          {/* Over Budget Count */}
          <div
            className={`col-span-2 lg:col-span-1 rounded-2xl border p-4 shadow-xs flex flex-col justify-between ${
              summary.overBudgetCount > 0
                ? "border-amber-200 bg-amber-50/50"
                : "border-slate-200 bg-white"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">تنبيهات التجاوز</span>
              <span
                className={`rounded-lg p-1.5 ${
                  summary.overBudgetCount > 0
                    ? "bg-amber-100 text-amber-700"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                <Icon name="alert" className="h-4 w-4" />
              </span>
            </div>
            <div className="mt-2">
              <div
                className={`text-lg sm:text-xl font-black font-mono ${
                  summary.overBudgetCount > 0 ? "text-amber-700" : "text-slate-800"
                }`}
              >
                {summary.overBudgetCount}{" "}
                <span className="text-xs font-normal text-slate-500">بنداً متجاوزاً</span>
              </div>
              <button
                onClick={() => setBudgetFilter(budgetFilter === "over" ? "all" : "over")}
                className="mt-1 text-[11px] font-bold text-amber-800 underline hover:text-amber-900 block"
              >
                {budgetFilter === "over" ? "عرض كافة البنود" : "تصفية البنود المتجاوزة ‹"}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Filter Tabs & Search Bar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {/* Search */}
        <div className="relative w-full sm:w-72">
          <Icon
            name="search"
            className="absolute start-3 top-2.5 h-4 w-4 text-slate-400"
          />
          <input
            type="text"
            placeholder="بحث بالبند، الحساب المحاسبي، أو المجموعة..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white py-2 ps-9 pe-3 text-xs text-slate-800 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none shadow-2xs"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute end-2.5 top-2.5 text-slate-400 hover:text-slate-600"
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Group Tabs */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <button
            onClick={() => setSelectedGroup("all")}
            className={`rounded-lg px-3 py-1.5 font-bold transition ${
              selectedGroup === "all"
                ? "bg-slate-900 text-white shadow-xs"
                : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"
            }`}
          >
            كافة المجموعات ({categories.length})
          </button>
          {groups.map((grp) => {
            const count = categories.filter((c) => c.categoryGroup === grp).length;
            return (
              <button
                key={grp}
                onClick={() => setSelectedGroup(grp)}
                className={`rounded-lg px-3 py-1.5 font-bold transition ${
                  selectedGroup === grp
                    ? "bg-teal-700 text-white shadow-xs"
                    : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"
                }`}
              >
                {grp} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* Floating Batch Save Bar */}
      {hasPendingChanges && (
        <div className="fixed bottom-6 start-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-2xl bg-slate-900/95 text-white px-5 py-3 shadow-2xl border border-slate-700 backdrop-blur-md animate-bounce">
          <div className="flex items-center gap-2">
            <span className="flex h-2.5 w-2.5 rounded-full bg-amber-400 animate-ping" />
            <span className="text-xs font-bold">
              لديك تعديلات غير محفوظة على {Object.keys(draftEdits).length} بنداً
            </span>
          </div>

          <div className="flex items-center gap-2 ms-4">
            <button
              onClick={handleSaveBatch}
              disabled={savingBatch}
              className="inline-flex items-center gap-1.5 rounded-xl bg-teal-500 hover:bg-teal-600 px-4 py-1.5 text-xs font-black text-slate-950 transition shadow-sm disabled:opacity-50"
            >
              <Icon name="check" className="h-4 w-4" />
              {savingBatch ? "جاري الحفظ..." : "حفظ التعديلات الآن"}
            </button>

            <button
              onClick={handleDiscardBatch}
              disabled={savingBatch}
              className="rounded-xl border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800 transition"
            >
              تراجع
            </button>
          </div>
        </div>
      )}

      {/* Main Table */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
        {loading ? (
          <div className="py-20 text-center">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-teal-600 border-e-transparent" />
            <p className="mt-3 text-xs font-bold text-slate-500">
              جاري تحميل بنود المصروفات والميزانيات...
            </p>
          </div>
        ) : filteredCategories.length === 0 ? (
          <div className="py-16 text-center text-slate-500">
            <Icon name="inbox" className="mx-auto h-12 w-12 text-slate-300 mb-2" />
            <p className="text-sm font-bold">لم يتم العثور على أي بنود تطابق معايير البحث.</p>
            <p className="text-xs text-slate-400 mt-1">
              جرب تغيير معايير التصفية أو أضف بند مصروف جديد من الزر أعلاه.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-right text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold">
                  <th className="p-3.5 w-12 text-center">م</th>
                  <th className="p-3.5">بند المصروف التشغيلي</th>
                  <th className="p-3.5 text-center">المجموعة</th>
                  <th className="p-3.5">الربط بدليل الحسابات</th>
                  <th className="p-3.5 text-left font-mono">الميزانية الشهرية</th>
                  <th className="p-3.5 text-left font-mono">المنصرف الفعلي</th>
                  <th className="p-3.5 text-left font-mono">الوفر / العجز</th>
                  <th className="p-3.5 text-center font-mono w-28" title="نسبة الانحراف اللحظية بين المنصرف الفعلي والميزانية التقديرية">
                    نسبة الانحراف
                  </th>
                  <th className="p-3.5 text-center w-36">الاستهلاك %</th>
                  <th className="p-3.5 text-center">الحالة</th>
                  <th className="p-3.5 text-center w-28">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredCategories.map((rawCat, idx) => {
                  const cat = getEffectiveCategory(rawCat);
                  const hasDraft = !!draftEdits[rawCat.id];
                  const isOver = cat.isOverBudget;

                  return (
                    <tr
                      key={rawCat.id}
                      className={`hover:bg-slate-50/70 transition-colors ${
                        hasDraft ? "bg-amber-50/30" : idx % 2 === 1 ? "bg-slate-50/30" : "bg-white"
                      } ${!cat.isActive ? "opacity-60 bg-slate-100/50" : ""}`}
                    >
                      {/* Index */}
                      <td className="p-3.5 text-center font-mono text-slate-400">
                        {idx + 1}
                      </td>

                      {/* Name & Key */}
                      <td className="p-3.5">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900 text-sm">{cat.name}</span>
                          {cat.isSystem && (
                            <span className="rounded bg-slate-100 border border-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                              أساسي
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-slate-500 mt-0.5 font-mono">
                          <span>كود: {cat.key}</span>
                          {cat.description && (
                            <span className="truncate max-w-xs text-slate-400 font-sans">
                              • {cat.description}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Group */}
                      <td className="p-3.5 text-center">
                        <span className="inline-block rounded-lg bg-slate-100 border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-700">
                          {cat.categoryGroup}
                        </span>
                      </td>

                      {/* Account Mapping & Auto-posting */}
                      <td className="p-3.5">
                        <div className="relative">
                          <select
                            value={cat.accountCode}
                            onChange={(e) =>
                              handleDraftChange(rawCat.id, "accountCode", e.target.value)
                            }
                            className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 shadow-2xs hover:border-teal-400 focus:border-teal-500 focus:outline-none"
                          >
                            {standardAccounts.map((acc) => (
                              <option key={acc.code} value={acc.code}>
                                {acc.code} — {acc.name}
                              </option>
                            ))}
                            {!standardAccounts.some((a) => a.code === cat.accountCode) && (
                              <option value={cat.accountCode}>
                                {cat.accountCode} — {cat.accountName}
                              </option>
                            )}
                          </select>
                        </div>
                        <div className="mt-1.5 flex items-center justify-between gap-1">
                          <label
                            className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700 cursor-pointer select-none"
                            title="تفعيل الترحيل التلقائي لقيود اليومية العامة عند تسجيل أي سند صرف لهذا البند"
                          >
                            <input
                              type="checkbox"
                              checked={cat.autoPostJournal !== false}
                              onChange={(e) =>
                                handleDraftChange(rawCat.id, "autoPostJournal", e.target.checked)
                              }
                              className="h-3.5 w-3.5 rounded text-teal-600 focus:ring-teal-500"
                            />
                            <span className={cat.autoPostJournal !== false ? "text-emerald-700 font-bold" : "text-slate-400 font-normal"}>
                              {cat.autoPostJournal !== false ? "ترحيل تلقائي لليومية" : "إيقاف الترحيل"}
                            </span>
                          </label>
                          <span className="text-[10px] text-slate-400 font-mono">
                            حـ/ {cat.accountCode}
                          </span>
                        </div>
                      </td>

                      {/* Monthly Budget Input */}
                      <td className="p-3.5 text-left">
                        <div className="relative inline-flex items-center">
                          <input
                            type="number"
                            min="0"
                            step="1000"
                            /* الموازنة المخزّنة بوحدات العملة الأساس الصغرى — والريال
                               اليمني وحدته الكبرى=الصغرى، فالقسمة/الضرب بمئة ثابتة
                               كانت تضخّم الميزانية مئة ضعف مقابل المصروف الفعلي. */
                            value={cat.monthlyBudgetMinor / MINOR_UNITS[baseCurrency]}
                            onChange={(e) => {
                              const val = Math.max(0, Number(e.target.value) || 0) * MINOR_UNITS[baseCurrency];
                              handleDraftChange(rawCat.id, "monthlyBudgetMinor", val);
                            }}
                            className="w-32 rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 text-left font-mono text-xs font-bold text-slate-900 shadow-2xs hover:border-teal-400 focus:border-teal-500 focus:outline-none"
                          />
                          <span className="ms-1.5 text-[10px] text-slate-400 font-mono">
                            {baseCurrency}
                          </span>
                        </div>
                      </td>

                      {/* Actual Spent */}
                      <td className="p-3.5 text-left font-mono">
                        <div className="font-bold text-slate-900 text-sm">
                          {formatMoney(cat.actualSpentMinor, baseCurrency)}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {cat.expensesCount} حركة صرف
                        </div>
                      </td>

                      {/* Variance */}
                      <td className="p-3.5 text-left font-mono">
                        <div
                          className={`font-black text-sm ${
                            cat.varianceMinor < 0 ? "text-rose-600" : "text-emerald-700"
                          }`}
                        >
                          {cat.varianceMinor < 0 ? "-" : "+"}
                          {formatMoney(Math.abs(cat.varianceMinor), baseCurrency)}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {cat.varianceMinor < 0 ? "تجاوز للموازنة" : "وفر متبقي"}
                        </div>
                      </td>

                      {/* Real-time Variance Percentage (نسبة الانحراف اللحظية) */}
                      <td className="p-3.5 text-center font-mono">
                        {cat.monthlyBudgetMinor === 0 && cat.actualSpentMinor === 0 ? (
                          <div className="flex flex-col items-center">
                            <span className="inline-flex items-center gap-1 rounded-lg bg-slate-50 border border-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-400">
                              0%
                            </span>
                            <span className="text-[10px] text-slate-400 mt-0.5 font-sans">
                              لا حركة
                            </span>
                          </div>
                        ) : cat.monthlyBudgetMinor === 0 && cat.actualSpentMinor > 0 ? (
                          <div className="flex flex-col items-center">
                            <span
                              className="inline-flex items-center gap-1 rounded-lg bg-rose-50 border border-rose-300 px-2.5 py-1 text-[11px] font-black text-rose-700 shadow-2xs"
                              title="تم صرف مبالغ بدون اعتماد ميزانية تقديرية مسبقة لهذا البند"
                            >
                              <span>+100%</span>
                              <span className="text-[10px]">▲</span>
                            </span>
                            <span className="text-[10px] text-rose-600 mt-0.5 font-sans font-bold">
                              صرف بلا ميزانية
                            </span>
                          </div>
                        ) : cat.variancePercent > 0 ? (
                          <div className="flex flex-col items-center">
                            <span
                              className="inline-flex items-center gap-1 rounded-lg bg-rose-50 border border-rose-200 px-2.5 py-1 text-[11px] font-black text-rose-700 shadow-2xs"
                              title={`تجاوز المصروف الفعلي للميزانية التقديرية بنسبة +${cat.variancePercent}%`}
                            >
                              <span>+{cat.variancePercent}%</span>
                              <span className="text-[10px]">▲</span>
                            </span>
                            <span className="text-[10px] text-rose-600 mt-0.5 font-sans font-bold">
                              تجاوز عجز
                            </span>
                          </div>
                        ) : cat.variancePercent < 0 ? (
                          <div className="flex flex-col items-center">
                            <span
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-[11px] font-black text-emerald-700 shadow-2xs"
                              title={`وفر المصروف الفعلي عن الميزانية التقديرية بنسبة ${cat.variancePercent}%`}
                            >
                              <span>{cat.variancePercent}%</span>
                              <span className="text-[10px]">▼</span>
                            </span>
                            <span className="text-[10px] text-emerald-600 mt-0.5 font-sans font-bold">
                              وفر مالي
                            </span>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center">
                            <span
                              className="inline-flex items-center gap-1 rounded-lg bg-slate-100 border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-700 shadow-2xs"
                              title="المنصرف الفعلي مطابق للميزانية التقديرية تماماً"
                            >
                              0%
                            </span>
                            <span className="text-[10px] text-slate-500 mt-0.5 font-sans">
                              مطابق تماماً
                            </span>
                          </div>
                        )}
                      </td>

                      {/* Consumption Progress */}
                      <td className="p-3.5 text-center">
                        <div className="flex items-center justify-between text-[11px] font-mono font-bold mb-1">
                          <span
                            className={
                              cat.consumptionPercent > 100
                                ? "text-rose-700"
                                : cat.consumptionPercent > 80
                                ? "text-amber-600"
                                : "text-slate-700"
                            }
                          >
                            {cat.consumptionPercent}%
                          </span>
                          <span className="text-[10px] text-slate-400 font-sans">
                            {isOver ? "تجاوز" : "متاح"}
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${
                              cat.consumptionPercent > 100
                                ? "bg-rose-500"
                                : cat.consumptionPercent > 80
                                ? "bg-amber-500"
                                : "bg-teal-500"
                            }`}
                            style={{
                              width: `${Math.min(100, cat.consumptionPercent)}%`,
                            }}
                          />
                        </div>
                      </td>

                      {/* Status */}
                      <td className="p-3.5 text-center">
                        <button
                          type="button"
                          onClick={() =>
                            handleDraftChange(rawCat.id, "isActive", !cat.isActive)
                          }
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold transition shadow-2xs ${
                            cat.isActive
                              ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                              : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                          }`}
                          title="اضغط لتغيير حالة التفعيل"
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              cat.isActive ? "bg-emerald-600" : "bg-slate-400"
                            }`}
                          />
                          {cat.isActive ? "نشط" : "معطّل"}
                        </button>
                      </td>

                      {/* Actions */}
                      <td className="p-3.5 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => setEditingCategory(rawCat)}
                            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-teal-700 transition"
                            title="تعديل التفاصيل الكاملة"
                          >
                            <Icon name="edit" className="h-4 w-4" />
                          </button>

                          <button
                            onClick={() => handleDeleteCategory(rawCat)}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition"
                            title={rawCat.isSystem ? "تعطيل البند" : "حذف البند"}
                          >
                            <Icon name="trash" className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* CREATE CATEGORY MODAL */}
      {showCreateModal && (
        <CreateCategoryModal
          standardAccounts={standardAccounts}
          groups={groups}
          baseCurrency={baseCurrency}
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            setSuccessMsg("تمت إضافة بند المصروف بنجاح وربطه بالدليل المحاسبي.");
            setTimeout(() => setSuccessMsg(null), 3000);
            loadData();
          }}
        />
      )}

      {/* EDIT CATEGORY MODAL */}
      {editingCategory && (
        <EditCategoryModal
          category={editingCategory}
          standardAccounts={standardAccounts}
          groups={groups}
          baseCurrency={baseCurrency}
          onClose={() => setEditingCategory(null)}
          onUpdated={() => {
            setEditingCategory(null);
            setSuccessMsg("تم تحديث بيانات بند المصروف بنجاح.");
            setTimeout(() => setSuccessMsg(null), 3000);
            loadData();
          }}
        />
      )}

      {/* A4 REPORT & AUDIT MODAL */}
      {showReportModal && summary && (
        <ExpenseBudgetReportModal
          categories={filteredCategories}
          summary={summary}
          month={selectedMonth}
          clinicName={clinicName}
          baseCurrency={baseCurrency}
          onClose={() => setShowReportModal(false)}
        />
      )}
    </main>
  );
}

// CREATE MODAL COMPONENT
function CreateCategoryModal({
  standardAccounts,
  groups,
  baseCurrency,
  onClose,
  onCreated,
}: {
  standardAccounts: StandardAccount[];
  groups: string[];
  baseCurrency: Currency;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [group, setGroup] = useState("تشغيلية ومرافق");
  const [customGroup, setCustomGroup] = useState("");
  const [accountCode, setAccountCode] = useState("5502");
  const [monthlyBudget, setMonthlyBudget] = useState("100000");
  const [annualBudget, setAnnualBudget] = useState("1200000");
  const [description, setDescription] = useState("");
  const [autoPostJournal, setAutoPostJournal] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleMonthlyChange = (val: string) => {
    setMonthlyBudget(val);
    const num = Number(val) || 0;
    setAnnualBudget(String(num * 12));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("يرجى إدخال اسم بند المصروف.");
      return;
    }
    if (!accountCode.trim()) {
      setError("يرجى تحديد الحساب المحاسبي المرتبط.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const finalGroup = group === "__custom__" ? customGroup.trim() || "عامة" : group;
      const res = await fetch("/api/finance/expense-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: key.trim() || undefined,
          name: name.trim(),
          categoryGroup: finalGroup,
          accountCode: accountCode.trim(),
          monthlyBudgetMinor: Math.round((Number(monthlyBudget) || 0) * MINOR_UNITS[baseCurrency]),
          annualBudgetMinor: Math.round((Number(annualBudget) || 0) * MINOR_UNITS[baseCurrency]),
          budgetCurrency: baseCurrency,
          description: description.trim() || undefined,
          autoPostJournal,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "تعذّر إنشاء البند.");

      onCreated();
    } catch (err: any) {
      setError(err.message || "حدث خطأ أثناء حفظ البند.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs">
      <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-100 text-teal-700">
              <Icon name="plus" className="h-5 w-5" />
            </span>
            <h3 className="text-base font-bold text-slate-800">إضافة بند مصروف تشغيلي جديد</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-xs font-bold text-rose-800">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div>
            <label className="block font-bold text-slate-700 mb-1">
              اسم البند التشغيلي <span className="text-rose-600">*</span>
            </label>
            <input
              type="text"
              required
              placeholder="مثال: فواتير الكهرباء، صيانة الأجهزة الطبية، خدمات الإنترنت..."
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white p-2.5 font-bold text-slate-800 focus:border-teal-500 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">المجموعة والتبويب</label>
              <select
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white p-2.5 font-semibold text-slate-800 focus:border-teal-500 focus:outline-none"
              >
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
                <option value="__custom__">+ مجموعة جديدة...</option>
              </select>
            </div>

            {group === "__custom__" && (
              <div>
                <label className="block font-bold text-slate-700 mb-1">اسم المجموعة الجديدة</label>
                <input
                  type="text"
                  placeholder="مثال: تسويق، تشغيل..."
                  value={customGroup}
                  onChange={(e) => setCustomGroup(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white p-2.5 font-bold text-slate-800 focus:border-teal-500 focus:outline-none"
                />
              </div>
            )}
          </div>

          <div>
            <label className="block font-bold text-slate-700 mb-1">
              الربط بدليل الحسابات المحاسبي <span className="text-rose-600">*</span>
            </label>
            <select
              value={accountCode}
              onChange={(e) => setAccountCode(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white p-2.5 font-bold text-slate-800 focus:border-teal-500 focus:outline-none"
            >
              {standardAccounts.map((acc) => (
                <option key={acc.code} value={acc.code}>
                  {acc.code} — {acc.name}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-slate-400 mt-1">
              سيتم ترحيل أي سند صرف لهذا البند آلياً إلى هذا الحساب في دفتر اليومية وميزان المراجعة.
            </p>
          </div>

          {/* Auto-posting checkbox */}
          <label className="flex items-start gap-2.5 font-bold text-slate-700 cursor-pointer bg-emerald-50/60 p-3 rounded-xl border border-emerald-200">
            <input
              type="checkbox"
              checked={autoPostJournal}
              onChange={(e) => setAutoPostJournal(e.target.checked)}
              className="h-4 w-4 mt-0.5 rounded text-emerald-600 focus:ring-emerald-500"
            />
            <div>
              <span className="block text-xs font-bold text-emerald-950">
                ترحيل تلقائي لقيود اليومية في دليل الحسابات
              </span>
              <span className="block text-[11px] font-normal text-emerald-800 mt-0.5">
                توليد قيد يومية متوازن آلياً (مدين: حـ/ المصروف، دائن: حـ/ الصندوق) فور اعتماد السند.
              </span>
            </div>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">
                الميزانية التقديرية الشهرية ({baseCurrency})
              </label>
              <input
                type="number"
                min="0"
                step="1000"
                value={monthlyBudget}
                onChange={(e) => handleMonthlyChange(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white p-2.5 font-mono font-bold text-slate-800 focus:border-teal-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">
                الميزانية السنوية التقديرية ({baseCurrency})
              </label>
              <input
                type="number"
                min="0"
                step="1000"
                value={annualBudget}
                onChange={(e) => setAnnualBudget(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white p-2.5 font-mono font-bold text-slate-800 focus:border-teal-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block font-bold text-slate-700 mb-1">بيان ونطاق استخدام البند</label>
            <textarea
              rows={2}
              placeholder="وصف مختصر لمشتريات وسندات هذا البند..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white p-2.5 text-slate-800 focus:border-teal-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-300 px-4 py-2 font-bold text-slate-600 hover:bg-slate-100"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-teal-600 px-5 py-2 font-black text-white hover:bg-teal-700 disabled:opacity-50 shadow-sm"
            >
              {saving ? "جاري الحفظ..." : "إضافة البند"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// EDIT MODAL COMPONENT
function EditCategoryModal({
  category,
  standardAccounts,
  groups,
  baseCurrency,
  onClose,
  onUpdated,
}: {
  category: ExpenseCategoryDTO;
  standardAccounts: StandardAccount[];
  groups: string[];
  baseCurrency: Currency;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [group, setGroup] = useState(category.categoryGroup);
  const [accountCode, setAccountCode] = useState(category.accountCode);
  const [monthlyBudget, setMonthlyBudget] = useState(String(category.monthlyBudgetMinor / MINOR_UNITS[baseCurrency]));
  const [annualBudget, setAnnualBudget] = useState(String(category.annualBudgetMinor / MINOR_UNITS[baseCurrency]));
  const [description, setDescription] = useState(category.description || "");
  const [isActive, setIsActive] = useState(category.isActive);
  const [autoPostJournal, setAutoPostJournal] = useState(category.autoPostJournal !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/finance/expense-categories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: category.id,
          name: name.trim(),
          categoryGroup: group.trim(),
          accountCode: accountCode.trim(),
          monthlyBudgetMinor: Math.round((Number(monthlyBudget) || 0) * MINOR_UNITS[baseCurrency]),
          annualBudgetMinor: Math.round((Number(annualBudget) || 0) * MINOR_UNITS[baseCurrency]),
          description: description.trim() || null,
          isActive,
          autoPostJournal,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "تعذّر حفظ التعديلات.");

      onUpdated();
    } catch (err: any) {
      setError(err.message || "حدث خطأ أثناء حفظ التعديلات.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs">
      <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-100 text-teal-700">
              <Icon name="edit" className="h-5 w-5" />
            </span>
            <h3 className="text-base font-bold text-slate-800">تعديل بند المصروف: {category.name}</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-xs font-bold text-rose-800">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div>
            <label className="block font-bold text-slate-700 mb-1">اسم البند</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white p-2.5 font-bold text-slate-800 focus:border-teal-500 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">المجموعة</label>
              <input
                type="text"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white p-2.5 font-semibold text-slate-800 focus:border-teal-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">الحساب المحاسبي</label>
              <select
                value={accountCode}
                onChange={(e) => setAccountCode(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white p-2.5 font-bold text-slate-800 focus:border-teal-500 focus:outline-none"
              >
                {standardAccounts.map((acc) => (
                  <option key={acc.code} value={acc.code}>
                    {acc.code} — {acc.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Auto-posting checkbox in edit modal */}
          <label className="flex items-start gap-2.5 font-bold text-slate-700 cursor-pointer bg-emerald-50/60 p-3 rounded-xl border border-emerald-200">
            <input
              type="checkbox"
              checked={autoPostJournal}
              onChange={(e) => setAutoPostJournal(e.target.checked)}
              className="h-4 w-4 mt-0.5 rounded text-emerald-600 focus:ring-emerald-500"
            />
            <div>
              <span className="block text-xs font-bold text-emerald-950">
                ترحيل تلقائي لقيود اليومية العامة
              </span>
              <span className="block text-[11px] font-normal text-emerald-800 mt-0.5">
                توليد قيد اليومية تلقائياً وترحيله لدفتر اليومية والأستاذ العام وميزان المراجعة فور تسجيل الصرف.
              </span>
            </div>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">
                الميزانية الشهرية ({baseCurrency})
              </label>
              <input
                type="number"
                min="0"
                step="1000"
                value={monthlyBudget}
                onChange={(e) => setMonthlyBudget(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white p-2.5 font-mono font-bold text-slate-800 focus:border-teal-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">
                الميزانية السنوية ({baseCurrency})
              </label>
              <input
                type="number"
                min="0"
                step="1000"
                value={annualBudget}
                onChange={(e) => setAnnualBudget(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white p-2.5 font-mono font-bold text-slate-800 focus:border-teal-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block font-bold text-slate-700 mb-1">الوصف والملاحظات</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white p-2.5 text-slate-800 focus:border-teal-500 focus:outline-none"
            />
          </div>

          <label className="flex items-center gap-2 font-bold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded text-teal-600 focus:ring-teal-500"
            />
            <span>البند نشط ويظهر في قائمة تسجيل المصروفات</span>
          </label>

          <div className="flex items-center justify-end gap-2 border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-300 px-4 py-2 font-bold text-slate-600 hover:bg-slate-100"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-teal-600 px-5 py-2 font-black text-white hover:bg-teal-700 disabled:opacity-50 shadow-sm"
            >
              {saving ? "جاري الحفظ..." : "حفظ التعديلات"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
