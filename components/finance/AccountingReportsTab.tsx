"use client";

import Link from "next/link";
import { formatMoney, type Currency } from "@/lib/money";

interface AccountBalanceItem {
  code: string;
  name: string;
  kind: "asset" | "liability" | "equity" | "revenue" | "expense";
  debitMinor: number;
  creditMinor: number;
}

interface AccountingReportsTabProps {
  balances: AccountBalanceItem[];
  baseCurrency: Currency;
  isAdmin: boolean;
  entryCount?: number;
}

export function AccountingReportsTab({
  balances,
  baseCurrency,
  isAdmin,
  entryCount = 0,
}: AccountingReportsTabProps) {
  const totalDebit = balances.reduce((sum, b) => sum + b.debitMinor, 0);
  const totalCredit = balances.reduce((sum, b) => sum + b.creditMinor, 0);
  const isBalanced = totalDebit === totalCredit && balances.length > 0;

  // إجماليات حسب تصنيف الحسابات
  const assetsDebit = balances
    .filter((b) => b.kind === "asset")
    .reduce((sum, b) => sum + (b.debitMinor - b.creditMinor), 0);
  const liabilitiesCredit = balances
    .filter((b) => b.kind === "liability")
    .reduce((sum, b) => sum + (b.creditMinor - b.debitMinor), 0);
  const revenueCredit = balances
    .filter((b) => b.kind === "revenue")
    .reduce((sum, b) => sum + (b.creditMinor - b.debitMinor), 0);
  const expenseDebit = balances
    .filter((b) => b.kind === "expense")
    .reduce((sum, b) => sum + (b.debitMinor - b.creditMinor), 0);

  const netIncome = revenueCredit - expenseDebit;

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
                    ✓ ميزان المراجعة متزن 100%
                  </span>
                ) : balances.length > 0 ? (
                  <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-black text-amber-800">
                    تنبيه: يتطلب مراجعة التسوية
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                كل حركة مالية تُقيد في طرفين (مدين ودائن) آلياً دون تدخل يدوي لضمان عدم ضياع أي فلس
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

        {/* ملخص الميزان والقوائم */}
        {isAdmin ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5">
              <span className="text-slate-500 font-bold block">إجمالي الأصول (Assets)</span>
              <p className="mt-1 text-base font-mono font-black text-navy-900">
                {formatMoney(assetsDebit, baseCurrency)}
              </p>
              <span className="text-[10px] text-slate-400">النقدية بالصناديق والذمم المدينة</span>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5">
              <span className="text-slate-500 font-bold block">إجمالي الخصوم (Liabilities)</span>
              <p className="mt-1 text-base font-mono font-black text-purple-900">
                {formatMoney(liabilitiesCredit, baseCurrency)}
              </p>
              <span className="text-[10px] text-slate-400">مستحقات المعامل وموردي المواد</span>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5">
              <span className="text-slate-500 font-bold block">إيرادات الفترة (Revenue)</span>
              <p className="mt-1 text-base font-mono font-black text-sky-900">
                {formatMoney(revenueCredit, baseCurrency)}
              </p>
              <span className="text-[10px] text-slate-400">خدمات الأسنان والتركيبات</span>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5">
              <span className="text-slate-500 font-bold block">صافي ربح النشاط (Net Profit)</span>
              <p
                className={`mt-1 text-base font-mono font-black ${
                  netIncome >= 0 ? "text-emerald-800" : "text-rose-700"
                }`}
              >
                {formatMoney(netIncome, baseCurrency)}
              </p>
              <span className="text-[10px] text-slate-400">
                بعد حسم المصروفات والعمولات ({formatMoney(expenseDebit, baseCurrency)})
              </span>
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-600">
            🔒 الدفاتر المحاسبية العامة وميزان المراجعة مخصصة للإدارة العليا والمدقق المالي.
          </div>
        )}

        {/* إحصائية القيود المحاسبية */}
        {entryCount > 0 && isAdmin ? (
          <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-100/80 px-3 py-2 text-xs text-slate-600 font-mono">
            <span>إجمالي قيود اليومية المشتقة: {entryCount} قيد مزدوج</span>
            <span>المدين: {formatMoney(totalDebit, baseCurrency)} = الدائن: {formatMoney(totalCredit, baseCurrency)}</span>
          </div>
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

        {/* نظام ٤: إعادة تقييم العملات الأجنبية */}
        <Link
          href="/finance/fx"
          className="group flex flex-col justify-between rounded-3xl border border-slate-200 bg-white p-5 shadow-xs hover:border-navy-300 hover:shadow-md transition-all"
        >
          <div>
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="text-lg">💱</span>
                <h4 className="text-sm font-black text-navy-900 group-hover:text-brand-orange">
                  إعادة تقييم العملات الأجنبية
                </h4>
              </div>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                FX Revaluation
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-600 leading-relaxed">
              معالجة فروق أسعار الصرف الناتجة عن تذبذب الريال السعودي والدولار، وترحيل قيود أرباح وخسائر
              فروق العملة آلياً.
            </p>
          </div>
          <span className="mt-4 text-xs font-bold text-navy-900 group-hover:text-brand-orange">
            معالجة فروق العملة ↗
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
