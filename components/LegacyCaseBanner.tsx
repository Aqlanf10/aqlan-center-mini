"use client";

import { LEGACY_CASE_LABEL } from "@/lib/legacy-treatment";

/**
 * (INV-LEGACY) حالةٌ بدأت قبل النظام في تبويب تخصصها: تُعرض مباشرةً موسومةً بذلك — لا «تحتاج تقييمًا أوليًّا».
 * العلاج يستمر عليها؛ وجلساتها (وشدّات التقويم) مشمولة بالاتفاق التاريخي.
 * لا طلب شبكة خاص به: يقرأ `legacyCases` من ملخّص المريض الذي حمّلته الصفحة تحت سياج المريض نفسه.
 */
export function LegacyCaseBanner({ cases, specialty }: {
  cases: readonly { id: number | null; specialty: string; title: string; site: string | null }[];
  specialty: string;
}) {
  const shown = cases.filter((one) => one.specialty === specialty);
  if (shown.length === 0) return null;
  return (
    <div role="status" data-testid={`legacy-case-banner-${specialty}`}
      className="mb-3 rounded-2xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-950">
      {shown.map((one, index) => (
        <p key={one.id ?? `legacy-${index}`} className="flex flex-wrap items-center gap-2 font-black">
          <span>{one.title}{one.site ? ` · ${one.site}` : ""}</span>
          <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-bold text-white">{LEGACY_CASE_LABEL}</span>
        </p>
      ))}
      <p className="mt-1 text-xs font-bold">العلاج يستمر على هذه الحالة؛ جلساته مشمولة بالاتفاق التاريخي ولا تُفوتر، والمتبقي في الرصيد السابق.</p>
    </div>
  );
}
