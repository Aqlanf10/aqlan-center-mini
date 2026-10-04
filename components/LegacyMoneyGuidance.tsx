/** Shared explanations only. These components never calculate or write money. */
export function OpeningBalanceGuidance() {
  return (
    <div className="space-y-1 text-[11px] font-semibold leading-5 text-amber-900" role="note">
      <p>أدخل المتبقي المستحق قبل بدء البرنامج بعد طرح ما دُفع سابقًا، وليس كامل قيمة العلاج.</p>
      <p>مثال بنفس العملة: قيمة العلاج 600، المدفوع سابقًا 250، الرصيد السابق الذي تُدخله 350.</p>
      <p>ما دُفع قبل البرنامج لا يُسجّل كسند قبض جديد. الرصيد السابق يدخل المديونية دون إيراد أو عمولة.</p>
    </div>
  );
}

export function CurrentCollectionGuidance() {
  return (
    <p role="note" className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold leading-5 text-amber-900">
      سجّل هنا مبلغًا استلمته الآن فقط؛ سيظهر في تحصيل الوردية الحالية.
      المبالغ المدفوعة قبل بدء البرنامج بيانات تاريخية، فلا تُدخلها كسند قبض هنا.
      عند نقل ملف قديم، يُسجّل المتبقي فقط في الرصيد السابق.
    </p>
  );
}
