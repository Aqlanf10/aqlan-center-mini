/**
 * (FIN-DISC) خصمٌ إداريٌّ على فاتورةٍ صدرت — قرارٌ للمدير بسببٍ مكتوب.
 *
 * - يزيد خصم الفاتورة نفسها (invoices.discount_minor) ولا يمسّ بنودها ولا ربطها بالخطة أو الحالة.
 * - لا يتجاوز المتبقي على الفاتورة: ما دُفع عليها صراحةً يبقى كما هو، فلا ينشأ رصيدٌ دائن خفي ولا استرداد.
 * - الفاتورة الملغاة أو المسدَّدة لا تُخصم؛ المسدَّدة بالاسترداد أو التصحيح، والملغاة لا تعود.
 * - الخصم بعملة الفاتورة وحدها؛ لا تحويل بسعر اليوم.
 */
export const ADMIN_DISCOUNT_REASON_MIN = 3;
export const ADMIN_DISCOUNT_REASON_MAX = 300;

export type AdminDiscountRefusal =
  | "not_found" | "cancelled" | "paid" | "stale" | "invalid_amount" | "exceeds_remaining" | "reason"
  | "period_locked" | "failed" | "uncertain";

export const ADMIN_DISCOUNT_MESSAGE: Record<AdminDiscountRefusal, string> = {
  not_found: "الفاتورة غير موجودة.",
  cancelled: "الفاتورة ملغاة ولا يُضاف عليها خصم.",
  paid: "الفاتورة مسدّدة؛ الخصم بعد السداد يكون باسترداد أو تصحيح الفاتورة.",
  stale: "تغيّر خصم الفاتورة أو مدفوعها منذ فتح النموذج. أعد فتحه وراجع المبلغ.",
  invalid_amount: "اكتب مبلغ خصم صحيحًا أكبر من صفر بعملة الفاتورة.",
  exceeds_remaining: "الخصم أكبر من المتبقي على الفاتورة؛ المدفوع عليها لا يُخصم.",
  reason: `اكتب سبب الخصم (من ${ADMIN_DISCOUNT_REASON_MIN} إلى ${ADMIN_DISCOUNT_REASON_MAX} حرفًا).`,
  period_locked: "الفاتورة في فترة مقفلة. سجّل الخصم بقيدٍ في الفترة المفتوحة.",
  failed: "تعذّر تسجيل الخصم. لم يتغيّر شيء؛ أعد المحاولة.",
  // A lost connection at COMMIT: the outcome is unknown. A blind retry is refused anyway (the expected discount changed if it
  // was saved), but the manager must look first.
  uncertain: "انقطع الاتصال أثناء الحفظ ولم يُعرف هل سُجّل الخصم. أعد فتح الفاتورة وتحقق من خصمها قبل أي محاولة جديدة.",
};

export interface AdminDiscountState {
  status: string;
  totalMinor: number;
  discountMinor: number;
  /** صافي ما سُدّد على هذه الفاتورة صراحةً بعملتها (القبض − الاسترداد). */
  settledMinor: number;
}

export function invoiceRemainingMinor(state: AdminDiscountState): number {
  const net = Math.max(0, state.totalMinor - Math.min(state.discountMinor, state.totalMinor));
  // A net refund on the invoice never creates room above its net.
  return Math.max(0, net - Math.max(0, state.settledMinor));
}

/** يقرّر الخصم الإضافي دون أثرٍ جانبي — المصدر الواحد للمسار والمعاينة. */
/** What the manager saw when opening the form: both the discount and the paid amount must still hold. */
export interface AdminDiscountExpectation { discountMinor: number; settledMinor: number }

export function planAdminDiscount(state: AdminDiscountState, additionalMinor: number, expected: AdminDiscountExpectation | null):
  | { ok: true; beforeDiscountMinor: number; afterDiscountMinor: number; beforeNetMinor: number; afterNetMinor: number;
      remainingBeforeMinor: number; remainingAfterMinor: number }
  | { ok: false; reason: AdminDiscountRefusal } {
  if (state.status === "cancelled") return { ok: false, reason: "cancelled" };
  if (state.status === "paid") return { ok: false, reason: "paid" };
  // A changed discount OR a changed balance (a receipt, refund or correction since the form opened) is stale:
  // the manager decided on numbers that no longer hold.
  if (expected !== null && (expected.discountMinor !== state.discountMinor || expected.settledMinor !== state.settledMinor)) {
    return { ok: false, reason: "stale" };
  }
  if (!Number.isSafeInteger(additionalMinor) || additionalMinor <= 0) return { ok: false, reason: "invalid_amount" };
  const remainingBeforeMinor = invoiceRemainingMinor(state);
  if (additionalMinor > remainingBeforeMinor) return { ok: false, reason: "exceeds_remaining" };
  const afterDiscountMinor = state.discountMinor + additionalMinor;
  if (!Number.isSafeInteger(afterDiscountMinor) || afterDiscountMinor > state.totalMinor) return { ok: false, reason: "exceeds_remaining" };
  const beforeNetMinor = Math.max(0, state.totalMinor - state.discountMinor);
  return {
    ok: true, beforeDiscountMinor: state.discountMinor, afterDiscountMinor,
    beforeNetMinor, afterNetMinor: state.totalMinor - afterDiscountMinor,
    remainingBeforeMinor, remainingAfterMinor: remainingBeforeMinor - additionalMinor,
  };
}
