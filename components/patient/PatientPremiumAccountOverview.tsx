"use client";

import { useState } from "react";
import styles from "./PatientOverview.module.css";
import { Icon, type IconName } from "../Icon";
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
  const [selectedCurrency, setSelectedCurrency] = useState<Currency>(base);
  // Finance values are omitted by the server for users without authority.
  if (!summary?.canSeeFinancial || !summary.financial) return null;

  const financial = summary.financial;
  const entries: { currency: Currency; row: CurrencyRow }[] = financial.byCurrency
    ? CURRENCIES.flatMap((currency) => {
        const row = financial.byCurrency?.[currency];
        if (!row) return []; // No synthetic empty financial bucket on partial reads.
        const amounts = [
          row.agreedMinor, row.agreementPaidMinor, row.agreementRemainingMinor,
          row.balanceMinor, row.invoicedMinor, row.paidMinor, row.openingMinor,
        ];
        return amounts.some((amount) => typeof amount === "number" && Number.isFinite(amount) && amount !== 0)
          ? [{ currency, row }] : [];
      })
    : [{ currency: base, row: financial }];

  if (entries.length === 0) return (
    <section aria-label="الملخص المالي الحالي" className="mb-4 rounded-2xl border border-sky-100 bg-white p-4">
      <h2 className="text-sm font-black text-brand-blue">ملخص الحساب</h2>
      <p className="mt-2 text-xs text-slate-600">لا تتوفر مبالغ تفصيلية لعرضها في هذه القراءة؛ راجع سجل الحساب الأصلي أدناه.</p>
    </section>
  );

  const currentCurrency = entries.some(entry => entry.currency === selectedCurrency) ? selectedCurrency : entries[0].currency;
  return (
    <section aria-label="الملخص المالي الحالي" data-testid="patient-premium-account-overview"
      className={styles.metrics}>
      <div className={styles.currencyChoices} role="group" aria-label="عملات ملخص الحساب">
        {entries.map(({currency}) => <button key={currency} type="button" aria-pressed={currency === currentCurrency}
          onClick={() => setSelectedCurrency(currency)}>{CURRENCY_LABEL[currency]}</button>)}
        {entries.length > 1 ? <span>حساب مستقل لكل عملة</span> : null}
      </div>
      {entries.map(({ currency, row }) => {
        const due = row.balanceMinor;
        const agreementRemaining = row.agreementRemainingMinor;
        const cards: { label: string; amount: number | undefined; tone: string; icon: IconName }[] = [
          { label: "إجمالي الاتفاق المسجل", amount: row.agreedMinor, tone: "agreed", icon: "clipboard" },
          { label: "المسدّد من الاتفاق", amount: row.agreementPaidMinor, tone: "paid", icon: "check" },
          { label: "المتبقي من الاتفاق", amount: agreementRemaining, tone: "remaining", icon: "wallet" },
          { label: due > 0 ? "الرصيد المستحق حالياً" : due < 0 ? "رصيد لصالح المريض" : "الرصيد الحالي",
            amount: Number.isFinite(due) ? Math.abs(due) : undefined, tone: due > 0 ? "due" : "paid", icon: "wallet" },
        ];
        return (
          <div key={currency} hidden={currency !== currentCurrency} aria-label={CURRENCY_LABEL[currency]}>
            <div className={styles.metricGrid} data-testid={`patient-finance-overview-${currency}`}>
              {cards.map((card) => (
                <div key={card.label} className={styles.metric} data-tone={card.tone}>
                  <dl><dt>{card.label}</dt><dd>{typeof card.amount === "number" && Number.isFinite(card.amount) ? formatMoney(card.amount, currency) : "غير متاح"}</dd></dl>
                  <span className={styles.metricIcon} aria-hidden="true"><Icon name={card.icon} className="h-6 w-6" /></span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <p className={styles.note}>
        الرصيد الحالي مستقل عن المبلغ المتبقي من اتفاق العلاج؛ لا يُضاف أحدهما إلى الآخر.
      </p>
    </section>
  );
}
