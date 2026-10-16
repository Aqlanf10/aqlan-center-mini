import { invoiceCatalogPrice, type InvoiceCatalogService } from "./invoice-catalog-price";
import { catalogPriceIn, type ForeignRates } from "./service-pricing";
import type { Currency } from "./money";

export const INVOICE_ZERO_CONVERSION_MESSAGE = "نتيجة التحويل بعد التقريب صفر؛ لا تُعتمد كسعر مجاني. اكتب سعرًا يدويًا موجبًا لهذه العملة وسبب التسعير قبل الحفظ.";

/** Immutable source snapshot. A converted zero is audit evidence only: the UI
 * offer selector refuses it and requires positive, reasoned manual pricing.
 * Converted prices never become native authority. */
export interface InvoicePriceQuote {
  version: 1; baseCurrency:"YER"; currency: Currency; source: "catalog" | "converted" | "none";
  minor: number | null; basePriceMinor: number | null;
  rate: number | null; rateSource: string | null;
  rounding: "native-minor-unit" | "nearest-major-unit" | "none";
}
export function invoicePriceQuote(service: InvoiceCatalogService, currency: Currency, rates: ForeignRates): InvoicePriceQuote {
  const native = invoiceCatalogPrice(service, currency);
  const result: InvoicePriceQuote = { version: 1, baseCurrency:"YER", currency, source: native === null ? "none" : "catalog", minor: native,
    basePriceMinor: null, rate: null, rateSource: null, rounding: native === null ? "none" : "native-minor-unit" };
  if (native !== null || currency === "YER" || service.isActive === false || service.priceConfigured === false) return result;
  const quoted = catalogPriceIn({ priceMinor: service.priceMinor, priceSarMinor: service.priceSarMinor ?? null,
    priceUsdMinor: service.priceUsdMinor ?? null }, currency, rates);
  if (quoted.source !== "converted" || quoted.minor === null || !Number.isSafeInteger(quoted.minor) || quoted.minor < 0) return result;
  return { version: 1, baseCurrency:"YER", currency, source: "converted", minor: quoted.minor, basePriceMinor: service.priceMinor,
    rate: rates[currency]!, rateSource: `finance.rate.${currency}`, rounding: "nearest-major-unit" };
}
export function sameInvoicePriceQuote(value: unknown, expected: InvoicePriceQuote): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, entry]) => Object.hasOwn(record, key) && record[key] === entry);
}
/** Strict DTO decoding for browser evidence; server commands still recompute
 * against their own catalogue/settings rather than trusting this decoder. */
export function readInvoicePriceQuote(value: unknown, currency: Currency): InvoicePriceQuote | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const minor = (amount: unknown): amount is number => typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0;
  let expected: InvoicePriceQuote;
  if (raw.source === "catalog" && minor(raw.minor)) expected = invoicePriceQuote({ priceMinor: currency === "YER" ? raw.minor : 0,
    priceSarMinor: currency === "SAR" ? raw.minor : null, priceUsdMinor: currency === "USD" ? raw.minor : null }, currency, {});
  else if (raw.source === "converted" && currency !== "YER" && minor(raw.basePriceMinor) && typeof raw.rate === "number" && Number.isFinite(raw.rate) && raw.rate > 0)
    expected = invoicePriceQuote({ priceMinor: raw.basePriceMinor, priceConfigured: true }, currency, { [currency]: raw.rate });
  else if (raw.source === "none") expected = invoicePriceQuote({ priceMinor: 0, priceConfigured: false }, currency, {});
  else return null;
  return sameInvoicePriceQuote(raw, expected) ? expected : null;
}
/** Browser DTO only. Server callers always recompute using their locked settings. */
export function invoiceOfferedPrice(service: InvoiceCatalogService, currency: Currency): number | null {
  if (service.isActive === false) return null;
  const native = invoiceCatalogPrice(service, currency);
  if (native !== null) return native;
  const offer = service.invoiceQuotes?.[currency];
  return offer?.source === "converted" && offer.currency === currency && offer.minor !== null && Number.isSafeInteger(offer.minor) && offer.minor > 0 ? offer.minor : null;
}
