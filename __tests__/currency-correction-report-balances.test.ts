import { describe, expect, it } from "vitest";
import { balancesByCurrencyAt, oldestUnpaidByCurrency, type CurrencyAwareMovement } from "../lib/reports";

// An unpaid SAR invoice issued on 10 Oct and corrected to USD on 15 Oct (0069): the replacement
// is listed from 15 Oct; before that the original is owed in SAR, in its own currency.
const movement: CurrencyAwareMovement = {
  openings: {},
  invoices: [{ date: "2026-10-15", netMinor: 8000, currency: "USD" }],
  payments: [],
  currencyCorrections: [{ invoiceId: 41, issuedDate: "2026-10-10", date: "2026-10-15", minor: 30000, currency: "SAR" }],
};

describe("dated currency correction in reports follows the original invoice's own currency", () => {
  it("as of a date before the correction the original is owed in SAR; from the correction date only the USD replacement", () => {
    expect(balancesByCurrencyAt(movement, "2026-10-09")).toEqual({ YER: 0, SAR: 0, USD: 0 });
    expect(balancesByCurrencyAt(movement, "2026-10-12")).toEqual({ YER: 0, SAR: 30000, USD: 0 });
    expect(balancesByCurrencyAt(movement, "2026-10-15")).toEqual({ YER: 0, SAR: 0, USD: 8000 });
  });
  it("aging dates the SAR debt from its issue date only while it is still the owed document", () => {
    expect(oldestUnpaidByCurrency(movement, "2026-10-12").SAR.date).toBe("2026-10-10");
    expect(oldestUnpaidByCurrency(movement, "2026-10-12").YER.date).toBeNull();
    expect(oldestUnpaidByCurrency(movement, "2026-10-20").SAR.date).toBeNull();
    expect(oldestUnpaidByCurrency(movement, "2026-10-20").USD.date).toBe("2026-10-15");
  });
});
