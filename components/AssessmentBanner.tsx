"use client";

import { useEffect, useState } from "react";
import type { SpecialtyCase } from "@/lib/db";

/**
 * (INV-LINK D) علاجٌ قبلته فاتورة ولم يبدأ سريريًّا: شريطٌ في تبويب التخصص يقول ذلك صراحةً.
 * لا تفاصيل سريرية مختلقة — فقط أن الحالة تنتظر تقييم الطبيب، وكيف تُستكمل.
 */
export function AssessmentBanner({ patientId, specialty, hint }: { patientId: number; specialty: string; hint: string }) {
  const [pending, setPending] = useState<SpecialtyCase[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/patients/${patientId}/cases`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { cases?: SpecialtyCase[] } | null;
        if (response.ok && payload?.cases) {
          setPending(payload.cases.filter((one) => one.specialty === specialty && one.needsAssessment));
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [patientId, specialty]);
  if (pending.length === 0) return null;
  return (
    <div role="status" data-testid={`assessment-banner-${specialty}`}
      className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-black">{pending.map((one) => one.title).join(" · ")}</p>
      <p className="mt-1 text-xs font-bold">العلاج مقبول ماليًّا بفاتورته ولم يبدأ سريريًّا. {hint}</p>
    </div>
  );
}
