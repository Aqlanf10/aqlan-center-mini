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
