"use client";

import { use } from "react";
import { ClinicalVisit } from "@/components/ClinicalVisit";
import { PageHeader } from "@/components/PageHeader";
import { CanonicalVisitClinical } from "@/components/CanonicalVisitClinical";
import { useSession } from "@/components/SessionProvider";

/**
 * شاشة الزيارة السريرية.
 *
 * تُفتح من الكرسي مباشرة — والطبيب على الكرسي لا يبحث في قوائم. (VISIT-2) وبعد التوقيع
 * يُفتح ملف المريض — ولو أُنشئ للتوّ — ففيه الفاتورة والتحصيل وحجز الجلسة القادمة.
 */
export default function VisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const visitId = Number(id);
  // M2 slice 84: a canonical account reads the projected visit (no price without the invoice view).
  const canonical = useSession()?.canonical === true;

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <PageHeader
        title="الزيارة السريرية"
        subtitle="التوثيق والإجراءات — والاستحقاق حسب مصادر العمل عند التوقيع"
        back={{ href: "/", label: "اللوحة" }}
      />
      {Number.isInteger(visitId) && visitId > 0 && canonical ? (
        <CanonicalVisitClinical key={visitId} visitId={visitId} />
      ) : Number.isInteger(visitId) && visitId > 0 ? (
        <ClinicalVisit visitId={visitId} onSigned={(result) => {
          /* (VISIT-2) بعد الإنهاء يُفتح ملف المريض (ولو أُنشئ للتوّ عند التوقيع) — فيه الفاتورة
             والتحصيل وحجز الجلسة القادمة؛ واللوحة تبقى على بعد نقرة. */
          window.location.href = result.patientId ? `/patients/${result.patientId}?tab=today&checkoutVisit=${visitId}` : "/";
        }} />
      ) : (
        <p className="rounded-2xl border border-danger-300 bg-danger-50 p-4 text-center text-sm font-semibold text-danger-700">
          رقم الزيارة غير صالح.
        </p>
      )}
    </main>
  );
}
