import { describe, expect, it } from "vitest";
import { workflowBalanceRows, hasWalkoutFinancials } from "../lib/walkout-financial-read";
const workflow = () => ({ patient: { id: 1 }, canSeeFinancial: true,
  financial: { byCurrency: { YER: { balanceMinor: 180000 }, SAR: { balanceMinor: 2300 }, USD: { balanceMinor: -100 } } } });
describe("financial transport integrity", () => {
  it("preserves canonical balances in separate currencies without adding agreement remaining", () => {
    expect(workflowBalanceRows({ ...workflow(), activePlans: [{ remainingMinor: 999999 }] }, 1)).toEqual([
      { currency: "YER", balanceMinor: 180000 }, { currency: "SAR", balanceMinor: 2300 }, { currency: "USD", balanceMinor: -100 },
    ]);
  });
  it.each([null, {}, { patient: { id: 1 }, financial: null },
    { ...workflow(), patient: { id: 2 } }, { ...workflow(), canSeeFinancial: false },
    { ...workflow(), financial: { byCurrency: {} } },
    { ...workflow(), financial: { byCurrency: { YER: { balanceMinor: 0 }, SAR: { balanceMinor: 0 } } } },
  ])("rejects absent or foreign evidence %j", (value) => {
    expect(() => workflowBalanceRows(value, 1)).toThrow();
  });
  it.each([null, "", "0", NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined])("rejects invalid amount %s", (amount) => {
    const value = workflow(); (value.financial.byCurrency.YER as { balanceMinor: unknown }).balanceMinor = amount;
    expect(() => workflowBalanceRows(value, 1)).toThrow();
  });
  it("requires complete maps, owner and consistent current rows on reopened walkout", () => {
    const value = { visitId: 10, patientId: 1, signedAt: "2026-10-09T10:00:00Z", arrivedAt: "2026-10-09T09:00:00Z",
      invoice: null, balances: [{ currency: "YER", balanceMinor: 180000 }],
      checkout: { previous: { YER: 180000, SAR: 0, USD: 0 }, current: { YER: 180000, SAR: 0, USD: 0 }, invoicePaidMinor: 0 } };
    expect(hasWalkoutFinancials(value, 1, 10)).toBe(true);
    expect(hasWalkoutFinancials(value, 2, 10)).toBe(false);
    expect(hasWalkoutFinancials(value, 1, 11)).toBe(false);
    expect(hasWalkoutFinancials({ ...value, balances: [] }, 1, 10)).toBe(false);
    expect(hasWalkoutFinancials({ ...value, checkout: { ...value.checkout, previous: {} } }, 1, 10)).toBe(false);
    expect(hasWalkoutFinancials({ ...value, invoice: { id: 2, currency: "EUR", netMinor: 0 } }, 1, 10)).toBe(false);
  });
});
