import {
  ACCOUNT_BY_CODE, LEDGER_CURRENCIES, balanceSheet, incomeStatement,
  inferAccountKind, naturalSide, trialBalance,
  type AccountBalance, type JournalEntry,
} from "./accounting";
import type { Currency } from "./money";

/** Read all available source history through the report end; never guess an opening date. */
export const LEDGER_HISTORY_START = "0001-01-01";

export interface AccountPeriodSummary extends Pick<AccountBalance, "code" | "name" | "kind" | "currency"> {
  /** Natural-side balance strictly before the selected first day. */
  openingBalanceMinor: number;
  periodDebitMinor: number;
  periodCreditMinor: number;
  /** Natural-side balance through the selected last day, inclusive. */
  closingBalanceMinor: number;
}

export interface AccountLedgerRow {
  date: string;
  source: string;
  reference: string;
  description: string;
  currency: Currency;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

/**
 * One source read, two time scopes. Sources already carry clinic calendar dates:
 * do not parse them as UTC instants or shift manual/opening dates a second time.
 * `balances` deliberately retains the historical period-activity API contract.
 */
export function accountingPeriod(entries: JournalEntry[], from: string, to: string) {
  // Legacy dateText sources omit leading zeroes for years before 1000.
  // Pad only that date representation, without parsing a timezone or changing facts.
  const datedEntries = entries.map((entry) => /^\d{1,3}-\d{2}-\d{2}$/.test(entry.date)
    ? { ...entry, date: entry.date.padStart(10, "0") } : entry);
  const throughEnd = datedEntries.filter((entry) => entry.date <= to);
  const periodEntries = throughEnd.filter((entry) => entry.date >= from);
  const balances = trialBalance(periodEntries);
  const cumulativeBalances = trialBalance(throughEnd);
  const periodByAccount = new Map(balances.map((row) => [`${row.code}|${row.currency}`, row]));
  const accountSummaries: AccountPeriodSummary[] = cumulativeBalances.map((row) => {
    const activity = periodByAccount.get(`${row.code}|${row.currency}`);
    return {
      code: row.code, name: row.name, kind: row.kind, currency: row.currency,
      openingBalanceMinor: row.balanceMinor - (activity?.balanceMinor ?? 0),
      periodDebitMinor: activity?.debitMinor ?? 0,
      periodCreditMinor: activity?.creditMinor ?? 0,
      closingBalanceMinor: row.balanceMinor,
    };
  });
  // Opening-only currencies remain visible, including zero period income.
  const statements = LEDGER_CURRENCIES
    .filter((currency) => cumulativeBalances.some((row) => row.currency === currency))
    .map((currency) => ({
      currency,
      income: incomeStatement(balances, currency),
      sheet: balanceSheet(cumulativeBalances, currency),
    }));
  return { balances, cumulativeBalances, accountSummaries, statements, entryCount: periodEntries.length, periodEntries };
}

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Stable documentary ordering within a day, not a claim of intraday chronology. */
export function accountLedger(report: ReturnType<typeof accountingPeriod>, account: string, currency: Currency) {
  const summary = report.accountSummaries.find((row) => row.code === account && row.currency === currency);
  const openingBalanceMinor = summary?.openingBalanceMinor ?? 0;
  const periodDebitMinor = summary?.periodDebitMinor ?? 0;
  const periodCreditMinor = summary?.periodCreditMinor ?? 0;
  const closingBalanceMinor = summary?.closingBalanceMinor ?? 0;
  const natural = naturalSide(ACCOUNT_BY_CODE.get(account)?.kind ?? inferAccountKind(account));
  let running = openingBalanceMinor;
  const rows: AccountLedgerRow[] = report.periodEntries
    .flatMap((entry) => entry.lines.map((line, lineIndex) => ({ entry, line, lineIndex })))
    .filter(({ line }) => line.accountCode === account && line.currency === currency)
    .sort((a, b) => compare(a.entry.date, b.entry.date)
      || compare(a.entry.source, b.entry.source)
      || compare(a.entry.reference, b.entry.reference)
      || a.lineIndex - b.lineIndex)
    .map(({ entry, line }) => {
      running += line.side === natural ? line.amountMinor : -line.amountMinor;
      return {
        date: entry.date, source: entry.source, reference: entry.reference, description: entry.description,
        currency: line.currency,
        debitMinor: line.side === "debit" ? line.amountMinor : 0,
        creditMinor: line.side === "credit" ? line.amountMinor : 0,
        balanceMinor: running,
      };
    });
  return { openingBalanceMinor, periodDebitMinor, periodCreditMinor, closingBalanceMinor, rows };
}
