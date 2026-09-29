import { CURRENCIES, type Currency } from "./money";

/**
 * ملخّص كشف حساب جهة (مختبر/مورّد) — لكل عملةٍ سطرها.
 *
 * فاتورة المورّد بالريال السعودي تبقى بالسعودي، وسند الصرف بالدولار يبقى
 * بالدولار: لا رقمٌ واحد يمزج العملات. والمسدَّد والمتبقي من لقطات السندات
 * (P0-2) بعملة الالتزام نفسه — فلا يتحرّك الكشف بتحرّك سعر الصرف.
 *
 * سند الإبطال مبلغه سالب ويشير لأصله، فيصافي الجمعُ نفسه تلقائيًّا.
 */

export interface StatementPayableLike {
  amountMinor: number;
  currency: Currency;
  settledMinor: number;
  remainingMinor: number;
  sourceType?: "operational" | "opening";
}

export interface StatementExpenseLike {
  amountMinor: number;
  currency: Currency;
  payableId: number | null;
}

export interface PartyCurrencyTotals {
  currency: Currency;
  /** مجموع الالتزامات (فواتير المورّد/أعمال المختبر) بهذه العملة. */
  owedMinor: number;
  /** ما سُدّد منها — بعملة الالتزام. */
  settledMinor: number;
  /** ما بقي عليها — بعملة الالتزام. */
  remainingMinor: number;
  /** ما صُرف فعلًا من الصندوق بهذه العملة (السندات مطروحًا منها الإبطالات). */
  paidMinor: number;
  /** ما صُرف بهذه العملة دون ربطٍ بفاتورةٍ بعينها (دفعة مقدّمة/على الحساب). */
  unlinkedPaidMinor: number;
  /** (FIA-1) رصيدٌ مقدَّم سابق لنا عند الجهة (قبل بدء النظام) بهذه العملة. */
  openingAdvanceMinor: number;
  /** (FIA-1) منه: الدَّين السابق لبدء النظام (رصيد افتتاحي) بهذه العملة — بعد التصحيحات. */
  openingOwedMinor: number;
}

export interface StatementAdvanceLike {
  amountMinor: number;
  currency: Currency;
}

export function partyStatementTotals(
  payables: readonly StatementPayableLike[],
  expenses: readonly StatementExpenseLike[],
  advances: readonly StatementAdvanceLike[] = [],
): PartyCurrencyTotals[] {
  const byCurrency = new Map<Currency, PartyCurrencyTotals>();
  const bucket = (currency: Currency): PartyCurrencyTotals => {
    let row = byCurrency.get(currency);
    if (!row) {
      row = {
        currency, owedMinor: 0, settledMinor: 0, remainingMinor: 0, paidMinor: 0, unlinkedPaidMinor: 0,
        openingAdvanceMinor: 0, openingOwedMinor: 0,
      };
      byCurrency.set(currency, row);
    }
    return row;
  };
  for (const payable of payables) {
    const row = bucket(payable.currency);
    row.owedMinor += payable.amountMinor;
    row.settledMinor += payable.settledMinor;
    row.remainingMinor += payable.remainingMinor;
    if (payable.sourceType === "opening") row.openingOwedMinor += payable.amountMinor;
  }
  for (const advance of advances) bucket(advance.currency).openingAdvanceMinor += advance.amountMinor;
  for (const expense of expenses) {
    const row = bucket(expense.currency);
    row.paidMinor += expense.amountMinor;
    if (expense.payableId === null) row.unlinkedPaidMinor += expense.amountMinor;
  }
  // ترتيب العملات ثابت (ريال يمني ثم سعودي ثم دولار) — والعملة الصفرية كلّها تُسقط.
  return CURRENCIES
    .map((currency) => byCurrency.get(currency))
    .filter((row): row is PartyCurrencyTotals => row !== undefined
      && (row.owedMinor !== 0 || row.paidMinor !== 0 || row.remainingMinor !== 0 || row.openingAdvanceMinor !== 0));
}
