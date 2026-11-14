/**
 * (P1-6) سلطة سعر الإجراء: الدليل هو السعر، والانحراف قرارٌ مسبَّب ومدقَّق.
 *
 * العيب (تدقيق الجاهزية): طبيبٌ حفظ إجراءً سعره في الدليل ١٥٬٠٠٠ بسعر ١ ريال فخُزّن
 * ١ وكانت الفاتورة ستصدر بريال — والنمط نفسه يرفع السعر فيضخّم العمولة. الخادم كان
 * يثق برقم الطلب.
 *
 * القاعدة:
 *  - السعر = سعر الدليل ما دامت الخدمة مسعّرة. الطلب يقترح ولا يقرّ.
 *  - خصمٌ عن الدليل: بسببٍ مكتوب دائمًا؛ وغير المدير حتى الحد المضبوط في الإعدادات
 *    (`billing.max_discount_percent`) — وما زاد عليه للمدير وحده.
 *  - رفعٌ فوق الدليل: للمدير وحده وبسبب (يضخّم العمولة، فلا يمرّ بلا قرار).
 *  - خدمة غير مسعّرة في الدليل: يُقبل السعر المُدخل ويُعلَّم «سعرًا يدويًّا» للتدقيق.
 *  - بنود الخطة لا تمرّ من هنا: سعرها من الخطة وقاعدة فوترتها (مسارٌ قائم).
 */

export type PriceOverrideKind = "discount" | "increase" | "unpriced";

export interface PriceCheckInput {
  serviceName: string;
  /** سعر الخدمة في الدليل — بالوحدة الصغرى لعملة الأساس. */
  catalogMinor: number;
  /** هل قرّر المالك سعر الخدمة (لا صفرٌ ولا تخمين)؟ */
  priceConfigured: boolean;
  requestedMinor: number;
  role: string;
  reason: string | null;
  /** حد الخصم لغير المدير، ٪ (من الإعدادات). */
  maxDiscountPercent: number;
}

export type PriceDecision =
  | {
      ok: true;
      unitPriceMinor: number;
      override: null | { kind: PriceOverrideKind; catalogMinor: number; requestedMinor: number; discountPercent: number | null; reason: string | null };
    }
  | { ok: false; message: string };

function cleanReason(reason: string | null): string | null {
  const text = reason?.trim() ?? "";
  return text.length >= 3 ? text.slice(0, 300) : null;
}

export function decideProcedurePrice(input: PriceCheckInput): PriceDecision {
  const requested = Math.max(0, Math.round(input.requestedMinor));
  const reason = cleanReason(input.reason);

  if (!input.priceConfigured || input.catalogMinor <= 0) {
    return {
      ok: true,
      unitPriceMinor: requested,
      override: requested > 0
        ? { kind: "unpriced", catalogMinor: input.catalogMinor, requestedMinor: requested, discountPercent: null, reason }
        : null,
    };
  }

  const catalog = input.catalogMinor;
  if (requested === catalog) return { ok: true, unitPriceMinor: catalog, override: null };

  const admin = input.role === "admin";
  if (requested > catalog) {
    if (!admin) {
      return { ok: false, message: `سعر «${input.serviceName}» أعلى من سعر الدليل — رفع السعر للمدير وحده.` };
    }
    if (!reason) return { ok: false, message: `اكتب سبب تغيير سعر «${input.serviceName}» عن سعر الدليل.` };
    return { ok: true, unitPriceMinor: requested, override: { kind: "increase", catalogMinor: catalog, requestedMinor: requested, discountPercent: null, reason } };
  }

  const discountPercent = Math.round(((catalog - requested) / catalog) * 1000) / 10;
  if (!reason) return { ok: false, message: `اكتب سبب الخصم على «${input.serviceName}» (${discountPercent}٪ عن سعر الدليل).` };
  if (!admin && discountPercent > Math.max(0, input.maxDiscountPercent)) {
    return {
      ok: false,
      message: `الخصم على «${input.serviceName}» ${discountPercent}٪ يتجاوز الحد المسموح (${Math.max(0, input.maxDiscountPercent)}٪) — يحتاج موافقة المدير.`,
    };
  }
  return { ok: true, unitPriceMinor: requested, override: { kind: "discount", catalogMinor: catalog, requestedMinor: requested, discountPercent, reason } };
}

/**
 * The same decision by explicit grants (M2 slice 85, the approved route map's
 * `priceOverrides` fields). A role label never decides here:
 * - discount within `billing.max_discount_percent`: `finance.discounts.apply`, with a reason;
 * - discount beyond the ceiling: `finance.discounts.override`;
 * - price above the catalogue: `finance.price-increases.apply`, with a reason;
 * - a manual price for an unpriced service: also `finance.price-increases.apply` (a price
 *   above the catalogue's none; narrower than the legacy doctor/admin reach).
 * `requestedMinor === null` means "the server price": an unchanged saved line keeps its saved
 * price (decided and audited when set); a new line takes the catalogue price. Never a request.
 */
export interface PriceGrants { discount: boolean; discountOverride: boolean; increase: boolean }
export function decideProcedurePriceByGrants(
  input: Omit<PriceCheckInput, "role" | "requestedMinor"> & {
    requestedMinor: number | null;
    /** An unchanged saved line's price: already decided and audited when it was set. */
    keptMinor?: number | null;
  },
  grants: PriceGrants,
): PriceDecision {
  const unpriced = !input.priceConfigured || input.catalogMinor <= 0;
  if (input.requestedMinor === null && typeof input.keptMinor === "number") return { ok: true, unitPriceMinor: input.keptMinor, override: null };
  if (input.requestedMinor === null) return { ok: true, unitPriceMinor: unpriced ? 0 : input.catalogMinor, override: null };
  const requested = Math.max(0, Math.round(input.requestedMinor));
  const reason = cleanReason(input.reason);
  if (unpriced) {
    if (requested === 0) return { ok: true, unitPriceMinor: 0, override: null };
    if (!grants.increase) return { ok: false, message: `«${input.serviceName}» غير مسعّرة في الدليل — تسعيرها يدويًا يحتاج صلاحية تطبيق زيادة السعر.` };
    if (!reason) return { ok: false, message: `اكتب سبب السعر اليدوي لـ«${input.serviceName}».` };
    return { ok: true, unitPriceMinor: requested, override: { kind: "unpriced", catalogMinor: input.catalogMinor, requestedMinor: requested, discountPercent: null, reason } };
  }
  const catalog = input.catalogMinor;
  if (requested === catalog) return { ok: true, unitPriceMinor: catalog, override: null };
  if (requested > catalog) {
    if (!grants.increase) return { ok: false, message: `سعر «${input.serviceName}» أعلى من سعر الدليل — يحتاج صلاحية تطبيق زيادة السعر.` };
    if (!reason) return { ok: false, message: `اكتب سبب تغيير سعر «${input.serviceName}» عن سعر الدليل.` };
    return { ok: true, unitPriceMinor: requested, override: { kind: "increase", catalogMinor: catalog, requestedMinor: requested, discountPercent: null, reason } };
  }
  const discountPercent = Math.round(((catalog - requested) / catalog) * 1000) / 10;
  if (!grants.discount && !grants.discountOverride) return { ok: false, message: `الخصم على «${input.serviceName}» يحتاج صلاحية تطبيق الخصم.` };
  if (!reason) return { ok: false, message: `اكتب سبب الخصم على «${input.serviceName}» (${discountPercent}٪ عن سعر الدليل).` };
  if (!grants.discountOverride && discountPercent > Math.max(0, input.maxDiscountPercent)) {
    return { ok: false, message: `الخصم على «${input.serviceName}» ${discountPercent}٪ يتجاوز الحد المسموح (${Math.max(0, input.maxDiscountPercent)}٪) — يحتاج صلاحية تجاوز حد الخصم.` };
  }
  return { ok: true, unitPriceMinor: requested, override: { kind: "discount", catalogMinor: catalog, requestedMinor: requested, discountPercent, reason } };
}
