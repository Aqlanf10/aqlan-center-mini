"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, StatCard as Stat } from "@/components/PageHeader";
import { CURRENCY_LABEL, formatMoney } from "@/lib/money";
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
 * (P-01 owner review — تصحيح ١) الفواتير والذمم بعملة كل اتفاق من مراجعها
 * القانونية — لا رقم واحد يمزج عملات — والصندوق والمصروفات من الدفاتر
 * الأساسية الخالصة، وصافي الربح الموحّد مؤجَّل لتصميم الدفتر العميق (TD-REG-028).
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
        subtitle="الفواتير والذمم بعملة كل اتفاق، والصندوق والمصروفات من الدفاتر بالأساس"
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

          {/* المالية — فواتير الفترة لكل عملة من المرجع القانوني (تصحيح ١) */}
          <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {feed.billingByCurrency.length === 0 ? (
              <Stat label="صافي الفواتير" value="—" icon="wallet" hint="لا فواتير في الفترة" />
            ) : feed.billingByCurrency.map((row) => (
              <Stat key={row.currency}
                label={`صافي الفواتير — ${CURRENCY_LABEL[row.currency]}`}
                value={formatMoney(row.netMinor, row.currency)} icon="wallet"
                hint={row.discountMinor > 0
                  ? `بعد خصم ${formatMoney(row.discountMinor, row.currency)} — بعملة الفاتورة`
                  : "من الفواتير بعملتها — أساس الاستحقاق"} />
            ))}
            <Stat label="إجمالي المصروفات (بالأساس)" value={money(feed.totalExpensesMinor)} icon="box" tone="warn"
              hint="من قيود المصروفات — أساسها يمني خالص" />
          </section>

          {/* الفواتير لكل عملة + المصروفات بالأساس (تصحيح ١) */}
          <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-black text-navy-900">الفواتير — لكل عملة على حدة</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="p-2 text-start font-bold">العملة</th>
                  <th className="p-2 text-end font-bold">الإجمالي</th>
                  <th className="p-2 text-end font-bold">الخصومات</th>
                  <th className="p-2 text-end font-bold">الصافي</th>
                </tr>
              </thead>
              <tbody>
                {feed.billingByCurrency.length === 0 && (
                  <tr className="border-t border-slate-100">
                    <td className="p-2 text-slate-500" colSpan={4}>لا فواتير في الفترة</td>
                  </tr>
                )}
                {feed.billingByCurrency.map((row) => (
                  <tr key={row.currency} className="border-t border-slate-100">
                    <td className="p-2 font-bold">{CURRENCY_LABEL[row.currency]}</td>
                    <td className="p-2 text-end tabular-nums">{formatMoney(row.grossMinor, row.currency)}</td>
                    <td className="p-2 text-end tabular-nums text-slate-500">{row.discountMinor > 0 ? `(${formatMoney(row.discountMinor, row.currency)})` : "—"}</td>
                    <td className="p-2 text-end font-bold tabular-nums">{formatMoney(row.netMinor, row.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h2 className="mb-3 mt-5 text-sm font-black text-navy-900">المصروفات — بالأساس المسجَّل</h2>
            <table className="w-full text-sm">
              <tbody>
                {feed.expenses.map((expense) => (
                  <Row key={expense.code} label={expense.name} value={money(expense.amountMinor)} indent />
                ))}
                {feed.expenses.length === 0 && (
                  <Row label="لا مصروفات في الفترة" value="—" muted />
                )}
                <Row label="إجمالي المصروفات" value={`(${money(feed.totalExpensesMinor)})`} indent strong />
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">
              صافي الربح الموحّد لا يُعرض: الفواتير بعملاتها والمصروفات بالأساس، فلا رقم واحد يجمعهما بلا تحويلٍ مسجَّل سعره — حتى إعادة تمثيل الدفتر العميق (TD-REG-028).
            </p>
          </section>

          {/* حركة الصندوق — محاسبة بالأساس (المراجعة النهائية للمال ١) */}
          <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-black text-navy-900">حركة الصندوق — للفترة (بالمكافئ الأساسي)</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="p-2 text-start font-bold">الدرج</th>
                  <th className="p-2 text-end font-bold">ما دخل (ر.ي)</th>
                  <th className="p-2 text-end font-bold">ما خرج (ر.ي)</th>
                  <th className="p-2 text-end font-bold">الصافي (ر.ي)</th>
                </tr>
              </thead>
              <tbody>
                {feed.cashMovements.map((row) => (
                  <tr key={row.cashAccountCurrency} className="border-t border-slate-100">
                    <td className="p-2 font-bold">
                      صندوق {CURRENCY_LABEL[row.cashAccountCurrency]}
                      <span className="ms-1 text-xs font-normal text-slate-500">— المكافئ الأساسي</span>
                    </td>
                    <td className="p-2 text-end tabular-nums">{formatMoney(row.collectedBaseMinor, feed.baseCurrency)}</td>
                    <td className="p-2 text-end tabular-nums">{formatMoney(row.paidOutBaseMinor, feed.baseCurrency)}</td>
                    <td className="p-2 text-end font-bold tabular-nums">{formatMoney(row.netBaseMinor, feed.baseCurrency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">
              من مدين ودائن حسابات النقدية في دفتر اليومية للفترة — نفس أرقام شاشة المحاسبة. قيود الدفعات بمكافئها
              الأساسي المسجَّل بسعر يومها، وعملة الحساب هوية الدرج لا عملة المبلغ: حركة صندوق السعودي والدولار
              تُعرض بالريال اليمني (المكافئ الأساسي) — 1,500.00 ر.س @130 تظهر 195,000 ر.ي لا 1,950.00 ر.س.
              المبالغ الورقية الأصلية تُقرأ من مستندات القبض والصرف.
            </p>
          </section>

          {/* الذمم */}
          <section className="mb-6 grid gap-3 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-black text-navy-900">ما لنا — ذمم المرضى (تراكمي)</h2>
              {feed.receivableByCurrency.length === 0 ? (
                <p className="text-2xl font-black tabular-nums text-navy-900">—</p>
              ) : (
                <ul className="space-y-1.5">
                  {feed.receivableByCurrency.map((row) => (
                    <li key={row.currency} className="flex items-baseline justify-between">
                      <span className="text-sm font-bold text-slate-600">{CURRENCY_LABEL[row.currency]}</span>
                      <span className="text-2xl font-black tabular-nums text-navy-900">{formatMoney(row.dueMinor, row.currency)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-xs text-slate-500">من مرجع أرصدة المرضى بدلائل عملاتهم حتى نهاية الفترة — لا رقم دفترٍ ممزوج.</p>
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
