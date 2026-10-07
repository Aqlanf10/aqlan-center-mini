"use client";

import { useEffect, useState } from "react";
import type { SpecialtyCase } from "@/lib/db";
import { LEGACY_CASE_LABEL } from "@/lib/legacy-treatment";

/**
 * (INV-LEGACY) حالةٌ بدأت قبل النظام في تبويب تخصصها: تُعرض مباشرةً موسومةً بذلك — لا «تحتاج تقييمًا أوليًّا».
 * العلاج يستمر عليها؛ وجلساتها (وشدّات التقويم) مشمولة بالاتفاق التاريخي.
 */
export function LegacyCaseBanner({ patientId, specialty }: { patientId: number; specialty: string }) {
  const [cases, setCases] = useState<SpecialtyCase[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/patients/${patientId}/cases`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { cases?: SpecialtyCase[] } | null;
        if (response.ok && payload?.cases) {
          setCases(payload.cases.filter((one) => one.specialty === specialty && one.legacy === true
            && (one.status === "active" || one.status === "waiting")));
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [patientId, specialty]);
  if (cases.length === 0) return null;
  return (
    <div role="status" data-testid={`legacy-case-banner-${specialty}`}
      className="mb-3 rounded-2xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-950">
      {cases.map((one) => (
        <p key={one.id ?? `ortho-${one.orthoCaseId}`} className="flex flex-wrap items-center gap-2 font-black">
          <span>{one.title}{one.site ? ` · ${one.site}` : ""}</span>
          <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-bold text-white">{LEGACY_CASE_LABEL}</span>
        </p>
      ))}
      <p className="mt-1 text-xs font-bold">العلاج يستمر على هذه الحالة؛ جلساته مشمولة بالاتفاق التاريخي ولا تُفوتر، والمتبقي في الرصيد السابق.</p>
    </div>
  );
}
