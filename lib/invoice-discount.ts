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
  | "period_locked" | "failed" | "uncertain" | "covered_on_account" | "no_shift" | "commission_paid";

export const ADMIN_DISCOUNT_MESSAGE: Record<AdminDiscountRefusal, string> = {
  not_found: "الفاتورة غير موجودة.",
  cancelled: "الفاتورة ملغاة ولا يُضاف عليها خصم.",
  paid: "الفاتورة مسدّدة؛ الخصم بعد السداد يكون باسترداد أو تصحيح الفاتورة.",
  stale: "تغيّر خصم الفاتورة أو مدفوعها منذ فتح النموذج. أعد فتحه وراجع المبلغ.",
  invalid_amount: "اكتب مبلغ خصم صحيحًا أكبر من صفر بعملة الفاتورة.",
  exceeds_remaining: "الخصم أكبر من المتبقي على الفاتورة؛ المدفوع عليها لا يُخصم.",
  reason: `اكتب سبب الخصم (من ${ADMIN_DISCOUNT_REASON_MIN} إلى ${ADMIN_DISCOUNT_REASON_MAX} حرفًا).`,
  period_locked: "الفاتورة في فترة مقفلة. سجّل الخصم بقيدٍ في الفترة المفتوحة.",
  covered_on_account: "هذا الجزء من الفاتورة مغطّى بدفعاتٍ على حساب المريض؛ الخصم عليه يكون باسترداد أو تصحيح، لا بخصم إداري.",
  no_shift: "افتح وردية الصندوق أولًا؛ الخصم الإداري يُسجَّل والوردية مفتوحة كي لا يتقاطع مع قبضٍ أو صرف عمولة.",
  commission_paid: "هذا الخصم يُنزل عمولة طبيبٍ تحت ما صُرف له فعلًا. لم يُسجَّل شيء؛ يلزم تسوية إدارية لعمولة الطبيب قبل الخصم.",
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

/**
 * (FIN-DISC, owner decision: option 2) An admin discount is split across the invoice's lines exactly, in proportion to each
 * line's remaining value (its total minus earlier admin allocations). Largest remainder; ties by line id. A line never
 * receives more than its remaining value, and the parts always sum to the amount. Null when the amount does not fit.
 */
export interface DiscountableLine { id: number; totalMinor: number; allocatedMinor: number }
export function allocateAdminDiscount(lines: readonly DiscountableLine[], amountMinor: number): Map<number, number> | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
  const remaining = lines.map((line) => ({ id: line.id, value: BigInt(Math.max(0, line.totalMinor - line.allocatedMinor)) }));
  const pool = remaining.reduce((sum, line) => sum + line.value, BigInt(0));
  const amount = BigInt(amountMinor);
  if (pool <= BigInt(0) || amount > pool) return null;
  const parts = remaining.map((line) => ({ id: line.id, value: line.value, part: (amount * line.value) / pool,
    fraction: (amount * line.value) % pool }));
  let left = amount - parts.reduce((sum, line) => sum + line.part, BigInt(0));
  const order = [...parts].sort((a, b) => (a.fraction === b.fraction ? a.id - b.id : a.fraction > b.fraction ? -1 : 1));
  for (const line of order) {
    if (left <= BigInt(0)) break;
    if (line.part < line.value) { line.part += BigInt(1); left -= BigInt(1); }
  }
  if (left !== BigInt(0)) return null;
  return new Map(parts.filter((line) => line.part > BigInt(0)).map((line) => [line.id, Number(line.part)]));
}

/**
 * (FIN-DISC, review 5461894751) How much of an invoice the commission engine's FIFO already covers. Within one currency
 * bucket, collections fill the opening balance first and then the invoices oldest first, regardless of the invoice a
 * receipt named (on-account money included). A discount must not take the net below this amount: otherwise money already
 * collected would move to later invoices and change their earned commission after the fact.
 */
export function fifoCoverageOfInvoice(input: {
  openingMinor: number;
  /** Non-cancelled invoices of the same currency bucket, with their current net. */
  invoices: readonly { id: number; netMinor: number; createdAt: string }[];
  /** Effective collected amount in the bucket (payments net of their linked refunds). */
  collectedMinor: number;
}, invoiceId: number): number {
  let pool = Math.max(0, input.collectedMinor) - Math.max(0, input.openingMinor);
  const ordered = [...input.invoices].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  for (const invoice of ordered) {
    const net = Math.max(0, invoice.netMinor);
    const covered = Math.max(0, Math.min(pool, net));
    if (invoice.id === invoiceId) return covered;
    pool -= covered;
  }
  return 0;
}
