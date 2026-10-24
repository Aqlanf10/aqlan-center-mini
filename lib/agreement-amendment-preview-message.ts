export const AGREEMENT_PREVIEW_UNAVAILABLE = "البيانات أو الهجرة المالية غير جاهزة؛ لا يمكن حفظ التعديل.";

// Only fixed, public reasons emitted by the preview GET are displayable.
// Matching a code alone is not enough: never echo arbitrary server text, even
// on a 4xx. Keep this client-only contract independent of the financial writer.
const CONTROLLED_REASONS: readonly (readonly [number, string | undefined, string])[] = [
  [400, "invalid", "معرف الخطة غير صالح."],
  [401, undefined, "يجب تسجيل الدخول"],
  [403, "unauthorized", "يتطلب تعديل اتفاق العلاج جلسة مدير سارية."],
  [404, "missing", "الخطة غير موجودة."],
  [409, "conflict", "قيمة مالية خارج النطاق الآمن."],
  [409, "conflict", "مصدر التسويات غير مكتمل؛ يلزم مراجعة مالية."],
  [409, "conflict", "سند غير مثبت."],
  [409, "conflict", "تسوية خارج النطاق الآمن."],
  [409, "conflict", "مطلوب اتفاق فعال معتمد ومغطى بفاتورة واحدة مثبتة؛ لم يُنشأ تعديل."],
  [409, "conflict", "تعدد بنود العلاج يحتاج تخصيصًا ماليًا مستقلًا؛ لا يُخمّن فرق السعر."],
  [409, "conflict", "أصل الفاتورة لم يعد مطابقًا للاتفاق المعتمد."],
  [409, "conflict", "يوجد مصدر مالي آخر غير منسوب؛ يلزم إثبات التغطية."],
  [409, "conflict", "توجد فوترة أخرى للعمل؛ لا تُضاعف أصل العلاج."],
  [409, "conflict", "تغطية الفاتورة الأصلية غير مثبتة."],
  [409, "conflict", "سلسلة تعديلات الاتفاق غير متطابقة."],
  [409, "conflict", "فرق الاتفاق السابق لا يطابق مستند مديونيته."],
  [409, "conflict", "تجميع المبالغ خارج النطاق."],
  [409, "conflict", "الاستردادات تتجاوز سندات المصدر؛ يلزم مراجعة مالية."],
];

export function agreementAmendmentPreviewMessage(status: number, payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return AGREEMENT_PREVIEW_UNAVAILABLE;
  const value = payload as Record<string, unknown>;
  const known = CONTROLLED_REASONS.find(([httpStatus, code, message]) =>
    status === httpStatus && value.code === code && value.message === message);
  return known?.[2] ?? AGREEMENT_PREVIEW_UNAVAILABLE;
}
