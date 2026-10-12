import type { Currency } from "./money";

/** Invoice agreements use the owner's price in the chosen currency. FX belongs
 * to actual collection settlement; a converted catalogue suggestion is not an agreement. */
export interface InvoiceCatalogService {
  priceMinor: number;
  priceConfigured?: boolean;
  isActive?: boolean;
  priceSarMinor?: number | null;
  priceUsdMinor?: number | null;
  priceIn?: Partial<Record<Currency, { minor: number | null; source: "catalog" | "converted" | "none" }>>;
}

export function invoiceCatalogPrice(service: InvoiceCatalogService, currency: Currency): number | null {
  if (service.isActive === false) return null;
  const amount = currency === "YER" ? service.priceConfigured === false ? null : service.priceMinor
    : currency === "SAR" ? service.priceSarMinor : service.priceUsdMinor;
  const quoted = service.priceIn?.[currency];
  const minor = amount === undefined ? quoted?.source === "catalog" ? quoted.minor : null : amount;
  return minor !== null && minor !== undefined && Number.isSafeInteger(minor) && minor >= 0 ? minor : null;
}
