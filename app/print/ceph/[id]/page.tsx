import { CephSavedCompletionEvidence } from "@/components/CephSavedCompletionEvidence";
import { CephReportTracing } from "@/components/CephReportTracing";
import { buildCephReportTracing, cephAgeAtAcquisition, cephReportAgeLabel, cephReportCalibration, sameCephReportSource } from "@/lib/ceph-report-view";
import { cephDraftReferenceContext, CEPH_UNAVAILABLE_NOTICE, CEPH_INTEGRITY_NOTICE, cephCompletionNotice, enrichPresentedCephMeasurements, isQuarantinedCephMeasurement, presentCephMeasurements } from "@/lib/cephPresentation";
import { PrintMetadata, PrintTableFrame } from "@/components/PrintDocument";
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
const GROUP_COLUMNS = [["sagittal", "vertical"], ["dental", "softTissue"]] as const;
const GROUP_LABELS = {
  sagittal: "الهيكل السهمي · Sagittal Skeletal",
  vertical: "الهيكل العمودي · Vertical Skeletal",
  dental: "العلاقة السنية والقواطع · Dental Analysis",
  softTissue: "الأنسجة الرخوة والبروفايل · Soft Tissue & Profile",
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
    <div className="sheet sheet-a4" style={{ fontSize: "8.5pt", lineHeight: 1.4 }}>
      <p className="mb-2 border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{CEPH_UNAVAILABLE_NOTICE}</p>
      {!completed && <><CephScientificContext /><CephDraftReferenceEvidence context={draftReference} />
        <p role="note" className="p-2 text-xs">هذه قراءة جديدة لمسودة قابلة للتغيير وقت فتح الطباعة، وليست لقطة اعتماد أو نسخة مضمونة المطابقة للشاشة المفتوحة سابقًا.</p></>}
      {completed && <p role="note" className="mb-2 border border-amber-200 p-2 text-xs">{cephCompletionNotice(study.provenance)}</p>}
      <PrintHeader settings={settings} title="تقرير التحليل السيفالومتري الرقمي · Digital Cephalometric Report" />
      <PrintMetadata>
        <div><span style={{ color: "#64748b" }}>المريض / Patient: </span><b>{patient?.fullName ?? `#${study.analysis.patientId}`}</b></div>
        <div><span style={{ color: "#64748b" }}>رقم الملف / File #: </span><span className="num">{study.analysis.patientId}</span></div>
        <div><span style={{ color: "#64748b" }}>الجنس / Gender: </span><b>{patient?.gender === "male" ? "ذكر (Male)" : patient?.gender === "female" ? "أنثى (Female)" : "—"}</b></div>
        <div><span style={{ color: "#64748b" }}>تاريخ الشععة / X-Ray: </span><span>{study.analysis.xrayDate ?? "غير محدد"}</span></div>
        <div data-testid="ceph-report-acquisition-age"><span style={{ color: "#64748b" }}>العمر التقريبي وقت التصوير / Approximate age: </span><b>{cephReportAgeLabel(ageAtXray)}</b></div>
        <div><span style={{ color: "#64748b" }}>مرحلة التقويم / Phase: </span><b>{PHASE_LABEL[study.analysis.phase]?.ar ?? study.analysis.phase}</b></div>
        <div><span style={{ color: "#64748b" }}>حالة التحليل / Status: </span><b style={{ color: completed ? "#047857" : "#b45309" }}>{completed ? "معتمد (Confirmed)" : "مسودة (Draft)"}</b></div>
        <div data-testid="ceph-report-calibration"><span style={{ color: "#64748b" }}>معايرة الصورة / Image calibration: </span><bdi className="num">{calibrationLabel}</bdi></div>
        <div><span style={{ color: "#64748b" }}>المرجع / Ref Set: </span><span style={{ fontSize: "7.5pt" }}>{completed ? historical?.referenceSet.name ?? "المرجع التاريخي غير موثّق" : draftReference.name}</span></div>
      </PrintMetadata>
      {completed && <p role="note" className="my-2 text-xs">بيانات المريض وتاريخ التصوير أعلاه من السجل الحالي؛ ليست توثيقًا مستقلًا لبياناته الديموغرافية وقت الاعتماد.</p>}
      {historical && <CephSavedCompletionEvidence witness={historical} />}
      <CephReportTracing tracing={tracing} />

      <div style={{ margin: "2mm 0" }}>
        <h3 style={{ fontSize: "9pt", fontWeight: 800, margin: "2mm 0 1.5mm", color: "#0f172a" }}>
          {completed ? "📊 لقطة القياسات عند الاعتماد · Sealed Measurements" : "📊 قياسات المسودة · Draft Measurements"}
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3mm" }}>
          {GROUP_COLUMNS.map((groups, column) => <div key={column}>
            {groups.map(group => <div key={group} style={{ marginBottom: "2.5mm" }}>
              <div style={{ backgroundColor: "#f1f5f9", padding: "1mm 2mm", fontWeight: 700, fontSize: "7.5pt", color: "#334155", borderBottom: "1px solid #cbd5e1" }}>{GROUP_LABELS[group]}</div>
              <PrintTableFrame><table className="items" style={{ fontSize: "7pt" }}>
                <thead><tr><th style={{ textAlign: "right" }}>القياس / Parameter</th><th className="num">القيمة / Value</th><th className="num">أرقام المرجع / Catalog numbers</th><th>المصدر / Source</th></tr></thead>
                <tbody>{enriched.filter(row => row.group === group).map(row => {
                  const refNorm = row.refMean != null && row.refSd != null ? `${row.refMean}±${row.refSd}` : "غير متاح";
                  return <tr key={row.code}>
                    <td><div><b>{row.code}</b><span style={{ color: "#64748b", marginInlineStart: "1.5mm", fontSize: "6.5pt" }}>{row.en}</span></div>
                      {row.interpretationAr && <div style={{ fontSize: "6.5pt", color: "#475569", marginTop: "0.3mm" }}>{row.interpretationAr}</div>}</td>
                    <td className="num" style={{ fontWeight: 700, color: "#475569" }}>{row.value != null ? `${row.value}${row.unit}` : "—"}</td>
                    <td className="num" style={{ color: "#475569" }}>{isQuarantinedCephMeasurement(row.code) ? "غير متاح" : (completed ? row.descriptiveOnly : isDescriptiveCephMeasurement(row.code)) ? "وصفي · بلا تصنيف" : refNorm}</td>
                    <td style={{ fontSize: "6.5pt", color: "#475569" }}>{row.source}{completed && row.note ? <div>{row.note}</div> : null}</td>
                  </tr>;
                })}</tbody>
              </table></PrintTableFrame>
            </div>)}
          </div>)}
        </div>
      </div>

      <div style={{ marginTop: "3mm", padding: "3mm", backgroundColor: "#f8fafc", border: "1.5px solid #0f172a", borderRadius: "2mm" }}>
        <h4 style={{ fontSize: "9pt", fontWeight: 800, margin: "0 0 2mm", color: "#0f172a" }}>{completed ? "التشخيص والملاحظات المحفوظة عند الاعتماد · Recorded Diagnosis & Notes" : "مسودة التشخيص وملاحظات الطبيب · Draft Diagnosis & Notes"}</h4>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2mm", fontSize: "8pt" }}>
          {diagnosis?.skeletal && <div><b style={{ color: "#1e3a5f" }}>التشخيص الهيكلي (Skeletal): </b><span>{diagnosis.skeletal}</span></div>}
          {diagnosis?.dental && <div><b style={{ color: "#1e3a5f" }}>التشخيص السني (Dental): </b><span>{diagnosis.dental}</span></div>}
          {diagnosis?.softTissue && <div><b style={{ color: "#1e3a5f" }}>الأنسجة والبروفايل (Soft Tissue): </b><span>{diagnosis.softTissue}</span></div>}
          <div><b style={{ color: "#1e3a5f" }}>الاستنتاج السيفالومتري (Conclusion): </b><span style={{ fontWeight: 700, color: "#0f172a" }}>{diagnosis?.finalDx || "—"}</span></div>
        </div>
        {diagnosis?.note && <div style={{ marginTop: "2mm", paddingTop: "1.5mm", borderTop: "1px dashed #cbd5e1", fontSize: "8pt" }}>
          <b style={{ color: "#1e3a5f" }}>الملاحظات والخطة كما حُفظت: </b><p style={{ margin: "1mm 0 0", whiteSpace: "pre-line", color: "#334155" }}>{diagnosis.note}</p>
        </div>}
      </div>
      {historical && <div className="mt-3 break-all text-xs"><b>مصادر الحساب والمراجع المحفوظة وقت الاعتماد</b>
        <p>{historical.referenceSet.name} · {historical.referenceSet.version}</p>
        <p dir="ltr">Image SHA-256: {historical.image.sha256}</p>
        <p dir="ltr">Reference SHA-256: {historical.referenceSetSha256}</p>
        {historical.measurements.map(row => <p key={row.code}>{row.code}: {row.algorithm.id} · {row.algorithm.version} · {row.algorithm.calculationVersion ?? "—"} · {row.reference.source}
          <span dir="ltr"> · SHA-256: {row.algorithm.sourceSha256}</span>
          {row.reference.sourceUrl && <span> · {row.reference.sourceUrl}</span>}
          {row.reference.populationReference && <span> · عينة وصفية محفوظة، ليست معيارًا شخصيًا: {row.reference.populationReference.mean} ± {row.reference.populationReference.sd} · {row.reference.populationReference.population}</span>}</p>)}
      </div>}
      <div className="sign-row" style={{ marginTop: "6mm" }}>
        <div>
          <p><b>{completed ? "المعتمِد المسجّل: " : "حالة الاعتماد: "}</b>{completed ? recordedActor : "لم يُعتمد بعد"}</p>
          {!historical && study.diagnosis?.createdBy && <p><b>محرر التشخيص: </b>{study.diagnosis.createdBy}</p>}
          <p style={{ color: "#64748b", fontSize: "7pt" }}>{completed ? `تاريخ الاعتماد: ${recordedAt ? friendlyDateLong(recordedAt.split("T")[0]) : "غير موثّق في السجل"}` : "مسودة قيد المراجعة؛ الطباعة لا تعني الاعتماد"}</p>
        </div>
        <div style={{ textAlign: "center", minWidth: "50mm" }}>
          <p><b>{completed ? "توقيع وخاتم الطبيب المعالج" : "مكان التوقيع بعد المراجعة والاعتماد"}</b></p>
          <div style={{ height: "14mm", borderBottom: "1px solid #000", marginTop: "2mm" }} />
          <p style={{ fontSize: "7pt", color: "#64748b", marginTop: "1mm" }}>{settings["clinic.lead_doctor"]} — {settings["clinic.lead_doctor_title"]}</p>
        </div>
      </div>
      <div style={{ marginTop: "4mm" }}><PrintFooter settings={settings} /></div>
    </div>
  </>;
}
