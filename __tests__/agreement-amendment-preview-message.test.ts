import { describe, expect, it } from "vitest";
import { AGREEMENT_PREVIEW_UNAVAILABLE, agreementAmendmentPreviewMessage } from "../lib/agreement-amendment-preview-message";

describe("public agreement preview message contract", () => {
  const conflicts = [
    "قيمة مالية خارج النطاق الآمن.",
    "مصدر التسويات غير مكتمل؛ يلزم مراجعة مالية.",
    "سند غير مثبت.",
    "تسوية خارج النطاق الآمن.",
    "مطلوب اتفاق فعال معتمد ومغطى بفاتورة واحدة مثبتة؛ لم يُنشأ تعديل.",
    "تعدد بنود العلاج يحتاج تخصيصًا ماليًا مستقلًا؛ لا يُخمّن فرق السعر.",
    "أصل الفاتورة لم يعد مطابقًا للاتفاق المعتمد.",
    "يوجد مصدر مالي آخر غير منسوب؛ يلزم إثبات التغطية.",
    "توجد فوترة أخرى للعمل؛ لا تُضاعف أصل العلاج.",
    "تغطية الفاتورة الأصلية غير مثبتة.",
    "سلسلة تعديلات الاتفاق غير متطابقة.",
    "فرق الاتفاق السابق لا يطابق مستند مديونيته.",
    "تجميع المبالغ خارج النطاق.",
    "الاستردادات تتجاوز سندات المصدر؛ يلزم مراجعة مالية.",
  ];
  it.each(conflicts)("exposes only the exact controlled 409 conflict: %s", (message) => {
    expect(agreementAmendmentPreviewMessage(409, { code: "conflict", message })).toBe(message);
    for (const status of [200, 400, 401, 403, 404, 422, 500, 503]) {
      expect(agreementAmendmentPreviewMessage(status, { code: "conflict", message })).toBe(AGREEMENT_PREVIEW_UNAVAILABLE);
    }
    expect(agreementAmendmentPreviewMessage(409, { code: "stale", message })).toBe(AGREEMENT_PREVIEW_UNAVAILABLE);
    expect(agreementAmendmentPreviewMessage(409, { code: "conflict", message: `${message}\nPRIVATE detail` })).toBe(AGREEMENT_PREVIEW_UNAVAILABLE);
  });
  it.each([undefined, null, [], "PRIVATE response", 42, { message: 42 }, { code: "conflict" }])(
    "does not stringify malformed payload %j", (payload) => {
      expect(agreementAmendmentPreviewMessage(409, payload)).toBe(AGREEMENT_PREVIEW_UNAVAILABLE);
    },
  );
  it("does not expose a write-outcome message as a preview refusal", () => {
    expect(agreementAmendmentPreviewMessage(409, { code: "stale",
      message: "هذه المحاولة رُفضت بسبب تغيّر المصدر ولم تُحفظ؛ افحص حالتها قبل تحديث المعاينة." })).toBe(AGREEMENT_PREVIEW_UNAVAILABLE);
  });
});
