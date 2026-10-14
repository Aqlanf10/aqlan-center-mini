import { describe, expect, it } from "vitest";
import { generateMonthlyDebtSchedule, monthlyDueDate } from "../lib/debt-monthly-schedule";
import { readDebtRepaymentDraft } from "../components/DebtRepaymentEditor";

const base = { remainingMinor: 150000, downPaymentMinor: 49000, downPaymentDate: "2026-10-14", monthCount: 2, firstMonthlyDate: "2026-11-30" };
function terms(input: Partial<typeof base> = {}) {
  const result = generateMonthlyDebtSchedule({ ...base, ...input });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.terms;
}
describe("monthly proposed repayment distribution", () => {
  it.each([
    ["2027-01-31", 1, "2027-02-28"], ["2027-01-31", 2, "2027-03-31"],
    ["2028-01-31", 1, "2028-02-29"], ["2028-02-29", 12, "2029-02-28"],
    ["2026-12-31", 1, "2027-01-31"], ["2000-01-31", 1, "2000-02-29"],
    ["2100-01-31", 1, "2100-02-28"], ["0001-01-31", 1, "0001-02-28"],
  ])("anchors %s + %s to %s", (first, offset, expected) => expect(monthlyDueDate(first, offset)).toBe(expected));
  it.each(["2027-02-29", "2026-04-31", "0000-01-01", "2026-13-01", "2026-01-00", "2026-1-01", "invalid"])("refuses invalid calendar %s", first => expect(monthlyDueDate(first, 1)).toBeNull());
  it("refuses calendar overflow and invalid offsets", () => {
    expect(monthlyDueDate("9999-12-31", 1)).toBeNull();
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) expect(monthlyDueDate("2026-01-01", offset)).toBeNull();
    expect(generateMonthlyDebtSchedule({ ...base, firstMonthlyDate: "9999-12-31" }).ok).toBe(false);
  });
  it("490 proposed plus 505 + 505 covers 1500 without recording cash", () => {
    expect(terms().installments).toEqual([
      { dueDate: "2026-10-14", amountMinor: 49000, kind: "down_payment" },
      { dueDate: "2026-11-30", amountMinor: 50500, kind: "installment" },
      { dueDate: "2026-12-30", amountMinor: 50500, kind: "installment" },
    ]);
  });
  it.each([12, 15, 18, 1, 59])("supports %s monthly installments after a proposed payment", monthCount => {
    const result = terms({ monthCount });
    expect(result.installments).toHaveLength(monthCount + 1);
    expect(result.installments.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(150000);
    expect(result.installments.every(row => row.amountMinor > 0)).toBe(true);
  });
  it.each([[101000, [33667, 33667, 33666]], [1010, [337, 337, 336]]])("distributes %s minor units exactly", (remainingMinor, expected) => {
    expect(terms({ remainingMinor, downPaymentMinor: 0, monthCount: 3 }).installments.map(row => row.amountMinor)).toEqual(expected);
  });
  it("distributes maximum safe integer without floating point remainder loss", () => {
    const rows = terms({ remainingMinor: Number.MAX_SAFE_INTEGER, downPaymentMinor: 0, monthCount: 60 }).installments;
    expect(rows.reduce((sum, row) => sum + BigInt(row.amountMinor), BigInt(0))).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect(Math.max(...rows.map(row => row.amountMinor)) - Math.min(...rows.map(row => row.amountMinor))).toBe(1);
  });
  it("uses net discounted debt and historical opening remaining exactly once", () => {
    expect(terms({ remainingMinor: 120000 }).installments.reduce((n, row) => n + row.amountMinor, 0)).toBe(120000);
    // Historical original 2500 - paid before system 1000 = opening remaining 1500.
    expect(terms().installments.reduce((n, row) => n + row.amountMinor, 0)).toBe(150000);
  });
  it("regeneration after an amount change restores canonical exact-sum validation", () => {
    const original = terms();
    const draft = { mode: "installments" as const, rows: original.installments.map((row, i) => ({ key: String(i), dueDate: row.dueDate, amount: String(row.amountMinor / 100), kind: row.kind })) };
    expect(readDebtRepaymentDraft(draft, "SAR", 140000).ok).toBe(false);
    const regenerated = terms({ remainingMinor: 140000 });
    expect(regenerated.installments.map(row => row.amountMinor)).toEqual([49000, 45500, 45500]);
    expect(readDebtRepaymentDraft({ ...draft, rows: regenerated.installments.map((row, i) => ({ key: String(i), dueDate: row.dueDate, amount: String(row.amountMinor / 100), kind: row.kind })) }, "SAR", 140000).ok).toBe(true);
  });
  it("handles zero monthly remainder without zero rows", () => {
    expect(terms({ downPaymentMinor: 150000, monthCount: NaN, firstMonthlyDate: "" }).installments).toEqual([{ dueDate: "2026-10-14", amountMinor: 150000, kind: "down_payment" }]);
    expect(terms({ remainingMinor: 0, downPaymentMinor: 0 })).toEqual({ mode: "full", installments: [] });
  });
  it.each([0, -1, 1.5, 60, 61, NaN, Infinity])("refuses invalid monthly count %s with proposed downpayment", monthCount => expect(generateMonthlyDebtSchedule({ ...base, monthCount }).ok).toBe(false));
  it.each([-1, 0.5, 150001, NaN, Infinity])("refuses invalid proposed amount %s", downPaymentMinor => expect(generateMonthlyDebtSchedule({ ...base, downPaymentMinor }).ok).toBe(false));
  it("refuses unsafe or negative debt, tiny remainder and invalid date ordering", () => {
    for (const remainingMinor of [-1, 0.1, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(generateMonthlyDebtSchedule({ ...base, remainingMinor }).ok).toBe(false);
    expect(generateMonthlyDebtSchedule({ ...base, remainingMinor: 49001 }).ok).toBe(false);
    expect(generateMonthlyDebtSchedule({ ...base, downPaymentDate: "2026-02-30" }).ok).toBe(false);
    expect(generateMonthlyDebtSchedule({ ...base, firstMonthlyDate: "2026-10-13" }).ok).toBe(false);
  });
});
