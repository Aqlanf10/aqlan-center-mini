import type { FinanceSummary } from "../../lib/db";

/** Synthetic amounts only; deliberately non-zero to expose accidental leakage. */
export const financeSummaryFixture: FinanceSummary = {
  from: "2026-09-01", to: "2026-09-30",
  income: { byCurrency: { YER: 123400, SAR: 3400, USD: 5600 }, baseTotalMinor: 180000, count: 6 },
  refunds: { baseTotalMinor: 2345, count: 2 },
  expenses: { byCategory: { rent: 45678 }, baseTotalMinor: 45678, count: 3 },
  openingSettlements: { baseTotalMinor: 6789, count: 1 },
  netMinor: 125188,
  invoicedByCurrency: { YER: 230000, SAR: 4500, USD: 6700 },
  invoiceCount: 7, patientCount: 5,
  topServices: [{ name: "خدمة تجريبية", count: 4, totalMinor: 12000, currency: "YER" }],
};
