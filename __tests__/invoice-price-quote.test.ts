import { describe, expect, it } from "vitest";
import type { Service } from "../lib/db";
import { invoicePriceQuote, invoiceOfferedPrice, readInvoicePriceQuote, sameInvoicePriceQuote, INVOICE_ZERO_CONVERSION_MESSAGE } from "../lib/invoice-price-quote";
import { parseInvoiceInput } from "../lib/invoice-input";
import { checkInvoiceAuthority } from "../lib/invoice-pricing";
import { invoiceCommandFingerprint } from "../lib/invoice-template";

const service: Service = { id: 1, name: "Synthetic fixed ortho", category: "ortho", priceMinor: 2200, priceSarMinor: null, priceUsdMinor: null, priceConfigured: true, priceProvisional: false, isActive: true, sortOrder: 1 };
const rates = { SAR: 440, USD: 2200 };
const services = new Map([[1, service]]);
const quote = invoicePriceQuote(service, "SAR", rates);
const body = { patientId: 1, currency: "SAR", items: [{ serviceId: 1, price: "5", priceQuote: quote }] };
const authority = (price: string, reason?: string, role = "reception") => {
  const parsed = parseInvoiceInput({ ...body, items: [{ ...body.items[0], price, priceReason: reason }] }, services, new Set(), rates);
  if (!parsed.ok) return parsed;
  return checkInvoiceAuthority({ requireInvoiceManualReason:true, lines: parsed.authorityLines, currency: "SAR", rates, role, maxDiscountPercent: 10, totalMinor: Number(price) * 100, discountMinor: 0, discountReason: null });
};
describe("invoice native/converted offers without changing unpriced authority", () => {
  it.each(["SAR","USD"] as const)("%s rounded-zero conversion is source evidence, never an automatically accepted free offer",currency=>{
    const tiny={...service,priceMinor:1};const tinyQuote=invoicePriceQuote(tiny,currency,rates);
    expect(tinyQuote).toMatchObject({source:"converted",minor:0,basePriceMinor:1,rounding:"nearest-major-unit"});
    expect(readInvoicePriceQuote(tinyQuote,currency)).toEqual(tinyQuote);
    expect(invoiceOfferedPrice({...tiny,invoiceQuotes:{[currency]:tinyQuote}},currency)).toBeNull();
    const source={patientId:1,currency,items:[{serviceId:1,price:"0",priceQuote:tinyQuote}]};
    expect(parseInvoiceInput(source,new Map([[1,tiny]]),new Set(),rates)).toEqual({ok:false,message:INVOICE_ZERO_CONVERSION_MESSAGE});
    const positive=parseInvoiceInput({...source,items:[{...source.items[0],price:"7.25"}]},new Map([[1,tiny]]),new Set(),rates);
    if(!positive.ok)throw new Error(positive.message);
    for(const role of ["admin","reception"]){
      const input={requireInvoiceManualReason:true,lines:positive.authorityLines,currency,rates,role,maxDiscountPercent:10,totalMinor:725,discountMinor:0,discountReason:null};
      expect(checkInvoiceAuthority(input).ok).toBe(false);
      expect(checkInvoiceAuthority({...input,lines:input.lines.map(line=>({...line,reason:"Documented positive manual price"}))}).ok).toBe(true);
    }
    const half=rates[currency]/2;
    expect(invoicePriceQuote({...tiny,priceMinor:half-1},currency,rates).minor).toBe(0);
    expect(invoicePriceQuote({...tiny,priceMinor:half},currency,rates).minor).toBe(100);
    expect(invoiceOfferedPrice({...tiny,...(currency==="SAR"?{priceSarMinor:0}:{priceUsdMinor:0}),invoiceQuotes:{[currency]:tinyQuote}},currency)).toBe(0);
  });
  it("snapshots configured source, rate and the existing whole-major-unit rounding", () => {
    expect(quote).toEqual({ version: 1, baseCurrency: "YER", currency: "SAR", source: "converted", minor: 500, basePriceMinor: 2200, rate: 440, rateSource: "finance.rate.SAR", rounding: "nearest-major-unit" });
    expect(invoicePriceQuote(service, "USD", rates).minor).toBe(100);
    expect(invoicePriceQuote({ ...service, priceMinor: 2420 }, "SAR", rates).minor).toBe(600);
  });
  it("native zero and nonzero win over conversion", () => {
    for (const priceSarMinor of [0, 150000]) {
      const native = { ...service, priceSarMinor };
      const nativeQuote = invoicePriceQuote(native, "SAR", rates);
      expect(nativeQuote.source).toBe("catalog"); expect(nativeQuote.minor).toBe(priceSarMinor); expect(nativeQuote.rate).toBeNull();
      expect(invoiceOfferedPrice({ ...native, invoiceQuotes: { SAR: quote } }, "SAR")).toBe(priceSarMinor);
    }
  });
  it("does not invent rates or price inactive/unconfigured services", () => {
    for (const rate of [null, undefined, 0, -1, NaN, Infinity]) expect(invoicePriceQuote(service, "SAR", { SAR: rate }).source).toBe("none");
    expect(invoicePriceQuote({ ...service, isActive: false }, "SAR", rates).minor).toBeNull();
    expect(invoicePriceQuote({ ...service, priceConfigured: false }, "SAR", rates).minor).toBeNull();
  });
  it.each(["admin", "reception"])("%s accepts the validated converted offer; any manual change needs a reason", role => {
    expect(authority("5", undefined, role).ok).toBe(true);
    expect(authority("1500", undefined, role).ok).toBe(false);
    expect(authority("1500", "Explicit unpriced agreement", role)).toMatchObject({ ok: true, overrides: [{ kind: "unpriced", reason: "Explicit unpriced agreement" }] });
    expect(authority("4", undefined, role).ok).toBe(false);
    expect(authority("4", "Explicit unpriced agreement", role).ok).toBe(true);
  });
  it("refuses a supplied/tampered/stale quote even if rounded display price stayed unchanged", () => {
    expect(invoicePriceQuote(service, "SAR", { SAR: 441 }).minor).toBe(500);
    expect(parseInvoiceInput(body, services, new Set(), { SAR: 441 })).toMatchObject({ ok: false, status: 409, code: "INVOICE_PRICE_STALE" });
    expect(sameInvoicePriceQuote({ ...quote, rate: 1 }, quote)).toBe(false);
    expect(sameInvoicePriceQuote({ ...quote, extra: "x" }, quote)).toBe(false);
    expect(sameInvoicePriceQuote(Object.fromEntries(Object.entries(quote).reverse()), quote)).toBe(true);
  });
  it("strictly decodes displayed quotes, including their rounding arithmetic",()=>{
    expect(readInvoicePriceQuote(quote,"SAR")).toEqual(quote);
    expect(readInvoicePriceQuote({...quote,minor:501},"SAR")).toBeNull();
    expect(readInvoicePriceQuote({...quote,rateSource:"client-invented"},"SAR")).toBeNull();
    expect(readInvoicePriceQuote({...quote,rate:0},"SAR")).toBeNull();
    expect(readInvoicePriceQuote(quote,"USD")).toBeNull();
    expect(readInvoicePriceQuote({...quote,source:"catalog"},"SAR")).toBeNull();
  });
  it("includes accepted rate/source evidence in the canonical fingerprint", () => {
    const first = parseInvoiceInput(body, services, new Set(), rates);
    const changed = parseInvoiceInput({ ...body, items: [{ ...body.items[0], priceQuote: invoicePriceQuote(service, "SAR", { SAR: 441 }) }] }, services, new Set(), { SAR: 441 });
    if (!first.ok || !changed.ok) throw new Error("Invalid test fixture");
    expect(invoiceCommandFingerprint({ ...first, template: null })).not.toBe(invoiceCommandFingerprint({ ...changed, template: null }));
    expect(first.pricingSnapshots[0]).toMatchObject({ serviceId: 1, quote, requestedMinor: 500 });
  });
  it("unquoted legacy clients cannot claim an automatic quote or avoid the manual reason", () => {
    const parsed = parseInvoiceInput({ ...body, items: [{ serviceId: 1, price: "5" }] }, services, new Set(), rates);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(checkInvoiceAuthority({ requireInvoiceManualReason:true, lines: parsed.authorityLines, currency: "SAR", rates, role: "reception", maxDiscountPercent: 10, totalMinor: 500, discountMinor: 0, discountReason: null }).ok).toBe(false);
    const text = parseInvoiceInput({ patientId: 1, items: [{ description: "Free text", price: "50" }] }, services, new Set());
    if (!text.ok) throw new Error(text.message);
    expect(checkInvoiceAuthority({ requireInvoiceManualReason:true, lines: text.authorityLines, currency: "YER", rates, role: "reception", maxDiscountPercent: 10, totalMinor: 50, discountMinor: 0, discountReason: null }).ok).toBe(true);
  });
  it("does not impose invoice-only reasons on shared plan pricing callers", () => {
    const input = { lines: [{ description: service.name, service, requestedMinor: 150000, quantity: 1, explicit: true, reason: null }],
      currency: "SAR" as const, rates, role: "reception", maxDiscountPercent: 10, totalMinor: 150000, discountMinor: 0, discountReason: null };
    expect(checkInvoiceAuthority(input).ok).toBe(true);
    expect(checkInvoiceAuthority({ ...input, requireInvoiceManualReason: true }).ok).toBe(false);
  });
});
