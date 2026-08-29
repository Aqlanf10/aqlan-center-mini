"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, StatCard as Stat } from "@/components/PageHeader";
import { formatMoney } from "@/lib/money";
import {
  PERIOD_PRESET_LABEL,
  periodRange,
  type ExecutiveKpis,
  type PeriodPreset,
} from "@/lib/executive";
import { friendlyDateLong } from "@/lib/reminders";

/**
 * غرفة القيادة — شاشة المالك.
 *
 * قرارٌ لا أرقام: هل العيادة رابحة؟ كم عليها للمختبرات؟ وهل كراسيّا تعمل أم تنام؟
 * كل رقم مالي هنا من الدفاتر الرسمية حصرًا — نفس ميزان المراجعة الذي تُصدَّر منه
 * التقارير — فلا يمكن أن تخالف شاشةٌ الأرقام التي تُرى في المحاسبة.
 *
 * والفترة تُختار لا تُخمَّن: شهرٌ مكتمل يقول غير ما يقوله أسبوع.
 */

const PRESETS: PeriodPreset[] = ["thisMonth", "lastMonth", "last3", "thisYear", "lastYear"];

export default function ExecutivePage() {
  const [preset, setPreset] = useState<PeriodPreset | null>("thisMonth");
  const [range, setRange] = useState(() => periodRange("thisMonth", new Date()));
  const [feed, setFeed] = useState<ExecutiveKpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (from: string, to: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/executive?from=${from}&to=${to}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setFeed(payload as ExecutiveKpis);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(range.from, range.to); }, [range, load]);

  const pickPreset = (next: PeriodPreset) => {
    setPreset(next);
    setRange(periodRange(next, new Date()));
  };

  const money = (minor: number) => feed ? formatMoney(minor, feed.baseCurrency) : "—";

  return (
    <main className="mx-auto max-w-4xl p-4 pb-24">
      <PageHeader
        title="غرفة القيادة"
        subtitle="مؤشرات المركز من الدفاتر الرسمية حصرًا"
      />

      {/* الفترة */}
      <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((option) => (
            <button key={option} onClick={() => pickPreset(option)}
              className={preset === option
                ? "rounded-xl bg-navy-800 px-3 py-2 text-sm font-bold text-white"
                : "rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:border-navy-300"}>
              {PERIOD_PRESET_LABEL[option]}
            </button>
          ))}
          {preset === null && (
            <span className="rounded-xl bg-navy-800 px-3 py-2 text-sm font-bold text-white">فترة مخصّصة</span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1">
            من
            <input type="date" value={range.from}
              onChange={(event) => { setPreset(null); setRange((r) => ({ ...r, from: event.target.value })); }}
              className="rounded-lg border border-slate-200 px-2 py-1.5" />
          </label>
          <label className="flex items-center gap-1">
            إلى
            <input type="date" value={range.to}
              onChange={(event) => { setPreset(null); setRange((r) => ({ ...r, to: event.target.value })); }}
              className="rounded-lg border border-slate-200 px-2 py-1.5" />
          </label>
          {feed && (
            <a href={`/api/executive?from=${range.from}&to=${range.to}&format=csv`}
              className="ms-auto rounded-xl border border-navy-200 bg-navy-50 px-3 py-2 text-sm font-bold text-navy-800 hover:bg-navy-100">
              تصدير CSV
            </a>
          )}
        </div>
      </section>

      {error && (
        <p className="mb-4 rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800">{error}</p>
      )}

      {loading && !feed && <p className="text-sm text-slate-500">جارٍ التحميل…</p>}

      {feed && (
        <>
          <p className="mb-4 text-xs text-slate-500">
            من {friendlyDateLong(feed.from)} إلى {friendlyDateLong(feed.to)} · العملة الأساسية {feed.baseCurrency}
          </p>

          {/* المالية — من الدفاتر */}
          <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="الإيرادات (مستحق)" value={money(feed.income.revenueMinor)} icon="wallet"
              hint="من الفواتير لا التحصيل — أساس الاستحقاق" />
            <Stat label="صافي الإيراد" value={money(feed.income.netRevenueMinor)} icon="wallet"
              hint={feed.income.discountMinor > 0 ? `بعد خصم ${money(feed.income.discountMinor)}` : undefined} />
            <Stat label="إجمالي المصروفات" value={money(feed.income.totalExpensesMinor)} icon="box" tone="warn"
              hint="من قائمة الدخل" />
            <Stat label="صافي الربح" value={money(feed.income.netProfitMinor)} icon="chart"
              tone={feed.income.netProfitMinor >= 0 ? "good" : "bad"}
              hint="الإيراد الصافي − المصروفات" />
          </section>

          {/* قائمة الدخل */}
          <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-black text-navy-900">قائمة الدخل — للفترة</h2>
            <table className="w-full text-sm">
              <tbody>
                <Row label="الإيرادات" value={money(feed.income.revenueMinor)} strong />
                <Row label="الخصومات الممنوحة" value={`(${money(feed.income.discountMinor)})`} muted={feed.income.discountMinor === 0} />
                <Row label="صافي الإيراد" value={money(feed.income.netRevenueMinor)} strong />
                {feed.income.expenses.map((expense) => (
                  <Row key={expense.code} label={expense.name} value={money(expense.amountMinor)} indent />
                ))}
                <Row label="إجمالي المصروفات" value={`(${money(feed.income.totalExpensesMinor)})`} indent />
                <Row label="صافي الربح" value={money(feed.income.netProfitMinor)} strong
                  valueClass={feed.income.netProfitMinor >= 0 ? "text-success-800" : "text-danger-800"} />
              </tbody>
            </table>
          </section>

          {/* حركة الصندوق */}
          <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-black text-navy-900">حركة الصندوق — للفترة</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="p-2 text-start font-bold">العملة</th>
                  <th className="p-2 text-end font-bold">ما دخل</th>
                  <th className="p-2 text-end font-bold">ما خرج</th>
                  <th className="p-2 text-end font-bold">الصافي</th>
                </tr>
              </thead>
              <tbody>
                {feed.collections.map((row) => (
                  <tr key={row.currency} className="border-t border-slate-100">
                    <td className="p-2 font-bold">{row.currency}</td>
                    <td className="p-2 text-end tabular-nums">{formatMoney(row.collectedMinor, row.currency)}</td>
                    <td className="p-2 text-end tabular-nums">{formatMoney(row.paidOutMinor, row.currency)}</td>
                    <td className="p-2 text-end font-bold tabular-nums">{formatMoney(row.netMinor, row.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">
              من مدين ودائن حساب النقدية في دفتر اليومية للفترة — نفس أرقام شاشة المحاسبة.
            </p>
          </section>

          {/* الذمم */}
          <section className="mb-6 grid gap-3 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-black text-navy-900">ما لنا — ذمم المرضى (تراكمي)</h2>
              <p className="text-2xl font-black tabular-nums text-navy-900">{money(feed.receivableMinor)}</p>
              <p className="mt-1 text-xs text-slate-500">رصيد حساب ذمم المرضى في الدفاتر حتى نهاية الفترة.</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-black text-navy-900">ما علينا — المعامل والموردين</h2>
              <p className="text-2xl font-black tabular-nums text-navy-900">{money(feed.payableMinor)}</p>
              {feed.parties.filter((party) => party.dueMinor > 0).length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-slate-600">
                  {feed.parties.filter((party) => party.dueMinor > 0).slice(0, 5).map((party) => (
                    <li key={`${party.kind}-${party.label}`} className="flex justify-between">
                      <span>{party.label}</span>
                      <span className="tabular-nums">{money(party.dueMinor)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* التشغيل */}
          <section className="mb-6">
            <h2 className="mb-3 text-sm font-black text-navy-900">التشغيل</h2>
            <div className="grid grid-cols-3 gap-3 lg:grid-cols-5">
              <Stat label="زيارات وصلت" value={feed.operational.arrived} />
              <Stat label="منتهية" value={feed.operational.done} tone="good" />
              <Stat label="ما زالت مفتوحة" value={feed.operational.stillOpen} tone={feed.operational.stillOpen > 0 ? "warn" : "calm"} />
              <Stat label="لم يحضر" value={feed.operational.noShow} tone={feed.operational.noShow > 0 ? "bad" : "calm"} />
              <Stat label="ملغاة" value={feed.operational.cancelled} />
              <Stat label="مرضى جدد" value={feed.operational.newPatients} hint="في الفترة" />
              <Stat label="إجمالي المرضى" value={feed.operational.totalPatients} />
              <Stat label="تقويم نشط" value={feed.operational.orthoActive} hint={`من ${feed.operational.orthoTotal} حالة`} />
              <Stat label="تنبيهات المخزون" value={feed.operational.inventoryAlerts}
                tone={feed.operational.inventoryAlerts > 0 ? "warn" : "calm"} hint="حد الطلب + الصلاحية" />
            </div>
          </section>

          {/* الإشغال */}
          <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-black text-navy-900">إشغال الكراسي</h2>
              <span className="text-2xl font-black text-navy-900 tabular-nums">{feed.occupancy.pct}%</span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100">
              <div className={feed.occupancy.pct >= 60 ? "h-full rounded-full bg-success-500"
                : feed.occupancy.pct >= 30 ? "h-full rounded-full bg-warning-400" : "h-full rounded-full bg-danger-400"}
              style={{ width: `${Math.min(100, feed.occupancy.pct)}%` }} />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {feed.occupancy.occupiedMinutes.toLocaleString("en")} دقيقة شغلًا من
              {" "}{feed.occupancy.capacityMinutes.toLocaleString("en")} دقيقة سعة
              {" "}({feed.occupancy.chairs} كراسٍ × {feed.occupancy.activeDays} يوم عمل فعلي × ساعات اليوم من الإعدادات).
              أيام الإغلاق لا تُحسب سعةً — فكرسيُّ عيادةٍ مغلقة ليس خاملًا.
            </p>
          </section>
        </>
      )}
    </main>
  );
}

function Row({ label, value, strong, indent, muted, valueClass }: {
  label: string;
  value: string;
  strong?: boolean;
  indent?: boolean;
  muted?: boolean;
  valueClass?: string;
}) {
  return (
    <tr className={strong ? "border-t border-slate-200" : "border-t border-slate-50"}>
      <td className={`p-2 ${strong ? "font-black text-navy-900" : muted ? "text-slate-400" : "text-slate-700"} ${indent ? "ps-6" : ""}`}>
        {label}
      </td>
      <td className={`p-2 text-end tabular-nums ${strong ? "font-black" : ""} ${valueClass ?? (muted ? "text-slate-400" : "text-slate-800")}`}>
        {value}
      </td>
    </tr>
  );
}
