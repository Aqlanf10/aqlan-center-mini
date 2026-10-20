import { CURRENCIES, isCurrency, type Currency } from "./money";

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
  /** Actual current direct-link existence, preserving dangling historical IDs. */
  payableExists: boolean;
  /** Signed allocation paid_minor total, in this expense's payment currency.
   * Never use settled_minor here: that amount belongs to the payable currency. */
  allocatedPaidMinor: number;
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

export function partyStatementUnlinkedPaidMinor(expense: StatementExpenseLike): number {
  if (!Number.isSafeInteger(expense.amountMinor) || !Number.isSafeInteger(expense.allocatedPaidMinor)
    || typeof expense.payableExists !== "boolean") {
    throw new Error("Invalid party statement payment allocation");
  }
  const unlinked = expense.payableId === null || !expense.payableExists ? expense.amountMinor - expense.allocatedPaidMinor : 0;
  if (!Number.isSafeInteger(unlinked)) throw new Error("Invalid party statement payment allocation");
  return unlinked;
}

/** Invoice remaining and native party net are distinct: on-account payments
 * reduce only the latter, without pretending to settle a particular invoice. */
export function partyStatementNetMinor(row: Pick<PartyCurrencyTotals, "remainingMinor" | "unlinkedPaidMinor" | "openingAdvanceMinor">): number {
  const values = [row.remainingMinor, row.unlinkedPaidMinor, row.openingAdvanceMinor];
  const afterPayments = row.remainingMinor - row.unlinkedPaidMinor;
  const net = afterPayments - row.openingAdvanceMinor;
  if (!values.every(Number.isSafeInteger) || !Number.isSafeInteger(afterPayments) || !Number.isSafeInteger(net)) throw new Error("Invalid party statement balance");
  return net;
}

/** An absent/malformed read must not become the successful empty/settled state. */
export function readPartyStatementTotals(value: unknown): PartyCurrencyTotals[] {
  if (!Array.isArray(value)) throw new Error("تعذّر تحميل أرصدة الجهة.");
  const currencies = new Set<Currency>();
  const fields = ["owedMinor", "settledMinor", "remainingMinor", "paidMinor", "unlinkedPaidMinor", "openingAdvanceMinor", "openingOwedMinor"] as const;
  return value.map((candidate: unknown) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("تعذّر تحميل أرصدة الجهة.");
    const row = candidate as Record<string, unknown>;
    if (!isCurrency(row.currency) || currencies.has(row.currency) || !fields.every((key) => Number.isSafeInteger(row[key]))) {
      throw new Error("تعذّر تحميل أرصدة الجهة.");
    }
    currencies.add(row.currency);
    const total = row as unknown as PartyCurrencyTotals;
    partyStatementNetMinor(total);
    return total;
  });
}

export function partyStatementTotals(
  payables: readonly StatementPayableLike[],
  expenses: readonly StatementExpenseLike[],
  advances: readonly StatementAdvanceLike[] = [],
): PartyCurrencyTotals[] {
  const byCurrency = new Map<Currency, PartyCurrencyTotals>();
  const bucket = (currency: Currency): PartyCurrencyTotals => {
    if (!isCurrency(currency)) throw new Error("Invalid party statement currency");
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
    row.unlinkedPaidMinor += partyStatementUnlinkedPaidMinor(expense);
  }
  // ترتيب العملات ثابت (ريال يمني ثم سعودي ثم دولار) — والعملة الصفرية كلّها تُسقط.
  return readPartyStatementTotals(CURRENCIES
    .map((currency) => byCurrency.get(currency))
    .filter((row): row is PartyCurrencyTotals => row !== undefined
      && (row.owedMinor !== 0 || row.paidMinor !== 0 || row.remainingMinor !== 0 || row.unlinkedPaidMinor !== 0 || row.openingAdvanceMinor !== 0)));
}
