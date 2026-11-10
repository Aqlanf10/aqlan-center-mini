/** Display-only guidance. Validation and persisted error contracts are unchanged. */
export function observationInputHintV2(code: string): string {
  const hints: Record<string, string> = {
    missing_observation_date: "افتح «المصدر والتاريخ» وحدد تاريخ الفحص، أو اختر غير معلوم مع السبب.",
    invalid_observation_date: "راجع تاريخ الفحص أو سبب غياب التاريخ في «المصدر والتاريخ».",
    invalid_method: "حدد طريقة التوثيق واكتب وصفاً لها في «المصدر والتاريخ».",
    invalid_performer: "أكمل إسناد منفذ الفحص أو اختر غير معلوم.",
    missing_report_source: "اربط التقرير الخارجي من قائمة المصادر المصرح بها.",
    invalid_observation_value: "أكمل القيمة أو سبب الحالة المختارة؛ الفراغ لا يمثل نتيجة.",
    number_missing: "أدخل قيمة القياس؛ الفراغ ليس صفراً.",
    number_partial: "أكمل كتابة الرقم قبل الحفظ؛ القيمة المدخلة ما زالت غير مكتملة.",
    number_empty: "أدخل قيمة القياس؛ الفراغ ليس صفراً.",
    number_invalid: "راجع صيغة الرقم والفاصل العشري المحدد.",
    number_ambiguous: "استخدم فاصلاً عشرياً واحداً مطابقاً لاختيار الإدخال.",
  };
  return hints[code] ?? "راجع قيمة الحقل ومصدره وتاريخه. لم يُحفظ هذا المدخل بعد.";
}
