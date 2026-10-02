"use client";

import Link from "next/link";
import { formatMoney, type Currency } from "@/lib/money";

interface AccountBalanceItem {
  code: string;
  name: string;
  kind: "asset" | "liability" | "equity" | "revenue" | "expense";
  /** (TD-REG-028) عملة الرصيد — الحساب الواحد رصيدٌ لكل عملة. */
  currency: Currency;
  debitMinor: number;
  creditMinor: number;
}

const CURRENCY_LABEL: Record<Currency, string> = { YER: "ريال يمني", SAR: "ريال سعودي", USD: "دولار" };
const CURRENCIES: Currency[] = ["YER", "SAR", "USD"];

/** (TD-REG-028) ملخص عملةٍ واحدة — لا مجموع يجمع ريالًا يمنيًا مع سعودي أو دولار. */
function summarize(balances: AccountBalanceItem[], currency: Currency) {
  const rows = balances.filter((b) => b.currency === currency);
  const net = (kind: AccountBalanceItem["kind"], sign: 1 | -1) => rows
    .filter((b) => b.kind === kind && b.currency === currency)
    .reduce((sum, b) => sum + sign * (b.debitMinor - b.creditMinor), 0);
  const debit = rows.reduce((sum, b) => sum + (b.currency === currency ? b.debitMinor : 0), 0);
  const credit = rows.reduce((sum, b) => sum + (b.currency === currency ? b.creditMinor : 0), 0);
  const revenue = net("revenue", -1);
  const expense = net("expense", 1);
  return {
    currency, count: rows.length, debit, credit, balanced: debit === credit,
    assets: net("asset", 1), liabilities: net("liability", -1), revenue, expense, netIncome: revenue - expense,
  };
}

interface AccountingReportsTabProps {
  readState: "loading" | "ready" | "error";
  error: string | null;
  onRetry: () => void;
  balances: AccountBalanceItem[];
  cumulativeBalances: AccountBalanceItem[];
  throughDate: string;
  baseCurrency: Currency;
  isAdmin: boolean;
  entryCount?: number;
}

export function AccountingReportsTab({
  readState,
  error,
  onRetry,
  balances,
  cumulativeBalances,
  throughDate,
  baseCurrency,
  isAdmin,
  entryCount = 0,
}: AccountingReportsTabProps) {
  const groups = isAdmin && readState === "ready" ? CURRENCIES.map((currency) => {
    const period = summarize(balances, currency);
    const closing = summarize(cumulativeBalances, currency);
    return { ...period, closing };
  }).filter((group) => group.count > 0 || group.closing.count > 0) : [];
  const isBalanced = groups.length > 0 && groups.every((group) => group.balanced && group.closing.balanced);
  void baseCurrency;

  return (
    <div className="space-y-6">
      {/* حالة اتزان القيد المزدوج وميزان المراجعة */}
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-navy-900 text-white text-lg">
              📑
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-black text-navy-900">
                  الدفاتر والرقابة المحاسبية بالقيد المزدوج
                </h3>
                {isBalanced ? (
                  <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-black text-emerald-800">
                    المدين يساوي الدائن في كل عملة
                  </span>
                ) : groups.length > 0 ? (
                  <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-black text-amber-800">
                    تنبيه: يتطلب مراجعة التسوية
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                اتزان المدين والدائن فحص حسابي للقيود. مطابقة النقد الفعلي مع الصندوق فحص مستقل.
              </p>
            </div>
          </div>

          <Link
            href="/finance/accounting"
            className="flex items-center gap-1.5 rounded-xl bg-navy-900 px-3.5 py-2 text-xs font-black text-white hover:bg-navy-800 shadow-2xs transition-colors"
          >
            <span>دفتر الأستاذ وميزان المراجعة ↗</span>
          </Link>
        </div>

        {/* ملخص الميزان والقوائم — لكل عملة على حدة (TD-REG-028) */}
        {isAdmin ? (
          readState === "loading" ? (
            <div role="status" className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-600">
              جارٍ تحميل الدفاتر المحاسبية…
            </div>
          ) : readState === "error" ? (
            <div role="alert" className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-center text-xs text-red-700">
              <p>{error ?? "تعذّر تحميل الدفاتر المحاسبية."}</p>
              <button type="button" onClick={onRetry} className="mt-3 rounded-xl border border-red-300 bg-white px-3 py-2 font-bold">
                إعادة تحميل الدفاتر
              </button>
            </div>
          ) : groups.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-600">
              لا قيود حتى تاريخ التقرير.
            </div>
          ) : groups.map((group) => (
            <div key={group.currency} className="mt-4" data-testid={`accounting-summary-${group.currency}`}>
              <h4 className="mb-2 text-xs font-black text-navy-900">
                {CURRENCY_LABEL[group.currency]}
                <span className={`ms-2 rounded-full px-2 py-0.5 text-[10px] ${group.balanced && group.closing.balanced ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                  {group.balanced && group.closing.balanced ? "مدين = دائن" : "يتطلب مراجعة"}
                </span>
              </h4>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
                <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5">
                  <span className="text-slate-500 font-bold block">إجمالي الأصول</span>
                  <p className="mt-1 text-base font-mono font-black text-navy-900">{formatMoney(group.closing.assets, group.currency)}</p>
                  <span className="text-[10px] text-slate-400">رصيد تراكمي حتى {throughDate}</span>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5">
                  <span className="text-slate-500 font-bold block">إجمالي الخصوم</span>
                  <p className="mt-1 text-base font-mono font-black text-purple-900">{formatMoney(group.closing.liabilities, group.currency)}</p>
                  <span className="text-[10px] text-slate-400">رصيد تراكمي حتى {throughDate}</span>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5">
                  <span className="text-slate-500 font-bold block">إيرادات الفترة</span>
                  <p className="mt-1 text-base font-mono font-black text-sky-900">{formatMoney(group.revenue, group.currency)}</p>
                  <span className="text-[10px] text-slate-400">بعد الخصومات</span>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5">
                  <span className="text-slate-500 font-bold block">صافي ربح الفترة</span>
                  <p className={`mt-1 text-base font-mono font-black ${group.netIncome >= 0 ? "text-emerald-800" : "text-rose-700"}`}>
                    {formatMoney(group.netIncome, group.currency)}
                  </p>
                  <span className="text-[10px] text-slate-400">بعد المصروفات ({formatMoney(group.expense, group.currency)})</span>
                </div>
              </div>
              {entryCount > 0 ? (
                <div className="mt-2 flex items-center justify-between rounded-xl bg-slate-100/80 px-3 py-2 text-xs text-slate-600 font-mono">
                  <span>حركة الفترة · {CURRENCY_LABEL[group.currency]}</span>
                  <span>المدين: {formatMoney(group.debit, group.currency)} = الدائن: {formatMoney(group.credit, group.currency)}</span>
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-600">
            🔒 الدفاتر المحاسبية العامة وميزان المراجعة مخصصة للإدارة العليا والمدقق المالي.
          </div>
        )}
        {readState === "ready" && entryCount > 0 && isAdmin ? (
          <p className="mt-3 text-[11px] text-slate-500">قيود اليومية في الفترة: {entryCount} قيدًا — كل عملة ميزانها وحدها.</p>
        ) : null}
      </section>

      {/* الركائز الأربع للدفاتر والتقارير المحاسبية المتخصصة */}
      <section aria-label="الأنظمة المحاسبية المتخصصة" className="grid gap-3 sm:grid-cols-2">
        {/* نظام ١: الدفاتر المحاسبية */}
        <Link
          href="/finance/accounting"
          className="group flex flex-col justify-between rounded-3xl border border-slate-200 bg-white p-5 shadow-xs hover:border-navy-300 hover:shadow-md transition-all"
        >
          <div>
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="text-lg">📚</span>
                <h4 className="text-sm font-black text-navy-900 group-hover:text-brand-orange">
                  الدفاتر والقيود المحاسبية
                </h4>
              </div>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                GL & Trial
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-600 leading-relaxed">
              ميزان المراجعة التفصيلي، كشف الأستاذ العام لكل حساب، دفتر اليومية العامة، وتسجيل القيود
              اليدوية والتسويات.
            </p>
          </div>
          <span className="mt-4 text-xs font-bold text-navy-900 group-hover:text-brand-orange">
            فتح شاشة الدفاتر ↗
          </span>
        </Link>

        {/* نظام ٢: التقارير المالية والتحليلية */}
        <Link
          href="/finance/reports"
          className="group flex flex-col justify-between rounded-3xl border border-slate-200 bg-white p-5 shadow-xs hover:border-navy-300 hover:shadow-md transition-all"
        >
          <div>
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="text-lg">📊</span>
                <h4 className="text-sm font-black text-navy-900 group-hover:text-brand-orange">
                  التقارير المالية وقائمة الدخل
                </h4>
              </div>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                P&L & Analytics
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-600 leading-relaxed">
              قائمة الدخل والأرباح والخسائر، كشف التدفقات النقدية، هوامش الربحية للخدمات، ومؤشرات الأداء
              المالي الاستراتيجي.
            </p>
          </div>
          <span className="mt-4 text-xs font-bold text-navy-900 group-hover:text-brand-orange">
            فتح التقارير المالية ↗
          </span>
        </Link>

        {/* نظام ٣: الأرصدة الافتتاحية */}
        <Link
          href="/finance/opening"
          className="group flex flex-col justify-between rounded-3xl border border-slate-200 bg-white p-5 shadow-xs hover:border-navy-300 hover:shadow-md transition-all"
        >
          <div>
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="text-lg">🏁</span>
                <h4 className="text-sm font-black text-navy-900 group-hover:text-brand-orange">
                  الأرصدة الافتتاحية
                </h4>
              </div>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                Opening Balances
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-600 leading-relaxed">
              إدارة وضبط أرصدة بداية الفترة للصناديق النقدية بالعملات المختلفة، وحسابات الموردين والمعامل
              والشركاء.
            </p>
          </div>
          <span className="mt-4 text-xs font-bold text-navy-900 group-hover:text-brand-orange">
            ضبط الأرصدة الافتتاحية ↗
          </span>
        </Link>

        {/* نظام ٤: العملات الأجنبية — عرض ترجمة للعلم (TD-REG-028) */}
        <Link
          href="/finance/fx"
          className="group flex flex-col justify-between rounded-3xl border border-slate-200 bg-white p-5 shadow-xs hover:border-navy-300 hover:shadow-md transition-all"
        >
          <div>
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="text-lg">💱</span>
                <h4 className="text-sm font-black text-navy-900 group-hover:text-brand-orange">
                  العملات الأجنبية (للعلم)
                </h4>
              </div>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                FX Translation
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-600 leading-relaxed">
              ما نملكه من الريال السعودي والدولار بعملته في الدفاتر، وقيمته بسعر اليوم للعلم — الدفاتر
              بعملاتها الأصلية فلا يُرحَّل قيد إعادة تقييم.
            </p>
          </div>
          <span className="mt-4 text-xs font-bold text-navy-900 group-hover:text-brand-orange">
            عرض العملات الأجنبية ↗
          </span>
        </Link>
      </section>

      {/* ميثاق الحوكمة والأمان المحاسبي لمركز عقلان لطب الأسنان */}
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
        <h4 className="text-xs font-black text-navy-900 mb-2">
          ميثاق الحوكمة والرقابة المحاسبية الصارمة (Practice Governance Standards)
        </h4>
        <div className="grid gap-2.5 sm:grid-cols-3 text-xs">
          <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-3">
            <span className="font-black text-navy-900 block mb-1">1. فصل الصلاحيات والمهام</span>
            <p className="text-[11px] text-slate-500 leading-normal">
              موظف الاستقبال يقبض ويصدر السندات ولا يعدل التسعيرات أو يرى عمولات الأطباء، بينما الطبيب
              يوقع التشخيص دون التلاعب بالفواتير.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-3">
            <span className="font-black text-navy-900 block mb-1">2. حماية وتجميد التسعير</span>
            <p className="text-[11px] text-slate-500 leading-normal">
              تسعيرة الخدمات الطبية محكومة بدليل التسعير المعتمد، ولا يمكن منح خصومات استثنائية إلا
              وفق سياسة المركز الرقابية.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-3">
            <span className="font-black text-navy-900 block mb-1">3. مطابقة الصندوق اليومية</span>
            <p className="text-[11px] text-slate-500 leading-normal">
              كل وردية تُقفل بجرد نقدي إجباري، وأي فارق (عجز أو زيادة) يُسجل فوراً في سجل التدقيق
              ولا يُغلق الصندوق بصمت.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
