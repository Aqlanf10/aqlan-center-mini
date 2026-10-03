import { describe, expect, it } from "vitest";
import { formatMoney } from "../lib/money";
import { balancesByCurrencyAt, parseFilters, patientStatementReport } from "../lib/reports";

type Context = Parameters<typeof patientStatementReport>[0];
type Movement = Context["movements"][number];

function invoice(id: number, date: string, currency: "YER" | "SAR", totalMinor: number, discountMinor = 0): Movement["invoices"][number] {
  return { id, date, currency, totalMinor, discountMinor, netMinor: totalMinor - discountMinor,
    planId: null, categories: [], doctorIds: [], items: [`Synthetic invoice ${id}`], lines: [] };
}
function payment(id: number, date: string, currency: "YER" | "SAR", settlementMinor: number, kind = "payment"): Movement["payments"][number] {
  return { id, date, currency, amountMinor: settlementMinor, baseMinor: settlementMinor,
    kind, method: "cash", invoiceId: null, planId: null, openingCurrency: currency,
    settlementCurrency: currency, settlementMinor, createdBy: "synthetic", note: null };
}
function context(to = "2026-09-30"): Context {
  const patient: Movement = {
    patientId: 17, patientNumber: "SYN-17", name: "Synthetic patient", phone: null,
    createdDate: "2026-01-01", lastVisitDate: "2026-10-02", status: "active", referralSource: null, referredBy: null,
    openings: { YER: { date: "2026-01-01", minor: 100 }, SAR: { date: "2026-09-01", minor: 500 }, USD: { date: "2026-10-01", minor: 300 } },
    invoices: [invoice(1, "2026-08-20", "YER", 1000, 100), invoice(2, "2026-09-30", "SAR", 2000, 200), invoice(3, "2026-10-01", "YER", 9000, 900)],
    payments: [payment(1, "2026-08-21", "YER", 300), payment(2, "2026-09-30", "SAR", 400), payment(3, "2026-09-30", "SAR", 50, "refund"), payment(4, "2026-10-01", "YER", 5000)],
    plans: [], visitDoctorIds: [],
  };
  return {
    filters: parseFilters(new URLSearchParams({ patientId: "17", preset: "custom", from: "2026-09-01", to }), to),
    base: "YER", doctors: new Map(), commissions: new Map(), expenses: [], movements: [patient],
    visits: [{ id: 1, patientId: 17, patientName: patient.name, patientNumber: patient.patientNumber, phone: null,
      date: "2026-09-29", arrivedAt: "2026-09-29T10:00:00Z", calledAt: null, seatedAt: null, finishedAt: null,
      status: "done", doctorId: null, invoiceId: null, appointmentId: null, chair: null, firstVisit: true }],
  };
}
const value = (result: ReturnType<typeof patientStatementReport>, key: string) => result.kpis.find((kpi) => kpi.key === key);

describe("patient statement as-of contract", () => {
  it("includes all opening-through-cutoff movements, excludes later rows, and reconciles every currency", () => {
    const ctx = context();
    const result = patientStatementReport(ctx);
    expect(result.rows).toHaveLength(7);
    expect(result.columns!.find((column) => column.key === "balanceMinor")?.aggregate).toBe("none");
    expect(JSON.stringify(result.rows)).not.toContain("01/10/2026");
    expect(JSON.stringify(result.rows)).toContain("20/08/2026"); // from is not a lower bound
    const expected = balancesByCurrencyAt(ctx.movements[0], ctx.filters.to);
    for (const currency of ["YER", "SAR", "USD"] as const) {
      const lastRow = result.rows!.filter((row) => row.currency === currency).at(-1);
      expect(lastRow?.balanceMinor ?? 0).toBe(expected[currency]);
    }
  });

  it("applies the same inclusive cutoff to gross, discounts, paid, refunds and last activity", () => {
    const result = patientStatementReport(context());
    expect(value(result, "treatment")?.minor).toBe(1000);
    expect(value(result, "discounts")?.minor).toBe(100);
    expect(value(result, "paid")?.minor).toBe(300);
    expect(value(result, "treatment-SAR")?.minor).toBe(2000);
    expect(value(result, "refunds-SAR")?.minor).toBe(50);
    expect(value(result, "lastPayment")?.text).toBe("30/09/2026");
    expect(value(result, "lastVisit")?.text).toBe("29/09/2026");
  });

  it("formats original payment/refund amounts in currency major units in descriptions", () => {
    const result = patientStatementReport(context());
    const paid = result.rows!.find((row) => row.currency === "SAR" && row.creditMinor === 400);
    const refund = result.rows!.find((row) => row.currency === "SAR" && row.debitMinor === 50);
    expect(paid?.description).toContain(formatMoney(400, "SAR"));
    expect(refund?.description).toContain(formatMoney(50, "SAR"));
    expect(paid?.description).not.toContain("400 SAR");
  });

  it("keeps the patient and resolved cutoff on the existing official print route", () => {
    const result = patientStatementReport(context());
    const link = new URL(result.actions![0].href, "https://synthetic.invalid");
    expect(link.pathname).toBe("/print/statement/17");
    expect(link.searchParams.get("from")).toBe("2026-09-01");
    expect(link.searchParams.get("to")).toBe("2026-09-30");
    expect(result.periodLabel).toContain("30/09/2026");
  });

  it("does not claim inherited movement filters apply to the whole-patient ledger", () => {
    const ctx = context();
    Object.assign(ctx.filters, { doctorId: 99, specialty: "endo", serviceId: 80, currency: "SAR", method: "card", receivedBy: "PRIVATE" });
    const result = patientStatementReport(ctx);
    expect(result.filtersLabel).toContain("جميع العملات");
    expect(result.filtersLabel).not.toContain("PRIVATE");
    expect(result.filtersLabel).not.toContain("99");
    expect(result.rows!.some((row) => row.currency === "YER")).toBe(true);
  });

  it("keeps the latest pre-from visit and excludes other-patient or post-cutoff visits", () => {
    const ctx = context();
    ctx.visits[0].date = "2026-08-15";
    ctx.visits.push({ ...ctx.visits[0], id: 2, patientId: 18, date: "2026-09-30" },
      { ...ctx.visits[0], id: 3, date: "2026-10-01" });
    expect(value(patientStatementReport(ctx), "lastVisit")?.text).toBe("15/08/2026");
  });

  it("renders zero balances with no invented past activity before the first movement", () => {
    const ctx = context("2025-12-31");
    ctx.filters.from = ctx.filters.to = "2025-12-31";
    ctx.visits = [];
    const result = patientStatementReport(ctx);
    expect(result.rows).toEqual([]);
    expect(value(result, "treatment")?.minor).toBe(0);
    expect(value(result, "balance")?.minor).toBe(0);
    expect(value(result, "lastPayment")?.text).toBe("—");
    expect(value(result, "lastVisit")?.text).toBe("—");
  });
});
