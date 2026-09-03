"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatMoney, isCurrency, type Currency } from "@/lib/money";
import { installmentReminderText, type PlanStatus } from "@/lib/plans";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { friendlyDateLong, toWhatsAppNumber } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";

/**
 * أقساط العلاج المستحقة — إدارة التحصيل والتنبيهات التلقائية عبر واتساب
 * مع تتبع دقيق لتاريخ آخر تذكير لكل قسط وخطة علاجية.
 */

interface Plan {
  id: number;
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  title: string;
  totalMinor: number;
  status: PlanStatus;
  lastReminderAt?: string | null;
  installments?: {
    id: number;
    number: number;
    dueDate: string;
    amountMinor: number;
    lastReminderAt?: string | null;
  }[];
  progress: {
    totalMinor: number;
    dueToDateMinor: number;
    paidMinor: number;
    remainingMinor: number;
    overdueMinor: number;
    nextDueDate: string | null;
    nextDueAmountMinor: number;
    paidCount: number;
    count: number;
    lastReminderAt?: string | null;
  };
}

type Filter = "overdue" | "soon" | "all";

const FILTER_LABEL: Record<Filter, string> = {
  overdue: "متأخرة",
  soon: "تستحق قريبًا",
  all: "كل الخطط الجارية",
};

function formatReminderDate(dateStr: string | null | undefined): { text: string; isRecent: boolean } {
  if (!dateStr) return { text: "لم يُرسل تذكير", isRecent: false };
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffHours = (now.getTime() - d.getTime()) / (1000 * 60 * 60);

    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = d.getHours();
    const min = String(d.getMinutes()).padStart(2, "0");
    const period = h >= 12 ? "م" : "ص";
    const h12 = h % 12 || 12;
    const timeText = `${y}/${m}/${day} ${h12}:${min} ${period}`;

    return {
      text: timeText,
      isRecent: diffHours < 24,
    };
  } catch {
    return { text: String(dateStr), isRecent: false };
  }
}

export default function PlansPage() {
  const baseSetting = useSetting("finance.base_currency");
  const clinicName = useClinicName();
  const clinicPhone = useSetting("clinic.phone");
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);

  const [plans, setPlans] = useState<Plan[]>([]);
  const [base, setBase] = useState<Currency>(isCurrency(baseSetting) ? baseSetting : "YER");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("overdue");
  const [searchQuery, setSearchQuery] = useState("");

  // Automated WhatsApp batch modal
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [selectedPlanIds, setSelectedPlanIds] = useState<Set<number>>(new Set());
  const [batchProgress, setBatchProgress] = useState<{
    currentIndex: number;
    total: number;
    isRunning: boolean;
  }>({ currentIndex: 0, total: 0, isRunning: false });
  const [batchNotice, setBatchNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/plans", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setPlans(payload.plans as Plan[]);
      if (isCurrency(payload.baseCurrency)) setBase(payload.baseCurrency);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const recordReminder = async (planId: number) => {
    try {
      const res = await fetch("/api/plans/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      if (res.ok) {
        const data = await res.json();
        setPlans((prev) =>
          prev.map((p) => {
            if (p.id === planId) {
              return {
                ...p,
                lastReminderAt: data.lastReminderAt,
                progress: {
                  ...p.progress,
                  lastReminderAt: data.lastReminderAt,
                },
              };
            }
            return p;
          }),
        );
      }
    } catch {
      /* ignore */
    }
  };

  const handleSendReminder = (plan: Plan) => {
    const overdue = plan.progress.overdueMinor > 0;
    const number = toWhatsAppNumber(plan.patientPhone);
    if (!number) return;

    const amount = overdue ? plan.progress.overdueMinor : plan.progress.nextDueAmountMinor;
    const dueDate = overdue ? today : plan.progress.nextDueDate ?? today;
    const text = installmentReminderText({
      patientName: plan.patientName,
      amountText: formatMoney(amount, base),
      dueDateText: friendlyDateLong(dueDate),
      overdue,
      clinicName,
      clinicPhone,
    });

    // Record reminder in background
    void recordReminder(plan.id);

    // Open WhatsApp
    const url = `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const visible = useMemo(() => {
    let list = plans;
    if (filter === "overdue") {
      list = list
        .filter((plan) => plan.progress.overdueMinor > 0)
        .sort((a, b) => b.progress.overdueMinor - a.progress.overdueMinor);
    } else if (filter === "soon") {
      const limit = new Date(`${today}T12:00:00`);
      limit.setDate(limit.getDate() + 14);
      const limitText = `${limit.getFullYear()}-${String(limit.getMonth() + 1).padStart(2, "0")}-${String(limit.getDate()).padStart(2, "0")}`;
      list = list
        .filter((plan) => plan.progress.nextDueDate && plan.progress.nextDueDate <= limitText)
        .sort((a, b) => (a.progress.nextDueDate ?? "").localeCompare(b.progress.nextDueDate ?? ""));
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (p) =>
          p.patientName.toLowerCase().includes(q) ||
          p.title.toLowerCase().includes(q) ||
          (p.patientPhone ?? "").includes(q),
      );
    }

    return list;
  }, [plans, filter, today, searchQuery]);

  const overdueList = useMemo(() => {
    return plans.filter((p) => p.progress.overdueMinor > 0 && toWhatsAppNumber(p.patientPhone));
  }, [plans]);

  const totals = useMemo(
    () => ({
      overdue: plans.reduce((sum, plan) => sum + plan.progress.overdueMinor, 0),
      remaining: plans.reduce((sum, plan) => sum + plan.progress.remainingMinor, 0),
      count: plans.length,
      overdueCount: plans.filter((p) => p.progress.overdueMinor > 0).length,
    }),
    [plans],
  );

  // Initialize selected for batch modal
  const openBatchModal = () => {
    const ids = new Set(overdueList.map((p) => p.id));
    setSelectedPlanIds(ids);
    setBatchProgress({ currentIndex: 0, total: overdueList.length, isRunning: false });
    setBatchNotice(null);
    setShowBatchModal(true);
  };

  const toggleSelectPlan = (id: number) => {
    setSelectedPlanIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedPlanIds.size === overdueList.length) {
      setSelectedPlanIds(new Set());
    } else {
      setSelectedPlanIds(new Set(overdueList.map((p) => p.id)));
    }
  };

  const runBatchDispatch = async () => {
    const selectedPlans = overdueList.filter((p) => selectedPlanIds.has(p.id));
    if (selectedPlans.length === 0) return;

    setBatchProgress({ currentIndex: 0, total: selectedPlans.length, isRunning: true });
    setBatchNotice("جارٍ توجيه التنبيهات وتسجيل تواريخ التذكير...");

    const updatedIds: number[] = [];

    for (let i = 0; i < selectedPlans.length; i++) {
      const plan = selectedPlans[i];
      setBatchProgress({ currentIndex: i + 1, total: selectedPlans.length, isRunning: true });

      const number = toWhatsAppNumber(plan.patientPhone);
      if (number) {
        const text = installmentReminderText({
          patientName: plan.patientName,
          amountText: formatMoney(plan.progress.overdueMinor, base),
          dueDateText: friendlyDateLong(today),
          overdue: true,
          clinicName,
          clinicPhone,
        });

        // Open WhatsApp
        const url = `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
        window.open(url, "_blank", "noopener,noreferrer");
        updatedIds.push(plan.id);
      }

      // Small delay between opening tabs to avoid browser popup blocking
      if (i < selectedPlans.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    // Bulk save reminder timestamp to DB
    if (updatedIds.length > 0) {
      try {
        const res = await fetch("/api/plans/reminders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planIds: updatedIds }),
        });
        if (res.ok) {
          const data = await res.json();
          setPlans((prev) =>
            prev.map((p) => {
              if (updatedIds.includes(p.id)) {
                return {
                  ...p,
                  lastReminderAt: data.lastReminderAt,
                  progress: {
                    ...p.progress,
                    lastReminderAt: data.lastReminderAt,
                  },
                };
              }
              return p;
            }),
          );
        }
      } catch {
        /* ignore */
      }
    }

    setBatchProgress((prev) => ({ ...prev, isRunning: false }));
    setBatchNotice(`اكتمل إرسال التنبيهات لـ ${updatedIds.length} مريض وتحديث تاريخ آخر تذكير بنجاح.`);
  };

  return (
    <main className="mx-auto max-w-5xl p-4 pb-24" dir="rtl">
      <PageHeader
        title="أقساط العلاج"
        subtitle="الخطط الجارية ومتابعة الأقساط المتأخرة وإصدار التنبيهات التلقائية عبر واتساب"
        links={financeLinks("/finance/plans")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            id="plans-batch-whatsapp-btn"
            type="button"
            onClick={openBatchModal}
            className="rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white px-3.5 py-2 text-xs font-bold shadow-xs transition-colors flex items-center gap-1.5"
          >
            <span>💬</span>
            <span>إصدار تنبيهات واتساب تلقائية ({overdueList.length})</span>
          </button>
        </div>
      </PageHeader>

      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700 font-bold"
        >
          {error}
        </p>
      ) : null}

      {/* Metric Cards */}
      <section className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-center">
        <div className="rounded-2xl border border-red-200 bg-red-50/80 p-3.5 shadow-2xs">
          <p className="text-base font-black text-red-700 font-mono">
            {formatMoney(totals.overdue, base)}
          </p>
          <p className="text-[11px] font-bold text-red-600 mt-0.5">
            إجمالي الأقساط المتأخرة ({totals.overdueCount})
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-2xs">
          <p className="text-base font-black text-slate-800 font-mono">
            {formatMoney(totals.remaining, base)}
          </p>
          <p className="text-[11px] font-bold text-slate-500 mt-0.5">باقٍ على كل الخطط</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-2xs">
          <p className="text-base font-black text-slate-800 font-mono">{totals.count}</p>
          <p className="text-[11px] font-bold text-slate-500 mt-0.5">خطة علاجية نشطة</p>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3.5 shadow-2xs">
          <p className="text-base font-black text-emerald-800 font-mono">
            {overdueList.length}
          </p>
          <p className="text-[11px] font-bold text-emerald-700 mt-0.5">متأخرين متاح لهم واتساب</p>
        </div>
      </section>

      {/* Filter and Search Bar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(["overdue", "soon", "all"] as Filter[]).map((option) => (
            <button
              key={option}
              id={`plans-filter-${option}`}
              onClick={() => setFilter(option)}
              className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition-colors ${
                filter === option
                  ? "border-navy-800 bg-navy-800 text-white shadow-2xs"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {FILTER_LABEL[option]}
              {option === "overdue" && totals.overdueCount > 0 && (
                <span className="mr-1 rounded-full bg-red-500 text-white px-1.5 py-0.2 text-[10px]">
                  {totals.overdueCount}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="w-full sm:w-64">
          <input
            id="plans-search-input"
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="بحث باسم المريض أو الهاتف..."
            className="w-full text-xs rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-slate-800 outline-none focus:border-navy-800"
          />
        </div>
      </div>

      {/* Installments Table */}
      {loading && plans.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
          جارٍ تحميل بيانات الأقساط والتنبيهات…
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center text-xs font-bold text-emerald-800">
          {filter === "overdue" ? "✓ لا توجد أي أقساط متأخرة حالياً!" : "لا توجد خطط تطابق الفلتر المحدد."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xs">
          <div className="overflow-x-auto">
            <table id="plans-installments-table" className="w-full text-xs text-right border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-slate-600 font-bold text-[11px]">
                  <th className="py-3 px-3">المريض</th>
                  <th className="py-3 px-3">خطة العلاج</th>
                  <th className="py-3 px-3">تاريخ الاستحقاق</th>
                  <th className="py-3 px-3 text-left">المبلغ المستحق</th>
                  <th className="py-3 px-3 text-center">تاريخ آخر تذكير ⭐</th>
                  <th className="py-3 px-3 text-center">تنبيه واتساب</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium">
                {visible.map((plan) => {
                  const overdue = plan.progress.overdueMinor > 0;
                  const number = toWhatsAppNumber(plan.patientPhone);
                  const amount = overdue ? plan.progress.overdueMinor : plan.progress.nextDueAmountMinor;
                  const dueDate = overdue ? today : plan.progress.nextDueDate ?? today;
                  const reminderInfo = formatReminderDate(
                    plan.progress.lastReminderAt || plan.lastReminderAt,
                  );

                  return (
                    <tr
                      key={plan.id}
                      className={`transition-colors hover:bg-slate-50/70 ${
                        overdue ? "bg-red-50/20" : ""
                      }`}
                    >
                      {/* Patient */}
                      <td className="py-3 px-3">
                        <a
                          href={`/patients/${plan.patientId}`}
                          className="font-bold text-slate-900 hover:text-indigo-600 underline decoration-slate-300 underline-offset-2 block truncate"
                        >
                          {plan.patientName}
                        </a>
                        <span className="text-[11px] text-slate-500 font-mono dir-ltr inline-block">
                          {plan.patientPhone || "بلا هاتف"}
                        </span>
                      </td>

                      {/* Plan title & progress */}
                      <td className="py-3 px-3">
                        <div className="font-semibold text-slate-800">{plan.title}</div>
                        <div className="text-[11px] text-slate-500">
                          {plan.progress.paidCount} من {plan.progress.count} أقساط مسددة
                        </div>
                      </td>

                      {/* Due date */}
                      <td className="py-3 px-3">
                        <span className={`font-semibold ${overdue ? "text-red-700" : "text-slate-700"}`}>
                          {friendlyDateLong(dueDate)}
                        </span>
                        {overdue && (
                          <span className="block text-[10px] font-bold text-red-600">
                            مستحق الدفع
                          </span>
                        )}
                      </td>

                      {/* Amount */}
                      <td className="py-3 px-3 text-left">
                        <div
                          className={`font-black font-mono ${
                            overdue ? "text-red-700 text-sm" : "text-slate-800"
                          }`}
                        >
                          {formatMoney(amount, base)}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          باقٍ {formatMoney(plan.progress.remainingMinor, base)}
                        </div>
                      </td>

                      {/* Last Reminder Date Column ⭐ */}
                      <td className="py-3 px-3 text-center">
                        {reminderInfo.text === "لم يُرسل تذكير" ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200">
                            <span>—</span>
                            <span>لم يُرسل تذكير بعد</span>
                          </span>
                        ) : (
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold border ${
                              reminderInfo.isRecent
                                ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                                : "bg-indigo-50 text-indigo-800 border-indigo-200"
                            }`}
                            title={reminderInfo.text}
                          >
                            <span>✓</span>
                            <span>{reminderInfo.text}</span>
                          </span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-3 text-center">
                        {number ? (
                          <button
                            id={`plan-reminder-btn-${plan.id}`}
                            type="button"
                            onClick={() => handleSendReminder(plan)}
                            className="inline-flex items-center gap-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-xs font-bold shadow-2xs transition-colors"
                            title="إرسال تذكير واتساب وتحديث تاريخ آخر تذكير فورياً"
                          >
                            <span>💬</span>
                            <span>تذكير</span>
                          </button>
                        ) : (
                          <span className="inline-block rounded-xl border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-amber-700 bg-amber-50">
                            بلا رقم
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Automated WhatsApp Batch Alerts Modal */}
      {showBatchModal && (
        <div
          id="plans-batch-modal-backdrop"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs"
          onClick={(e) => {
            if (e.target === e.currentTarget && !batchProgress.isRunning) {
              setShowBatchModal(false);
            }
          }}
        >
          <div
            id="plans-batch-modal"
            className="relative w-full max-w-2xl rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden my-6"
            dir="rtl"
          >
            {/* Modal Header */}
            <div className="bg-gradient-to-r from-slate-900 via-emerald-950 to-slate-900 text-white px-6 py-4.5 border-b border-emerald-900/50 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="text-2xl">📢</span>
                <div>
                  <h3 className="text-base font-bold text-white">
                    إصدار تنبيهات تلقائية عبر واتساب للمتأخرين
                  </h3>
                  <p className="text-xs text-emerald-200 mt-0.5">
                    إرسال تذكيرات مخصصة وتحديث عمود "تاريخ آخر تذكير" تلقائياً
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={batchProgress.isRunning}
                onClick={() => setShowBatchModal(false)}
                className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors disabled:opacity-50"
              >
                ✕
              </button>
            </div>

            <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
              {batchNotice && (
                <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold flex items-center gap-2">
                  <span>✓</span>
                  <span>{batchNotice}</span>
                </div>
              )}

              {/* Notice & Counter */}
              <div className="flex items-center justify-between bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-xs">
                <div>
                  <span className="text-slate-600 block">إجمالي المرضى المتأخرين المتاح لهم واتساب:</span>
                  <span className="font-bold text-slate-800 text-sm">{overdueList.length} مريض</span>
                </div>
                <button
                  type="button"
                  disabled={batchProgress.isRunning}
                  onClick={toggleSelectAll}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors"
                >
                  {selectedPlanIds.size === overdueList.length ? "إلغاء تحديد الكل" : "تحديد الكل"}
                </button>
              </div>

              {/* Progress bar if running */}
              {batchProgress.isRunning && (
                <div className="space-y-1.5 bg-emerald-50 p-3 rounded-xl border border-emerald-200">
                  <div className="flex justify-between text-xs font-bold text-emerald-800">
                    <span>جارٍ معالجة التنبيهات...</span>
                    <span>
                      {batchProgress.currentIndex} من {batchProgress.total}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-emerald-200 overflow-hidden">
                    <div
                      className="h-full bg-emerald-600 transition-all duration-300"
                      style={{
                        width: `${(batchProgress.currentIndex / Math.max(1, batchProgress.total)) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Patients List with Checkboxes */}
              <div className="space-y-2 border border-slate-200 rounded-xl p-3 max-h-60 overflow-y-auto">
                {overdueList.map((plan) => {
                  const isChecked = selectedPlanIds.has(plan.id);
                  const reminderInfo = formatReminderDate(
                    plan.progress.lastReminderAt || plan.lastReminderAt,
                  );
                  return (
                    <label
                      key={plan.id}
                      className={`flex items-center justify-between p-2.5 rounded-lg border text-xs cursor-pointer transition-colors ${
                        isChecked ? "bg-emerald-50/70 border-emerald-300" : "bg-white border-slate-200"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={batchProgress.isRunning}
                          onChange={() => toggleSelectPlan(plan.id)}
                          className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500"
                        />
                        <div>
                          <span className="font-bold text-slate-800 block">{plan.patientName}</span>
                          <span className="text-[11px] text-slate-500 font-mono">
                            {plan.patientPhone} · {plan.title}
                          </span>
                        </div>
                      </div>
                      <div className="text-left">
                        <span className="font-black text-red-700 font-mono block">
                          {formatMoney(plan.progress.overdueMinor, base)}
                        </span>
                        <span className="text-[10px] text-slate-500 block">
                          آخر تذكير: {reminderInfo.text}
                        </span>
                      </div>
                    </label>
                  );
                })}
              </div>

              {/* Automated message preview */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-1.5 text-xs text-slate-600">
                <span className="font-bold text-slate-800 block flex items-center gap-1">
                  <span>✉️</span> نموذج نص التذكير التلقائي:
                </span>
                <div className="bg-white p-2.5 rounded-lg border border-slate-200 text-[11px] font-mono text-slate-700 leading-relaxed">
                  السلام عليكم [اسم المريض]،<br />
                  تذكير بقسط علاجكم المستحق [تاريخ الاستحقاق] بمبلغ [مبلغ القسط].<br />
                  نرجو التكرم بالمرور للسداد في موعد زيارتكم القادمة.<br />
                  دمتم بصحة وعافية — {clinicName || "عيادة الأسنان"}
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
              <button
                type="button"
                disabled={batchProgress.isRunning}
                onClick={() => setShowBatchModal(false)}
                className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 text-xs font-bold hover:bg-slate-100 transition-colors"
              >
                إغلاق
              </button>

              <button
                id="plans-start-batch-dispatch-btn"
                type="button"
                disabled={selectedPlanIds.size === 0 || batchProgress.isRunning}
                onClick={runBatchDispatch}
                className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-md shadow-emerald-600/20 transition-all flex items-center gap-1.5 disabled:opacity-50"
              >
                <span>🚀</span>
                <span>
                  {batchProgress.isRunning
                    ? "جارٍ إصدار التنبيهات..."
                    : `بدء إصدار التنبيهات (${selectedPlanIds.size} مريض)`}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
