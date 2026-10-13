import { CURRENCIES, CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";
import type { WorkflowSummary } from "./SummaryTab";

type FinancialSnapshot = NonNullable<WorkflowSummary["financial"]>;
type CurrencyRow = FinancialSnapshot;

/**
 * Read-only executive snapshot above the canonical PatientLedger.
 * Never computes across different currencies, never posts money and never
 * converts unknown historical treatment into a fabricated receivable.
 */
export function PatientPremiumAccountOverview({
  summary, base,
}: {
  summary: WorkflowSummary | null;
  base: Currency;
}) {
  // Finance values are omitted by the server for users without authority.
  if (!summary?.canSeeFinancial || !summary.financial) return null;

  const financial = summary.financial;
  const entries: { currency: Currency; row: CurrencyRow }[] = financial.byCurrency
    ? CURRENCIES.map((currency) => ({
        currency, row: financial.byCurrency![currency] as CurrencyRow,
      })).filter(({ row }) => [
        row.agreedMinor, row.agreementPaidMinor ?? 0, row.agreementRemainingMinor ?? 0,
        row.balanceMinor, row.invoicedMinor, row.paidMinor, row.openingMinor,
      ].some((amount) => amount !== 0))
    : [{ currency: base, row: financial }];

  if (entries.length === 0) return (
    <section aria-label="الملخص المالي الحالي" className="mb-4 rounded-2xl border border-sky-100 bg-white p-4">
      <h2 className="text-sm font-black text-brand-blue">ملخص الحساب</h2>
      <p className="mt-2 text-xs text-slate-600">لا توجد مبالغ مسجلة في القراءة المالية الحالية.</p>
    </section>
  );

  return (
    <section aria-label="الملخص المالي الحالي" data-testid="patient-premium-account-overview"
      className="mb-4 space-y-4 rounded-2xl border border-sky-100 bg-white p-3 shadow-card sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-black text-brand-blue">الملخص المالي للمريض</h2>
          <p className="mt-1 text-[11px] leading-5 text-slate-600">
            ملخص حسب العملة من سجل الحساب الحالي؛ الفواتير والدفعات والتصحيحات من سجل الحساب الرسمي أدناه.
          </p>
        </div>
        <span className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-[11px] font-bold text-orange-800">
          بدون دمج أرصدة العملات
        </span>
      </div>
      {entries.map(({ currency, row }) => {
        const due = row.balanceMinor;
        const agreementRemaining = row.agreementRemainingMinor;
        const cards = [
          { label: "إجمالي الاتفاق المسجل", amount: row.agreedMinor, color: "text-brand-blue", accent: "border-t-brand-blue" },
          { label: "المسدّد من الاتفاق", amount: row.agreementPaidMinor, color: "text-emerald-700", accent: "border-t-emerald-500" },
          { label: "المتبقي من الاتفاق", amount: agreementRemaining, color: "text-navy-800", accent: "border-t-sky-400" },
          { label: due > 0 ? "الرصيد المستحق حالياً" : due < 0 ? "رصيد لصالح المريض" : "الرصيد الحالي",
            amount: Math.abs(due), color: due > 0 ? "text-orange-700" : "text-emerald-700", accent: "border-t-brand-orange" },
        ];
        return (
          <div key={currency} className="space-y-2">
            <h3 className="text-xs font-black text-navy-900">{CURRENCY_LABEL[currency]}</h3>
            <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4" data-testid={`patient-finance-overview-${currency}`}>
              {cards.map((card) => (
                <div key={card.label} className={`min-w-0 rounded-xl border border-sky-100 border-t-[3px] bg-sky-50/30 p-3 ${card.accent}`}>
                  <p className="text-[11px] font-bold leading-5 text-slate-600">{card.label}</p>
                  <p className={`mt-1 break-words text-base font-black tabular-nums [overflow-wrap:anywhere] ${card.color}`}>
                    {card.amount === undefined ? "غير متاح" : formatMoney(card.amount, currency)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <p className="text-[11px] leading-5 text-slate-500">
        الرصيد الحالي مستقل عن المبلغ المتبقي من اتفاق العلاج؛ لا يُضاف أحدهما إلى الآخر.
      </p>
    </section>
  );
}
