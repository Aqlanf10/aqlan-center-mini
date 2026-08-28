"use client";

import { use } from "react";
import { ClinicalVisit } from "@/components/ClinicalVisit";
import { PageHeader } from "@/components/PageHeader";

/**
 * شاشة الزيارة السريرية.
 *
 * تُفتح من الكرسي مباشرة — والطبيب على الكرسي لا يبحث في قوائم. وبعد التوقيع تعود
 * إلى اللوحة، لأن الشاشة التالية في يومه هي المريض التالي لا هذه الزيارة.
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
        <ClinicalVisit visitId={visitId} onSigned={() => { window.location.href = "/"; }} />
      ) : (
        <p className="rounded-2xl border border-danger-300 bg-danger-50 p-4 text-center text-sm font-semibold text-danger-700">
          رقم الزيارة غير صالح.
        </p>
      )}
    </main>
  );
}
