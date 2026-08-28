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
 * أقساط العلاج المستحقة.
 *
 * الشاشة التي تجعل الأقساط تُحصَّل بدل أن تُنسى. ومريض التقويم لا يتغيّب عن الدفع
 * غالبًا — ينسى، لأن موعده الشهري لا يرتبط في ذهنه بمبلغ. رسالة قبل الموعد تُحصّل
 * أكثر مما تُحصّل مطالبة بعده.
 */

interface Plan {
  id: number; patientId: number; patientName: string; patientPhone: string | null;
  title: string; totalMinor: number; status: PlanStatus;
  progress: {
    totalMinor: number; dueToDateMinor: number; paidMinor: number; remainingMinor: number;
    overdueMinor: number; nextDueDate: string | null; nextDueAmountMinor: number;
    paidCount: number; count: number;
  };
}

type Filter = "overdue" | "soon" | "all";

const FILTER_LABEL: Record<Filter, string> = {
  overdue: "متأخرة",
  soon: "تستحق قريبًا",
  all: "كل الخطط الجارية",
};

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

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    if (filter === "overdue") {
      return plans.filter((plan) => plan.progress.overdueMinor > 0)
        .sort((a, b) => b.progress.overdueMinor - a.progress.overdueMinor);
    }
    if (filter === "soon") {
      // خلال أسبوعين: مدى يكفي لرسالة تذكير قبل الموعد لا بعده.
      const limit = new Date(`${today}T12:00:00`);
      limit.setDate(limit.getDate() + 14);
      const limitText = `${limit.getFullYear()}-${String(limit.getMonth() + 1).padStart(2, "0")}-${String(limit.getDate()).padStart(2, "0")}`;
      return plans.filter((plan) =>
        plan.progress.nextDueDate && plan.progress.nextDueDate <= limitText)
        .sort((a, b) => (a.progress.nextDueDate ?? "").localeCompare(b.progress.nextDueDate ?? ""));
    }
    return plans;
  }, [plans, filter, today]);

  const totals = useMemo(() => ({
    overdue: plans.reduce((sum, plan) => sum + plan.progress.overdueMinor, 0),
    remaining: plans.reduce((sum, plan) => sum + plan.progress.remainingMinor, 0),
    count: plans.length,
  }), [plans]);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <PageHeader
        title="أقساط العلاج"
        subtitle="الخطط الجارية وما استحقّ منها"
        links={financeLinks("/finance/plans")}
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      <section className="mb-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-extrabold text-red-700">{formatMoney(totals.overdue, base)}</p>
          <p className="text-[11px] font-bold text-red-600">متأخر</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-sm font-extrabold">{formatMoney(totals.remaining, base)}</p>
          <p className="text-[11px] font-bold text-slate-500">باقٍ على الخطط</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-sm font-extrabold">{totals.count}</p>
          <p className="text-[11px] font-bold text-slate-500">خطة جارية</p>
        </div>
      </section>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {(["overdue", "soon", "all"] as Filter[]).map((option) => (
          <button key={option} onClick={() => setFilter(option)}
            className={`rounded-xl border px-3 py-1.5 text-xs font-bold ${
              filter === option ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-slate-600"
            }`}>
            {FILTER_LABEL[option]}
          </button>
        ))}
      </div>

      {loading && plans.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center text-sm font-bold text-emerald-800">
          {filter === "overdue" ? "لا أقساط متأخرة." : "لا خطط في هذه القائمة."}
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((plan) => {
            const overdue = plan.progress.overdueMinor > 0;
            const number = toWhatsAppNumber(plan.patientPhone);
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
            return (
              <li key={plan.id} className={`flex flex-wrap items-center gap-2 rounded-2xl border p-3 ${
                overdue ? "border-red-300 bg-red-50" : "border-slate-200 bg-white"
              }`}>
                <div className="min-w-[9rem] flex-1">
                  <a href={`/patients/${plan.patientId}`} className="block truncate text-sm font-extrabold underline decoration-slate-300 underline-offset-4">
                    {plan.patientName}
                  </a>
                  <p className="text-[11px] text-slate-500">
                    {plan.title} · {plan.progress.paidCount}/{plan.progress.count} أقساط
                    {plan.progress.nextDueDate ? ` · القادم ${friendlyDateLong(plan.progress.nextDueDate)}` : ""}
                  </p>
                </div>
                <div className="text-left">
                  <p className={`text-sm font-extrabold ${overdue ? "text-red-700" : ""}`}>
                    {formatMoney(amount, base)}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    باقٍ {formatMoney(plan.progress.remainingMinor, base)}
                  </p>
                </div>
                {number ? (
                  <a href={`https://wa.me/${number}?text=${encodeURIComponent(text)}`}
                    target="_blank" rel="noopener"
                    className="shrink-0 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white">
                    تذكير
                  </a>
                ) : (
                  <span className="shrink-0 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-amber-600">
                    بلا رقم
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
