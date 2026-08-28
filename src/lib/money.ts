import type { Currency } from "@/db/schema/enums";

/**
 * Money helpers. Amounts are stored as PostgreSQL numeric(12,2) and come
 * back from Drizzle as strings. To avoid float drift, balances are
 * computed in minor units (halalas/cents) as integers.
 */

export type MoneyLike = { amount: string | number; currency: Currency };

/** "1234.50" | 1234.5 -> 123450 minor units. Returns NaN on garbage. */
export function toMinorUnits(amount: string | number): number {
  const value = typeof amount === "number" ? amount : parseFloat(amount);
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  return Math.round(value * 100);
}

/** 123450 -> "1234.50" */
export function fromMinorUnits(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}${whole}.${String(cents).padStart(2, "0")}`;
}

export type CurrencyBalances = Record<Currency, number>;

export const EMPTY_BALANCES: CurrencyBalances = { YER: 0, SAR: 0, USD: 0 };

/**
 * Balance per currency = sum(charges) - sum(payments).
 * Currencies are NEVER mixed into one total.
 */
export function computeBalances(
  charges: readonly MoneyLike[],
  payments: readonly MoneyLike[]
): CurrencyBalances {
  const balances: CurrencyBalances = { YER: 0, SAR: 0, USD: 0 };
  for (const charge of charges) {
    const minor = toMinorUnits(charge.amount);
    if (Number.isFinite(minor)) {
      balances[charge.currency] += minor;
    }
  }
  for (const payment of payments) {
    const minor = toMinorUnits(payment.amount);
    if (Number.isFinite(minor)) {
      balances[payment.currency] -= minor;
    }
  }
  return balances;
}

/** True when the balance for at least one currency is outstanding. */
export function hasOutstandingBalance(balances: CurrencyBalances): boolean {
  return (Object.values(balances) as number[]).some((minor) => minor > 0);
}

const currencyLocaleLabels: Record<Currency, string> = {
  YER: "YER",
  SAR: "SAR",
  USD: "USD",
};

/** Format a minor-unit balance for display, e.g. "12,500.00 YER". */
export function formatMoney(
  minor: number,
  currency: Currency,
  locale: "ar" | "en" = "ar"
): string {
  const formatted = new Intl.NumberFormat(
    locale === "ar" ? "ar-u-nu-latn" : "en",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 }
  ).format(Math.abs(minor) / 100);
  const sign = minor < 0 ? "-" : "";
  return `${sign}${formatted} ${currencyLocaleLabels[currency]}`;
}
