import { describe, expect, it } from "vitest";
import { invoiceCatalogPrice } from "../lib/invoice-catalog-price";

describe("invoice currency catalogue authority", () => {
  const service = { priceMinor: 10000, priceConfigured: true, priceSarMinor: 12345, priceUsdMinor: 2345, isActive: true };
  it("uses distinct owner prices in each invoice currency", () => {
    expect(["YER", "SAR", "USD"].map(c => invoiceCatalogPrice(service, c as "YER" | "SAR" | "USD"))).toEqual([10000,12345,2345]);
  });
  it("does not substitute a configured exchange rate or a zero placeholder for a missing price", () => {
    expect(invoiceCatalogPrice({ ...service, priceSarMinor: null, priceIn: { SAR: { minor: 5000, source: "converted" } } }, "SAR")).toBeNull();
    expect(invoiceCatalogPrice({ priceMinor: 0, priceConfigured: false }, "YER")).toBeNull();
    expect(invoiceCatalogPrice({ ...service, isActive: false }, "SAR")).toBeNull();
  });
  it("retains an explicitly configured free service and independently priced foreign currency", () => {
    expect(invoiceCatalogPrice({ ...service, priceMinor: 0 }, "YER")).toBe(0);
    expect(invoiceCatalogPrice({ ...service, priceConfigured: false }, "SAR")).toBe(12345);
  });
});
