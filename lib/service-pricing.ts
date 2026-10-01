/**
 * (DAY1 — قرار المالك) سعر الخدمة بعملة الزيارة: لكل خدمةٍ سعرٌ خاص بالسعودي والدولار
 * يقرّره المالك في الدليل؛ وإن تُرك فارغًا حُوِّل من السعر اليمني بسعر الصرف المحفوظ
 * في الإعدادات، مقرَّبًا لأقرب وحدة كاملة (ريال/دولار) — كما تُسعَّر في العيادة.
 *
 * منطقٌ خالص: الخادم (سلطة التسعير) والشاشة (العرض) يحسبان بالدالة نفسها، فلا يُعدّ
 * السعر المعروض «خصمًا» لأنه حُسب بطريقةٍ أخرى.
 */
import { CLINIC_BASE_CURRENCY, CURRENCIES, MINOR_UNITS, type Currency } from "./money";
import { rateFromSettings, type SettingsMap } from "./settings";

export interface PricedService {
  priceMinor: number;
  priceSarMinor: number | null;
  priceUsdMinor: number | null;
}

/** كم ريالًا يمنيًا تساوي وحدةٌ كاملة من العملة — null إن لم يُضبط. */
export type ForeignRates = Partial<Record<Currency, number | null>>;

export interface CatalogPrice {
  /** السعر بالوحدة الصغرى لعملة الزيارة — null إن لم يُعرف (لا سعر خاص ولا سعر صرف). */
  minor: number | null;
  source: "catalog" | "converted" | "none";
}

export function catalogPriceIn(service: PricedService, currency: Currency, rates: ForeignRates): CatalogPrice {
  if (currency === CLINIC_BASE_CURRENCY) return { minor: service.priceMinor, source: "catalog" };
  const own = currency === "SAR" ? service.priceSarMinor : currency === "USD" ? service.priceUsdMinor : null;
  if (own !== null && own !== undefined) return { minor: own, source: "catalog" };
  const rate = rates[currency];
  if (!rate || !Number.isFinite(rate) || rate <= 0) return { minor: null, source: "none" };
  const baseMajor = service.priceMinor / MINOR_UNITS[CLINIC_BASE_CURRENCY];
  return { minor: Math.round(baseMajor / rate) * MINOR_UNITS[currency], source: "converted" };
}

/** أسعار الصرف المحفوظة في الإعدادات لكل عملة غير الأساس. */
export function foreignRatesFromSettings(settings: SettingsMap): ForeignRates {
  const rates: ForeignRates = {};
  for (const currency of CURRENCIES) {
    if (currency !== CLINIC_BASE_CURRENCY) rates[currency] = rateFromSettings(settings, currency, CLINIC_BASE_CURRENCY);
  }
  return rates;
}

/** سعر الخدمة بكل عملة — للعرض في الشاشات (null: لا سعر ولا سعر صرف). */
export function catalogPricesByCurrency(service: PricedService, rates: ForeignRates): Record<Currency, CatalogPrice> {
  return Object.fromEntries(CURRENCIES.map((currency) => [currency, catalogPriceIn(service, currency, rates)])) as Record<Currency, CatalogPrice>;
}

/** (P3) ما تحتاجه الواجهة من خدمة الدليل كما يعيدها `GET /api/services`. */
export interface CatalogPriceInput {
  priceMinor: number;
  priceConfigured?: boolean;
  priceProvisional?: boolean;
  priceIn?: Partial<Record<Currency, { minor: number | null; source: "catalog" | "converted" | "none" }>>;
}

export type CatalogPriceState = "ok" | "provisional" | "unconfigured" | "no_rate";

/**
 * سعر الخدمة بعملة السياق كما سيُعرض — للعرض والاقتراح فقط.
 * سلطة السعر تبقى في الخادم (checkInvoiceAuthority): ما يُرسل يُقارن هناك بالدليل.
 */
export function catalogPriceFor(service: CatalogPriceInput, currency: Currency): { minor: number | null; state: CatalogPriceState } {
  const fromServer = service.priceIn?.[currency];
  const minor = fromServer ? fromServer.minor : currency === "YER" ? service.priceMinor : null;
  if (service.priceConfigured === false) return { minor: null, state: "unconfigured" };
  if (minor === null || minor === undefined) return { minor: null, state: "no_rate" };
  return { minor, state: service.priceProvisional ? "provisional" : "ok" };
}

