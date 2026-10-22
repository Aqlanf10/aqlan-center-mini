import { describe, expect, it } from "vitest";
import { CURRENCIES } from "../lib/money";
import { invoiceCurrencyReadiness } from "../lib/invoice-currency-readiness";
import { INVOICE_CURRENCY_SCOPE_MESSAGES } from "../lib/invoice-currency-scope";
import type { InvoiceRevisionView } from "../lib/invoice-revision-view";

// A YER invoice whose SAR receipts the server proved: only YER -> SAR is admitted.
const eligible: NonNullable<InvoiceRevisionView["currencyCorrection"]> = {
  available: true, targetCurrency: "SAR", targets: ["SAR"], options: [{ currency: "SAR", settledMinor: 0, accountDueMinor: 0 }],
  settledMinor: 0, accountDueMinor: 0, message: "Synthetic valid preview",
};
const unpaid = (source: (typeof CURRENCIES)[number]): NonNullable<InvoiceRevisionView["currencyCorrection"]> => {
  const targets = CURRENCIES.filter(currency => currency !== source);
  return { available: true, targetCurrency: targets[0], targets, options: targets.map(currency => ({ currency, settledMinor: 0, accountDueMinor: 0 })),
    settledMinor: 0, accountDueMinor: 0, message: "Synthetic unpaid preview" };
};
describe("currency correction readiness follows the server-proven targets only", () => {
  it("a receipt-backed YER invoice admits only SAR; the other direction is explained, not offered", () => {
    const rows = invoiceCurrencyReadiness({ sourceCurrency: "YER", preview: "ready", correction: eligible });
    expect(rows.map(row => [row.currency, row.status, row.selectable])).toEqual([["YER", "current", true], ["SAR", "eligible", true], ["USD", "unsupported", false]]);
  });
  it.each(CURRENCIES)("an unpaid %s invoice admits both other currencies, each with an explicit-amount explanation", sourceCurrency => {
    const rows = invoiceCurrencyReadiness({ sourceCurrency, preview: "ready", correction: unpaid(sourceCurrency) });
    expect(rows.map(row => row.currency)).toEqual(CURRENCIES);
    for (const row of rows) {
      expect(row.selectable).toBe(true);
      expect(row.status).toBe(row.currency === sourceCurrency ? "current" : "eligible");
      if (row.currency !== sourceCurrency && !(sourceCurrency === "YER" && row.currency === "SAR")) expect(row.message).toContain("لا تحويل بسعر صرف");
    }
  });
  it.each(["loading", "unavailable", "recovery"] as const)("never derives eligibility during %s, even from stale successful proof", preview => {
    for (const sourceCurrency of CURRENCIES) {
      const rows = invoiceCurrencyReadiness({ sourceCurrency, preview, correction: eligible });
      expect(rows.every(row => row.status === "unverified" && !row.selectable)).toBe(true);
    }
  });
  it("does not guess a source currency or a missing target proof", () => {
    expect(invoiceCurrencyReadiness({ preview: "ready", correction: eligible }).every(row => !row.selectable)).toBe(true);
    expect(invoiceCurrencyReadiness({ sourceCurrency: "YER", preview: "ready" }).find(row => row.currency === "SAR"))
      .toMatchObject({ status: "unverified", selectable: false });
  });
  it.each(Object.keys(INVOICE_CURRENCY_SCOPE_MESSAGES) as Array<keyof typeof INVOICE_CURRENCY_SCOPE_MESSAGES>)("explains %s without parsing display text", reason => {
    const rows = invoiceCurrencyReadiness({ sourceCurrency: "YER", preview: "ready", correction: { ...eligible, available: false, reasonCodes: [reason], message: "available" } });
    expect(rows.find(row => row.currency === "SAR")).toMatchObject({ selectable: false, status: "review", message: INVOICE_CURRENCY_SCOPE_MESSAGES[reason] });
  });
  it("preserves multiple reasons and fails closed on contradictory positive proof", () => {
    const correction = { ...eligible, reasonCodes: ["PLAN_LINKED_LINEAGE", "ALREADY_RECLASSIFIED"] as const };
    const input = { sourceCurrency: "YER" as const, preview: "ready" as const, correction: { ...correction, reasonCodes: [...correction.reasonCodes] } };
    const before = structuredClone(input);
    const sar = invoiceCurrencyReadiness(input).find(row => row.currency === "SAR")!;
    expect(sar.selectable).toBe(false);
    for (const reason of correction.reasonCodes) expect(sar.message).toContain(INVOICE_CURRENCY_SCOPE_MESSAGES[reason]);
    expect(input).toEqual(before);
  });
  it.each(["Synthetic commission review", "Synthetic receipt proof failure", "available", "   "])("uses refusal text only as explanation: %j", message => {
    const sar = invoiceCurrencyReadiness({ sourceCurrency: "YER", preview: "ready", correction: { ...eligible, available: false, message } }).find(row => row.currency === "SAR")!;
    expect(sar).toMatchObject({ status: "review", selectable: false });
    expect(sar.message.trim().length).toBeGreaterThan(0);
  });
});
