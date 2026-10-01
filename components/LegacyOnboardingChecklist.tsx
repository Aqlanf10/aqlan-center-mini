"use client";

import { useEffect, useState } from "react";
import type { LegacyOnboarding } from "@/lib/legacy-onboarding";

const CLASS_TEXT: Record<string, string> = {
  LEGACY_INCLUDED: "الشدّة اليوم مشمولة بالعلاج السابق — بلا فاتورة جديدة.",
  INCLUDED: "الشدّة اليوم مشمولة باتفاق الأقساط — بلا فاتورة مستقلة.",
  OUTSIDE_CONTRACT: "الشدّة اليوم تحتاج قرار فوترة (خارج العقد أو تُفوتر كل جلسة).",
  NEW_BILLABLE: "مستحق جديد.",
  NO_CHARGE: "بلا رسوم.",
};

/**
 * (P1-A) تهيئة مريض التقويم السابق للنظام: ما اكتمل وما الناقص، وأثره على فوترة الشدّة —
 * من الخادم بالمصنِّف نفسه الذي يقرر التوقيع. لا يكتب شيئًا: كل خطوة في مكانها القائم.
 */
export function LegacyOnboardingChecklist({ patientId }: { patientId: number }) {
  const [data, setData] = useState<LegacyOnboarding | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/patients/${patientId}/legacy-onboarding`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { onboarding: LegacyOnboarding | null };
        if (!cancelled) setData(payload.onboarding);
      } catch {
        // القائمة مساعدة — الحالة تعمل بدونها.
      }
    })();
    return () => { cancelled = true; };
  }, [patientId]);

  if (!data || !data.legacy) return null;
  return (
    <section className={`mt-2 rounded-xl border px-3 py-2 text-[11px] ${data.complete ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}
      aria-label="تهيئة الحالة السابقة">
      <p className="mb-1 font-extrabold text-navy-900">
        {data.complete ? "✓ تهيئة الحالة السابقة مكتملة" : "تهيئة الحالة السابقة — خطوات ناقصة"}
      </p>
      <ul className="space-y-0.5">
        {data.steps.map((step) => (
          <li key={step.key} className="flex items-start gap-1.5">
            <span aria-hidden>{step.done ? "✅" : step.optional ? "◻️" : "⚠️"}</span>
            <span>
              <span className="font-bold text-slate-800">{step.label}</span>
              {step.optional && !step.done ? <span className="text-slate-500"> (اختياري)</span> : null}
              {!step.done && step.hint ? <span className="block text-slate-600">{step.hint}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1 font-bold text-slate-700">{CLASS_TEXT[data.adjustmentClass] ?? ""}</p>
      {data.warning ? <p className="mt-1 font-bold text-amber-800">{data.warning}</p> : null}
    </section>
  );
}
