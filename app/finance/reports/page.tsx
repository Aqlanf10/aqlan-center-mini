"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, isCurrency, type Currency } from "@/lib/money";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL, type ExpenseCategory } from "@/lib/expenses";
import { useSetting } from "@/components/SettingsProvider";
import { Logo } from "@/components/Icon";
import { PrintButton } from "@/components/PrintButton";
import { friendlyDateLong } from "@/lib/reminders";
import { addDays, clinicDateString } from "@/lib/schedule";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";

/**
 * التقرير المالي — يومي وشهري بنفس الشاشة.
 *
 * الفرق بينهما تاريخان لا منطقان. وبناء شاشتين كان يعني رقمين مختلفين لنفس اليوم
 * حين يختلف الحسابان بسطر — وهو ما يجعل صاحب العيادة لا يصدّق أيًّا منهما.
 *
 * والرقم الذي في الأعلى هو **الصافي**: المقبوض ناقص المسترد ناقص المصروف. «الدخل»
 * وحده رقمٌ يخدع: عيادة قبضت مليونًا وصرفت تسعمئة ألف لم تربح مليونًا.
 */

interface Summary {
  from: string; to: string;
  income: { byCurrency: Record<Currency, number>; baseTotalMinor: number; count: number };
  refunds: { baseTotalMinor: number; count: number };
  expenses: { byCategory: Record<string, number>; baseTotalMinor: number; count: number };
  netMinor: number;
  invoicedMinor: number;
  invoiceCount: number;
  patientCount: number;
  topServices: { name: string; count: number; totalMinor: number }[];
}

export default function FinanceReportsPage() {
  const baseSetting = useSetting("finance.base_currency");
  const base: Currency = isCurrency(baseSetting) ? baseSetting : "YER";
  const clinicName = useSetting("clinic.name");
  const doctor = useSetting("clinic.lead_doctor");
  const doctorTitle = useSetting("clinic.lead_doctor_title");
  const phone = useSetting("clinic.phone");
  const address = useSetting("clinic.address");
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);
  const monthStart = `${today.slice(0, 7)}-01`;

  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (start: string, end: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/finance/report?from=${start}&to=${end}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setSummary(payload as Summary);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(from, to); }, [from, to, load]);

  const presets: [string, string, string][] = [
    ["اليوم", today, today],
    ["أمس", addDays(today, -1), addDays(today, -1)],
    ["آخر ٧ أيام", addDays(today, -6), today],
    ["هذا الشهر", monthStart, today],
    ["الشهر الماضي", `${addDays(monthStart, -1).slice(0, 7)}-01`, addDays(monthStart, -1)],
  ];

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      {/* ترويسة الطباعة: التقرير المالي كان يُطبع بلا اسمٍ ولا شعار — والورقة
          المالية أشد الأوراق حاجةً إلى هويةٍ تحمّل مسؤولية أرقامها. */}
      <div className="mb-3 hidden print:block" dir="rtl">
        <div className="flex items-center gap-3 border-b-2 border-navy-900 pb-2">
          <Logo className="h-14 w-14 shrink-0" />
          <div className="min-w-0">
            <p className="text-base font-black leading-snug text-navy-950">{clinicName}</p>
            <p className="text-[10px] font-semibold text-slate-600">
              {doctor} — {doctorTitle}
            </p>
            <p className="text-[9px] text-slate-500">
              {address}
              {phone ? (
                <>
                  {address ? " · " : ""}
                  هاتف: <span dir="ltr">{phone}</span>
                </>
              ) : null}
            </p>
          </div>
          <p className="ms-auto shrink-0 text-xs font-bold text-navy-900">التقرير المالي</p>
        </div>
      </div>

      <PageHeader
        title="التقرير المالي"
        subtitle="الدخل والمصروف والصافي"
        links={[...financeLinks("/finance/reports"), { href: "/finance/commissions", label: "العمولات" }]}
      >
        <PrintButton />
      </PageHeader>

      <div className="mb-3 flex flex-wrap gap-1.5 print:hidden">
        {presets.map(([label, start, end]) => (
          <button key={label} onClick={() => { setFrom(start); setTo(end); }}
            className={`rounded-xl border px-3 py-1.5 text-xs font-bold ${
              from === start && to === end ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-slate-600"
            }`}>
            {label}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap gap-2 print:hidden">
        <label className="min-w-[8rem] flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">من</span>
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </label>
        <label className="min-w-[8rem] flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">إلى</span>
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </label>
      </div>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {loading && !summary ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : summary ? (
        <>
          <p className="mb-3 text-sm font-bold text-slate-600">
            {summary.from === summary.to
              ? friendlyDateLong(summary.from)
              : `${friendlyDateLong(summary.from)} — ${friendlyDateLong(summary.to)}`}
          </p>

          <section className={`mb-4 rounded-2xl border-2 p-4 text-center ${
            summary.netMinor >= 0 ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"
          }`}>
            <p className="text-2xl font-extrabold">{formatMoney(summary.netMinor, base)}</p>
            <p className="mt-1 text-[11px] font-bold text-slate-600">
              الصافي — المقبوض ناقص المسترد ناقص المصروف
            </p>
          </section>

          <section className="mb-4 grid grid-cols-3 gap-2" aria-label="الأرقام الرئيسية">
            <Stat label="قُبض" value={formatMoney(summary.income.baseTotalMinor, base)} tone="good" />
            <Stat label="صُرف" value={formatMoney(summary.expenses.baseTotalMinor, base)} tone="bad" />
            <Stat label="فُوتر" value={formatMoney(summary.invoicedMinor, base)} />
          </section>

          <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-bold">المقبوض بكل عملة</h2>
            <div className="grid gap-2 sm:grid-cols-3">
              {CURRENCIES.map((currency) => (
                <div key={currency} className="rounded-xl border border-slate-200 p-2 text-center">
                  <p className="text-sm font-extrabold">{formatMoney(summary.income.byCurrency[currency], currency)}</p>
                  <p className="text-[11px] text-slate-500">{CURRENCY_LABEL[currency]}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              {summary.income.count} سند قبض · {summary.refunds.count} استرداد
              {summary.refunds.baseTotalMinor > 0 ? ` بقيمة ${formatMoney(summary.refunds.baseTotalMinor, base)}` : ""}
            </p>
          </section>

          <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-bold">المصروف حسب البند</h2>
            {summary.expenses.count === 0 ? (
              <p className="text-center text-sm text-slate-400">لا مصروفات في هذه المدة.</p>
            ) : (
              <ul className="space-y-1">
                {EXPENSE_CATEGORIES.filter((category) => (summary.expenses.byCategory[category] ?? 0) > 0)
                  .sort((a, b) => (summary.expenses.byCategory[b] ?? 0) - (summary.expenses.byCategory[a] ?? 0))
                  .map((category) => (
                    <li key={category} className="flex justify-between gap-3 text-sm">
                      <span className="text-slate-600">{EXPENSE_CATEGORY_LABEL[category as ExpenseCategory]}</span>
                      <span className="font-bold">{formatMoney(summary.expenses.byCategory[category], base)}</span>
                    </li>
                  ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-bold">أكثر الخدمات دخلًا</h2>
            {summary.topServices.length === 0 ? (
              <p className="text-center text-sm text-slate-400">لا فواتير في هذه المدة.</p>
            ) : (
              <ul className="space-y-1">
                {summary.topServices.map((service) => (
                  <li key={service.name} className="flex justify-between gap-3 text-sm">
                    <span className="truncate text-slate-600">{service.name} × {service.count}</span>
                    <span className="shrink-0 font-bold">{formatMoney(service.totalMinor, base)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-slate-400">
              {summary.invoiceCount} فاتورة لـ{summary.patientCount} مريضًا
            </p>
          </section>
        </>
      ) : null}
    </main>
  );
}

function Stat({ label, value, tone = "calm" }: { label: string; value: string; tone?: "calm" | "good" | "bad" }) {
  const tones = {
    calm: "border-slate-200 bg-white text-navy-900",
    good: "border-emerald-200 bg-emerald-50 text-emerald-800",
    bad: "border-red-200 bg-red-50 text-red-700",
  } as const;
  return (
    <div className={`rounded-2xl border p-3 text-center ${tones[tone]}`}>
      <p className="text-sm font-extrabold">{value}</p>
      <p className="text-[11px] font-bold opacity-70">{label}</p>
    </div>
  );
}
