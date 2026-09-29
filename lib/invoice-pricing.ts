/**
 * (FIN-4) سلطة السعر والخصم على **الفاتورة اليدوية** — القاعدة نفسها التي تحكم الزيارة.
 *
 * العيب (تدقيق المالية): للمركز حدّ خصمٍ في الإعدادات (`billing.max_discount_percent`)
 * يُفرض على إجراءات الزيارة — الخصم بسببٍ مكتوب، وما فوق الحد للمدير. لكن «فاتورة جديدة»
 * في حساب المريض كانت تتجاوزه كله: خصمٌ على الفاتورة بأي قدر (حتى ١٠٠٪) بلا سبب، وسعر
 * خدمةٍ من الدليل يُكتب أقل بلا سببٍ ولا حد. والآن:
 *  - بند خدمةٍ مسعّرة بسعرٍ مكتوب يمرّ بـ`decideProcedurePrice` (lib/price-authority.ts)
 *    بسعر الدليل بعملة الفاتورة (`catalogPriceIn`) — كالزيارة حرفيًّا.
 *  - الخصم على الفاتورة: بسببٍ مكتوب دائمًا، ولغير المدير حتى الحد نفسه من إجمالي البنود.
 * البند اليدوي بلا خدمة يبقى حرًّا — سعرٌ يُكتب لا يُقارن بشيء (ويُدقَّق في invoice.create).
 */
import { decideProcedurePrice, type PriceOverrideKind } from "./price-authority";
import { catalogPriceIn, type ForeignRates, type PricedService } from "./service-pricing";
import { CLINIC_BASE_CURRENCY, type Currency } from "./money";

export interface InvoiceLineAuthorityInput {
  description: string;
  /** خدمة الدليل — null للبند اليدوي. */
  service: (PricedService & { priceConfigured: boolean }) | null;
  requestedMinor: number;
  quantity: number;
  /** هل كُتب السعر صراحةً؟ بلا سعرٍ مكتوب يؤخذ سعر الدليل فلا انحراف. */
  explicit: boolean;
  reason: string | null;
}

export interface InvoicePriceOverride {
  description: string;
  kind: PriceOverrideKind;
  catalogMinor: number;
  requestedMinor: number;
  discountPercent: number | null;
  reason: string | null;
}

export type InvoiceAuthorityDecision =
  | { ok: true; overrides: InvoicePriceOverride[]; discount: null | { percent: number; reason: string } }
  | { ok: false; message: string };

export function checkInvoiceAuthority(input: {
  lines: readonly InvoiceLineAuthorityInput[];
  currency: Currency;
  rates: ForeignRates;
  role: string;
  maxDiscountPercent: number;
  totalMinor: number;
  discountMinor: number;
  discountReason: string | null;
}): InvoiceAuthorityDecision {
  const overrides: InvoicePriceOverride[] = [];
  /* مرجع الحد المجمَّع: كل بندٍ بسعر دليله المقرَّر إن كان له، وإلا بسعره المكتوب — فخصم
     البنود وخصم الفاتورة يُقاسان معًا من سعر الدليل ولا يتراكمان فوق الحد. */
  let referenceMinor = 0;
  for (const line of input.lines) {
    const quantity = Math.max(1, Math.round(line.quantity));
    if (!line.service || !line.explicit) {
      referenceMinor += quantity * Math.max(0, line.requestedMinor);
      continue;
    }
    const priced = catalogPriceIn(line.service, input.currency, input.rates);
    // سعرٌ خاص بعملةٍ أجنبية قرّره المالك مقرَّرٌ بذاته؛ والمحوَّل يتبع تقرير السعر اليمني.
    const configured = priced.minor === null ? false
      : priced.source === "catalog" && input.currency !== CLINIC_BASE_CURRENCY ? true
        : line.service.priceConfigured;
    const decision = decideProcedurePrice({
      serviceName: line.description,
      catalogMinor: priced.minor ?? 0,
      priceConfigured: configured,
      requestedMinor: line.requestedMinor,
      role: input.role,
      reason: line.reason,
      maxDiscountPercent: input.maxDiscountPercent,
    });
    if (!decision.ok) return decision;
    if (decision.override) overrides.push({ description: line.description, ...decision.override });
    const catalogUnit = configured && (priced.minor ?? 0) > 0 ? priced.minor! : Math.max(0, line.requestedMinor);
    referenceMinor += quantity * Math.max(catalogUnit, Math.max(0, line.requestedMinor));
  }

  if (input.discountMinor <= 0) return { ok: true, overrides, discount: null };
  const reason = input.discountReason?.trim() ?? "";
  if (reason.length < 3) return { ok: false, message: "اكتب سبب الخصم على الفاتورة." };
  const total = Math.max(0, input.totalMinor);
  const percent = total > 0 ? Math.round((Math.min(input.discountMinor, total) / total) * 1000) / 10 : 100;
  const limit = Math.max(0, Number.isFinite(input.maxDiscountPercent) ? input.maxDiscountPercent : 0);
  if (input.role !== "admin" && percent > limit) {
    return {
      ok: false,
      message: `الخصم على الفاتورة ${percent}٪ يتجاوز الحد المسموح (${limit}٪) — يحتاج موافقة المدير.`,
    };
  }
  /* خصم البنود عن الدليل + خصم الفاتورة معًا لا يتجاوزان الحد (لغير المدير). */
  const net = Math.max(0, total - Math.min(input.discountMinor, total));
  const combined = referenceMinor > 0 ? Math.round(((referenceMinor - net) / referenceMinor) * 1000) / 10 : 0;
  if (input.role !== "admin" && combined > limit) {
    return {
      ok: false,
      message: `مجموع الخصم (على أسعار البنود والفاتورة معًا) ${combined}٪ يتجاوز الحد المسموح (${limit}٪) — يحتاج موافقة المدير.`,
    };
  }
  return { ok: true, overrides, discount: { percent, reason: reason.slice(0, 300) } };
}

/** سطر التدقيق لأسعارٍ خالفت الدليل: «تاج: 15000 ← 13500 (خصم عائلة)؛ …». */
export function formatPriceOverrides(overrides: readonly InvoicePriceOverride[]): string {
  return overrides.map((override) =>
    `${override.description}: ${override.catalogMinor} ← ${override.requestedMinor}${override.reason ? ` (${override.reason})` : ""}`).join("؛ ");
}

/**
 * (FIN-5، قرار المالك TD-05) خطةٌ بعملة اتفاق: سعرها يُكتب بالاتفاق ولا يُحوَّل من اليمني
 * بسعر اليوم أبدًا — فالسعر المحوَّل ليس «سعر دليل» يُقاس عليه الخصم. تُفرض السلطة على
 * بند الخطة الأجنبية فقط حين قرّر المالك للخدمة سعرًا بتلك العملة نفسها؛ وإلا يُقبل السعر
 * المكتوب ويُعلَّم «غير مسعّر» في التدقيق. خطة العملة الأساسية تبقى على سعر الدليل.
 */
export function agreementPricedService<T extends PricedService & { priceConfigured: boolean }>(
  service: T,
  currency: Currency,
): T {
  if (currency === CLINIC_BASE_CURRENCY) return service;
  const own = currency === "SAR" ? service.priceSarMinor : currency === "USD" ? service.priceUsdMinor : null;
  return own != null && own > 0 ? service : { ...service, priceConfigured: false };
}
