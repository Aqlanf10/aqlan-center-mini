import { CephSavedCompletionEvidence } from "@/components/CephSavedCompletionEvidence";
import { CephReportTracing } from "@/components/CephReportTracing";
import { buildCephReportTracing, cephAgeAtAcquisition, cephReportAgeLabel, cephReportCalibration, sameCephReportSource } from "@/lib/ceph-report-view";
import { cephDraftReferenceContext, CEPH_UNAVAILABLE_NOTICE, CEPH_INTEGRITY_NOTICE, cephCompletionNotice, enrichPresentedCephMeasurements, isQuarantinedCephMeasurement, presentCephMeasurements } from "@/lib/cephPresentation";
import { CephReportMeasurements } from "@/components/CephReportMeasurements";
import { CephReportStyle } from "@/components/CephReportStyle";
import { PrintMetadata } from "@/components/PrintDocument";
import { CephDraftReferenceEvidence } from "@/components/CephDraftReferenceEvidence";
import { CephScientificContext } from "@/components/CephScientificContext";
import { notFound } from "next/navigation";
import { getCephStudy, getPatient, getSettingsSafe } from "@/lib/db";
import { computeAll, isDescriptiveCephMeasurement, type LandmarkMap } from "@/lib/ceph";
import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { friendlyDateLong } from "@/lib/reminders";

export const dynamic = "force-dynamic";

const PHASE_LABEL: Record<string, { ar: string; en: string }> = {
  pretreatment: { ar: "قبل العلاج", en: "Pre-treatment" },
  during: { ar: "أثناء العلاج", en: "In-treatment" },
  posttreatment: { ar: "بعد العلاج", en: "Post-treatment" },
  followup: { ar: "متابعة", en: "Follow-up" },
};
/** Read-only report: completed numbers, diagnosis and geometry come from saved
 * evidence. Drawing does not invoke today's clinical calculation engine. */
export default async function CephPrintReportPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) notFound();
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const [study, settings] = await Promise.all([getCephStudy(id), getSettingsSafe()]);
  if (!study) notFound();
  if (!(await canAccessPatient(session, study.analysis.patientId, "canViewXrays").catch(() => false))) notFound();

  const completed = study.analysis.status === "completed";
  if (study.analysis.status !== "draft" && !completed) {
    return <p role="alert" className="p-6 text-red-700">الدراسة مرفوضة أو غير متاحة؛ لا يصدر عنها تقرير سريري.</p>;
  }
  if (completed && study.provenance?.state === "integrity_unavailable") {
    return <p role="alert" className="p-6 text-red-700">{CEPH_INTEGRITY_NOTICE}</p>;
  }
  const historical = completed && study.provenance?.state === "versioned" ? study.provenance.witness : null;
  const geometryInput = { analysisId: study.analysis.id, patientId: study.analysis.patientId,
    documentId: study.analysis.documentId, status: study.analysis.status,
    draftLandmarks: study.landmarks, saved: historical };
  if (historical && !sameCephReportSource(geometryInput)) {
    return <p role="alert" className="p-6 text-red-700">{CEPH_INTEGRITY_NOTICE}</p>;
  }
  const tracing = buildCephReportTracing(geometryInput);
  const diagnosis = historical ? historical.snapshot.diagnosis : study.diagnosis;
  const patient = await getPatient(study.analysis.patientId);
  const draftReference = cephDraftReferenceContext(completed ? undefined : study.completionSources, study.analysis);
  const points: LandmarkMap = {};
  for (const landmark of completed ? [] : study.landmarks) points[landmark.code] = { x: landmark.x, y: landmark.y };
  // Never recompute sealed values, including empty or legacy snapshots.
  const rawResults = completed ? [] : computeAll(points, study.analysis.mmPerPixel ?? NaN);
  const table = presentCephMeasurements(rawResults, completed ? study.measurements : null, study.provenance);
  const enriched = enrichPresentedCephMeasurements(table, draftReference.refs, completed, draftReference.source);
  const ageAtXray = cephAgeAtAcquisition(patient?.birthYear, study.analysis.xrayDate);
  const calibrationLabel = cephReportCalibration(study.analysis.status, study.analysis.mmPerPixel, historical);
  const recordedActor = historical ? historical.actor.username : study.analysis.completedBy?.trim() || "غير موثّق في السجل";
  const recordedAt = historical ? historical.sealedAt : study.analysis.completedAt;

  return <>
    <PrintButton />
    <article className="sheet sheet-a4 ceph-clinical-report" aria-label="تقرير التحليل السيفالومتري">
      <CephReportStyle />
      <PrintHeader settings={settings} title="تقرير التحليل السيفالومتري · Cephalometric Report" />
      <div className="ceph-status" role="note">
        <strong>{completed ? "سجل معتمد — القياسات والملاحظات من النسخة المحفوظة" : "مسودة للمراجعة — ليست تقريرًا معتمدًا"}</strong>
        <span className="ceph-small">{completed ? "الاعتماد يوثّق مراجعة المدخلات، ولا يُعدّ تحققًا سريريًا مستقلًا. تفاصيل المصدر في ملحق التدقيق." : "النتائج مقروءة عند فتح الطباعة؛ راجع المعايرة والنقاط واحفظ الدراسة قبل اعتمادها."}</span>
      </div>
      <PrintMetadata>
        <div><span>المريض / Patient: </span><b>{patient?.fullName ?? `#${study.analysis.patientId}`}</b></div>
        <div><span>معرّف المريض / Patient ID: </span><bdi>{study.analysis.patientId}</bdi></div>
        <div><span>رقم الدراسة / Study: </span><bdi>{study.analysis.id}</bdi></div>
        <div><span>الجنس / Gender: </span><b>{patient?.gender === "male" ? "ذكر (Male)" : patient?.gender === "female" ? "أنثى (Female)" : "—"}</b></div>
        <div><span>تاريخ الأشعة / Acquisition: </span><bdi>{study.analysis.xrayDate ?? "غير محدد"}</bdi></div>
        <div data-testid="ceph-report-acquisition-age"><span>العمر التقريبي وقت التصوير: </span><b>{cephReportAgeLabel(ageAtXray)}</b></div>
        <div><span>مرحلة العلاج / Phase: </span><b>{PHASE_LABEL[study.analysis.phase]?.ar ?? study.analysis.phase}</b></div>
        <div><span>حالة التحليل / Status: </span><b>{completed ? "معتمد (Confirmed)" : "مسودة (Draft)"}</b></div>
        <div data-testid="ceph-report-calibration"><span>معايرة الصورة / Image calibration: </span><bdi>{calibrationLabel}</bdi></div>
        <div><span>المجموعة المرجعية / Reference: </span><span>{completed ? historical?.referenceSet.name ?? "المرجع التاريخي غير موثّق" : draftReference.name}</span></div>
      </PrintMetadata>
      {completed && <p role="note" className="ceph-small">بيانات المريض وتاريخ التصوير أعلاه من السجل الحالي؛ ليست توثيقًا مستقلًا لبياناته الديموغرافية وقت الاعتماد.</p>}
      {completed && !historical && <p role="note" className="ceph-small">{cephCompletionNotice(study.provenance)}</p>}
      <h2>الصورة الهندسية للمعالم<span dir="ltr">Landmark geometry</span></h2>
      <CephReportTracing tracing={tracing} />
      <p className="ceph-small">الرسم يربط المعالم المحددة فقط؛ لا يمثل تتبعًا تشريحيًا كاملًا ولا يضيف بنى غير مرسومة.</p>
      <CephReportMeasurements completed={completed} contextLabel={`${patient?.fullName ?? "المريض"} · دراسة ${study.analysis.id} · ${completed ? "سجل معتمد" : "مسودة"}`} rows={enriched.filter(row => !isQuarantinedCephMeasurement(row.code)).map(row => ({
        ...row, descriptiveOnly: completed ? row.descriptiveOnly : isDescriptiveCephMeasurement(row.code),
      }))} />
      <section className="ceph-diagnosis" aria-label="التشخيص وملاحظات الطبيب">
        <h2>{completed ? "التشخيص والملاحظات المحفوظة عند الاعتماد" : "مسودة التشخيص وملاحظات الطبيب"}<span dir="ltr">Clinician diagnosis and notes</span></h2>
        <p className="ceph-small">{patient?.fullName ?? "المريض"} · دراسة {study.analysis.id} · {completed ? "سجل معتمد" : "مسودة"}</p>
        <p className="ceph-small">النصوص أدناه كما حُفظت؛ لا تنشئ هذه الطباعة تشخيصًا أو خطة علاج جديدة.</p>
        {diagnosis?.skeletal && <><h3>العلاقات الهيكلية / Skeletal</h3><div className="ceph-notes">{diagnosis.skeletal}</div></>}
        {diagnosis?.dental && <><h3>العلاقات السنية / Dental</h3><div className="ceph-notes">{diagnosis.dental}</div></>}
        {diagnosis?.softTissue && <><h3>الأنسجة الرخوة / Soft tissue</h3><div className="ceph-notes">{diagnosis.softTissue}</div></>}
        <h3>الاستنتاج السيفالومتري / Conclusion</h3>
        <div className="ceph-notes">{diagnosis?.finalDx || "لم يُسجّل استنتاج في هذه النسخة."}</div>
        {diagnosis?.note && <><h3>الملاحظات والخطة كما حُفظت</h3><div className="ceph-notes">{diagnosis.note}</div></>}
        <p className="ceph-small">{CEPH_UNAVAILABLE_NOTICE}</p>
        <div className="sign-row ceph-signature" style={{ marginTop: "5mm" }}>
          <div>
            <p><b>{completed ? "المعتمِد المسجّل: " : "حالة الاعتماد: "}</b>{completed ? recordedActor : "لم يُعتمد بعد"}</p>
            {!historical && study.diagnosis?.createdBy && <p><b>محرر التشخيص: </b>{study.diagnosis.createdBy}</p>}
            <p className="ceph-small">{completed ? `تاريخ الاعتماد: ${recordedAt ? friendlyDateLong(recordedAt.split("T")[0]) : "غير موثّق في السجل"}` : "مسودة قيد المراجعة؛ الطباعة لا تعني الاعتماد"}</p>
          </div>
          <div style={{ minWidth: "50mm", textAlign: "center" }}>
            <p>{completed ? "توقيع وخاتم الطبيب المعالج" : "مكان التوقيع بعد المراجعة والاعتماد"}</p>
            <div style={{ height: "12mm", borderBottom: "1px solid #9aaeba" }} />
            <p className="ceph-small">{settings["clinic.lead_doctor"]} — {settings["clinic.lead_doctor_title"]}</p>
          </div>
        </div>
      </section>
      <details className="ceph-audit" data-testid="ceph-report-audit-appendix">
        <summary>ملحق التدقيق والمصادر — افتحه قبل الطباعة لإرفاقه بالتقرير</summary>
        <div className="ceph-audit-content">
          {!completed && <><CephScientificContext /><CephDraftReferenceEvidence context={draftReference} />
            <p>هذه قراءة جديدة لمسودة قابلة للتغيير وقت فتح الطباعة، وليست لقطة اعتماد أو نسخة مضمونة المطابقة للشاشة المفتوحة سابقًا.</p></>}
          {completed && <p>{cephCompletionNotice(study.provenance)}</p>}
          {historical && <CephSavedCompletionEvidence witness={historical} />}
          {historical && <section><h3>مصادر الحساب والمراجع المحفوظة وقت الاعتماد</h3>
            <p>{historical.referenceSet.name} · {historical.referenceSet.version}</p>
            <p dir="ltr">Image SHA-256: {historical.image.sha256}</p>
            <p dir="ltr">Reference SHA-256: {historical.referenceSetSha256}</p>
            {historical.measurements.map(row => <div key={row.code} className="ceph-audit-entry"><b>{row.code}</b>
              <p>{row.algorithm.id} · {row.algorithm.version} · {row.algorithm.calculationVersion ?? "—"} · {row.reference.source}</p>
              <p dir="ltr">SHA-256: {row.algorithm.sourceSha256}</p>
              {row.reference.sourceUrl && <p>{row.reference.sourceUrl}</p>}
              {row.reference.populationReference && <p>عينة وصفية محفوظة، ليست معيارًا شخصيًا: {row.reference.populationReference.mean} ± {row.reference.populationReference.sd} · {row.reference.populationReference.population}</p>}
            </div>)}
          </section>}
          {enriched.filter(row => row.note).map(row => <p key={row.code}><b>{row.code}</b>: {row.note}</p>)}
        </div>
      </details>
      <PrintFooter settings={settings} />
    </article>
  </>;
}
