"use client";

import { CURRENCIES, formatMoney, type Currency } from "@/lib/money";

export type FinanceTab = "cash" | "receivables" | "commissions" | "accounting";

interface ShiftTotals {
  byCurrency: Record<Currency, number>;
  baseTotalMinor: number;
  paymentCount: number;
}

interface ExpenseTotals {
  baseTotalMinor: number;
  count: number;
  byCurrency: Record<Currency, number>;
}

interface FinanceKpisProps {
  activeTab: FinanceTab;
  onTabChange: (tab: FinanceTab) => void;
  baseCurrency: Currency;
  isShiftOpen: boolean;
  openedBy?: string | null;
  expectedInBox: Record<Currency, number> | null;
  shiftTotals: ShiftTotals | null;
  expenseTotals: ExpenseTotals | null;
  totalDebtsMinor: number;
  debtorsCount: number;
  overduePlansCount: number;
  totalLabPayablesMinor: number;
  unsettledLabOrdersCount: number;
  onOpenQuickCollect: () => void;
  onOpenNewExpense: () => void;
  onOpenCloseShift: () => void;
  onOpenLabReconcile: () => void;
  onOpenProfitability: () => void;
}

export function FinanceKpis({
  activeTab,
  onTabChange,
  baseCurrency,
  isShiftOpen,
  openedBy,
  expectedInBox,
  shiftTotals,
  expenseTotals,
  totalDebtsMinor,
  debtorsCount,
  overduePlansCount,
  totalLabPayablesMinor,
  unsettledLabOrdersCount,
  onOpenQuickCollect,
  onOpenNewExpense,
  onOpenCloseShift,
  onOpenLabReconcile,
  onOpenProfitability,
}: FinanceKpisProps) {
  const collectionsBase = shiftTotals?.baseTotalMinor ?? 0;
  const expensesBase = expenseTotals?.baseTotalMinor ?? 0;
  const netShiftCash = collectionsBase - expensesBase;

  const tabs: { id: FinanceTab; label: string; icon: string; badge?: string }[] = [
    {
      id: "cash",
      label: "الصندوق والعمليات اليومية",
      icon: "💵",
      badge: isShiftOpen ? "وردية نشطة" : "مغلق",
    },
    {
      id: "receivables",
      label: "الذمم والتحصيل والمعامل",
      icon: "👥",
      badge: debtorsCount > 0 ? `${debtorsCount} مدين` : undefined,
    },
    {
      id: "commissions",
      label: "عمولات الأطباء والربحية",
      icon: "🩺",
      badge: "الحوكمة والشفافية",
    },
    {
      id: "accounting",
      label: "الدفاتر والتقارير المحاسبية",
      icon: "📑",
      badge: "ميزان المراجعة",
    },
  ];

  return (
    <div className="mb-6 space-y-4">
      {/* ١. بطاقات النبض المالي الحي الخمس */}
      <section aria-label="مؤشرات النبض المالي الحي" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {/* بطاقة ١: سيولة الصندوق اللحظية */}
        <div
          onClick={() => onTabChange("cash")}
          className="group cursor-pointer rounded-2xl border border-emerald-200/90 bg-gradient-to-br from-emerald-50/90 via-white to-emerald-50/50 p-3.5 shadow-xs transition-all hover:border-emerald-400 hover:shadow-md"
        >
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs font-bold text-emerald-950">سيولة الصندوق الآن</span>
            {isShiftOpen ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-800">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 animate-ping" />
                مفتوح {openedBy ? `(${openedBy})` : ""}
              </span>
            ) : (
              <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-900">
                الصندوق مغلق
              </span>
            )}
          </div>
          <p className="mt-1 text-xl font-black text-emerald-900 font-mono">
            {formatMoney(isShiftOpen ? netShiftCash : 0, baseCurrency)}
          </p>
          <div className="mt-2 flex flex-wrap gap-1 text-[10px] font-mono">
            {CURRENCIES.map((c) => {
              const val = expectedInBox?.[c] ?? 0;
              if (val === 0) return null;
              return (
                <span
                  key={c}
                  className="rounded-md bg-emerald-100/90 px-1.5 py-0.5 font-black text-emerald-900"
                >
                  {formatMoney(val, c)}
                </span>
              );
            })}
          </div>
          <span className="mt-2.5 block text-[11px] font-bold text-emerald-700 group-hover:underline">
            إدارة حركة الصندوق ↗
          </span>
        </div>

        {/* بطاقة ٢: مقبوضات الوردية */}
        <div
          onClick={() => onTabChange("cash")}
          className="group cursor-pointer rounded-2xl border border-sky-200/90 bg-gradient-to-br from-sky-50/90 via-white to-sky-50/50 p-3.5 shadow-xs transition-all hover:border-sky-400 hover:shadow-md"
        >
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs font-bold text-sky-950">مقبوضات اليوم</span>
            <span className="rounded-md bg-sky-200/80 px-1.5 py-0.5 text-[10px] font-bold text-sky-900">
              {shiftTotals?.paymentCount || 0} سند
            </span>
          </div>
          <p className="mt-1 text-xl font-black text-sky-900 font-mono">
            {formatMoney(collectionsBase, baseCurrency)}
          </p>
          <p className="mt-2 text-[11px] font-medium text-sky-800">
            صافي النقد: {formatMoney(netShiftCash, baseCurrency)}
          </p>
          <span className="mt-2.5 block text-[11px] font-bold text-sky-700 group-hover:underline">
            كشف السندات والمقبوضات ↗
          </span>
        </div>

        {/* بطاقة ٣: مصروفات الصندوق */}
        <div
          onClick={() => onTabChange("cash")}
          className="group cursor-pointer rounded-2xl border border-rose-200/90 bg-gradient-to-br from-rose-50/90 via-white to-rose-50/50 p-3.5 shadow-xs transition-all hover:border-rose-400 hover:shadow-md"
        >
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs font-bold text-rose-950">مصروفات الصندوق</span>
            <span className="rounded-md bg-rose-200/80 px-1.5 py-0.5 text-[10px] font-bold text-rose-900">
              {expenseTotals?.count || 0} سند صرف
            </span>
          </div>
          <p className="mt-1 text-xl font-black text-rose-800 font-mono">
            {formatMoney(expensesBase, baseCurrency)}
          </p>
          <p className="mt-2 text-[11px] font-medium text-rose-700">
            المصروفات النثرية والتشغيلية
          </p>
          <span className="mt-2.5 block text-[11px] font-bold text-rose-700 group-hover:underline">
            كشف سندات الصرف ↗
          </span>
        </div>

        {/* بطاقة ٤: مديونيات المرضى (AR) */}
        <div
          onClick={() => onTabChange("receivables")}
          className="group cursor-pointer rounded-2xl border border-blue-200/90 bg-gradient-to-br from-blue-50/90 via-white to-blue-50/50 p-3.5 shadow-xs transition-all hover:border-blue-400 hover:shadow-md"
        >
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs font-bold text-blue-950">مديونيات المرضى (AR)</span>
            <span className="rounded-md bg-blue-200/80 px-1.5 py-0.5 text-[10px] font-bold text-blue-900">
              {debtorsCount} مريض
            </span>
          </div>
          <p className="mt-1 text-xl font-black text-blue-900 font-mono">
            {formatMoney(totalDebtsMinor, baseCurrency)}
          </p>
          <p className="mt-2 text-[11px] font-medium text-blue-800">
            {overduePlansCount > 0 ? (
              <span className="font-bold text-rose-700">{overduePlansCount} أقساط متأخرة</span>
            ) : (
              <span>الأقساط منتظمة</span>
            )}
          </p>
          <span className="mt-2.5 block text-[11px] font-bold text-blue-700 group-hover:underline">
            تحصيل وأعمار الديون ↗
          </span>
        </div>

        {/* بطاقة ٥: مستحقات معامل الأسنان (AP) */}
        <div
          onClick={() => onTabChange("receivables")}
          className="group cursor-pointer rounded-2xl border border-purple-200/90 bg-gradient-to-br from-purple-50/90 via-white to-purple-50/50 p-3.5 shadow-xs transition-all hover:border-purple-400 hover:shadow-md"
        >
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs font-bold text-purple-950">مستحقات المعامل (AP)</span>
            <span className="rounded-md bg-purple-200/80 px-1.5 py-0.5 text-[10px] font-bold text-purple-900">
              {unsettledLabOrdersCount} عمل معمل
            </span>
          </div>
          <p className="mt-1 text-xl font-black text-purple-900 font-mono">
            {formatMoney(totalLabPayablesMinor, baseCurrency)}
          </p>
          <p className="mt-2 text-[11px] font-medium text-purple-800">
            تركيبات وزراعة معلقة
          </p>
          <span className="mt-2.5 block text-[11px] font-bold text-purple-700 group-hover:underline">
            تسوية كشوفات المعامل ↗
          </span>
        </div>
      </section>

      {/* ٢. شريط الإجراءات السريعة البارزة */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-slate-200/80 bg-slate-900 p-2.5 text-white shadow-xs">
        <div className="flex items-center gap-2 pe-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-white/10 text-sm">
            ⚡
          </span>
          <span className="text-xs font-black tracking-wide text-slate-200">
            إجراءات سريعة فورية:
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* سند قبض سريع */}
          <button
            type="button"
            onClick={onOpenQuickCollect}
            className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-black text-white shadow-xs hover:bg-emerald-500 transition-colors"
          >
            <span>+</span>
            <span>سند قبض سريع</span>
          </button>

          {/* سند صرف نثري */}
          <button
            type="button"
            onClick={onOpenNewExpense}
            className="flex items-center gap-1.5 rounded-xl bg-rose-700 px-3.5 py-2 text-xs font-black text-white shadow-xs hover:bg-rose-600 transition-colors"
          >
            <span>−</span>
            <span>سند صرف نثري</span>
          </button>

          {/* إغلاق الوردية وجرد الصندوق */}
          {isShiftOpen ? (
            <button
              type="button"
              onClick={onOpenCloseShift}
              className="flex items-center gap-1.5 rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-black text-white shadow-xs hover:bg-amber-500 transition-colors"
            >
              <span>🔒</span>
              <span>إغلاق وجرد الوردية</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onTabChange("cash")}
              className="flex items-center gap-1.5 rounded-xl bg-brand-orange px-3.5 py-2 text-xs font-black text-white shadow-xs hover:brightness-110 transition-colors"
            >
              <span>🚀</span>
              <span>فتح وردية جديدة</span>
            </button>
          )}

          {/* تسوية كشف معمل */}
          <button
            type="button"
            onClick={onOpenLabReconcile}
            className="flex items-center gap-1.5 rounded-xl bg-purple-700 px-3 py-2 text-xs font-bold text-white shadow-xs hover:bg-purple-600 transition-colors"
          >
            <span>🦷</span>
            <span>تسوية معمل أسنان</span>
          </button>

          {/* محاكي ربحية الحالات */}
          <button
            type="button"
            onClick={onOpenProfitability}
            className="flex items-center gap-1.5 rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-xs font-bold text-slate-200 hover:bg-slate-700 hover:text-white transition-colors"
          >
            <span>📊</span>
            <span>ربحية الحالات</span>
          </button>
        </div>
      </div>

      {/* ٣. شريط التبويبات الأربعة الرئيسية المنظمة */}
      <div className="grid grid-cols-2 gap-1.5 rounded-2xl border border-slate-200 bg-slate-100/90 p-1.5 sm:grid-cols-4">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={`flex flex-col items-center justify-center gap-1 rounded-xl p-2.5 text-center transition-all ${
                isActive
                  ? "bg-white text-navy-900 shadow-sm ring-1 ring-slate-200"
                  : "text-slate-600 hover:bg-white/60 hover:text-navy-900"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-base">{tab.icon}</span>
                <span className="text-xs font-black">{tab.label}</span>
              </div>
              {tab.badge ? (
                <span
                  className={`rounded-md px-1.5 py-0.2 text-[10px] font-bold ${
                    isActive
                      ? "bg-navy-100 text-navy-900"
                      : "bg-slate-200/70 text-slate-600"
                  }`}
                >
                  {tab.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
