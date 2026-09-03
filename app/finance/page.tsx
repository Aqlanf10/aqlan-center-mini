"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CURRENCIES,
  CURRENCY_LABEL,
  CURRENCY_SHORT,
  formatMoney,
  isCurrency,
  parseAmount,
  type Currency,
} from "@/lib/money";
import { useSetting } from "@/components/SettingsProvider";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABEL,
  categoryForParty,
  expectedInBox,
  type ExpenseCategory,
  type PartyKind,
} from "@/lib/expenses";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks, FINANCE_PILLARS } from "@/components/financeLinks";
import { FinanceNavigation } from "@/components/FinanceNavigation";

interface Shift {
  id: number;
  openedBy: string;
  openedAt: string;
  opening: Record<Currency, number>;
  closedBy: string | null;
  closedAt: string | null;
  counted: Record<Currency, number> | null;
  note: string | null;
  status: "open" | "closed";
}

interface Payment {
  id: number;
  receiptNumber: string;
  patientId: number;
  patientName: string;
  kind: "payment" | "refund";
  amountMinor: number;
  currency: Currency;
  exchangeRate: number;
  baseAmountMinor: number;
  method: string;
  createdAt: string;
}

interface Expense {
  id: number;
  voucherNumber: string;
  category: ExpenseCategory;
  partyName: string | null;
  payeeText: string | null;
  amountMinor: number;
  currency: Currency;
  exchangeRate: number;
  baseAmountMinor: number;
  note: string | null;
  createdAt: string;
}

interface Party {
  id: number;
  name: string;
  kind: PartyKind;
  commissionPercent: number;
  isActive: boolean;
}

interface Feed {
  open: Shift | null;
  totals: { byCurrency: Record<Currency, number>; baseTotalMinor: number; paymentCount: number };
  expenseTotals: {
    byCategory: Record<ExpenseCategory, number>;
    byCurrency: Record<Currency, number>;
    baseTotalMinor: number;
    count: number;
  };
  payments: Payment[];
  expenses: Expense[];
  recent: Shift[];
}

interface DebtSummary {
  totalDueMinor: number;
  patientCount: number;
}

interface PlansSummary {
  activePlansCount: number;
  overdueCount: number;
}

const emptyAmounts = (): Record<Currency, string> => ({ YER: "", SAR: "", USD: "" });

export default function FinancePage() {
  const baseSetting = useSetting("finance.base_currency");
  const base: Currency = isCurrency(baseSetting) ? baseSetting : "YER";
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);

  const [activeView, setActiveView] = useState<"overview" | "shift">("overview");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [debtStats, setDebtStats] = useState<DebtSummary>({ totalDueMinor: 0, patientCount: 0 });
  const [plansStats, setPlansStats] = useState<PlansSummary>({ activePlansCount: 0, overdueCount: 0 });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(emptyAmounts);
  const [counted, setCounted] = useState(emptyAmounts);
  const [note, setNote] = useState("");
  const [closing, setClosing] = useState(false);
  const [parties, setParties] = useState<Party[]>([]);
  const [spending, setSpending] = useState(false);
  const [expenseForm, setExpenseForm] = useState({
    category: "lab" as ExpenseCategory,
    partyId: "",
    payee: "",
    amount: "",
    currency: base as Currency,
    note: "",
  });
  const [lastVoucherId, setLastVoucherId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [shiftsRes, partiesRes, debtsRes, plansRes] = await Promise.allSettled([
        fetch("/api/shifts", { cache: "no-store" }),
        fetch("/api/parties", { cache: "no-store" }),
        fetch("/api/finance/debts", { cache: "no-store" }),
        fetch("/api/plans", { cache: "no-store" }),
      ]);

      if (shiftsRes.status === "fulfilled" && shiftsRes.value.ok) {
        const payload = await shiftsRes.value.json();
        setFeed(payload as Feed);
      } else if (shiftsRes.status === "fulfilled") {
        const payload = await shiftsRes.value.json().catch(() => null);
        throw new Error(payload?.message ?? "تعذّر تحميل بيانات الصندوق.");
      }

      if (partiesRes.status === "fulfilled" && partiesRes.value.ok) {
        setParties(await partiesRes.value.json());
      }

      if (debtsRes.status === "fulfilled" && debtsRes.value.ok) {
        const debtPayload = await debtsRes.value.json();
        const rows: { dueMinor: number }[] = debtPayload.rows || [];
        const sumDue = rows.reduce((acc, r) => acc + (r.dueMinor || 0), 0);
        setDebtStats({ totalDueMinor: sumDue, patientCount: rows.length });
      }

      if (plansRes.status === "fulfilled" && plansRes.value.ok) {
        const plansPayload = await plansRes.value.json();
        const plans: { status: string; progress?: { overdueMinor: number } }[] = plansPayload.plans || [];
        const active = plans.filter((p) => p.status === "active");
        const overdue = active.filter((p) => (p.progress?.overdueMinor || 0) > 0);
        setPlansStats({ activePlansCount: active.length, overdueCount: overdue.length });
      }

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

  const expected = useMemo(() => {
    if (!feed?.open) return null;
    return expectedInBox(feed.open.opening, feed.totals.byCurrency, feed.expenseTotals.byCurrency);
  }, [feed]);

  const openShift = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر فتح الوردية.");
        return;
      }
      setOpening(emptyAmounts());
      setError(null);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  }, [busy, opening, load]);

  const spendVoucher = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(expenseForm),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر تسجيل الصرف.");
        return;
      }
      setLastVoucherId((payload as { id: number }).id);
      setExpenseForm((current) => ({ ...current, amount: "", note: "", payee: "" }));
      setSpending(false);
      setError(null);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  }, [busy, expenseForm, load]);

  const closeShift = useCallback(async () => {
    if (busy || !feed?.open) return;
    setBusy(true);
    try {
      const response = await fetch("/api/shifts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: feed.open.id, counted, note }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر الإغلاق.");
        return;
      }
      setCounted(emptyAmounts());
      setNote("");
      setClosing(false);
      setError(null);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  }, [busy, feed, counted, note, load]);

  return (
    <main className="mx-auto max-w-5xl p-4 pb-28">
      {/* الترويسة الرئيسية */}
      <PageHeader
        title="الإدارة المالية ودورة الإيرادات"
        subtitle={`المنظومة المالية المركزية الشاملة للمركز الطبي — ${friendlyDateLong(today)}`}
        links={financeLinks("/finance")}
      />

      {/* شريط التنقل بالركائز الأربع المعيارية */}
      <FinanceNavigation currentHref="/finance" />

      {error ? (
        <div role="alert" className="mb-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-bold">{error}</p>
        </div>
      ) : null}

      {/* شريط التبديل الرئيسي بين «لوحة القيادة ودورة الإيرادات» و«الصندوق والوردية الحالية» */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-100/80 p-1.5">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setActiveView("overview")}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-black transition-all ${
              activeView === "overview"
                ? "bg-white text-navy-900 shadow-sm"
                : "text-slate-600 hover:text-navy-900"
            }`}
          >
            <span>📊 المركز المالي ودورة الإيرادات</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveView("shift")}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-black transition-all ${
              activeView === "shift"
                ? "bg-white text-navy-900 shadow-sm"
                : "text-slate-600 hover:text-navy-900"
            }`}
          >
            <span>💵 الصندوق والوردية الحالية</span>
            {feed?.open ? (
              <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" title="وردية مفتوحة" />
            ) : (
              <span className="rounded-md bg-amber-100 px-1.5 py-0.2 text-[10px] font-bold text-amber-800">مغلق</span>
            )}
          </button>
        </div>

        {/* مؤشر حالة الوردية السريع */}
        <div className="flex items-center gap-2 pe-3 text-xs">
          <span className="text-slate-500">حالة الصندوق الآن:</span>
          {feed?.open ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 font-bold text-emerald-800">
              <span className="h-2 w-2 rounded-full bg-emerald-600 animate-ping" />
              وردية مفتوحة ({feed.open.openedBy})
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setActiveView("shift")}
              className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-3 py-1 font-extrabold text-amber-900 hover:bg-amber-200"
            >
              ⚠️ لا توجد وردية مفتوحة — انقر للفتح
            </button>
          )}
        </div>
      </div>

      {activeView === "overview" ? (
        <div className="space-y-6">
          {/* ١. بطاقات النبض المالي الحي (Live Practice Financial Health Indicators) */}
          <section aria-label="مؤشرات النبض المالي الحي" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {/* مقبوضات الوردية الحالية */}
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
              <div className="flex items-center justify-between pb-1">
                <span className="text-xs font-bold text-emerald-900">مقبوضات الوردية اليوم</span>
                <span className="rounded-md bg-emerald-200/80 px-1.5 py-0.5 text-[10px] font-bold text-emerald-900">
                  {feed?.totals.paymentCount || 0} سند
                </span>
              </div>
              <p className="mt-1 text-xl font-black text-emerald-900">
                {formatMoney(feed?.totals.baseTotalMinor || 0, base)}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-emerald-800 font-mono">
                {CURRENCIES.map((c) => {
                  const val = feed?.totals.byCurrency[c] || 0;
                  if (val === 0) return null;
                  return (
                    <span key={c} className="rounded bg-emerald-100 px-1.5 py-0.5 font-bold">
                      {formatMoney(val, c)}
                    </span>
                  );
                })}
              </div>
            </div>

            {/* مصروفات الصندوق النثري */}
            <div className="rounded-2xl border border-rose-200 bg-rose-50/70 p-4">
              <div className="flex items-center justify-between pb-1">
                <span className="text-xs font-bold text-rose-900">مصروفات الصندوق اليوم</span>
                <span className="rounded-md bg-rose-200/80 px-1.5 py-0.5 text-[10px] font-bold text-rose-900">
                  {feed?.expenseTotals.count || 0} سند
                </span>
              </div>
              <p className="mt-1 text-xl font-black text-rose-900">
                {formatMoney(feed?.expenseTotals.baseTotalMinor || 0, base)}
              </p>
              <p className="mt-2 text-[11px] font-medium text-rose-700">
                صافي سيولة الوردية: {formatMoney((feed?.totals.baseTotalMinor || 0) - (feed?.expenseTotals.baseTotalMinor || 0), base)}
              </p>
            </div>

            {/* ذمم وديون المرضى (Accounts Receivable) */}
            <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-4">
              <div className="flex items-center justify-between pb-1">
                <span className="text-xs font-bold text-blue-900">مديونيات المرضى</span>
                <Link
                  href="/finance/debts"
                  className="rounded-md bg-blue-200/80 px-1.5 py-0.5 text-[10px] font-bold text-blue-900 hover:bg-blue-300"
                >
                  أعمار الديون ↗
                </Link>
              </div>
              <p className="mt-1 text-xl font-black text-blue-900">
                {formatMoney(debtStats.totalDueMinor, base)}
              </p>
              <p className="mt-2 text-[11px] font-medium text-blue-700">
                موزعة على {debtStats.patientCount} مريضاً مسجلاً
              </p>
            </div>

            {/* خطط الأقساط العلاجية الجارية */}
            <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
              <div className="flex items-center justify-between pb-1">
                <span className="text-xs font-bold text-amber-900">خطط الأقساط العلاجية</span>
                <Link
                  href="/finance/plans"
                  className="rounded-md bg-amber-200/80 px-1.5 py-0.5 text-[10px] font-bold text-amber-900 hover:bg-amber-300"
                >
                  إدارة الأقساط ↗
                </Link>
              </div>
              <p className="mt-1 text-xl font-black text-amber-900">
                {plansStats.activePlansCount} خطة جارية
              </p>
              <p className="mt-2 text-[11px] font-medium text-amber-800">
                {plansStats.overdueCount > 0 ? (
                  <span className="font-bold text-rose-700">منها {plansStats.overdueCount} خطة متأخرة الدفع</span>
                ) : (
                  <span>جميع الأقساط منتظمة السداد</span>
                )}
              </p>
            </div>
          </section>

          {/* ٢. خريطة دورة الإيرادات والربط العلمي مع وحدة المرضى (Medical RCM Flow Map) */}
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xs">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-navy-900 text-white text-xs font-black">
                    RCM
                  </span>
                  <h2 className="text-base font-black text-navy-900">
                    دورة الإيرادات الطبية والارتباط العضوي بوحدة المرضى
                  </h2>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  المسار المعياري العالمي (Clinical-to-Financial RCM Workflow) — كيف يتدفق المال بين الطبيب والمريض والمحاسبة
                </p>
              </div>
              <Link
                href="/patients"
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-navy-900 hover:bg-slate-100"
              >
                تصفح سجل المرضى 👥
              </Link>
            </div>

            {/* مراحل التدفق السبعة */}
            <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-7 text-center">
              {/* مرحلة ١ */}
              <div className="relative rounded-2xl border border-slate-200 bg-slate-50/70 p-3 hover:border-slate-300">
                <span className="inline-block rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-black text-slate-700 mb-1">
                  المحطة ١
                </span>
                <h3 className="text-xs font-extrabold text-navy-900">ملف المريض والتشخيص</h3>
                <p className="mt-1 text-[11px] leading-tight text-slate-500">
                  فتح الملف، التشخيص السريري، وتحديد العملة المعتمدة.
                </p>
                <Link href="/patients" className="mt-2 block text-[10px] font-bold text-brand-orange hover:underline">
                  ملفات المرضى ↗
                </Link>
              </div>

              {/* مرحلة ٢ */}
              <div className="relative rounded-2xl border border-slate-200 bg-slate-50/70 p-3 hover:border-slate-300">
                <span className="inline-block rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-black text-slate-700 mb-1">
                  المحطة ٢
                </span>
                <h3 className="text-xs font-extrabold text-navy-900">خطة العلاج والتقسيط</h3>
                <p className="mt-1 text-[11px] leading-tight text-slate-500">
                  تسعير الخطة وجدولة دفعات التقويم والزراعة المطولة.
                </p>
                <Link href="/finance/plans" className="mt-2 block text-[10px] font-bold text-brand-orange hover:underline">
                  خطط الأقساط ↗
                </Link>
              </div>

              {/* مرحلة ٣ */}
              <div className="relative rounded-2xl border border-slate-200 bg-slate-50/70 p-3 hover:border-slate-300">
                <span className="inline-block rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-black text-slate-700 mb-1">
                  المحطة ٣
                </span>
                <h3 className="text-xs font-extrabold text-navy-900">الفوترة الآلية الفورية</h3>
                <p className="mt-1 text-[11px] leading-tight text-slate-500">
                  توليد الفاتورة آلياً عند توقيع الطبيب للزيارة السريرية.
                </p>
                <Link href="/finance/services" className="mt-2 block text-[10px] font-bold text-brand-orange hover:underline">
                  تسعير الخدمات ↗
                </Link>
              </div>

              {/* مرحلة ٤ */}
              <div className="relative rounded-2xl border border-emerald-300 bg-emerald-50/60 p-3 hover:border-emerald-400">
                <span className="inline-block rounded-full bg-emerald-200 px-2 py-0.5 text-[10px] font-black text-emerald-800 mb-1">
                  المحطة ٤
                </span>
                <h3 className="text-xs font-extrabold text-emerald-900">القبض بالصندوق</h3>
                <p className="mt-1 text-[11px] leading-tight text-emerald-800">
                  قبض المبلغ نقداً أو بالتحويل وإصدار السند الحراري.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveView("shift")}
                  className="mt-2 block w-full text-[10px] font-bold text-emerald-700 hover:underline"
                >
                  فتح الصندوق ↗
                </button>
              </div>

              {/* مرحلة ٥ */}
              <div className="relative rounded-2xl border border-slate-200 bg-slate-50/70 p-3 hover:border-slate-300">
                <span className="inline-block rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-black text-slate-700 mb-1">
                  المحطة ٥
                </span>
                <h3 className="text-xs font-extrabold text-navy-900">المختبر والعمولة</h3>
                <p className="mt-1 text-[11px] leading-tight text-slate-500">
                  خصم تكلفة معمل التركيبات واحتساب نسبة الطبيب المنفذ.
                </p>
                <Link href="/finance/lab-accounting" className="mt-2 block text-[10px] font-bold text-brand-orange hover:underline">
                  حسابات المعامل ↗
                </Link>
              </div>

              {/* مرحلة ٦ */}
              <div className="relative rounded-2xl border border-slate-200 bg-slate-50/70 p-3 hover:border-slate-300">
                <span className="inline-block rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-black text-slate-700 mb-1">
                  المحطة ٦
                </span>
                <h3 className="text-xs font-extrabold text-navy-900">الترحيل المحاسبي</h3>
                <p className="mt-1 text-[11px] leading-tight text-slate-500">
                  توليد قيود القيد المزدوج اليومية الآلية دون تدخل يدوي.
                </p>
                <Link href="/finance/accounting" className="mt-2 block text-[10px] font-bold text-brand-orange hover:underline">
                  الدفاتر والقيود ↗
                </Link>
              </div>

              {/* مرحلة ٧ */}
              <div className="relative rounded-2xl border border-slate-200 bg-slate-50/70 p-3 hover:border-slate-300">
                <span className="inline-block rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-black text-slate-700 mb-1">
                  المحطة ٧
                </span>
                <h3 className="text-xs font-extrabold text-navy-900">الرقابة والأرباح</h3>
                <p className="mt-1 text-[11px] leading-tight text-slate-500">
                  إقفال اليومية، ميزان المراجعة، ومؤشرات الأداء المالي.
                </p>
                <Link href="/finance/reports" className="mt-2 block text-[10px] font-bold text-brand-orange hover:underline">
                  التقارير المالية ↗
                </Link>
              </div>
            </div>
          </section>

          {/* ٣. مصفوفة الركائز الأربع المعيارية للإدارة المالية (The 4 Scientific Financial Pillars) */}
          <section aria-label="الركائز الأربع للإدارة المالية" className="grid gap-4 md:grid-cols-2">
            {FINANCE_PILLARS.map((pillar, pillarIdx) => (
              <div
                key={pillar.id}
                className="flex flex-col justify-between rounded-3xl border border-slate-200 bg-white p-5 shadow-xs transition-shadow hover:shadow-md"
              >
                <div>
                  <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                    <div>
                      <span className="text-[10px] font-bold tracking-wider text-brand-orange">
                        {["الركيزة الأولى", "الركيزة الثانية", "الركيزة الثالثة", "الركيزة الرابعة"][pillarIdx]}
                      </span>
                      <h3 className="text-base font-black text-navy-900">{pillar.name}</h3>
                    </div>
                    <span className="rounded-xl bg-slate-100 px-2.5 py-1 text-xs font-extrabold text-slate-700">
                      {pillar.badge}
                    </span>
                  </div>
                  <p className="my-3 text-xs leading-relaxed text-slate-600">{pillar.description}</p>
                  <div className="space-y-2">
                    {pillar.links.map((link) => (
                      <Link
                        key={link.href}
                        href={link.href}
                        className="group flex items-start justify-between rounded-xl border border-slate-100 bg-slate-50/70 p-2.5 transition-colors hover:border-navy-200 hover:bg-slate-100"
                      >
                        <div>
                          <p className="text-xs font-extrabold text-navy-900 group-hover:text-brand-orange">
                            {link.label}
                          </p>
                          <p className="text-[11px] text-slate-500">{link.description}</p>
                        </div>
                        <span className="text-slate-400 group-hover:text-navy-900">←</span>
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </section>

          {/* ٤. شريط الإجراءات والروابط السريعة (Quick Actions) */}
          <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="mb-2 text-xs font-black text-slate-500 uppercase tracking-wider">
              إجراءات مالية يومية سريعة
            </h3>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setActiveView("shift");
                  setSpending(true);
                }}
                className="rounded-xl bg-navy-900 px-3.5 py-2 text-xs font-extrabold text-white shadow-xs hover:bg-navy-800"
              >
                + سند صرف نثري فوري
              </button>
              <Link
                href="/finance/reconciliation"
                className="rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-navy-900 hover:bg-slate-50"
              >
                ⚖️ مطابقة وإقفال اليومية
              </Link>
              <Link
                href="/finance/debts"
                className="rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-navy-900 hover:bg-slate-50"
              >
                📑 أعمار ديون المرضى
              </Link>
              <Link
                href="/finance/lab-accounting"
                className="rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-navy-900 hover:bg-slate-50"
              >
                🦷 حسابات معامل الأسنان
              </Link>
              <Link
                href="/finance/expense-categories"
                className="rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-navy-900 hover:bg-slate-50"
              >
                🎯 ميزانيات المصروفات ونسب الانحراف
              </Link>
              <Link
                href="/finance/accounting"
                className="rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-navy-900 hover:bg-slate-50"
              >
                📚 شجرة الحسابات واليومية العامة
              </Link>
            </div>
          </section>
        </div>
      ) : (
        /* تبويب الصندوق وحركة الوردية (Cash Drawer & Shift Operations) */
        <div className="space-y-5">
          {loading && !feed ? (
            <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
              جارٍ التحميل…
            </p>
          ) : !feed?.open ? (
            <section className="rounded-3xl border-2 border-brand-orange bg-white p-6 shadow-sm" aria-label="فتح الوردية">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-100 text-amber-900 text-base">
                  🔐
                </span>
                <div>
                  <h2 className="text-base font-black text-navy-900">الصندوق مغلق — فتح وردية عمل جديدة</h2>
                  <p className="text-xs text-slate-500">
                    لا يمكن تسجيل أي قبض أو تحصيل من المرضى قبل فتح الوردية وتوثيق عهدة الصندوق الافتتاحية.
                  </p>
                </div>
              </div>
              <p className="mb-4 text-xs leading-relaxed text-slate-600">
                أدخل النقد المتواجد في درج الصندوق الآن لكل عملة (اترك الحقل فارغاً أو صفراً إن لم يوجد رصيد افتتاحي):
              </p>
              <div className="mb-4 grid gap-3 sm:grid-cols-3">
                {CURRENCIES.map((currency) => (
                  <label key={currency} className="block rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                    <span className="mb-1 block text-xs font-bold text-navy-900">{CURRENCY_LABEL[currency]}</span>
                    <input
                      value={opening[currency]}
                      onChange={(event) => setOpening((current) => ({ ...current, [currency]: event.target.value }))}
                      inputMode="decimal"
                      dir="ltr"
                      placeholder="0.00"
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-mono font-bold outline-none focus:border-brand-blue"
                    />
                  </label>
                ))}
              </div>
              <button
                onClick={openShift}
                disabled={busy}
                className="w-full rounded-2xl bg-brand-orange py-3 text-sm font-extrabold text-white shadow-xs hover:brightness-105 disabled:opacity-50"
              >
                افتح وردية الصندوق الآن 🚀
              </button>
            </section>
          ) : (
            <>
              {/* الوردية المفتوحة والبيانات الحية */}
              <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xs" aria-label="الوردية المفتوحة">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-3 w-3 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-sm font-black text-navy-900">الوردية المفتوحة الحالية</span>
                  </div>
                  <span className="text-xs font-bold text-slate-500">
                    المسؤول: {feed.open.openedBy} · فُتحت الساعة:{" "}
                    {new Date(feed.open.openedAt).toLocaleTimeString("ar-YE-u-nu-latn", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>

                <div className="mb-4 grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-2xl bg-emerald-50 p-3">
                    <p className="text-base font-black text-emerald-800">
                      {formatMoney(feed.totals.baseTotalMinor, base)}
                    </p>
                    <p className="text-xs font-bold text-emerald-700">إجمالي المقبوض</p>
                  </div>
                  <div className="rounded-2xl bg-rose-50 p-3">
                    <p className="text-base font-black text-rose-700">
                      {formatMoney(feed.expenseTotals.baseTotalMinor, base)}
                    </p>
                    <p className="text-xs font-bold text-rose-600">إجمالي المصروف</p>
                  </div>
                  <div className="rounded-2xl bg-slate-100 p-3">
                    <p className="text-base font-black text-navy-900">
                      {formatMoney(feed.totals.baseTotalMinor - feed.expenseTotals.baseTotalMinor, base)}
                    </p>
                    <p className="text-xs font-bold text-slate-600">الصافي الحالي</p>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-3">
                  {CURRENCIES.map((currency) => (
                    <div key={currency} className="rounded-xl border border-slate-200 bg-slate-50/50 p-2.5 text-center">
                      <p className="text-sm font-mono font-black text-navy-900">
                        {formatMoney(expected?.[currency] ?? 0, currency)}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {CURRENCY_LABEL[currency]} — المتوقَّع في الصندوق
                      </p>
                    </div>
                  ))}
                </div>

                {!closing ? (
                  <div className="mt-4 flex flex-wrap gap-2.5">
                    <button
                      onClick={() => setSpending((open) => !open)}
                      className="flex-1 rounded-xl bg-navy-900 py-2.5 text-sm font-extrabold text-white hover:bg-navy-800"
                    >
                      {spending ? "إلغاء الصرف" : "+ سند صرف نثري"}
                    </button>
                    <button
                      onClick={() => setClosing(true)}
                      className="flex-1 rounded-xl border border-slate-300 bg-white py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"
                    >
                      إغلاق الوردية وجرد الصندوق 🔒
                    </button>
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="mb-2 text-xs font-black text-slate-700">الجرد الفعلي للنقدية في الصندوق الآن:</p>
                    <div className="mb-3 grid gap-2 sm:grid-cols-3">
                      {CURRENCIES.map((currency) => {
                        const countedMinor = parseAmount(counted[currency] || "0", currency);
                        const difference =
                          countedMinor === null || !expected ? null : countedMinor - expected[currency];
                        return (
                          <label key={currency} className="block rounded-xl border border-slate-200 bg-white p-2.5">
                            <span className="mb-1 block text-[11px] font-bold text-slate-500">
                              {CURRENCY_SHORT[currency]} — المتوقَّع {formatMoney(expected?.[currency] ?? 0, currency)}
                            </span>
                            <input
                              value={counted[currency]}
                              onChange={(event) =>
                                setCounted((current) => ({ ...current, [currency]: event.target.value }))
                              }
                              inputMode="decimal"
                              dir="ltr"
                              placeholder="0.00"
                              className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-mono font-bold"
                            />
                            {difference !== null && difference !== 0 ? (
                              <span
                                className={`mt-1 block text-[11px] font-bold ${
                                  difference < 0 ? "text-red-600" : "text-amber-600"
                                }`}
                              >
                                {difference < 0 ? "نقص" : "زيادة"} {formatMoney(Math.abs(difference), currency)}
                              </span>
                            ) : null}
                          </label>
                        );
                      })}
                    </div>
                    <input
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="ملاحظة الإقفال (اختياري) — سبب الفارق أو رقم الإيداع"
                      className="mb-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={closeShift}
                        disabled={busy}
                        className="flex-1 rounded-xl bg-navy-900 py-2.5 text-sm font-extrabold text-white disabled:opacity-50 hover:bg-navy-800"
                      >
                        تأكيد إغلاق الوردية وترحيل الجرد
                      </button>
                      <button
                        onClick={() => setClosing(false)}
                        className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-50"
                      >
                        إلغاء
                      </button>
                    </div>
                  </div>
                )}
              </section>

              {lastVoucherId ? (
                <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-center">
                  <p className="mb-2 text-sm font-bold text-emerald-800">سُجّل سند الصرف بنجاح في قيود الصندوق.</p>
                  <a
                    href={`/print/voucher/${lastVoucherId}`}
                    target="_blank"
                    rel="noopener"
                    onClick={() => setLastVoucherId(null)}
                    className="inline-block rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700"
                  >
                    طباعة سند الصرف 🖨️
                  </a>
                </div>
              ) : null}

              {/* نموذج تسجيل سند صرف جديد */}
              {spending ? (
                <section className="rounded-3xl border-2 border-navy-800 bg-white p-5 shadow-xs" aria-label="سند صرف">
                  <h2 className="mb-3 text-sm font-black text-navy-900">تسجيل سند صرف نثري جديد</h2>

                  <label className="mb-2 block">
                    <span className="mb-1 block text-xs font-bold text-slate-600">بند المصروف</span>
                    <select
                      value={expenseForm.category}
                      onChange={(event) =>
                        setExpenseForm((current) => ({
                          ...current,
                          category: event.target.value as ExpenseCategory,
                        }))
                      }
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    >
                      {EXPENSE_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {EXPENSE_CATEGORY_LABEL[category]}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="mb-2 block">
                    <span className="mb-1 block text-xs font-bold text-slate-600">الجهة / المورد المستفيد</span>
                    <select
                      value={expenseForm.partyId}
                      onChange={(event) => {
                        const party = parties.find((item) => String(item.id) === event.target.value);
                        setExpenseForm((current) => ({
                          ...current,
                          partyId: event.target.value,
                          category: party ? categoryForParty(party.kind) : current.category,
                        }));
                      }}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    >
                      <option value="">— جهة غير مسجّلة / مستفيد مباشر —</option>
                      {parties
                        .filter((party) => party.isActive)
                        .map((party) => (
                          <option key={party.id} value={party.id}>
                            {party.name}
                          </option>
                        ))}
                    </select>
                  </label>

                  {!expenseForm.partyId ? (
                    <input
                      value={expenseForm.payee}
                      onChange={(event) =>
                        setExpenseForm((current) => ({ ...current, payee: event.target.value }))
                      }
                      placeholder="اسم المستفيد المباشر"
                      aria-label="اسم المستفيد"
                      className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    />
                  ) : null}

                  <div className="mb-2 flex flex-wrap gap-2">
                    <input
                      value={expenseForm.amount}
                      onChange={(event) =>
                        setExpenseForm((current) => ({ ...current, amount: event.target.value }))
                      }
                      placeholder="المبلغ"
                      aria-label="المبلغ"
                      inputMode="decimal"
                      dir="ltr"
                      className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-base font-bold font-mono"
                    />
                    <select
                      value={expenseForm.currency}
                      onChange={(event) =>
                        setExpenseForm((current) => ({
                          ...current,
                          currency: event.target.value as Currency,
                        }))
                      }
                      aria-label="العملة"
                      className="w-36 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold"
                    >
                      {CURRENCIES.map((option) => (
                        <option key={option} value={option}>
                          {CURRENCY_LABEL[option]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <input
                    value={expenseForm.note}
                    onChange={(event) =>
                      setExpenseForm((current) => ({ ...current, note: event.target.value }))
                    }
                    placeholder="البيان وسبب الصرف بالتفصيل"
                    aria-label="البيان"
                    className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  />

                  <button
                    onClick={spendVoucher}
                    disabled={busy || !expenseForm.amount.trim()}
                    className="w-full rounded-xl bg-rose-700 py-2.5 text-sm font-extrabold text-white hover:bg-rose-800 disabled:opacity-50"
                  >
                    سجّل الصرف واطبع السند 🖨️
                  </button>
                </section>
              ) : null}

              {/* مصروفات الوردية */}
              {feed.expenses.length > 0 ? (
                <section aria-label="مصروفات الوردية">
                  <h2 className="mb-2 text-sm font-bold text-navy-900">مصروفات الوردية ({feed.expenses.length})</h2>
                  <ul className="space-y-2">
                    {feed.expenses.map((expense) => (
                      <li
                        key={expense.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-rose-200 bg-rose-50/60 p-3"
                      >
                        <div className="min-w-[9rem] flex-1">
                          <p className="truncate text-sm font-extrabold text-navy-900">
                            {expense.partyName ?? expense.payeeText}
                          </p>
                          <p className="text-[11px] text-slate-500">
                            {expense.voucherNumber} · {EXPENSE_CATEGORY_LABEL[expense.category]}
                            {expense.note ? ` · ${expense.note}` : ""}
                          </p>
                        </div>
                        <div className="text-left">
                          <p className="text-sm font-mono font-extrabold text-rose-700">
                            −{formatMoney(expense.amountMinor, expense.currency)}
                          </p>
                          {expense.currency !== base ? (
                            <p className="text-[11px] text-slate-400 font-mono">
                              = {formatMoney(expense.baseAmountMinor, base)}
                            </p>
                          ) : null}
                        </div>
                        <a
                          href={`/print/voucher/${expense.id}`}
                          target="_blank"
                          rel="noopener"
                          className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-slate-50"
                        >
                          طباعة
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {/* حركة المقبوضات وسندات القبض */}
              <section aria-label="حركة الوردية">
                <h2 className="mb-2 text-sm font-bold text-navy-900">
                  سندات التحصيل ومقبوضات المرضى ({feed.payments.length})
                </h2>
                {feed.payments.length === 0 ? (
                  <p className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400">
                    لم يُقبض أي مبلغ في هذه الوردية بعد.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {feed.payments.map((payment) => (
                      <li
                        key={payment.id}
                        className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-3 ${
                          payment.kind === "refund" ? "border-rose-200 bg-rose-50/70" : "border-slate-200 bg-white"
                        }`}
                      >
                        <div className="min-w-[9rem] flex-1">
                          <Link
                            href={`/patients/${payment.patientId}`}
                            className="block truncate text-sm font-extrabold text-navy-900 hover:text-brand-orange underline decoration-slate-300 underline-offset-4"
                          >
                            {payment.patientName}
                          </Link>
                          <p className="text-[11px] text-slate-500">
                            {payment.receiptNumber} · {payment.kind === "refund" ? "استرداد" : "قبض"}
                            {payment.currency !== base ? ` · سعر ${payment.exchangeRate}` : ""}
                          </p>
                        </div>
                        <div className="text-left">
                          <p
                            className={`text-sm font-mono font-extrabold ${
                              payment.kind === "refund" ? "text-rose-700" : "text-emerald-800"
                            }`}
                          >
                            {payment.kind === "refund" ? "−" : "+"}
                            {formatMoney(payment.amountMinor, payment.currency)}
                          </p>
                          {payment.currency !== base ? (
                            <p className="text-[11px] text-slate-400 font-mono">
                              = {formatMoney(payment.baseAmountMinor, base)}
                            </p>
                          ) : null}
                        </div>
                        <a
                          href={`/print/receipt/${payment.id}`}
                          target="_blank"
                          rel="noopener"
                          className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-slate-50"
                        >
                          طباعة السند
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}

          {/* سجل الورديات السابقة */}
          {feed?.recent?.length ? (
            <section aria-label="ورديات سابقة" className="mt-8 border-t border-slate-200 pt-5">
              <h2 className="mb-3 text-sm font-bold text-navy-900">سجل الورديات السابقة المغلقة</h2>
              <ul className="space-y-2">
                {feed.recent
                  .filter((shift) => shift.status === "closed")
                  .slice(0, 6)
                  .map((shift) => (
                    <li key={shift.id} className="rounded-2xl border border-slate-200 bg-white p-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-bold text-navy-900">
                          {friendlyDateLong(shift.openedAt.slice(0, 10))} · فتحها {shift.openedBy}
                        </span>
                        <span className="text-slate-500">أغلقها {shift.closedBy}</span>
                      </div>
                      {shift.counted ? (
                        <p className="mt-1 font-mono text-[11px] text-slate-600">
                          الجرد:{" "}
                          {CURRENCIES.filter((c) => shift.counted![c] > 0)
                            .map((c) => formatMoney(shift.counted![c], c))
                            .join(" · ") || "صفر"}
                        </p>
                      ) : null}
                      {shift.note ? <p className="mt-1 text-slate-500">ملاحظة: {shift.note}</p> : null}
                    </li>
                  ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </main>
  );
}
