import { describe, expect, it, vi } from "vitest";
import { invoiceCurrencyScopeReasons, invoiceCurrencyScopeMessage, isInvoiceCurrencyScopeReason } from "../lib/invoice-currency-scope";
import type { DbClient, Invoice } from "../lib/db";

vi.mock("../lib/debt-installments-db", () => ({ DebtRepaymentError: class extends Error {
  constructor(public code: string, message: string) { super(message); }
} }));
vi.mock("../lib/invoice-settlement-position", () => ({ readInvoiceSettlementPosition: async () => ({ lineageInvoiceIds: [11, 12] }) }));
vi.mock("../lib/invoice-currency-reclassification", () => ({
  ReclassificationProofError: class extends Error {},
  planCurrencyReclassification: () => ({ settledMinor: 0 }),
}));
import { prepareInvoiceCurrencyChange, InvoiceCurrencyScopeError } from "../lib/invoice-currency-plan";

const invoice: Invoice = { id:12, invoiceNumber:"SYNTHETIC", patientId:17, patientName:"Synthetic", status:"open",
  totalMinor:2500, discountMinor:0, baseCurrency:"YER", note:null, createdAt:"2026-01-01T00:00:00Z", items:[] };

describe("currency scope diagnostics preserve the existing refusal truth table", () => {
  it.each(Array.from({length:8}, (_, mask) => mask))("scope mask %i", async mask => {
    const facts = { plan_linked_lineage:!!(mask&1), independent_item_source:!!(mask&2), already_reclassified:!!(mask&4) };
    const expected = [mask&1?"PLAN_LINKED_LINEAGE":null,mask&2?"INDEPENDENT_ITEM_SOURCE":null,mask&4?"ALREADY_RECLASSIFIED":null].filter(Boolean);
    expect(invoiceCurrencyScopeReasons(facts)).toEqual(expected);
    const query=vi.fn().mockResolvedValueOnce({rows:[facts]}).mockResolvedValue({rows:[]});
    const operation=prepareInvoiceCurrencyChange({query} as unknown as DbClient,invoice,0);
    if(mask){
      await expect(operation).rejects.toMatchObject({code:"conflict",reasonCodes:expected});
      expect(query).toHaveBeenCalledTimes(1);
      expect(invoiceCurrencyScopeMessage(invoiceCurrencyScopeReasons(facts))).not.toContain("يحتاج مساره المخصص");
    } else await expect(operation).resolves.toMatchObject({lineageInvoiceIds:[11,12],planIds:[]});
    expect(query.mock.calls[0][1]).toEqual([[11,12],12]);
    for(const [sql] of query.mock.calls)expect(sql.trim()).toMatch(/^SELECT\b/);
  });
  it("returns allowlisted codes only; no record identities or sensitive source facts", () => {
    expect(isInvoiceCurrencyScopeReason("PLAN_LINKED_LINEAGE")).toBe(true);
    for(const value of [null,17,"patientName","__proto__","constructor","UNKNOWN"])expect(isInvoiceCurrencyScopeReason(value)).toBe(false);
    expect(new InvoiceCurrencyScopeError(["INDEPENDENT_ITEM_SOURCE"]).message).toContain("غير مدعوم حاليًا");
  });
});
