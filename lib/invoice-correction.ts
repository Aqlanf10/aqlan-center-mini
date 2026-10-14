/**
 * (FIN-2) تصحيح فاتورةٍ صدرت بمبلغٍ زائد — منطقٌ خالص يُختبر بلا قاعدة.
 *
 * المشكلة: مبلغٌ زائد يُسجَّل على المريض بالخطأ (سعرٌ أعلى، كمية زائدة، بندٌ لم يُعمل)
 * ولا طريق في الشاشة لتصحيحه. الفاتورة وثيقة مالية لا تُعدَّل في مكانها، فالتصحيح:
 * **تُلغى الفاتورة الخاطئة وتصدر بدلها فاتورةٌ مصحَّحة** برقمٍ جديد، مربوطةً بها، بسببٍ
 * مكتوب — والمدفوع على الأولى يبقى للمريض فيسدّد المصحَّحة.
 *
 * التصحيح **تخفيضٌ فقط**: كل بندٍ باقٍ بكميةٍ وسعرٍ لا يزيدان على الأصل، والبند المحذوف
 * لا يُصدر. الزيادة ليست تصحيحًا — هي فاتورةٌ جديدة بما أُضيف.
 */

export interface CorrectionOriginalItem {
  id: number;
  quantity: number;
  unitPriceMinor: number;
}

export interface CorrectionLineInput {
  itemId: number;
  quantity: number;
  unitPriceMinor: number;
}

export type CorrectionPlan =
  | {
    ok: true;
    lines: { itemId: number; quantity: number; unitPriceMinor: number; totalMinor: number }[];
    totalMinor: number;
    discountMinor: number;
  }
  | { ok: false; message: string };

export const CORRECTION_REASON_MIN = 3;
export const CORRECTION_REASON_MAX = 300;

/** Authorized revision arithmetic. Issued values remain in the original invoice;
 * increases and decreases both produce one replacement, using safe minor units. */
export function planInvoiceRevision(
  original: readonly CorrectionOriginalItem[],
  requested: readonly CorrectionLineInput[],
  discountMinor: number,
): CorrectionPlan {
  if (!requested.length || requested.length > 200) return { ok: false, message: "أبقِ بندًا واحدًا على الأقل في الفاتورة المصححة." };
  const ids = new Set(original.map(item => item.id));
  const seen = new Set<number>();
  const lines: { itemId: number; quantity: number; unitPriceMinor: number; totalMinor: number }[] = [];
  let totalMinor = 0;
  for (const line of requested) {
    if (!Number.isSafeInteger(line.itemId) || !ids.has(line.itemId) || seen.has(line.itemId)) return { ok: false, message: "بند التصحيح مكرر أو لا يخص هذه الفاتورة." };
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || !Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) return { ok: false, message: "راجع الكمية والسعر؛ المبالغ بوحدات العملة الصحيحة." };
    const amount = line.quantity * line.unitPriceMinor;
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(totalMinor + amount)) return { ok: false, message: "مجموع الفاتورة خارج النطاق الآمن." };
    seen.add(line.itemId); totalMinor += amount; lines.push({ ...line, totalMinor: amount });
  }
  if (!Number.isSafeInteger(discountMinor) || discountMinor < 0 || discountMinor > totalMinor) return { ok: false, message: "الخصم لا يتجاوز مجموع البنود." };
  return { ok: true, lines, totalMinor, discountMinor };
}

/** البنود الباقية بعد التصحيح وإجماليها — أو سبب الرفض بالعربية. */
export function planInvoiceCorrection(
  original: readonly CorrectionOriginalItem[],
  requested: readonly CorrectionLineInput[],
  originalDiscountMinor: number,
): CorrectionPlan {
  if (requested.length === 0) {
    return { ok: false, message: "أبقِ بندًا واحدًا على الأقل — ولإسقاط الفاتورة كلها استعمل الإلغاء." };
  }
  const byId = new Map(original.map((item) => [item.id, item]));
  const seen = new Set<number>();
  const lines: { itemId: number; quantity: number; unitPriceMinor: number; totalMinor: number }[] = [];
  for (const line of requested) {
    const item = byId.get(line.itemId);
    if (!item || seen.has(line.itemId)) return { ok: false, message: "بندٌ غير موجود في هذه الفاتورة." };
    seen.add(line.itemId);
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      return { ok: false, message: "الكمية عددٌ صحيح من ١ فأكثر." };
    }
    if (!Number.isInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
      return { ok: false, message: "السعر مبلغٌ صحيح لا يقل عن صفر." };
    }
    if (line.quantity > item.quantity || line.unitPriceMinor > item.unitPriceMinor) {
      return { ok: false, message: "التصحيح تخفيضٌ فقط — لإضافة مبلغ أصدر فاتورةً جديدة." };
    }
    lines.push({ ...line, totalMinor: line.quantity * line.unitPriceMinor });
  }
  const totalMinor = lines.reduce((sum, line) => sum + line.totalMinor, 0);
  const originalTotal = original.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0);
  if (totalMinor >= originalTotal) {
    return { ok: false, message: "لم يتغيّر شيء — خفّض سعر بندٍ أو كميته أو احذف البند الزائد." };
  }
  // الخصم الممنوح يبقى كما هو ما لم يتجاوز الإجمالي الجديد.
  const discountMinor = Math.min(Math.max(0, originalDiscountMinor), totalMinor);
  return { ok: true, lines, totalMinor, discountMinor };
}
