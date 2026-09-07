import { redirect } from "next/navigation";
import { getPatient } from "@/lib/db";
import { CephCompareView } from "@/components/CephCompareView";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * صفحة مقارنة تحليلين سيفالومتريين لمريضٍ واحد.
 * (من مستودع الوكيل الآخر؛ الترتيب حاسمٌ يُفرض في الخادم لا الشاشة.)
 *
 * الأقدم «قبل» والأحدث «بعد» — وقلبُهما يقلب كل إشارة وكل حكم، فيُقرأ تراجعٌ
 * على أنه تحسّن. والصفحة بوابة الصلاحيات: من لا يرى أشعّة المريض لا يرى مقارنتها.
 */
export default async function CephComparePage({
  searchParams,
}: {
  searchParams: Promise<{ first?: string; second?: string; patient?: string }>;
}) {
  const session = await requireSession();
  if (!session) redirect("/login");

  const params = await searchParams;
  const first = Number(params.first);
  const second = Number(params.second);
  const patientId = Number(params.patient);

  if (!Number.isInteger(first) || first <= 0
      || !Number.isInteger(second) || second <= 0
      || first === second) {
    return (
      <p className="p-6 text-sm font-bold text-rose-700">
        اختر تحليلين مختلفين للمريض نفسه من تبويب الأشعة.
      </p>
    );
  }

  const patient = Number.isInteger(patientId) && patientId > 0
    ? await getPatient(patientId)
    : null;

  return (
    <div className="mx-auto max-w-[1200px] p-4">
      <CephCompareView
        first={first}
        second={second}
        patientName={patient?.fullName ?? `#${patientId}`}
      />
    </div>
  );
}
