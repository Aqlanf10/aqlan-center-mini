"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatMoney, type Currency } from "@/lib/money";
import { addDays, clinicDateString } from "@/lib/schedule";

export interface CommissionRowItem {
  doctorId: number;
  doctorName: string;
  commissionPercent: number;
  accruedMinor: number;
  earnedMinor: number;
  paidMinor: number;
  dueMinor: number;
}

interface CommissionsProfitabilityTabProps {
  rows: CommissionRowItem[];
  baseCurrency: Currency;
  isPersonalOnly: boolean;
  isAdmin: boolean;
  onOpenProfitability: () => void;
  onDateRangeChange: (from: string, to: string) => void;
  loading: boolean;
  error: string | null;
}

export function CommissionsProfitabilityTab({
  rows,
  baseCurrency,
  isPersonalOnly,
  isAdmin,
  onOpenProfitability,
  onDateRangeChange,
  loading,
  error,
}: CommissionsProfitabilityTabProps) {
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);
  const currentMonthStart = `${today.slice(0, 7)}-01`;
  const lastMonthStart = `${addDays(currentMonthStart, -1).slice(0, 7)}-01`;

  const [from, setFrom] = useState(currentMonthStart);
  const [to, setTo] = useState(today);

  const totalDue = useMemo(() => {
    return rows.reduce((sum, r) => sum + Math.max(0, r.dueMinor), 0);
  }, [rows]);

  const totalEarned = useMemo(() => {
    return rows.reduce((sum, r) => sum + r.earnedMinor, 0);
  }, [rows]);

  const totalAccrued = useMemo(() => {
    return rows.reduce((sum, r) => sum + r.accruedMinor, 0);
  }, [rows]);

  const totalPaid = useMemo(() => {
    return rows.reduce((sum, r) => sum + r.paidMinor, 0);
  }, [rows]);

  const applyRange = (newFrom: string, newTo: string) => {
    setFrom(newFrom);
    setTo(newTo);
    onDateRangeChange(newFrom, newTo);
  };

  return (
    <div className="space-y-6">
      {/* بطاقة الحوكمة والشفافية */}
      <section className="overflow-hidden rounded-3xl border border-amber-200 bg-gradient-to-r from-amber-50/80 via-white to-orange-50/80 p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-100 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-100 text-amber-900 text-lg">
              ⚖️
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm sm:text-base font-black text-navy-900">
                  {isPersonalOnly ? "مستحقاتي وعمولاتي السريرية" : "حوكمة عمولات ومستحقات الأطباء"}
                </h3>
                {isPersonalOnly && (
                  <span className="rounded-full bg-amber-200/80 px-2 py-0.5 text-[10px] font-black text-amber-900">
                    🔒 كشف شخصي محمي
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                احتساب دقيق قائم على التدفق الفعلي المحصل لا على المفوتر النظري
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-xl bg-white border border-amber-300 px-3 py-1.5 text-xs font-mono font-black text-amber-950 shadow-2xs">
              صافي المستحق للصرف: {formatMoney(totalDue, baseCurrency)}
            </span>
            <Link
              href="/finance/commissions"
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-900 hover:bg-slate-50 shadow-2xs"
            >
              كشف العمولات الموسع ↗
            </Link>
          </div>
        </div>

        {/* المبدأ المحاسبي المعياري */}
        <div className="mt-3 rounded-2xl bg-amber-100/50 p-3 text-xs leading-relaxed text-amber-950 border border-amber-200/60">
          <span className="font-black">📌 القاعدة الذهبية في حوكمة مركز عقلان الطبي:</span>{" "}
          العمولة تُحسب وتُصرف فقط على ما دخل الصندوق فعلياً من تحصيلات المريض (المحصّل)، ولا تُصرف على المفوتر
          قبل سداده، لضمان عدم الصرف من سيولة المركز لحالات غير مسددة.
        </div>
      </section>

      {/* شريط الفلاتر واختيار الفترة */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-500 font-bold pe-1">الفترة الزمنية:</span>
          <button
            type="button"
            onClick={() => applyRange(currentMonthStart, today)}
            className={`rounded-xl px-3 py-1.5 font-bold transition-all ${
              from === currentMonthStart && to === today
                ? "bg-navy-900 text-white shadow-2xs"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            الشهر الحالي
          </button>
          <button
            type="button"
            onClick={() => applyRange(lastMonthStart, addDays(currentMonthStart, -1))}
            className={`rounded-xl px-3 py-1.5 font-bold transition-all ${
              from === lastMonthStart
                ? "bg-navy-900 text-white shadow-2xs"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            الشهر الماضي
          </button>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <input
            type="date"
            value={from}
            onChange={(e) => applyRange(e.target.value, to)}
            className="rounded-xl border border-slate-200 px-2.5 py-1 text-xs font-mono font-bold"
          />
          <span className="text-slate-400">إلى</span>
          <input
            type="date"
            value={to}
            onChange={(e) => applyRange(from, e.target.value)}
            className="rounded-xl border border-slate-200 px-2.5 py-1 text-xs font-mono font-bold"
          />
        </div>
      </div>

      {/* خطأ التحميل أو غياب الصلاحية إن وجد */}
      {error ? (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-center text-xs text-amber-900">
          <p className="font-bold mb-1">🔒 تنبيه الصلاحيات والخصوصية</p>
          <p>{error}</p>
        </div>
      ) : loading ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
          جارٍ احتساب عمولات الأطباء وتدقيق التحصيلات…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
          لا توجد عمولات مسجلة للأطباء خلال هذه الفترة المحددة.
        </div>
      ) : (
        /* جدول كشف العمولات */
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-200/80 text-slate-500 font-bold">
                  <th className="pb-3 ps-2">الطبيب</th>
                  <th className="pb-3">النسبة</th>
                  <th className="pb-3">المفوتر (الإنتاج)</th>
                  <th className="pb-3">المحصّل الفعلي</th>
                  <th className="pb-3">المصروف سابقاً</th>
                  <th className="pb-3">الصافي المستحق للصرف</th>
                  <th className="pb-3 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.doctorId} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 ps-2">
                      <span className="font-black text-navy-900 block text-xs">
                        {row.doctorName}
                      </span>
                      <span className="text-[10px] text-slate-400">طبيب أسنان معتمد</span>
                    </td>
                    <td className="py-3 font-mono font-bold text-slate-700">
                      %{row.commissionPercent}
                    </td>
                    <td className="py-3 font-mono text-slate-500">
                      {formatMoney(row.accruedMinor, baseCurrency)}
                    </td>
                    <td className="py-3 font-mono font-bold text-sky-800">
                      {formatMoney(row.earnedMinor, baseCurrency)}
                    </td>
                    <td className="py-3 font-mono text-slate-600">
                      {formatMoney(row.paidMinor, baseCurrency)}
                    </td>
                    <td className="py-3 font-mono font-black text-emerald-800 text-sm">
                      {formatMoney(Math.max(0, row.dueMinor), baseCurrency)}
                    </td>
                    <td className="py-3 text-center">
                      {row.dueMinor > 0 ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-800">
                          مستحق للصرف
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                          خالص بالكامل
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50/60 font-black text-navy-900">
                  <td className="py-3 ps-2">الإجمالي العام</td>
                  <td className="py-3">—</td>
                  <td className="py-3 font-mono">{formatMoney(totalAccrued, baseCurrency)}</td>
                  <td className="py-3 font-mono text-sky-800">{formatMoney(totalEarned, baseCurrency)}</td>
                  <td className="py-3 font-mono">{formatMoney(totalPaid, baseCurrency)}</td>
                  <td className="py-3 font-mono text-emerald-800 text-sm">
                    {formatMoney(totalDue, baseCurrency)}
                  </td>
                  <td className="py-3 text-center">
                    <span className="text-[10px] text-slate-500">{rows.length} أطباء</span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* قسم محاكي وهوامش ربحية الحالات السريرية */}
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-100 text-emerald-800 text-sm font-black">
              📊
            </span>
            <div>
              <h4 className="text-sm font-black text-navy-900">
                محلل وهوامش ربحية الحالات السريرية (Clinical Case Profitability)
              </h4>
              <p className="text-xs text-slate-500 mt-0.5">
                حساب هامش ربح المركز بعد خصم عمولة الطبيب وتكلفة المعمل والمواد المستهلكة
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onOpenProfitability}
            className="flex items-center gap-1.5 rounded-xl bg-emerald-700 px-3.5 py-2 text-xs font-black text-white hover:bg-emerald-800 transition-colors shadow-2xs"
          >
            <span>📊</span>
            <span>تشغيل محاكي ربحية الحالات</span>
          </button>
        </div>

        {/* معادلة الربحية التوضيحية */}
        <div className="mt-4 grid gap-2 text-center sm:grid-cols-5 text-xs">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-2.5">
            <span className="text-[10px] text-slate-500 block">رسوم الإجراء (الفاتورة)</span>
            <span className="font-mono font-black text-navy-900 text-sm">100%</span>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-2.5">
            <span className="text-[10px] text-amber-800 block">− عمولة الطبيب المعالج</span>
            <span className="font-mono font-bold text-amber-900 text-sm">نسبة الإنتاج</span>
          </div>
          <div className="rounded-xl border border-purple-200 bg-purple-50/50 p-2.5">
            <span className="text-[10px] text-purple-800 block">− فاتورة معمل الأسنان</span>
            <span className="font-mono font-bold text-purple-900 text-sm">تكلفة التركيبات</span>
          </div>
          <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-2.5">
            <span className="text-[10px] text-rose-800 block">− المواد والمستهلكات</span>
            <span className="font-mono font-bold text-rose-900 text-sm">التكلفة المباشرة</span>
          </div>
          <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-2.5">
            <span className="text-[10px] text-emerald-800 block">= صافي هامش المركز</span>
            <span className="font-mono font-black text-emerald-900 text-sm">صافي المساهمة</span>
          </div>
        </div>
      </section>
    </div>
  );
}
