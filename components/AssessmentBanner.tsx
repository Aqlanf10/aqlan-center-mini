"use client";

/**
 * (INV-LINK D) علاجٌ قبلته فاتورة ولم يبدأ سريريًّا: شريطٌ في تبويب التخصص يقول ذلك صراحةً.
 * لا تفاصيل سريرية مختلقة — فقط أن الحالة تنتظر تقييم الطبيب، وكيف تُستكمل.
 * لا طلب شبكة خاص به: يقرأ `assessmentCases` من ملخّص المريض الذي حمّلته الصفحة (تحت سياج المريض نفسه)،
 * فلا يضيف قراءةً للحالات خارج ضبط الصفحة لاستجابات المريض الحالي.
 */
export function AssessmentBanner({ cases, specialty, hint }: {
  cases: readonly { id: number; specialty: string; title: string }[];
  specialty: string;
  hint: string;
}) {
  const pending = cases.filter((one) => one.specialty === specialty);
  if (pending.length === 0) return null;
  return (
    <div role="status" data-testid={`assessment-banner-${specialty}`}
      className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-black">{pending.map((one) => one.title).join(" · ")}</p>
      <p className="mt-1 text-xs font-bold">العلاج مقبول ماليًّا بفاتورته ولم يبدأ سريريًّا. {hint}</p>
    </div>
  );
}
