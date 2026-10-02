import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expenseEntry, invoiceEntry, paymentEntry, trialBalance,
  type AccountKind, type JournalEntry, type JournalLine,
} from "../lib/accounting";
import { accountLedger, accountingPeriod, LEDGER_HISTORY_START } from "../lib/accounting-reports";
import { FinancialCurrencyIntegrityError, type Currency } from "../lib/money";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn<() => Promise<{ username: string; role: string } | null>>(),
  journalEntries: vi.fn<(from: string, to: string) => Promise<JournalEntry[]>>(),
  createManualEntry: vi.fn(),
  isPeriodLocked: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("../lib/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("../lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  journalEntries: mocks.journalEntries,
  ManualEntryInvalidError: class extends Error {},
  createManualEntry: mocks.createManualEntry,
  isPeriodLocked: mocks.isPeriodLocked,
  recordAudit: mocks.recordAudit,
}));

const { GET, POST } = await import("../app/api/accounting/route");

const FROM = "2026-10-01";
const TO = "2026-10-02";

// All facts are synthetic and all source/database access is mocked. The prior
// invoice and receipt earn/collect 10,000; the selected period spends 2,000.
function cashHistory(): JournalEntry[] {
  return [
    invoiceEntry({ invoiceNumber: "SYN-SEP-INVOICE", date: "2026-09-30", patientName: "Synthetic",
      currency: "YER", totalMinor: 10_000, discountMinor: 0, cancelled: false })!,
    paymentEntry({ receiptNumber: "SYN-SEP-PAYMENT", date: "2026-09-30", patientName: "Synthetic",
      currency: "YER", amountMinor: 10_000, settlementCurrency: "YER", settlementMinor: 10_000, kind: "payment" })!,
    expenseEntry({ voucherNumber: "SYN-OCT-EXPENSE", date: FROM, payeeName: "Synthetic",
      category: "electricity", currency: "YER", amountMinor: 2_000, settlesPayable: false })!,
  ];
}

function posting(
  reference: string, date: string, account: string, side: JournalLine["side"],
  amountMinor: number, currency: Currency = "YER", source = "manual",
): JournalEntry {
  return {
    source, reference, date, description: `Synthetic ${reference}`,
    lines: [
      { accountCode: account, currency, side, amountMinor },
      { accountCode: account === "1101" ? "3101" : "1101", currency,
        side: side === "debit" ? "credit" : "debit", amountMinor },
    ],
  };
}

function mockHistory(entries: JournalEntry[]) {
  mocks.journalEntries.mockImplementation(async (from, to) =>
    entries.filter((entry) => entry.date >= from && entry.date <= to));
}

function request(query = "") {
  return new Request(`http://localhost/api/accounting?from=${FROM}&to=${TO}${query}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireSession.mockResolvedValue({ username: "synthetic-accountant", role: "admin" });
  mockHistory(cashHistory());
});

describe("accountingPeriod carry-forward", () => {
  it("keeps period activity distinct from opening and cumulative closing balances", () => {
    const report = accountingPeriod(cashHistory(), FROM, TO);

    expect(report.entryCount).toBe(1);
    expect(report.periodEntries.map((entry) => entry.reference)).toEqual(["SYN-OCT-EXPENSE"]);
    expect(report.balances).toEqual(trialBalance([cashHistory()[2]]));
    expect(report.balances.find((row) => row.code === "1101")).toMatchObject({
      currency: "YER", debitMinor: 0, creditMinor: 2_000, balanceMinor: -2_000,
    });
    expect(report.cumulativeBalances.find((row) => row.code === "1101")).toMatchObject({
      currency: "YER", debitMinor: 10_000, creditMinor: 2_000, balanceMinor: 8_000,
    });
    expect(report.accountSummaries.find((row) => row.code === "1101")).toMatchObject({
      code: "1101", name: expect.any(String), kind: "asset", currency: "YER",
      openingBalanceMinor: 10_000, periodDebitMinor: 0, periodCreditMinor: 2_000, closingBalanceMinor: 8_000,
    });
    expect(report.statements).toHaveLength(1);
    expect(report.statements[0]).toMatchObject({
      currency: "YER",
      income: { revenueMinor: 0, totalExpensesMinor: 2_000, netProfitMinor: -2_000 },
      sheet: { totalAssetsMinor: 8_000, retainedEarningsMinor: 8_000, equityMinor: 8_000, differenceMinor: 0 },
    });
  });

  it("retains opening-only accounts and currencies without inventing period activity", () => {
    const report = accountingPeriod([
      posting("SYN-YER", "2026-09-29", "1101", "debit", 1_000),
      posting("SYN-SAR", "2026-09-29", "3101", "credit", 2_500, "SAR"),
      posting("SYN-USD", "2026-09-30", "3101", "credit", 3_125, "USD"),
    ], FROM, TO);

    expect(report.balances).toEqual([]);
    expect(report.entryCount).toBe(0);
    expect(report.periodEntries).toEqual([]);
    expect(report.statements.map((row) => row.currency)).toEqual(["YER", "SAR", "USD"]);
    for (const [currency, balance] of [["YER", 1_000], ["SAR", 2_500], ["USD", 3_125]] as const) {
      expect(report.accountSummaries.find((row) => row.code === "3101" && row.currency === currency)).toMatchObject({
        openingBalanceMinor: balance, periodDebitMinor: 0, periodCreditMinor: 0, closingBalanceMinor: balance,
      });
      expect(report.statements.find((row) => row.currency === currency)).toMatchObject({
        income: { revenueMinor: 0, totalExpensesMinor: 0, netProfitMinor: 0 },
        sheet: { totalAssetsMinor: balance, capitalMinor: balance, retainedEarningsMinor: 0, differenceMinor: 0 },
      });
      expect(accountLedger(report, "3101", currency)).toEqual({
        openingBalanceMinor: balance, periodDebitMinor: 0, periodCreditMinor: 0, closingBalanceMinor: balance, rows: [],
      });
    }
  });

  it("returns empty statements and zero ledger summaries when no history exists", () => {
    const report = accountingPeriod([], FROM, TO);
    expect(report).toEqual({
      balances: [], cumulativeBalances: [], accountSummaries: [], statements: [], entryCount: 0, periodEntries: [],
    });
    expect(accountLedger(report, "1101", "YER")).toEqual({
      openingBalanceMinor: 0, periodDebitMinor: 0, periodCreditMinor: 0, closingBalanceMinor: 0, rows: [],
    });
  });

  it("uses clinic calendar dates inclusively and excludes facts after the report end", () => {
    const entries = [
      posting("SYN-OPEN", "2026-09-30", "1101", "debit", 1_000),
      posting("SYN-START", FROM, "1101", "debit", 100),
      posting("SYN-END", TO, "1101", "debit", 200),
      posting("SYN-FUTURE", "2026-10-03", "1101", "debit", 9_000),
    ];
    const report = accountingPeriod(entries, FROM, TO);
    expect(report.entryCount).toBe(2);
    expect(report.periodEntries.map((entry) => entry.reference)).toEqual(["SYN-START", "SYN-END"]);
    expect(accountLedger(report, "1101", "YER")).toMatchObject({
      openingBalanceMinor: 1_000, periodDebitMinor: 300, periodCreditMinor: 0, closingBalanceMinor: 1_300,
    });
    expect(accountLedger(accountingPeriod(entries, TO, TO), "1101", "YER")).toMatchObject({
      openingBalanceMinor: 1_100, periodDebitMinor: 200, periodCreditMinor: 0, closingBalanceMinor: 1_300,
      rows: [{ reference: "SYN-END", balanceMinor: 1_300 }],
    });
  });

  it("keeps an opening-only currency visible when another currency has period activity", () => {
    const report = accountingPeriod([
      ...cashHistory(),
      posting("SYN-USD-OPEN", "2026-09-30", "3101", "credit", 7_500, "USD"),
    ], FROM, TO);
    expect(report.balances.every((row) => row.currency === "YER")).toBe(true);
    expect(report.statements.map((row) => row.currency)).toEqual(["YER", "USD"]);
    expect(report.statements[1]).toMatchObject({
      currency: "USD", income: { netProfitMinor: 0 },
      sheet: { totalAssetsMinor: 7_500, capitalMinor: 7_500, differenceMinor: 0 },
    });
    expect(accountLedger(report, "1101", "YER").closingBalanceMinor).toBe(8_000);
    expect(accountLedger(report, "1101", "USD").closingBalanceMinor).toBe(7_500);
    expect(accountLedger(report, "1101", "SAR")).toEqual({
      openingBalanceMinor: 0, periodDebitMinor: 0, periodCreditMinor: 0, closingBalanceMinor: 0, rows: [],
    });
  });
});

describe("accountLedger carry-forward", () => {
  it("starts the first period row at opening plus movement instead of zero", () => {
    const ledger = accountLedger(accountingPeriod(cashHistory(), FROM, TO), "1101", "YER");
    expect(ledger).toMatchObject({
      openingBalanceMinor: 10_000, periodDebitMinor: 0, periodCreditMinor: 2_000, closingBalanceMinor: 8_000,
    });
    expect(ledger.rows).toEqual([expect.objectContaining({
      date: FROM, source: "expense", reference: "SYN-OCT-EXPENSE", currency: "YER",
      debitMinor: 0, creditMinor: 2_000, balanceMinor: 8_000,
    })]);
  });

  it("applies refunds and reversing entries without losing or re-counting opening cash", () => {
    const entries = cashHistory();
    const expense = entries[2];
    entries.push(
      paymentEntry({ receiptNumber: "SYN-REFUND", date: TO, patientName: "Synthetic", currency: "YER",
        amountMinor: 2_500, settlementCurrency: "YER", settlementMinor: 2_500, kind: "refund" })!,
      { ...expense, source: "reversal", reference: "SYN-EXPENSE-REVERSAL", date: "2026-10-03",
        lines: expense.lines.map((line) => ({ ...line, side: line.side === "debit" ? "credit" : "debit" })) },
    );
    const report = accountingPeriod(entries, FROM, "2026-10-03");
    const ledger = accountLedger(report, "1101", "YER");
    expect(ledger).toMatchObject({
      openingBalanceMinor: 10_000, periodDebitMinor: 2_000, periodCreditMinor: 4_500, closingBalanceMinor: 7_500,
    });
    expect(ledger.rows.map((row) => row.balanceMinor)).toEqual([8_000, 5_500, 7_500]);
    expect(report.statements[0]).toMatchObject({
      income: { totalExpensesMinor: 0, netProfitMinor: 0 },
      sheet: { totalAssetsMinor: 10_000, retainedEarningsMinor: 10_000, differenceMinor: 0 },
    });
  });

  it.each<[string, AccountKind, JournalLine["side"]]>([
    ["2101", "liability", "credit"], ["3101", "equity", "credit"], ["4101", "revenue", "credit"],
    ["2999", "liability", "credit"], ["3999", "equity", "credit"], ["4999", "revenue", "credit"],
    ["1999", "asset", "debit"], ["5999", "expense", "debit"],
  ])("uses the natural side of %s (%s), including inferred custom accounts", (account, kind, natural) => {
    const otherSide = natural === "debit" ? "credit" : "debit";
    const report = accountingPeriod([
      posting("SYN-OPEN", "2026-09-30", account, natural, 1_000),
      posting("SYN-INCREASE", FROM, account, natural, 200),
      posting("SYN-DECREASE", TO, account, otherSide, 50),
    ], FROM, TO);
    expect(report.accountSummaries.find((row) => row.code === account)).toMatchObject({
      kind, openingBalanceMinor: 1_000, closingBalanceMinor: 1_150,
    });
    const ledger = accountLedger(report, account, "YER");
    expect(ledger).toMatchObject({
      openingBalanceMinor: 1_000,
      periodDebitMinor: natural === "debit" ? 200 : 50,
      periodCreditMinor: natural === "credit" ? 200 : 50,
      closingBalanceMinor: 1_150,
    });
    expect(ledger.rows.map((row) => row.balanceMinor)).toEqual([1_200, 1_150]);
  });

  it("orders by date, source, reference, and line index without mutating the source", () => {
    const repeatedAccount: JournalEntry = {
      source: "manual", reference: "SYN-001", date: FROM, description: "Synthetic two cash lines",
      lines: [
        { accountCode: "1101", currency: "YER", side: "debit", amountMinor: 2 },
        { accountCode: "1101", currency: "YER", side: "credit", amountMinor: 1 },
        { accountCode: "3101", currency: "YER", side: "credit", amountMinor: 1 },
      ],
    };
    const entries = [
      posting("SYN-000", TO, "1101", "debit", 32, "YER", "expense"),
      posting("SYN-000", FROM, "1101", "debit", 16, "YER", "payment"),
      posting("SYN-002", FROM, "1101", "debit", 8),
      repeatedAccount,
      posting("SYN-OPEN", "2026-09-30", "1101", "debit", 100),
    ];
    const unchanged = structuredClone(entries);
    const report = accountingPeriod(entries, FROM, TO);
    const ledger = accountLedger(report, "1101", "YER");
    expect(ledger.rows.map((row) => [row.date, row.source, row.reference, row.debitMinor, row.creditMinor])).toEqual([
      [FROM, "manual", "SYN-001", 2, 0],
      [FROM, "manual", "SYN-001", 0, 1],
      [FROM, "manual", "SYN-002", 8, 0],
      [FROM, "payment", "SYN-000", 16, 0],
      [TO, "expense", "SYN-000", 32, 0],
    ]);
    expect(ledger.rows.map((row) => row.balanceMinor)).toEqual([102, 101, 109, 125, 157]);
    expect(ledger.closingBalanceMinor).toBe(157);
    expect(accountLedger(accountingPeriod([...entries].reverse(), FROM, TO), "1101", "YER")).toEqual(ledger);
    expect(entries).toEqual(unchanged);
  });
});

describe("GET /api/accounting carry-forward contract", () => {
  it("preserves legacy period balances while returning cumulative balances, summaries, and scoped statements", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ from: FROM, to: TO, entryCount: 1, baseCurrency: "YER" });
    expect(result.balances).toEqual(trialBalance([cashHistory()[2]]));
    expect(result.cumulativeBalances).toEqual(trialBalance(cashHistory()));
    expect(result.accountSummaries).toContainEqual(expect.objectContaining({
      code: "1101", currency: "YER", openingBalanceMinor: 10_000,
      periodDebitMinor: 0, periodCreditMinor: 2_000, closingBalanceMinor: 8_000,
    }));
    expect(result.statements).toContainEqual(expect.objectContaining({
      currency: "YER",
      income: expect.objectContaining({ netProfitMinor: -2_000 }),
      sheet: expect.objectContaining({ totalAssetsMinor: 8_000, retainedEarningsMinor: 8_000, differenceMinor: 0 }),
    }));
    expect(result).not.toHaveProperty("periodEntries");
    expect(mocks.journalEntries).toHaveBeenCalledExactlyOnceWith("0001-01-01", TO);
    expect(LEDGER_HISTORY_START).toBe("0001-01-01");
    expect(mocks.createManualEntry).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("returns all four minor-unit summaries at the root of an account response", async () => {
    const response = await GET(request("&account=1101&currency=YER"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      from: FROM, to: TO, account: "1101", currency: "YER", baseCurrency: "YER",
      openingBalanceMinor: 10_000, periodDebitMinor: 0, periodCreditMinor: 2_000, closingBalanceMinor: 8_000,
      rows: [{ date: FROM, reference: "SYN-OCT-EXPENSE", debitMinor: 0, creditMinor: 2_000, balanceMinor: 8_000 }],
    });
    expect(mocks.journalEntries).toHaveBeenCalledExactlyOnceWith("0001-01-01", TO);
  });

  it.each(["", "&account=1101&currency=YER"])("normalizes a reversed range before a single history read (%s)", async (query) => {
    const response = await GET(new Request(`http://localhost/api/accounting?from=${TO}&to=${FROM}${query}`));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ from: FROM, to: TO });
    if (query) expect(result.closingBalanceMinor).toBe(8_000);
    else expect(result.entryCount).toBe(1);
    expect(mocks.journalEntries).toHaveBeenCalledExactlyOnceWith("0001-01-01", TO);
  });

  it("returns an opening-only account even when the requested period has no rows", async () => {
    mockHistory([posting("SYN-OLD-USD", "2020-01-01", "3101", "credit", 8_123, "USD")]);
    const response = await GET(request("&account=3101&currency=USD"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      account: "3101", currency: "USD", openingBalanceMinor: 8_123,
      periodDebitMinor: 0, periodCreditMinor: 0, closingBalanceMinor: 8_123, rows: [],
    });
    expect(mocks.journalEntries).toHaveBeenCalledExactlyOnceWith("0001-01-01", TO);
  });

  it("preserves the existing base-currency fallback for a missing account currency", async () => {
    const response = await GET(request("&account=1101"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ currency: "YER", openingBalanceMinor: 10_000, closingBalanceMinor: 8_000 });
  });
});

describe("accounting authorization and integrity guards", () => {
  it.each(["admin", "accountant"])("allows %s to read carry-forward reports", async (role) => {
    mocks.requireSession.mockResolvedValue({ username: "synthetic-reader", role });
    expect((await GET(request())).status).toBe(200);
    expect(mocks.journalEntries).toHaveBeenCalledExactlyOnceWith("0001-01-01", TO);
  });

  it.each(["reception", "doctor", "cashier", "assistant"])("denies %s before reading any expanded financial history", async (role) => {
    mocks.requireSession.mockResolvedValue({ username: "synthetic-denied", role });
    expect((await GET(request())).status).toBe(403);
    expect(mocks.journalEntries).not.toHaveBeenCalled();
  });

  it("denies unauthenticated reads before loading any financial history", async () => {
    mocks.requireSession.mockResolvedValue(null);
    expect((await GET(request("&account=1101&currency=YER"))).status).toBe(401);
    expect(mocks.journalEntries).not.toHaveBeenCalled();
  });

  it("does not expand an accountant's read authorization into manual-entry writes", async () => {
    mocks.requireSession.mockResolvedValue({ username: "synthetic-reader", role: "accountant" });
    const response = await POST(new Request("http://localhost/api/accounting", { method: "POST", body: "{}" }));
    expect(response.status).toBe(403);
    expect(mocks.createManualEntry).not.toHaveBeenCalled();
    expect(mocks.isPeriodLocked).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it.each(["", "&account=1101&currency=YER"])("fails closed on currency corruption anywhere in the required history (%s)", async (query) => {
    mocks.journalEntries.mockRejectedValue(new FinancialCurrencyIntegrityError("synthetic-payment", "PRIVATE-SOURCE-ID", "EUR"));
    const response = await GET(request(query));
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result).toEqual({ message: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain("PRIVATE-SOURCE-ID");
    expect(JSON.stringify(result)).not.toContain("EUR");
    expect(mocks.journalEntries).toHaveBeenCalledExactlyOnceWith("0001-01-01", TO);
  });

  it("does not return partial balances or internal details when history cannot be loaded", async () => {
    mocks.journalEntries.mockRejectedValue(new Error("PRIVATE-DATABASE-DETAIL"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    const result = await response.json();
    expect(result).toEqual({ message: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain("PRIVATE-DATABASE-DETAIL");
  });
});


describe("legacy short-year source date normalization", () => {
  it("preserves pre-1000 opening history and orders early years without altering source facts", () => {
    const entries = [posting("YEAR999", "999-01-01", "1101", "debit", 999),
      posting("YEAR1", "1-01-01", "1101", "debit", 1)];
    const originalDates = entries.map((entry) => entry.date);
    const report = accountingPeriod(entries, "0001-01-01", "0999-12-31");
    expect(accountLedger(report, "1101", "YER").rows.map((row) => row.date)).toEqual(["0001-01-01", "0999-01-01"]);
    expect(accountLedger(accountingPeriod(entries, FROM, TO), "1101", "YER")).toMatchObject({
      openingBalanceMinor: 1000, closingBalanceMinor: 1000, rows: [],
    });
    expect(entries.map((entry) => entry.date)).toEqual(originalDates);
  });
});
