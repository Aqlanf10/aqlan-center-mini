"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";
import { Icon } from "@/components/Icon";
import { formatMoney, type Currency } from "@/lib/money";
import { useSetting } from "@/components/SettingsProvider";

interface LabMapping {
  id: number;
  name: string;
  currency: Currency;
  isActive: boolean;
  deliveryDays: number;
  expenseAccountCode: string;
  expenseAccountName: string;
  payableAccountCode: string;
  payableAccountName: string;
  autoPostJournal: boolean;
  customAccountName: string | null;
  activeOrdersCount: number;
  totalOrdersCount: number;
  totalOwedMinor: number;
  totalPaidMinor: number;
  dueMinor: number;
  lastOrderDate: string | null;
}

interface AccountOption {
  code: string;
  name: string;
  description: string;
}

interface SummaryData {
  totalLabs: number;
  activeLabs: number;
  totalOwedMinor: number;
  totalPaidMinor: number;
  totalDueMinor: number;
  activeOrdersTotal: number;
  customMappedCount: number;
}

export default function LabAccountingPage() {
  const baseSetting = (useSetting("finance.base_currency") as Currency) || "YER";

  const [mappings, setMappings] = useState<LabMapping[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<AccountOption[]>([]);
  const [payableAccounts, setPayableAccounts] = useState<AccountOption[]>([]);
  const [summary, setSummary] = useState<SummaryData | null>(null);

  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [batchSaving, setBatchSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form local state for edits
  const [drafts, setDrafts] = useState<Record<number, {
    expenseAccountCode: string;
    payableAccountCode: string;
    autoPostJournal: boolean;
    customAccountName: string;
  }>>({});

  const [search, setSearch] = useState("");
  const [filterAccount, setFilterAccount] = useState<string>("all");
  const [previewLab, setPreviewLab] = useState<LabMapping | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/finance/lab-accounting");
      if (!res.ok) {
        if (res.status === 401) {
          window.location.assign("/login");
          return;
        }
        const data = await res.json().catch(() => null);
        throw new Error(data?.message || "تعذّر تحميل إعدادات الحسابات للمختبرات.");
      }
      const data = await res.json();
      setMappings(data.mappings || []);
      setExpenseAccounts(data.standardExpenseAccounts || []);
      setPayableAccounts(data.standardPayableAccounts || []);
      setSummary(data.summary || null);

      // Initialize drafts
      const initialDrafts: Record<number, {
        expenseAccountCode: string;
        payableAccountCode: string;
        autoPostJournal: boolean;
        customAccountName: string;
      }> = {};
      for (const m of data.mappings || []) {
        initialDrafts[m.id] = {
          expenseAccountCode: m.expenseAccountCode,
          payableAccountCode: m.payableAccountCode,
          autoPostJournal: m.autoPostJournal,
          customAccountName: m.customAccountName || "",
        };
      }
      setDrafts(initialDrafts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleDraftChange = (id: number, key: string, value: any) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        [key]: value,
      },
    }));
  };

  const isLabChanged = (lab: LabMapping) => {
    const draft = drafts[lab.id];
    if (!draft) return false;
    return (
      draft.expenseAccountCode !== lab.expenseAccountCode ||
      draft.payableAccountCode !== lab.payableAccountCode ||
      draft.autoPostJournal !== lab.autoPostJournal ||
      (draft.customAccountName || "") !== (lab.customAccountName || "")
    );
  };

  const hasAnyChanges = useMemo(() => {
    return mappings.some((m) => isLabChanged(m));
  }, [mappings, drafts]);

  const saveSingle = async (id: number) => {
    const draft = drafts[id];
    if (!draft) return;
    setSavingId(id);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch("/api/finance/lab-accounting", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          expenseAccountCode: draft.expenseAccountCode,
          payableAccountCode: draft.payableAccountCode,
          autoPostJournal: draft.autoPostJournal,
          customAccountName: draft.customAccountName.trim() || null,
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "تعذّر حفظ التعديلات.");

      setMappings(data.mappings || []);
      setSuccess("تم حفظ التعديلات بنجاح وربط المعمل بالبنود الحسابية في دفتر اليومية.");
      setTimeout(() => setSuccess(null), 3500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ أثناء الحفظ.");
    } finally {
      setSavingId(null);
    }
  };

  const saveAll = async () => {
    const changedUpdates = mappings
      .filter((m) => isLabChanged(m))
      .map((m) => ({
        id: m.id,
        expenseAccountCode: drafts[m.id].expenseAccountCode,
        payableAccountCode: drafts[m.id].payableAccountCode,
        autoPostJournal: drafts[m.id].autoPostJournal,
        customAccountName: drafts[m.id].customAccountName.trim() || null,
      }));

    if (changedUpdates.length === 0) return;

    setBatchSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch("/api/finance/lab-accounting", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: changedUpdates }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "تعذّر حفظ التعديلات الجماعية.");

      setMappings(data.mappings || []);
      setSuccess(`تم تحديث وحفظ ربط ${changedUpdates.length} مختبرات بنجاح.`);
      setTimeout(() => setSuccess(null), 3500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ أثناء الحفظ الجماعي.");
    } finally {
      setBatchSaving(false);
    }
  };

  const filteredMappings = useMemo(() => {
    return mappings.filter((m) => {
      const matchSearch =
        m.name.toLowerCase().includes(search.toLowerCase()) ||
        m.expenseAccountCode.includes(search) ||
        m.payableAccountCode.includes(search) ||
        (m.customAccountName || "").toLowerCase().includes(search.toLowerCase());

      if (!matchSearch) return false;
      if (filterAccount === "all") return true;
      if (filterAccount === "custom") {
        return m.expenseAccountCode !== "5101" || m.payableAccountCode !== "2101";
      }
      if (filterAccount === "general") {
        return m.expenseAccountCode === "5101" && m.payableAccountCode === "2101";
      }
      return m.expenseAccountCode === filterAccount;
    });
  }, [mappings, search, filterAccount]);

  return (
    <main className="mx-auto max-w-6xl p-4 pb-24 text-slate-900" id="lab-accounting-page">
      <PageHeader
        title="ربط حسابات المختبرات"
        subtitle="توجيه التزامات ومصروفات المعامل إلى بنود دليل الحسابات وقائمة الدخل تلقائيًا"
        links={financeLinks("/finance/lab-accounting")}
      />

      {/* تنبيهات النجاح والخطأ */}
      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-sm text-rose-800">
          <Icon name="alert" className="h-5 w-5 shrink-0 text-rose-600" />
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="mr-auto text-xs font-semibold text-rose-700 underline"
          >
            إغلاق
          </button>
        </div>
      )}

      {success && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-sm text-emerald-800">
          <Icon name="check" className="h-5 w-5 shrink-0 text-emerald-600" />
          <span>{success}</span>
        </div>
      )}

      {/* بطاقات الإحصائيات المالية والربط */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>إجمالي المختبرات المسجلة</span>
            <Icon name="box" className="h-4 w-4 text-indigo-500" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold tracking-tight text-slate-900">
              {summary?.totalLabs || 0}
            </span>
            <span className="text-xs text-slate-500">
              ({summary?.customMappedCount || 0} بحسابات مخصصة)
            </span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
            <span>{summary?.activeLabs || 0} مختبر نشط</span>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>إجمالي الالتزامات (المصروفات المستحقة)</span>
            <Icon name="file" className="h-4 w-4 text-amber-500" />
          </div>
          <div className="mt-2">
            <span className="text-xl font-bold text-slate-900">
              {formatMoney(summary?.totalOwedMinor || 0, baseSetting)}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            تُقيَّد تلقائياً في قائمة الدخل تحت بند (51xx)
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>المسدد من الذمم</span>
            <Icon name="check" className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="mt-2">
            <span className="text-xl font-bold text-emerald-600">
              {formatMoney(summary?.totalPaidMinor || 0, baseSetting)}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            سندات صرف مخصومة من الصندوق
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>الرصيد المتبقي المستحق للمختبرات</span>
            <Icon name="wallet" className="h-4 w-4 text-rose-500" />
          </div>
          <div className="mt-2">
            <span className="text-xl font-bold text-rose-600">
              {formatMoney(summary?.totalDueMinor || 0, baseSetting)}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            ذمم دائنة تظهر في الميزانية العمومية (21xx)
          </p>
        </div>
      </div>

      {/* توضيح آلية الترحيل لقائمة الدخل ودفتر اليومية */}
      <div className="mb-6 rounded-2xl border border-indigo-100 bg-gradient-to-l from-indigo-50/60 via-sky-50/40 to-white p-4.5 text-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xs">
              <Icon name="clipboard" className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900">
                كيف تظهر التزامات المعامل تلقائياً في قائمة الدخل ودفتر اليومية؟
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-600">
                عند إضافة أمر عمل مختبر أو التزام مالي (<span className="font-mono font-semibold">Payable</span>)، يقوم النظام فوراً بإنشاء قيد مزدوج في دفتر اليومية:
                <strong className="text-indigo-900 mx-1">مدين:</strong> حساب مصروف المختبر المحدد (<span className="font-mono">5101-5108</span>) ويظهر فوراً في <em>قائمة الدخل</em>،
                مقابل <strong className="text-indigo-900 mx-1">دائن:</strong> حساب الذمم الدائنة للمختبر (<span className="font-mono">2101-2104</span>) ويظهر في <em>الميزانية</em>.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href="/finance/accounting"
              className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 shadow-xs hover:bg-indigo-50 transition-colors"
            >
              <Icon name="file" className="h-4 w-4" />
              <span>معاينة الدفاتر وقائمة الدخل</span>
            </Link>
          </div>
        </div>
      </div>

      {/* أدوات البحث والتصفية والحفظ الجماعي */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[240px]">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث بالاسم أو رقم الحساب..."
              className="w-full rounded-xl border border-slate-200 bg-white py-2 pr-9 pl-3 text-xs placeholder:text-slate-400 focus:border-indigo-500 focus:outline-hidden focus:ring-2 focus:ring-indigo-100"
            />
            <Icon name="search" className="absolute right-3 top-2.5 h-4 w-4 text-slate-400" />
          </div>

          <select
            value={filterAccount}
            onChange={(e) => setFilterAccount(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white py-2 px-3 text-xs font-medium text-slate-700 focus:border-indigo-500 focus:outline-hidden"
          >
            <option value="all">كافة الحسابات</option>
            <option value="general">الحساب الافتراضي (5101 / 2101)</option>
            <option value="custom">الحسابات المخصصة</option>
            {expenseAccounts.map((acc) => (
              <option key={acc.code} value={acc.code}>
                {acc.code} - {acc.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => void loadData()}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            title="تحديث البيانات"
          >
            <Icon name="refresh" className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>تحديث</span>
          </button>

          {hasAnyChanges && (
            <button
              onClick={saveAll}
              disabled={batchSaving}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-indigo-700 transition-colors"
            >
              {batchSaving ? (
                <>
                  <Icon name="refresh" className="h-3.5 w-3.5 animate-spin" />
                  <span>جارٍ الحفظ...</span>
                </>
              ) : (
                <>
                  <Icon name="check" className="h-3.5 w-3.5" />
                  <span>حفظ كافة التغييرات</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* جدول ربط المختبرات بالبنود الحسابية */}
      <div className="overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/70 text-slate-600 font-semibold">
              <tr>
                <th className="py-3.5 pr-4 pl-3">المختبر / المعمل</th>
                <th className="py-3.5 px-3">بند مصروف قائمة الدخل (Expense)</th>
                <th className="py-3.5 px-3">بند الذمم الدائنة (Payable)</th>
                <th className="py-3.5 px-3">مسمى الحساب المخصص</th>
                <th className="py-3.5 px-3 text-center">الترحيل التلقائي</th>
                <th className="py-3.5 px-3 text-left">الرصيد المستحق</th>
                <th className="py-3.5 pr-3 pl-4 text-center">الإجراء</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Icon name="refresh" className="h-5 w-5 animate-spin text-indigo-500" />
                      <span>جارٍ تحميل دليل الحسابات والمختبرات...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredMappings.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    لا توجد مختبرات تطابق معايير البحث.
                  </td>
                </tr>
              ) : (
                filteredMappings.map((lab) => {
                  const draft = drafts[lab.id] || {
                    expenseAccountCode: lab.expenseAccountCode,
                    payableAccountCode: lab.payableAccountCode,
                    autoPostJournal: lab.autoPostJournal,
                    customAccountName: lab.customAccountName || "",
                  };
                  const changed = isLabChanged(lab);
                  const isSaving = savingId === lab.id;

                  return (
                    <tr
                      key={lab.id}
                      className={`hover:bg-slate-50/80 transition-colors ${
                        changed ? "bg-amber-50/40" : ""
                      }`}
                    >
                      {/* اسم المختبر وحالته */}
                      <td className="py-3.5 pr-4 pl-3">
                        <div className="flex items-center gap-2">
                          <div
                            className={`h-2.5 w-2.5 rounded-full ${
                              lab.isActive ? "bg-emerald-500" : "bg-slate-300"
                            }`}
                            title={lab.isActive ? "نشط" : "معطّل"}
                          />
                          <div>
                            <div className="font-bold text-slate-900">{lab.name}</div>
                            <div className="flex items-center gap-2 text-[11px] text-slate-500">
                              <span>العملة: {lab.currency}</span>
                              <span>·</span>
                              <span>{lab.activeOrdersCount} طلب نشط</span>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* بند المصروف بقائمة الدخل */}
                      <td className="py-3.5 px-3">
                        <select
                          value={draft.expenseAccountCode}
                          onChange={(e) =>
                            handleDraftChange(lab.id, "expenseAccountCode", e.target.value)
                          }
                          className="w-full min-w-[190px] rounded-lg border border-slate-200 bg-white py-1.5 px-2.5 text-xs font-medium text-slate-800 focus:border-indigo-500 focus:outline-hidden"
                        >
                          {expenseAccounts.map((acc) => (
                            <option key={acc.code} value={acc.code}>
                              {acc.code} - {acc.name}
                            </option>
                          ))}
                        </select>
                        <div className="mt-1 text-[10px] text-slate-500">
                          {expenseAccounts.find((a) => a.code === draft.expenseAccountCode)
                            ?.description || "مصروف مختبرات"}
                        </div>
                      </td>

                      {/* بند الذمم الدائنة */}
                      <td className="py-3.5 px-3">
                        <select
                          value={draft.payableAccountCode}
                          onChange={(e) =>
                            handleDraftChange(lab.id, "payableAccountCode", e.target.value)
                          }
                          className="w-full min-w-[170px] rounded-lg border border-slate-200 bg-white py-1.5 px-2.5 text-xs font-medium text-slate-800 focus:border-indigo-500 focus:outline-hidden"
                        >
                          {payableAccounts.map((acc) => (
                            <option key={acc.code} value={acc.code}>
                              {acc.code} - {acc.name}
                            </option>
                          ))}
                        </select>
                        <div className="mt-1 text-[10px] text-slate-500">
                          {payableAccounts.find((a) => a.code === draft.payableAccountCode)
                            ?.description || "ذمم دائنة"}
                        </div>
                      </td>

                      {/* مسمى الحساب المخصص في التقارير */}
                      <td className="py-3.5 px-3">
                        <input
                          type="text"
                          value={draft.customAccountName}
                          onChange={(e) =>
                            handleDraftChange(lab.id, "customAccountName", e.target.value)
                          }
                          placeholder={`افتراضي: ${lab.name}`}
                          className="w-full min-w-[130px] rounded-lg border border-slate-200 bg-white py-1.5 px-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-hidden"
                        />
                      </td>

                      {/* النشر التلقائي للقيود */}
                      <td className="py-3.5 px-3 text-center">
                        <label className="inline-flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            checked={draft.autoPostJournal}
                            onChange={(e) =>
                              handleDraftChange(lab.id, "autoPostJournal", e.target.checked)
                            }
                            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          />
                          <span className="mr-1.5 text-[11px] text-slate-600">
                            {draft.autoPostJournal ? "مفعّل" : "معطّل"}
                          </span>
                        </label>
                      </td>

                      {/* الرصيد المستحق الحالي */}
                      <td className="py-3.5 px-3 text-left">
                        <div className="font-mono font-bold text-slate-900">
                          {formatMoney(lab.dueMinor, baseSetting)}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          سداد: {formatMoney(lab.totalPaidMinor, baseSetting)}
                        </div>
                      </td>

                      {/* زر الحفظ والمعاينة */}
                      <td className="py-3.5 pr-3 pl-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setPreviewLab(lab)}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                            title="معاينة نموذج القيد المحاسبي"
                          >
                            <Icon name="file" className="h-4 w-4" />
                          </button>

                          <button
                            type="button"
                            onClick={() => saveSingle(lab.id)}
                            disabled={!changed || isSaving}
                            className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                              changed
                                ? "bg-indigo-600 text-white shadow-xs hover:bg-indigo-700"
                                : "bg-slate-100 text-slate-400 cursor-not-allowed"
                            }`}
                          >
                            {isSaving ? "..." : "حفظ"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* نافذة معاينة القيد المحاسبي النموذجي */}
      {previewLab && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700">
                  <Icon name="file" className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    معاينة أثر القيود في دفتر اليومية وقائمة الدخل
                  </h3>
                  <p className="text-xs text-slate-500">{previewLab.name}</p>
                </div>
              </div>
              <button
                onClick={() => setPreviewLab(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <Icon name="close" className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-4 text-xs">
              <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
                <div className="font-bold text-indigo-900 mb-1">
                  1. عند إثبات التزام طلب المختبر (Payable / Order Completion):
                </div>
                <div className="space-y-1 text-slate-700 font-mono">
                  <div className="flex justify-between border-b border-indigo-100/60 pb-1">
                    <span>
                      مدين (Debit) : {drafts[previewLab.id]?.expenseAccountCode || previewLab.expenseAccountCode} (
                      {expenseAccounts.find(
                        (a) =>
                          a.code ===
                          (drafts[previewLab.id]?.expenseAccountCode || previewLab.expenseAccountCode)
                      )?.name}
                      )
                    </span>
                    <span className="font-bold text-emerald-700">قائمة الدخل (مصروف)</span>
                  </div>
                  <div className="flex justify-between pt-1">
                    <span>
                      دائن (Credit): {drafts[previewLab.id]?.payableAccountCode || previewLab.payableAccountCode} (
                      {payableAccounts.find(
                        (a) =>
                          a.code ===
                          (drafts[previewLab.id]?.payableAccountCode || previewLab.payableAccountCode)
                      )?.name}
                      )
                    </span>
                    <span className="font-bold text-rose-700">الميزانية (ذمم دائنة)</span>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="font-bold text-slate-900 mb-1">
                  2. عند سداد دفعة للمختبر (Expense Voucher):
                </div>
                <div className="space-y-1 text-slate-700 font-mono">
                  <div className="flex justify-between border-b border-slate-200/60 pb-1">
                    <span>
                      مدين (Debit) : {drafts[previewLab.id]?.payableAccountCode || previewLab.payableAccountCode} (
                      {payableAccounts.find(
                        (a) =>
                          a.code ===
                          (drafts[previewLab.id]?.payableAccountCode || previewLab.payableAccountCode)
                      )?.name}
                      )
                    </span>
                    <span className="font-bold text-emerald-700">تخفيض التزام المعمل</span>
                  </div>
                  <div className="flex justify-between pt-1">
                    <span>مدين (Credit): 1101 (الصندوق - النقدية وما في حكمها)</span>
                    <span className="font-bold text-rose-700">تخفيض رصيد الصندوق</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setPreviewLab(null)}
                className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-slate-800"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
