"use client";

import { use } from "react";
import { ClinicalVisit } from "@/components/ClinicalVisit";
import { PageHeader } from "@/components/PageHeader";

/**
 * شاشة الزيارة السريرية.
 *
 * تُفتح من الكرسي مباشرة — والطبيب على الكرسي لا يبحث في قوائم. (VISIT-2) وبعد التوقيع
 * يُفتح ملف المريض — ولو أُنشئ للتوّ — ففيه الفاتورة والتحصيل وحجز الجلسة القادمة.
 */
export default function VisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const visitId = Number(id);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <PageHeader
        title="الزيارة السريرية"
        subtitle="التوثيق والإجراءات — والتوقيع يُصدر الفاتورة ويحدّث المخطط"
        back={{ href: "/", label: "اللوحة" }}
      />
      {Number.isInteger(visitId) && visitId > 0 ? (
        <ClinicalVisit visitId={visitId} onSigned={(result) => {
          /* (VISIT-2) بعد الإنهاء يُفتح ملف المريض (ولو أُنشئ للتوّ عند التوقيع) — فيه الفاتورة
             والتحصيل وحجز الجلسة القادمة؛ واللوحة تبقى على بعد نقرة. */
          window.location.href = result.patientId ? `/patients/${result.patientId}?tab=account` : "/";
        }} />
      ) : (
        <p className="rounded-2xl border border-danger-300 bg-danger-50 p-4 text-center text-sm font-semibold text-danger-700">
          رقم الزيارة غير صالح.
        </p>
      )}
    </main>
  );
}
