"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatMoney, isCurrency, type Currency } from "@/lib/money";
import { useSetting } from "@/components/SettingsProvider";
import { friendlyDateLong } from "@/lib/reminders";
import { addDays, clinicDateString } from "@/lib/schedule";

/**
 * عمولات الأطباء.
 *
 * الشاشة تعرض ثلاثة أرقام لكل طبيب لأن الخلط بينها هو ما يجعل صاحب العيادة يدفع من
 * جيبه:
 *
 * - **على الفواتير**: نسبته من قيمة ما عمله، حُصّل أو لم يُحصَّل.
 * - **المستحق**: نسبته من المال الذي دخل الصندوق فعلًا — وهو المعتمد للصرف.
 * - **المصروف**: ما دُفع له في هذه المدة.
 *
 * الفرق بين الأول والثاني هو المرضى الذين لم يدفعوا. وصرفُ العمولة على الأول يعني
 * أن تدفع عن مريض لم يدفع، ثم تطارده وحدك.
 */

interface CommissionRow {
  doctorId: number; doctorName: string; commissionPercent: number;
  accruedMinor: number; earnedMinor: number; paidMinor: number; dueMinor: number;
}

export default function CommissionsPage() {
  const baseSetting = useSetting("finance.base_currency");
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);
  const monthStart = `${today.slice(0, 7)}-01`;

  const [base, setBase] = useState<Currency>(isCurrency(baseSetting) ? baseSetting : "YER");
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [rows, setRows] = useState<CommissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (start: string, end: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/finance/commissions?from=${start}&to=${end}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setRows(payload.rows as CommissionRow[]);
      if (isCurrency(payload.baseCurrency)) setBase(payload.baseCurrency);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(from, to); }, [from, to, load]);

  const totalDue = rows.reduce((sum, row) => sum + Math.max(0, row.dueMinor), 0);
  const lastMonthStart = `${addDays(monthStart, -1).slice(0, 7)}-01`;

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <header className="mb-4">
        <h1 className="text-xl font-extrabold leading-tight">عمولات الأطباء</h1>
        <p className="text-xs text-slate-500">المستحق يُحسب على المحصّل لا على المفوتر</p>
        <nav className="mt-2 flex flex-wrap gap-1.5">
          <a href="/finance" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">الصندوق</a>
          <a href="/finance/parties" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">الأطباء والنسب</a>
          <a href="/finance/reports" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">التقرير</a>
        </nav>
      </header>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {([["هذا الشهر", monthStart, today], ["الشهر الماضي", lastMonthStart, addDays(monthStart, -1)]] as [string, string, string][]).map(
          ([label, start, end]) => (
            <button key={label} onClick={() => { setFrom(start); setTo(end); }}
              className={`rounded-xl border px-3 py-1.5 text-xs font-bold ${
                from === start && to === end ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-slate-600"
              }`}>
              {label}
            </button>
          ))}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
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

      <section className="mb-4 rounded-2xl border-2 border-brand-blue bg-white p-4 text-center">
        <p className="text-2xl font-extrabold">{formatMoney(totalDue, base)}</p>
        <p className="mt-1 text-[11px] font-bold text-slate-500">
          مستحق للأطباء عن {friendlyDateLong(from)} — {friendlyDateLong(to)}
        </p>
      </section>

      {loading && rows.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا عمولات في هذه المدة. تأكد من إسناد بنود الفواتير إلى الأطباء ومن ضبط نسبهم.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.doctorId} className="rounded-2xl border border-slate-200 bg-white p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-base font-extrabold">{row.doctorName}</span>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">
                  {row.commissionPercent}%
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-slate-50 p-2">
                  <p className="text-sm font-bold">{formatMoney(row.accruedMinor, base)}</p>
                  <p className="text-[11px] text-slate-500">على الفواتير</p>
                </div>
                <div className="rounded-xl bg-emerald-50 p-2">
                  <p className="text-sm font-extrabold text-emerald-800">{formatMoney(row.earnedMinor, base)}</p>
                  <p className="text-[11px] text-emerald-700">المستحق</p>
                </div>
                <div className="rounded-xl bg-slate-50 p-2">
                  <p className="text-sm font-bold">{formatMoney(row.paidMinor, base)}</p>
                  <p className="text-[11px] text-slate-500">صُرف</p>
                </div>
              </div>
              <p className={`mt-2 text-center text-sm font-extrabold ${
                row.dueMinor > 0 ? "text-brand-blue" : row.dueMinor < 0 ? "text-red-700" : "text-slate-400"
              }`}>
                {row.dueMinor > 0
                  ? `الباقي له: ${formatMoney(row.dueMinor, base)}`
                  : row.dueMinor < 0
                    ? `صُرف له زيادة: ${formatMoney(-row.dueMinor, base)}`
                    : "لا مستحق"}
              </p>
              {row.dueMinor > 0 ? (
                <a href="/finance" className="mt-2 block rounded-xl bg-brand-orange py-2 text-center text-xs font-bold text-white">
                  اصرف من الصندوق بسند عمولة
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-400">
        الفرق بين «على الفواتير» و«المستحق» هو المرضى الذين لم يدفعوا. الصرف يكون على
        المستحق: عمولةٌ على فاتورة لم تُحصَّل تعني أن تدفع عن مريض لم يدفع.
      </p>
    </main>
  );
}
