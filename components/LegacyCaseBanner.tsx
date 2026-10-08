"use client";

import { LEGACY_CASE_LABEL } from "@/lib/legacy-treatment";
import { legacyCaseKey, type LegacyCase } from "@/lib/patient-workflow-cases";

/** Historical provenance is not consent, a clinical assessment, or current financial clearance. */
export function LegacyCaseBanner({ cases: acceptedCases, specialty }: { cases: readonly LegacyCase[]; specialty: string }) {
  const cases = acceptedCases.filter((one) => one.specialty === specialty);
  if (cases.length === 0) return null;
  return (
    <div role="status" data-testid={`legacy-case-banner-${specialty}`}
      className="mb-3 rounded-2xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-950">
      {cases.map((one) => (
        <p key={legacyCaseKey(one)} className="flex flex-wrap items-center gap-2 font-black">
          <span>{one.title}{one.site ? ` · ${one.site}` : ""}</span>
          <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-bold text-white">{LEGACY_CASE_LABEL}</span>
        </p>
      ))}
      <p className="mt-1 text-xs font-bold">تقدّم العلاج السابق وجلساته غير مثبتين بهذا التسجيل. سجّل التقييم والموافقة الفعلية، وراجع حالة التغطية المالية قبل توقيع الزيارة. يمكن حفظ المسودة أثناء استكمال ذلك.</p>
    </div>
  );
}
