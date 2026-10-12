"use client";

/** Choosing an origin is presentation only. The owning Account component keeps
 * the existing invoice and legacy writers, currencies and idempotency keys. */
export function TreatmentEntryChoice({ canAddLegacy, disabled, onSelect }: {
  canAddLegacy: boolean;
  disabled: boolean;
  onSelect: (mode: "invoice" | "legacy") => void;
}) {
  return <section aria-label="نوع الفاتورة / اتفاق العلاج" data-testid="treatment-entry-choice"
    className="mb-4 rounded-2xl border border-navy-200 bg-white p-4">
    <h3 className="text-base font-bold">كيف بدأ هذا العلاج؟</h3>
    <p className="mt-1 text-xs text-slate-600">اختر المسار قبل إدخال المبلغ. لا تُنشأ خطة أو حالة أو حركة مالية بمجرد الاختيار.</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <button type="button" aria-label="علاج جديد" disabled={disabled} onClick={() => { if (!disabled) onSelect("invoice"); }}
        className="min-h-11 rounded-xl border border-navy-200 p-3 text-right disabled:opacity-50">
        <span className="block font-bold">علاج جديد</span>
        <span className="mt-1 block text-xs text-slate-600">فاتورة فعلية بخدمة وعملة محددتين؛ راجع ربط الخطة والحالة قبل الحفظ. التحصيل منفصل.</span>
      </button>
      <button type="button" aria-label="علاج بدأ قبل النظام" disabled={disabled || !canAddLegacy}
        onClick={() => { if (!disabled && canAddLegacy) onSelect("legacy"); }}
        className="min-h-11 rounded-xl border border-indigo-200 p-3 text-right disabled:opacity-50">
        <span className="block font-bold">علاج بدأ قبل النظام</span>
        <span className="mt-1 block text-xs text-slate-600">الاتفاق والمدفوع تاريخيًا؛ المتبقي فقط يدخل الحساب. لا فاتورة ولا سند للمدفوع سابقًا.</span>
      </button>
    </div>
    {!canAddLegacy ? <p className="mt-2 text-xs text-slate-500">تسجيل العلاج السابق غير متاح بصلاحية الحساب الحالية.</p> : null}
  </section>;
}
