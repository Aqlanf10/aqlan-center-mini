"use client";

import type { AssessmentCase } from "@/lib/patient-workflow-cases";

/** Invoice provenance does not establish clinical consent, current settlement, or readiness to treat. */
export function AssessmentBanner({ cases, specialty, hint }: {
  cases: readonly AssessmentCase[]; specialty: string; hint: string;
}) {
  const pending = cases.filter((one) => one.specialty === specialty);
  if (pending.length === 0) return null;
  return (
    <div role="status" data-testid={`assessment-banner-${specialty}`}
      className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-black">{pending.map((one) => one.title).join(" · ")}</p>
      <p className="mt-1 text-xs font-bold">حالة مرتبطة بفاتورة وتنتظر تقييم الطبيب. الفاتورة لا تثبت الموافقة السريرية أو اكتمال السداد. {hint}</p>
    </div>
  );
}
