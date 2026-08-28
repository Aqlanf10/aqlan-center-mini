import { getCephStudy, getPatient } from "@/lib/db";
import { CephTracer } from "@/components/CephTracer";
import { requireSession } from "@/lib/session";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * مساحة رسم التحليل السيفالومتري.
 *
 * الصفحة تقرأ التحليل ومعالمه ولقطته من النطاق وتسلّمها للشاشة — وما بعدها
 * تفاعلٌ يحفظ من المسارات نفسها. ومن لا جلسة له لا يرى الشععة أصلًا: مسار
 * الصورة نفسه محروس بالجلسة، فالصفحة البوابة لا الحاجز.
 */
export default async function CephWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) redirect("/login");

  const { id: raw } = await params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return <p className="p-6 text-sm text-red-700">رقم التحليل غير صالح.</p>;
  }

  const study = await getCephStudy(id);
  if (!study) {
    return <p className="p-6 text-sm text-red-700">التحليل غير موجود أو مرفوض.</p>;
  }
  const patient = await getPatient(study.analysis.patientId);

  return (
    <div className="mx-auto max-w-[1400px] p-4">
      <h1 className="mb-1 text-lg font-bold text-slate-800">
        التحليل السيفالومتري — {patient?.fullName ?? `#${study.analysis.patientId}`}
      </h1>
      <p className="mb-4 text-xs text-slate-500">
        الشععة تُقرأ من مستندات المريض (# {study.analysis.documentId}) بجلسةٍ كما هي.
        المعالم تُحفَظ لحظة نقرها وسحبها، والاعتماد يختم القياسات ويقفل التحليل.
      </p>
      <CephTracer
        patientName={patient?.fullName ?? ""}
        analysis={study.analysis}
        initialLandmarks={study.landmarks}
        stamped={
          study.analysis.status === "completed" && study.measurements.length > 0
            ? study.measurements
            : null
        }
      />
    </div>
  );
}
