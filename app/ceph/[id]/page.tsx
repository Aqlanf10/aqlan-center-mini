import { getCephReferenceSet, getCephStudy, getPatient } from "@/lib/db";
import { CephTracer } from "@/components/CephTracer";
import { requireSession } from "@/lib/session";
import { getAccessibleCephPatientId } from "@/lib/ceph-page-access";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * مساحة رسم التحليل السيفالومتري.
 *
 * الصفحة تقرأ التحليل ومعالمه ولقطته وتشخيصه ومجموعته المرجعية من النطاق وتسلّمها
 * للشاشة — وما بعدها تفاعلٌ يحفظ من المسارات نفسها. ومن لا جلسة له لا يرى الشععة
 * أصلًا. ويُفحص إذن أشعة المريض قبل قراءة التفاصيل أو تسليمها للشاشة.
 */
export default async function CephWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) redirect("/login");

  const { id: raw } = await params;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return <p className="p-6 text-sm text-red-700">رقم التحليل غير صالح.</p>;
  }

  const patientId = await getAccessibleCephPatientId(session, id);
  if (patientId === null) notFound();

  const study = await getCephStudy(id);
  if (!study || study.analysis.patientId !== patientId) {
    return <p className="p-6 text-sm text-red-700">التحليل غير موجود أو مرفوض.</p>;
  }
  const patient = await getPatient(study.analysis.patientId);
  const refSet = await getCephReferenceSet(study.analysis.refSet);

  return (
    <div className="mx-auto max-w-[1400px] p-4">
      <h1 className="mb-1 text-lg font-bold text-slate-800">
        التحليل السيفالومتري — {patient?.fullName ?? `#${study.analysis.patientId}`}
      </h1>
      <p className="mb-4 text-xs text-slate-500">
        الشععة تُقرأ من مستندات المريض (# {study.analysis.documentId}) بجلسةٍ كما هي.
        المعالم تُحفَظ لحظة نقرها وسحبها، والاعتماد يختم القياسات والتشخيص ويقفل التحليل.
      </p>
      <CephTracer
        patientName={patient?.fullName ?? ""}
        patientBirthYear={patient?.birthYear ?? null}
        analysis={study.analysis}
        initialLandmarks={study.landmarks}
        stamped={
          study.analysis.status === "completed" && study.measurements.length > 0
            ? study.measurements
            : null
        }
        refValues={refSet?.values ?? null}
        refSetName={refSet?.name ?? null}
        diagnosis={study.diagnosis}
      />
    </div>
  );
}
